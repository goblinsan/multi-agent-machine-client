import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as dashboard from '../src/dashboard.js';
import * as persona from '../src/agents/persona.js';
import { sent } from './testCapture';
import * as tasks from '../src/tasks/taskManager.js';

// This test verifies the QA follow-up iterative loop:
// - Evaluator runs every time
// - Planner receives acknowledgement requirement
// - Retries stop at configured max (default 5)

describe('QA follow-up plan iteration respects max retries and requires ack', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    sent.length = 0;
  });

  it('evaluates on each iteration, requests ack, and stops at max when evaluator always fails', async () => {
    // Delay importing coordinator until after spies are set up
    const project = { id: 'proj-iter', name: 'proj', tasks: [{ id: 'task-1', name: 'task-1', status: 'open' }], next_milestone: { id: 'm1', name: 'Milestone 1' } } as any;
    vi.spyOn(dashboard, 'fetchProjectStatus').mockImplementation(async () => (JSON.parse(JSON.stringify(project))));
    vi.spyOn(dashboard, 'updateTaskStatus').mockResolvedValue({ ok: true, status: 200, body: {} } as any);
    vi.spyOn(dashboard, 'fetchProjectStatusDetails').mockResolvedValue(null as any);
    vi.spyOn(dashboard, 'fetchProjectNextAction').mockResolvedValue(null as any);

    // Capture all outgoing persona requests
    vi.spyOn(persona, 'sendPersonaRequest').mockImplementation(async (_r: any, opts: any) => {
      sent.push(opts);
      return opts.corrId || 'corr-mock';
    });

    // Always-failing evaluator across all QA follow-up iterations
    vi.spyOn(persona, 'waitForPersonaCompletion').mockImplementation(async (_r: any, _toPersona: string, _workflowId: string, corrId: string) => {
      const match = sent.find(s => s.corrId === corrId) as any;
      if (!match) throw new Error('no match');
      const step: string = match.step || '';
      if (step === '1-context') return { fields: { result: JSON.stringify({}) }, id: 'evt-ctx' } as any;
      if (step === '2-plan') return { fields: { result: JSON.stringify({ payload: { plan: [{ goal: 'feature' }] }, output: '' }) }, id: 'evt-plan' } as any;
      if (step === '2-implementation') return { fields: { result: JSON.stringify({}) }, id: 'evt-lead' } as any;
      if (step === '3-qa') return { fields: { result: JSON.stringify({ status: 'fail', details: 'tests failing' }) }, id: 'evt-qa' } as any;
      if (step === '3.5-evaluate-qa-plan' || step === '3.7-evaluate-qa-plan-revised') {
        return { fields: { result: JSON.stringify({ status: 'fail', reason: 'not aligned with QA feedback' }) } , id: `evt-${step}` } as any;
      }
      if (step === '3.6-plan-revision') {
        // Return a revised plan each time; content does not matter because evaluator fails anyway
        return { fields: { result: JSON.stringify({ payload: { plan: [{ goal: 'revise attempt' }] }, output: '' }) }, id: 'evt-plan-rev' } as any;
      }
      if (match.toPersona === 'project-manager') return { fields: { result: JSON.stringify({ status: 'pass' }) }, id: 'evt-pm' } as any;
      return { fields: { result: JSON.stringify({}) }, id: 'evt' } as any;
    });

    // Summarizer creates a single QA task; details not critical here
    vi.spyOn(tasks, 'createDashboardTaskEntriesWithSummarizer').mockResolvedValue([
      { title: 'QA failure task', externalId: 'ext-qa', createdId: 't-qa', description: 'desc' } as any
    ]);

    // Stub git utils to avoid real operations
    const gitUtils = await import('../src/gitUtils.js');
    vi.spyOn(gitUtils, 'resolveRepoFromPayload').mockResolvedValue({ repoRoot: '/tmp/repo', branch: 'main', remote: 'git@example:repo.git' } as any);
    vi.spyOn(gitUtils, 'getRepoMetadata').mockResolvedValue({ remoteSlug: 'example/repo', currentBranch: 'main' } as any);
    vi.spyOn(gitUtils, 'checkoutBranchFromBase').mockResolvedValue(undefined as any);
    vi.spyOn(gitUtils, 'ensureBranchPublished').mockResolvedValue(undefined as any);

    // Now import the coordinator and run
    const coordinatorMod = await import('../src/workflows/coordinator.js');
    const redisMock: any = {};
    const msg = { workflow_id: 'wf-iter', project_id: 'proj-iter' } as any;
    const payloadObj: any = { repo: 'https://example/repo.git' };
    await coordinatorMod.handleCoordinator(redisMock, msg, payloadObj);

    // Count evaluator and revision calls across the QA loop
    const evalCalls = sent.filter(s => s.toPersona === 'plan-evaluator' && (s.step === '3.5-evaluate-qa-plan' || s.step === '3.7-evaluate-qa-plan-revised'));
    const revCalls = sent.filter(s => s.step === '3.6-plan-revision');

    // Default max is 5; evaluator should have been called exactly 5 times, and same for revisions
    expect(evalCalls.length).toBe(5);
    expect(revCalls.length).toBe(5);

    // Each plan-revision request should instruct the planner to include acknowledged_feedback
    for (const rc of revCalls) {
      expect(rc.payload?.require_acknowledged_feedback).toBe(true);
      expect(rc.payload?.acknowledge_key).toBe('acknowledged_feedback');
    }

    // New behavior: proceed with latest plan even on failure; should forward implementation plan
    const implFollowup = sent.find(s => s.step === '4-implementation-plan');
    expect(implFollowup).toBeTruthy();
    expect(implFollowup?.payload?.plan_approved).toBe(false);
    expect(implFollowup?.payload?.planner_result?.meta?.reason).toBe('iteration_limit_exceeded');
  }, 15000);
});
