import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TaskCreateUpsertSchema, TaskStatusUpdateSchema, validate } from './helpers/dashboardSchemas.js';

// Mock undici fetch used by src/dashboard.ts
const calls: Array<{ url: string; init?: any; body?: any; method?: string }> = [];
function makeResponse(status: number, body: any) {
  const jsonText = body !== undefined ? JSON.stringify(body) : '';
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Map<string, string>(),
    async text() { return jsonText; },
    async json() { return body; },
    get headersRaw() { return this.headers; }
  } as any;
}

beforeEach(() => {
  calls.length = 0;
});

vi.mock('undici', () => {
  const defaultImpl = async (url: string, init?: any) => {
    let body: any = undefined;
    try { body = init?.body ? JSON.parse(init.body) : undefined; } catch { body = undefined; }
    calls.push({ url, init, method: init?.method || 'GET', body });
    // Default no-op success
    return makeResponse(200, {});
  };
  const fetch = vi.fn(defaultImpl);
  return { fetch };
});

describe('dashboard interactions', () => {
  it('createDashboardTask uses upsert and parent_task_external_id for non-UUID parent', async () => {
    const { createDashboardTask } = await import('../src/dashboard.js');

    // Arrange a single successful upsert response
    const resp = await createDashboardTask({
      projectId: '11111111-1111-1111-1111-111111111111',
      title: 'Test',
      description: 'Desc',
      externalId: 'ext-1',
      parentTaskId: 't-synth'
    });
    expect(resp?.ok).toBe(true);

  const call = calls.find(c => c.url.includes('/v1/tasks:upsert'));
    expect(call).toBeTruthy();
    expect(call?.body?.external_id).toBe('ext-1');
    // Should not send parent_task_id for non-UUID; should send parent_task_external_id
    expect(call?.body?.parent_task_id).toBeUndefined();
    expect(call?.body?.parent_task_external_id).toBe('t-synth');
  const val = validate(TaskCreateUpsertSchema, call?.body);
  expect(val.ok).toBe(true);
  });

  it('createDashboardTask falls back to legacy create when upsert not supported', async () => {
    // Swap fetch to return 405 for first upsert, then 201 for legacy create
    const { fetch } = await import('undici');
    let n = 0;
    (fetch as any).mockImplementation(async (url: string, init?: any) => {
      let body: any = undefined;
      try { body = init?.body ? JSON.parse(init.body) : undefined; } catch { body = undefined; }
      calls.push({ url, init, method: init?.method || 'GET', body });
      n++;
      if (url.includes('/v1/tasks:upsert')) return makeResponse(405, { error: 'method not allowed' });
      if (url.includes('/v1/tasks') && init?.method === 'POST') return makeResponse(201, { id: '22222222-2222-2222-2222-222222222222' });
      return makeResponse(200, {});
    });

    const { createDashboardTask } = await import('../src/dashboard.js');
    const resp = await createDashboardTask({
      projectId: '11111111-1111-1111-1111-111111111111',
      title: 'Test',
      description: 'Desc',
      externalId: 'ext-2'
    });
    expect(resp?.ok).toBe(true);
    const upsert = calls.find(c => c.url.includes('/v1/tasks:upsert'));
    const legacy = calls.find(c => c.url.endsWith('/v1/tasks') && c.method === 'POST');
    expect(upsert).toBeTruthy();
    expect(legacy).toBeTruthy();
  });

  it('fetchProjectMilestones uses /v1/projects/{id}/milestones', async () => {
    const { fetch } = await import('undici');
    (fetch as any).mockImplementation(async (url: string, init?: any) => {
      calls.push({ url, init, method: init?.method || 'GET' });
      if (url.includes('/v1/projects/') && url.includes('/milestones')) return makeResponse(200, { milestones: [] });
      return makeResponse(200, {});
    });
    const { fetchProjectMilestones } = await import('../src/dashboard.js');
    const pid = '33333333-3333-3333-3333-333333333333';
    const res = await fetchProjectMilestones(pid);
    expect(Array.isArray(res)).toBe(true);
    const call = calls.find(c => c.url.includes(`/v1/projects/${pid}/milestones`));
    expect(call).toBeTruthy();
  });

  it('updateTaskStatus resolves by external_id when 404 and retries by id', async () => {
    const { fetch } = await import('undici');
    (fetch as any).mockImplementation(async (url: string, init?: any) => {
      let body: any = undefined;
      try { body = init?.body ? JSON.parse(init.body) : undefined; } catch { body = undefined; }
      calls.push({ url, init, method: init?.method || 'GET', body });
      if (url.includes('/v1/tasks/by-external/')) return makeResponse(404, { detail: 'Not found' });
      if (url.includes('/v1/tasks/resolve')) return makeResponse(200, { id: '44444444-4444-4444-4444-444444444444' });
      if (url.includes('/v1/tasks/44444444-4444-4444-4444-444444444444/status')) return makeResponse(200, { ok: true });
      return makeResponse(200, {});
    });

    const { updateTaskStatus } = await import('../src/dashboard.js');
  const out = await updateTaskStatus('ext-missing', 'done');
    expect(out.ok).toBe(true);
    const byExternal = calls.find(c => c.url.includes('/v1/tasks/by-external/'));
    const resolve = calls.find(c => c.url.includes('/v1/tasks/resolve'));
    const byId = calls.find(c => c.url.includes('/v1/tasks/44444444-4444-4444-4444-444444444444/status'));
    expect(byExternal).toBeTruthy();
    expect(resolve).toBeTruthy();
    expect(byId).toBeTruthy();
  const statusPayload = byExternal?.body;
  const statusVal = validate(TaskStatusUpdateSchema, statusPayload);
  expect(statusVal.ok).toBe(true);
  });
});

describe('coordinator dashboard hygiene', () => {
  it('skips updateTaskStatus for synthetic task id', async () => {
    const coord = await import('../src/workflows/coordinator.js');
    let updateCalled = 0;
    const overrides: any = {
      fetchProjectStatus: async () => ({ id: 'p' }),
      fetchProjectStatusDetails: async () => ({}),
      fetchProjectNextAction: async () => ({}),
      resolveRepoFromPayload: async (p: any) => ({ repoRoot: process.cwd(), remote: '', branch: p.branch || 'main' }),
      getRepoMetadata: async () => ({ currentBranch: 'main', remoteSlug: null, remoteUrl: '' }),
      checkoutBranchFromBase: async () => {},
      ensureBranchPublished: async () => {},
      commitAndPushPaths: async () => ({ ok: true }),
      updateTaskStatus: async () => { updateCalled++; return { ok: true }; },
      selectNextMilestone: () => null,
      selectNextTask: () => null,
      runLeadCycle: async () => ({ success: true, result: { ops: [] } }),
      parseUnifiedDiffToEditSpec: async () => ({ ops: [] }),
      applyEditOps: async () => ({ changed: [] }),
      persona: {
        sendPersonaRequest: async () => ({ ok: true }),
        waitForPersonaCompletion: async () => ({ fields: { result: {} }, id: 'evt-test' }),
        parseEventResult: (r: any) => r,
        interpretPersonaStatus: (r: any) => ({ status: 'pass' })
      }
    };

    await (coord as any).handleCoordinator({}, { workflow_id: 'wf', project_id: 'sim-proj' }, { repo: process.cwd(), branch: 'main', project_id: 'sim-proj' }, overrides);
    // Because no task id was provided, coordinator synthesizes 't-synth' and must skip update
    expect(updateCalled).toBe(0);
  });
});
