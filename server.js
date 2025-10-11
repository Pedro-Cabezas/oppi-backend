// =========================================================
// Oppi — Server.js (versión Render + GitHub Pages)
// =========================================================

// --- Diagnóstico inicial ---
process.on("uncaughtException", e => console.error("❌ uncaughtException:", e));
process.on("unhandledRejection", e => console.error("❌ unhandledRejection:", e));
console.log("🚀 Boot Oppi: iniciando server.js...");

// --- Imports principales ---
import express from "express";
import dotenv from "dotenv";
import { GoogleGenAI } from "@google/genai";
import multerPkg from "multer";
const multer = multerPkg.default ?? multerPkg;
import ini from "ini";
import { spawn } from "node:child_process";
import os from "node:os";
import fs from "node:fs/promises";
import path from "node:path";
import cors from "cors";

dotenv.config();

// --- Evitar doble arranque ---
if (globalThis.__OPPI_STARTED__) {
  console.log("⚠️ Oppi ya estaba iniciado; evitando doble arranque.");
} else {
  console.log("✅ Primer arranque de Oppi.");
  globalThis.__OPPI_STARTED__ = true;

  // =========================================================
  // EXPRESS + GEMINI
  // =========================================================
  const app = express();
  const ai  = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

  // CORS: permitir tu dominio de GitHub Pages y localhost
  const ALLOWED = [
    "http://localhost:3000",
    "https://pedro-cabezas.github.io",
    "https://pedro-cabezas.github.io/oppi-frontend"
  ];
  app.use(cors({ origin: ALLOWED, methods: ["GET","POST"] }));

  app.use(express.json());
  app.use(express.static("public"));

  // =========================================================
  // MINI MEMORIA (RAM)
  // =========================================================
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

  // =========================================================
  // IMPORTADOR DE PERFILES
  // =========================================================
  const profiles = new Map(); // threadId -> { raw, data, summary }
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 2 * 1024 * 1024 } });

  const SYSTEM = `Sos Oppi, asistente experto en impresión 3D (PrusaSlicer/OctoPrint).
- Español rioplatense, claro y amable.
- Cuando el usuario pida un perfil, devolvelo SIEMPRE dentro de un bloque \`\`\`ini ... \`\`\` sin texto afuera.
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
    if (Object.keys(corePrint).length)   lines.push("— **Velocidades**: " + JSON.stringify(corePrint));
    if (Object.keys(corePrinter).length) lines.push("— **Impresora**: " + JSON.stringify(corePrinter));
    return lines.join("\n");
  }

  async function writeTmpIni(iniText) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "oppi-"));
    const file = path.join(dir, "oppi-profile.prusa.ini");
    await fs.writeFile(file, iniText, "utf8");
    return file;
  }

  // =========================================================
  // PARÁMETROS PRUSA + SANITIZACIÓN bed_shape
  // =========================================================
  const PARAM_KEYS = [
    "layer_height", "perimeters", "top_solid_layers", "bottom_solid_layers", "first_layer_height",
    "fill_density", "fill_pattern", "fill_angle",
    "perimeter_speed", "infill_speed", "solid_infill_speed", "top_solid_infill_speed",
    "gap_fill_speed", "travel_speed", "first_layer_speed", "bridge_speed",
    "first_layer_temperature", "temperature", "bed_temperature", "first_layer_bed_temperature",
    "min_fan_speed", "max_fan_speed", "bridge_fan_speed",
    "retract_length", "retract_speed", "deretract_speed", "retract_restart_extra", "retract_lift",
    "brim_width", "brim_type", "skirt_distance", "skirts",
    "filament_diameter", "extrusion_multiplier", "nozzle_diameter",
    "max_print_height", "bed_shape",
  ];

  const KEY_MAP = {
    "infill_density": "fill_density",
    "infill_pattern": "fill_pattern",
    "fan_speed": "min_fan_speed",
    "fan_min_speed": "min_fan_speed",
    "fan_max_speed": "max_fan_speed",
    "nozzle_temperature": "temperature",
    "lift_z": "retract_lift",
  };

  const PERCENT_KEYS = new Set(["fill_density","min_fan_speed","max_fan_speed","bridge_fan_speed"]);

  function normalizeParams(raw = {}) {
    const out = {};
    for (const [k,v] of Object.entries(raw)) out[KEY_MAP[k]||k] = v;
    if (raw.fan_speed != null) {
      if (out.min_fan_speed == null) out.min_fan_speed = raw.fan_speed;
      if (out.max_fan_speed == null) out.max_fan_speed = raw.fan_speed;
    }
    for (const k of Object.keys(out)) {
      let val = out[k];
      if (typeof val === "string" && val.trim() && !val.trim().endsWith("%") && !isNaN(Number(val))) {
        val = Number(val);
      }
      if (PERCENT_KEYS.has(k) && typeof val === "number") val = `${val}%`;
      out[k] = val;
    }
    return out;
  }

  function sanitizeBedShape(val) {
    if (!val) return null;
    val = String(val).replace(/\s+/g,"");
    const ok = /^-?\d+(\.\d+)?x-?\d+(\.\d+)?(,-?\d+(\.\d+)?x-?\d+(\.\d+)?){3,}$/i.test(val);
    return ok ? val : null;
  }
  function defaultBedShapeFor(threadId) {
    if (profiles.has(threadId)) {
      const dat = profiles.get(threadId).data;
      const raw = dat?.printer?.bed_shape || dat?.bed_shape;
      const s = sanitizeBedShape(raw);
      if (s) return s;
    }
    return "0x0,250x0,250x210,0x210"; // Prusa MK3S por defecto
  }

  function buildIniFromParams(params = {}, ctx = {}) {
    const p = normalizeParams(params);
    let bedShape = sanitizeBedShape(p.bed_shape);
    if (!bedShape) bedShape = defaultBedShapeFor(ctx.threadId);
    p.bed_shape = bedShape;

    const filtered = {};
    for (const k of PARAM_KEYS) {
      const v = p[k];
      if (v !== undefined && v !== null && v !== "") filtered[k] = v;
    }

    const GROUPS = [
      ["; ---- Capas", ["layer_height","first_layer_height","perimeters","top_solid_layers","bottom_solid_layers","nozzle_diameter"]],
      ["; ---- Infill", ["fill_density","fill_pattern","fill_angle"]],
      ["; ---- Velocidades", ["perimeter_speed","infill_speed","solid_infill_speed","top_solid_infill_speed","gap_fill_speed","first_layer_speed","bridge_speed","travel_speed"]],
      ["; ---- Temperaturas", ["temperature","first_layer_temperature","bed_temperature","first_layer_bed_temperature"]],
      ["; ---- Ventilador", ["min_fan_speed","max_fan_speed","bridge_fan_speed"]],
      ["; ---- Retracción", ["retract_length","retract_speed","deretract_speed","retract_restart_extra","retract_lift"]],
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

  // =========================================================
  // ENDPOINTS
  // =========================================================
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
      const text = response?.text ?? "No pude generar respuesta.";

      pushTurn(threadId, "user", message);
      pushTurn(threadId, "model", text);
      res.json({ reply: text });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Error al generar respuesta." });
    }
  });

  app.post("/reset-thread", (req, res) => {
    const { threadId } = req.body || {};
    if (threadId) { memory.delete(threadId); profiles.delete(threadId); }
    res.json({ ok: true });
  });

  app.post("/import-ini", upload.single("file"), async (req, res) => {
    try {
      const { threadId } = req.body || {};
      if (!threadId) return res.status(400).json({ error: "Falta threadId." });
      if (!req.file)   return res.status(400).json({ error: "Subí un archivo .ini." });

      const raw = req.file.buffer.toString("utf8");
      const data = ini.parse(raw);
      const summary = summarizeProfile(data);

      profiles.set(threadId, { raw, data, summary });
      pushTurn(threadId, "user", `Se importó un perfil .ini.\n${summary}`);
      res.json({ ok: true, summary });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "No se pudo importar el .ini." });
    }
  });

  app.post("/generate-ini-ai", async (req, res) => {
    try {
      const { threadId, overrides } = req.body || {};
      if (!threadId) return res.status(400).json({ error: "Falta threadId." });

      const history = getThread(threadId);
      const schemaList = PARAM_KEYS.map(k => `"${k}"`).join(", ");
      const askJson = `
Quiero un JSON con parámetros de impresión para PrusaSlicer.
Usá SOLO estas claves: [${schemaList}].
Valores seguros estilo "Modo Abuela". 
Respondé SOLO JSON válido (sin markdown).`;

      const contents = [
        { role: "user", parts: [{ text: SYSTEM }] },
        ...history,
        { role: "user", parts: [{ text: askJson }] }
      ];

      const resp = await ai.models.generateContent({ model: "gemini-2.5-flash", contents });
      const raw = resp?.text ?? "";
      const json = extractJson(raw);
      if (!json) return res.status(502).json({ error: "La IA no devolvió JSON válido." });

      const params = { ...json, ...(overrides || {}) };
      const iniText = buildIniFromParams(params, { threadId });
      res.json({ ok: true, params: normalizeParams(params), iniText });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "No pude generar el .ini con IA." });
    }
  });

  // =========================================================
  // INICIAR SERVIDOR (Render usa process.env.PORT)
  // =========================================================
  const PORT = process.env.PORT || 3000;
  const server = app.listen(PORT, () => {
    console.log(`🧠 Oppi activo en puerto ${PORT}`);
  });
}
