# Redis Machine Client (TypeScript)

A per-machine worker that:
1) Listens on a Redis Stream consumer group for its **allowed personas**.
2) Pulls project context from your dashboard.
3) Calls the **local LM Studio** server with the correct **model identifier**.
4) Emits a result event back to Redis and optionally updates the dashboard.

## Quick start

```bash
# 1) In this folder
npm i

# 2) Copy env and edit for THIS machine
cp .env.example .env
# - Set REDIS_URL/REDIS_PASSWORD
# - Set ALLOWED_PERSONAS to the personas this machine should handle
# - Set LMS_BASE_URL to the local LM Studio (http://127.0.0.1:1234)
# - Edit PERSONA_MODELS_JSON mapping for this machine

# 3) Run in dev (tsx) or build and start
npm run dev
# or
npm run build && npm start

# 4) (Optional) Seed an example request to your stream
npm run seed
```

## Streams & groups

- Requests: `agent.requests` (Coordinator → Persona)
- Events:   `agent.events`  (Persona → Coordinator)

Consumer group naming: `cg:<persona>`

## Notes
- Single‑load strategy: **one model per identifier**, reuse via system prompts.
- Each persona keeps its **own message history** (the dashboard is the source of truth).
- Error handling: on failure, the worker **XACKs** and emits a `status=error` to `agent.events` with `error` details.
