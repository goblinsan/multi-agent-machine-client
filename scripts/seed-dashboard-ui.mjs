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

/*
 * Capability-fitting plan for the local 14B (see project_14b_capability_ceiling).
 * Each view is ONE self-contained file whose only local import is `apiGet` from
 * "../api", spelled out verbatim, with the data shape declared inline - so the
 * model never has to derive the module graph (its measured failure mode). Run the
 * descriptions through the dashboard's POST /plans/evaluate: every task reports
 * verdict "fits".
 */
function viewDesc(file, endpoint, shapeName, shapeBody, render) {
  return [
    `Create ONE self-contained file: ${file}. Do not create or modify any other file.`,
    `Use EXACTLY these imports and no other local imports:`,
    `  import { useEffect, useState } from "react";`,
    `  import { apiGet } from "../api";`,
    `Do NOT import from "../types" or any other view; declare the shape inline:`,
    `  type ${shapeName} = ${shapeBody};`,
    `apiGet is generic: apiGet<T>(path) resolves to { data: T; error?: string }.`,
    `The dashboard wraps lists as { data: [...] }, so read res.data.data.`,
    `On mount, fetch inside useEffect and ALWAYS handle failure so no promise rejection is left unhandled:`,
    `  apiGet<{ data: ${shapeName}[] }>("${endpoint}").then((r) => setRows(r.data.data ?? [])).catch(() => setRows([]));`,
    `Hold rows with useState<${shapeName}[]>([]). ${render}`,
    `Export it as a named export (export function ...). No default export. Keep everything in this one file.`,
  ].join("\n");
}

const SPEC = [
  { ref: "api-types", title: "Define dashboard API types in src/types.ts", priority: 100, deps: [] },
  { ref: "api-client", title: "Add typed API fetchers in src/api.ts", priority: 95, deps: ["api-types"] },
  { ref: "layout", title: "Build the app shell and navigation in src/components/Layout.tsx", priority: 90, deps: ["api-types"] },
  { ref: "projects-view", title: "Build the Projects list view in src/views/ProjectsView.tsx", priority: 85, deps: ["api-client", "layout"],
    desc: viewDesc("src/views/ProjectsView.tsx", "/projects", "Project", "{ id: number; name: string; slug: string; status?: string }", "Render an unordered list of each project's name and slug.") },
  { ref: "project-detail", title: "Build the Project detail view in src/views/ProjectDetailView.tsx", priority: 80, deps: ["projects-view"],
    desc: viewDesc("src/views/ProjectDetailView.tsx", "/projects", "Project", "{ id: number; name: string; slug: string; status?: string }", "Render a table of every project's id, name, slug and status.") },
  { ref: "task-board", title: "Build the Task board in src/views/TaskBoardView.tsx", priority: 75, deps: ["project-detail"],
    desc: viewDesc("src/views/TaskBoardView.tsx", "/projects/1/tasks", "Task", "{ id: number; title: string; status: string }", "Group rows by status and render each group's titles under a status heading.") },
  { ref: "run-timeline", title: "Build the Run timeline view in src/views/RunTimelineView.tsx", priority: 70, deps: ["api-client", "layout"],
    desc: viewDesc("src/views/RunTimelineView.tsx", "/runs", "Run", "{ id: number; status: string; started_at?: string }", "Render each run as a row showing id, status and started_at, newest first.") },
  { ref: "benchmark-matrix", title: "Build the Benchmark matrix view in src/views/BenchmarkMatrixView.tsx", priority: 65, deps: ["api-client", "layout"],
    desc: viewDesc("src/views/BenchmarkMatrixView.tsx", "/benchmark-results", "BenchmarkResult", "{ id: number; workflow_type: string; model_id: string; pass: boolean }", "Render a table with columns workflow_type, model_id and pass.") },
  { ref: "capability-tiers", title: "Build the Capability tiers view in src/views/CapabilityTiersView.tsx", priority: 60, deps: ["benchmark-matrix"],
    desc: viewDesc("src/views/CapabilityTiersView.tsx", "/capability-tiers", "CapabilityTier", "{ id: number; workflow_type: string; verdict: string; achieved_tier: number | null }", "Render a table with columns workflow_type, verdict and achieved_tier.") },
  { ref: "home", title: "Build the Dashboard home overview in src/views/HomeView.tsx", priority: 10, deps: ["layout"],
    desc: viewDesc("src/views/HomeView.tsx", "/projects", "Project", "{ id: number; name: string }", "Render a heading 'Dashboard' and a paragraph stating how many projects exist (rows.length).") },
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
  const statusByTitle = new Map(existing.map((t) => [t.title, t.status]));
  const toCreate = SPEC.filter((s) => !idByTitle.has(s.title)).map((s) => ({
    title: s.title,
    description: s.desc || undefined,
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
    const isDone = statusByTitle.get(s.title) === "done";
    const body = isDone
      ? { description: s.desc || null }
      : {
          status: "open",
          description: s.desc || null,
          priority_score: s.priority,
          blocked_dependencies: deps,
          claimed_by: null,
          claimed_at: null,
        };
    await dash(`/projects/${projectId}/tasks/${id}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    });
    console.log(
      `  task ${id} (${s.ref}) ${isDone ? "done (kept, desc updated)" : `open prio ${s.priority} deps [${deps.join(",")}]`}`,
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
