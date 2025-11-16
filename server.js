// ============================================================================
// Oppi Backend — Chat + Memoria + Import/Generar .ini + STL + Supabase
// Versión: GoogleGenAI (@google/genai 1.4.0)
// ============================================================================

process.on("uncaughtException", (e) => {
  console.error("❌ uncaughtException:", e);
});
process.on("unhandledRejection", (e) => {
  console.error("❌ unhandledRejection:", e);
});

console.log("🚀 Boot Oppi: iniciando server.js...");

// ------------------------------
// Imports
// ------------------------------
import express from "express";
import dotenv from "dotenv";
import cors from "cors";
import multerPkg from "multer";
const multer = multerPkg.default ?? multerPkg; // compat ESM/CJS
import ini from "ini";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { GoogleGenAI } from "@google/genai";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import { requireSupabaseUser } from "./authMiddleware.js";

dotenv.config();

// ------------------------------
// Supabase (backend / admin)
// ------------------------------
const supabaseAdmin = createSupabaseClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// ------------------------------
// IA: GoogleGenAI
// ------------------------------
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

async function askGemini(modelName, contents) {
  const result = await ai.models.generateContent({
    model: modelName,
    contents,
  });

  // Forma estable: tomamos el primer texto disponible
  return (
    result?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || null
  );
}

// Helper robusto para extraer JSON desde la respuesta de la IA
function extractJsonFromText(raw) {
  if (!raw || typeof raw !== "string") return null;
  let text = raw.trim();

  // 1) Si viene dentro de ``` ``` o ```json ```
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced && fenced[1]) {
    text = fenced[1].trim();
  }

  // 2) Recortar desde el primer { hasta el último }
  const s = text.indexOf("{");
  const e = text.lastIndexOf("}");
  if (s === -1 || e === -1 || e <= s) return null;

  const candidate = text.slice(s, e + 1);
  try {
    return JSON.parse(candidate);
  } catch (err) {
    console.error("❌ No pude parsear JSON:", err, "\nTexto candidato:\n", candidate);
    return null;
  }
}

// ------------------------------
// Express + CORS
// ------------------------------
const app = express();
app.use(express.json({ limit: "2mb" }));

const ALLOWED_ORIGINS = [
  "http://localhost:3000",
  "http://localhost:5173",
  "http://127.0.0.1:3000",
  "https://pedro-cabezas.github.io",
  "https://pedro-cabezas.github.io/opifex",
];
app.use(
  cors({
    origin: ALLOWED_ORIGINS,
    methods: ["GET", "POST"],
    credentials: false,
  })
);

// ------------------------------
// Memoria en RAM (por threadId) + perfiles .ini
// ------------------------------
const memory = new Map(); // threadId -> [{ role, text }]
const profiles = new Map(); // threadId -> { raw, data, summary }
const MAX_TURNS = 12;

function getThread(threadId) {
  if (!memory.has(threadId)) memory.set(threadId, []);
  return memory.get(threadId);
}

function pushTurn(threadId, role, text) {
  const thread = getThread(threadId);
  thread.push({ role, text });
  while (thread.length > MAX_TURNS) thread.shift();
}

// ------------------------------
// Sistema / Prompt de Oppi
// ------------------------------
const SYSTEM = `Sos Oppi, asistente experto en impresión 3D (PrusaSlicer/OctoPrint).
- Español rioplatense, claro y amable.
- Cuando el usuario pida un perfil, devolvelo SIEMPRE dentro de un bloque \`\`\`ini ... \`\`\` como Config Bundle válido ([print], [filament], [printer]) sin texto fuera del bloque.
- Si hay ambigüedad, hacé 1-2 preguntas de seguimiento muy concretas.
- Recordá el contexto reciente (pieza, material, impresora) y retomalo.`;

// ------------------------------
// Helpers para resumen de perfil .ini
// ------------------------------
const pick = (obj, keys) => {
  const o = {};
  for (const k of keys)
    if (obj && Object.prototype.hasOwnProperty.call(obj, k)) o[k] = obj[k];
  return o;
};

function summarizeProfile(iniData) {
  const print = iniData.print || iniData.Print || {};
  const filament = iniData.filament || iniData.Filament || {};
  const printer = iniData.printer || iniData.Printer || {};

  const corePrint = pick(print, [
    "layer_height",
    "perimeters",
    "top_solid_layers",
    "bottom_solid_layers",
    "fill_density",
    "fill_pattern",
    "fill_angle",
    "perimeter_speed",
    "infill_speed",
    "solid_infill_speed",
    "top_solid_infill_speed",
    "gap_fill_speed",
    "travel_speed",
    "first_layer_speed",
    "bridge_speed",
  ]);
  const coreTemp = pick(filament, [
    "temperature",
    "first_layer_temperature",
    "bed_temperature",
    "first_layer_bed_temperature",
  ]);
  const coreFan = pick(filament, [
    "min_fan_speed",
    "max_fan_speed",
    "bridge_fan_speed",
  ]);
  const corePrinter = pick(printer, [
    "nozzle_diameter",
    "max_print_height",
    "bed_shape",
  ]);

  const lines = [];
  lines.push("**Resumen de perfil importado**");
  if (Object.keys(coreTemp).length)
    lines.push("— **Temperaturas**: " + JSON.stringify(coreTemp));
  if (Object.keys(coreFan).length)
    lines.push("— **Ventilador**: " + JSON.stringify(coreFan));
  if (Object.keys(corePrint).length)
    lines.push("— **Impresión/Velocidades**: " + JSON.stringify(corePrint));
  if (Object.keys(corePrinter).length)
    lines.push("— **Impresora**: " + JSON.stringify(corePrinter));
  if (lines.length === 1)
    lines.push("Secciones detectadas: " + JSON.stringify(Object.keys(iniData)));
  return lines.join("\n");
}

async function writeTmpIni(iniText) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "oppi-"));
  const file = path.join(dir, "oppi-profile.prusa.ini");
  await fs.writeFile(file, iniText, "utf8");
  return file;
}

// ------------------------------
// Generador de .ini — PARAM_KEYS, normalización, bed_shape
// ------------------------------
const PARAM_KEYS = [
  // capas/geometría
  "layer_height",
  "perimeters",
  "top_solid_layers",
  "bottom_solid_layers",
  "first_layer_height",
  // densidad/patrón
  "fill_density",
  "fill_pattern",
  "fill_angle",
  // velocidades
  "perimeter_speed",
  "infill_speed",
  "solid_infill_speed",
  "top_solid_infill_speed",
  "gap_fill_speed",
  "travel_speed",
  "first_layer_speed",
  "bridge_speed",
  // temperaturas
  "first_layer_temperature",
  "temperature",
  "bed_temperature",
  "first_layer_bed_temperature",
  // ventilador
  "min_fan_speed",
  "max_fan_speed",
  "bridge_fan_speed",
  // retracción
  "retract_length",
  "retract_speed",
  "deretract_speed",
  "retract_restart_extra",
  "retract_lift",
  // adhesión
  "brim_width",
  "brim_type",
  "skirt_distance",
  "skirts",
  // filamento/boquilla
  "filament_diameter",
  "extrusion_multiplier",
  "nozzle_diameter",
  // impresora/volumen cama
  "max_print_height",
  "bed_shape",
];

const KEY_MAP = {
  // infill
  infill_density: "fill_density",
  infill_pattern: "fill_pattern",
  // ventilador
  fan_speed: "min_fan_speed",
  fan_min_speed: "min_fan_speed",
  fan_max_speed: "max_fan_speed",
  // temperaturas
  nozzle_temperature: "temperature",
  // retracción
  lift_z: "retract_lift",
};

const PERCENT_KEYS = new Set([
  "fill_density",
  "min_fan_speed",
  "max_fan_speed",
  "bridge_fan_speed",
]);

function normalizeParams(raw = {}) {
  const out = {};
  // mapear sinónimos
  for (const [k, v] of Object.entries(raw)) out[KEY_MAP[k] || k] = v;
  // fan_speed => min/max si faltan
  if (raw.fan_speed != null) {
    if (out.min_fan_speed == null) out.min_fan_speed = raw.fan_speed;
    if (out.max_fan_speed == null) out.max_fan_speed = raw.fan_speed;
  }
  // tipado y % explícito
  for (const k of Object.keys(out)) {
    let val = out[k];
    if (
      typeof val === "string" &&
      val.trim() !== "" &&
      !val.trim().endsWith("%") &&
      !isNaN(Number(val))
    ) {
      val = Number(val);
    }
    if (PERCENT_KEYS.has(k) && typeof val === "number") val = `${val}%`;
    out[k] = val;
  }
  return out;
}

function sanitizeBedShape(val) {
  if (!val) return null;
  val = String(val).replace(/\s+/g, "");
  const ok =
    /^-?\d+(\.\d+)?x-?\d+(\.\d+)?(,-?\d+(\.\d+)?x-?\d+(\.\d+)?){3,}$/i.test(
      val
    );
  return ok ? val : null;
}

function defaultBedShapeFor(threadId) {
  if (profiles.has(threadId)) {
    const dat = profiles.get(threadId).data;
    const raw = dat?.printer?.bed_shape || dat?.bed_shape;
    const s = sanitizeBedShape(raw);
    if (s) return s;
  }
  // default: MK3S 250x210
  return "0x0,250x0,250x210,0x210";
}

function buildIniFromParams(params = {}, ctx = {}) {
  const p = normalizeParams(params);

  // asegurar bed_shape válido
  let bedShape = sanitizeBedShape(p.bed_shape);
  if (!bedShape) bedShape = defaultBedShapeFor(ctx.threadId);
  p.bed_shape = bedShape;

  const filtered = {};
  for (const k of PARAM_KEYS) {
    const v = p[k];
    if (v !== undefined && v !== null && v !== "") filtered[k] = v;
  }

  const GROUPS = [
    [
      "; ---- Capas/Geometría",
      [
        "layer_height",
        "first_layer_height",
        "perimeters",
        "top_solid_layers",
        "bottom_solid_layers",
        "nozzle_diameter",
      ],
    ],
    [
      "; ---- Infill",
      ["fill_density", "fill_pattern", "fill_angle"],
    ],
    [
      "; ---- Velocidades",
      [
        "perimeter_speed",
        "infill_speed",
        "solid_infill_speed",
        "top_solid_infill_speed",
        "gap_fill_speed",
        "first_layer_speed",
        "bridge_speed",
        "travel_speed",
      ],
    ],
    [
      "; ---- Temperaturas",
      [
        "temperature",
        "first_layer_temperature",
        "bed_temperature",
        "first_layer_bed_temperature",
      ],
    ],
    [
      "; ---- Ventilador",
      ["min_fan_speed", "max_fan_speed", "bridge_fan_speed"],
    ],
    [
      "; ---- Retracción/Mov.",
      [
        "retract_length",
        "retract_speed",
        "deretract_speed",
        "retract_restart_extra",
        "retract_lift",
      ],
    ],
    [
      "; ---- Adhesión",
      ["brim_type", "brim_width", "skirt_distance", "skirts"],
    ],
    [
      "; ---- Filamento/Impresora",
      [
        "filament_diameter",
        "extrusion_multiplier",
        "max_print_height",
        "bed_shape",
      ],
    ],
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

  const rest = Object.keys(filtered).filter((k) => !printed.has(k));
  if (rest.length)
    out +=
      `; ---- Otros\n` +
      rest.map((k) => `${k} = ${filtered[k]}`).join("\n") +
      "\n";

  return out.trim() + "\n";
}

// ------------------------------
// Biblioteca STL
// ------------------------------
let STL_CACHE = null;
async function loadStlLibrary() {
  if (STL_CACHE) return STL_CACHE;
  try {
    const raw = await fs.readFile(
      path.join(process.cwd(), "data", "stl-library.json"),
      "utf8"
    );
    STL_CACHE = JSON.parse(raw);
  } catch (e) {
    console.error("❌ Error cargando stl-library.json:", e);
    STL_CACHE = [];
  }
  return STL_CACHE;
}

function stlScore(model, query) {
  const full =
    (model.nombre || "") +
    " " +
    (model.descripcion || "") +
    " " +
    (model.categoria || "") +
    " " +
    (Array.isArray(model.tags) ? model.tags : []).join(" ");

  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  let score = 0;
  for (const w of words) if (full.toLowerCase().includes(w)) score++;
  return score;
}

async function bestStl(prompt) {
  const lib = await loadStlLibrary();
  const matches = lib
    .map((m) => ({ ...m, score: stlScore(m, prompt) }))
    .filter((m) => m.score > 0)
    .sort((a, b) => b.score - a.score);

  return matches[0] || null;
}

function describeStlLibraryForAi(lib) {
  return lib
    .map((m, i) => {
      const tags = Array.isArray(m.tags) ? m.tags.join(", ") : "";
      return `#${i + 1}
archivo: ${m.archivo}
nombre: ${m.nombre}
descripcion: ${m.descripcion}
categoria: ${m.categoria}
dificultad: ${m.dificultad}
tags: ${tags}`;
    })
    .join("\n\n");
}

// ------------------------------
// Supabase: helpers de conversación/mensajes
// ------------------------------
async function getOrCreateConversation({ userId, threadId, title }) {
  const { data, error } = await supabaseAdmin
    .from("conversations")
    .select("*")
    .eq("user_id", userId)
    .eq("thread_id", threadId)
    .limit(1);

  if (error) {
    console.error("❌ Error buscando conversation:", error);
    throw new Error("No pude buscar la conversación");
  }

  if (data && data.length) return data[0];

  const { data: inserted, error: insErr } = await supabaseAdmin
    .from("conversations")
    .insert({
      user_id: userId,
      thread_id: threadId,
      title: title || "Conversación Oppi",
    })
    .select()
    .single();

  if (insErr) {
    console.error("❌ Error creando conversation:", insErr);
    throw new Error("No pude crear la conversación");
  }

  return inserted;
}

async function insertMessage({ conversationId, role, content }) {
  const { error } = await supabaseAdmin.from("messages").insert({
    conversation_id: conversationId,
    role,
    content,
  });

  if (error) {
    console.error("❌ Error insertando mensaje:", error);
  }
}

// Actualiza summary con los últimos 3 mensajes de esa conversación
async function updateConversationSummary(conversationId) {
  const { data: msgs, error } = await supabaseAdmin
    .from("messages")
    .select("role, content, created_at")
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: true })
    .limit(20);

  if (error) {
    console.error("❌ Error trayendo mensajes para summary:", error);
    return;
  }
  if (!msgs || !msgs.length) return;

  const lastMsgs = msgs.slice(-3);
  const lines = lastMsgs.map((m) => {
    const speaker = m.role === "user" ? "Usuario" : "Oppi";
    return `${speaker}: ${m.content}`;
  });

  let summaryText = lines.join("\n");
  if (summaryText.length > 900) {
    summaryText = summaryText.slice(0, 900) + "...";
  }

  const { error: upErr } = await supabaseAdmin
    .from("conversations")
    .update({
      summary: summaryText,
      updated_at: new Date().toISOString(),
    })
    .eq("id", conversationId);

  if (upErr) {
    console.error("❌ Error actualizando summary:", upErr);
  }
}

// ------------------------------
// Rutas
// ------------------------------

// CHAT — ahora ligado a Supabase por cuenta + resumen por conversación
app.post("/chat-oppi", requireSupabaseUser, async (req, res) => {
  try {
    const userId = req.supabaseUser.id;
    const { message, threadId } = req.body || {};
    if (!message || !threadId) {
      return res.status(400).json({ error: "Falta message o threadId." });
    }

    // 1) Conversación en Supabase (por usuario + threadId)
    const conversation = await getOrCreateConversation({
      userId,
      threadId,
      title: "Conversación de impresión 3D",
    });

    // 2) Contexto de perfil .ini (si existe en RAM)
    let profileContext = "";
    if (profiles.has(threadId)) {
      profileContext = `\n\n[Contexto de perfil importado]\n${profiles.get(threadId).summary}\n`;
    }

    // 3) Resumen guardado en DB para esta conversación
    const summaryText =
      conversation.summary || "Sin resumen previo todavía en esta conversación.";

    const systemText = `${SYSTEM}

[Resumen de esta conversación]
${summaryText}
${profileContext}
`;

    const history = getThread(threadId);

    const contents = [
      { role: "user", parts: [{ text: systemText }] },
      ...history.map((t) => ({
        role: t.role === "model" ? "model" : "user",
        parts: [{ text: t.text }],
      })),
      { role: "user", parts: [{ text: message }] },
    ];

    const text = await askGemini("gemini-2.0-flash", contents);
    const finalReply =
      text || "No pude generar respuesta por el momento. Probá de nuevo.";

    // 4) Memoria RAM para contexto corto
    pushTurn(threadId, "user", message);
    pushTurn(threadId, "model", finalReply);

    // 5) Guardar en Supabase: mensaje de usuario + Oppi
    await insertMessage({
      conversationId: conversation.id,
      role: "user",
      content: message,
    });
    await insertMessage({
      conversationId: conversation.id,
      role: "assistant",
      content: finalReply,
    });

    // 6) Actualizar resumen (no esperamos)
    updateConversationSummary(conversation.id).catch((e) =>
      console.error("❌ Error recalculando summary:", e)
    );

    res.json({ reply: finalReply });
  } catch (err) {
    console.error("❌ Chat error:", err);
    res.status(500).json({ error: "Error al generar respuesta." });
  }
});

// RESET hilo — limpia RAM y mensajes/summary en DB de ese thread
app.post("/reset-thread", requireSupabaseUser, async (req, res) => {
  try {
    const userId = req.supabaseUser.id;
    const { threadId } = req.body || {};
    if (!threadId) {
      return res.status(400).json({ error: "Falta threadId." });
    }

    // Limpiamos memoria en RAM
    memory.delete(threadId);
    profiles.delete(threadId);

    // Buscamos la conversación en DB
    const { data, error } = await supabaseAdmin
      .from("conversations")
      .select("id")
      .eq("user_id", userId)
      .eq("thread_id", threadId)
      .limit(1);

    if (!error && data && data.length) {
      const convId = data[0].id;

      // Borramos mensajes y reseteamos summary
      await supabaseAdmin
        .from("messages")
        .delete()
        .eq("conversation_id", convId);

      await supabaseAdmin
        .from("conversations")
        .update({
          summary: null,
          updated_at: new Date().toISOString(),
        })
        .eq("id", convId);
    }

    res.json({ ok: true });
  } catch (err) {
    console.error("❌ reset-thread error:", err);
    res.status(500).json({ error: "No se pudo resetear el hilo." });
  }
});

// IMPORTAR .ini
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024 },
});

app.post(
  "/import-ini",
  requireSupabaseUser,
  upload.single("file"),
  async (req, res) => {
    try {
      const { threadId } = req.body || {};
      if (!threadId)
        return res.status(400).json({ error: "Falta threadId." });
      if (!req.file)
        return res.status(400).json({ error: "Subí un archivo .ini." });

      const raw = req.file.buffer.toString("utf8");
      const data = ini.parse(raw);
      const summary = summarizeProfile(data);

      profiles.set(threadId, { raw, data, summary });
      pushTurn(
        threadId,
        "user",
        `Nota de sistema: Se importó un perfil .ini para este hilo.\n${summary}`
      );
      res.json({ ok: true, summary });
    } catch (err) {
      console.error("❌ import-ini error:", err);
      res.status(500).json({ error: "No se pudo importar el .ini." });
    }
  }
);

// GENERAR .ini con IA
app.post("/generate-ini-ai", requireSupabaseUser, async (req, res) => {
  try {
    const { threadId, overrides } = req.body || {};
    if (!threadId) return res.status(400).json({ error: "Falta threadId." });

    const history = getThread(threadId);
    let profileContext = "";
    if (profiles.has(threadId))
      profileContext = `\n\n[Contexto de perfil importado]\n${profiles.get(threadId).summary}\n`;

    const schemaList = PARAM_KEYS.map((k) => `"${k}"`).join(", ");
    const askJson = `
Quiero que construyas un JSON de parámetros para PrusaSlicer (modo principiante estable).
Usá SOLO estas claves exactamente (puede faltar alguna si no aplica): [${schemaList}].
Valores numéricos donde corresponda (mm, mm/s, °C, %, etc.). Si falta info, elegí valores seguros tipo "Modo Abuela".
IMPORTANTE: respondé SOLO con JSON plano válido (sin markdown, sin comentarios, sin texto extra).
`;

    const contents = [
      { role: "user", parts: [{ text: SYSTEM + profileContext }] },
      ...history.map((t) => ({
        role: t.role === "model" ? "model" : "user",
        parts: [{ text: t.text }],
      })),
      { role: "user", parts: [{ text: askJson }] },
    ];

    const raw = await askGemini("gemini-2.5-flash", contents);
    if (!raw) {
      console.error("❌ generate-ini-ai: IA no devolvió texto");
      return res.status(502).json({ error: "La IA no devolvió contenido." });
    }

    const json = extractJsonFromText(raw);
    if (!json) {
      console.error("❌ Respuesta cruda de la IA (sin JSON válido):\n", raw);
      return res.status(502).json({ error: "La IA no devolvió JSON válido." });
    }

    const params = { ...json, ...(overrides || {}) };
    const iniText = buildIniFromParams(params, { threadId });

    res.json({ ok: true, params: normalizeParams(params), iniText });
  } catch (err) {
    console.error("❌ generate-ini-ai error:", err);
    res.status(500).json({ error: "No pude generar el .ini con IA." });
  }
});

// SUGERIR STL (simple, por texto)
app.post("/api/stl/suggest", async (req, res) => {
  try {
    const { prompt } = req.body || {};
    if (!prompt || !prompt.trim()) return res.json({ found: false });

    const model = await bestStl(prompt);
    if (!model) return res.json({ found: false });

    res.json({ found: true, model });
  } catch (err) {
    console.error("❌ STL error:", err);
    res.status(500).json({ error: "No pude buscar STL." });
  }
});

// SUGERIR STL usando IA + historial de conversación
app.post("/api/stl/suggest-ai", requireSupabaseUser, async (req, res) => {
  try {
    const { threadId } = req.body || {};
    if (!threadId) {
      return res.status(400).json({ ok: false, error: "Falta threadId." });
    }

    const history = getThread(threadId);
    const lib = await loadStlLibrary();
    if (!lib.length) {
      return res.json({ ok: false, error: "Biblioteca STL vacía." });
    }

    const libDesc = describeStlLibraryForAi(lib);

    const ask = `
Tenés esta conversación previa con el usuario sobre impresión 3D y esta biblioteca de modelos STL.
Elegí EL MEJOR modelo STL de la lista para que imprima ahora.

Devolvé EXCLUSIVAMENTE un JSON válido con esta forma:

{
  "archivo": "nombre_del_archivo.stl",
  "nombre": "Nombre legible del modelo",
  "motivo": "Texto corto explicando por qué lo elegiste"
}

Usá SIEMPRE un valor de "archivo" que esté EXACTAMENTE en el campo "archivo" de alguno de los modelos listados.

Biblioteca de modelos:

${libDesc}
`;

    const contents = [
      { role: "user", parts: [{ text: SYSTEM }] },
      ...history.map((t) => ({
        role: t.role === "model" ? "model" : "user",
        parts: [{ text: t.text }],
      })),
      { role: "user", parts: [{ text: ask }] },
    ];

    const raw = await askGemini("gemini-2.0-flash", contents);
    if (!raw) {
      console.error("❌ STL AI: IA no devolvió texto");
      return res
        .status(502)
        .json({ ok: false, error: "La IA no devolvió contenido." });
    }

    const json = extractJsonFromText(raw);
    if (!json || !json.archivo) {
      console.error("❌ STL AI sin JSON válido. Respuesta cruda:\n", raw);

      // Fallback: simplemente usar el primer modelo de la biblioteca
      const fallback = lib[0];
      return res.json({
        ok: true,
        model: fallback,
        motivo:
          "Usé un modelo de la biblioteca por defecto porque la IA no respondió con un JSON válido.",
      });
    }

    // Buscar en la biblioteca el archivo elegido
    const model =
      lib.find((m) => m.archivo === json.archivo) ||
      (await bestStl(json.nombre || json.motivo || json.archivo)) ||
      lib[0];

    return res.json({
      ok: true,
      model,
      motivo: json.motivo || null,
    });
  } catch (err) {
    console.error("❌ STL AI error:", err);
    return res
      .status(500)
      .json({ ok: false, error: "No pude elegir un STL con IA." });
  }
});

// (Opcional) ABRIR en PrusaSlicer local
app.post("/open-prusa", async (req, res) => {
  try {
    const { iniText, iniPath } = req.body || {};
    const prusaPath = process.env.PRUSASLICER_PATH;
    if (!prusaPath)
      return res
        .status(400)
        .json({ error: "Falta PRUSASLICER_PATH en .env" });

    let fileToLoad = iniPath;
    if (!fileToLoad) {
      if (!iniText)
        return res
          .status(400)
          .json({ error: "Falta iniText o iniPath." });
      fileToLoad = await writeTmpIni(iniText);
    }

    const child = spawn(prusaPath, ["--load", fileToLoad], {
      detached: true,
      stdio: "ignore",
    });
    child.unref();
    res.json({ ok: true, loaded: fileToLoad });
  } catch (err) {
    console.error("❌ open-prusa error:", err);
    res
      .status(500)
      .json({ error: "No pude abrir PrusaSlicer con ese .ini." });
  }
});

// Info de la cuenta (debug)
app.get("/api/me", requireSupabaseUser, (req, res) => {
  res.json({
    id: req.supabaseUser.id,
    email: req.supabaseUser.email,
  });
});

// ------------------------------
// Iniciar servidor
// ------------------------------
const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, () => {
  console.log(`🧠 Oppi con memoria + Supabase en puerto ${PORT}`);
});

server.on("error", (err) => {
  console.error("❌ No se pudo iniciar el servidor:", err);
  process.exit(1);
});
