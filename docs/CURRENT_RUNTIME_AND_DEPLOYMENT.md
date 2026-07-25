# Current Runtime and Deployment (Canonical)

Last updated: July 25, 2026

This document is the authoritative "how it is running right now" reference for human operators and future AI coding agents.
It is intentionally explicit and redundant to reduce ambiguity.

## 1) Executive Summary

`call-julia` is configured as a split deployment:

1. Frontend project on Vercel (`talk-with-julia`).
2. Backend project on Vercel (`call-julia`).
3. ElevenLabs Custom LLM calls the backend OpenAI-compatible endpoint (`/v1/chat/completions`).
4. Backend fetches persona/memory context from `drewe4point0/julia-workspace` (GitHub mode enabled).
5. Backend sends action messages and call summaries to Telegram.

Also present:

1. A separate local Node server process was observed on port `3789` at `/Users/macminihome/.openclaw/workspace/julia-voice/server/index.js`.
2. That local process is not the same codebase as this repo and can create confusion if inspected without context.

## 2) Verified Runtime Snapshot

The following checks were executed on March 6, 2026:

1. `curl -sS https://call-julia.vercel.app/health`
2. `lsof -nP -iTCP:3789 -sTCP:LISTEN`
3. `curl -sS http://127.0.0.1:3789/health`

Observed results:

1. Vercel backend health returned:
   - `status: ok`
   - `provider: anthropic`
   - `model: claude-sonnet-4-20250514`
   - `brainDir: /var/task/brain`
   - `memoryDir: /tmp/call-julia-memory`
   - `remoteBrainBaseUrl: https://raw.githubusercontent.com/drewe4point0/julia-workspace/main`
   - `githubBrainMode: true`
   - `githubBrainRepo: drewe4point0/julia-workspace@main`
   - `actionDedupWindowSec: 180`
2. Local port `3789` had an active Node listener from a different workspace path (`.openclaw/workspace/julia-voice`).

Conclusion:

1. Production backend is running on Vercel (`call-julia.vercel.app`).
2. A legacy/local service also exists on `3789` and should be treated as separate.

## 3) Production URL Contract

Use this matrix as source of truth:

1. Frontend public URL: `https://talk-with-julia.vercel.app`
2. Backend public URL: `https://call-julia.vercel.app`
3. Backend health: `https://call-julia.vercel.app/health`
4. ElevenLabs WebRTC token source: `https://call-julia.vercel.app/conversation-token?agent_id=<agent_id>`
5. Legacy WebSocket signed URL source: `https://call-julia.vercel.app/signed-url?agent_id=<agent_id>`
5. ElevenLabs Custom LLM base URL: `https://call-julia.vercel.app/v1`
6. ElevenLabs app automatically appends: `/chat/completions`
7. Finalized call summary endpoint: `https://call-julia.vercel.app/conversation/finalize`

If ElevenLabs points to a Tailnet URL or localhost URL, that is a different runtime path.

## 4) Runtime Behavior (What Happens During a Call)

1. Frontend requests a WebRTC conversation token from backend (`/conversation-token`).
2. Frontend starts an ElevenLabs WebRTC session with the token.
3. ElevenLabs sends model requests to backend (`/v1/chat/completions`).
4. Backend loads context:
   - local context when available
   - GitHub-backed context fallback/primary in production
5. Backend prompts model with:
   - personality + memory context
   - action protocol
   - emotion handling protocol
   - timezone calendar context
6. Backend strips `[ACTION ...]` tags from spoken stream.
7. Backend executes deduped actions (Telegram/iMessage).
8. On call end/disconnect, frontend posts transcript to `/conversation/finalize`.
9. Backend generates formatted summary, sends to Telegram, appends local memory file.

## 5) Recent Hardening Changes (Important)

### July 25 reliability and latency audit

1. Production was targeting retired model `claude-sonnet-4-20250514`. Anthropic returned HTTP 404, ElevenLabs recorded `custom_llm generation failed`, and the call terminated.
2. Live turns now use low-latency `claude-haiku-4-5`; summaries use `claude-sonnet-4-6`.
3. Unsupported Anthropic models automatically cascade through a configured fallback list.
4. Provider calls have explicit timeouts and static system context uses prompt caching.
5. Remote context loads concurrently, GitHub filenames are resolved with one directory lookup, and live context is capped at 14,000 characters by default.
6. The browser SDK is current, sessions use WebRTC, microphone permission is checked before startup, and unexpected disconnect details remain visible.

These changes are now in `main` and should be preserved:

1. Caller naming enforcement:
   - Summaries default to `Drewe` (not `User`).
   - Commit: `55028a8`.
2. Calendar consistency enforcement:
   - `today`/`tomorrow` weekday references are aligned to configured timezone.
   - Prompt now includes authoritative current date context.
   - Commit: `790c8b4`.
3. Reminder anti-spam and clarity:
   - Dedup/cooldown/limit logic.
   - Reminder language normalized to explicit who/what/when.
   - Prior commits: `97a807f`, `23aa72f`, `9930da2`.

## 6) Full Environment Variable Inventory

Do not store secret values in git. Use placeholders in docs and actual values in Vercel/local env only.

### 6.1 Backend variables (`server/.env`)

`PORT`
- Purpose: local server listen port.
- Typical value: `3789`.
- Vercel note: runtime port is platform-managed.

`CORS_ORIGINS`
- Purpose: browser origin allow-list.
- Typical values: `*` (dev) or exact frontend origin(s).
- Production recommendation: include `https://talk-with-julia.vercel.app`.

`ELEVENLABS_API_KEY`
- Purpose: backend signs ElevenLabs conversation URLs.
- Required for `/signed-url`.

`ELEVENLABS_AGENT_ID`
- Purpose: default agent for `/signed-url`.
- Must match frontend `VITE_ELEVENLABS_AGENT_ID`.

`LLM_PROVIDER`
- Purpose: LLM backend mode.
- Allowed: `openai-compatible` or `anthropic`.
- Current production behavior (verified): `anthropic`.

`LLM_BASE_URL`
- Purpose: OpenAI-compatible upstream base URL.
- Used only when `LLM_PROVIDER=openai-compatible`.
- Local example: `http://localhost:3456`.

`LLM_API_KEY`
- Purpose: bearer key for OpenAI-compatible upstream.
- Used only in `openai-compatible` mode.

`LLM_MODEL`
- Purpose: target model ID.
- Compatibility/default model: `claude-sonnet-4-6`.

`VOICE_LLM_MODEL`
- Purpose: low-latency model for live spoken turns.
- Current default: `claude-haiku-4-5`.

`SUMMARY_LLM_MODEL`
- Purpose: higher-capability model for end-of-call summaries.
- Current default: `claude-sonnet-4-6`.

`ANTHROPIC_FALLBACK_MODELS`
- Purpose: recovery list when a configured model is retired or unavailable.
- Current default: `claude-haiku-4-5,claude-sonnet-4-6`.

`LLM_MAX_TOKENS`
- Purpose: caps response length/latency/cost.
- Current value used in repo defaults: `220`.
- This is a response-time control key.

`LLM_TIMEOUT_MS`
- Purpose: prevents stalled upstream generation from hanging a live turn.
- Current default: `20000`.

`ANTHROPIC_API_KEY`
- Purpose: direct Anthropic auth when provider is `anthropic`.

`ANTHROPIC_VERSION`
- Purpose: Anthropic API version header.
- Current default: `2023-06-01`.

`TELEGRAM_BOT_TOKEN`
- Purpose: auth for Telegram sendMessage.
- Required for action and summary delivery.

`TELEGRAM_CHAT_ID`
- Purpose: Telegram destination chat id.

`ACTION_TELEGRAM_PREFIX`
- Purpose: prepend context sentence for all action messages.
- Current target text:
  - `Drewe and I just talked about this so let's make sure that it happens:`

`MAX_ACTIONS_PER_RESPONSE`
- Purpose: hard cap number of action side effects per assistant response.
- Current target: `1`.

`ACTION_DEDUP_WINDOW_SEC`
- Purpose: suppress repeated near-duplicate actions over a time window.
- Current target: `180`.

`ENABLE_IMESSAGE`
- Purpose: enable local iMessage transport.
- Default: `false`.

`IMESSAGE_TO`
- Purpose: iMessage target phone/contact.
- Used only when iMessage enabled.

`ASSISTANT_NAME`
- Purpose: display + prompt persona identity.
- Typical value: `Julia`.

`TIMEZONE`
- Purpose: canonical local time for memory dates and summary date reasoning.
- Current target: `America/Vancouver`.

`BRAIN_DIR`
- Purpose: local folder for context markdown files.
- Local default: `../brain`.

`MEMORY_DIR`
- Purpose: where finalized transcripts are appended.
- Vercel runtime currently shows: `/tmp/call-julia-memory` (ephemeral).

`CONTEXT_FILES`
- Purpose: ordered list of context filenames to load.
- Current default in repo:
  - `soul.md,claude.md,user.md,memories.md,memory.md,tools.md`
- Loader includes filename variant matching, so mixed-case repos are supported.

`RECENT_MEMORY_FILES`
- Purpose: count of recent daily memory files loaded into prompt.
- Current target: `2`.
- This is a response-time control key.

`CONTEXT_CACHE_TTL_MS`
- Purpose: context cache TTL to avoid repeated fetches.
- Current target: `60000`.
- This is a response-time control key.

`CONTEXT_MAX_CHARS`
- Purpose: bounds the live-call system prompt to reduce prefill latency.
- Current default: `14000`.

`BRAIN_REMOTE_BASE_URL`
- Purpose: remote raw-file fallback source.
- Current health output includes:
  - `https://raw.githubusercontent.com/drewe4point0/julia-workspace/main`

`BRAIN_REMOTE_MEMORY_PATH`
- Purpose: memory subfolder path for remote fetch mode.
- Typical: `memory`.

`BRAIN_REMOTE_TIMEOUT_MS`
- Purpose: max remote fetch wait.
- Current target: `6000`.
- This is a response-time control key.

`BRAIN_REMOTE_AUTH_TOKEN`
- Purpose: optional bearer token for non-GitHub-API remote endpoints.

`GITHUB_BRAIN_OWNER`
- Purpose: GitHub repo owner for authenticated content mode.
- Current target: `drewe4point0`.

`GITHUB_BRAIN_REPO`
- Purpose: GitHub repo name for context.
- Current target: `julia-workspace`.

`GITHUB_BRAIN_BRANCH`
- Purpose: branch to read context from.
- Current target: `main`.

`GITHUB_BRAIN_ROOT_PATH`
- Purpose: subpath inside repository root where context files live.
- Current target: empty string for repo root files.

`GITHUB_BRAIN_TOKEN`
- Purpose: GitHub token with repo contents read permission.
- Needed for private repos.

### 6.2 Frontend variables (`app/.env`)

`VITE_API_BASE_URL`
- Purpose: frontend backend origin for `/signed-url` + `/conversation/finalize`.
- Production target: `https://call-julia.vercel.app`.

`VITE_ELEVENLABS_AGENT_ID`
- Purpose: selected agent for web call UI.
- Must match backend/ElevenLabs agent.

## 7) ElevenLabs Configuration Contract

Inside ElevenLabs Agent Custom LLM panel:

1. Server URL mode: `Chat Completions`.
2. Base URL field: `https://call-julia.vercel.app/v1`
3. Appended path: `/chat/completions` (managed by ElevenLabs UI).
4. Model ID: `claude-sonnet-4-20250514`
5. API key field:
   - if backend endpoint is public and unauthenticated, any placeholder secret can be used in ElevenLabs UI.
   - if backend auth is added later, this key must match backend auth validation logic.

## 8) GitHub Token Requirements for Brain Access

Use a fine-grained personal access token:

1. Repository access:
   - only `drewe4point0/julia-workspace` (or the relevant brain repo).
2. Permissions:
   - Repository `Contents`: Read-only.
   - `Metadata`: Read-only (required by GitHub).
3. Store in backend env:
   - `GITHUB_BRAIN_TOKEN=<token>`

Never commit the token value.

## 9) How to Determine Which Runtime Is Actually Serving Traffic

Run these in order:

1. `curl -sS https://call-julia.vercel.app/health`
2. `curl -sS http://127.0.0.1:3789/health`
3. `lsof -nP -iTCP:3789 -sTCP:LISTEN`
4. Check frontend `VITE_API_BASE_URL` for deployed app.
5. Check ElevenLabs Custom LLM base URL.

Interpretation:

1. If frontend base URL and ElevenLabs both point to `call-julia.vercel.app`, production path is Vercel backend.
2. If either points to localhost/Tailscale, that component is still using local runtime.

## 10) Current Design Decisions and Why They Exist

1. Split frontend/backend projects on Vercel:
   - separates secrets from static UI.
2. Keep OpenAI-compatible `/v1/chat/completions` contract:
   - required for ElevenLabs custom LLM integration.
3. Parse action tags in model text:
   - provider-agnostic and stream-compatible.
4. Dedupe and cooldown action side effects:
   - prevents reminder spam.
5. Enforce explicit reminder phrasing:
   - downstream Telegram reader can execute reliably.
6. Include emotion-handling instructions:
   - expressive voice signal should influence response style and summary.
7. Enforce caller naming (`Drewe`) and calendar consistency:
   - prevents drift and ambiguity in summaries.
8. Support remote GitHub brain loading:
   - Vercel runtime may not have local workspace files.

## 11) Known Limits (Important for Future Agents)

1. `/tmp/call-julia-memory` on Vercel is ephemeral:
   - call summaries may not persist across cold starts/deploys.
   - durable memory source should remain GitHub-based or move to DB/storage.
2. LLM can still produce incorrect dates in free text:
   - backend now post-processes weekday references where lines mention `today`/`tomorrow`.
3. Action dedupe is intentionally conservative:
   - distinct but similar reminders may be suppressed inside cooldown window.

## 12) Commit Trail for Operational Context

Recent commits tied to this runtime behavior:

1. `6bfd561` refactor voice runtime + memory pipeline + deployment docs.
2. `9930da2` action dedupe/prefix + remote brain loading.
3. `23aa72f` emotion-aware prompt + mood in summaries.
4. `6966996` filename variant matching for context files.
5. `1decd9f` GitHub API private brain support + summary section cleanup.
6. `3cff42a` config decision log expansion.
7. `97a807f` reminder clarity/dedupe + summary readability.
8. `55028a8` caller naming defaults to Drewe.
9. `790c8b4` timezone-anchored calendar consistency.

When changing behavior, update this file and `docs/CONFIG_DECISION_LOG.md` in the same commit.
