import { describe, it, expect } from 'vitest';

// Regression: ensure we don't try to checkout in PROJECT_BASE/active when it's not a repo;
// we should resolve using a remote and clone under PROJECT_BASE/<slug> before checkout.
describe('coordinator repo resolution fallback', () => {
  it('re-resolves to remote-backed repo before checkout when config default is not a repo', async () => {
    const coord = await import('../src/workflows/coordinator.js');

    let checkoutCalledWith: { root: string; base: string; branch: string } | null = null;

    const overrides: any = {
      fetchProjectStatus: async () => ({ id: 'p', name: 'Demo Project', slug: 'demo-project', repository: { url: `https://github.com/example/demo.git` } }),
      fetchProjectStatusDetails: async () => ({ milestones: [] }),
      resolveRepoFromPayload: async (p: any) => {
        if (p.repo) {
          // simulate ensureRepo produced a proper repo path under temp folder
          return { repoRoot: require('path').join(require('os').tmpdir(), 'mc-demo-project'), branch: p.branch || 'main', remote: p.repo };
        }
        // initial resolution returns config default which is not a repo
        return { repoRoot: '/Users/test/code/active', branch: p.branch || 'main', remote: null };
      },
      getRepoMetadata: async (root: string) => {
        if (root.includes('mc-demo-project')) return ({ currentBranch: 'main', remoteSlug: 'github.com/example/demo', remoteUrl: 'https://github.com/example/demo.git' });
        return ({ currentBranch: null, remoteSlug: null, remoteUrl: null });
      },
      checkoutBranchFromBase: async (root: string, base: string, branch: string) => {
        checkoutCalledWith = { root, base, branch };
        if (root === '/Users/test/code/active') {
          // simulate failure same as real code path
          throw new Error(`Base branch ${base} not found in repository ${root}`);
        }
      },
      ensureBranchPublished: async () => {},
      applyEditOps: async () => ({ changed: ['dummy.txt'] }),
      parseUnifiedDiffToEditSpec: async () => ({ ops: [] }),
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
      runLeadCycle: async () => ({ success: true, result: { ops: [{ action: 'upsert', path: 'dummy.txt', content: 'hello' }] } }),
      persona: {
        sendPersonaRequest: async () => ({ ok: true }),
        waitForPersonaCompletion: async () => ({ fields: { result: {} }, id: 'evt-test' }),
        parseEventResult: (r: any) => r,
        interpretPersonaStatus: (r: any) => ({ status: 'pass' })
      }
    };

    await (coord as any).handleCoordinator({}, { workflow_id: 'wf-fallback', project_id: 'p' }, { project_id: 'p' }, overrides);

    expect(checkoutCalledWith).not.toBeNull();
    // After fallback, checkout must target the remote-backed path, not config default
    expect(checkoutCalledWith!.root).toContain('mc-demo-project');
  });
});
