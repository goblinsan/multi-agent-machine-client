#!/usr/bin/env node
/*
 * Resets the Todo Web Benchmark to its seed state for a fresh workflow run.
 *
 *   - git: checks out main, hard-resets to the seed commit, deletes every other
 *     local branch, and removes untracked non-ignored files (node_modules stays).
 *   - dashboard: reopens every task in the project, clears claim fields, and
 *     restores the original priorities and dependency edges.
 *
 * Keeps the project id stable so the coordinator can be pointed at it unchanged.
 *
 * Env (defaults shown):
 *   REPO_DIR=<home>/code/todo-web-benchmark
 *   DASH_BASE=http://localhost:3000
 *   PROJECT_SLUG=todo-web-benchmark
 *   SEED_REF=seed            (falls back to the repository root commit)
 *   RESET_REMOTE=true        (force-pushes main back to the seed state)
 */

import { execSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

const REPO_DIR =
  process.env.REPO_DIR || join(homedir(), "code", "todo-web-benchmark");
const DASH_BASE = (process.env.DASH_BASE || "http://localhost:3000").replace(
  /\/$/,
  "",
);
const PROJECT_SLUG = process.env.PROJECT_SLUG || "todo-web-benchmark";
const SEED_REF = process.env.SEED_REF || "seed";
const RESET_REMOTE = parseBool(process.env.RESET_REMOTE, true);

const SPEC = [
  {
    ref: "types",
    title: "Define the Todo domain types in src/types.ts",
    priority: 100,
    deps: [],
  },
  {
    ref: "reducer",
    title: "Implement the pure todo reducer in src/todoReducer.ts",
    priority: 90,
    deps: ["types"],
  },
  {
    ref: "selectors",
    title: "Implement view selectors in src/selectors.ts",
    priority: 90,
    deps: ["types"],
  },
  {
    ref: "hook",
    title: "Add the useTodos hook in src/useTodos.ts",
    priority: 80,
    deps: ["reducer"],
  },
  {
    ref: "todoitem",
    title: "Build the TodoItem component in src/components/TodoItem.tsx",
    priority: 70,
    deps: ["types"],
  },
  {
    ref: "addform",
    title: "Build the AddTodoForm component in src/components/AddTodoForm.tsx",
    priority: 70,
    deps: [],
  },
  {
    ref: "filterbar",
    title: "Build the FilterBar component in src/components/FilterBar.tsx",
    priority: 70,
    deps: ["types"],
  },
  {
    ref: "app",
    title: "Compose the todo app in src/App.tsx",
    priority: 10,
    deps: ["hook", "selectors", "todoitem", "addform", "filterbar"],
  },
];

function git(args) {
  return execSync(`git ${args}`, {
    cwd: REPO_DIR,
    stdio: ["ignore", "pipe", "pipe"],
  })
    .toString()
    .trim();
}

function parseBool(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(String(value).trim().toLowerCase());
}

function resolveSeed() {
  try {
    return git(`rev-parse --verify --quiet ${SEED_REF}^{commit}`);
  } catch {
    const roots = git("rev-list --max-parents=0 HEAD")
      .split(/\r?\n/)
      .filter(Boolean);
    return roots[roots.length - 1];
  }
}

function resetGit() {
  const seed = resolveSeed();
  if (!seed)
    throw new Error(`Could not resolve seed ref '${SEED_REF}' or a root commit`);
  git("checkout -f main");
  git(`reset --hard ${seed}`);
  const branches = git("for-each-ref --format='%(refname:short)' refs/heads/")
    .split(/\r?\n/)
    .map((b) => b.trim())
    .filter((b) => b && b !== "main");
  for (const branch of branches) git(`branch -D ${branch}`);
  git("clean -fd");
  let remoteReset = false;
  if (RESET_REMOTE) {
    const remotes = git("remote")
      .split(/\r?\n/)
      .map((r) => r.trim())
      .filter(Boolean);
    if (remotes.includes("origin")) {
      git("push --force-with-lease origin main");
      remoteReset = true;
    }
  }
  console.log(
    `git: main reset to seed ${seed.slice(0, 10)}, deleted ${branches.length} branch(es), ` +
      `remote ${remoteReset ? "reset" : "unchanged"}`,
  );
  return { seed, deletedBranches: branches };
}

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

async function resetTasks() {
  const projects = (await dash("/projects")).data || [];
  const project = projects.find((p) => p.slug === PROJECT_SLUG);
  if (!project) throw new Error(`Project '${PROJECT_SLUG}' not found`);

  const tasks = (await dash(`/projects/${project.id}/tasks`)).data || [];
  const idByTitle = new Map(tasks.map((t) => [t.title, t.id]));

  const missing = SPEC.filter((s) => !idByTitle.has(s.title)).map((s) => s.ref);
  if (missing.length) {
    throw new Error(`Tasks missing from project (was it provisioned?): ${missing.join(", ")}`);
  }

  for (const s of SPEC) {
    const id = idByTitle.get(s.title);
    const blocked = s.deps.map((ref) => {
      const dep = SPEC.find((x) => x.ref === ref);
      return String(idByTitle.get(dep.title));
    });
    await dash(`/projects/${project.id}/tasks/${id}`, {
      method: "PATCH",
      body: JSON.stringify({
        status: "open",
        priority_score: s.priority,
        claimed_by: null,
        claimed_at: null,
        blocked_dependencies: blocked,
      }),
    });
    console.log(
      `  task ${id} (${s.ref}) -> open, prio ${s.priority}, deps [${blocked.join(",")}]`,
    );
  }
  return { projectId: project.id, count: SPEC.length };
}

async function main() {
  console.log(`Resetting benchmark at ${REPO_DIR}`);
  resetGit();
  const { projectId, count } = await resetTasks();
  console.log(`\nDone. Project ${projectId}: ${count} tasks reopened. Ready for a fresh run.`);
}

main().catch((err) => {
  console.error(`\nReset failed: ${err.message}`);
  process.exit(1);
});
