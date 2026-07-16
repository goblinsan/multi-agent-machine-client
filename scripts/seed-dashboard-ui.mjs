#!/usr/bin/env node
/*
 * Seeds the "Dashboard UI" project: creates the project, repository, and a
 * dependency-ordered task plan that builds the project-dashboard control surface
 * (typed API client + shared layout + 7 views). This is the harder, real-output
 * coding benchmark. Idempotent (reuses existing project/repo/tasks).
 *
 * Env (defaults shown):
 *   DASH_BASE=<DASHBOARD_API_URL>
 *   REPO_DIR=<home>/code/dashboard-ui
 *   REPO_URL=<origin remote of REPO_DIR>
 *   PROJECT_SLUG=dashboard-ui
 *   PROJECT_NAME=Dashboard UI
 *   DEFAULT_BRANCH=main
 */

import "dotenv/config";
import { execSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

const DASH_BASE = (
  process.env.DASH_BASE || process.env.DASHBOARD_API_URL || "http://localhost:5402"
).replace(/\/$/, "");
const REPO_DIR = process.env.REPO_DIR || join(homedir(), "code", "dashboard-ui");
const PROJECT_SLUG = process.env.PROJECT_SLUG || "dashboard-ui";
const PROJECT_NAME = process.env.PROJECT_NAME || "Dashboard UI";
const DEFAULT_BRANCH = process.env.DEFAULT_BRANCH || "main";
const REPO_URL =
  process.env.REPO_URL ||
  (() => {
    try {
      return execSync(`git -C "${REPO_DIR}" remote get-url origin`).toString().trim();
    } catch {
      return "";
    }
  })();

const SPEC = [
  { ref: "api-types", title: "Define dashboard API types in src/types.ts", priority: 100, deps: [] },
  { ref: "api-client", title: "Add typed API fetchers in src/api.ts", priority: 95, deps: ["api-types"] },
  { ref: "layout", title: "Build the app shell and navigation in src/components/Layout.tsx", priority: 90, deps: ["api-types"] },
  { ref: "projects-view", title: "Build the Projects list view in src/views/ProjectsView.tsx", priority: 85, deps: ["api-client", "layout"] },
  { ref: "project-detail", title: "Build the Project detail view in src/views/ProjectDetailView.tsx", priority: 80, deps: ["projects-view"] },
  { ref: "task-board", title: "Build the Task board in src/views/TaskBoardView.tsx", priority: 75, deps: ["project-detail"] },
  { ref: "run-timeline", title: "Build the Run timeline view in src/views/RunTimelineView.tsx", priority: 70, deps: ["api-client", "layout"] },
  { ref: "benchmark-matrix", title: "Build the Benchmark matrix view in src/views/BenchmarkMatrixView.tsx", priority: 65, deps: ["api-client", "layout"] },
  { ref: "capability-tiers", title: "Build the Capability tiers view in src/views/CapabilityTiersView.tsx", priority: 60, deps: ["benchmark-matrix"] },
  { ref: "home", title: "Build the Dashboard home overview and wire navigation in src/views/HomeView.tsx and src/App.tsx", priority: 10, deps: ["projects-view", "run-timeline", "benchmark-matrix", "capability-tiers", "task-board"] },
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
  if (!res.ok) throw new Error(`${init.method || "GET"} ${path} -> ${res.status}: ${text}`);
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
  if (!REPO_URL)
    throw new Error(
      `No repository URL. Create the Forgejo repo, push ${REPO_DIR}, then re-run (or set REPO_URL).`,
    );
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
    console.log(`  task ${id} (${s.ref}) open prio ${s.priority} deps [${deps.join(",")}]`);
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
