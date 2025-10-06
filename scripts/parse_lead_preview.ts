import fs from 'fs/promises';
import path from 'path';
import { parseUnifiedDiffToEditSpec } from '../src/fileops.js';

async function main() {
  const file = path.join(process.cwd(), 'scripts', 'lead_preview.txt');
  const txt = await fs.readFile(file, 'utf8');
  console.log('--- input preview ---');
  console.log(txt.slice(0, 400));
  console.log('--- end preview ---');
  try {
    // Replicate parser preprocessing for debugging
    let raw = String(txt);
    const rawDiffIdx = raw.indexOf('diff --git');
    console.log('rawDiffIdx:', rawDiffIdx);
    // Log all occurrences of 'diff --git'
    const diffs: number[] = [];
    let pos = raw.indexOf('diff --git');
    while (pos >= 0) {
      diffs.push(pos);
      pos = raw.indexOf('diff --git', pos + 1);
    }
    console.log('diff occurrences:', diffs.length, diffs);
    for (const d of diffs) {
      console.log('occurrence at', d, 'preview:', raw.slice(Math.max(0,d-40), d+80));
    }
    if (rawDiffIdx >= 0) raw = raw.slice(rawDiffIdx);
    const fenced = /```(?:diff)?\n([\s\S]*?)```/.exec(raw);
    console.log('fenced?', !!(fenced && fenced[1]));
    if (fenced && fenced[1]) raw = fenced[1];
    const pre = /<pre[^>]*>([\s\S]*?)<\/pre>/.exec(raw);
    console.log('pre?', !!(pre && pre[1]));
    if (pre && pre[1]) raw = pre[1];
    const firstIdx = raw.search(/(^|\n)(diff --git |@@ |\+\+\+ b\/)/);
    console.log('firstIdx after search:', firstIdx);
    if (firstIdx >= 0) raw = raw.slice(firstIdx);
    const fileSections = raw.split(/\n(?=diff --git )/);
    console.log('fileSections.length:', fileSections.length);
    console.log('first section preview:\n', fileSections[0].slice(0,400));
    const spec = parseUnifiedDiffToEditSpec(txt);
    console.log('Parsed edit spec:');
    console.log(JSON.stringify(spec, null, 2));
  } catch (err) {
    console.error('Parser threw:', err);
    process.exitCode = 2;
  }
}

main();
