// ============================================================================
// Oppi Backend v2 — Reescritura total (compatible con @google/genai 1.4.0)
// Autor: ChatGPT + Pedro
// ============================================================================

// ------------------------------
// Imports
// ------------------------------
import express from "express";
import dotenv from "dotenv";
import cors from "cors";
import multer from "multer";
import ini from "ini";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { GoogleGenAI } from "@google/genai";

dotenv.config();

// ------------------------------
// Inicialización IA
// ------------------------------
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

async function askGemini(modelName, contents) {
  const result = await ai.models.generateContent({
    model: modelName,
    contents,
  });

  return (
    result?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || null
  );
}

// ------------------------------
// Express Config
// ------------------------------
const app = express();
app.use(express.json({ limit: "2mb" }));
app.use(cors({
  origin: [
    "http://localhost:3000",
    "http://localhost:5173",
    "http://127.0.0.1:3000",
    "https://pedro-cabezas.github.io",
    "https://pedro-cabezas.github.io/opifex"
  ]
}));

// ------------------------------
// Memoria por hilo
// ------------------------------
const memory = new Map();      // Id → [{role, text}]
const profiles = new Map();    // Id → {raw, data, summary}
const MAX_TURNS = 12;

function getThread(threadId) {
  if (!memory.has(threadId)) memory.set(threadId, []);
  return memory.get(threadId);
}

function pushTurn(threadId, role, text) {
  const arr = getThread(threadId);
  arr.push({ role, text });
  while (arr.length > MAX_TURNS) arr.shift();
}

// ------------------------------
// Sistema Oppi
// ------------------------------
const SYSTEM_PROMPT =
`Sos Oppi, asistente experto en impresión 3D.
— Español rioplatense, claro y amable.
— Cuando generes perfiles .ini devolvelos SOLO dentro de bloques \`\`\`ini\`\`\`.
— Recordá el contexto de la pieza y la impresora.
`;

// ------------------------------
// STL Library
// ------------------------------
let STL_CACHE = null;
async function loadStlLibrary() {
  if (STL_CACHE) return STL_CACHE;
  try {
    const raw = await fs.readFile(path.join(process.cwd(), "data", "stl-library.json"), "utf8");
    STL_CACHE = JSON.parse(raw);
  } catch {
    STL_CACHE = [];
  }
  return STL_CACHE;
}

function stlScore(model, query) {
  const full =
    (model.nombre || "") + " " +
    (model.descripcion || "") + " " +
    (model.categoria || "") + " " +
    (model.tags || []).join(" ");

  const words = query.toLowerCase().split(/\s+/);
  let score = 0;
  for (const w of words) if (full.toLowerCase().includes(w)) score++;
  return score;
}

async function bestStl(prompt) {
  const lib = await loadStlLibrary();
  const matches = lib
    .map(m => ({ ...m, score: stlScore(m, prompt) }))
    .filter(m => m.score > 0)
    .sort((a, b) => b.score - a.score);

  return matches[0] || null;
}

// ------------------------------
// .ini Helpers
// ------------------------------
function summarizeProfile(parsed) {
  const print = parsed.print || {};
  const filament = parsed.filament || {};
  const printer = parsed.printer || {};

  return [
    "**Perfil importado**",
    "— Temperaturas: " + JSON.stringify({
      temp: filament.temperature,
      first: filament.first_layer_temperature,
      bed: filament.bed_temperature,
    }),
    "— Velocidades: " + JSON.stringify({
      perim: print.perimeter_speed,
      infill: print.infill_speed,
      travel: print.travel_speed,
    }),
    "— Impresora: " + JSON.stringify({
      nozzle: printer.nozzle_diameter,
      bed_shape: printer.bed_shape,
    })
  ].join("\n");
}

async function writeTmpIni(text) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "oppi-"));
  const file = path.join(dir, "oppi.prusa.ini");
  await fs.writeFile(file, text);
  return file;
}

// ------------------------------
// Routes
// ------------------------------

// =============== CHAT ===============
app.post("/chat-oppi", async (req, res) => {
  try {
    const { message, threadId } = req.body;
    if (!message || !threadId) return res.status(400).json({ error: "Faltan datos." });

    const history = getThread(threadId);
    const profileContext = profiles.has(threadId)
      ? `\n[Contexto del perfil]\n${profiles.get(threadId).summary}\n`
      : "";

    const contents = [
      { role: "user", parts: [{ text: SYSTEM_PROMPT + profileContext }] },
      ...history.map(t => ({ role: t.role, parts: [{ text: t.text }] })),
      { role: "user", parts: [{ text: message }] }
    ];

    const text = await askGemini("gemini-2.0-flash", contents);

    pushTurn(threadId, "user", message);
    pushTurn(threadId, "model", text || "(sin respuesta)");

    return res.json({ reply: text || "No pude generar respuesta." });

  } catch (e) {
    console.error("❌ Chat error:", e);
    return res.status(500).json({ error: "Error al generar respuesta." });
  }
});

// =============== RESET MEMORIA ===============
app.post("/reset-thread", (req, res) => {
  const { threadId } = req.body;
  if (threadId) {
    memory.delete(threadId);
    profiles.delete(threadId);
  }
  res.json({ ok: true });
});

// =============== IMPORT .INI ===============
const upload = multer({ storage: multer.memoryStorage() });

app.post("/import-ini", upload.single("file"), (req, res) => {
  try {
    const { threadId } = req.body;
    if (!threadId) return res.status(400).json({ error: "Falta threadId." });
    if (!req.file) return res.status(400).json({ error: "Falta archivo." });

    const raw = req.file.buffer.toString("utf8");
    const parsed = ini.parse(raw);
    const summary = summarizeProfile(parsed);

    profiles.set(threadId, { raw, data: parsed, summary });
    pushTurn(threadId, "user", `Importé un perfil.\n${summary}`);

    return res.json({ ok: true, summary });
  } catch (e) {
    console.error("❌ import .ini:", e);
    res.status(500).json({ error: "No pude importar perfil." });
  }
});

// =============== GENERAR INI CON IA ===============
app.post("/generate-ini-ai", async (req, res) => {
  try {
    const { threadId } = req.body;
    if (!threadId) return res.status(400).json({ error: "Falta threadId." });

    const ask = `
Generame SOLO un JSON de parámetros para PrusaSlicer.
Solo con claves reales: layer_height, perimeters, fill_density, travel_speed, temperature,
first_layer_temperature, bed_temperature, nozzle_diameter, bed_shape, etc.
Valores modo abuela si falta info.
NO escribas texto fuera del JSON.
`;

    const history = getThread(threadId);
    const contents = [
      { role: "user", parts: [{ text: SYSTEM_PROMPT }] },
      ...history.map(t => ({ role: t.role, parts: [{ text: t.text }] })),
      { role: "user", parts: [{ text: ask }] }
    ];

    const raw = await askGemini("gemini-2.0-flash", contents);
    const open = raw.indexOf("{");
    const close = raw.lastIndexOf("}");
    if (open === -1 || close === -1) {
      return res.status(502).json({ error: "La IA no devolvió JSON válido." });
    }

    const json = JSON.parse(raw.slice(open, close + 1));

    let iniText = "; Oppi Profile\n\n";
    for (const [k, v] of Object.entries(json)) iniText += `${k} = ${v}\n`;

    pushTurn(threadId, "model", iniText);

    return res.json({ ok: true, iniText });

  } catch (e) {
    console.error("❌ generate-ini-ai:", e);
    return res.status(500).json({ error: "No pude generar el .ini con IA." });
  }
});

// =============== SUGERIR STL ===============
app.post("/api/stl/suggest", async (req, res) => {
  try {
    const { prompt } = req.body;
    if (!prompt) return res.json({ found: false });

    const model = await bestStl(prompt);
    if (!model) return res.json({ found: false });

    return res.json({ found: true, model });

  } catch (e) {
    console.error("❌ STL error:", e);
    return res.status(500).json({ error: "No pude buscar STL." });
  }
});

// =============== SERVIDOR ===============
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Oppi Backend v2 corriendo en puerto ${PORT}`);
});
