# Dashboard Backend (Proof-of-Concept)

This is a self-contained proof-of-concept for the Dashboard API (Phase 2).

Prerequisites:

- Node 18+ and npm

Quickstart:

```bash
cd src/dashboard-backend
npm install
npm run dev
```

This will start a Fastify server on port 3000 and apply schema from `docs/dashboard-api/schema.sql`.

API Endpoints (basic):

- GET /projects/:projectId/tasks
- GET /projects/:projectId/tasks/:taskId
- POST /projects/:projectId/tasks
- POST /projects/:projectId/tasks:bulk
- PATCH /projects/:projectId/tasks/:taskId

Notes:

- The POC reads the authoritative schema from `docs/dashboard-api/schema.sql` in the repo.
- For production, set `DATABASE_PATH` env var to control DB location.
