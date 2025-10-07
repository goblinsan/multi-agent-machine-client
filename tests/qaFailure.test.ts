import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as coordinatorMod from '../src/workflows/coordinator.js';
import * as dashboard from '../src/dashboard.js';
import * as persona from '../src/agents/persona.js';
import { sent, writeCapturedOutputs, annotateCaptured } from './testCapture';
import * as tasks from '../src/tasks/taskManager.js';

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('Coordinator QA failure plan evaluation', () => {
  it('routes evaluator failure back to the implementation-planner for revision and re-evaluation', async () => {
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

    sent.length = 0;
    vi.spyOn(persona, 'sendPersonaRequest').mockImplementation(async (_r: any, opts: any) => {
      sent.push(opts);
      return opts.corrId || 'corr-mock';
    });

    const completions: Record<string, any> = {};
    completions['1-context'] = { fields: { result: JSON.stringify({}) }, id: 'evt-ctx' };
    completions['2-plan'] = { fields: { result: JSON.stringify({ payload: { plan: [{ goal: 'feature' }] }, output: '' }) }, id: 'evt-plan' };
    completions['2-implementation'] = { fields: { result: JSON.stringify({}) }, id: 'evt-lead' };
    completions['3-qa'] = { fields: { result: JSON.stringify({ status: 'fail', details: 'no tests', tasks: [] }) }, id: 'evt-qa' };

    const irrelevantPlan = { payload: { plan: [{ goal: 'implement new feature' }] }, output: '' };

    vi.spyOn(persona, 'waitForPersonaCompletion').mockImplementation(async (_r: any, toPersona: string, workflowId: string, corrId: string) => {
      const match = sent.find(s => s.corrId === corrId) as any;
      if (toPersona === 'plan-evaluator') {
      }
      if (match.step === '3.5-evaluate-qa-plan') {
        const plan = match.payload.plan;
        if (plan && plan.payload && plan.payload.plan && plan.payload.plan[0].goal === 'implement new feature') {
          return { fields: { result: JSON.stringify({ status: 'fail', reason: 'The plan is not relevant to the QA feedback.' }) }, id: 'evt-eval-fail' };
        } else {
          return { fields: { result: JSON.stringify({ status: 'pass' }) }, id: 'evt-eval-pass' };
        }
      }
      if (match.step === '3.6-plan-revision') {
        // Planner returns a revised plan
        return { fields: { result: JSON.stringify({ payload: { plan: [{ goal: 'address QA feedback' }] }, output: '' }) }, id: 'evt-plan-revised' } as any;
      }
      if (match.step === '3.7-evaluate-qa-plan-revised') {
        // Revised plan should pass
        return { fields: { result: JSON.stringify({ status: 'pass' }) }, id: 'evt-eval-pass-revised' } as any;
      }
      if (!match) {
        if (corrId.endsWith('3-qa')) return completions['3-qa'];
        throw new Error('no match');
      }
      if (match.toPersona === 'plan-evaluator') {
        const plan = match.payload.plan;
        if (plan && plan.plan && plan.plan[0].goal === 'implement new feature') {
          return { fields: { result: JSON.stringify({ status: 'fail', reason: 'The plan is not relevant to the QA feedback.' }) }, id: 'evt-eval-fail' };
        } else {
          return { fields: { result: JSON.stringify({ status: 'pass' }) }, id: 'evt-eval-pass' };
        }
      }
      if (match.toPersona === 'plan-evaluator') {
        const plan = match.payload.plan;
        if (plan && plan.payload && plan.payload.plan && plan.payload.plan[0].goal === 'implement new feature') {
          return { fields: { result: JSON.stringify({ status: 'fail', reason: 'The plan is not relevant to the QA feedback.' }) }, id: 'evt-eval-fail' };
        } else {
          return { fields: { result: JSON.stringify({ status: 'pass' }) }, id: 'evt-eval-pass' };
        }
      }
      if (match.step === '1-context') return completions['1-context'];
      if (match.step === '2-plan') return completions['2-plan'];
      if (match.step === '2-implementation') return completions['2-implementation'];
      if (match.step === '3-qa') return completions['3-qa'];
      if (match.step === 'qa-created-tasks') {
        return { fields: { result: JSON.stringify(irrelevantPlan) }, id: 'evt-planner-followup' } as any;
      }
      if (match.step === '4-implementation-plan') return { fields: { result: JSON.stringify(irrelevantPlan) }, id: 'evt-impl-final' } as any;
      if (match.toPersona === 'project-manager') {
        const task = match.payload.task;
        if (task) {
          dashboard.updateTaskStatus(task.id, 'closed');
        }
        return { fields: { result: JSON.stringify({ status: 'pass' }) }, id: 'evt-pm' };
      }
      return { fields: { result: JSON.stringify({}) }, id: 'evt-unknown' } as any;
    });

    vi.spyOn(tasks, 'createDashboardTaskEntriesWithSummarizer').mockResolvedValue([{ title: 'QA failure task', externalId: 'ext-1', createdId: 't-1', description: 'Condensed description about missing tests' } as any]);

    const gitUtils = await import('../src/gitUtils.js');
    vi.spyOn(gitUtils, 'resolveRepoFromPayload').mockResolvedValue({ repoRoot: '/tmp/repo', branch: 'main', remote: 'git@example:repo.git' } as any);
    vi.spyOn(gitUtils, 'getRepoMetadata').mockResolvedValue({ remoteSlug: 'example/repo', currentBranch: 'main' } as any);
    vi.spyOn(gitUtils, 'checkoutBranchFromBase').mockResolvedValue(undefined as any);
    vi.spyOn(gitUtils, 'ensureBranchPublished').mockResolvedValue(undefined as any);

    const redisMock: any = {};
    const msg = { workflow_id: 'wf-1', project_id: 'proj-1' } as any;
    const payloadObj: any = { repo: 'https://example/repo.git' };

    let error: Error | null = null;
    try {
      await coordinatorMod.handleCoordinator(redisMock, msg, payloadObj);
    } catch (e) {
      error = e as Error;
    }

  // New behavior: coordinator handles evaluator failure by requesting plan revision; no exception thrown
    expect(error).toBeNull();
    const revisionSent = sent.find(s => s.step === '3.6-plan-revision');
    expect(revisionSent).toBeTruthy();
    const reevaluateSent = sent.find(s => s.step === '3.7-evaluate-qa-plan-revised');
    expect(reevaluateSent).toBeTruthy();
  }, 10000);
});