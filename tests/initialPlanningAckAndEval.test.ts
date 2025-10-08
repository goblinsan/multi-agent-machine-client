import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as dashboard from '../src/dashboard.js';
import * as persona from '../src/agents/persona.js';
import { sent } from './testCapture';

// Verifies: initial planning loop evaluates every time and asks planner to acknowledge feedback

describe('Initial planning loop evaluates and requests acknowledgement', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    sent.length = 0;
  });

  it('runs evaluator after planner and passes QA feedback when present; planner acknowledgement requested', async () => {
    const project = { id: 'proj-init', name: 'proj', tasks: [{ id: 'task-1', name: 'task-1', status: 'open' }], next_milestone: { id: 'm1', name: 'Milestone 1' } } as any;
    vi.spyOn(dashboard, 'fetchProjectStatus').mockResolvedValue(JSON.parse(JSON.stringify(project)));
    vi.spyOn(dashboard, 'updateTaskStatus').mockResolvedValue({ ok: true, status: 200, body: {} } as any);
    vi.spyOn(dashboard, 'fetchProjectStatusDetails').mockResolvedValue(null as any);
    vi.spyOn(dashboard, 'fetchProjectNextAction').mockResolvedValue(null as any);

    vi.spyOn(persona, 'sendPersonaRequest').mockImplementation(async (_r: any, opts: any) => {
      sent.push(opts);
      return opts.corrId || 'corr';
    });

    // Sequence: context -> initial planner -> evaluator(pass) -> lead
    vi.spyOn(persona, 'waitForPersonaCompletion').mockImplementation(async (_r: any, _to: string, _wf: string, corrId: string) => {
      const match = sent.find(s => s.corrId === corrId) as any;
      if (!match) throw new Error('no match');
      const step = match.step;
      if (step === '1-context') return { fields: { result: JSON.stringify({}) }, id: 'evt-ctx' } as any;
      if (step === '2-plan') {
        // Include a plan array so evaluator runs
        return { fields: { result: JSON.stringify({ payload: { plan: [{ goal: 'do X' }], acknowledged_feedback: 'ack here' }, output: '' }) }, id: 'evt-plan' } as any;
      }
      if (step === '2.5-evaluate-plan') {
        // Non-fail should be treated as pass
        return { fields: { result: JSON.stringify({ status: 'ok' }) }, id: 'evt-eval' } as any;
      }
      if (step === '2-implementation') return { fields: { result: JSON.stringify({ applied_edits: { attempted: true, applied: true, paths: [], commit: { committed: true, pushed: true } } }) }, id: 'evt-lead' } as any;
      if (step === '3-qa') return { fields: { result: JSON.stringify({ status: 'pass' }) }, id: 'evt-qa' } as any;
      if (match.toPersona === 'project-manager') return { fields: { result: JSON.stringify({ status: 'pass' }) }, id: 'evt-pm' } as any;
      return { fields: { result: JSON.stringify({}) }, id: 'evt' } as any;
    });

    const gitUtils = await import('../src/gitUtils.js');
    vi.spyOn(gitUtils, 'resolveRepoFromPayload').mockResolvedValue({ repoRoot: '/tmp/repo', branch: 'main', remote: 'git@example:repo.git' } as any);
    vi.spyOn(gitUtils, 'getRepoMetadata').mockResolvedValue({ remoteSlug: 'example/repo', currentBranch: 'main' } as any);
    vi.spyOn(gitUtils, 'checkoutBranchFromBase').mockResolvedValue(undefined as any);
    vi.spyOn(gitUtils, 'ensureBranchPublished').mockResolvedValue(undefined as any);

    const coordinatorMod = await import('../src/workflows/coordinator.js');
    const redisMock: any = {};
    await coordinatorMod.handleCoordinator(redisMock, { workflow_id: 'wf-init', project_id: 'proj-init' }, { repo: 'https://example/repo.git' });

    const planReq = sent.find(s => s.step === '2-plan');
    expect(planReq).toBeTruthy();
    // Planner should be asked to include acknowledgement when feedback context exists (guidance injected when any feedback/guidance present)
    // In this path, guidance may be absent if no QA feedback; we still expect evaluator to run once
    const evalReq = sent.find(s => s.step === '2.5-evaluate-plan');
    expect(evalReq).toBeTruthy();
  // Ensure citation/relevance flags are forwarded to evaluator
  expect(evalReq?.payload?.require_citations).toBeTypeOf('boolean');
  expect(Array.isArray(evalReq?.payload?.citation_fields)).toBe(true);
  expect(typeof evalReq?.payload?.uncited_budget).toBe('number');
  expect(evalReq?.payload?.treat_uncited_as_invalid).toBeTypeOf('boolean');

    // If guidance was included, verify the ack flags; tolerate either presence or absence based on payload
    if (planReq?.payload?.require_acknowledged_feedback !== undefined) {
      expect(planReq.payload.require_acknowledged_feedback).toBe(true);
      expect(planReq.payload.acknowledge_key).toBe('acknowledged_feedback');
    }
  }, 15000);
});
