## API update v2 — goals and notes

The dashboard API currently accepts task creates by slug and sometimes returns minimal responses. To make the multi-agent coordinator reliable we need a small set of server-side changes so the agent can consistently obtain canonical task IDs, milestone IDs, and set initial statuses at create-time. This document outlines the recommended API contract, DB migrations, tests, and rollout plan.

### Implementation plan (dashboard changes)

Goal: guarantee that POST /v1/tasks returns a canonical task object (including id and milestone_id when applicable) and that the API supports reliable lookup by `external_id` so the agent never needs to rely on fragile title-search fallbacks or local persistence.

- Core principles
  - Idempotence: clients should be able to safely re-send a create with the same `external_id` and receive the same canonical task (upsert-by-external_id behavior).
  - Deterministic responses: POST should return the created/existing task object (not just a 201 with empty body).
  - Canonical milestone resolution: when a client provides `milestone_slug` the API should resolve and return `milestone_id` or fail clearly; implicit server-side creation of arbitrary milestones should be controlled and observable.
  - Optimistic-locking: task updates should be lock-version aware (return `lock_version` on reads/creates and accept it on PATCH operations).

### API contract changes

1) POST /v1/tasks
  - Input (JSON):
    {
      "project_id"?: string,
      "project_slug"?: string,
      "milestone_id"?: string,
      "milestone_slug"?: string,
      "parent_task_id"?: string,
      "title": string,
      "description": string,
      "effort_estimate"?: number,
      "priority_score"?: number,
      "assignee_persona"?: string,
      "external_id"?: string,
      "attachments"?: [...],
      "options"?: { "initial_status"?: string }
    }

  - Behavior:
    - If `external_id` provided, attempt to find an existing task in the same `project_id` (or `project_slug` resolved). If found, return the existing task (200). If not found, create a new task and return 201.
    - Always return a full task object in the response JSON with fields: `id`, `external_id`, `title`, `description`, `project_id`, `milestone_id`, `milestone_slug` (if provided), `parent_task_id`, `status`, `lock_version`, `created_at`, `updated_at` and any other relevant metadata.
    - Include a Location header pointing to `/v1/tasks/{id}` for both created and existing returns.
    - If `milestone_slug` is provided and not resolved to an existing milestone: either return 422 with an explicit list of valid milestone slugs (preferred) or create only when the slug is explicitly allowed (e.g. `future-enhancements`) depending on cluster configuration. If creation is allowed, create the canonical milestone and return its `milestone_id` in the task response.
    - If `options.initial_status` is provided and allowed for the API key, set that status on creation and return it in the task object.
    - Enforce uniqueness of (`external_id`, `project_id`) at DB level and return 409 if a conflicting cross-project or inconsistent-ownership collision occurs.

2) GET /v1/tasks
  - Accept query params: `external_id`, `project_id`, `project_slug`, `milestone_id`, `created_after`, `limit`, `offset`.
  - Return an array of full task objects matching the filter. If `external_id` specified, return at most one canonical match (or return a small, ordered list if duplicates exist but prefer to avoid duplicates via DB constraint).

3) GET /v1/tasks/{id}
  - Return full task object including `lock_version`.

4) PATCH /v1/tasks/{id}
  - Accept `status` and an optional `lock_version` in the body. If `lock_version` mismatches current, return 409 to indicate a race; otherwise increment `lock_version` and apply update.

5) POST /v1/milestones (if auto-creation is desired)
  - Create milestone with a normalized `slug` and `name`, ensure unique `(project_id, slug)`, return full milestone object.

### DB / schema changes (Postgres examples)

-- tasks: ensure external_id uniqueness per project and lock_version
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS lock_version integer DEFAULT 0 NOT NULL;
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS ux_tasks_external_project ON tasks((external_id), project_id) WHERE external_id IS NOT NULL;

-- milestones: normalized slug + unique per project
ALTER TABLE milestones ADD COLUMN IF NOT EXISTS slug text;
-- normalize existing slugs via a migration script to lowercase-hyphen form
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS ux_milestones_project_slug ON milestones(project_id, slug);

Notes: run migration scripts during a maintenance window; use CONCURRENTLY for index creation to avoid long locks.

### Implementation details (server)
- When handling POST /v1/tasks with `external_id`:
  - Begin DB transaction.
  - If `external_id` present: SELECT FOR UPDATE on tasks WHERE external_id = $1 AND project_id = $2. If exists, return it (200). If not, INSERT and return 201. This prevents race-created duplicates.
  - If `milestone_slug` provided and `milestone_id` not provided: attempt to resolve milestone by (project_id, normalized slug); if not found and auto-create allowed, INSERT milestone in same transaction and use its id.

### Response examples

Create (existing): 200
HTTP/1.1 200 OK
Location: /v1/tasks/abcd-1234
{
  "id": "abcd-1234",
  "external_id": "auto-qa-xyz",
  "title": "QA follow-up",
  "description": "...",
  "project_id": "proj-1",
  "milestone_id": "mile-1",
  "status": "in_progress",
  "lock_version": 2,
  "created_at": "...",
  "updated_at": "..."
}

Create (new): 201
HTTP/1.1 201 Created
Location: /v1/tasks/new-uuid
{ ... same object with new id ... }

Error: unknown milestone slug
HTTP/1.1 422 Unprocessable Entity
{
  "error": "milestone_not_found",
  "available_milestones": [ { "id": "mile-1", "slug": "mvp-local-ingestion-ui", "name": "MVP - Local ingestion + UI" }, ... ]
}

### Tests to add (server)
- POST /v1/tasks with external_id: new create returns 201 and full object + Location
- POST /v1/tasks with same external_id: returns 200 and same object (idempotent)
- POST /v1/tasks with milestone_slug resolves milestone_id or returns 422 (and returns list)
- GET /v1/tasks?external_id=... returns the created task
- Concurrent POST with same external_id: ensure only one record created (use transactional SELECT...FOR UPDATE or DB uniqueness)

### Rollout and compatibility
- Implement and enable in staging. Keep a compatibility mode that preserves old behavior for a short period while agents are rolled out.
- Agent changes: once API returns canonical ids reliably, remove title-search fallback and read-after-create retries. The agent will prefer `created.id` or Location header.

### Observability and monitoring
- Add metrics/logs for: create success rate, creates that returned no id (should be zero after change), frequency of 422 milestone_not_found responses, and duplicate-external_id conflicts.

### Quick migration SQL snippets (Postgres)
-- add lock_version and unique external index
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS lock_version integer DEFAULT 0 NOT NULL;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE c.relname = 'ux_tasks_external_project') THEN
    CREATE UNIQUE INDEX CONCURRENTLY ux_tasks_external_project ON tasks((external_id), project_id) WHERE external_id IS NOT NULL;
  END IF;
END$$;

-- ensure milestones have slug and unique index
ALTER TABLE milestones ADD COLUMN IF NOT EXISTS slug text;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE c.relname = 'ux_milestones_project_slug') THEN
    CREATE UNIQUE INDEX CONCURRENTLY ux_milestones_project_slug ON milestones(project_id, slug);
  END IF;
END$$;

### Next steps for me (agent-side)
After you implement and deploy these server changes in staging:
1. Tell me when the POST /v1/tasks response includes the full object and Location header. I'll update `src/dashboard.ts` to read `createdId` from the response body (or Location header) and remove the read-after-create retry/fallbacks.
2. I will remove the title-search fallback in `src/worker.ts` and replace it with a single lookup by `external_id` (with Redis optional if you want persisted mapping across restarts).

If you'd like, I can also generate a minimal OpenAPI fragment for these endpoints (useful for server-side implementation and tests).
