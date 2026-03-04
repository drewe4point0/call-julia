# Julia Voice — Real-Time Calling Architecture

## Overview
Real-time voice conversations with Julia via a web app on Drewe's phone.

## Architecture: Two Phases

### Phase 1 — Quick Win (Today)
**ElevenLabs Conversational AI Agent + Web Widget**

- Create an ElevenLabs Agent via their API
- Voice: Jessica (cgSgspJ2msm6clMCkdW9)
- LLM: Claude Sonnet 4 (built-in, no custom server needed)
- System prompt: Julia's personality from SOUL.md + key context
- Deploy: Simple React app → Vercel. Drewe opens URL, taps "Call Julia"
- Latency: Low — ElevenLabs handles all audio streaming via WebSocket
- Limitation: No access to Julia's tools, memory files, or Supabase. It's Julia's personality but without her "brain."

### Phase 2 — Full Brain (Later)
**Custom LLM Server → OpenClaw Bridge**

- FastAPI server on Mac Mini exposing OpenAI-compatible `/v1/chat/completions`
- ElevenLabs Agent points to this custom endpoint
- Server injects Julia's memory/context and routes to Claude via Anthropic API
- Exposed via Tailscale Funnel or ngrok for public URL
- Full tool access: memory, Supabase, cron, etc.
- This is "real Julia" on the phone

## Tech Stack
- `@elevenlabs/react` — React SDK with `useConversation` hook
- ElevenLabs Conversational AI API — agent creation + management
- Vite + React + TypeScript — web app
- Vercel — hosting
- Tailscale Funnel (Phase 2) — expose Mac Mini endpoint

## ElevenLabs Agent Config
- Voice: Jessica (cgSgspJ2msm6clMCkdW9)
- Model: Claude Sonnet 4 (Phase 1) / Custom LLM (Phase 2)
- System prompt: Julia's SOUL.md + USER.md context
- First message: "Hey Drewe. What's on your mind?"
- Language: English

## Cost (Starter Plan)
- 30 min/month of Conversational AI included on Starter ($5/mo)
- Additional: ~$0.08/min for voice + LLM costs
