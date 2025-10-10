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
      commitAndPushPaths: async () => ({ committed: true, pushed: true, branch: 'main' }),
      verifyRemoteBranchHasDiff: (() => {
        let counter = 0;
        return async () => {
          counter += 1;
          return { ok: true, hasDiff: true, branch: 'main', baseBranch: 'main', diffSummary: '1 file changed', aheadCount: 1, branchSha: `verify-sha-${counter}` };
        };
      })(),
      getBranchHeadSha: (() => {
        let local = 0;
        let remote = 0;
        return async ({ remote: isRemote }: any) => {
          if (isRemote) {
            remote += 1;
            if (remote === 1) return null;
            return `remote-sha-${remote}`;
          }
          local += 1;
          return `local-sha-${local}`;
        };
      })(),
      updateTaskStatus: async () => ({ ok: true }),
      selectNextMilestone: () => ({ id: 'm', name: 'm' }),
      selectNextTask: () => ({ id: 't', name: 't' }),
      runLeadCycle: async () => ({ success: true, result: preview }),
      parseUnifiedDiffToEditSpec: async (txt: string) => { parserCalled = true; const real = await import('../src/fileops.js'); return (real as any).parseUnifiedDiffToEditSpec(txt); },
      applyEditOps: async (_jsonText: string, opts: any) => { applyCalled = true; return { changed: ['dummy.txt'], branch: opts?.branchName || opts?.branch || 'main', sha: 'stub-sha' }; },
      persona: {
        sendPersonaRequest: async () => ({ ok: true }),
        waitForPersonaCompletion: async () => ({ fields: { result: {} }, id: 'evt-test' }),
        parseEventResult: (r: any) => r,
        interpretPersonaStatus: (r: any) => ({ status: 'pass' })
      }
    };

  await (coord as any).handleCoordinator({}, { workflow_id: 'test-wf', project_id: 'sim-proj' }, { repo: process.cwd(), branch: 'milestone/test', project_id: 'sim-proj' }, overrides);

    expect(parserCalled).toBe(true);
    expect(applyCalled).toBe(true);
    // sanity: ensure the test files were created in the repo
    const fs = require('fs');
    expect(fs.existsSync('src/App.test.tsx')).toBeTruthy();
    expect(fs.existsSync('src/main.test.ts')).toBeTruthy();
  });
});
