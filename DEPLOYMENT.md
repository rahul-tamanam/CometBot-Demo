# CometBot — Full deployment walkthrough (portfolio demo)

Follow these steps **in order**. Each optional step improves demo quality; skipping them still works thanks to catalog fallbacks and `safe_chat` LLM fallbacks.

**Legal copy:** See [LEGAL_DEMO_NOTICE.md](LEGAL_DEMO_NOTICE.md). Visitors must accept a modal on first chat load each session.

---

## Overview

| Step | What | Time (approx.) |
|------|------|----------------|
| 0 | Accounts & tools | 15 min |
| 1 | Local `.env` files | 5 min |
| 2 | Groq API (required for AI text) | 5 min |
| 3 | Neo4j Aura + graph build (optional, prereqs) | 20 min |
| 4 | Pinecone + Ollama index build (optional, career/skills retrieval) | 30–60 min |
| 5 | Deploy backend (Render) | 15 min |
| 6 | Deploy frontend (Vercel) | 10 min |
| 7 | Smoke test & compliance check | 15 min |

**Live URLs you will have:**

- Frontend: `https://your-app.vercel.app`
- Backend: `https://your-api.onrender.com`
- Health: `https://your-api.onrender.com/api/health`

**User journey:** `/` onboarding → `/chat` dashboard (demo modal on first chat visit per session).

---

## Step 0 — Prerequisites

Install locally:

- **Python 3.10+** and `pip`
- **Node.js 18+** and `npm`
- **Git**
- **Ollama** (only for Step 4 index build): [https://ollama.com](https://ollama.com) — then run:
  ```powershell
  ollama pull mxbai-embed-large
  ```

Create free accounts (no credit card for basic tiers in most cases):

| Service | URL | Used for |
|---------|-----|----------|
| Groq | https://console.groq.com | LLM chat |
| Neo4j Aura | https://neo4j.com/cloud/aura-free | Prerequisite graph |
| Pinecone | https://www.pinecone.io | Vector search |
| Render | https://render.com | Backend hosting |
| Vercel | https://vercel.com | Frontend hosting |

---

## Step 1 — Local environment files

From repo root `E:\JSOMAdvisor` (adjust path):

### 1a. Backend `.env`

```powershell
copy .env.example .env
```

Edit `.env` and fill values as you obtain them in Steps 2–4:

```env
NEO4J_URI=neo4j+s://xxxx.databases.neo4j.io
NEO4J_USERNAME=neo4j
NEO4J_PASSWORD=your_password

PINECONE_API_KEY=pcsk_...
PINECONE_INDEX=cometbot-demo

GROQ_API_KEY=gsk_...
GROQ_MODEL=llama-3.3-70b-versatile
LLM_MAX_TOKENS=1024

# Add your Vercel URL after Step 6 (comma-separated, no trailing slash)
CORS_ALLOW_ORIGINS=http://localhost:5173,https://your-app.vercel.app
```

Never commit `.env`.

### 1b. Frontend `frontend/.env`

```powershell
cd frontend
copy .env.example .env
```

```env
VITE_API_BASE=http://127.0.0.1:8000/api
# Transcript upload uses client-side pdf.js by default (recommended on Vercel).
# Only set these if you explicitly want Render/pdfplumber first:
# VITE_TRANSCRIPTPARSER_API=http://127.0.0.1:8000/api/parse-transcript
# VITE_TRANSCRIPTPARSER_PREFER_SERVER=true
```

After backend deploy, change both URLs to your Render API base.

### 1c. Python venv & dependencies

```powershell
cd E:\JSOMAdvisor
python -m venv venv
.\venv\Scripts\activate
pip install -r requirements.txt
```

### 1d. Frontend dependencies

```powershell
cd frontend
npm install
```

---

## Step 2 — Groq (recommended; fallbacks exist without it)

1. Sign in at [Groq Console](https://console.groq.com).
2. **API Keys** → Create key → copy `gsk_...` into root `.env` as `GROQ_API_KEY`.
3. Confirm model `llama-3.3-70b-versatile` is available on your tier (default in code).
4. Keep `LLM_MAX_TOKENS=1024` to reduce free-tier usage.

**Test locally:**

```powershell
cd E:\JSOMAdvisor
.\venv\Scripts\activate
uvicorn backend.main:app --reload --port 8000 --env-file .env
```

Open `http://127.0.0.1:8000/api/health` — expect `"llm_configured": true`.

If Groq fails later, users see friendly demo text (not API errors).

---

## Step 3 — Neo4j Aura (optional; better prerequisite answers)

### 3a. Create database

1. [Neo4j Aura](https://neo4j.com/cloud/aura-free/) → New instance (free).
2. Save **URI**, **username** (usually `neo4j`), **password** into `.env`.

### 3b. Build graph (local, one-time per catalog change)

```powershell
cd E:\JSOMAdvisor
.\venv\Scripts\activate
python backend\build_neo4j_graph.py
```

Expect `[done] Neo4j graph ready`. Re-run after major catalog JSON edits.

### 3c. Verify

With backend running, degree planner chat should use graph eligibility (no 503 errors). If Aura is down, API continues with catalog-only progress.

---

## Step 4 — Pinecone + Ollama index (optional; career mentor & skills retrieval)

Pinecone stores vectors; **embeddings are generated locally via Ollama** (not on Render).

### 4a. Pinecone setup

1. Create project → create **index** (name = `PINECONE_INDEX` in `.env`).
2. Use dimension matching `mxbai-embed-large` (1024) — check your existing index settings if you already created one.
3. Copy API key to `.env`.

### 4b. Start Ollama

```powershell
ollama serve
# separate terminal:
ollama pull mxbai-embed-large
```

### 4c. Build index (courses, skills, certificates)

```powershell
cd E:\JSOMAdvisor
.\venv\Scripts\activate
python backend\build_pinecone_index.py
```

This upserts namespaces: `courses`, `skills`, `certificates`. Takes several minutes.

### 4d. Deploy note

Render **does not** run Ollama. Index must be built **before** go-live (re-run when catalog/skills JSON changes). Querying works from Render with `PINECONE_*` env vars only.

---

## Step 5 — Deploy backend (Render)

### 5a. Push code to GitHub

Ensure the repo is on GitHub (private is fine).

### 5b. Create Web Service

1. Render Dashboard → **New** → **Web Service** → connect repo.
2. **Root directory:** leave as repository root (where `requirements.txt` lives).
3. **Runtime:** Python 3.
4. **Build command:** `pip install -r requirements.txt`
5. **Start command:**
   ```bash
   uvicorn backend.main:app --host 0.0.0.0 --port $PORT
   ```
6. **Health check path:** `/api/health`

Or use the included `render.yaml` Blueprint (Render → Blueprints → New Blueprint Instance).

### 5c. Environment variables on Render

Set the same keys as local `.env` (use Render’s **Secret** type for keys):

| Variable | Required |
|----------|----------|
| `GROQ_API_KEY` | Yes (for AI narratives) |
| `CORS_ALLOW_ORIGINS` | Yes — your Vercel URL + `http://localhost:5173` |
| `GROQ_MODEL` | Optional |
| `LLM_MAX_TOKENS` | Optional |
| `NEO4J_URI`, `NEO4J_USERNAME`, `NEO4J_PASSWORD` | Optional |
| `PINECONE_API_KEY`, `PINECONE_INDEX` | Optional |

### 5d. Cold starts

Free Render spins down after inactivity; first request may take ~30s. Mention this in portfolio README if reviewers notice delay.

### 5e. Copy API URL

Example: `https://cometbot-api.onrender.com`  
API base for frontend: `https://cometbot-api.onrender.com/api`

---

## Step 6 — Deploy frontend (Vercel)

### 6a. Import project

1. Vercel → **Add New** → **Project** → import GitHub repo.
2. **Root Directory:** `frontend` (required)
3. **Framework Preset:** Vite
4. **Build Command:** leave **empty** (use `frontend/vercel.json`) or set exactly `npm ci && npm run build`
5. **Output Directory:** `dist`

Do **not** use `cd frontend && ...` in the Vercel UI — that only works when Root Directory is the repo root. With Root Directory = `frontend`, the shell is already inside `frontend/`.

### 6b. Environment variables (Vercel)

| Name | Value |
|------|--------|
| `VITE_API_BASE` | `https://YOUR-RENDER-HOST.onrender.com/api` |
| `VITE_TRANSCRIPTPARSER_API` | Optional — only if `VITE_TRANSCRIPTPARSER_PREFER_SERVER=true` |
| `VITE_TRANSCRIPTPARSER_PREFER_SERVER` | `true` to try Render pdfplumber before client parser (usually leave unset) |

Redeploy after changing env vars.

### 6c. SPA routing

`frontend/vercel.json` rewrites all routes to `index.html` so `/chat` refresh works.

### 6d. Update Render CORS

Add your final Vercel URL to Render `CORS_ALLOW_ORIGINS`, e.g.:

```env
CORS_ALLOW_ORIGINS=https://cometbot-demo.vercel.app,http://localhost:5173
```

Redeploy backend if you change CORS.

---

## Step 7 — Smoke test & compliance checklist

Run through as a new visitor (incognito window):

### Routing

- [ ] `https://your-app.vercel.app/` → **Prospective / Current student** landing
- [ ] Complete onboarding → lands on `/chat`
- [ ] Refresh `/chat` → still works (no 404)

### Demo legal UI

- [ ] On `/chat`, **blocking modal** appears first visit (per session)
- [ ] Cannot continue without checkbox + **Continue to demo**
- [ ] **Floating “Demo only”** badge bottom-right after dismiss
- [ ] Footer disclaimer visible on chat page

### Features

- [ ] Degree planner: message returns text or demo fallback (not raw 500)
- [ ] Career mentor: response (better with Pinecone)
- [ ] Skills gap: resume or form analysis
- [ ] Profile: add course ID (catalog loads from API)
- [ ] `GET https://your-api.onrender.com/api/health` → `status: ok`

### Compliance (portfolio safety)

- [ ] README links to [LEGAL_DEMO_NOTICE.md](LEGAL_DEMO_NOTICE.md)
- [ ] No real student transcripts in demo screenshots
- [ ] Avoid UT Dallas logos in marketing unless you have permission
- [ ] Résumé/GitHub states **“unofficial portfolio demo”**
- [ ] No `.env` or API keys in git (`git status` clean of secrets)

### Clear stale onboarding (testing)

In browser DevTools → Application → Local Storage, delete:

- `cometbot_onboarding_complete`
- `cometbot_profile`
- `cometbot_demo_ack_v1` (modal will show again)

---

## Compliance summary (avoid future issues)

| Risk | Mitigation in this project |
|------|---------------------------|
| Implied university endorsement | Modal + footer: not affiliated with UT Dallas |
| Liability for bad advice | “As is”, no liability, verify with official sources |
| Sensitive data | Do not submit SSN/passwords/full transcripts |
| AI hallucinations | Label outputs as project data + AI, not official audits |
| Third-party APIs | Keys server-side only; Groq/Pinecone terms apply |
| Trademark | Descriptive use only; see LEGAL_DEMO_NOTICE.md |

For a **portfolio**, this is usually sufficient. For **production** or **real students**, you need institutional approval, FERPA review, and proper legal counsel.

---

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| CORS error in browser | Add exact Vercel origin to `CORS_ALLOW_ORIGINS` on Render |
| Blank page on `/chat` refresh | Confirm `frontend/vercel.json` rewrites |
| Build fails: `cd: frontend: No such file` | Root Directory must be `frontend`; clear Build Command override (`cd frontend && ...`) |
| Always demo fallback text | Check `GROQ_API_KEY`, quota, model name |
| No certificate matches | Run `build_pinecone_index.py` with Ollama + Pinecone |
| Wrong prereqs | Run `build_neo4j_graph.py`; check Aura credentials |
| Modal every click | Normal once per session; clears when tab session ends |
| Stuck on chatbot at `/` | Clear `cometbot_onboarding_complete` in localStorage |

---

## Quick local dev (after setup)

**Terminal 1 — API:**

```powershell
cd E:\JSOMAdvisor
.\venv\Scripts\activate
uvicorn backend.main:app --reload --port 8000 --env-file .env
```

**Terminal 2 — UI:**

```powershell
cd E:\JSOMAdvisor\frontend
npm run dev
```

Open `http://localhost:5173/` → onboarding → `http://localhost:5173/chat`.

---

## File reference

| File | Purpose |
|------|---------|
| `render.yaml` | Render Blueprint for API |
| `frontend/vercel.json` | SPA rewrites |
| `LEGAL_DEMO_NOTICE.md` | Standalone legal notice |
| `frontend/src/components/DemoAcknowledgmentModal.tsx` | Chat-load modal + floating badge |
| `frontend/src/lib/demoMessages.ts` | All disclaimer strings |
| `backend/services/demo_fallbacks.py` | Server LLM fallback copy |
