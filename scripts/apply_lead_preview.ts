import path from 'path';
import fs from 'fs/promises';
import { parseUnifiedDiffToEditSpec, applyEditOps } from '../src/fileops.js';
import { parseAgentEditsFromResponse } from '../src/workflows/helpers/agentResponseParser.js';

async function main() {
  const file = path.join(process.cwd(), 'scripts', 'lead_preview_current.txt');
  const txt = await fs.readFile(file, 'utf8');
  console.log('Preview length:', txt.length);

  const parseOutcome = await parseAgentEditsFromResponse(txt, {
    parseDiff: (diff: string) => parseUnifiedDiffToEditSpec(diff),
    maxDiffCandidates: 10,
  });

  const editSpec = (parseOutcome.editSpec && typeof parseOutcome.editSpec === 'object')
    ? parseOutcome.editSpec
    : { ops: [] };
  const ops = Array.isArray((editSpec as any).ops) ? (editSpec as any).ops : [];

  console.log('Parser source:', parseOutcome.source || 'none');
  console.log('Parsed ops count:', ops.length);
  if (!ops.length) {
    console.error('No ops parsed — aborting apply');
    if (parseOutcome.diffCandidates.length) {
      console.error('first diff candidate preview:', parseOutcome.diffCandidates[0]?.slice(0, 400));
    }
    if (parseOutcome.errors.length) {
      console.error('parser errors:', parseOutcome.errors);
    }
    process.exit(2);
  }

  try {
    const result = await applyEditOps(JSON.stringify(editSpec), {
      repoRoot: process.cwd(),
      branchName: 'feat/agent-test-apply',
      commitMessage: 'test: apply lead preview'
    });
    console.log('applyEditOps result:', result);
  } catch (err) {
    console.error('applyEditOps failed:', err);
    process.exitCode = 3;
  }
}

main();
