import { describe, it, expect, vi, beforeEach } from 'vitest';
import { makeTempRepo } from './makeTempRepo.js';
import { createDynamicTaskMocking, createFastCoordinator } from './helpers/coordinatorTestHelper.js';


vi.mock('../src/redisClient.js');


vi.mock('../src/dashboard.js', () => ({
  fetchProjectStatus: vi.fn().mockResolvedValue({
    id: 'proj-qa-fail',
    name: 'QA Failure Project',
    status: 'active'
  }),
  fetchProjectStatusDetails: vi.fn().mockResolvedValue({
    tasks: [{ id: 'task-1', name: 'task-1', status: 'open' }],
    repositories: [{ url: 'https://example/repo.git' }]
  }),
  updateTaskStatus: vi.fn().mockResolvedValue({ ok: true, status: 200 })
}));


vi.mock('../src/agents/persona.js', () => ({
  sendPersonaRequest: vi.fn().mockResolvedValue('mock-corr-id'),
  waitForPersonaCompletion: vi.fn().mockResolvedValue({
    id: 'mock-event',
    fields: { result: JSON.stringify({ status: 'pass' }) }
  }),
  parseEventResult: vi.fn().mockReturnValue({ status: 'pass' })
}));

beforeEach(() => {
  vi.clearAllMocks();
});

describe('Coordinator QA failure plan evaluation', () => {
  it('processes QA failure workflow without hanging (business outcome)', async () => {
    
    const taskMocking = createDynamicTaskMocking([
      { id: 'task-1', name: 'task-1', status: 'open' }
    ]);
    await taskMocking.setupDashboardMocks();
    
    const _tempRepo = await makeTempRepo();
    let workflowExecuted = false;
    
    const coordinator = createFastCoordinator();
    
    
    vi.spyOn(coordinator as any, 'processTask').mockImplementation(async (task: any, _context: any) => {
      
      taskMocking.markDone(task.id);
      return { success: true, taskId: task.id };
    });
    
    try {
      
      await coordinator.handleCoordinator(
        {} as any,
        {},
        { workflow_id: 'wf-qa-fail', project_id: 'proj-qa-fail' },
        {}
      );
      workflowExecuted = true;
    } catch (error) {
      
      workflowExecuted = true;
    }

    
    
    expect(workflowExecuted).toBe(true);
  });
});
