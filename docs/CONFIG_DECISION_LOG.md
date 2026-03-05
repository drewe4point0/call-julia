# Config Decision Log (Agent-Facing)

This is the authoritative explanation of configuration choices for `call-julia`.
Use this document when changing environment variables, behavior defaults, or deployment wiring.

## 1) Outcomes We Optimize For

1. Reliable voice call flow from web app to ElevenLabs.
2. Julia responses influenced by persona + memory context.
3. Exactly-once-ish action notifications (avoid Telegram spam).
4. End-of-call summaries persisted and sent.
5. Emotional signal awareness in both response behavior and summary output.

## 2) Current Topology (Production)

Expected production split:

1. Frontend project: `talk-with-julia.vercel.app`
2. Backend project: `call-julia.vercel.app`
3. ElevenLabs custom LLM endpoint:
- `https://call-julia.vercel.app/v1/chat/completions`

Why split:

1. Frontend is static Vite output and easy to cache.
2. Backend holds secrets and mediates external APIs.
3. ElevenLabs must call a public backend endpoint, not frontend.

## 3) Core Behavior Decisions (What + Why + Effect)

### A) Action spam prevention

Decision:

1. Parse all action tags, then dedupe + limit + cooldown filter before executing.

Why:

1. LLMs may repeat tags in one completion or across nearby turns.

Effect:

1. User receives one reminder instead of repeated copies.
2. Slight risk: truly distinct repeated request within cooldown may be suppressed.

Controls:

- `MAX_ACTIONS_PER_RESPONSE`
- `ACTION_DEDUP_WINDOW_SEC`

### B) Action message prefix

Decision:

1. Prefix outgoing action text with:
- `Drewe and I just talked about this so let's make sure that it happens:`

Why:

1. Message context in Telegram should be explicit and recognizable.

Effect:

1. Every action message is framed as follow-through from a call.

Control:

- `ACTION_TELEGRAM_PREFIX`

Additional wording guardrail:

1. Backend rewrites short/ambiguous reminder text into clearer phrasing, e.g.:
- "Drewe would like to be reminded tomorrow at 9:00 AM to call the dentist."

Why:

1. Downstream Telegram receiver should be able to infer precise intent quickly.

### C) Emotion-aware behavior

Decision:

1. Prompt requires mood inference and tone adaptation.
2. User message normalization appends detected emotion metadata hints when available.

Why:

1. ElevenLabs expressive mode provides cues that should influence responses.

Effect:

1. Julia can acknowledge stress/anxiety/excitement with better calibration.
2. Mood appears in call summaries.

### D) Summary output format

Decision:

1. Keep summary sections for discussion, actions, preferences, and emotional signals.
2. Remove "Julia Response Strategy" section.

Why:

1. You requested no future-directive section in summaries.

Effect:

1. Summaries stay descriptive, not prescriptive.
2. Plain-text sections with vertical spacing improve Telegram readability.

### E) Memory/context loading in serverless

Decision:

1. Try local `BRAIN_DIR`/`MEMORY_DIR`.
2. Fallback to remote content.
3. Prefer GitHub API mode for private repos.
4. Cache loaded context briefly.

Why:

1. Vercel function bundle may not include sibling repo files.
2. Raw GitHub URLs fail for private repos.
3. Re-fetching every request increases latency.

Effect:

1. Persona and memory remain available in Vercel runtime.
2. Slight staleness during cache TTL window.

Controls:

- `BRAIN_REMOTE_BASE_URL`
- `GITHUB_BRAIN_*`
- `CONTEXT_CACHE_TTL_MS`
- `BRAIN_REMOTE_TIMEOUT_MS`

## 4) Environment Variable Reference (Decision Table)

### 4.1 Backend transport/runtime

`PORT`
- Typical: `3789` (local); ignored by Vercel runtime routing.
- Why: consistent local port.
- Effect: local process binding.

`CORS_ORIGINS`
- Production: `https://talk-with-julia.vercel.app`
- Why: frontend should be allowed to call backend.
- Effect: browser calls succeed across origins.

`TIMEZONE`
- Production: `America/Vancouver`
- Why: date-stamped memory + time phrasing should match your timezone.
- Effect: summary timestamps and "today/yesterday" alignment.

`ASSISTANT_NAME`
- Typical: `Julia`
- Why: prompt identity consistency.

### 4.2 ElevenLabs integration

`ELEVENLABS_API_KEY`
- Required for `/signed-url`.
- Why: backend mints signed conversation URLs.

`ELEVENLABS_AGENT_ID`
- Must match frontend `VITE_ELEVENLABS_AGENT_ID`.
- Why: signed URL and agent behavior alignment.

### 4.3 LLM provider selection

`LLM_PROVIDER`
- `anthropic` on Vercel (recommended).
- `openai-compatible` for local Claude proxy.
- Why: Vercel cannot use `localhost:3456`.

`LLM_MODEL`
- Current: `claude-sonnet-4-20250514`
- Why: stable tested model ID.

`LLM_MAX_TOKENS`
- Current: `450`
- Why: voice responses should stay concise and low-latency.
- Effect: limits verbosity and cost.

`ANTHROPIC_API_KEY` / `ANTHROPIC_VERSION`
- Required when provider is `anthropic`.

`LLM_BASE_URL` / `LLM_API_KEY`
- Used only in `openai-compatible` mode.
- Typical local: `LLM_BASE_URL=http://localhost:3456`.

### 4.4 Action execution and anti-spam

`TELEGRAM_BOT_TOKEN`
- Required for action + summary sends.

`TELEGRAM_CHAT_ID`
- Destination chat.

`ACTION_TELEGRAM_PREFIX`
- Current desired prefix text.
- Why: contextual clarity in Telegram.

`MAX_ACTIONS_PER_RESPONSE`
- Current: `1`
- Why: prevent multi-action blasts from one model turn.

`ACTION_DEDUP_WINDOW_SEC`
- Current: `180`
- Why: suppress repeated identical actions during short retry loops.
- Effect: if same reminder is requested repeatedly within 3 minutes, duplicates are suppressed.

`ENABLE_IMESSAGE` / `IMESSAGE_TO`
- Optional local/macOS transport.

### 4.5 Context and memory sources

`BRAIN_DIR`
- Local default: `../brain`
- Why: local markdown persona files.

`MEMORY_DIR`
- Vercel recommended: `/tmp/call-julia-memory`
- Why: writable directory in serverless runtime.
- Effect: ephemeral filesystem; not durable long-term store.

`CONTEXT_FILES`
- Recommended for your workspace repo:
- `SOUL.md,USER.md,MEMORY.md,TOOLS.md`
- Why: matches actual file names and avoids unnecessary misses.

`RECENT_MEMORY_FILES`
- Current: `2`
- Why: keeps prompt compact while still including near-term context.

`CONTEXT_CACHE_TTL_MS`
- Current: `60000`
- Why: reduce remote fetch overhead.
- Effect: up to 60s delay before new file edits are reflected.

### 4.6 Remote context (raw URL mode)

`BRAIN_REMOTE_BASE_URL`
- Example:
- `https://raw.githubusercontent.com/<owner>/<repo>/<branch>/<root-path>`
- Why: fallback source for serverless contexts.
- Note: private repos will fail with 404 unless authenticated mode is used.

`BRAIN_REMOTE_MEMORY_PATH`
- Typical: `memory`

`BRAIN_REMOTE_TIMEOUT_MS`
- Current: `6000`
- Why: avoid long blocking calls to remote source.

`BRAIN_REMOTE_AUTH_TOKEN`
- Optional bearer token for raw endpoint if supported.

### 4.7 Remote context (GitHub API mode, private repo preferred)

`GITHUB_BRAIN_OWNER`
- Your owner/org (example: `drewe4point0`)

`GITHUB_BRAIN_REPO`
- Repo name (example: `julia-workspace`)

`GITHUB_BRAIN_BRANCH`
- Default: `main`

`GITHUB_BRAIN_ROOT_PATH`
- Path inside repo where brain files live (empty when at repo root).

`GITHUB_BRAIN_TOKEN`
- Token with read access to repo contents.
- Why: private repo support in Vercel runtime.

## 5) Response-Time and Stability Keys

These are the "response time keys" and related performance controls:

1. `LLM_MAX_TOKENS`
- Lower value => faster, shorter responses.

2. `BRAIN_REMOTE_TIMEOUT_MS`
- Caps remote file fetch wait time.
- Prevents long blocking before model call.

3. `CONTEXT_CACHE_TTL_MS`
- Prevents repeated remote fetch each turn.
- Tradeoff: temporary staleness.

4. `RECENT_MEMORY_FILES`
- More files => larger prompt => slower response.
- Current low value balances recall vs latency.

5. `ACTION_DEDUP_WINDOW_SEC`
- Operational stability; prevents repetitive side effects during retries.

## 6) Known Failure Patterns and Their Config Causes

### "I have no memory files"

Likely causes:

1. `BRAIN_REMOTE_BASE_URL` points to non-existent/publicly inaccessible path.
2. Private repo without `GITHUB_BRAIN_TOKEN`.
3. Wrong `CONTEXT_FILES` names.
4. Missing daily files in configured memory path.

Checks:

1. `/health` should show either `remoteBrainBaseUrl` or `githubBrainMode: true`.
2. Verify repo path and branch.

### Duplicate reminders

Likely causes:

1. `MAX_ACTIONS_PER_RESPONSE > 1`.
2. `ACTION_DEDUP_WINDOW_SEC=0`.
3. Reminder variants with small wording changes not normalized semantically.

Mitigation now in code:

1. Reminder intent normalization (e.g., "call dentist" + "call dentist tomorrow") is deduped in cooldown window.

### Slow first response

Likely causes:

1. Large context files.
2. Large `RECENT_MEMORY_FILES`.
3. Long remote fetch timeout.

## 7) Recommended Production Values (Current)

For your current desired behavior:

```env
LLM_PROVIDER=anthropic
LLM_MODEL=claude-sonnet-4-20250514
LLM_MAX_TOKENS=450

ACTION_TELEGRAM_PREFIX=Drewe and I just talked about this so let's make sure that it happens:
MAX_ACTIONS_PER_RESPONSE=1
ACTION_DEDUP_WINDOW_SEC=180

CONTEXT_FILES=SOUL.md,USER.md,MEMORY.md,TOOLS.md
RECENT_MEMORY_FILES=2
CONTEXT_CACHE_TTL_MS=60000
BRAIN_REMOTE_TIMEOUT_MS=6000

GITHUB_BRAIN_OWNER=drewe4point0
GITHUB_BRAIN_REPO=julia-workspace
GITHUB_BRAIN_BRANCH=main
GITHUB_BRAIN_ROOT_PATH=
GITHUB_BRAIN_TOKEN=<read-token>

MEMORY_DIR=/tmp/call-julia-memory
```

## 8) Change Management Rule for Future Agents

Before changing behavior defaults:

1. State user outcome being optimized.
2. List impacted env keys.
3. Predict side effects on latency, duplication, and memory recall.
4. Update this document and `AGENT_OPERATIONS_GUIDE.md`.
5. Add a small runtime check in `/health` output if new mode is introduced.
