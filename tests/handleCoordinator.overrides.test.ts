import { describe, it, expect } from 'vitest';

describe('handleCoordinator with overrides', () => {
  it('calls parse and apply and returns changed files via applyEditOps', async () => {
    const coord = await import('../src/workflows/coordinator.js');
    const previewPath = require('path').join(process.cwd(), 'scripts', 'lead_preview_current.txt');
    const preview = await require('fs/promises').readFile(previewPath, 'utf8');

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

    await (coord as any).handleCoordinator({}, { workflow_id: 'test-wf' }, { repo: process.cwd(), branch: 'milestone/test' }, overrides);

    expect(parserCalled).toBe(true);
    expect(applyCalled).toBe(true);
    // sanity: ensure the test files were created in the repo
    const fs = require('fs');
    expect(fs.existsSync('src/App.test.tsx')).toBeTruthy();
    expect(fs.existsSync('src/main.test.ts')).toBeTruthy();
  });
});
