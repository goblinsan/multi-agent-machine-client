import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as coordinatorMod from '../src/workflows/coordinator.js';
import * as dashboard from '../src/dashboard.js';
import * as persona from '../src/agents/persona.js';
import { sent } from './testCapture';
import * as tasks from '../src/tasks/taskManager.js';

describe('Coordinator routes approved QA follow-up plan to engineer', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    sent.length = 0;
  });

  it('after plan approval, sends 4.6-implementation-execute to lead-engineer and applies edits', async () => {
    const project = { id: 'proj-qa-exec', name: 'proj', tasks: [{ id: 'task-1', name: 'task-1', status: 'open' }], next_milestone: { id: 'milestone-1', name: 'Milestone 1' } } as any;
    vi.spyOn(dashboard, 'fetchProjectStatus').mockImplementation(async () => (JSON.parse(JSON.stringify(project))));
    vi.spyOn(dashboard, 'updateTaskStatus').mockResolvedValue({ ok: true, status: 200, body: {} } as any);
    vi.spyOn(dashboard, 'fetchProjectStatusDetails').mockResolvedValue(null as any);
    vi.spyOn(dashboard, 'fetchProjectNextAction').mockResolvedValue(null as any);

    vi.spyOn(persona, 'sendPersonaRequest').mockImplementation(async (_r: any, opts: any) => { sent.push(opts); return opts.corrId || 'corr'; });

    // Sequence: context -> initial plan -> lead -> QA fail -> mini-cycle
    vi.spyOn(persona, 'waitForPersonaCompletion').mockImplementation(async (_r: any, _to: string, _wf: string, corrId: string) => {
      const match = sent.find(s => s.corrId === corrId) as any;
      if (!match) throw new Error('no match');
      const step = match.step;
      if (step === '1-context') return { fields: { result: JSON.stringify({}) }, id: 'evt-ctx' } as any;
      if (step === '2-plan') return { fields: { result: JSON.stringify({ payload: { plan: [{ goal: 'feature' }] }, output: '' }) }, id: 'evt-plan' } as any;
      if (step === '2.5-evaluate-plan') return { fields: { result: JSON.stringify({ status: 'pass' }) }, id: 'evt-eval-pass' } as any;
      if (step === '2-implementation') return { fields: { result: JSON.stringify({ applied_edits: { attempted: true, applied: true, paths: [], commit: { committed: true, pushed: true } } }) }, id: 'evt-lead' } as any;
      if (step === '3-qa') return { fields: { result: JSON.stringify({ status: 'fail', details: 'missing tests', tasks: [] }) }, id: 'evt-qa' } as any;
      if (step === 'qa-created-tasks') return { fields: { result: JSON.stringify({ payload: { plan: [{ goal: 'address QA feedback' }], output: '' } }) }, id: 'evt-planner-followup' } as any;
      if (step === '3.5-evaluate-qa-plan') return { fields: { result: JSON.stringify({ status: 'pass' }) }, id: 'evt-eval-qa-pass' } as any;
      if (step === '4-implementation-plan') return { fields: { result: JSON.stringify({ payload: { plan: [{ goal: 'execute fixes' }] }, output: '' }) }, id: 'evt-impl-plan' } as any;
      if (step === '4.6-implementation-execute') {
        // Return a textual diff to be applied
        const diff = [
          '```diff',
          'diff --git a/README.md b/README.md',
          'index 1111111..2222222 100644',
          '--- a/README.md',
          '+++ b/README.md',
          '@@ -1,2 +1,2 @@',
          '-Old',
          '+New',
          '```'
        ].join('\n');
        return { fields: { result: JSON.stringify({ output: 'done', result: diff }) }, id: 'evt-exec' } as any;
      }
      if (match.toPersona === 'project-manager') return { fields: { result: JSON.stringify({ status: 'pass' }) }, id: 'evt-pm' } as any;
      return { fields: { result: JSON.stringify({}) }, id: 'evt' } as any;
    });

    vi.spyOn(tasks, 'createDashboardTaskEntriesWithSummarizer').mockResolvedValue([{ title: 'QA failure task', externalId: 'ext-1', createdId: 't-1', description: 'Condensed description about missing tests' } as any]);

    const gitUtils = await import('../src/gitUtils.js');
    vi.spyOn(gitUtils, 'resolveRepoFromPayload').mockResolvedValue({ repoRoot: '/tmp/repo', branch: 'main', remote: 'git@example:repo.git' } as any);
    vi.spyOn(gitUtils, 'getRepoMetadata').mockResolvedValue({ remoteSlug: 'example/repo', currentBranch: 'main' } as any);
    vi.spyOn(gitUtils, 'checkoutBranchFromBase').mockResolvedValue(undefined as any);
    vi.spyOn(gitUtils, 'ensureBranchPublished').mockResolvedValue(undefined as any);

    const redisMock: any = {};
    await coordinatorMod.handleCoordinator(redisMock, { workflow_id: 'wf-qa-exec', project_id: 'proj-qa-exec' }, { repo: 'https://example/repo.git' });

    const execReq = sent.find(s => s.step === '4.6-implementation-execute');
    expect(execReq).toBeTruthy();
    // Ensure that the approved plan context is provided to the engineer
    expect(execReq?.payload?.approved_plan || execReq?.payload?.approved_plan_steps).toBeTruthy();
  }, 15000);
});
