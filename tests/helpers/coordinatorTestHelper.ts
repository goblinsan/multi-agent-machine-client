import { vi } from 'vitest';
import { WorkflowCoordinator } from '../../src/workflows/WorkflowCoordinator.js';

/**
 * Helper utilities for coordinator integration tests
 * Provides dynamic task status mocking to prevent test hangs
 */

/**
 * Creates a fast coordinator instance with fetchProjectTasks mocked.
 * This prevents slow 10+ second timeouts from dashboard API calls during tests.
 * 
 * @returns WorkflowCoordinator instance with fast mocks applied
 */
export function createFastCoordinator(): WorkflowCoordinator {
  const coordinator = new WorkflowCoordinator();
  // Mock fetchProjectTasks to prevent slow dashboard API calls (10+ seconds)
  vi.spyOn(coordinator as any, 'fetchProjectTasks').mockImplementation(async () => {
    return [];
  });
  return coordinator;
}

/**
 * Creates a dynamic task status tracking system for coordinator tests.
 * Tasks will be automatically marked as "done" when processed, allowing
 * the coordinator loop to exit cleanly.
 * 
 * @param initialTasks Array of tasks with their initial statuses
 * @returns Object with task tracking and mock setup functions
 */
export function createDynamicTaskMocking(
  initialTasks: Array<{ id: string; name: string; status: string; order?: number }>
) {
  const taskStatuses = new Map(initialTasks.map(t => [t.id, t.status]));
  const taskData = new Map(initialTasks.map(t => [t.id, t]));
  
  return {
    /**
     * Get current status of a task
     */
    getStatus(taskId: string): string | undefined {
      return taskStatuses.get(taskId);
    },
    
    /**
     * Update a task's status
     */
    setStatus(taskId: string, status: string) {
      taskStatuses.set(taskId, status);
    },
    
    /**
     * Mark a task as done (useful in processTask mocks)
     */
    markDone(taskId: string) {
      taskStatuses.set(taskId, 'done');
    },
    
    /**
     * Set up dashboard mocks to return dynamic task data
     */
    async setupDashboardMocks() {
      const { fetchProjectStatusDetails, updateTaskStatus } = await import('../../src/dashboard.js');
      
      // Mock fetchProjectStatusDetails to return tasks dynamically
      (fetchProjectStatusDetails as any).mockImplementation(async () => ({
        tasks: Array.from(taskStatuses.entries())
          .map(([id, status]) => {
            const task = taskData.get(id)!;
            return { ...task, status };
          }),
        repositories: [{ url: 'https://example/repo.git' }]
      }));
      
      // Mock updateTaskStatus to track status changes
      (updateTaskStatus as any).mockImplementation(async (taskId: string, status: string) => {
        taskStatuses.set(taskId, status);
        return { ok: true, status: 200 };
      });
    }
  };
}
