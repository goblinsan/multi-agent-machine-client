import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as coordinatorMod from '../src/workflows/coordinator.js';
import * as dashboard from '../src/dashboard.js';
import * as persona from '../src/agents/persona.js';

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('Coordinator branch selection', () => {
  it('uses remote default branch as base and avoids milestone/milestone', async () => {
    // Arrange project with a single open task
    const project = { id: 'proj-2', name: 'Demo Project', tasks: [{ id: 't-1', name: 'task', status: 'open' }] };
    vi.spyOn(dashboard, 'fetchProjectStatus').mockResolvedValue(project as any);
    vi.spyOn(dashboard, 'fetchProjectStatusDetails').mockResolvedValue(null as any);
    vi.spyOn(dashboard, 'updateTaskStatus').mockResolvedValue({ ok: true } as any);

    // Capture persona requests without doing real work
    vi.spyOn(persona, 'sendPersonaRequest').mockResolvedValue('corr' as any);
    vi.spyOn(persona, 'waitForPersonaCompletion').mockImplementation(async (_r: any, toPersona: string, _wf: string, _cid: string) => {
      if (toPersona === 'implementation-planner') return { fields: { result: JSON.stringify({ payload: { plan: [{ goal: 'do' }] } }) }, id: 'evt-plan' } as any;
      if (toPersona === 'lead-engineer') return { fields: { result: JSON.stringify({}) }, id: 'evt-lead' } as any;
      if (toPersona === 'tester-qa') return { fields: { result: JSON.stringify({ status: 'pass' }) }, id: 'evt-qa' } as any;
      return { fields: { result: JSON.stringify({}) }, id: 'evt' } as any;
    });

    const gitUtils = await import('../src/gitUtils.js');
    // Simulate local repo being on a misleading branch
    vi.spyOn(gitUtils, 'getRepoMetadata').mockResolvedValue({ remoteSlug: 'example/repo', currentBranch: 'milestone/milestone', remoteUrl: 'https://example/repo.git' } as any);
    // Force remote default to main
    vi.spyOn(gitUtils, 'detectRemoteDefaultBranch').mockResolvedValue('main');

    // ensure resolveRepoFromPayload returns a repoRoot
    vi.spyOn(gitUtils, 'resolveRepoFromPayload').mockResolvedValue({ repoRoot: '/tmp/repo', branch: null, remote: 'https://example/repo.git' } as any);

    // Capture arguments to checkout to assert base branch
    const checkoutSpy = vi.spyOn(gitUtils, 'checkoutBranchFromBase').mockResolvedValue(undefined as any);
    vi.spyOn(gitUtils, 'ensureBranchPublished').mockResolvedValue(undefined as any);

    const msg = { workflow_id: 'wf-branch', project_id: 'proj-2' } as any;
    const payload = { repo: 'https://example/repo.git' } as any;
    await coordinatorMod.handleCoordinator({}, msg, payload);

    expect(checkoutSpy).toHaveBeenCalled();
    const [repoRoot, baseBranch, newBranch] = checkoutSpy.mock.calls[0] as any[];
    expect(repoRoot).toBe('/tmp/repo');
    expect(baseBranch).toBe('main');
    expect(newBranch).toBe('feat/task');
  });
});
