"use strict";
/* ============================================================================
   scoring.js — Groq integration + report assembly
   - mapWhisper(): Whisper verbose_json -> internal transcriptionResult shape
   - scoreSession(): asks the LLM for band judgements, merges onto the
     rule-based baseline the frontend already computed, returns final `scored`.
   The rule-based baseline guarantees a complete, valid report even if the LLM
   call fails; the LLM only refines the three transcript-based criteria, the
   prose feedback, and the recommendations.
   ============================================================================ */

const GROQ_BASE = "https://api.groq.com/openai/v1";

function clamp(v, lo, hi){ return Math.max(lo, Math.min(hi, v)); }
function roundHalf(x){ return Math.round(x * 2) / 2; }
function clampBand(b){ return clamp(roundHalf(Number(b)), 0, 9); }
function mean(a){ return a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0; }

function cefrFor(overall){
  if(overall == null) return { level: "—", label: "Not assessed" };
  if(overall >= 8.5) return { level: "C2", label: "Proficient" };
  if(overall >= 7.0) return { level: "C1", label: "Advanced" };
  if(overall >= 5.5) return { level: "B2", label: "Upper Intermediate" };
  if(overall >= 4.0) return { level: "B1", label: "Intermediate" };
  if(overall >= 3.0) return { level: "A2", label: "Elementary" };
  return { level: "A1", label: "Beginner" };
}

/* ---- Whisper verbose_json -> internal transcriptionResult ---------------- */
function mapWhisper(json, fallbackDurationMs, model){
  const conf = (avgLogprob, noSpeechProb) => {
    let c = (typeof avgLogprob === "number") ? Math.exp(avgLogprob) : 0.85;
    if(typeof noSpeechProb === "number") c *= (1 - clamp(noSpeechProb, 0, 1));
    return clamp(c, 0, 1);
  };
  const raw = Array.isArray(json.segments) ? json.segments : [];
  let segments = raw.map(s => ({
    startMs: Math.round((s.start || 0) * 1000),
    endMs: Math.round((s.end || 0) * 1000),
    text: (s.text || "").trim(),
    confidence: conf(s.avg_logprob, s.no_speech_prob)
  })).filter(s => s.text);
  const text = (json.text || segments.map(s => s.text).join(" ")).trim();
  if(!segments.length && text){
    segments = [{ startMs: 0, endMs: Math.round(json.duration ? json.duration * 1000 : (fallbackDurationMs || 0)), text, confidence: 0.85 }];
  }
  const confidence = segments.length ? mean(segments.map(s => s.confidence)) : 0;
  return {
    text, segments, words: [],
    confidence: confidence || 0,
    languageDetected: json.language || "en",
    durationMs: Math.round(json.duration ? json.duration * 1000 : (fallbackDurationMs || 0)),
    provider: "whisper",
    providerMeta: { model: model || "whisper", segmentCount: segments.length },
    warnings: [], sourceTags: ["transcript"], stability: 0.95
  };
}

/* ---- Transcribe a single audio buffer via Groq -------------------------- */
async function transcribeBuffer(buffer, mimetype, filename, opts){
  const { apiKey, model, language } = opts;
  const fd = new FormData();
  fd.append("file", new Blob([buffer], { type: mimetype || "audio/webm" }), filename || "recording.webm");
  fd.append("model", model);
  if(language && language !== "auto") fd.append("language", language);
  fd.append("response_format", "verbose_json");
  fd.append("temperature", "0");
  const res = await fetch(GROQ_BASE + "/audio/transcriptions", {
    method: "POST", headers: { Authorization: `Bearer ${apiKey}` }, body: fd
  });
  if(!res.ok){
    let msg = `HTTP ${res.status}`;
    try{ const j = await res.json(); msg = (j.error && j.error.message) || JSON.stringify(j); }
    catch(e){ try{ msg = (await res.text()).slice(0, 200); }catch(_){} }
    const err = new Error(msg); err.status = res.status; throw err;
  }
  const json = await res.json();
  return mapWhisper(json, 0, model);
}

/* ---- Build a compact transcript view for the LLM ------------------------ */
function serializeSessionForLLM(session){
  const partLabels = { part1: "Part 1 (Introduction & familiar topics)", part2: "Part 2 (Long turn)", part3: "Part 3 (Discussion)" };
  const lines = [];
  for(const k of ["part1", "part2", "part3"]){
    const pm = session.parts && session.parts[k];
    if(!pm) continue;
    const text = (pm.transcriptionResult && pm.transcriptionResult.text) || "";
    const ex = (session.examinerTurns || []).filter(t => t.partKey === k).map(t => t.text);
    const wpm = pm.speakingTimeMs ? Math.round(((text.trim().split(/\s+/).filter(Boolean).length) / (pm.speakingTimeMs / 60000))) : 0;
    lines.push(`### ${partLabels[k]}`);
    if(ex.length) lines.push(`Examiner prompts: ${ex.slice(0, 6).join(" | ")}`);
    lines.push(`Speaking pace: ~${wpm} wpm; speech-to-silence ratio: ${Math.round((pm.speechRatio || 0) * 100)}%.`);
    lines.push(`Candidate said: """${text || "(no speech transcribed)"}"""`);
    lines.push("");
  }
  return lines.join("\n");
}

const SYSTEM_PROMPT = `You are a certified IELTS Speaking examiner. You assess a candidate's recorded Speaking test against the official IELTS public band descriptors, scoring in whole or half bands from 0 to 9.

You score exactly THREE criteria (pronunciation is assessed separately from audio and is NOT your job):
- Fluency and Coherence: speech rate, hesitation, self-correction, cohesion, ability to develop topics.
- Lexical Resource: range and precision of vocabulary, collocation, paraphrase, idiomatic usage.
- Grammatical Range and Accuracy: range of structures, complexity, and error frequency/communicative effect.

Calibrate honestly against the descriptors — do not inflate. Ground every judgement in concrete evidence from the transcript. A short or empty transcript means a low band for the affected criteria.

Return ONLY a single JSON object (no markdown, no commentary) with this exact schema:
{
  "criteria": { "fluencyCoherence": number, "lexical": number, "grammar": number },
  "performanceSummary": [ "2 to 3 short paragraphs, each a string, written to the candidate in an examiner's voice" ],
  "detailedAnalysis": {
    "fluencyCoherence": "2-4 sentences citing transcript evidence",
    "lexical": "2-4 sentences citing specific words/phrases used or missing",
    "grammar": "2-4 sentences citing structures and any recurring errors",
    "pronunciation": "1-2 neutral sentences on delivery, noting this is assessed acoustically"
  },
  "recommendations": {
    "immediate": [ { "title": "...", "body": "actionable, 1-2 sentences", "descriptorGap": "the band-descriptor gap this closes" } ],
    "shortTerm": [ { "title": "...", "body": "...", "descriptorGap": "..." } ],
    "targetBand": [ { "title": "...", "body": "...", "descriptorGap": "..." } ]
  },
  "errorsByPart": { "part1": ["short verbatim error example"], "part2": [], "part3": [] }
}
Provide 1-3 items in each recommendations list. Keep all text concise and specific.`;

async function callGroqLLM(messages, opts){
  const { apiKey, model } = opts;
  const res = await fetch(GROQ_BASE + "/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      messages,
      temperature: 0.2,
      max_tokens: 1600,
      response_format: { type: "json_object" }
    })
  });
  if(!res.ok){
    let msg = `HTTP ${res.status}`;
    try{ const j = await res.json(); msg = (j.error && j.error.message) || JSON.stringify(j); }
    catch(e){ try{ msg = (await res.text()).slice(0, 200); }catch(_){} }
    const err = new Error(msg); err.status = res.status; throw err;
  }
  const data = await res.json();
  const content = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
  return JSON.parse(content);
}

/* ---- Merge an LLM overlay onto the rule-based baseline ------------------- */
function mergeOverlay(baseline, overlay, providerLabel){
  const scored = JSON.parse(JSON.stringify(baseline || {}));
  scored.criteria = scored.criteria || {};
  if(overlay && overlay.criteria){
    if(overlay.criteria.fluencyCoherence != null) scored.criteria.fluencyCoherence = clampBand(overlay.criteria.fluencyCoherence);
    if(overlay.criteria.lexical != null) scored.criteria.lexical = clampBand(overlay.criteria.lexical);
    if(overlay.criteria.grammar != null) scored.criteria.grammar = clampBand(overlay.criteria.grammar);
    // pronunciation intentionally left as the baseline (acoustic) value
  }
  const bands = [scored.criteria.fluencyCoherence, scored.criteria.lexical, scored.criteria.grammar, scored.criteria.pronunciation]
    .filter(b => typeof b === "number");
  if(bands.length) scored.overall = roundHalf(mean(bands));
  scored.cefr = cefrFor(scored.overall);

  if(overlay){
    scored.feedback = scored.feedback || {};
    if(Array.isArray(overlay.performanceSummary) && overlay.performanceSummary.length)
      scored.feedback.performanceSummary = overlay.performanceSummary;
    if(overlay.detailedAnalysis)
      scored.feedback.detailedAnalysis = { ...(scored.feedback.detailedAnalysis || {}), ...overlay.detailedAnalysis };
    if(overlay.recommendations) scored.recommendations = overlay.recommendations;
    if(overlay.errorsByPart && scored.analyzed){
      for(const k of ["part1", "part2", "part3"]){
        if(scored.analyzed[k] && scored.analyzed[k].metrics && Array.isArray(overlay.errorsByPart[k])){
          scored.analyzed[k].metrics.errors = overlay.errorsByPart[k].map(t => ({ text: t }));
        }
      }
    }
  }
  scored.scoringProvider = providerLabel;
  scored.engineVersion = (baseline && baseline.engineVersion ? baseline.engineVersion : "5.75.0") + "+ai";
  scored.computedAt = new Date().toISOString();
  return scored;
}

async function scoreSession(session, baseline, opts){
  const messages = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content:
      `Candidate: ${session.studentName || "Unknown"}.\n` +
      `Rule-based baseline bands (reference only — judge independently): ` +
      `F&C ${baseline.criteria.fluencyCoherence}, Lexical ${baseline.criteria.lexical}, Grammar ${baseline.criteria.grammar}.\n\n` +
      serializeSessionForLLM(session) +
      `\nReturn the JSON object now.` }
  ];
  const overlay = await callGroqLLM(messages, opts);
  return mergeOverlay(baseline, overlay, "groq:" + opts.model);
}

/* ---- Mock implementations (no API key) ---------------------------------- */
function mockTranscript(durationMs){
  const text = "Well, I think technology has become a really central part of everyday life, and honestly I can't imagine going a single day without my phone. I use it for pretty much everything, from checking the news in the morning to staying in touch with my family who live abroad.";
  return {
    text,
    segments: [
      { startMs: 0, endMs: 6000, text: "Well, I think technology has become a really central part of everyday life,", confidence: 0.93 },
      { startMs: 6000, endMs: 12000, text: "and honestly I can't imagine going a single day without my phone.", confidence: 0.91 },
      { startMs: 12000, endMs: 20000, text: "I use it for pretty much everything, from checking the news in the morning to staying in touch with my family who live abroad.", confidence: 0.9 }
    ],
    words: [], confidence: 0.91, languageDetected: "en",
    durationMs: durationMs || 20000, provider: "whisper",
    providerMeta: { model: "mock", segmentCount: 3 }, warnings: ["mock-mode"], sourceTags: ["transcript"], stability: 0.95
  };
}
function mockOverlay(baseline){
  const fc = baseline.criteria.fluencyCoherence, lx = baseline.criteria.lexical, gr = baseline.criteria.grammar;
  return {
    criteria: { fluencyCoherence: fc, lexical: lx, grammar: gr },
    performanceSummary: [
      "This is a mock report generated without an AI key. Add a Groq API key to the server's .env file to enable genuine examiner-grade scoring.",
      "Your responses showed reasonable development of ideas and a workable range of vocabulary, with occasional hesitation typical of this band."
    ],
    detailedAnalysis: {
      fluencyCoherence: "Mock analysis: speech was generally connected with some natural hesitation.",
      lexical: "Mock analysis: a serviceable range of everyday vocabulary with limited less-common items.",
      grammar: "Mock analysis: a mix of simple and complex sentences with occasional errors.",
      pronunciation: "Delivery was intelligible; pronunciation is assessed acoustically from the recording."
    },
    recommendations: {
      immediate: [{ title: "Add a Groq key", body: "Set GROQ_API_KEY in the server .env to replace this mock report with real AI scoring.", descriptorGap: "Enables descriptor-grounded judgement" }],
      shortTerm: [{ title: "Extend your answers", body: "Aim to give two or three supported sentences per question.", descriptorGap: "Fluency: topic development" }],
      targetBand: [{ title: "Use precise vocabulary", body: "Replace general words with topic-specific ones.", descriptorGap: "Lexical: less common items" }]
    },
    errorsByPart: { part1: [], part2: [], part3: [] }
  };
}

module.exports = {
  GROQ_BASE, cefrFor, mapWhisper, transcribeBuffer, scoreSession, mergeOverlay,
  mockTranscript, mockOverlay
};
