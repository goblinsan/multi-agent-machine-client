import path from 'path';
import fs from 'fs/promises';
import { parseUnifiedDiffToEditSpec, applyEditOps } from '../src/fileops.js';

async function main() {
  const file = path.join(process.cwd(), 'scripts', 'lead_preview_current.txt');
  const txt = await fs.readFile(file, 'utf8');
  console.log('Preview length:', txt.length);
  const spec = parseUnifiedDiffToEditSpec(txt);
  console.log('Parsed ops count:', spec.ops.length);
  console.log(JSON.stringify(spec, null, 2).slice(0, 2000));
  if (!spec.ops.length) {
    console.error('No ops parsed — aborting apply');
    process.exit(2);
  }
  try {
    const result = await applyEditOps(JSON.stringify(spec), { repoRoot: process.cwd(), branchName: 'feat/agent-test-apply', commitMessage: 'test: apply lead preview' });
    console.log('applyEditOps result:', result);
  } catch (err) {
    console.error('applyEditOps failed:', err);
    process.exitCode = 3;
  }
}

main();
