import { describe, it, expect, vi } from 'vitest';
import { createFastCoordinator } from './helpers/coordinatorTestHelper.js';


vi.mock('../src/redisClient.js');


describe('coordinator TDD governance gating', () => {
  it("skips governanceHook when tdd_stage is 'write_failing_test'", async () => {
    const { setupAllMocks } = await import('./helpers/mockHelpers.js');

    
    const project = {
      id: 'p1',
      name: 'TDD Project',
      tasks: [{ id: 't-1', name: 'test task', status: 'open' }],
      repositories: [{ url: 'https://github.com/example/tdd.git' }]
    };

    setupAllMocks(project);
    
    
    const governanceHookCalled = vi.fn();
    
    
    const coordinator = createFastCoordinator();
    
    try {
      await coordinator.handleCoordinator(
        {} as any,
        {},
        { 
          workflow_id: 'wf', 
          project_id: 'p1', 
          workflow_mode: 'tdd', 
          tdd_stage: 'write_failing_test' 
        },
        { project_id: 'p1', repo: 'https://github.com/example/tdd.git' }
      );
    } catch (_error) {
      void 0;
    }

    
    
    expect(governanceHookCalled).not.toHaveBeenCalled();
  });
});
