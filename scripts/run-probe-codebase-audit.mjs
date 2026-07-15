#!/usr/bin/env node
/*
 * Codebase-audit capability probe. Sends a fixture codebase with a known set of
 * seeded concerns to a model, asks it to identify concerns, scores its findings
 * against the ground truth (precision/recall/F1 by file + category), and posts a
 * benchmark_result to the dashboard (workflow_type=codebase-audit).
 *
 * This is the first standalone probe: single-shot, no coordinator, no lock.
 *
 * Usage:
 *   MODEL_ID=<label> PROBE_ENDPOINT=http://host:port PROBE_MODEL=<api-model> \
 *     node scripts/run-probe-codebase-audit.mjs
 *   node scripts/run-probe-codebase-audit.mjs --findings=<file.json>   (skip the model)
 *
 * Env (defaults shown):
 *   DASH_BASE=<DASHBOARD_API_URL>
 *   MODEL_ID=<--model= arg>              label recorded on the result
 *   PROBE_ENDPOINT=<--endpoint= arg>     OpenAI-compatible model host
 *   PROBE_MODEL=<MODEL_ID>               model name the API expects
 *   ACCEPT_F1=0.5                        F1 at or above this counts as pass
 *   FIXTURE=<repo>/probes/codebase-audit
 *   RUN_TAG=<--tag= arg>                 optional; sets an idempotent external_id
 */

import "dotenv/config";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const arg = (name) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split("=").slice(1).join("=") : null;
};

const DASH_BASE = (
  process.env.DASH_BASE ||
  process.env.DASHBOARD_API_URL ||
  "http://localhost:3000"
).replace(/\/$/, "");
const MODEL_ID = process.env.MODEL_ID || arg("model");
const PROBE_ENDPOINT = (process.env.PROBE_ENDPOINT || arg("endpoint") || "").replace(/\/$/, "");
const PROBE_MODEL = process.env.PROBE_MODEL || arg("probe-model") || MODEL_ID;
const ACCEPT_F1 = Number(process.env.ACCEPT_F1 || arg("accept-f1") || 0.5);
const FIXTURE = process.env.FIXTURE || join(HERE, "..", "probes", "codebase-audit");
const NODE_ID = process.env.NODE_ID || null;
const RUN_TAG = process.env.RUN_TAG || arg("tag");
const FINDINGS_FILE = arg("findings");

const TAXONOMY = [
  "security",
  "null-safety",
  "correctness",
  "error-handling",
  "resource-leak",
  "performance",
];

const SYNONYMS = {
  "sql injection": "security",
  injection: "security",
  vulnerability: "security",
  "hardcoded secret": "security",
  "hardcoded credential": "security",
  "null pointer": "null-safety",
  "null reference": "null-safety",
  "undefined access": "null-safety",
  "off-by-one": "correctness",
  "logic error": "correctness",
  "logic bug": "correctness",
  bug: "correctness",
  "exception handling": "error-handling",
  "unhandled error": "error-handling",
  "unhandled exception": "error-handling",
  "unhandled rejection": "error-handling",
  "memory leak": "resource-leak",
  "connection leak": "resource-leak",
  leak: "resource-leak",
};

const base = (f) => String(f || "").split("/").pop();

function normCat(raw) {
  const s = String(raw || "").toLowerCase().trim();
  if (SYNONYMS[s]) return SYNONYMS[s];
  const h = s.replace(/[ _]+/g, "-");
  if (TAXONOMY.includes(h)) return h;
  for (const k of TAXONOMY) if (h.includes(k) || k.includes(h)) return k;
  for (const [phrase, cat] of Object.entries(SYNONYMS))
    if (s.includes(phrase)) return cat;
  return h;
}

function listFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...listFiles(p));
    else out.push(p);
  }
  return out;
}

function loadFixture() {
  const ground = JSON.parse(readFileSync(join(FIXTURE, "concerns.json"), "utf8"));
  const root = join(FIXTURE, "fixture");
  const files = listFiles(root).map((abs) => ({
    path: relative(root, abs).split("\\").join("/"),
    content: readFileSync(abs, "utf8"),
  }));
  return { ground, files };
}

function buildPrompt(files) {
  const body = files
    .map((f) => `--- FILE: ${f.path} ---\n${f.content}`)
    .join("\n\n");
  return (
    `Audit the following source files for concerns.\n` +
    `Respond with ONLY a JSON array; each item {"file","line","category","note"}.\n` +
    `Use category from EXACTLY this list: ${TAXONOMY.join(", ")}.\n` +
    `Report each distinct concern once.\n\n${body}`
  );
}

function extractFindings(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : text;
  try {
    const parsed = JSON.parse(candidate);
    if (Array.isArray(parsed)) return parsed;
    if (Array.isArray(parsed.concerns)) return parsed.concerns;
    if (Array.isArray(parsed.findings)) return parsed.findings;
  } catch {}
  const start = candidate.indexOf("[");
  const end = candidate.lastIndexOf("]");
  if (start !== -1 && end > start) {
    try {
      const parsed = JSON.parse(candidate.slice(start, end + 1));
      if (Array.isArray(parsed)) return parsed;
    } catch {}
  }
  return [];
}

async function callModel(prompt) {
  if (!PROBE_ENDPOINT)
    throw new Error("PROBE_ENDPOINT required (or use --findings=<file>)");
  const res = await fetch(`${PROBE_ENDPOINT}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: PROBE_MODEL,
      temperature: 0.1,
      max_tokens: 2000,
      messages: [
        { role: "system", content: "You are a precise code auditor." },
        { role: "user", content: prompt },
      ],
    }),
  });
  if (!res.ok) throw new Error(`model call -> ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data.choices?.[0]?.message?.content || "";
}

function score(ground, findings) {
  const concerns = ground.concerns.map((c) => ({
    key: `${base(c.file)}::${normCat(c.category)}`,
    file: c.file,
    category: c.category,
    matched: false,
  }));
  const seenFinding = new Set();
  let tp = 0;
  const falsePositives = [];
  for (const f of findings) {
    const key = `${base(f.file)}::${normCat(f.category)}`;
    if (seenFinding.has(key)) continue;
    seenFinding.add(key);
    const hit = concerns.find((c) => c.key === key && !c.matched);
    if (hit) {
      hit.matched = true;
      tp++;
    } else {
      falsePositives.push({ file: base(f.file), category: normCat(f.category) });
    }
  }
  const fp = falsePositives.length;
  const missed = concerns
    .filter((c) => !c.matched)
    .map((c) => ({ file: base(c.file), category: normCat(c.category) }));
  const fn = missed.length;
  const precision = tp + fp > 0 ? tp / (tp + fp) : 0;
  const recall = tp + fn > 0 ? tp / (tp + fn) : 0;
  const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;
  return { tp, fp, fn, precision, recall, f1, missed, falsePositives };
}

async function main() {
  if (!MODEL_ID) throw new Error("MODEL_ID required (set MODEL_ID or --model=)");
  const { ground, files } = loadFixture();

  let findings;
  if (FINDINGS_FILE) {
    findings = JSON.parse(readFileSync(FINDINGS_FILE, "utf8"));
    console.log(`Using findings from ${FINDINGS_FILE} (${findings.length})`);
  } else {
    const content = await callModel(buildPrompt(files));
    findings = extractFindings(content);
    console.log(`Model returned ${findings.length} finding(s)`);
  }

  const s = score(ground, findings);
  const pass = s.f1 >= ACCEPT_F1;
  console.log(
    `  precision=${s.precision.toFixed(2)} recall=${s.recall.toFixed(2)} f1=${s.f1.toFixed(2)} (tp=${s.tp} fp=${s.fp} fn=${s.fn}) -> ${pass ? "PASS" : "FAIL"}`,
  );
  if (s.missed.length)
    console.log(`  missed: ${s.missed.map((m) => `${m.file}:${m.category}`).join(", ")}`);

  const body = {
    benchmark_suite: "codebase-audit",
    benchmark_case: "fixture-v1",
    scope: "workflow",
    workflow_type: "codebase-audit",
    model_id: MODEL_ID,
    node_id: NODE_ID,
    pass,
    metrics: {
      precision: s.precision,
      recall: s.recall,
      f1: s.f1,
      tp: s.tp,
      fp: s.fp,
      fn: s.fn,
      concern_count: ground.concerns.length,
    },
    score: { missed: s.missed, false_positives: s.falsePositives },
    ...(RUN_TAG
      ? { external_id: `codebase-audit:fixture-v1:${MODEL_ID}:${RUN_TAG}` }
      : {}),
  };

  const res = await fetch(`${DASH_BASE}/benchmark-results`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`post result -> ${res.status}: ${await res.text()}`);
  console.log(
    `\nRecorded codebase-audit for ${MODEL_ID}: pass=${pass} f1=${s.f1.toFixed(2)} -> ${res.status}`,
  );
}

main().catch((err) => {
  console.error(`\nProbe failed: ${err.message}`);
  process.exit(1);
});
