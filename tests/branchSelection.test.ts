import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as coordinatorMod from '../src/workflows/coordinator.js';
import * as dashboard from '../src/dashboard.js';
import * as persona from '../src/agents/persona.js';
import * as fileops from '../src/fileops.js';
import * as gitUtils from '../src/gitUtils.js';

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
      if (toPersona === 'lead-engineer') return { fields: { result: JSON.stringify({ applied_edits: { attempted: true, applied: true, paths: ['dummy.txt'], commit: { committed: true, pushed: true } } }) }, id: 'evt-lead' } as any;
      if (toPersona === 'tester-qa') return { fields: { result: JSON.stringify({ status: 'pass' }) }, id: 'evt-qa' } as any;
      return { fields: { result: JSON.stringify({}) }, id: 'evt' } as any;
    });

    vi.spyOn(fileops, 'applyEditOps').mockResolvedValue({ changed: ['dummy.txt'], branch: 'feat/task', sha: 'stub-sha' } as any);
    vi.spyOn(gitUtils, 'commitAndPushPaths').mockResolvedValue({ committed: true, pushed: true, branch: 'feat/task' });
    let verifyCounter = 0;
    vi.spyOn(gitUtils, 'verifyRemoteBranchHasDiff').mockImplementation(async () => {
      verifyCounter += 1;
      return { ok: true, hasDiff: true, branch: 'feat/task', baseBranch: 'main', branchSha: `verify-sha-${verifyCounter}`, baseSha: 'base', aheadCount: 1, diffSummary: '1 file changed' } as any;
    });
    let localShaCounter = 0;
    let remoteShaCounter = 0;
    vi.spyOn(gitUtils, 'getBranchHeadSha').mockImplementation(async ({ remote }) => {
      if (remote) {
        remoteShaCounter += 1;
        if (remoteShaCounter === 1) return null;
        return `remote-sha-${remoteShaCounter}`;
      }
      localShaCounter += 1;
      return `local-sha-${localShaCounter}`;
    });
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
