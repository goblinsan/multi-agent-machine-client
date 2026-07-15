#!/usr/bin/env node
/*
 * Ticket-routing capability probe (classification archetype). Sends a labeled
 * set of support tickets to a model, asks it to route each into one queue, and
 * scores accuracy against the labels. Posts a benchmark_result
 * (workflow_type=ticket-routing).
 *
 * Usage:
 *   MODEL_ID=<label> PROBE_ENDPOINT=http://host:port PROBE_MODEL=<api-model> \
 *     node scripts/run-probe-ticket-routing.mjs
 *   node scripts/run-probe-ticket-routing.mjs --predictions=<file.json>   (skip the model)
 *
 * Env (defaults shown):
 *   DASH_BASE=<DASHBOARD_API_URL>
 *   MODEL_ID=<--model= arg>
 *   PROBE_ENDPOINT=<--endpoint= arg>
 *   PROBE_MODEL=<MODEL_ID>
 *   ACCEPT_ACC=0.7                       accuracy at or above this counts as pass
 *   FIXTURE=<repo>/probes/ticket-routing/tickets.json
 *   RUN_TAG=<--tag= arg>                 optional idempotent external_id
 */

import "dotenv/config";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

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
const ACCEPT_ACC = Number(process.env.ACCEPT_ACC || arg("accept-acc") || 0.7);
const FIXTURE = process.env.FIXTURE || join(HERE, "..", "probes", "ticket-routing", "tickets.json");
const NODE_ID = process.env.NODE_ID || null;
const RUN_TAG = process.env.RUN_TAG || arg("tag");
const PREDICTIONS_FILE = arg("predictions");

function normQueue(raw, queues) {
  const s = String(raw || "").toLowerCase().trim();
  if (queues.includes(s)) return s;
  const map = {
    payment: "billing",
    payments: "billing",
    invoice: "billing",
    charges: "billing",
    "technical support": "technical",
    tech: "technical",
    support: "technical",
    bug: "technical",
    profile: "account",
    login: "account",
    password: "account",
    refunds: "refund",
    other: "general",
    info: "general",
    information: "general",
    misc: "general",
  };
  if (map[s]) return map[s];
  for (const q of queues) if (s.includes(q)) return q;
  return s;
}

function extractPredictions(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : text;
  const tryParse = (str) => {
    try {
      const p = JSON.parse(str);
      if (Array.isArray(p)) return p;
      if (Array.isArray(p.predictions)) return p.predictions;
      if (Array.isArray(p.tickets)) return p.tickets;
    } catch {}
    return null;
  };
  return (
    tryParse(candidate) ||
    (() => {
      const a = candidate.indexOf("[");
      const b = candidate.lastIndexOf("]");
      return a !== -1 && b > a ? tryParse(candidate.slice(a, b + 1)) : null;
    })() ||
    []
  );
}

async function callModel(prompt) {
  if (!PROBE_ENDPOINT)
    throw new Error("PROBE_ENDPOINT required (or use --predictions=<file>)");
  const res = await fetch(`${PROBE_ENDPOINT}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: PROBE_MODEL,
      temperature: 0,
      max_tokens: 1500,
      messages: [
        { role: "system", content: "You are a support-ticket router." },
        { role: "user", content: prompt },
      ],
    }),
  });
  if (!res.ok) throw new Error(`model call -> ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data.choices?.[0]?.message?.content || "";
}

function buildPrompt(tickets, queues) {
  const list = tickets.map((t) => `${t.id}: ${t.text}`).join("\n");
  return (
    `Route each support ticket into exactly one queue.\n` +
    `Queues: ${queues.join(", ")}.\n` +
    `Respond with ONLY a JSON array; each item {"id","queue"}.\n\n${list}`
  );
}

function score(fixture, predictions) {
  const queues = fixture.queues;
  const labelById = new Map(fixture.tickets.map((t) => [t.id, t.queue]));
  const predById = new Map(
    predictions.map((p) => [String(p.id), normQueue(p.queue, queues)]),
  );
  let correct = 0;
  const perClass = {};
  const mislabels = [];
  for (const q of queues) perClass[q] = { correct: 0, total: 0 };
  for (const t of fixture.tickets) {
    const truth = t.queue;
    const pred = predById.get(t.id) || "(none)";
    perClass[truth].total++;
    if (pred === truth) {
      correct++;
      perClass[truth].correct++;
    } else {
      mislabels.push({ id: t.id, truth, predicted: pred });
    }
  }
  const total = fixture.tickets.length;
  return { correct, total, accuracy: total > 0 ? correct / total : 0, perClass, mislabels };
}

async function main() {
  if (!MODEL_ID) throw new Error("MODEL_ID required (set MODEL_ID or --model=)");
  const fixture = JSON.parse(readFileSync(FIXTURE, "utf8"));

  let predictions;
  if (PREDICTIONS_FILE) {
    predictions = JSON.parse(readFileSync(PREDICTIONS_FILE, "utf8"));
    console.log(`Using predictions from ${PREDICTIONS_FILE} (${predictions.length})`);
  } else {
    const content = await callModel(buildPrompt(fixture.tickets, fixture.queues));
    predictions = extractPredictions(content);
    console.log(`Model returned ${predictions.length} prediction(s)`);
  }

  const s = score(fixture, predictions);
  const pass = s.accuracy >= ACCEPT_ACC;
  console.log(
    `  accuracy=${s.accuracy.toFixed(2)} (${s.correct}/${s.total}) -> ${pass ? "PASS" : "FAIL"}`,
  );
  if (s.mislabels.length)
    console.log(
      `  mislabeled: ${s.mislabels.map((m) => `${m.id}:${m.truth}->${m.predicted}`).join(", ")}`,
    );

  const body = {
    benchmark_suite: "ticket-routing",
    benchmark_case: "tickets-v1",
    scope: "workflow",
    workflow_type: "ticket-routing",
    model_id: MODEL_ID,
    node_id: NODE_ID,
    pass,
    metrics: {
      accuracy: s.accuracy,
      correct: s.correct,
      total: s.total,
      per_class: s.perClass,
    },
    score: { mislabels: s.mislabels },
    ...(RUN_TAG
      ? { external_id: `ticket-routing:tickets-v1:${MODEL_ID}:${RUN_TAG}` }
      : {}),
  };

  const res = await fetch(`${DASH_BASE}/benchmark-results`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`post result -> ${res.status}: ${await res.text()}`);
  console.log(
    `\nRecorded ticket-routing for ${MODEL_ID}: pass=${pass} accuracy=${s.accuracy.toFixed(2)} -> ${res.status}`,
  );
}

main().catch((err) => {
  console.error(`\nProbe failed: ${err.message}`);
  process.exit(1);
});
