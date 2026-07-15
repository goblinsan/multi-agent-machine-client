#!/usr/bin/env node
/*
 * Render floor for the UI design-quality flow. Renders a page in a headless
 * browser, captures a full-page screenshot, runs an axe-core accessibility
 * audit, and computes deterministic scores for the rubric criteria axe covers
 * (color-contrast, a11y-labels, a11y-semantics). Writes a render report that
 * run-probe-ui-design.mjs consumes via --render-report.
 *
 * Usage:
 *   node scripts/render-ui.mjs --file=probes/ui-design/fixture/index.html
 *   node scripts/render-ui.mjs --url=http://localhost:5173
 *
 * Env/args (defaults shown):
 *   OUT=<repo>/probes/ui-design/render-report.json
 *   SHOT=<repo>/probes/ui-design/screenshots/render.png
 */

import { chromium } from "playwright";
import { createRequire } from "node:module";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join, resolve, relative } from "node:path";

const require = createRequire(import.meta.url);
const HERE = dirname(fileURLToPath(import.meta.url));
const arg = (n) => {
  const h = process.argv.find((a) => a.startsWith(`--${n}=`));
  return h ? h.split("=").slice(1).join("=") : null;
};

const FILE = arg("file");
const URL_ARG = arg("url");
const OUT = arg("out") || join(HERE, "..", "probes", "ui-design", "render-report.json");
const SHOT = arg("shot") || join(HERE, "..", "probes", "ui-design", "screenshots", "render.png");

const RULE_MAP = {
  "color-contrast": ["color-contrast"],
  "a11y-labels": [
    "label",
    "image-alt",
    "input-image-alt",
    "aria-input-field-name",
    "select-name",
    "aria-command-name",
  ],
  "a11y-semantics": [
    "button-name",
    "link-name",
    "list",
    "listitem",
    "landmark-one-main",
    "region",
    "page-has-heading-one",
    "aria-required-children",
  ],
};

function scoreCriterion(violations, rules) {
  const relevant = violations.filter((v) => rules.includes(v.id));
  if (relevant.length === 0) return 2;
  const nodes = relevant.reduce((n, v) => n + (v.nodes || 0), 0);
  const critical = relevant.some((v) => v.impact === "critical" || v.impact === "serious");
  if (critical || nodes >= 3) return 0;
  return 1;
}

async function main() {
  if (!FILE && !URL_ARG) throw new Error("provide --file=<path> or --url=<url>");
  const target = URL_ARG || pathToFileURL(resolve(FILE)).href;

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 960, height: 800 } });
  await page.goto(target, { waitUntil: "networkidle", timeout: 30000 });

  mkdirSync(dirname(SHOT), { recursive: true });
  await page.screenshot({ path: SHOT, fullPage: true });

  await page.addScriptTag({ path: require.resolve("axe-core") });
  const results = await page.evaluate(async () => await window.axe.run());
  await browser.close();

  const violations = results.violations.map((v) => ({
    id: v.id,
    impact: v.impact,
    help: v.help,
    nodes: v.nodes.length,
  }));

  const criteria = {};
  for (const [crit, rules] of Object.entries(RULE_MAP)) {
    criteria[crit] = scoreCriterion(violations, rules);
  }

  const report = {
    source: target,
    screenshot: relative(join(HERE, ".."), SHOT),
    timestamp: new Date().toISOString(),
    axe: {
      violationCount: violations.length,
      passCount: results.passes.length,
      incompleteCount: results.incomplete.length,
      violations,
    },
    criteria,
  };
  writeFileSync(OUT, JSON.stringify(report, null, 2));

  console.log(`Rendered ${target}`);
  console.log(`  screenshot: ${report.screenshot}`);
  console.log(
    `  axe: ${violations.length} violation(s) [${violations.map((v) => v.id).join(", ") || "none"}], ${results.passes.length} passes`,
  );
  console.log(
    `  deterministic a11y criteria: ${Object.entries(criteria).map(([k, v]) => `${k}=${v}`).join("  ")}`,
  );
  console.log(`  wrote ${relative(process.cwd(), OUT)}`);
}

main().catch((err) => {
  console.error(`\nRender failed: ${err.message}`);
  process.exit(1);
});
