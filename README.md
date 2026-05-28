# Mourad Mekki Teacher Toolkit — IELTS Speaking Assessment (Backend)

A small Node/Express backend that powers the IELTS Speaking platform with
**cheap, near-instant AI**:

| Job | Service | Cost | Speed |
|---|---|---|---|
| Transcription | Groq **whisper-large-v3-turbo** | ~$0.04 / hour of audio (≈ **$0.009 per 13-min test**) | ~228× real-time (a full test in ~3–4 s) |
| Scoring / report | Groq **llama-3.3-70b-versatile** | ~**$0.002 per report** | ~1–2 s |

**≈ 1 cent per complete assessment**, reports in well under ~6 seconds. Groq also
has a free tier, so low volumes can cost nothing. Your API key stays on the
server — it is never sent to the browser.

The server runs in **MOCK mode with no key** (canned data, zero cost) so you can
try the whole flow immediately, then add a Groq key to switch on real AI.

---

## 1. Setup

```bash
cd server
npm install
cp .env.example .env        # then edit .env
npm start
```

Open **http://localhost:8787** — the app is served by the backend and
auto-detects it (no configuration needed in the browser).

## 2. Get a Groq API key (for real AI)

1. Sign up at https://console.groq.com (free).
2. Create an API key.
3. Put it in `.env`:

```
GROQ_API_KEY=gsk_your_key_here
```

Restart the server. That's it — transcription and scoring now use Groq.

### Models (already set to the cheapest fast options)
```
WHISPER_MODEL=whisper-large-v3-turbo     # transcription
SCORING_MODEL=llama-3.3-70b-versatile    # band scoring + feedback
```
For the absolute cheapest scoring you can switch to `llama-3.1-8b-instant`
(a fraction of the cost, slightly less nuanced bands).

## 3. How it works

- **Transcription** (`POST /api/transcribe`): the recorded clip for each part is
  uploaded and transcribed by Groq Whisper, returning text + word-timed segments.
- **Scoring** (`POST /api/score`): the browser first computes a rule-based
  baseline (instant, always valid). The server then asks Groq Llama — acting as
  an IELTS examiner — to judge Fluency & Coherence, Lexical Resource, and
  Grammatical Range from the transcript, and merges that onto the baseline.
  Pronunciation stays acoustic (from the recording). If the AI call ever fails,
  the baseline report is returned, so a report is **always** produced.
- **Sessions** (`/api/sessions`): completed reports are persisted server-side so
  history is durable and shared across devices. Storage is pluggable: it uses
  **Postgres** when `DATABASE_URL` is set (any provider — Neon, Supabase, Render,
  Railway), and otherwise a JSON file at `DATA_DIR` (default `./data`). Audio
  recordings stay in each browser's local storage for playback.

## 4. API

| Method | Path | Body | Returns |
|---|---|---|---|
| GET | `/api/config` | — | capabilities (models, mock flag) |
| POST | `/api/transcribe` | multipart, field `audio` (+ optional `language`) | `{text, segments[], confidence, ...}` |
| POST | `/api/score` | `{session, baseline}` | `{scored}` |
| GET | `/api/sessions` | — | `[session, ...]` |
| POST | `/api/sessions` | a session (must have `id`) | `{ok}` |
| DELETE | `/api/sessions/:id` | — | `{ok}` |

## 5. One-click deploy

This folder ships with ready-made configs for the major hosts. First push it to
a Git repo (GitHub/GitLab/Bitbucket):

```bash
cd server
git init && git add . && git commit -m "IELTS backend"
git remote add origin https://github.com/YOUR_USERNAME/YOUR_REPO.git
git push -u origin main
```

Then pick a host. In every case the only thing to set is `GROQ_API_KEY`
(leave it unset to run in free mock mode), and the frontend is served at `/`
automatically — no CORS or backend-URL setup needed.

### ▸ Render + Neon  (recommended — free, durable, runs the server as-is)

This pairs Render's free web service with Neon's free (non-expiring) Postgres.
Total cost: **$0**, no credit card required.

**Step 1 — Get a free Postgres from Neon**
1. Sign up at https://neon.tech (free, no card).
2. Create a project (any name/region). Neon creates a database automatically.
3. On the project dashboard, click **Connect** and copy the **connection string**.
   It looks like:
   `postgresql://user:pass@ep-xxx-pooler.us-east-2.aws.neon.tech/neondb?sslmode=require`
   (Any of Neon's connection strings work; the pooled one is fine.)

**Step 2 — Get a Groq key** (optional — skip to run in free mock mode)
- https://console.groq.com → API Keys → create one (`gsk_…`).

**Step 3 — Deploy to Render**
1. Push this folder to a GitHub/GitLab repo.
2. In the Render dashboard: **New ▸ Blueprint** → connect the repo.
3. Render reads `render.yaml` and prompts you for the two secrets:
   - `GROQ_API_KEY` → paste your Groq key (or leave blank for mock mode)
   - `DATABASE_URL` → paste the Neon connection string from Step 1
4. Click **Apply**. Render builds and deploys; open the service URL when it's live.

That's it. The app is served at `/`, auto-detects the backend, and writes history
to Neon. SSL is auto-handled (Neon URLs include `sslmode=require`).

> Cold start: Render's free web service sleeps after ~15 min idle, so the first
> request after a lull takes ~30–60s to wake. Upgrade to the $7/mo plan to keep
> it warm. Neon also auto-suspends when idle and wakes on the next query (a few
> hundred ms) — your data is never lost.

> Don't want the Neon step? See the comments in `render.yaml` to have Render
> provision its own Postgres automatically (one less step, but Render's free
> Postgres expires after ~30 days).

### ▸ Railway  (uses `railway.json`)

New Project → **Deploy from GitHub repo** → select the repo. Railway auto-builds
(Nixpacks), then add `GROQ_API_KEY` under the service's **Variables** tab.

### ▸ Fly.io  (uses `fly.toml` + `Dockerfile`)

```bash
fly launch --copy-config --now
fly secrets set GROQ_API_KEY=gsk_your_key_here
```

### ▸ Docker / Google Cloud Run / any container host  (uses `Dockerfile`)

```bash
docker build -t ielts-backend .
docker run -p 8787:8787 -e GROQ_API_KEY=gsk_your_key_here ielts-backend
# Cloud Run: gcloud run deploy --source . --set-env-vars GROQ_API_KEY=gsk_xxx
```

### ▸ Heroku / DigitalOcean App Platform  (uses `Procfile` + `app.json`)

Create an app from the repo; both platforms detect Node automatically. Add
`GROQ_API_KEY` as a config var / app-level environment variable.

> **Durable, cross-device history.** Completed reports are stored server-side via
> a pluggable layer:
>
> - **Postgres (recommended)** — set `DATABASE_URL` to any Postgres connection
>   string and the table is created automatically. A free **Neon** database
>   (https://neon.tech) is the easiest permanently-free option and is the path
>   used in the Render walkthrough above; **Supabase** works identically. SSL
>   auto-detects (force it with `PGSSL=require` if ever needed).
> - **File store** — with no `DATABASE_URL`, sessions are written to
>   `DATA_DIR/sessions.json` (default `./data`). On hosts with a persistent disk
>   (Render Disk, Fly Volume), mount it and set `DATA_DIR=/var/data` to keep this
>   durable too. On free/ephemeral hosts the file resets on redeploy — use
>   Postgres there.
>
> Either way, each browser also keeps its own copy of reports, so nothing is ever
> lost for the person who ran the test. If Postgres is configured but unreachable
> at startup, the server logs a warning and falls back to the file store so it
> always runs.

## 6. Security note

The Groq key lives only in the server environment and is used for direct
server→Groq calls. Do not commit your `.env`. This is the right setup for a
shared/public deployment; everything stays off the client.
