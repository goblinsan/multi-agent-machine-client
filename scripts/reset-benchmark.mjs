#!/usr/bin/env node
/*
 * Resets the Todo Web Benchmark for a fresh workflow run, per measurement tier.
 *
 * Usage: node reset-benchmark.mjs <tier>   where tier is core | ui | all (default core)
 *
 *   core  Reliable pure-logic baseline. main -> empty seed; core tasks reopened,
 *         ui tasks archived so the run stays isolated to the core tier.
 *   ui    React stretch tier from a core-complete base. main -> ui-seed; core
 *         tasks marked done (so dependencies resolve), ui tasks reopened.
 *   all   Full pipeline from the empty seed; every task reopened.
 *
 * The coordinator re-aligns the base branch to origin on each run, so the reset
 * force-pushes main to the tier baseline and prunes stale remote branches.
 * Set DRY_RUN=1 to preview every action without mutating git or the dashboard.
 *
 * Env (defaults shown):
 *   REPO_DIR=<home>/code/todo-web-benchmark
 *   DASH_BASE=http://localhost:3000
 *   PROJECT_SLUG=todo-web-benchmark
 *   SEED_REF=seed            (core/all baseline; falls back to the root commit)
 *   UI_SEED_REF=ui-seed      (ui baseline)
 *   DRY_RUN=0
 */

import "dotenv/config";
import { execSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

const TIER = (process.argv[2] || "core").toLowerCase();
if (!["core", "ui", "all"].includes(TIER)) {
  console.error(`Unknown tier '${TIER}'. Use one of: core, ui, all`);
  process.exit(1);
}

const REPO_DIR = process.env.REPO_DIR || join(homedir(), "code", "todo-web-benchmark");
const DASH_BASE = (process.env.DASH_BASE || process.env.DASHBOARD_API_URL || "http://localhost:3000").replace(/\/$/, "");
const PROJECT_SLUG = process.env.PROJECT_SLUG || "todo-web-benchmark";
const SEED_REF = process.env.SEED_REF || "seed";
const UI_SEED_REF = process.env.UI_SEED_REF || "ui-seed";
const DRY = /^(1|true|yes)$/i.test(process.env.DRY_RUN || "");

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

const GIT_WRITE = /^(checkout|reset|push|clean|branch|merge|commit|tag|rm)\b/;

function git(args, { allowFail = false } = {}) {
  if (DRY && GIT_WRITE.test(args)) { console.log(`  [dry] git ${args}`); return ""; }
  try {
    return execSync(`git ${args}`, { cwd: REPO_DIR, stdio: ["ignore", "pipe", "pipe"] }).toString().trim();
  } catch (err) {
    if (allowFail) return "";
    throw err;
  }
}

function resolveBaseline() {
  const ref = TIER === "ui" ? UI_SEED_REF : SEED_REF;
  const sha = git(`rev-parse --verify --quiet ${ref}^{commit}`, { allowFail: true });
  if (sha) return { ref, sha };
  if (TIER === "ui") throw new Error(`ui tier requires the '${UI_SEED_REF}' commit; run the core tier first or create it`);
  const roots = git("rev-list --max-parents=0 HEAD").split(/\r?\n/).filter(Boolean);
  return { ref: "root", sha: roots[roots.length - 1] };
}

function resetGit() {
  const { ref, sha } = resolveBaseline();
  git("fetch origin", { allowFail: true });
  git("checkout -f main");
  git(`reset --hard ${sha || ref}`);
  git("push --force origin main");

  const localBranches = git("for-each-ref --format='%(refname:short)' refs/heads/")
    .split(/\r?\n/).map((b) => b.trim()).filter((b) => b && b !== "main");
  for (const b of localBranches) git(`branch -D ${b}`, { allowFail: true });

  const remoteHeads = git("ls-remote --heads origin", { allowFail: true })
    .split(/\r?\n/).map((line) => line.split(/\s+/)[1]).filter(Boolean)
    .map((ref) => ref.replace("refs/heads/", ""))
    .filter((b) => b && b !== "main");
  for (const b of remoteHeads) git(`push origin --delete ${b}`, { allowFail: true });

  git("clean -fd");
  console.log(`git: main -> ${ref} (${(sha || "").slice(0, 10)}), pruned ${localBranches.length} local / ${remoteHeads.length} remote branch(es)`);
}

async function dash(path, init = {}) {
  if (DRY && init.method && init.method !== "GET") {
    console.log(`  [dry] ${init.method} ${path} ${init.body || ""}`);
    return null;
  }
  const res = await fetch(`${DASH_BASE}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init.headers || {}) },
  });
  const text = await res.text();
  let body;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  if (!res.ok) throw new Error(`${init.method || "GET"} ${path} -> ${res.status}: ${text}`);
  return body;
}

function desiredStatus(task) {
  if (TIER === "all") return "open";
  if (TIER === "core") return task.tier === "core" ? "open" : "archived";
  return task.tier === "core" ? "done" : "open";
}

async function resetTasks() {
  const projects = (await dash("/projects")).data || [];
  const project = projects.find((p) => p.slug === PROJECT_SLUG);
  if (!project) throw new Error(`Project '${PROJECT_SLUG}' not found`);

  const tasks = (await dash(`/projects/${project.id}/tasks`)).data || [];
  const idByTitle = new Map(tasks.map((t) => [t.title, t.id]));
  const missing = SPEC.filter((s) => !idByTitle.has(s.title)).map((s) => s.ref);
  if (missing.length) throw new Error(`Tasks missing from project: ${missing.join(", ")}`);

  const ordered = [...SPEC].sort((a) => (a.tier === "core" ? -1 : 1));
  for (const s of ordered) {
    const id = idByTitle.get(s.title);
    const status = desiredStatus(s);
    const body = { status, claimed_by: null, claimed_at: null };
    if (status === "open") {
      body.priority_score = s.priority;
      body.blocked_dependencies = s.deps.map((ref) =>
        String(idByTitle.get(SPEC.find((x) => x.ref === ref).title)));
    }
    await dash(`/projects/${project.id}/tasks/${id}`, { method: "PATCH", body: JSON.stringify(body) });
    console.log(`  task ${id} (${s.ref}, ${s.tier}) -> ${status}${status === "open" ? ` prio ${s.priority} deps [${body.blocked_dependencies.join(",")}]` : ""}`);
  }
  return project.id;
}

async function main() {
  console.log(`Resetting benchmark tier '${TIER}'${DRY ? " (dry run)" : ""} at ${REPO_DIR}`);
  resetGit();
  const projectId = await resetTasks();
  const runnable = SPEC.filter((s) => desiredStatus(s) === "open").length;
  console.log(`\nDone. Project ${projectId}: ${runnable} task(s) runnable for the '${TIER}' tier.`);
}

main().catch((err) => {
  console.error(`\nReset failed: ${err.message}`);
  process.exit(1);
});
