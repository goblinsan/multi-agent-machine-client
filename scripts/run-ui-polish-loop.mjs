#!/usr/bin/env node
/*
 * UI polish loop driver. Renders the app, runs the design-quality probe with
 * the render-floor report, and converts failing review findings into dashboard
 * tasks for the coordinator.
 *
 * This is intentionally one iteration: review -> task creation. The existing
 * coordinator then implements those tasks, after which this script can be run
 * again to re-render/re-score and create the next focused polish batch.
 *
 * Env/args:
 *   DASH_BASE=<dashboard URL>          falls back to DASHBOARD_API_URL
 *   PROJECT_SLUG=todo-web-benchmark
 *   REPO_DIR=<home>/code/todo-web-benchmark
 *   MODEL_ID=<model label>            required by run-probe-ui-design
 *   PROBE_ENDPOINT=<llm endpoint>      required unless --review=<file> used
 *   ACCEPT=0.7
 *   MAX_TASKS=5
 *   PORT=5173
 *   --review=<file.json>              replay a saved review, for testing
 *   --allow-incomplete-ui             do not require canonical UI tasks done
 *   --skip-build                      skip npm run build before render
 *   --no-create-tasks                 only render/review/score
 */

import "dotenv/config";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");

const arg = (name) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split("=").slice(1).join("=") : null;
};
const flag = (name) => process.argv.includes(`--${name}`);

const DASH_BASE = (
  process.env.DASH_BASE ||
  process.env.DASHBOARD_API_URL ||
  "http://localhost:3000"
).replace(/\/$/, "");
const PROJECT_SLUG = process.env.PROJECT_SLUG || arg("project") || "todo-web-benchmark";
const REPO_DIR = process.env.REPO_DIR || arg("repo") || join(homedir(), "code", "todo-web-benchmark");
const MODEL_ID = process.env.MODEL_ID || arg("model");
const ACCEPT = process.env.ACCEPT || arg("accept") || "0.7";
const MAX_TASKS = Number(process.env.MAX_TASKS || arg("max-tasks") || 5);
const PORT = Number(process.env.PORT || arg("port") || 5173);
const REVIEW_FILE = arg("review");
const ALLOW_INCOMPLETE_UI = flag("allow-incomplete-ui") || /^(1|true|yes)$/i.test(process.env.ALLOW_INCOMPLETE_UI || "");
const SKIP_BUILD = flag("skip-build") || /^(1|true|yes)$/i.test(process.env.SKIP_BUILD || "");
const CREATE_TASKS = !flag("no-create-tasks") && !/^(0|false|no)$/i.test(process.env.CREATE_TASKS || "1");
const CASE = process.env.CASE || arg("case") || "todo-web-polish";
const OUT_DIR = process.env.OUT_DIR || arg("out-dir") || join(ROOT, "probes", "ui-design", "polish-loop");

const UI_TASK_TITLES = new Set([
  "Add the useTodos hook in src/useTodos.ts",
  "Build the TodoItem component in src/components/TodoItem.tsx",
  "Build the AddTodoForm component in src/components/AddTodoForm.tsx",
  "Build the FilterBar component in src/components/FilterBar.tsx",
  "Compose the todo app in src/App.tsx",
]);

function run(command, args, options = {}) {
  const res = spawnSync(command, args, {
    stdio: options.stdio || "pipe",
    cwd: options.cwd,
    env: options.env || process.env,
    encoding: "utf8",
  });
  if (res.status !== 0) {
    const output = [res.stdout, res.stderr].filter(Boolean).join("\n");
    throw new Error(`${command} ${args.join(" ")} failed (${res.status})${output ? `:\n${output}` : ""}`);
  }
  return res.stdout || "";
}

async function dash(path, init = {}) {
  const res = await fetch(`${DASH_BASE}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init.headers || {}) },
  });
  const text = await res.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (!res.ok) throw new Error(`${init.method || "GET"} ${path} -> ${res.status}: ${text}`);
  return body;
}

async function projectBySlug() {
  const projects = (await dash("/projects")).data || [];
  const project = projects.find((p) => p.slug === PROJECT_SLUG);
  if (!project) throw new Error(`Project '${PROJECT_SLUG}' not found on ${DASH_BASE}`);
  return project;
}

async function assertUiComplete(projectId) {
  const tasks = (await dash(`/projects/${projectId}/tasks`)).data || [];
  const missingDone = [...UI_TASK_TITLES]
    .filter((title) => !tasks.some((t) => t.title === title && t.status === "done"))
    .map((title) => {
      const seen = tasks
        .filter((t) => t.title === title)
        .map((t) => `${t.id}:${t.status}`)
        .join(", ");
      return seen ? `${title} (${seen})` : `${title} (missing)`;
    });
  if (missingDone.length && !ALLOW_INCOMPLETE_UI) {
    throw new Error(
      `UI tier is not complete; refusing to create polish tasks yet.\n` +
        missingDone.map((x) => `  - ${x}`).join("\n") +
        `\nRun the UI tier first, or pass --allow-incomplete-ui for a diagnostic review.`,
    );
  }
}

async function waitForUrl(url, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  let last = "";
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
      last = `${res.status}`;
    } catch (err) {
      last = err instanceof Error ? err.message : String(err);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Timed out waiting for ${url}: ${last}`);
}

async function withDevServer(fn) {
  const url = `http://127.0.0.1:${PORT}`;
  const child = spawn("npm", ["run", "dev", "--", "--host", "127.0.0.1", "--port", String(PORT), "--strictPort"], {
    cwd: REPO_DIR,
    env: { ...process.env, BROWSER: "none" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  let exited = false;
  child.stdout.on("data", (b) => {
    output += b.toString();
  });
  child.stderr.on("data", (b) => {
    output += b.toString();
  });
  child.once("exit", () => {
    exited = true;
  });
  try {
    await waitForUrl(url);
    return await fn(url);
  } finally {
    if (!exited) {
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
    }
    if (process.env.DEBUG_POLISH_SERVER) console.log(output);
  }
}

function lowScoreNotes(report) {
  const scoreById = new Map((report.review?.scores || []).map((s) => [s.id, s]));
  const low = [];
  for (const [theme, value] of Object.entries(report.score?.perTheme || {})) {
    if (Number(value) < Number(ACCEPT)) {
      low.push(`Theme '${theme}' scored ${Math.round(Number(value) * 100)}%, below ${(Number(ACCEPT) * 100).toFixed(0)}%.`);
    }
  }
  for (const [id, item] of scoreById) {
    if (Number(item.score) < 2 && item.note) low.push(`${id}: ${item.note}`);
  }
  return low;
}

function taskFromFinding(projectId, finding, index, report) {
  const hash = createHash("sha1").update(`${CASE}:${finding}`).digest("hex").slice(0, 12);
  const titleText = finding.replace(/\s+/g, " ").trim();
  return {
    title: `Polish UI: ${titleText.slice(0, 110)}`,
    status: "open",
    priority_score: 65 - index,
    external_id: `ui-polish:${PROJECT_SLUG}:${CASE}:${hash}`,
    labels: ["ui-polish", "ui-design-quality", "auto-generated"],
    description:
      `Design polish task generated from the ui-design-quality loop for project ${projectId}.\n\n` +
      `Finding:\n${finding}\n\n` +
      `Current score:\n` +
      `- overall: ${Math.round((report.score?.overall || 0) * 100)}%\n` +
      `- accessibility: ${Math.round((report.score?.perTheme?.accessibility || 0) * 100)}%\n` +
      `- material3: ${Math.round((report.score?.perTheme?.material3 || 0) * 100)}%\n` +
      `- typography: ${Math.round((report.score?.perTheme?.typography || 0) * 100)}%\n\n` +
      `Acceptance:\n` +
      `- Improve the rendered UI without changing the todo app's intended behavior.\n` +
      `- Follow Material 3 roles/patterns and impeccable.style restraint: purposeful hierarchy, no decorative gradients/glassmorphism, no generated-output visual tropes.\n` +
      `- Preserve or improve axe-core accessibility results from the render floor.\n` +
      `- Keep implementation scoped to the UI files and relevant CSS.\n` +
      `- Re-run the UI design-quality loop after implementation.`,
  };
}

async function createPolishTasks(projectId, report) {
  const findings = [...(report.review?.findings || []), ...lowScoreNotes(report)]
    .map((x) => String(x).trim())
    .filter(Boolean);
  const unique = [...new Set(findings)].slice(0, MAX_TASKS);
  if (!unique.length) {
    console.log("No findings available to convert into polish tasks.");
    return null;
  }
  const tasks = unique.map((finding, index) => taskFromFinding(projectId, finding, index, report));
  const response = await dash(`/projects/${projectId}/tasks:bulk`, {
    method: "POST",
    body: JSON.stringify({ tasks }),
  });
  console.log(
    `Created ${response.summary.created} polish task(s), skipped ${response.summary.skipped || 0} duplicate(s).`,
  );
  for (const task of response.created || []) {
    console.log(`  created ${task.id}: ${task.title}`);
  }
  for (const skipped of response.skipped || []) {
    console.log(`  skipped ${skipped.task.id}: ${skipped.external_id}`);
  }
  return response;
}

async function main() {
  if (!MODEL_ID) throw new Error("MODEL_ID required (set MODEL_ID or --model=)");
  if (!existsSync(REPO_DIR)) throw new Error(`REPO_DIR not found: ${REPO_DIR}`);

  const project = await projectBySlug();
  await assertUiComplete(project.id);

  mkdirSync(OUT_DIR, { recursive: true });
  const renderReport = join(OUT_DIR, "render-report.json");
  const screenshot = join(OUT_DIR, "screenshots", "render.png");
  const designMd = join(OUT_DIR, "DESIGN.md");
  const designReport = join(OUT_DIR, "design-review.json");

  if (!SKIP_BUILD) {
    console.log(`Building ${relative(process.cwd(), REPO_DIR)} before render...`);
    run("npm", ["run", "build"], { cwd: REPO_DIR, stdio: "inherit" });
  }

  const report = await withDevServer(async (url) => {
    console.log(`Rendering ${url}...`);
    run("node", [
      join(HERE, "render-ui.mjs"),
      `--url=${url}`,
      `--out=${renderReport}`,
      `--shot=${screenshot}`,
    ], { cwd: ROOT, stdio: "inherit" });

    console.log("Running ui-design-quality probe...");
    const probeArgs = [
      join(HERE, "run-probe-ui-design.mjs"),
      `--target=${join(REPO_DIR, "src")}`,
      `--render-report=${renderReport}`,
      `--out=${designMd}`,
      `--report=${designReport}`,
      `--case=${CASE}`,
      `--accept=${ACCEPT}`,
    ];
    if (REVIEW_FILE) probeArgs.push(`--review=${REVIEW_FILE}`);
    run("node", probeArgs, { cwd: ROOT, stdio: "inherit" });
    return JSON.parse(readFileSync(designReport, "utf8"));
  });

  console.log(`Design score: ${Math.round(report.score.overall * 100)}% (${report.pass ? "PASS" : "FAIL"})`);
  if (!report.pass && CREATE_TASKS) {
    if (!Array.isArray(report.review?.scores) || report.review.scores.length === 0) {
      throw new Error(
        "ui-design-quality review produced no rubric scores; refusing to create generic polish tasks. " +
          "Inspect the design-review.json raw_response and rerun the probe.",
      );
    }
    await createPolishTasks(project.id, report);
  } else if (!report.pass) {
    console.log("Task creation disabled; no polish tasks created.");
  } else {
    console.log("Design score passed; no polish tasks created.");
  }

  console.log(`\nArtifacts:`);
  console.log(`  ${relative(process.cwd(), renderReport)}`);
  console.log(`  ${relative(process.cwd(), screenshot)}`);
  console.log(`  ${relative(process.cwd(), designMd)}`);
  console.log(`  ${relative(process.cwd(), designReport)}`);
}

main().catch((err) => {
  console.error(`\nPolish loop failed: ${err.message}`);
  process.exit(1);
});
