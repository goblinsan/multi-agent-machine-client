import fs from 'fs/promises';
import path from 'path';
import { parseUnifiedDiffToEditSpec } from '../src/fileops.js';
import { parseAgentEditsFromResponse } from '../src/workflows/helpers/agentResponseParser.js';

async function main() {
  const file = path.join(process.cwd(), 'scripts', 'lead_preview.txt');
  const txt = await fs.readFile(file, 'utf8');
  console.log('--- input preview ---');
  console.log(txt.slice(0, 400));
  console.log('--- end preview ---');

  const parseOutcome = await parseAgentEditsFromResponse(txt, {
    parseDiff: (diff: string) => parseUnifiedDiffToEditSpec(diff),
    maxDiffCandidates: 10,
  });

  console.log('Parser source:', parseOutcome.source || 'none');
  console.log('Structured candidate path:', parseOutcome.structuredCandidate?.path || []);
  console.log('Structured ops count:', parseOutcome.structuredCandidate?.ops.length || 0);
  console.log('Diff candidates:', parseOutcome.diffCandidates.length);
  parseOutcome.diffCandidates.forEach((candidate, idx) => {
    console.log(`candidate[${idx}] preview:`, candidate.slice(0, 160));
  });
  if (parseOutcome.errors.length) {
    console.log('Parsing errors:', parseOutcome.errors);
  }

  const editSpec = (parseOutcome.editSpec && typeof parseOutcome.editSpec === 'object')
    ? parseOutcome.editSpec
    : { ops: [] };
  const ops = Array.isArray((editSpec as any).ops) ? (editSpec as any).ops : [];
  console.log('Parsed ops count:', ops.length);
  if (ops.length) {
    console.log('First op:', editSpec.ops?.[0]);
  }
}

main();
