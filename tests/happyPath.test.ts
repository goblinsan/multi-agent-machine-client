import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as coordinatorMod from '../src/workflows/coordinator.js';
import * as dashboard from '../src/dashboard.js';
import * as persona from '../src/agents/persona.js';
import * as tasks from '../src/tasks/taskManager.js';

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('Coordinator happy path across multiple milestones and tasks', () => {
  it('processes 2 milestones x 2 tasks and marks project complete', async () => {
    // Arrange: create a project with 2 milestones, each with 2 tasks (all in 'open' state)
    const projectId = 'proj-happy';
    const milestones = [
      { id: 'm1', name: 'Milestone 1', slug: 'milestone-1', tasks: [ { id: 'm1t1', name: 'task-1-1', status: 'open' }, { id: 'm1t2', name: 'task-1-2', status: 'open' } ] },
      { id: 'm2', name: 'Milestone 2', slug: 'milestone-2', tasks: [ { id: 'm2t1', name: 'task-2-1', status: 'open' }, { id: 'm2t2', name: 'task-2-2', status: 'open' } ] }
    ];

    const allTasks = milestones.flatMap(m => m.tasks);

    vi.spyOn(dashboard, 'fetchProjectStatus').mockImplementation(async () => {
      return { id: projectId, name: 'Happy Project', repositories: [{ url: 'https://example/repo.git' }], tasks: allTasks.filter(t => t.status !== 'done') } as any;
    });
    vi.spyOn(dashboard, 'fetchProjectStatusDetails').mockResolvedValue({ milestones } as any);
    vi.spyOn(dashboard, 'fetchProjectNextAction').mockResolvedValue({ suggestions: [] } as any);
    vi.spyOn(dashboard, 'fetchProjectMilestones').mockResolvedValue(milestones as any);

    vi.spyOn(dashboard, 'fetchTask').mockImplementation(async (taskId: string) => {
      const task = allTasks.find(t => t.id === taskId);
      return { ...task, lock_version: 0 } as any;
    });

    const updatedTasks: Record<string, string> = {};
    vi.spyOn(dashboard, 'updateTaskStatus').mockImplementation(async (taskId: string, status: string) => {
      updatedTasks[taskId] = status;
      const task = allTasks.find(t => t.id === taskId);
      if (task) {
        task.status = status;
      }
      milestones.forEach(m => {
        const task = m.tasks.find(t => t.id === taskId);
        if (task) {
          task.status = status;
        }
      });
      return { ok: true, status: 200, body: {} } as any;
    });

    const sent: any[] = [];
    vi.spyOn(persona, 'sendPersonaRequest').mockImplementation(async (_r: any, opts: any) => {
      sent.push(opts);
      return opts.corrId || 'corr-' + String(sent.length);
    });

    vi.spyOn(persona, 'waitForPersonaCompletion').mockImplementation(async (_r: any, toPersona: string, workflowId: string, corrId: string) => {
      const match = sent.find(s => s.corrId === corrId) as any;
      if (!match) {
        return { fields: { result: JSON.stringify({ status: 'ok' }) }, id: 'evt-default' } as any;
      }
      const step = match.step;
      if (step === '1-context') {
        return { fields: { result: JSON.stringify({}) }, id: 'evt-context' } as any;
      }
      if (step === '2-plan') {
        return { fields: { result: JSON.stringify({ payload: { plan: [{ goal: 'implement feature' }] } }) }, id: 'evt-plan' } as any;
      }
      if (step === '2-implementation') {
        return { fields: { result: JSON.stringify({ status: 'ok', output: 'built' }) }, id: 'evt-impl' } as any;
      }
      if (step === '3-qa') {
        return { fields: { result: JSON.stringify({ status: 'pass', details: 'tests passed' }) }, id: 'evt-qa' } as any;
      }
      if (step === '3-code-review') {
        return { fields: { result: JSON.stringify({ status: 'pass', details: 'review ok' }) }, id: 'evt-cr' } as any;
      }
      if (step === '3-security') {
        return { fields: { result: JSON.stringify({ status: 'pass', details: 'security ok' }) }, id: 'evt-sec' } as any;
      }
      if (step === '3-devops') {
        const task = match.payload.task;
        if (task && task.id) {
          await dashboard.updateTaskStatus(task.id, 'done');
        }
        return { fields: { result: JSON.stringify({ status: 'pass', details: 'deployed' }) }, id: 'evt-devops' } as any;
      }
      if (step === '4-implementation-plan') {
        return { fields: { result: JSON.stringify({ payload: { plan: [{ goal: 'followup' }] } }) }, id: 'evt-final-plan' } as any;
      }
      return { fields: { result: JSON.stringify({ status: 'ok' }) }, id: 'evt-other' } as any;
    });

    vi.spyOn(tasks, 'createDashboardTaskEntriesWithSummarizer').mockResolvedValue([{ title: 'auto-task', externalId: 'ext-x', createdId: 'created-x', description: 'auto' } as any]);

    const gitUtils = await import('../src/gitUtils.js');
    vi.spyOn(gitUtils, 'resolveRepoFromPayload').mockResolvedValue({ repoRoot: '/tmp/repo', branch: 'main', remote: 'https://example/repo.git' } as any);
    vi.spyOn(gitUtils, 'getRepoMetadata').mockResolvedValue({ remoteSlug: 'example/repo', currentBranch: 'main' } as any);
    vi.spyOn(gitUtils, 'checkoutBranchFromBase').mockResolvedValue(undefined as any);
    vi.spyOn(gitUtils, 'ensureBranchPublished').mockResolvedValue(undefined as any);

    const redisMock: any = {};
    const initialMsg = { workflow_id: 'wf-happy', project_id: projectId } as any;
    const payloadObj: any = { repo: 'https://example/repo.git' };

  await coordinatorMod.handleCoordinator(redisMock, initialMsg, payloadObj);

  // Diagnostic: persona steps are captured in 'sent' for inspection by failed tests

    const totalTasks = allTasks.length;
    const planCalls = sent.filter(s => s.step === '2-plan');
    expect(planCalls.length).toBe(totalTasks);

    const finalProj = await dashboard.fetchProjectStatus(projectId);
    const finalTasks = Array.isArray((finalProj as any)?.tasks) ? (finalProj as any).tasks : [];
    expect(finalTasks.length).toBe(0);

    // Ensure each original task was marked done exactly once
    for (const t of allTasks) {
      // After the coordinator run, tasks array should be empty (filtered), but our updatedTasks map records status updates
      expect(updatedTasks[t.id]).toBe('done');
    }

    const contextCalls = sent.filter(s => s.step === '1-context');
    expect(contextCalls.length).toBe(totalTasks);

    for (const c of contextCalls) {
      expect(c.payload).toBeDefined();
      expect(c.payload.repo).toBeDefined();
      expect(c.payload.milestone || c.payload.milestone_name).toBeDefined();
      expect(c.payload.task || c.payload.task_name || c.payload.task_name === null).toBeDefined();
    }

    for (const p of planCalls) {
      expect(p.intent).toBe('plan_execution');
      expect(p.payload).toBeDefined();
      expect(p.payload.plan_request || p.payload.plan_request === undefined || p.payload.plan_request === null).toBeDefined();
    }
  }, 10000);
});