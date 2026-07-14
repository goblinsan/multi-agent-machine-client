# Deploying the agentic coding service

The system splits into **stateful long-lived services** and a **stateless orchestrator**,
wired together entirely through environment variables. Nothing here needs a GPU except the
model endpoints — the orchestrator is a CPU-only Node process.

## Topology

```
                 ┌─────────────────────────┐
                 │  project-dashboard      │   separate service (own repo)
                 │  Fastify + Postgres     │   holds projects / tasks / plans / artifacts
                 │  :<port>  DATABASE_URL   │
                 └───────────▲─────────────┘
                             │ HTTP (DASHBOARD_BASE_URL / DASHBOARD_API_URL)
                 ┌───────────┴─────────────┐
                 │  orchestrator node (CPU)│   coordinator + persona workers
                 │  npm run local -- <pid> │   works the plans stored in the dashboard
                 └───┬──────────────────┬──┘
      per-persona    │                  │   per-persona
      endpoint       ▼                  ▼   endpoint
        ┌────────────────────┐  ┌────────────────────┐
        │ 14B node (GPU)     │  │ 9B node (GPU)      │
        │ implement/plan/... │  │ reviews/context/.. │
        └────────────────────┘  └────────────────────┘
```

- **project-dashboard** is a separate service, deployed from its own repository and backed
  by a managed Postgres instance. It is no longer part of this repo; the orchestrator only
  talks to it over HTTP.
- **orchestrator node** is CPU-light. It reads the project's tasks/plans from the dashboard
  over HTTP and dispatches persona work to the model endpoints. It does **not** own the
  dashboard — it verifies the configured dashboard is reachable at startup and fails fast if
  it is not.
- **model nodes** are reached per-persona (see `PERSONA_ENDPOINTS_JSON`), so the heavy
  generative roles go to the 14B and everything else stays on the smaller model.

Everything except the two GPU nodes and the dashboard's database can co-locate on a single
small node if you prefer; `TRANSPORT_TYPE=local` keeps the coordinator and workers in one
process (no Redis needed). Use `TRANSPORT_TYPE=redis` + `REDIS_URL` only if you split workers
across machines.

## 1. Dashboard

Deploy the `project-dashboard` service from its own repository (see that repo's README and
the control-plane runbook). It exposes the same HTTP API this orchestrator expects; point the
orchestrator at its published URL.

## 2. Orchestrator node

Copy `orchestrator.env.example` to `.env`, set `DASHBOARD_BASE_URL` and `DASHBOARD_API_URL`
to the deployed dashboard service, and the model endpoints to your GPU nodes. Then launch a
run for a project id:

```sh
npm run local -- <project_id>
```

`run_local` verifies the dashboard is reachable (health + artifact API) and does not spawn or
kill one.

## Files

- `orchestrator.env.example` — env for the coordinator/worker node
