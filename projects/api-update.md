## Step 1 — Slug resolution endpoint (quick win)

Endpoint: GET /v1/projects/{project_id}/milestones
Purpose: Find milestone(s) by slug or name so clients can resolve slugs to UUIDs.
Query params:
?slug=<slug> (preferred)
?name=<name>
?limit=10
Response: 200 with array of milestone objects (id, slug, name, start_date, due_date, url)
404: if project not found
Example request: GET /v1/projects/1808e304-fc52-49f6-9a42-71044b4cb4b5/milestones?slug=mvp-local-ingestion-ui
Example response: 200 OK { "ok": true, "milestones": [ { "id":"11111111-1111-1111-1111-111111111111", "slug":"mvp-local-ingestion-ui", "name":"MVP: Local ingestion UI", "due":"2025-11-01" } ] }
Implementation notes:
Index milestones by slug in DB for fast lookup.
Accept case-insensitive match; consider fuzzy matches for suggestions.
Tests:
slug match returns single milestone
no match returns empty array (or 404 with suggestion, your choice)

## Step 2 — Extend POST /v1/tasks to accept references, attachments, options

Endpoint: POST /v1/tasks
Minimal backward-compatible change:
Accept milestone_slug and project_slug as alternates to milestone_id and project_id.
Accept parent_task_external_id alongside parent_task_id.
Recommended richer payload (OpenAPI-style JSON schema)
Request body: { "references": { "project": { "id": "<uuid>", "slug": "..." }, "milestone": { "id": "<uuid>", "slug": "...", "name": "...", "auto_create": false }, "parent_task": { "id": "<uuid>", "external_id": "c1" } }, "title": "QA follow-up", "description": "Build and tests failed. See attachments.", "effort_estimate": 3, "priority_score": 5, "assignee_persona": "lead-engineer", "external_id": "wf_coord_1759456443504-qa-1", "attachments": [ { "name":"npm-debug.log", "content_base64":"..." } ], "options": { "resolve_inline": true, "create_milestone_if_missing": false } }
Server behavior:
Resolve project id:
If references.project.id present: use it.
Else if references.project.slug present: resolve to id; if not found => 404 (unless options.resolve_inline true and allowed).
Resolve milestone:
If references.milestone.id present: use it.
Else if references.milestone.slug present: attempt lookup under project.
If not found and create_milestone_if_missing true: create milestone with that slug.
Else return 404/422 with suggestions.
Resolve parent task by id or external_id and use it as parent_task_id if found.
Check for external_id idempotency (see Step 4).
Store attachments: decode base64, save to attachments storage (e.g., S3 or DB blob), and reference them from task record.
Create task record linking project_id, milestone_id, parent_task_id as available.
Return 201 with full task object.
Response example (success): 201 Created { "ok": true, "task": { "id":"c9a3a7f6-....", "title":"QA follow-up", "project_id":"1808e304-...", "milestone_id":"11111111-...", "parent_task_id":"278e5daa-...", "assignee_persona":"lead-engineer", "attachments":[ { "id":"att-1", "name":"npm-debug.log", "url":"https://..." } ], "url":"/v1/tasks/c9a3a7f6" } }
Error example (unresolved slug): 404 Not Found { "ok": false, "status":404, "detail":[ { "type":"not_found","loc":["body","references","milestone","slug"],"msg":"Milestone not found","input":"mvp-local-ingestion-ui", "suggestions":[{"slug":"mvp-local-ingestion","id":"1111-..."}] } ] }
Backwards compatibility:
Continue accepting the old simple body fields (project_id, milestone_id, parent_task_id) for older clients.

## Step 3 — Idempotency with external_id (server must store and check)

Purpose: Prevent duplicate tasks when coordinator retries; allow safe retries.
Pattern:
Add column external_id (nullable string, unique index) on tasks.
On create:
If external_id provided and already exists, return 200 (or 409 with existing task info). I recommend returning 200 and the existing task (idempotent semantics).
If not exists, create and store external_id.
Example:
First POST with external_id="wf_coord_123-qa-1" → create new task (201), store external_id.
Retry same POST → server responds 200 with existing task info.
Race safety:
Use DB constraint + upsert or transactional insert to avoid duplicate creation during concurrent requests.
Response example on duplicate: 200 OK { "ok": true, "status":200, "task": { "id":"c9a3a7f6-....", ... }, "note":"existing" }

## Implementation checklist and timeline estimate

Step 1 (slug resolution endpoint): 1-2 hours
Implement DB query + route + tests.
Step 2 (extended POST /v1/tasks): 4-8 hours
Parse references, resolve slugs -> ids, accept attachments, validate input, return helpful errors.
Step 3 (idempotency): 2-4 hours
DB migration (add external_id unique), update create logic to check/return existing.
