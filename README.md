# Redis Machine Client (TypeScript)

Per-machine worker that:
1) Listens on Redis Streams for its **allowed personas**.
2) Pulls project context from your dashboard.
3) Calls the **local LM Studio** model (single-loaded identifier).
4) Emits a result event to Redis and (optionally) updates the dashboard.
5) (Optional) **Applies file edits** safely and commits to a branch.
6) (Optional) **Context scanner** writes `.ma/context` artifacts before the model call when persona===context.
7) **Multi-component scanning**: set SCAN_COMPONENTS or pass payload.components.

See `.env.example` for config.
