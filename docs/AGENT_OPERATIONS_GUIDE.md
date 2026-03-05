# Agent Operations Guide

This document is the post-launch handoff for AI agents maintaining `call-julia`.
It explains not only **what** the system does, but **why it was stitched together this way** so future edits preserve behavior.

Detailed key-by-key decision reference:
- `/Users/macminihome/dev_projects/call-julia/docs/CONFIG_DECISION_LOG.md`

## 1) Product Intent

The app provides a voice-call UX for talking to "Julia" while preserving long-term context and producing operational follow-through.

Core outcomes:

1. User starts a voice session from the web app.
2. Julia replies using context from `brain/` files (persona + memory).
3. If tasks emerge in conversation, they are forwarded to Telegram immediately.
4. On call end, transcript is summarized and appended to memory history.

## 2) Why This Architecture

Design choices and rationale:

1. Backend mediates all key external calls.
- Why: frontend must not hold ElevenLabs or Telegram secrets.
- Result: frontend only talks to backend (`/signed-url`, `/conversation/finalize`).

2. ElevenLabs uses a custom LLM endpoint (`/v1/chat/completions`).
- Why: this is where memory/persona injection and action parsing happen.
- Result: Julia can reference `soul.md`, `claude.md`, `memories.md`, and recent logs.

3. Action tags are embedded in normal model text (`[ACTION ...]`).
- Why: model/provider-independent and works in streaming mode.
- Result: spoken output strips action tags before audio, backend executes tags out-of-band.
- Guardrail: backend dedupes repeated tags and executes at most `MAX_ACTIONS_PER_RESPONSE` (default 1).
- Guardrail: backend also applies cooldown dedupe (`ACTION_DEDUP_WINDOW_SEC`) across nearby turns.

4. End-of-call memory is finalized by explicit frontend callback.
- Why: old timer/global-state approaches were fragile and easy to miss.
- Result: frontend sends transcript with `callId` to `/conversation/finalize` on disconnect/end.

5. Memory storage is plain markdown files in-repo (`brain/memory/YYYY-MM-DD.md`).
- Why: transparent, editable, portable, and easy for agents to inspect/patch.
- Tradeoff: if deployed server is stateless, file persistence requires external storage.

6. LLM layer supports both `openai-compatible` and `anthropic`.
- Why: primary path can run through local Claude proxy, fallback can call Anthropic directly.
- Result: provider switch is env-only in many cases.

## 3) Repository Map (Source of Truth)

- `app/src/App.tsx`: call lifecycle, transcript capture, finalize trigger.
- `server/index.js`: full API layer, LLM routing, action execution, memory writes.
- `brain/`: persistent context and memory files injected into prompt.
- `server/.env`: backend runtime config.
- `app/.env`: frontend runtime config.
- `README.md`: operator quick-start.
- `ARCHITECTURE.md`: concise architecture summary.

## 4) Runtime Flow

```mermaid
flowchart TD
  U["User"] --> F["Frontend (React)"]
  F -->|GET /signed-url| B["Backend (Express)"]
  B -->|xi-api-key| E["ElevenLabs API"]
  E --> F
  F -->|startSession(signedUrl)| E
  E -->|POST /v1/chat/completions| B
  B -->|inject brain + memory| L["LLM Provider"]
  L --> B
  B -->|stream spoken chunks| E
  B -->|execute [ACTION ...]| T["Telegram / iMessage"]
  U --> F
  F -->|POST /conversation/finalize| B
  B -->|summary + append| M["brain/memory/YYYY-MM-DD.md"]
  B -->|send summary| T
```

## 5) Detailed Request/Response Contracts

### `GET /health`

Purpose: liveness and current runtime config snapshot.

Response example:

```json
{
  "status": "ok",
  "provider": "openai-compatible",
  "model": "claude-sonnet-4-20250514",
  "brainDir": "/abs/path/brain",
  "memoryDir": "/abs/path/brain/memory",
  "timestamp": "2026-03-04T22:43:59.970Z"
}
```

### `GET /signed-url?agent_id=...`

Purpose: generate ElevenLabs signed conversation URL.

Dependencies:

- `ELEVENLABS_API_KEY`
- `ELEVENLABS_AGENT_ID` (or query `agent_id`)

Failure modes:

- Missing API key -> `500` with `ELEVENLABS_API_KEY is not configured.`
- Bad agent id/key -> ElevenLabs upstream error.

### `POST /v1/chat/completions`

Purpose: OpenAI-compatible endpoint for ElevenLabs custom LLM integration.

Accepted body:

```json
{
  "messages": [
    { "role": "user", "content": "..." }
  ],
  "stream": true
}
```

Behavior:

1. Normalizes incoming messages and ensures first message is user role.
2. Builds system prompt + context from `brain/` and recent memory files.
3. Routes to selected provider.
4. Streams text as OpenAI SSE chunks.
5. Removes `[ACTION ...]` and legacy `[ACTION: ...]` from spoken stream.
6. Executes extracted actions after full response.

### `POST /conversation/finalize`

Purpose: finalize call memory after disconnect/end.

Body:

```json
{
  "callId": "uuid-or-string",
  "transcript": [
    { "role": "you", "text": "..." },
    { "role": "julia", "text": "..." }
  ]
}
```

Behavior:

1. Normalizes transcript (`you/julia`).
2. Generates summary via current provider.
3. Sends summary to Telegram (if configured).
4. Appends transcript + summary to daily markdown memory file.

Returns summary, telegram status, and memory write result.

`POST /save-memory` is a legacy alias to this handler.

## 6) Prompt/Context Injection Model

Context is assembled in this order:

1. Static files from `CONTEXT_FILES` in `BRAIN_DIR` (first variant found per filename).
2. Most recent memory files from `MEMORY_DIR` (`RECENT_MEMORY_FILES` count).
3. If local files are missing, optional remote files from `BRAIN_REMOTE_BASE_URL` (GitHub raw or equivalent).
4. Truncated to max 30k chars.

Expected files:

- `soul.md`
- `claude.md`
- `user.md`
- `memories.md`
- optional extras from `CONTEXT_FILES`

Important:

- Missing files do not crash runtime; they are skipped.
- Context load is per request (dynamic), so file edits are picked up without restart.
- A short cache (`CONTEXT_CACHE_TTL_MS`) reduces repeated remote fetch latency.

## 7) Action System

Supported action tags in assistant output:

```text
[ACTION type="telegram" message="..."]
[ACTION type="julia" message="..."]
[ACTION type="imessage" message="..."]
[ACTION type="joke" channel="telegram"]
```

Rules:

1. Tags are hidden from spoken stream.
2. Multiple tags are parsed, then deduped and capped before execution.
3. Legacy format `[ACTION: ...]` maps to Telegram text.
4. Repeated identical actions within cooldown window are skipped.

Execution mapping:

- `telegram`: sends message directly.
- `julia`: currently forwards to Telegram (same transport, different semantic intent).
- `imessage`: uses `/opt/homebrew/bin/imsg` when enabled.
- `joke`: model-generated joke, then routed to selected channel.
- Telegram/iMessage action messages are prefixed by `ACTION_TELEGRAM_PREFIX`.
- Reminder-style actions are rewritten for clarity (who/what/when wording) before delivery.

## 8) Frontend Call Lifecycle

Key logic in `app/src/App.tsx`:

1. `startConversation()`:
- creates `callId`,
- fetches signed URL from backend,
- starts ElevenLabs session.

2. `onMessage()`:
- appends transcript line-by-line (`you` or `julia`).

3. `endConversation()` and `onDisconnect()`:
- call `/conversation/finalize` with transcript and `callId`.
- guarded by `finalizedRef` so each call finalizes once.

Why this matters:

- Prevents duplicate memory writes.
- Ensures summary creation happens even if user presses End or disconnect happens naturally.

## 9) Environment Variables (Operational Matrix)

Backend required for full feature set:

- `ELEVENLABS_API_KEY`
- `ELEVENLABS_AGENT_ID`
- `LLM_PROVIDER`
- provider-specific values
- `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` (for action+summary delivery)

Common provider setups:

1. OpenAI-compatible proxy mode:
- `LLM_PROVIDER=openai-compatible`
- `LLM_BASE_URL=http://localhost:3456`
- `LLM_API_KEY=dummy` (if proxy ignores key)

2. Direct Anthropic mode:
- `LLM_PROVIDER=anthropic`
- `ANTHROPIC_API_KEY=<real key>`

Frontend required:

- `VITE_API_BASE_URL=<backend origin>`
- `VITE_ELEVENLABS_AGENT_ID=<agent id>`

Remote brain settings (useful on Vercel when `../brain` is unavailable):

- `BRAIN_REMOTE_BASE_URL=https://raw.githubusercontent.com/<owner>/<repo>/<branch>/<path>`
- `BRAIN_REMOTE_MEMORY_PATH=memory`
- `BRAIN_REMOTE_TIMEOUT_MS=6000`
- For private GitHub repos, use API mode:
  - `GITHUB_BRAIN_OWNER`, `GITHUB_BRAIN_REPO`, `GITHUB_BRAIN_BRANCH`, `GITHUB_BRAIN_ROOT_PATH`, `GITHUB_BRAIN_TOKEN`

Action anti-spam settings:

- `MAX_ACTIONS_PER_RESPONSE=1`
- `ACTION_DEDUP_WINDOW_SEC=180`

## 10) Deployment Topologies

### Local-only testing

- Frontend and backend run on localhost.
- Good for UI, endpoint, summary, memory write validation.
- Limitation: ElevenLabs cannot call localhost custom LLM unless tunneled.

### Public backend + local/frontend

- Backend exposed via tunnel/domain.
- ElevenLabs points custom LLM to public `/v1/chat/completions`.
- Frontend can still be local.

### Full deployment

- Frontend on Vercel.
- Backend on Render/Fly/Railway/Vercel or VM.
- Ensure backend has persistent storage if daily memory files must persist.

## 11) Editing Playbooks for Future AI Agents

### Add a new action type

1. Add parser/handler branch in `runActions()`.
2. Update prompt instructions in `buildSystemPrompt()`.
3. Add/adjust stripping rules if new tag syntax is introduced.
4. Validate in non-stream and stream paths.

### Add a new context source

1. Put file in `brain/` or adjust `CONTEXT_FILES`.
2. If source is remote/database, add a bounded fetch in `loadAssistantContext()`.
3. Keep truncation guard to avoid prompt explosion.

### Swap provider model

1. Prefer env-only update (`LLM_MODEL`, provider keys).
2. If provider API shape changes, isolate changes inside provider functions only.
3. Keep OpenAI-compatible output contract unchanged for ElevenLabs.

### Change summary format

1. Edit `summarizeTranscript()` prompt only.
2. Keep plain text + spacing; Telegram rendering does not reliably support markdown headings.
3. Avoid breaking downstream operators expecting readable plain-text sections.

## 12) Operational Runbook

### Start services

```bash
cd /Users/macminihome/dev_projects/call-julia/server && npm start
cd /Users/macminihome/dev_projects/call-julia/app && npm run dev
```

### Health checks

```bash
curl -sS http://127.0.0.1:3789/health
curl -sS "http://127.0.0.1:3789/signed-url?agent_id=<agent>"
```

### Finalize test without real call

```bash
curl -sS -X POST http://127.0.0.1:3789/conversation/finalize \
  -H 'Content-Type: application/json' \
  -d '{"callId":"smoke","transcript":[{"role":"you","text":"hello"},{"role":"julia","text":"hi"}]}'
```

## 13) Known Failure Modes and Fixes

1. Signed URL failure
- Symptom: `ELEVENLABS_API_KEY is not configured.` or upstream error.
- Fix: set key; verify agent id.

2. No voice response from custom LLM
- Symptom: ElevenLabs connects but response errors.
- Fix: ensure custom LLM URL is public HTTPS and points to `/v1/chat/completions`.

3. No Telegram messages
- Symptom: actions/summaries not delivered.
- Fix: set bot token + chat id, verify bot permissions.

4. Memory not persisted in production
- Symptom: summaries send but files missing after restart.
- Fix: mount persistent volume or switch memory backend.

5. Duplicate finalization
- Mitigation already in frontend via `finalizedRef`; preserve this guard.

## 14) Invariants (Do Not Break)

1. `/v1/chat/completions` must stay OpenAI-compatible for ElevenLabs.
2. Spoken stream must not include raw action tags.
3. Finalization must remain idempotent per call from frontend perspective.
4. Context injection must remain bounded in size.
5. Missing optional context files must not crash request handling.

## 15) Recommended Backlog

1. Persist memory to DB/object store for stateless hosting.
2. Add automated tests for:
- action extraction,
- stream tag stripping,
- finalize handler.
3. Add request IDs and structured logging.
4. Add optional auth on backend endpoints if exposed publicly.
5. Split `server/index.js` into modules once behavior is stable.

## 16) Quick Glossary

- **Brain files**: markdown files defining persona/context.
- **Finalize**: post-call summarization + storage + Telegram send.
- **Action tag**: in-band marker in model output that triggers backend behavior.
- **OpenAI-compatible mode**: generic `/v1/chat/completions` provider protocol.
