#!/usr/bin/env node
/*
 * Seeds the Todo Web Benchmark project into a dashboard from scratch:
 * project, repository, and the 8 canonical tasks with priorities and
 * dependency wiring (the same baseline `reset-benchmark.mjs all` produces on
 * the dashboard side, without any git side effects).
 *
 * Idempotent: re-running reuses the existing project/repository/tasks by slug,
 * url, and title, and only re-applies priorities and dependencies.
 *
 * Env (defaults shown):
 *   DASH_BASE=http://192.168.0.200:5402   (falls back to DASHBOARD_API_URL)
 *   REPO_DIR=<home>/code/todo-web-benchmark
 *   REPO_URL=<origin remote of REPO_DIR>
 *   PROJECT_SLUG=todo-web-benchmark
 *   PROJECT_NAME=Todo Web Benchmark
 *   DEFAULT_BRANCH=main
 */

import "dotenv/config";
import { execSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

const DASH_BASE = (
  process.env.DASH_BASE ||
  process.env.DASHBOARD_API_URL ||
  "http://192.168.0.200:5402"
).replace(/\/$/, "");
const REPO_DIR =
  process.env.REPO_DIR || join(homedir(), "code", "todo-web-benchmark");
const PROJECT_SLUG = process.env.PROJECT_SLUG || "todo-web-benchmark";
const PROJECT_NAME = process.env.PROJECT_NAME || "Todo Web Benchmark";
const DEFAULT_BRANCH = process.env.DEFAULT_BRANCH || "main";
const REPO_URL =
  process.env.REPO_URL ||
  execSync(`git -C "${REPO_DIR}" remote get-url origin`).toString().trim();

const SPEC = [
  { ref: "types", title: "Define the Todo domain types in src/types.ts", tier: "core", priority: 100, deps: [] },
  { ref: "reducer", title: "Implement the pure todo reducer in src/todoReducer.ts", tier: "core", priority: 90, deps: ["types"] },
  { ref: "selectors", title: "Implement view selectors in src/selectors.ts", tier: "core", priority: 90, deps: ["types"] },
  { ref: "hook", title: "Add the useTodos hook in src/useTodos.ts", tier: "ui", priority: 80, deps: ["reducer"] },
  { ref: "todoitem", title: "Build the TodoItem component in src/components/TodoItem.tsx", tier: "ui", priority: 70, deps: ["types"] },
  { ref: "addform", title: "Build the AddTodoForm component in src/components/AddTodoForm.tsx", tier: "ui", priority: 70, deps: [] },
  { ref: "filterbar", title: "Build the FilterBar component in src/components/FilterBar.tsx", tier: "ui", priority: 70, deps: ["types"] },
  { ref: "app", title: "Compose the todo app in src/App.tsx", tier: "ui", priority: 10, deps: ["hook", "selectors", "todoitem", "addform", "filterbar"] },
];

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
  return body;
}

async function ensureProject() {
  const projects = (await dash("/projects")).data || [];
  const found = projects.find((p) => p.slug === PROJECT_SLUG);
  if (found) return found;
  return dash("/projects", {
    method: "POST",
    body: JSON.stringify({ name: PROJECT_NAME, slug: PROJECT_SLUG }),
  });
}

async function ensureRepository(projectId) {
  const repos = await dash(`/projects/${projectId}/repositories`);
  const list = Array.isArray(repos) ? repos : [];
  if (list.some((r) => r.url === REPO_URL)) return;
  await dash(`/projects/${projectId}/repositories`, {
    method: "POST",
    body: JSON.stringify({ url: REPO_URL, default_branch: DEFAULT_BRANCH }),
  });
}

async function ensureTasks(projectId) {
  const existing = (await dash(`/projects/${projectId}/tasks`)).data || [];
  const idByTitle = new Map(existing.map((t) => [t.title, t.id]));

  const toCreate = SPEC.filter((s) => !idByTitle.has(s.title)).map((s) => ({
    title: s.title,
    status: "open",
    priority_score: s.priority,
    external_id: s.ref,
  }));

  if (toCreate.length) {
    const res = await dash(`/projects/${projectId}/tasks:bulk`, {
      method: "POST",
      body: JSON.stringify({ tasks: toCreate }),
    });
    for (const t of res.created) idByTitle.set(t.title, t.id);
    for (const s of res.skipped) idByTitle.set(s.task.title, s.task.id);
  }

  const idByRef = new Map(SPEC.map((s) => [s.ref, idByTitle.get(s.title)]));

  for (const s of SPEC) {
    const id = idByRef.get(s.ref);
    const deps = s.deps.map((r) => String(idByRef.get(r)));
    await dash(`/projects/${projectId}/tasks/${id}`, {
      method: "PATCH",
      body: JSON.stringify({
        status: "open",
        priority_score: s.priority,
        blocked_dependencies: deps,
        claimed_by: null,
        claimed_at: null,
      }),
    });
    console.log(
      `  task ${id} (${s.ref}, ${s.tier}) open prio ${s.priority} deps [${deps.join(",")}]`,
    );
  }
  return idByRef;
}

async function main() {
  console.log(`Seeding '${PROJECT_SLUG}' into ${DASH_BASE}`);
  const project = await ensureProject();
  console.log(`  project ${project.id} (${project.slug})`);
  await ensureRepository(project.id);
  console.log(`  repository ensured on ${DEFAULT_BRANCH}`);
  await ensureTasks(project.id);
  console.log(`\nDone. Project ${project.id}: ${SPEC.length} tasks seeded.`);
}

main().catch((err) => {
  console.error(`\nSeed failed: ${err.message}`);
  process.exit(1);
});
