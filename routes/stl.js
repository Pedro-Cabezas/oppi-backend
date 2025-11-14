// routes/stl.js
const express = require("express");
const router = express.Router();

const stlLibrary = require("../data/stl-library.json");

// Función simple para puntuar qué tan bien matchea un modelo
function scoreModel(model, query) {
  const text = (
    model.nombre + " " +
    model.descripcion + " " +
    model.categoria + " " +
    model.tags.join(" ")
  ).toLowerCase();

  const words = query.toLowerCase().split(/\s+/).filter(Boolean);

  let score = 0;
  for (const w of words) {
    if (text.includes(w)) score++;
  }
  return score;
}

function findBestStl(query) {
  const scored = stlLibrary
    .map(m => ({ ...m, score: scoreModel(m, query) }))
    .filter(m => m.score > 0)
    .sort((a, b) => b.score - a.score);

  return scored[0] || null;
}

// POST /api/stl/suggest
router.post("/suggest", (req, res) => {
  const { prompt } = req.body;

  if (!prompt || !prompt.trim()) {
    return res.status(400).json({ error: "Falta el texto de búsqueda (prompt)." });
  }

  const best = findBestStl(prompt);

  if (!best) {
    return res.json({ found: false });
  }

  return res.json({
    found: true,
    model: best
  });
});

module.exports = router;
