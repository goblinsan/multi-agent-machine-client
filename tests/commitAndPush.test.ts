import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as coordinatorMod from '../src/workflows/coordinator.js';
import * as dashboard from '../src/dashboard.js';
import * as persona from '../src/agents/persona.js';
import * as gitUtils from '../src/gitUtils.js';
import * as fileops from '../src/fileops.js';
import { sent } from './testCapture.js';

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('Coordinator commit and push', () => {
  it('applies, commits, and pushes changes from a lead engineer', async () => {
    const project = {
      id: 'proj-1',
      name: 'proj',
      tasks: [{ id: 'task-1', name: 'task-1', status: 'open' }],
      next_milestone: { id: 'milestone-1', name: 'Milestone 1' },
    };
    vi.spyOn(dashboard, 'fetchProjectStatus').mockResolvedValue(project as any);
    const updateTaskStatusSpy = vi.spyOn(dashboard, 'updateTaskStatus').mockResolvedValue({ ok: true } as any);
    vi.spyOn(dashboard, 'fetchProjectStatusDetails').mockResolvedValue(null as any);
    vi.spyOn(dashboard, 'fetchProjectNextAction').mockResolvedValue(null as any);

    sent.length = 0;
    vi.spyOn(persona, 'sendPersonaRequest').mockImplementation(async (_r: any, opts: any) => {
      sent.push(opts);
      return opts.corrId || 'corr-mock';
    });

    const leadEngineerResult = {
      status: 'ok',
      ops: [
        {
          action: 'upsert',
          path: 'src/test.ts',
          content: 'console.log("hello world");'
        }
      ]
    };

    vi.spyOn(persona, 'waitForPersonaCompletion').mockImplementation(async (_r: any, toPersona: string, workflowId: string, corrId: string) => {
      const match = sent.find(s => s.corrId === corrId) as any;
      if (match.toPersona === 'implementation-planner') {
        return { fields: { result: JSON.stringify({ payload: { plan: [{ goal: 'feature' }] }, output: '' }) }, id: 'evt-plan' };
      }
      if (match.toPersona === 'lead-engineer') {
        return { fields: { result: JSON.stringify(leadEngineerResult) }, id: 'evt-lead' };
      }
      if (match.toPersona === 'tester-qa') {
        return { fields: { result: JSON.stringify({ status: 'pass' }) }, id: 'evt-qa' };
      }
      return { fields: { result: JSON.stringify({}) }, id: 'evt-unknown' };
    });

    const applyEditOpsSpy = vi.spyOn(fileops, 'applyEditOps').mockResolvedValue({ changed: ['src/test.ts'], branch: 'feat/agent-edit', sha: '12345' });
    const commitAndPushPathsSpy = vi.spyOn(gitUtils, 'commitAndPushPaths').mockResolvedValue({ committed: true, pushed: true, branch: 'feat/agent-edit' });
    vi.spyOn(gitUtils, 'resolveRepoFromPayload').mockResolvedValue({ repoRoot: '/tmp/repo', branch: 'main', remote: 'git@example:repo.git' } as any);
    vi.spyOn(gitUtils, 'getRepoMetadata').mockResolvedValue({ remoteSlug: 'example/repo', currentBranch: 'main' } as any);
    vi.spyOn(gitUtils, 'checkoutBranchFromBase').mockResolvedValue(undefined as any);
    vi.spyOn(gitUtils, 'ensureBranchPublished').mockResolvedValue(undefined as any);

    const redisMock: any = {};
    const msg = { workflow_id: 'wf-1', project_id: 'proj-1' } as any;
    const payloadObj: any = { repo: 'https://example/repo.git' };

    await coordinatorMod.handleCoordinator(redisMock, msg, payloadObj);

    expect(applyEditOpsSpy).toHaveBeenCalled();
    expect(commitAndPushPathsSpy).toHaveBeenCalled();
    expect(updateTaskStatusSpy).toHaveBeenCalledWith('task-1', 'done');
  });
});
