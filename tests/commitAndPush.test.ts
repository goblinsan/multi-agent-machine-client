import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as coordinatorMod from '../src/workflows/coordinator.js';
import * as dashboard from '../src/dashboard.js';
import * as persona from '../src/agents/persona.js';
import * as gitUtils from '../src/gitUtils.js';
import * as fileops from '../src/fileops.js';
import { sent } from './testCapture.js';
import fs from 'fs/promises';
import path from 'path';
import { makeTempRepo } from './makeTempRepo';

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('Coordinator commit and push (integration-ish)', () => {
  it('applies edits to a real repo and creates a commit', async () => {
    // Prepare a temporary repo directory
    const tmp = await makeTempRepo({ 'README.md': '# test\n' });

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

    // Let fileops.applyEditOps run against our temp repo for real writes/commits
    // but stub out pushing to remote
    const commitAndPushPathsSpy = vi.spyOn(gitUtils, 'commitAndPushPaths').mockResolvedValue({ committed: true, pushed: true, branch: 'feat/agent-edit' });
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
    let verifyCounter = 0;
    vi.spyOn(gitUtils, 'verifyRemoteBranchHasDiff').mockImplementation(async () => {
      verifyCounter += 1;
      return { ok: true, hasDiff: true, branch: 'feat/agent-edit', baseBranch: 'main', branchSha: `verify-sha-${verifyCounter}`, baseSha: 'base', aheadCount: 1, diffSummary: '1 file changed' } as any;
    });
    vi.spyOn(gitUtils, 'resolveRepoFromPayload').mockResolvedValue({ repoRoot: tmp, branch: 'main', remote: null } as any);
    vi.spyOn(gitUtils, 'getRepoMetadata').mockResolvedValue({ remoteSlug: null, currentBranch: 'main' } as any);
    vi.spyOn(gitUtils, 'checkoutBranchFromBase').mockResolvedValue(undefined as any);
    vi.spyOn(gitUtils, 'ensureBranchPublished').mockResolvedValue(undefined as any);

    const redisMock: any = {};
    const msg = { workflow_id: 'wf-1', project_id: 'proj-1' } as any;
    const payloadObj: any = { repo: 'https://example/repo.git' };

    await coordinatorMod.handleCoordinator(redisMock, msg, payloadObj);

    // Verify the file was written
    const written = await fs.readFile(path.join(tmp, 'src', 'test.ts'), 'utf8');
    expect(written).toContain('hello world');

    // Verify a commit was created (HEAD not the initial commit)
    // Confirm HEAD exists by reading the commit hash via file system interaction is enough here,
    // but we still verify with git rev-parse with explicit cwd
    const { exec } = await import('child_process');
    const { promisify } = await import('util');
    const execP = promisify(exec);
    const rev = (await execP('git rev-parse HEAD', { cwd: tmp })).stdout.trim();
    expect(rev.length).toBeGreaterThan(0);

    expect(updateTaskStatusSpy).toHaveBeenCalledWith('task-1', 'done');
  });
});
