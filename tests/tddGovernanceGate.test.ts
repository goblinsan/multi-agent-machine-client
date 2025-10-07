import { describe, it, expect, vi } from 'vitest';

// Minimal test to ensure governance (code-review/security) does not run during TDD failing test stage

describe('coordinator TDD governance gating', () => {
  it("skips governanceHook when tdd_stage is 'write_failing_test'", async () => {
    const coord = await import('../src/workflows/coordinator.js');

    const governanceHook = vi.fn(async () => {});

    const overrides: any = {
      fetchProjectStatus: async () => ({ id: 'p', name: 'Proj' }),
      fetchProjectStatusDetails: async () => ({ tasks: [{ id: 't-1', name: 'task' }] }),
      resolveRepoFromPayload: async () => ({ repoRoot: process.cwd(), remote: '', branch: 'main' }),
      getRepoMetadata: async () => ({ currentBranch: 'main', remoteSlug: null, remoteUrl: '' }),
      detectRemoteDefaultBranch: async () => 'main',
      checkoutBranchFromBase: async () => {},
      ensureBranchPublished: async () => {},
      commitAndPushPaths: async () => ({ ok: true }),
      updateTaskStatus: async () => ({ ok: true }),
      applyEditOps: async () => ({ changed: [] }),
      parseUnifiedDiffToEditSpec: async () => ({ ops: [] }),
      runLeadCycle: async () => ({ success: true, result: { status: 'ok' } }),
      governanceHook,
      persona: {
        sendPersonaRequest: async (_r: any, req: any) => {
          // For QA step, simulate expected failing tests being treated as pass
          if (req.toPersona === 'tester-qa') return { ok: true } as any;
          return { ok: true } as any;
        },
        waitForPersonaCompletion: async (_r: any, who: string, _wf: string, _corr: string) => {
          if (who === 'tester-qa') {
            return { id: 'evt-qa', fields: { result: { status: 'pass', payload: { details: 'expected failing tests acknowledged' } } } } as any;
          }
          return { id: 'evt-x', fields: { result: {} } } as any;
        },
        parseEventResult: (r: any) => r,
        interpretPersonaStatus: (r: any) => ({ status: (r && r.status) || 'pass' })
      }
    };

    await (coord as any).handleCoordinator(
      {},
      { workflow_id: 'wf', project_id: 'p1', workflow_mode: 'tdd', tdd_stage: 'write_failing_test' },
      { project_id: 'p1', repo: process.cwd() },
      overrides
    );

    expect(governanceHook).not.toHaveBeenCalled();
  });
});
