// ============================================================================
// Oppi — Backend universal (funciona local y en Render)
// - Chat con mini-memoria
// - Importar .ini como contexto
// - Generar .ini (nombres de Prusa) con sanitización de bed_shape
// - Abrir en PrusaSlicer (solo si corre local y PRUSASLICER_PATH está definido)
// - CORS para GitHub Pages (https://pedro-cabezas.github.io/opifex)
// ============================================================================

// ---------- Diagnóstico global ----------
process.on("uncaughtException", e => console.error("❌ uncaughtException:", e));
process.on("unhandledRejection", e => console.error("❌ unhandledRejection:", e));
console.log("🚀 Boot Oppi: iniciando server.js...");

// ---------- Imports ----------
import express from "express";
import dotenv from "dotenv";
import { GoogleGenAI } from "@google/genai";
import multerPkg from "multer";
const multer = multerPkg.default ?? multerPkg; // compat CJS/ESM
import ini from "ini";
import cors from "cors";
import { spawn } from "node:child_process";
import os from "node:os";
import fs from "node:fs/promises";
import path from "node:path";

// ---------- .env ----------
dotenv.config();

// ---------- Anti doble arranque (por seguridad en ciertos entornos) ----------
if (globalThis.__OPPI_STARTED__) {
  console.log("⚠️ Oppi ya estaba iniciado; evitando doble arranque.");
  // Nota: si llegaste acá y no tenés otra instancia, probablemente lo estás importando desde otro archivo.
} else {
  console.log("✅ Primer arranque de Oppi.");
  globalThis.__OPPI_STARTED__ = true;

  // ========================================================================
  // Express + Gemini
  // ========================================================================
  const app = express();
  const ai  = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

  // ---------- CORS: permitimos localhost y TU GitHub Pages ----------
  const ALLOWED_ORIGINS = [
    "http://localhost:3000",
    "http://localhost:5173",
    "http://127.0.0.1:3000",
    "https://pedro-cabezas.github.io",
    "https://pedro-cabezas.github.io/opifex"
  ];
  app.use(cors({ origin: ALLOWED_ORIGINS, methods: ["GET","POST"] }));

  // ---------- Middlewares base ----------
  app.use(express.json({ limit: "2mb" }));
  app.use(express.urlencoded({ extended: true }));
  app.use(express.static("public"));

  // ========================================================================
  // Estado en memoria (RAM)
  // ========================================================================
  const memory = new Map();     // threadId -> [{ role, parts:[{text}] }, ...]
  const profiles = new Map();   // threadId -> { raw, data, summary }
  const MAX_TURNS = 12;

  function getThread(threadId) {
    if (!memory.has(threadId)) memory.set(threadId, []);
    return memory.get(threadId);
  }
  function pushTurn(threadId, role, text) {
    const t = getThread(threadId);
    t.push({ role, parts: [{ text }] });
    while (t.length > MAX_TURNS) t.shift();
  }



  // ========================================================================
  // Helpers varios
  // ========================================================================
  const SYSTEM = `Sos Oppi, asistente experto en impresión 3D (PrusaSlicer/OctoPrint).
- Español rioplatense, claro y amable.
- Cuando el usuario pida un perfil, devolvelo SIEMPRE dentro de un bloque \`\`\`ini ... \`\`\` (Config Bundle válido) sin texto afuera.
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

  // ========================================================================
  // Biblioteca STL: cargar JSON y buscar mejor modelo
  // ========================================================================
  let stlLibraryCache = null;

  async function loadStlLibrary() {
    if (stlLibraryCache) return stlLibraryCache;
    try {
      const stlPath = path.join(process.cwd(), "data", "stl-library.json");
      const raw = await fs.readFile(stlPath, "utf8");
      stlLibraryCache = JSON.parse(raw);
    } catch (e) {
      console.error("❌ Error cargando stl-library.json:", e);
      stlLibraryCache = [];
    }
    return stlLibraryCache;
  }

   // Normalizar: minúsculas + sin tildes
    // Normalizar: minúsculas + sin tildes
  function normalize(str = "") {
    return String(str)
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, ""); // saca acentos
  }

  const STOPWORDS = new Set([
    "el","la","los","las","un","una","unos","unas",
    "de","del","para","por","con","y","o","u","en","a",
    "mi","tu","su","sus","quiero","necesito","modelo","simple",
    "probar","prueba","imprimir","imprime","algo"
  ]);

  function scoreStlModel(model, query) {
    const text = normalize(
      (model.nombre || "") + " " +
      (model.descripcion || "") + " " +
      (model.categoria || "") + " " +
      (Array.isArray(model.tags) ? model.tags.join(" ") : "")
    );

    const words = normalize(query)
      .split(/\s+/)
      .filter(w => w && !STOPWORDS.has(w) && w.length >= 3);

    if (!words.length) return 0;

    let score = 0;

    for (const w of words) {
      if (text.includes(w)) score += 2; // match general
    }

    // Bonus: matches en tags
    const tags = (model.tags || []).map(t => normalize(t));
    for (const w of words) {
      if (tags.includes(w)) score += 3;                // exacto
      else if (tags.some(t => t.includes(w))) score++; // parcial
    }

    return score;
  }

  async function findBestStl(query) {
    const library = await loadStlLibrary();
    if (!library.length) return null;

    const scored = library
      .map(m => ({ ...m, score: scoreStlModel(m, query) }))
      .filter(m => m.score > 0)
      .sort((a, b) => b.score - a.score);

    // si nada matchea, devolvemos Benchy como “modelo test”
    if (!scored.length) {
      const benchy = library.find(m => m.id === "benchy") || library[0];
      return benchy;
    }

    return scored[0];
  }



  
  async function writeTmpIni(iniText) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "oppi-"));
    const file = path.join(dir, "oppi-profile.prusa.ini");
    await fs.writeFile(file, iniText, "utf8");
    return file;
  }

  // ========================================================================
  // Generador de .ini (nombres de Prusa) + sanitización bed_shape
  // ========================================================================
  const PARAM_KEYS = [
    // Capas/Geometría
    "layer_height","perimeters","top_solid_layers","bottom_solid_layers","first_layer_height",
    // Infill
    "fill_density","fill_pattern","fill_angle",
    // Velocidades
    "perimeter_speed","infill_speed","solid_infill_speed","top_solid_infill_speed",
    "gap_fill_speed","travel_speed","first_layer_speed","bridge_speed",
    // Temperaturas
    "first_layer_temperature","temperature","bed_temperature","first_layer_bed_temperature",
    // Ventilador
    "min_fan_speed","max_fan_speed","bridge_fan_speed",
    // Retracción
    "retract_length","retract_speed","deretract_speed","retract_restart_extra","retract_lift",
    // Adhesión
    "brim_width","brim_type","skirt_distance","skirts",
    // Filamento/Boquilla
    "filament_diameter","extrusion_multiplier","nozzle_diameter",
    // Impresora
    "max_print_height","bed_shape"
  ];

  // Sinónimos (por si la IA o el user mandan otras claves)
  const KEY_MAP = {
    "infill_density": "fill_density",
    "infill_pattern": "fill_pattern",
    "fan_speed": "min_fan_speed",
    "fan_min_speed": "min_fan_speed",
    "fan_max_speed": "max_fan_speed",
    "nozzle_temperature": "temperature",
    "lift_z": "retract_lift",
  };

  // Claves que deben llevar "%"
  const PERCENT_KEYS = new Set(["fill_density","min_fan_speed","max_fan_speed","bridge_fan_speed"]);

  function normalizeParams(raw = {}) {
    const out = {};
    // mapear sinónimos
    for (const [k, v] of Object.entries(raw)) out[KEY_MAP[k] || k] = v;
    // si vino solo fan_speed, lo usamos para min/max
    if (raw.fan_speed != null) {
      if (out.min_fan_speed == null) out.min_fan_speed = raw.fan_speed;
      if (out.max_fan_speed == null) out.max_fan_speed = raw.fan_speed;
    }
    // tipado y % explícito
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

  // bed_shape: "0x0,250x0,250x210,0x210" (sin espacios, al menos 4 puntos)
  function sanitizeBedShape(val) {
    if (!val) return null;
    val = String(val).replace(/\s+/g, "");
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
    // Por defecto: Prusa MK3S (250x210). Cambiá si querés otra impresora default.
    return "0x0,250x0,250x210,0x210";
  }

  function buildIniFromParams(params = {}, ctx = {}) {
    const p = normalizeParams(params);
    // asegurar bed_shape válido
    let bedShape = sanitizeBedShape(p.bed_shape);
    if (!bedShape) bedShape = defaultBedShapeFor(ctx.threadId);
    p.bed_shape = bedShape;

    // mantener solo las claves oficiales y en orden
    const filtered = {};
    for (const k of PARAM_KEYS) {
      const v = p[k];
      if (v !== undefined && v !== null && v !== "") filtered[k] = v;
    }

    // salida ordenada en grupos (legible, aunque no es requisito de Prusa)
    const GROUPS = [
      ["; ---- Capas/Geometría", ["layer_height","first_layer_height","perimeters","top_solid_layers","bottom_solid_layers","nozzle_diameter"]],
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
        if (filtered[k] !== undefined) { lines.push(`${k} = ${filtered[k]}`); printed.add(k); }
      }
      if (lines.length) out += `${title}\n${lines.join("\n")}\n\n`;
    }

    // resto (por si agregamos nuevas claves en el futuro)
    const rest = Object.keys(filtered).filter(k => !printed.has(k));
    if (rest.length) out += `; ---- Otros\n` + rest.map(k => `${k} = ${filtered[k]}`).join("\n") + "\n";

    return out.trim() + "\n";
  }

  function extractJson(text) {
    try { return JSON.parse(text); } catch {}
    const s = text.indexOf("{"), e = text.lastIndexOf("}");
    if (s !== -1 && e !== -1 && e > s) {
      try { return JSON.parse(text.slice(s, e + 1)); } catch {}
    }
    return null;
  }

  // ========================================================================
  // Rutas HTTP
  // ========================================================================

  // Chat principal
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
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: "Error al generar respuesta." });
    }
  });

  // Reset memoria del hilo
  app.post("/reset-thread", (req, res) => {
    const { threadId } = req.body || {};
    if (threadId) { memory.delete(threadId); profiles.delete(threadId); }
    res.json({ ok: true });
  });

    // Sugerir STL en base a un texto
  app.post("/api/stl/suggest", async (req, res) => {
    try {
      const { prompt } = req.body || {};
      if (!prompt || !prompt.trim()) {
        return res.status(400).json({ error: "Falta el texto de búsqueda (prompt)." });
      }

      const best = await findBestStl(prompt);
      if (!best) {
        return res.json({ found: false });
      }

      return res.json({
        found: true,
        model: best
      });
    } catch (e) {
      console.error("❌ Error en /api/stl/suggest:", e);
      res.status(500).json({ error: "No pude buscar un modelo STL." });
    }
  });


  // Importar .ini (para usar como contexto)
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 2 * 1024 * 1024 } });
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
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: "No se pudo importar el .ini." });
    }
  });

  // Generar .ini con IA
  app.post("/generate-ini-ai", async (req, res) => {
    try {
      const { threadId, overrides } = req.body || {};
      if (!threadId) return res.status(400).json({ error: "Falta threadId." });

      const history = getThread(threadId);
      let profileContext = "";
      if (profiles.has(threadId)) profileContext = `\n\n[Contexto de perfil importado]\n${profiles.get(threadId).summary}\n`;

      const schemaList = PARAM_KEYS.map(k => `"${k}"`).join(", ");
      const askJson = `
Quiero un JSON con parámetros de impresión para PrusaSlicer usando SOLO estas claves: [${schemaList}].
Valores seguros "Modo Abuela" si falta info. Respondé SOLO JSON válido (sin markdown, sin comentarios).
`;

      const contents = [
        { role: "user", parts: [{ text: SYSTEM + profileContext }] },
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
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: "No pude generar el .ini con IA." });
    }
  });

  // Abrir en PrusaSlicer (solo útil localmente)
  app.post("/open-prusa", async (req, res) => {
    try {
      const prusaPath = process.env.PRUSASLICER_PATH;
      if (!prusaPath) {
        return res.status(400).json({
          error: "PRUSASLICER_PATH no está configurado (esta acción solo funciona localmente)."
        });
      }
      const { iniText, iniPath } = req.body || {};
      if (!iniText && !iniPath) return res.status(400).json({ error: "Falta iniText o iniPath." });

      let fileToLoad = iniPath;
      if (!fileToLoad) fileToLoad = await writeTmpIni(iniText);

      const child = spawn(prusaPath, ["--load", fileToLoad], { detached: true, stdio: "ignore" });
      child.unref();
      res.json({ ok: true, loaded: fileToLoad });
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: "No pude abrir PrusaSlicer con ese .ini." });
    }
  });

  // ========================================================================
  // Iniciar servidor (Render usa process.env.PORT)
  // ========================================================================
  const PORT = process.env.PORT || 3000;
  const server = app.listen(PORT, () => {
    console.log(`🧠 Oppi activo en puerto ${PORT}`);
  });
}





