#!/usr/bin/env node
/*
 * UI design-quality probe (judge archetype). Reviews a rendered-UI codebase
 * against a rubric derived from Material 3 + impeccable.style + WCAG AA, scores
 * each criterion 0-2, writes a DESIGN.md review, and posts a benchmark_result
 * (workflow_type=ui-design-quality).
 *
 * This is a Layer-2 judge probe: the score is the model's rubric assessment,
 * NOT ground truth. It needs calibration against human acceptance before the
 * verdict is trusted. It is the "review" step of the design-quality flow and the
 * measurement of design output.
 *
 * Usage:
 *   MODEL_ID=<label> PROBE_ENDPOINT=http://host:port PROBE_MODEL=<api-model> \
 *     TARGET=<home>/code/todo-web-benchmark/src \
 *     node scripts/run-probe-ui-design.mjs
 *   node scripts/run-probe-ui-design.mjs --review=<file.json>   (skip the model)
 *
 * Env (defaults shown):
 *   DASH_BASE=<DASHBOARD_API_URL>
 *   MODEL_ID / PROBE_ENDPOINT / PROBE_MODEL
 *   TARGET=<home>/code/todo-web-benchmark/src
 *   ACCEPT=0.7           overall score at or above this counts as pass
 *   CASE=todo-web-ui     benchmark_case label
 *   OUT=<repo>/probes/ui-design/last-review.md
 *   RUN_TAG / NODE_ID
 */

import "dotenv/config";
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";
import { homedir } from "node:os";

const HERE = dirname(fileURLToPath(import.meta.url));
const arg = (n) => {
  const h = process.argv.find((a) => a.startsWith(`--${n}=`));
  return h ? h.split("=").slice(1).join("=") : null;
};

const DASH_BASE = (process.env.DASH_BASE || process.env.DASHBOARD_API_URL || "http://localhost:3000").replace(/\/$/, "");
const MODEL_ID = process.env.MODEL_ID || arg("model");
const PROBE_ENDPOINT = (process.env.PROBE_ENDPOINT || arg("endpoint") || "").replace(/\/$/, "");
const PROBE_MODEL = process.env.PROBE_MODEL || arg("probe-model") || MODEL_ID;
const PROBE_MAX_TOKENS = Number(process.env.PROBE_MAX_TOKENS || arg("probe-max-tokens") || 6000);
const ACCEPT = Number(process.env.ACCEPT || arg("accept") || 0.7);
const TARGET = process.env.TARGET || arg("target") || join(homedir(), "code", "todo-web-benchmark", "src");
const CASE = process.env.CASE || arg("case") || "todo-web-ui";
const OUT = process.env.OUT || arg("out") || join(HERE, "..", "probes", "ui-design", "last-review.md");
const REPORT = process.env.REPORT || arg("report") || join(HERE, "..", "probes", "ui-design", "last-review.json");
const RUN_TAG = process.env.RUN_TAG || arg("tag");
const NODE_ID = process.env.NODE_ID || null;
const REVIEW_FILE = arg("review");
const RENDER_REPORT = arg("render-report");
const MAX_SRC = 24000;
const EXT = [".tsx", ".ts", ".jsx", ".js", ".css"];

const rubric = JSON.parse(readFileSync(join(HERE, "..", "probes", "ui-design", "rubric.json"), "utf8"));

function listFiles(dir) {
  const out = [];
  for (const e of readdirSync(dir)) {
    if (e === "node_modules" || e.startsWith(".")) continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) out.push(...listFiles(p));
    else if (EXT.includes(p.slice(p.lastIndexOf(".")))) out.push(p);
  }
  return out;
}

function loadSource() {
  const files = listFiles(TARGET);
  let budget = MAX_SRC;
  const parts = [];
  for (const abs of files) {
    const rel = relative(TARGET, abs).split("\\").join("/");
    const content = readFileSync(abs, "utf8");
    const block = `--- FILE: ${rel} ---\n${content}`;
    if (block.length > budget) {
      parts.push(block.slice(0, budget) + "\n... (truncated)");
      break;
    }
    parts.push(block);
    budget -= block.length;
  }
  return parts.join("\n\n");
}

function buildPrompt(source, render) {
  const list = rubric.criteria
    .map((c) => `${c.id} [${c.theme}]: ${c.criterion}`)
    .join("\n");
  let renderBlock = "";
  if (render) {
    const v = render.axe.violations
      .map((x) => `${x.id} (${x.impact}, ${x.nodes} node[s]): ${x.help}`)
      .join("\n");
    renderBlock =
      `\n\nRENDERED ACCESSIBILITY AUDIT (axe-core, ${render.axe.violationCount} violation[s]):\n` +
      `${v || "none"}\n` +
      `The a11y and contrast criteria are scored from this audit, not your guess; ` +
      `use it to inform the rest of your review.`;
  }
  return (
    `Review this web UI codebase for design quality against the rubric below.\n` +
    `Score EACH criterion 0 (fail), 1 (partial), or 2 (pass) with a one-line note.\n` +
    `Then list concrete findings and a one-paragraph summary.\n` +
    `Respond with ONLY valid minified JSON. Do not include markdown, prose, analysis, or <think> text.\n` +
    `Required schema: {"scores":[{"id":"criterion-id","score":0,"note":"one-line evidence"}],"findings":["concrete improvement"],"summary":"one paragraph"}.\n\n` +
    `RUBRIC:\n${list}${renderBlock}\n\nSOURCE:\n${source}`
  );
}

function extractReview(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const c = fenced ? fenced[1] : text;
  const tryP = (s) => { try { return JSON.parse(s); } catch { return null; } };
  let obj = tryP(c);
  if (!obj) {
    const a = c.indexOf("{"), b = c.lastIndexOf("}");
    if (a !== -1 && b > a) obj = tryP(c.slice(a, b + 1));
  }
  return obj || { scores: [], findings: [], summary: "" };
}

async function callModel(prompt) {
  if (!PROBE_ENDPOINT) throw new Error("PROBE_ENDPOINT required (or use --review=<file>)");
  const res = await fetch(`${PROBE_ENDPOINT}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: PROBE_MODEL,
      temperature: 0.2,
      max_tokens: PROBE_MAX_TOKENS,
      messages: [
        { role: "system", content: "You are an exacting UI design reviewer." },
        { role: "user", content: prompt },
      ],
    }),
  });
  if (!res.ok) throw new Error(`model call -> ${res.status}: ${await res.text()}`);
  return (await res.json()).choices?.[0]?.message?.content || "";
}

function scoreReview(review, renderCriteria) {
  const byId = new Map((review.scores || []).map((s) => [s.id, Math.max(0, Math.min(2, Number(s.score) || 0))]));
  const overridden = new Set();
  if (renderCriteria) {
    for (const [id, score] of Object.entries(renderCriteria)) {
      byId.set(id, Math.max(0, Math.min(2, Number(score))));
      overridden.add(id);
    }
  }
  const themes = {};
  let sum = 0;
  let covered = 0;
  for (const c of rubric.criteria) {
    const s = byId.has(c.id) ? byId.get(c.id) : 0;
    if (byId.has(c.id)) covered++;
    sum += s;
    themes[c.theme] = themes[c.theme] || { sum: 0, count: 0 };
    themes[c.theme].sum += s;
    themes[c.theme].count += 1;
  }
  const overall = sum / (2 * rubric.criteria.length);
  const perTheme = {};
  for (const [t, v] of Object.entries(themes)) perTheme[t] = v.sum / (2 * v.count);
  return { overall, perTheme, covered, total: rubric.criteria.length };
}

function writeDesignMd(review, s) {
  mkdirSync(dirname(OUT), { recursive: true });
  const lines = [
    `# Design review — ${MODEL_ID}`,
    ``,
    `Overall: ${(s.overall * 100).toFixed(0)}%  ·  criteria covered ${s.covered}/${s.total}`,
    ``,
    `## By theme`,
    ...Object.entries(s.perTheme).map(([t, v]) => `- ${t}: ${(v * 100).toFixed(0)}%`),
    ``,
    `## Summary`,
    review.summary || "(none)",
    ``,
    `## Findings`,
    ...(review.findings || []).map((f) => `- ${f}`),
  ];
  writeFileSync(OUT, lines.join("\n"));
}

function writeReport(review, s, pass, render, response) {
  mkdirSync(dirname(REPORT), { recursive: true });
  writeFileSync(
    REPORT,
    JSON.stringify(
      {
        model_id: MODEL_ID,
        benchmark_case: CASE,
        pass,
        accept_threshold: ACCEPT,
        score: s,
        review,
        render,
        dashboard_response: response,
        design_md: OUT,
        timestamp: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
}

async function main() {
  if (!MODEL_ID) throw new Error("MODEL_ID required (set MODEL_ID or --model=)");

  const render = RENDER_REPORT ? JSON.parse(readFileSync(RENDER_REPORT, "utf8")) : null;
  if (render)
    console.log(`Render report: ${render.axe.violationCount} axe violation(s), a11y criteria from render`);

  let review;
  let rawResponse = null;
  if (REVIEW_FILE) {
    review = JSON.parse(readFileSync(REVIEW_FILE, "utf8"));
    console.log(`Using review from ${REVIEW_FILE}`);
  } else {
    rawResponse = await callModel(buildPrompt(loadSource(), render));
    review = extractReview(rawResponse);
    console.log(`Model scored ${(review.scores || []).length} criteria`);
  }

  const s = scoreReview(review, render ? render.criteria : null);
  const pass = s.overall >= ACCEPT;
  console.log(`  overall=${(s.overall * 100).toFixed(0)}% covered=${s.covered}/${s.total} -> ${pass ? "PASS" : "FAIL"}`);
  console.log(`  ${Object.entries(s.perTheme).map(([t, v]) => `${t}:${(v * 100).toFixed(0)}%`).join("  ")}`);
  writeDesignMd(review, s);
  console.log(`  wrote ${relative(process.cwd(), OUT)}`);

  const body = {
    benchmark_suite: "ui-design-quality",
    benchmark_case: CASE,
    scope: "workflow",
    workflow_type: "ui-design-quality",
    model_id: MODEL_ID,
    node_id: NODE_ID,
    pass,
    metrics: {
      overall: s.overall,
      covered: s.covered,
      total: s.total,
      per_theme: s.perTheme,
      ...(render ? { axe_violations: render.axe.violationCount, rendered: true } : { rendered: false }),
    },
    score: {
      summary: review.summary,
      findings: (review.findings || []).slice(0, 20),
      ...(render ? { screenshot: render.screenshot, axe: render.axe.violations } : {}),
    },
    ...(RUN_TAG ? { external_id: `ui-design-quality:${CASE}:${MODEL_ID}:${RUN_TAG}` } : {}),
  };

  const res = await fetch(`${DASH_BASE}/benchmark-results`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const responseText = await res.text();
  let responseBody = null;
  try {
    responseBody = responseText ? JSON.parse(responseText) : null;
  } catch {
    responseBody = responseText;
  }
  if (!res.ok) throw new Error(`post result -> ${res.status}: ${responseText}`);
  writeReport({ ...review, raw_response: rawResponse }, s, pass, render, responseBody);
  console.log(`  wrote ${relative(process.cwd(), REPORT)}`);
  console.log(`\nRecorded ui-design-quality for ${MODEL_ID}: overall=${(s.overall * 100).toFixed(0)}% pass=${pass} -> ${res.status}`);
}

main().catch((err) => {
  console.error(`\nProbe failed: ${err.message}`);
  process.exit(1);
});
