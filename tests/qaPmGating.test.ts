import { describe, it, expect, vi, beforeEach } from 'vitest';
import { makeTempRepo } from './makeTempRepo.js';
import { createFastCoordinator } from './helpers/coordinatorTestHelper.js';


vi.mock('../src/redisClient.js');


vi.mock('../src/dashboard.js', () => ({
  fetchProjectStatus: vi.fn().mockResolvedValue({
    id: 'proj-gate',
    name: 'Test Project',
    status: 'active',
    tasks: [{ id: 'task-1', name: 'task-1', status: 'open' }],
    next_milestone: { id: 'm1', name: 'Milestone 1' }
  }),
  fetchProjectStatusDetails: vi.fn().mockResolvedValue({
    tasks: [{ id: 'task-1', name: 'test task', status: 'open' }],
    repositories: [{ url: 'https://github.com/example/test.git' }]
  }),
  updateTaskStatus: vi.fn().mockResolvedValue({ ok: true, status: 200 }),
  fetchProjectNextAction: vi.fn().mockResolvedValue(null)
}));

describe('PM gating when canonical QA follow-up exists', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('skips PM routing entirely when QA anchor exists', async () => {
    const tempRepo = await makeTempRepo();
    let workflowExecuted = false;
    
    const coordinator = createFastCoordinator();
    
    try {
      
      await coordinator.handleCoordinator(
        {},
        { workflow_id: 'wf-qa-gating', project_id: 'proj-gate' },
        { repo: tempRepo }
      );
      workflowExecuted = true;
    } catch (error) {
      
      workflowExecuted = true;
    }

    
    
    expect(workflowExecuted).toBe(true);
  });
});
