# call-julia

Voice web app + backend for talking to Julia via ElevenLabs, with:

- Context injection from `soul.md`, `claude.md`, `memories.md`, etc.
- Action extraction during calls (`[ACTION ...]` tags) and Telegram delivery.
- End-of-call transcript summary sent to Telegram and appended to memory logs.

Primary maintainer handoff document:
- `/Users/macminihome/dev_projects/call-julia/docs/AGENT_OPERATIONS_GUIDE.md`

## Architecture

- `app/`: Vite + React UI using `@elevenlabs/react`.
- `server/`: Express backend providing:
  - `GET /signed-url` for ElevenLabs signed conversation URLs
  - `POST /v1/chat/completions` for ElevenLabs custom LLM endpoint
  - `POST /conversation/finalize` to summarize/save call memory
- `brain/`: local assistant context files loaded into every LLM call.

## 1) Configure environment

### Backend

1. Copy `/Users/macminihome/dev_projects/call-julia/server/.env.example` to `.env`.
2. Fill at minimum:
   - `ELEVENLABS_API_KEY`
   - `ELEVENLABS_AGENT_ID`
   - `TELEGRAM_BOT_TOKEN`
   - `TELEGRAM_CHAT_ID`
   - `ACTION_TELEGRAM_PREFIX`
3. Choose one LLM mode:
   - `LLM_PROVIDER=openai-compatible` with `LLM_BASE_URL` (`http://localhost:3456` for Claude Max proxy)
   - or `LLM_PROVIDER=anthropic` with `ANTHROPIC_API_KEY`
4. For Vercel memory/persona context from another repo, set:
   - `BRAIN_REMOTE_BASE_URL` (raw GitHub folder containing `soul.md`, `claude.md`, etc.)
   - `BRAIN_REMOTE_MEMORY_PATH` (usually `memory`)
   - For private repos, prefer GitHub API mode:
     - `GITHUB_BRAIN_OWNER`, `GITHUB_BRAIN_REPO`, `GITHUB_BRAIN_BRANCH`, `GITHUB_BRAIN_ROOT_PATH`, `GITHUB_BRAIN_TOKEN`

### Frontend

1. Copy `/Users/macminihome/dev_projects/call-julia/app/.env.example` to `.env`.
2. Fill:
   - `VITE_ELEVENLABS_AGENT_ID`
   - `VITE_API_BASE_URL` (backend public URL or `http://localhost:3789`)

## 2) ElevenLabs agent settings

In your ElevenLabs Conversational AI agent:

1. Keep the same agent ID used in frontend env.
2. Set custom LLM endpoint to:
   - `https://<your-backend-domain>/v1/chat/completions`
3. Ensure the agent uses signed URL auth (frontend calls `/signed-url`).

## 3) Local run

### Backend

```bash
cd /Users/macminihome/dev_projects/call-julia/server
npm install
npm start
```

### Frontend

```bash
cd /Users/macminihome/dev_projects/call-julia/app
npm install
npm run dev
```

## 4) Deploy

### Frontend on Vercel

- Deploy `app/` as a Vite project.
- Set env vars in Vercel:
  - `VITE_ELEVENLABS_AGENT_ID`
  - `VITE_API_BASE_URL` (your backend URL)

### Backend hosting options

- Vercel (Node serverless), Railway, Render, Fly, or your own VM.
- If your backend runs on Vercel/Render, point ElevenLabs custom LLM URL to that domain.
- Important: `LLM_BASE_URL=http://localhost:3456` only works on your local machine.
- For Vercel backend, use:
  - `LLM_PROVIDER=anthropic` with `ANTHROPIC_API_KEY`, or
  - `LLM_PROVIDER=openai-compatible` with a publicly reachable `LLM_BASE_URL`.
- If backend root is `server` on Vercel, local `../brain` may not exist at runtime; use `BRAIN_REMOTE_BASE_URL` to load soul/memory from GitHub raw files.

## Notes

- End-of-call summary is triggered by frontend on disconnect/end and sent to Telegram.
- Memory append writes to `brain/memory/YYYY-MM-DD.md` when filesystem is writable.
- On Vercel runtime with no `MEMORY_DIR` configured, memory writes default to `/tmp/call-julia-memory` (ephemeral).
- Action tags are removed from spoken output before audio playback.
- Action delivery is deduped, cooldown-limited, and capped to prevent repeated Telegram spam:
  - `MAX_ACTIONS_PER_RESPONSE=1`
  - `ACTION_DEDUP_WINDOW_SEC=180`
- Call summaries now include observed mood/emotional signals.
