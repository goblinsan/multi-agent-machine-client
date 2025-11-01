import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  TaskCreateUpsertSchema as _TaskCreateUpsertSchema, TaskStatusUpdateSchema as _TaskStatusUpdateSchema, validate as _validate } from './helpers/dashboardSchemas.js';


vi.mock('../src/redisClient.js');


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
    
    return makeResponse(200, {});
  };
  const fetch = vi.fn(defaultImpl);
  return { fetch };
});

describe('dashboard interactions', () => {
  it('createDashboardTask uses /projects/:projectId/tasks endpoint with external_id for idempotency', async () => {
    const { fetch } = await import('undici');
    (fetch as any).mockImplementation(async (url: string, init?: any) => {
      let body: any = undefined;
      try { body = init?.body ? JSON.parse(init.body) : undefined; } catch { body = undefined; }
      calls.push({ url, init, method: init?.method || 'GET', body });
      
      if (url.includes('/projects/') && url.includes('/tasks') && init?.method === 'POST') {
        return makeResponse(201, { id: '12345', external_id: body.external_id });
      }
      return makeResponse(200, {});
    });

    const { TaskAPI } = await import('../src/dashboard/TaskAPI.js');
    const taskAPI = new TaskAPI();
    const createDashboardTask = taskAPI.createDashboardTask.bind(taskAPI);

    const resp = await createDashboardTask({
      projectId: '11111111-1111-1111-1111-111111111111',
      title: 'Test',
      description: 'Desc',
      externalId: 'ext-1',
      parentTaskId: 't-synth'
    });
    expect(resp?.ok).toBe(true);

    const call = calls.find(c => c.url.includes('/projects/11111111-1111-1111-1111-111111111111/tasks'));
    expect(call).toBeTruthy();
    expect(call?.method).toBe('POST');
    expect(call?.body?.external_id).toBe('ext-1');
    expect(call?.body?.title).toBe('Test');
    
    expect(call?.body?.parent_task_id).toBeUndefined();
  });

  it('createDashboardTask includes milestone_id when resolved from slug', async () => {
    const { fetch } = await import('undici');
    (fetch as any).mockImplementation(async (url: string, init?: any) => {
      let body: any = undefined;
      try { body = init?.body ? JSON.parse(init.body) : undefined; } catch { body = undefined; }
      calls.push({ url, init, method: init?.method || 'GET', body });
      
      
      if (url.includes('/projects/') && url.includes('/milestones')) {
        return makeResponse(200, { 
          milestones: [{ id: 999, name: 'Future Enhancements', slug: 'future-enhancements' }] 
        });
      }
      
      
      if (url.includes('/projects/') && url.includes('/tasks') && init?.method === 'POST') {
        return makeResponse(201, { id: '12346', milestone_id: body.milestone_id });
      }
      
      return makeResponse(200, {});
    });

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

    const call = calls.find(c => c.url.includes('/projects/11111111-1111-1111-1111-111111111111/tasks') && c.method === 'POST');
    expect(call).toBeTruthy();
    expect(call?.body?.milestone_id).toBe(999);
  });

  it('createDashboardTask requires projectId', async () => {
    const { TaskAPI } = await import('../src/dashboard/TaskAPI.js');
    const taskAPI = new TaskAPI();
    const createDashboardTask = taskAPI.createDashboardTask.bind(taskAPI);
    
    const resp = await createDashboardTask({
      title: 'Test',
      description: 'Desc',
      externalId: 'ext-2'
    });
    
    expect(resp?.ok).toBe(false);
    expect(resp?.status).toBe(400);
  });

  it('fetchProjectMilestones uses /projects/{id}/milestones', async () => {
    const { fetch } = await import('undici');
    (fetch as any).mockImplementation(async (url: string, init?: any) => {
      calls.push({ url, init, method: init?.method || 'GET' });
      if (url.includes('/projects/') && url.includes('/milestones')) return makeResponse(200, { milestones: [] });
      return makeResponse(200, {});
    });
    const { ProjectAPI } = await import('../src/dashboard/ProjectAPI.js');
    const projectAPI = new ProjectAPI();
    const fetchProjectMilestones = projectAPI.fetchProjectMilestones.bind(projectAPI);
    const pid = '33333333-3333-3333-3333-333333333333';
    const res = await fetchProjectMilestones(pid);
    expect(Array.isArray(res)).toBe(true);
    const call = calls.find(c => c.url.includes(`/projects/${pid}/milestones`));
    expect(call).toBeTruthy();
  });

  it('updateTaskStatus requires projectId - throws error if missing', async () => {
    const { TaskAPI } = await import('../src/dashboard/TaskAPI.js');
    const taskAPI = new TaskAPI();
    
    
    await expect(taskAPI.updateTaskStatus('task-123', 'done')).rejects.toThrow('projectId is required');
  });
});
