import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as coordinatorMod from '../src/workflows/coordinator.js';
import * as dashboard from '../src/dashboard.js';
import * as persona from '../src/agents/persona.js';
import * as gitUtils from '../src/gitUtils.js';
import * as fileops from '../src/fileops.js';
import { sent } from './testCapture.js';

beforeEach(() => {
  vi.restoreAllMocks();
  sent.length = 0;
});

describe('Coordinator processes each task only once', () => {
  it('marks each task done exactly once for multiple tasks', async () => {
    const projectId = 'proj-once';
    const tasks = [ { id: 't1', name: 't1', status: 'open' }, { id: 't2', name: 't2', status: 'open' } ];
    vi.spyOn(dashboard, 'fetchProjectStatus').mockImplementation(async () => ({ id: projectId, name: 'P', repositories: [{ url: 'https://example/repo.git' }], tasks: tasks.filter(t => t.status !== 'done') } as any));
    vi.spyOn(dashboard, 'fetchProjectStatusDetails').mockResolvedValue({ milestones: [] } as any);
    vi.spyOn(dashboard, 'fetchProjectNextAction').mockResolvedValue({ suggestions: [] } as any);

    const updateCalls: string[] = [];
    vi.spyOn(dashboard, 'updateTaskStatus').mockImplementation(async (taskId: string, status: string) => { updateCalls.push(taskId); const t = tasks.find(x => x.id === taskId); if (t) t.status = status; return { ok: true } as any; });

    vi.spyOn(persona, 'sendPersonaRequest').mockImplementation(async (_r: any, opts: any) => { sent.push(opts); return opts.corrId || 'corr-' + String(sent.length); });

    vi.spyOn(persona, 'waitForPersonaCompletion').mockImplementation(async (_r: any, toPersona: string, workflowId: string, corrId: string) => {
      const match = sent.find(s => s.corrId === corrId) as any;
      if (!match) return { fields: { result: JSON.stringify({ status: 'ok' }) }, id: 'evt' } as any;
      if (match.step === '1-context') return { fields: { result: JSON.stringify({}) }, id: 'evt-ctx' } as any;
      if (match.step === '2-plan') return { fields: { result: JSON.stringify({ payload: { plan: [{ goal: 'g' }] } }) }, id: 'evt-plan' } as any;
      if (match.step === '2-implementation') return { fields: { result: JSON.stringify({ status: 'ok', applied_edits: { applied: true, attempted: true, paths: [], commit: { committed: true, pushed: true } } }) }, id: 'evt-impl' } as any;
      if (match.step === '3-qa') return { fields: { result: JSON.stringify({ status: 'pass' }) }, id: 'evt-qa' } as any;
      return { fields: { result: JSON.stringify({ status: 'ok' }) }, id: 'evt-other' } as any;
    });

    vi.spyOn(gitUtils, 'resolveRepoFromPayload').mockResolvedValue({ repoRoot: '/tmp/repo', branch: 'main', remote: 'https://example/repo.git' } as any);
    vi.spyOn(gitUtils, 'getRepoMetadata').mockResolvedValue({ remoteSlug: 'example/repo', currentBranch: 'main' } as any);
    vi.spyOn(gitUtils, 'checkoutBranchFromBase').mockResolvedValue(undefined as any);
    vi.spyOn(gitUtils, 'ensureBranchPublished').mockResolvedValue(undefined as any);
    vi.spyOn(fileops, 'applyEditOps').mockResolvedValue({ changed: ['dummy.txt'], branch: 'feat/agent-edit', sha: 'stub-sha' });
    vi.spyOn(gitUtils, 'commitAndPushPaths').mockResolvedValue({ committed: true, pushed: true, branch: 'feat/agent-edit' });
    let verifyCounter = 0;
    vi.spyOn(gitUtils, 'verifyRemoteBranchHasDiff').mockImplementation(async () => {
      verifyCounter += 1;
      return { ok: true, hasDiff: true, branch: 'feat/agent-edit', baseBranch: 'main', branchSha: `verify-sha-${verifyCounter}`, baseSha: 'base', aheadCount: 1, diffSummary: '1 file changed' } as any;
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

    const redisMock: any = {};
    const msg = { workflow_id: 'wf-once', project_id: projectId } as any;
    const payloadObj: any = { repo: 'https://example/repo.git' };

    await coordinatorMod.handleCoordinator(redisMock, msg, payloadObj);

    // each task should have been updated exactly once
    expect(updateCalls.length).toBe(tasks.length);
    expect(new Set(updateCalls).size).toBe(tasks.length);
  }, 10000);
});
