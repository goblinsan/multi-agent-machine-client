import fs from 'fs/promises';
import path from 'path';
import { parseUnifiedDiffToEditSpec, applyEditOps, writeDiagnostic } from '../src/fileops.js';
import { parseAgentEditsFromResponse } from '../src/workflows/helpers/agentResponseParser.js';

async function simulate() {
  const file = path.join(process.cwd(), 'scripts', 'lead_preview_current.txt');
  const txt = await fs.readFile(file, 'utf8');
  console.log('Simulating coordinator with preview length:', txt.length);

  const parseOutcome = await parseAgentEditsFromResponse(txt, {
    parseDiff: (diff: string) => parseUnifiedDiffToEditSpec(diff),
    maxDiffCandidates: 10,
    logger: {
      debug: (msg, meta) => console.debug(msg, meta),
      warn: (msg, meta) => console.warn(msg, meta),
    },
  });

  const editSpec = (parseOutcome.editSpec && typeof parseOutcome.editSpec === 'object')
    ? parseOutcome.editSpec
    : { ops: [] };
  const ops = Array.isArray((editSpec as any).ops) ? (editSpec as any).ops : [];

  console.log('Parser source:', parseOutcome.source || 'none');
  console.log('Diff candidates:', parseOutcome.diffCandidates.length);
  if (parseOutcome.diffCandidates.length) {
    console.log('First candidate preview:', parseOutcome.diffCandidates[0]?.slice(0, 400));
  }
  console.log('Parsed ops count:', ops.length);

  if (!ops.length) {
    console.log('No ops parsed. Writing diagnostic and exiting.');
    await writeDiagnostic(process.cwd(), 'simulator-no-ops.json', {
      parseOutcome,
      preview: txt.slice(0, 2000),
    });
    return;
  }

  console.log('Attempting applyEditOps with branch coordinator-sim');
  try {
    const res = await applyEditOps(JSON.stringify(editSpec), {
      repoRoot: process.cwd(),
      branchName: 'coordinator-sim',
      commitMessage: 'sim: coordinator apply',
    });
    console.log('applyEditOps result:', res);
  } catch (err) {
    console.error('applyEditOps threw:', err);
    await writeDiagnostic(process.cwd(), 'simulator-apply-exception.json', {
      error: String(err),
      parseOutcome,
    });
  }
}

simulate().catch(e => {
  console.error('Simulator failed:', e);
  process.exit(2);
});
