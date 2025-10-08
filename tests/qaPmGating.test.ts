import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as coordinatorMod from '../src/workflows/coordinator.js';
import * as dashboard from '../src/dashboard.js';
import * as persona from '../src/agents/persona.js';
import { sent } from './testCapture';
import * as tasks from '../src/tasks/taskManager.js';

describe('PM gating when canonical QA follow-up exists', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    sent.length = 0;
  });

  it('skips PM routing entirely when QA anchor exists', async () => {
    const project = { id: 'proj-gate', name: 'proj', tasks: [{ id: 'task-1', name: 'task-1', status: 'open' }], next_milestone: { id: 'm1', name: 'Milestone 1' } } as any;
    vi.spyOn(dashboard, 'fetchProjectStatus').mockResolvedValue(JSON.parse(JSON.stringify(project)));
    vi.spyOn(dashboard, 'updateTaskStatus').mockResolvedValue({ ok: true, status: 200, body: {} } as any);
    vi.spyOn(dashboard, 'fetchProjectStatusDetails').mockResolvedValue(null as any);
    vi.spyOn(dashboard, 'fetchProjectNextAction').mockResolvedValue(null as any);

    vi.spyOn(persona, 'sendPersonaRequest').mockImplementation(async (_r: any, opts: any) => { sent.push(opts); return opts.corrId || 'c'; });
    vi.spyOn(persona, 'waitForPersonaCompletion').mockImplementation(async (_r: any, _to: string, _wf: string, corrId: string) => {
      const match = sent.find(s => s.corrId === corrId) as any;
      if (!match) throw new Error('no match');
      const step = match.step;
      if (step === '1-context') return { fields: { result: JSON.stringify({}) }, id: 'evt-ctx' } as any;
      if (step === '2-plan') return { fields: { result: JSON.stringify({ payload: { plan: [{ goal: 'feature' }] }, output: '' }) }, id: 'evt-plan' } as any;
      if (step === '2.5-evaluate-plan') return { fields: { result: JSON.stringify({ status: 'pass' }) }, id: 'evt-eval-pass' } as any;
      if (step === '2-implementation') return { fields: { result: JSON.stringify({ applied_edits: { attempted: true, applied: true, paths: [], commit: { committed: true, pushed: true } } }) }, id: 'evt-lead' } as any;
      if (step === '3-qa') return { fields: { result: JSON.stringify({ status: 'fail', details: 'missing tests' }) }, id: 'evt-qa' } as any;
      if (step === 'qa-created-tasks') return { fields: { result: JSON.stringify({ payload: { plan: [{ goal: 'address QA feedback' }] }, output: '' }) }, id: 'evt-plan-followup' } as any;
      if (step === '3.5-evaluate-qa-plan') return { fields: { result: JSON.stringify({ status: 'pass' }) }, id: 'evt-eval-qa' } as any;
      if (step === '4.6-implementation-execute') return { fields: { result: JSON.stringify({ applied_edits: { attempted: true, applied: true, paths: [], commit: { committed: true, pushed: true } } }) }, id: 'evt-exec' } as any;
      return { fields: { result: JSON.stringify({}) }, id: 'evt' } as any;
    });

    // Summarizer creates a canonical QA follow-up, implying anchor exists
    vi.spyOn(tasks, 'createDashboardTaskEntriesWithSummarizer').mockResolvedValue([{ title: 'QA failure task', externalId: 'ext-qa', createdId: 't-qa', description: 'desc' } as any]);
    // Make findTaskIdByExternalId resolve truthy to simulate canonical task exists in dashboard
    vi.spyOn(tasks, 'findTaskIdByExternalId').mockResolvedValue('t-qa');

    const gitUtils = await import('../src/gitUtils.js');
    vi.spyOn(gitUtils, 'resolveRepoFromPayload').mockResolvedValue({ repoRoot: '/tmp/repo', branch: 'main', remote: 'git@example:repo.git' } as any);
    vi.spyOn(gitUtils, 'getRepoMetadata').mockResolvedValue({ remoteSlug: 'example/repo', currentBranch: 'main' } as any);
    vi.spyOn(gitUtils, 'checkoutBranchFromBase').mockResolvedValue(undefined as any);
    vi.spyOn(gitUtils, 'ensureBranchPublished').mockResolvedValue(undefined as any);

    const redisMock: any = {};
    await coordinatorMod.handleCoordinator(redisMock, { workflow_id: 'wf-pm-gate', project_id: 'proj-gate' } as any, { repo: 'https://example/repo.git' });

    // Ensure no PM routing occurred
    const pmReq = sent.find(s => s.toPersona === 'project-manager' && s.step === '3-route');
    expect(pmReq).toBeFalsy();
  });
});
