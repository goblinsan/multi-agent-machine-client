import fs from 'fs';
import path from 'path';

async function main() {
  const coord = await import('../src/workflows/coordinator.js');
  const previewPath = path.join(process.cwd(), 'scripts', 'lead_preview_current.txt');
  const preview = await (await import('fs/promises')).readFile(previewPath, 'utf8');

  let parserCalled = false;
  let applyCalled = false;

  const overrides: any = {
    fetchProjectStatus: async () => ({ id: 'p' }),
    fetchProjectStatusDetails: async () => ({}),
    fetchProjectNextAction: async () => ({}),
    resolveRepoFromPayload: async (p: any) => ({ repoRoot: process.cwd(), remote: '', branch: p.branch || 'main' }),
    getRepoMetadata: async () => ({ currentBranch: 'main', remoteSlug: null, remoteUrl: '' }),
    checkoutBranchFromBase: async () => {},
    ensureBranchPublished: async () => {},
    commitAndPushPaths: async () => ({ ok: true }),
    updateTaskStatus: async () => ({ ok: true }),
    selectNextMilestone: () => ({ id: 'm', name: 'm' }),
    selectNextTask: () => ({ id: 't', name: 't' }),
    runLeadCycle: async () => ({ success: true, result: preview }),
    parseUnifiedDiffToEditSpec: async (txt: string) => { parserCalled = true; const real = await import('../src/fileops.js'); return (real as any).parseUnifiedDiffToEditSpec(txt); },
    applyEditOps: async (jsonText: string, opts: any) => { applyCalled = true; const real = await import('../src/fileops.js'); return (real as any).applyEditOps(jsonText, { repoRoot: process.cwd(), branchName: opts?.branchName || opts?.branch }); }
  };

  
  overrides.persona = {
    sendPersonaRequest: async () => ({ ok: true }),
    waitForPersonaCompletion: async () => ({ fields: { result: {} }, id: 'evt-test' }),
    parseEventResult: (_r: any) => _r,
    interpretPersonaStatus: (_r: any) => ({ status: 'pass' })
  };

  console.log('Running handleCoordinator with overrides (test runner)');
  await (coord as any).handleCoordinator({}, { workflow_id: 'test-wf', project_id: 'sim-proj' }, { repo: process.cwd(), branch: 'milestone/test', project_id: 'sim-proj' }, overrides);

  console.log('parserCalled=', parserCalled, 'applyCalled=', applyCalled);
  if (!parserCalled) throw new Error('parser not called');
  if (!applyCalled) throw new Error('apply not called');
  if (!fs.existsSync('src/App.test.tsx') || !fs.existsSync('src/main.test.ts')) throw new Error('expected files not present');

  console.log('Integration run succeeded: parser & apply invoked, files present.');
}

main().catch(e => { console.error('Runner failed:', e); process.exit(2); });
