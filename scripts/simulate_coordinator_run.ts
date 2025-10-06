import fs from 'fs/promises';
import path from 'path';
import { parseUnifiedDiffToEditSpec, applyEditOps, writeDiagnostic } from '../src/fileops.js';

async function simulate() {
  const file = path.join(process.cwd(), 'scripts', 'lead_preview_current.txt');
  const txt = await fs.readFile(file, 'utf8');
  console.log('Simulating coordinator with preview length:', txt.length);

  // Coordinator-like normalization: look for fences, pre tags, etc.
  let raw = String(txt);
  const rawDiffIdx = raw.indexOf('diff --git');
  if (rawDiffIdx >= 0) raw = raw.slice(rawDiffIdx);
  const fenced = /```(?:diff)?\n([\s\S]*?)```/.exec(raw);
  if (fenced && fenced[1]) raw = fenced[1];
  const pre = /<pre[^>]*>([\s\S]*?)<\/pre>/.exec(raw);
  if (pre && pre[1]) raw = pre[1];
  const firstIdx = raw.search(/(^|\n)(diff --git |@@ |\+\+\+ b\/)/);
  if (firstIdx >= 0) raw = raw.slice(firstIdx);

  console.log('Pre-normalization preview slice:', raw.slice(0, 400));

  // Try parsing as coordinator does
  const parsed = parseUnifiedDiffToEditSpec(raw);
  console.log('Parsed ops count:', parsed.ops.length);
  console.log(JSON.stringify(parsed, null, 2).slice(0, 2000));

  if (!parsed.ops || parsed.ops.length === 0) {
    console.log('No ops parsed. Writing diagnostic and exiting.');
    await writeDiagnostic(process.cwd(), 'simulator-no-ops.json', { preview: raw.slice(0,2000) });
    return;
  }

  console.log('Attempting applyEditOps with branch coordinator-sim');
  try {
    const res = await applyEditOps(JSON.stringify(parsed), { repoRoot: process.cwd(), branchName: 'coordinator-sim', commitMessage: 'sim: coordinator apply' });
    console.log('applyEditOps result:', res);
  } catch (err) {
    console.error('applyEditOps threw:', err);
    await writeDiagnostic(process.cwd(), 'simulator-apply-exception.json', { error: String(err), parsed });
  }
}

simulate().catch(e => { console.error('Simulator failed:', e); process.exit(2); });
