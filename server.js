// server.js — Oppi: chat + memoria + importar .ini + abrir en Prusa + GENERAR .ini (nombres Prusa)
// Requisitos:
//   npm i express dotenv @google/genai multer ini
// package.json -> { "type": "module", "scripts": { "start": "node server.js" } }
// .env -> GEMINI_API_KEY="..."  |  PRUSASLICER_PATH="C:\\Program Files\\Prusa3D\\PrusaSlicer\\prusa-slicer.exe"

process.on("uncaughtException", (e) => { console.error("❌ uncaughtException:", e); });
process.on("unhandledRejection", (e) => { console.error("❌ unhandledRejection:", e); });
process.on("beforeExit", (code) => { console.log("ℹ️ beforeExit:", code); });
process.on("exit", (code) => { console.log("ℹ️ exit:", code); });

console.log("🚀 Boot Oppi: iniciando server.js...");


import express from "express";
import dotenv from "dotenv";
import { GoogleGenAI } from "@google/genai";
import multerPkg from "multer";
const multer = multerPkg.default ?? multerPkg; // compat ESM/CJS
import ini from "ini";
import { spawn } from "node:child_process";
import os from "node:os";
import fs from "node:fs/promises";
import path from "node:path";

// server.js (arriba de las rutas)
import cors from "cors";
const ALLOWED = [
  "http://localhost:3000",                        // local
  "https://<tu-usuario>.github.io/<tu-repo>"      // tu Pages
];
app.use(cors({ origin: ALLOWED, methods: ["GET","POST"], credentials: false }));


dotenv.config();

// Evitar doble arranque si el módulo se evalúa dos veces
if (globalThis.__OPPI_STARTED__) {
  console.log("⚠️ Oppi ya estaba iniciado; evitando doble arranque.");
} else {
  console.log("✅ Primer arranque de Oppi.");
  globalThis.__OPPI_STARTED__ = true;
  // ... (acá todo tu código de app/express/listen)


  const app = express();
  const ai  = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

  app.use(express.json());
  app.use(express.static("public"));

  // ────────────────────────────────────────────────────────────────────────────
  // Mini-memoria por hilo (RAM)
  const memory = new Map(); // threadId -> [{ role, parts:[{text}] }, ...]
  const MAX_TURNS = 12;

  function getThread(threadId) {
    if (!memory.has(threadId)) memory.set(threadId, []);
    return memory.get(threadId);
  }
  function pushTurn(threadId, role, text) {
    const thread = getThread(threadId);
    thread.push({ role, parts: [{ text }] });
    while (thread.length > MAX_TURNS) thread.shift();
  }

  // Perfiles .ini por hilo + upload
  const profiles = new Map(); // threadId -> { raw, data, summary }
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 2 * 1024 * 1024 } });

  const SYSTEM = `Sos Oppi, asistente experto en impresión 3D (PrusaSlicer/OctoPrint).
- Español rioplatense, claro y amable.
- Cuando el usuario pida un perfil, devolvelo SIEMPRE dentro de un bloque \`\`\`ini ... \`\`\` como Config Bundle válido ([print], [filament], [printer]) sin texto fuera del bloque.
- Si hay ambigüedad, hacé 1-2 preguntas de seguimiento muy concretas.
- Recordá el contexto reciente (pieza, material, impresora) y retomalo.`;

  const pick = (obj, keys) => {
    const o = {};
    for (const k of keys) if (obj && Object.prototype.hasOwnProperty.call(obj, k)) o[k] = obj[k];
    return o;
  };

  function summarizeProfile(iniData) {
    const print    = iniData.print    || iniData.Print    || {};
    const filament = iniData.filament || iniData.Filament || {};
    const printer  = iniData.printer  || iniData.Printer  || {};

    const corePrint = pick(print, [
      "layer_height","perimeters","top_solid_layers","bottom_solid_layers",
      "fill_density","fill_pattern","fill_angle",
      "perimeter_speed","infill_speed","solid_infill_speed","top_solid_infill_speed",
      "gap_fill_speed","travel_speed","first_layer_speed","bridge_speed"
    ]);
    const coreTemp = pick(filament, [
      "temperature","first_layer_temperature","bed_temperature","first_layer_bed_temperature"
    ]);
    const coreFan  = pick(filament, ["min_fan_speed","max_fan_speed","bridge_fan_speed"]);
    const corePrinter = pick(printer, ["nozzle_diameter","max_print_height","bed_shape"]);

    const lines = [];
    lines.push("**Resumen de perfil importado**");
    if (Object.keys(coreTemp).length)    lines.push("— **Temperaturas**: " + JSON.stringify(coreTemp));
    if (Object.keys(coreFan).length)     lines.push("— **Ventilador**: " + JSON.stringify(coreFan));
    if (Object.keys(corePrint).length)   lines.push("— **Impresión/Velocidades**: " + JSON.stringify(corePrint));
    if (Object.keys(corePrinter).length) lines.push("— **Impresora**: " + JSON.stringify(corePrinter));
    if (lines.length === 1) lines.push("Secciones detectadas: " + JSON.stringify(Object.keys(iniData)));
    return lines.join("\n");
  }

  async function writeTmpIni(iniText) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "oppi-"));
    const file = path.join(dir, "oppi-profile.prusa.ini");
    await fs.writeFile(file, iniText, "utf8");
    return file;
  }

  // ────────────────────────────────────────────────────────────────────────────
  // ===== Generador .ini (nombres Prusa + sanitización de bed_shape) =====

  // Claves oficiales (según export de Prusa)
  const PARAM_KEYS = [
    // capas/geometría
    "layer_height", "perimeters", "top_solid_layers", "bottom_solid_layers", "first_layer_height",
    // densidad/patrón
    "fill_density", "fill_pattern", "fill_angle",
    // velocidades
    "perimeter_speed", "infill_speed", "solid_infill_speed", "top_solid_infill_speed",
    "gap_fill_speed", "travel_speed", "first_layer_speed", "bridge_speed",
    // temperaturas
    "first_layer_temperature", "temperature", "bed_temperature", "first_layer_bed_temperature",
    // ventilador
    "min_fan_speed", "max_fan_speed", "bridge_fan_speed",
    // retracción
    "retract_length", "retract_speed", "deretract_speed", "retract_restart_extra", "retract_lift",
    // adhesión
    "brim_width", "brim_type", "skirt_distance", "skirts",
    // filamento/boquilla
    "filament_diameter", "extrusion_multiplier", "nozzle_diameter",
    // impresora/volumen cama
    "max_print_height", "bed_shape",
  ];

  // Sinónimos aceptados (IA/usuario) → claves Prusa
  const KEY_MAP = {
    // infill
    "infill_density": "fill_density",
    "infill_pattern": "fill_pattern",
    // ventilador
    "fan_speed": "min_fan_speed",
    "fan_min_speed": "min_fan_speed",
    "fan_max_speed": "max_fan_speed",
    // temperaturas
    "nozzle_temperature": "temperature",
    // retracción
    "lift_z": "retract_lift",
  };

  // Campos que llevan "%" en Prusa
  const PERCENT_KEYS = new Set([
    "fill_density",
    "min_fan_speed","max_fan_speed","bridge_fan_speed",
  ]);

  function normalizeParams(raw = {}) {
    const out = {};
    // 1) mapear sinónimos
    for (const [k, v] of Object.entries(raw)) out[KEY_MAP[k] || k] = v;
    // 2) si solo llegó fan_speed, usarlo para min/max si faltan
    if (raw.fan_speed != null) {
      if (out.min_fan_speed == null) out.min_fan_speed = raw.fan_speed;
      if (out.max_fan_speed == null) out.max_fan_speed = raw.fan_speed;
    }
    // 3) tipado y %
    for (const k of Object.keys(out)) {
      let val = out[k];
      if (typeof val === "string" && val.trim() !== "" && !val.trim().endsWith("%") && !isNaN(Number(val))) {
        val = Number(val);
      }
      if (PERCENT_KEYS.has(k) && typeof val === "number") val = `${val}%`;
      out[k] = val;
    }
    return out;
  }

  // --- helpers para bed_shape ---
  function sanitizeBedShape(val) {
    if (!val) return null;
    val = String(val).replace(/\s+/g, ""); // sin espacios
    const ok = /^-?\d+(\.\d+)?x-?\d+(\.\d+)?(,-?\d+(\.\d+)?x-?\d+(\.\d+)?){3,}$/i.test(val);
    return ok ? val : null;
  }
  function defaultBedShapeFor(threadId) {
    // 1) si hay perfil importado, intentar usarlo
    if (profiles.has(threadId)) {
      const dat = profiles.get(threadId).data;
      const raw = dat?.printer?.bed_shape || dat?.bed_shape;
      const s = sanitizeBedShape(raw);
      if (s) return s;
    }
    // 2) por defecto (cambiá al que uses): MK3S 250x210
    return "0x0,250x0,250x210,0x210";
  }

  function buildIniFromParams(params = {}, ctx = {}) {
    const p = normalizeParams(params);

    // asegurar bed_shape válido (según contexto del hilo si lo tenemos)
    let bedShape = sanitizeBedShape(p.bed_shape);
    if (!bedShape) bedShape = defaultBedShapeFor(ctx.threadId);
    p.bed_shape = bedShape;

    // mantener solo claves oficiales y en orden
    const filtered = {};
    for (const k of PARAM_KEYS) {
      const v = p[k];
      if (v !== undefined && v !== null && v !== "") filtered[k] = v;
    }

    // grupos de legibilidad
    const GROUPS = [
      ["; ---- Capas/Geometría", ["layer_height","first_layer_height","perimeters","top_solid_layers","bottom_solid_layers","nozzle_diameter"]],
      ["; ---- Infill", ["fill_density","fill_pattern","fill_angle"]],
      ["; ---- Velocidades", ["perimeter_speed","infill_speed","solid_infill_speed","top_solid_infill_speed","gap_fill_speed","first_layer_speed","bridge_speed","travel_speed"]],
      ["; ---- Temperaturas", ["temperature","first_layer_temperature","bed_temperature","first_layer_bed_temperature"]],
      ["; ---- Ventilador", ["min_fan_speed","max_fan_speed","bridge_fan_speed"]],
      ["; ---- Retracción/Mov.", ["retract_length","retract_speed","deretract_speed","retract_restart_extra","retract_lift"]],
      ["; ---- Adhesión", ["brim_type","brim_width","skirt_distance","skirts"]],
      ["; ---- Filamento/Impresora", ["filament_diameter","extrusion_multiplier","max_print_height","bed_shape"]],
    ];

    let out = `; ============================\n; Perfil generado por Oppi\n; ============================\n\n`;
    const printed = new Set();

    for (const [title, keys] of GROUPS) {
      const lines = [];
      for (const k of keys) {
        if (filtered[k] !== undefined) {
          lines.push(`${k} = ${filtered[k]}`);
          printed.add(k);
        }
      }
      if (lines.length) out += `${title}\n${lines.join("\n")}\n\n`;
    }

    const rest = Object.keys(filtered).filter(k => !printed.has(k));
    if (rest.length) out += `; ---- Otros\n` + rest.map(k => `${k} = ${filtered[k]}`).join("\n") + "\n";

    return out.trim() + "\n";
  }

  function extractJson(text) {
    try { return JSON.parse(text); } catch {}
    const s = text.indexOf("{");
    const e = text.lastIndexOf("}");
    if (s !== -1 && e !== -1 && e > s) {
      try { return JSON.parse(text.slice(s, e + 1)); } catch {}
    }
    return null;
  }

  // ────────────────────────────────────────────────────────────────────────────
  // CHAT
  app.post("/chat-oppi", async (req, res) => {
    try {
      const { message, threadId } = req.body || {};
      if (!message || !threadId) return res.status(400).json({ error: "Falta message o threadId." });

      const history = getThread(threadId);
      let profileContext = "";
      if (profiles.has(threadId)) profileContext = `\n\n[Contexto de perfil importado]\n${profiles.get(threadId).summary}\n`;

      const contents = [
        { role: "user", parts: [{ text: SYSTEM + profileContext }] },
        ...history,
        { role: "user", parts: [{ text: message }] }
      ];

      const response = await ai.models.generateContent({ model: "gemini-2.5-flash", contents });
      const text =
        response?.text ??
        response?.candidates?.[0]?.content?.parts?.map(p => p.text).join("\n") ??
        "No pude generar respuesta.";

      pushTurn(threadId, "user", message);
      pushTurn(threadId, "model", text);
      res.json({ reply: text });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Error al generar respuesta." });
    }
  });

  // RESET hilo
  app.post("/reset-thread", (req, res) => {
    const { threadId } = req.body || {};
    if (threadId) { memory.delete(threadId); profiles.delete(threadId); }
    res.json({ ok: true });
  });

  // IMPORTAR .ini (como contexto)
  app.post("/import-ini", upload.single("file"), async (req, res) => {
    try {
      const { threadId } = req.body || {};
      if (!threadId) return res.status(400).json({ error: "Falta threadId." });
      if (!req.file)   return res.status(400).json({ error: "Subí un archivo .ini." });

      const raw = req.file.buffer.toString("utf8");
      const data = ini.parse(raw);
      const summary = summarizeProfile(data);

      profiles.set(threadId, { raw, data, summary });
      pushTurn(threadId, "user", `Nota de sistema: Se importó un perfil .ini para este hilo.\n${summary}`);
      res.json({ ok: true, summary });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "No se pudo importar el .ini." });
    }
  });

  // PERFIL actual
  app.get("/current-profile", (req, res) => {
    const { threadid } = req.query || {};
    if (!threadid || !profiles.has(threadid)) return res.json({ hasProfile: false });
    const p = profiles.get(threadid);
    res.json({ hasProfile: true, summary: p.summary });
  });

  // ABRIR en PrusaSlicer
  app.post("/open-prusa", async (req, res) => {
    try {
      const { iniText, iniPath } = req.body || {};
      const prusaPath = process.env.PRUSASLICER_PATH;
      if (!prusaPath) return res.status(400).json({ error: "Falta PRUSASLICER_PATH en .env" });

      let fileToLoad = iniPath;
      if (!fileToLoad) {
        if (!iniText) return res.status(400).json({ error: "Falta iniText o iniPath." });
        fileToLoad = await writeTmpIni(iniText);
      }

      const child = spawn(prusaPath, ["--load", fileToLoad], { detached: true, stdio: "ignore" });
      child.unref();
      res.json({ ok: true, loaded: fileToLoad });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "No pude abrir PrusaSlicer con ese .ini." });
    }
  });

  // GENERAR .ini con IA → nombres Prusa (+ bed_shape seguro)
  app.post("/generate-ini-ai", async (req, res) => {
    try {
      const { threadId, overrides } = req.body || {};
      if (!threadId) return res.status(400).json({ error: "Falta threadId." });

      const history = getThread(threadId);
      let profileContext = "";
      if (profiles.has(threadId)) profileContext = `\n\n[Contexto de perfil importado]\n${profiles.get(threadId).summary}\n`;

      const schemaList = PARAM_KEYS.map(k => `"${k}"`).join(", ");
      const askJson = `
Quiero que construyas un JSON de parámetros para PrusaSlicer (modo principiante estable).
Usá SOLO estas claves exactamente (sin agregar ni quitar): [${schemaList}].
Valores numéricos donde corresponda (mm, mm/s, °C, %, etc.). Si falta info, elegí valores seguros tipo "Modo Abuela".
IMPORTANTE: respondé SOLO con JSON plano válido (sin markdown, sin comentarios, sin texto extra).
`;

      const contents = [
        { role: "user", parts: [{ text: SYSTEM + profileContext }] },
        ...history,
        { role: "user", parts: [{ text: askJson }] }
      ];

      const resp = await ai.models.generateContent({ model: "gemini-2.5-flash", contents });
      const raw = resp?.text ?? "";
      const json = extractJson(raw);
      if (!json) return res.status(502).json({ error: "La IA no devolvió JSON válido.", raw });

      const params = { ...json, ...(overrides || {}) };
      const iniText = buildIniFromParams(params, { threadId });
      res.json({ ok: true, params: normalizeParams(params), iniText });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "No pude generar el .ini con IA." });
    }
  });

  // ────────────────────────────────────────────────────────────────────────────
  // Escuchar en puerto libre automático
const PORT = process.env.PORT || 0; // en Render te pasan PORT; local queda 0 (auto-libre)
const server = app.listen(PORT, () => {
  const { port } = server.address();
  console.log(`🧠 Oppi con memoria en http://localhost:${port}`);
});

server.on("error", (err) => {
  console.error("❌ No se pudo iniciar el servidor:", err);
  process.exit(1);
});

}
