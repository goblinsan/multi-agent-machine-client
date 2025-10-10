import path from 'path';
import fs from 'fs/promises';
import { applyEditOps, parseUnifiedDiffToEditSpec } from '../src/fileops.js';
import { parseAgentEditsFromResponse } from '../src/workflows/helpers/agentResponseParser.js';

// Harness: run the coordinator fallback parse/apply path directly using the
// saved lead preview. Avoid monkey-patching ESM module namespaces.
async function main() {
  const repoRoot = process.cwd();
  const previewPath = path.join(repoRoot, 'scripts', 'lead_preview_current.txt');
  const preview = await fs.readFile(previewPath, 'utf8');

  try {
    console.log('Invoking coordinator fallback parse/apply directly using saved preview');
    const parseOutcome = await parseAgentEditsFromResponse(preview, {
      parseDiff: (diff: string) => parseUnifiedDiffToEditSpec(diff),
      maxDiffCandidates: 10,
    });

    const editSpec = (parseOutcome.editSpec && typeof parseOutcome.editSpec === 'object')
      ? parseOutcome.editSpec
      : { ops: [] };
    const ops = Array.isArray((editSpec as any).ops) ? (editSpec as any).ops : [];
    console.log('Parser source:', parseOutcome.source || 'none');
    console.log('Parsed ops count:', ops.length);

    if (ops.length === 0) {
      console.log('No ops parsed from preview; nothing to apply');
      return;
    }

    const res = await applyEditOps(JSON.stringify(editSpec), {
      repoRoot,
      branchName: 'handleCoordinator-sim',
      commitMessage: 'sim: handleCoordinator apply',
    });
    console.log('Direct apply result:', res);
  } catch (err) {
    console.error('Fallback parse/apply failed:', err);
  }
}

main().catch(e => {
  console.error('Run harness failed:', e);
  process.exit(2);
});
