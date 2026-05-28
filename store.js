"use strict";
/* ============================================================================
   store.js — durable session storage with two interchangeable drivers.

   - Postgres  : used automatically when DATABASE_URL is set. Works with any
                 hosted Postgres (Neon, Supabase, Render, Railway, …). Durable
                 and cross-device even on ephemeral/serverless hosts.
   - File      : default fallback. Stores data/sessions.json. Point DATA_DIR at
                 a mounted persistent disk to make it durable on disk-based hosts.

   If Postgres is configured but unreachable at startup, we log a warning and
   fall back to the file driver so the server always runs.

   Public async API: init() -> {driver}, list(), get(id), save(session), remove(id)
   ============================================================================ */

const fs = require("fs");
const path = require("path");

const DATABASE_URL = (process.env.DATABASE_URL || "").trim();
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(__dirname, "data");
const SESSIONS_FILE = path.join(DATA_DIR, "sessions.json");

let driver = "file";          // resolved in init()
let pool = null;              // pg pool when driver === "pg"

/* --------------------------------- SSL ----------------------------------- */
function needSSL(url){
  const v = (process.env.PGSSL || "").toLowerCase();
  if(v === "require" || v === "true" || v === "1") return true;
  if(v === "disable" || v === "false" || v === "0") return false;
  // Heuristic: external hosted Postgres needs SSL; an internal/local one doesn't.
  if(/sslmode=disable/i.test(url)) return false;
  if(/sslmode=require/i.test(url)) return true;
  if(/localhost|127\.0\.0\.1/i.test(url)) return false;
  if(/\.neon\.tech|supabase\.co|\.render\.com|railway|amazonaws\.com|\.fly\.dev/i.test(url)) return true;
  return false;
}

/* ------------------------------ file driver ------------------------------ */
const fileStore = {
  readAll(){
    try{ return JSON.parse(fs.readFileSync(SESSIONS_FILE, "utf-8")); }
    catch(e){ return []; }
  },
  writeAll(list){
    if(!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(SESSIONS_FILE, JSON.stringify(list));
  },
  async init(){ if(!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true }); },
  async list(){ return this.readAll(); },
  async get(id){ return this.readAll().find(s => s.id === id) || null; },
  async save(session){
    const all = this.readAll();
    const i = all.findIndex(s => s.id === session.id);
    if(i >= 0) all[i] = session; else all.push(session);
    this.writeAll(all);
    return true;
  },
  async remove(id){
    this.writeAll(this.readAll().filter(s => s.id !== id));
    return true;
  }
};

/* ------------------------------- pg driver ------------------------------- */
const pgStore = {
  async init(){
    const { Pool } = require("pg");
    pool = new Pool({
      connectionString: DATABASE_URL,
      ssl: needSSL(DATABASE_URL) ? { rejectUnauthorized: false } : false,
      max: 5,
      connectionTimeoutMillis: 8000
    });
    await pool.query(`
      CREATE TABLE IF NOT EXISTS sessions (
        id          TEXT PRIMARY KEY,
        data        JSONB NOT NULL,
        updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
      )`);
  },
  async list(){
    const r = await pool.query("SELECT data FROM sessions ORDER BY updated_at DESC");
    return r.rows.map(row => row.data);
  },
  async get(id){
    const r = await pool.query("SELECT data FROM sessions WHERE id = $1", [id]);
    return r.rows[0] ? r.rows[0].data : null;
  },
  async save(session){
    await pool.query(
      `INSERT INTO sessions (id, data, updated_at) VALUES ($1, $2, now())
       ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = now()`,
      [session.id, session]
    );
    return true;
  },
  async remove(id){
    await pool.query("DELETE FROM sessions WHERE id = $1", [id]);
    return true;
  }
};

/* ------------------------------ public API ------------------------------- */
let active = fileStore;

async function init(){
  if(DATABASE_URL){
    try{
      await pgStore.init();
      active = pgStore;
      driver = "postgres";
      return { driver };
    }catch(err){
      console.warn("⚠ Postgres unavailable (" + err.message + ") — falling back to file store.");
      try{ if(pool) await pool.end(); }catch(_){}
      pool = null;
    }
  }
  await fileStore.init();
  active = fileStore;
  driver = "file";
  return { driver };
}

module.exports = {
  init,
  list: (...a) => active.list(...a),
  get: (...a) => active.get(...a),
  save: (...a) => active.save(...a),
  remove: (...a) => active.remove(...a),
  info: () => ({ driver, dataDir: DATA_DIR })
};
