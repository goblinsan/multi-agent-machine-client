#!/usr/bin/env node
/*
 * Scores a completed benchmark run into benchmark_results on the dashboard.
 * Reads the run's task_started/task_completed|failed events, maps each task to
 * its workflow_type via the benchmark SPEC, and posts one result per task
 * attempt (idempotent on the end event's id).
 *
 * This is the reusable sweep primitive: for each model you want to measure,
 *   1. set PERSONA_MODELS_JSON / PERSONA_ENDPOINTS_JSON to that model
 *   2. node scripts/reset-benchmark.mjs core   (or ui / all)
 *   3. run the coordinator (npm run local -- <projectId>)
 *   4. node scripts/score-benchmark.mjs --model=<model-id>
 * Repeat with the next model; benchmark_results accumulates the matrix.
 *
 * Env (defaults shown):
 *   DASH_BASE=<DASHBOARD_API_URL>          dashboard base URL
 *   PROJECT_SLUG=todo-web-benchmark
 *   SUITE=todo-web-benchmark
 *   MODEL_ID=<--model= arg, else derived from PERSONA_MODELS_JSON>
 *   NODE_ID=<optional>
 *   RUN_ID=<--run= arg, else the latest orchestrate_milestone run>
 */

import "dotenv/config";

const arg = (name) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split("=").slice(1).join("=") : null;
};

const DASH_BASE = (
  process.env.DASH_BASE ||
  process.env.DASHBOARD_API_URL ||
  "http://localhost:3000"
).replace(/\/$/, "");
const PROJECT_SLUG = process.env.PROJECT_SLUG || "todo-web-benchmark";
const SUITE = process.env.SUITE || "todo-web-benchmark";
const NODE_ID = process.env.NODE_ID || null;
const RUN_ID = process.env.RUN_ID || arg("run");

function deriveModel() {
  try {
    const m = JSON.parse(process.env.PERSONA_MODELS_JSON || "{}");
    return (
      m["lead-engineer"] ||
      m["implementation-planner"] ||
      Object.values(m)[0] ||
      null
    );
  } catch {
    return null;
  }
}
const MODEL_ID = process.env.MODEL_ID || arg("model") || deriveModel();

const SPEC = [
  { ref: "types", title: "Define the Todo domain types in src/types.ts", tier: "core" },
  { ref: "reducer", title: "Implement the pure todo reducer in src/todoReducer.ts", tier: "core" },
  { ref: "selectors", title: "Implement view selectors in src/selectors.ts", tier: "core" },
  { ref: "hook", title: "Add the useTodos hook in src/useTodos.ts", tier: "ui" },
  { ref: "todoitem", title: "Build the TodoItem component in src/components/TodoItem.tsx", tier: "ui" },
  { ref: "addform", title: "Build the AddTodoForm component in src/components/AddTodoForm.tsx", tier: "ui" },
  { ref: "filterbar", title: "Build the FilterBar component in src/components/FilterBar.tsx", tier: "ui" },
  { ref: "app", title: "Compose the todo app in src/App.tsx", tier: "ui" },
];

const workflowTypeFor = (tier) => (tier === "core" ? "core-logic" : "react-ui");
const toMs = (ts) => (ts ? Date.parse(ts.replace(" ", "T") + "Z") : NaN);

async function dash(path, init = {}) {
  const res = await fetch(`${DASH_BASE}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init.headers || {}) },
  });
  const text = await res.text();
  let body;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (!res.ok)
    throw new Error(`${init.method || "GET"} ${path} -> ${res.status}: ${text}`);
  return { status: res.status, body };
}

async function main() {
  if (!MODEL_ID) {
    throw new Error(
      "MODEL_ID required (set MODEL_ID, pass --model=<id>, or set PERSONA_MODELS_JSON)",
    );
  }
  console.log(`Scoring '${PROJECT_SLUG}' on ${DASH_BASE} for model ${MODEL_ID}`);

  const projects = (await dash("/projects")).body.data || [];
  const project = projects.find((p) => p.slug === PROJECT_SLUG);
  if (!project) throw new Error(`Project '${PROJECT_SLUG}' not found`);

  const runs = (await dash(`/projects/${project.id}/runs`)).body.data || [];
  let run;
  if (RUN_ID) {
    run = runs.find((r) => String(r.id) === String(RUN_ID));
    if (!run) throw new Error(`Run ${RUN_ID} not found for project`);
  } else {
    run = runs.find((r) => r.workflow_type === "orchestrate_milestone");
    if (!run) throw new Error("No orchestrate_milestone run found");
  }

  const tasks = (await dash(`/projects/${project.id}/tasks`)).body.data || [];
  const specByTitle = new Map(SPEC.map((s) => [s.title, s]));
  const specByTaskId = new Map();
  for (const t of tasks) {
    const s = specByTitle.get(t.title);
    if (s) specByTaskId.set(String(t.id), s);
  }

  const events = (await dash(`/runs/${run.id}/events`)).body.data || [];
  const starts = new Map();
  const outcomes = [];
  for (const e of events) {
    const taskId =
      e.payload && e.payload.taskId != null
        ? String(e.payload.taskId)
        : e.step_name && e.step_name.startsWith("task:")
          ? e.step_name.slice(5)
          : null;
    if (!taskId) continue;
    if (e.event_type === "task_started") {
      starts.set(taskId, e);
    } else if (
      e.event_type === "task_completed" ||
      e.event_type === "task_failed"
    ) {
      outcomes.push({
        taskId,
        pass: e.event_type === "task_completed",
        start: starts.get(taskId),
        end: e,
      });
    }
  }

  let posted = 0;
  for (const o of outcomes) {
    const spec = specByTaskId.get(o.taskId);
    if (!spec) continue;
    const durationMs =
      o.start && o.end && !Number.isNaN(toMs(o.end.ts))
        ? toMs(o.end.ts) - toMs(o.start.ts)
        : null;
    const body = {
      benchmark_suite: SUITE,
      benchmark_case: spec.ref,
      scope: "workflow",
      workflow_type: workflowTypeFor(spec.tier),
      model_id: MODEL_ID,
      node_id: NODE_ID,
      pass: o.pass,
      external_id: o.end.event_id,
      ...(durationMs != null ? { metrics: { duration_ms: durationMs } } : {}),
    };
    const res = await dash(`/runs/${run.id}/benchmark-results`, {
      method: "POST",
      body: JSON.stringify(body),
    });
    posted++;
    console.log(
      `  ${spec.ref} (${body.workflow_type}) pass=${o.pass}${durationMs != null ? " " + durationMs + "ms" : ""} -> ${res.status}`,
    );
  }

  console.log(
    `\nScored run ${run.id} (${run.external_id}) for ${MODEL_ID}: ${posted} result(s).`,
  );
}

main().catch((err) => {
  console.error(`\nScore failed: ${err.message}`);
  process.exit(1);
});
