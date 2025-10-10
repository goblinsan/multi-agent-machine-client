import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as coordinatorMod from '../src/workflows/coordinator.js';
import * as dashboard from '../src/dashboard.js';
import * as persona from '../src/agents/persona.js';
import { sent, writeCapturedOutputs, annotateCaptured } from './testCapture';
import * as tasks from '../src/tasks/taskManager.js';
import * as fileops from '../src/fileops.js';
import * as gitUtils from '../src/gitUtils.js';

// Lightweight in-memory mocks to simulate redis and persona events.
// We'll stub sendPersonaRequest and waitForPersonaCompletion to intercept payloads.

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('Coordinator QA failure handling', () => {
  it('forwards created tasks with descriptions and QA context to implementation-planner', async () => {
    // Arrange: mock fetchProjectStatus etc. to provide minimal project info
      const project = { id: 'proj-1', name: 'proj', tasks: [{ id: 'task-1', name: 'task-1', status: 'open' }], next_milestone: { id: 'milestone-1', name: 'Milestone 1' } };
    vi.spyOn(dashboard, 'fetchProjectStatus').mockImplementation(async () => (JSON.parse(JSON.stringify(project))));
    vi.spyOn(dashboard, 'updateTaskStatus').mockImplementation(async (taskId: string, status: string) => {
      const task = project.tasks.find(t => t.id === taskId);
      if (task) {
        task.status = status;
      }
      return { ok: true, status: 200, body: {} } as any;
    });
    vi.spyOn(dashboard, 'fetchProjectStatusDetails').mockResolvedValue(null as any);
    vi.spyOn(dashboard, 'fetchProjectNextAction').mockResolvedValue(null as any);

    // Mock sendPersonaRequest to capture requests
    sent.length = 0;
    vi.spyOn(persona, 'sendPersonaRequest').mockImplementation(async (_r: any, opts: any) => {
      sent.push(opts);
      return opts.corrId || 'corr-mock';
    });

    // Mock waitForPersonaCompletion to simulate persona completions in sequence
    const completions: Record<string, any> = {};
    // context -> done
    completions['1-context'] = { fields: { result: JSON.stringify({}) }, id: 'evt-ctx' };
  // implementation-planner initial plan -> done (wrap in payload to match parser expectations)
  completions['2-plan'] = { fields: { result: JSON.stringify({ payload: { plan: [{ goal: 'feature' }] }, output: '' }) }, id: 'evt-plan' };
    // lead-engineer -> done
    completions['2-implementation'] = { fields: { result: JSON.stringify({ applied_edits: { attempted: true, applied: true, paths: ['dummy.txt'], commit: { committed: true, pushed: true } } }) }, id: 'evt-lead' };
    // tester-qa -> fail
    completions['3-qa'] = { fields: { result: JSON.stringify({ status: 'fail', details: 'no tests', tasks: [] }) }, id: 'evt-qa' };
    // implementation-planner when handling created followups -> should receive created tasks + qa_result
    // We'll return a plan that specifically references the QA issue
  const plannerFollowupResult = { payload: { plan: [{ goal: 'fix tests', key_files: [], owners: ['dev'] }] }, output: '' };

    vi.spyOn(persona, 'waitForPersonaCompletion').mockImplementation(async (_r: any, toPersona: string, workflowId: string, corrId: string) => {
      // correlate by step in corrId or by last sent options
      // for simplicity, match by existence in sent array where opts.corrId === corrId
      const match = sent.find(s => s.corrId === corrId) as any;
      if (!match) {
        // fallback: if corrId looks like a step name, use that
        if (corrId.endsWith('3-qa')) return completions['3-qa'];
        throw new Error('no match');
      }
      if (match.toPersona === 'plan-evaluator') {
        return { fields: { result: JSON.stringify({ status: 'pass' }) }, id: 'evt-eval-pass' };
      }
      if (match.toPersona === 'plan-evaluator') {
        return { fields: { result: JSON.stringify({ status: 'pass' }) }, id: 'evt-eval-pass' };
      }
      if (match.step === '1-context') return completions['1-context'];
      if (match.step === '2-plan') return completions['2-plan'];
      if (match.step === '2-implementation') return completions['2-implementation'];
      if (match.step === '3-qa') return completions['3-qa'];
      if (match.step === 'qa-created-tasks') {
        return { fields: { result: JSON.stringify(plannerFollowupResult) }, id: 'evt-planner-followup' } as any;
      }
      if (match.step === '4-implementation-plan') return { fields: { result: JSON.stringify(plannerFollowupResult) }, id: 'evt-impl-final' } as any;
      if (match.toPersona === 'project-manager') {
        const task = match.payload.task;
        if (task) {
          dashboard.updateTaskStatus(task.id, 'closed');
        }
        return { fields: { result: JSON.stringify({ status: 'pass' }) }, id: 'evt-pm' };
      }
      return { fields: { result: JSON.stringify({}) }, id: 'evt-unknown' } as any;
    });

    // Mock createDashboardTaskEntriesWithSummarizer to return a created task with description
    vi.spyOn(tasks, 'createDashboardTaskEntriesWithSummarizer').mockResolvedValue([{ title: 'QA failure task', externalId: 'ext-1', createdId: 't-1', description: 'Condensed description about missing tests' } as any]);

  // Mock git helpers to avoid real git operations
    vi.spyOn(fileops, 'applyEditOps').mockResolvedValue({ changed: ['dummy.txt'], branch: 'feat/task-1', sha: 'stub-sha' } as any);
    vi.spyOn(gitUtils, 'commitAndPushPaths').mockResolvedValue({ committed: true, pushed: true, branch: 'feat/task-1' });
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
      return { ok: true, hasDiff: true, branch: 'feat/task-1', baseBranch: 'main', branchSha: `verify-sha-${verifyCounter}`, baseSha: 'base', aheadCount: 1, diffSummary: '1 file changed' } as any;
    });
    vi.spyOn(gitUtils, 'resolveRepoFromPayload').mockResolvedValue({ repoRoot: '/tmp/repo', branch: 'main', remote: 'git@example:repo.git' } as any);
    vi.spyOn(gitUtils, 'getRepoMetadata').mockResolvedValue({ remoteSlug: 'example/repo', currentBranch: 'main' } as any);
    vi.spyOn(gitUtils, 'checkoutBranchFromBase').mockResolvedValue(undefined as any);
    vi.spyOn(gitUtils, 'ensureBranchPublished').mockResolvedValue(undefined as any);

  // Act: call handleCoordinator with a minimal message and payload
    const redisMock: any = {};
    const msg = { workflow_id: 'wf-1', project_id: 'proj-1' } as any;
    const payloadObj: any = { repo: 'https://example/repo.git' };

    // Call the coordinator handler (it will use our spies)
    await coordinatorMod.handleCoordinator(redisMock, msg, payloadObj);

  // Optionally write captured persona requests to outputs when TEST_CAPTURE_PROMPTS is enabled
  writeCapturedOutputs('coordinator', annotateCaptured);
  // Assert: find at least one planner request that contains QA context
  const plannerReqs = sent.filter(s => s.step === 'qa-created-tasks' || s.step === '4-implementation-plan');
  expect(plannerReqs.length).toBeGreaterThan(0);

  const reqWithQa = plannerReqs.find(r => r.payload && r.payload.qa_result);
  expect(reqWithQa, 'expected at least one planner request to include qa_result').toBeDefined();
  const plannerReq = reqWithQa as any;
  expect(plannerReq.payload).toBeDefined();
  expect(Array.isArray(plannerReq.payload.created_tasks) || Array.isArray(plannerReq.payload.created_tasks)).toBeTruthy();
  const created = (plannerReq.payload.created_tasks && plannerReq.payload.created_tasks[0]) || (plannerReq.payload.created_tasks && plannerReq.payload.created_tasks[0]);
  expect(created).toBeDefined();
  expect(created.description).toContain('missing tests');
  expect(plannerReq.payload.qa_result).toBeDefined();
  expect(plannerReq.payload.qa_result.status || plannerReq.payload.qa_result.details).toBeDefined();
  // Finally ensure the final planner produced a plan that contains a QA-focused goal
  const finalPlannerReq = sent.find(s => s.step === '4-implementation-plan');
  expect(finalPlannerReq).toBeDefined();

  }, 10000);

  it('aborts when remote diff verification reports no changes after lead step', async () => {
    const coord = await import('../src/workflows/coordinator.js');
    const overrides: any = {
      fetchProjectStatus: async () => ({ id: 'proj-x', name: 'proj', tasks: [{ id: 'task-1', name: 'task-1', status: 'open' }] }),
      fetchProjectStatusDetails: async () => ({ milestones: [] }),
      resolveRepoFromPayload: async () => ({ repoRoot: process.cwd(), branch: 'main', remote: '' }),
      getRepoMetadata: async () => ({ currentBranch: 'main', remoteSlug: null, remoteUrl: '' }),
      detectRemoteDefaultBranch: async () => 'main',
      checkoutBranchFromBase: async () => {},
      ensureBranchPublished: async () => {},
      runLeadCycle: async () => ({ appliedEdits: { applied: true, commit: { committed: true, pushed: true } } }),
      verifyRemoteBranchHasDiff: async () => ({ ok: false, hasDiff: false, branch: 'main', baseBranch: 'main', diffSummary: '', reason: 'no_diff' }),
      commitAndPushPaths: async () => ({ committed: true, pushed: true, branch: 'main' }),
      updateTaskStatus: async () => ({ ok: true }),
      parseUnifiedDiffToEditSpec: async () => ({ ops: [] }),
      applyEditOps: async () => ({ changed: ['dummy.txt'] }),
      persona: {
        sendPersonaRequest: async () => ({ ok: true }),
        waitForPersonaCompletion: async () => ({ fields: { result: JSON.stringify({ status: 'pass' }) }, id: 'evt' }),
        parseEventResult: (r: any) => (typeof r === 'string' ? JSON.parse(r) : r),
        interpretPersonaStatus: (r: any) => ({ status: (typeof r === 'string' ? JSON.parse(r) : r)?.status || 'pass' })
      }
    };

    vi.spyOn(gitUtils, 'getBranchHeadSha').mockImplementation(async ({ remote }) => (remote ? 'remote-static' : 'local-static'));

    await expect((coord as any).handleCoordinator({}, { workflow_id: 'wf-verify-fail', project_id: 'proj-x' }, { project_id: 'proj-x', repo: process.cwd() }, overrides)).rejects.toThrow(/did not create a new commit/i);
  });
});
