import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TaskCreateUpsertSchema, TaskStatusUpdateSchema, validate } from './helpers/dashboardSchemas.js';

// Mock Redis client (uses __mocks__/redisClient.js)
vi.mock('../src/redisClient.js');

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
    const { TaskAPI } = await import('../src/dashboard/TaskAPI.js');
    const taskAPI = new TaskAPI();
    const createDashboardTask = taskAPI.createDashboardTask.bind(taskAPI);

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

  it('createDashboardTask includes milestone_slug when milestoneId is missing', async () => {
    const { TaskAPI } = await import('../src/dashboard/TaskAPI.js');
    const taskAPI = new TaskAPI();
    const createDashboardTask = taskAPI.createDashboardTask.bind(taskAPI);

    const resp = await createDashboardTask({
      projectId: '11111111-1111-1111-1111-111111111111',
      title: 'Test with milestone slug',
      description: 'Desc',
      externalId: 'ext-mslug-1',
      milestoneSlug: 'future-enhancements'
    });
    expect(resp?.ok).toBe(true);

    const call = calls.find(c => c.url.includes('/v1/tasks:upsert'));
    expect(call).toBeTruthy();
    expect(call?.body?.milestone_id).toBeUndefined();
    expect(call?.body?.milestone_slug).toBe('future-enhancements');
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

    const { TaskAPI } = await import('../src/dashboard/TaskAPI.js');
    const taskAPI = new TaskAPI();
    const createDashboardTask = taskAPI.createDashboardTask.bind(taskAPI);
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

  it('fetchProjectMilestones uses /projects/{id}/milestones', async () => { // Fixed test name
    const { fetch } = await import('undici');
    (fetch as any).mockImplementation(async (url: string, init?: any) => {
      calls.push({ url, init, method: init?.method || 'GET' });
      if (url.includes('/projects/') && url.includes('/milestones')) return makeResponse(200, { milestones: [] }); // Fixed: removed /v1
      return makeResponse(200, {});
    });
    const { ProjectAPI } = await import('../src/dashboard/ProjectAPI.js');
    const projectAPI = new ProjectAPI();
    const fetchProjectMilestones = projectAPI.fetchProjectMilestones.bind(projectAPI);
    const pid = '33333333-3333-3333-3333-333333333333';
    const res = await fetchProjectMilestones(pid);
    expect(Array.isArray(res)).toBe(true);
    const call = calls.find(c => c.url.includes(`/projects/${pid}/milestones`)); // Fixed: removed /v1 prefix
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

    const { TaskAPI } = await import('../src/dashboard/TaskAPI.js');
    const taskAPI = new TaskAPI();
    // Don't provide projectId to force legacy path that uses by-external
    const updateTaskStatus = (taskId: string, status: string) => taskAPI.updateTaskStatus(taskId, status);
  const out = await updateTaskStatus('ext-missing', 'done');
    expect(out.ok).toBe(true);
    
    // Debug: log all calls to see what's happening
    // console.log('All calls:', calls.map(c => ({ url: c.url, method: c.method })));
    
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
    const { setupAllMocks, coordinatorMod } = await import('./helpers/mockHelpers.js');
    
    // Setup project with synthetic task structure
    const project = {
      id: 'proj-dashboard',
      name: 'Dashboard Test',
      tasks: [],  // No real tasks
      repositories: [{ url: 'https://example/repo.git' }]
    };

    const mocks = setupAllMocks(project);
    
    // Mock Redis to prevent connection issues
    const redisMock = {
      xGroupCreate: vi.fn().mockResolvedValue(null),
      xReadGroup: vi.fn().mockResolvedValue([]),
      xAck: vi.fn().mockResolvedValue(null),
      disconnect: vi.fn().mockResolvedValue(null),
      quit: vi.fn().mockResolvedValue(null),
      xRevRange: vi.fn().mockResolvedValue([]),
      xAdd: vi.fn().mockResolvedValue('test-id'),
      exists: vi.fn().mockResolvedValue(1)
    };

    // Act: Run coordinator with synthetic task (should not update task status)
    const coordinator = new coordinatorMod.WorkflowCoordinator();
    await coordinator.handleCoordinator(
      redisMock, 
      { workflow_id: 'wf-dashboard', project_id: 'proj-dashboard' }, 
      { repo: 'https://example/repo.git', task: { id: '1.1.2' } }
    );

    // Assert: No task status updates should occur for synthetic tasks
    expect(mocks.dashboard.updateTaskStatusSpy).not.toHaveBeenCalled();
  });
});
