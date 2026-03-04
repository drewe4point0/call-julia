# Architecture

For full post-launch maintenance details and design rationale, see:
- `/Users/macminihome/dev_projects/call-julia/docs/AGENT_OPERATIONS_GUIDE.md`

## Components

- **Frontend (`app/`)**: React + `@elevenlabs/react` call UI.
- **Backend (`server/`)**: Express API for signed URLs, custom LLM responses, action execution, and call finalization.
- **Brain context (`brain/`)**: `soul.md`, `claude.md`, `memories.md`, `user.md`, plus rolling memory files in `brain/memory/`.

## Request Flow

1. Frontend calls `GET /signed-url?agent_id=...`.
2. Frontend starts ElevenLabs session with the returned signed URL.
3. ElevenLabs calls backend `POST /v1/chat/completions` (custom LLM endpoint).
4. Backend injects brain context and routes to configured LLM provider:
   - `openai-compatible` (Claude Max proxy or any OpenAI-compatible endpoint), or
   - `anthropic` (direct Anthropic API).
5. Backend strips action tags from spoken stream and executes actions (Telegram/iMessage).
6. On end/disconnect, frontend sends transcript to `POST /conversation/finalize`.
7. Backend summarizes the call, sends summary to Telegram, and appends memory to `brain/memory/YYYY-MM-DD.md`.

## Key Endpoints

- `GET /health`
- `GET /signed-url`
- `POST /v1/chat/completions`
- `POST /conversation/finalize`
- `POST /save-memory` (legacy alias of finalize)
