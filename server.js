"use strict";
/* ============================================================================
   Mourad Mekki Teacher Toolkit — IELTS Speaking Assessment · Backend
   - Serves the single-page frontend from /public
   - POST /api/transcribe : audio -> Groq Whisper -> transcript (+segments)
   - POST /api/score      : session + baseline -> Groq Llama -> final report
   - GET/POST/DELETE /api/sessions : optional durable session store (JSON file)
   Runs in MOCK mode (no cost) when GROQ_API_KEY is unset, so it works out of
   the box for testing; add a key to enable real AI.
   ============================================================================ */

require("dotenv").config();
const express = require("express");
const multer = require("multer");
const path = require("path");
const scoring = require("./scoring");
const store = require("./store");

const PORT = process.env.PORT || 8787;
const GROQ_API_KEY = (process.env.GROQ_API_KEY || "").trim();
const WHISPER_MODEL = (process.env.WHISPER_MODEL || "whisper-large-v3-turbo").trim();
const SCORING_MODEL = (process.env.SCORING_MODEL || "llama-3.3-70b-versatile").trim();
const MOCK = process.env.MOCK === "1" || !GROQ_API_KEY;

const app = express();
app.use(express.json({ limit: "16mb" }));

// Permissive CORS (so the frontend also works if opened from a different origin)
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", req.headers.origin || "*");
  res.header("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if(req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

/* ------------------------------- routes ----------------------------------- */
app.get("/api/config", (req, res) => {
  res.json({
    ok: true,
    mock: MOCK,
    transcription: { enabled: true, provider: "groq", model: MOCK ? "mock" : WHISPER_MODEL },
    scoring: { enabled: true, provider: "groq", model: MOCK ? "mock" : SCORING_MODEL },
    sessions: { enabled: true, store: store.info().driver },
    brand: "Mourad Mekki Teacher Toolkit"
  });
});

app.post("/api/transcribe", upload.single("audio"), async (req, res) => {
  try{
    if(!req.file || !req.file.buffer || !req.file.buffer.length){
      return res.status(400).json({ error: "No audio uploaded (field name must be 'audio')." });
    }
    const language = (req.body && req.body.language) || undefined;
    if(MOCK){
      return res.json(scoring.mockTranscript());
    }
    const result = await scoring.transcribeBuffer(
      req.file.buffer, req.file.mimetype, req.file.originalname,
      { apiKey: GROQ_API_KEY, model: WHISPER_MODEL, language }
    );
    res.json(result);
  }catch(err){
    console.warn("transcribe error:", err.message);
    res.status(err.status || 502).json({ error: "Transcription failed: " + err.message });
  }
});

app.post("/api/score", async (req, res) => {
  try{
    const { session, baseline } = req.body || {};
    if(!baseline || !baseline.criteria){
      return res.status(400).json({ error: "Missing baseline score in request body." });
    }
    if(MOCK){
      return res.json({ scored: scoring.mergeOverlay(baseline, scoring.mockOverlay(baseline), "mock"), mock: true });
    }
    const scored = await scoring.scoreSession(session, baseline, { apiKey: GROQ_API_KEY, model: SCORING_MODEL });
    res.json({ scored });
  }catch(err){
    console.warn("score error:", err.message);
    // Graceful: return the baseline so the report still renders.
    res.json({ scored: req.body && req.body.baseline, warning: "AI scoring failed: " + err.message });
  }
});

app.get("/api/sessions", async (req, res) => {
  try{ res.json(await store.list()); }
  catch(err){ console.warn("sessions list error:", err.message); res.status(500).json({ error: err.message }); }
});
app.post("/api/sessions", async (req, res) => {
  const session = req.body;
  if(!session || !session.id) return res.status(400).json({ error: "Session must have an id." });
  try{ await store.save(session); res.json({ ok: true }); }
  catch(err){ console.warn("session save error:", err.message); res.status(500).json({ error: err.message }); }
});
app.delete("/api/sessions/:id", async (req, res) => {
  try{ await store.remove(req.params.id); res.json({ ok: true }); }
  catch(err){ console.warn("session delete error:", err.message); res.status(500).json({ error: err.message }); }
});

// Static frontend
app.use(express.static(path.join(__dirname, "public")));
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

store.init().then((s) => {
  app.listen(PORT, () => {
    console.log(`\n  Mourad Mekki Teacher Toolkit · IELTS backend`);
    console.log(`  ▸ http://localhost:${PORT}`);
    console.log(`  ▸ mode: ${MOCK ? "MOCK (no API key — canned data, no cost)" : "LIVE (Groq)"}`);
    if(!MOCK){
      console.log(`  ▸ transcription: ${WHISPER_MODEL}`);
      console.log(`  ▸ scoring:       ${SCORING_MODEL}`);
    } else {
      console.log(`  ▸ add GROQ_API_KEY to .env to enable real transcription + AI scoring`);
    }
    console.log(`  ▸ session store: ${s.driver}${s.driver === "file" ? " ("+store.info().dataDir+")" : ""}`);
    console.log("");
  });
});
