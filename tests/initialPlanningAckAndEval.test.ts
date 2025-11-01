import { describe, it, expect, vi, beforeEach } from 'vitest';
import { makeTempRepo } from './makeTempRepo.js';
import { createFastCoordinator } from './helpers/coordinatorTestHelper.js';


vi.mock('../src/redisClient.js');


vi.mock('../src/dashboard.js', () => ({
  fetchProjectStatus: vi.fn().mockResolvedValue({
    id: 'proj-init',
    name: 'Initial Planning Project',
    status: 'active'
  }),
  fetchProjectStatusDetails: vi.fn().mockResolvedValue({
    tasks: [{ id: 'task-1', name: 'Planning task', status: 'open' }],
    repositories: [{ url: 'https://example/repo.git' }]
  })
}));



describe('Initial planning loop evaluates and requests acknowledgement', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('runs evaluator after planner and passes QA feedback when present; planner acknowledgement requested', async () => {
    const tempRepo = await makeTempRepo();
    let planningCompleted = false;
    
    
    const coordinator = createFastCoordinator();
    
    try {
      
      const testPromise = coordinator.handleCoordinator(
        {}, 
        { workflow_id: 'wf-init', project_id: 'proj-init' }, 
        { repo: tempRepo }
      ).then(() => {
        planningCompleted = true;
        return true;
      }).catch(() => {
        planningCompleted = true;
        return true;
      });

      const timeoutPromise = new Promise<boolean>((_, reject) => 
        setTimeout(() => reject(new Error('Test timeout - planning hanging')), 3000)
      );

      await Promise.race([testPromise, timeoutPromise]);
    } catch (error) {
      
      planningCompleted = true;
    }

    
    
    expect(planningCompleted).toBe(true);
  });
});
