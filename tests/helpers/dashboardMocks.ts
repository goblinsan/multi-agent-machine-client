/**
 * Dashboard Client Mock Helpers
 * 
 * Provides reusable mock implementations of DashboardClient for testing.
 * This file contains mock factories, response builders, and test data generators
 * to simplify testing of code that depends on the DashboardClient.
 * 
 * Usage:
 * ```typescript
 * import { createMockDashboardClient, mockTaskResponse } from './helpers/dashboardMocks';
 * 
 * const mockClient = createMockDashboardClient();
 * mockClient.bulkCreateTasks.mockResolvedValue(mockBulkCreateResponse({
 *   created: 2,
 *   skipped: 1
 * }));
 * ```
 */

import { vi } from 'vitest';
import type {
  Task,
  TaskCreateInput,
  TaskUpdateInput,
  BulkTaskCreateResponse,
  TaskListResponse
} from '../../src/services/DashboardClient';

// ============================================================================
// Mock Client Factory
// ============================================================================

/**
 * Creates a fully mocked DashboardClient instance with all methods mocked.
 * Default behavior returns successful responses. Override specific methods as needed.
 */
export function createMockDashboardClient() {
  return {
    createTask: vi.fn().mockResolvedValue(mockTaskResponse({ id: 1 })),
    bulkCreateTasks: vi.fn().mockResolvedValue(mockBulkCreateResponse()),
    updateTask: vi.fn().mockResolvedValue(mockTaskResponse({ id: 1 })),
    listTasks: vi.fn().mockResolvedValue(mockListTasksResponse()),
    getTask: vi.fn().mockResolvedValue(mockTaskResponse({ id: 1 }))
  };
}

// ============================================================================
// Response Builders
// ============================================================================

/**
 * Creates a mock Task response with default values.
 * Override any fields by passing them in the options object.
 */
export function mockTaskResponse(overrides: Partial<Task> = {}): Task {
  return {
    id: 1,
    project_id: 1,
    title: 'Test Task',
    description: 'Test task description',
    status: 'open',
    priority_score: 1200,
    milestone_id: null,
    milestone_slug: null,
    parent_task_id: null,
    labels: null,
    external_id: `test-${Date.now()}`,
    blocked_attempt_count: 0,
    last_unblock_attempt: null,
    review_status_qa: null,
    review_status_code: null,
    review_status_security: null,
    review_status_devops: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    completed_at: null,
    ...overrides
  };
}

/**
 * Creates a mock BulkTaskCreateResponse.
 * 
 * @param options Configuration for the response
 * @param options.created Number of tasks to create (default: 2)
 * @param options.skipped Number of tasks to skip (default: 0)
 * @param options.projectId Project ID for created tasks (default: 1)
 */
export function mockBulkCreateResponse(options: {
  created?: number;
  skipped?: number;
  projectId?: number;
} = {}): BulkTaskCreateResponse {
  const { created = 2, skipped = 0, projectId = 1 } = options;

  const createdTasks: Task[] = [];
  for (let i = 0; i < created; i++) {
    createdTasks.push(mockTaskResponse({
      id: i + 1,
      project_id: projectId,
      title: `Created Task ${i + 1}`,
      external_id: `created-${Date.now()}-${i}`
    }));
  }

  const skippedTasks: Array<{ task: Task; reason: string; external_id: string }> = [];
  for (let i = 0; i < skipped; i++) {
    const taskId = created + i + 1;
    skippedTasks.push({
      task: mockTaskResponse({
        id: taskId,
        project_id: projectId,
        title: `Skipped Task ${taskId}`,
        external_id: `skipped-${Date.now()}-${i}`
      }),
      reason: 'Task already exists',
      external_id: `skipped-${Date.now()}-${i}`
    });
  }

  return {
    created: createdTasks,
    skipped: skipped > 0 ? skippedTasks : undefined,
    summary: {
      totalRequested: created + skipped,
      created: createdTasks.length,
      skipped: skippedTasks.length
    }
  };
}

/**
 * Creates a mock TaskListResponse.
 * 
 * @param count Number of tasks to include in the list (default: 5)
 * @param projectId Project ID for all tasks (default: 1)
 */
export function mockListTasksResponse(count: number = 5, _projectId: number = 1): TaskListResponse {
  const tasks = [];
  for (let i = 0; i < count; i++) {
    const status: 'open' | 'in_progress' = i % 2 === 0 ? 'open' : 'in_progress';
    tasks.push({
      id: i + 1,
      title: `Task ${i + 1}`,
      status: status,
      priority_score: 1200 - (i * 100),
      milestone_id: i % 3 === 0 ? 1 : null,
      labels: i % 2 === 0 ? ['test', 'mock'] : null
    });
  }

  return { data: tasks };
}

// ============================================================================
// Test Data Generators
// ============================================================================

/**
 * Generates a TaskCreateInput object with default test values.
 */
export function mockTaskCreateInput(overrides: Partial<TaskCreateInput> = {}): TaskCreateInput {
  return {
    title: 'Test Task',
    description: 'Test task description',
    status: 'open',
    priority_score: 1200,
    external_id: `test-${Date.now()}-${Math.random().toString(36).substring(7)}`,
    ...overrides
  };
}

/**
 * Generates an array of TaskCreateInput objects for bulk operations.
 * 
 * @param count Number of tasks to generate (default: 5)
 * @param priorities Array of priority scores to cycle through (default: [1500, 1200, 800, 50])
 */
export function mockBulkTaskCreateInput(
  count: number = 5,
  priorities: number[] = [1500, 1200, 800, 50]
): TaskCreateInput[] {
  const tasks: TaskCreateInput[] = [];
  for (let i = 0; i < count; i++) {
    tasks.push(mockTaskCreateInput({
      title: `Bulk Task ${i + 1}`,
      priority_score: priorities[i % priorities.length],
      external_id: `bulk-${Date.now()}-${i}`
    }));
  }
  return tasks;
}

/**
 * Generates a TaskUpdateInput object for task updates.
 */
export function mockTaskUpdateInput(overrides: Partial<TaskUpdateInput> = {}): TaskUpdateInput {
  return {
    status: 'in_progress',
    ...overrides
  };
}

// ============================================================================
// Scenario Helpers
// ============================================================================

/**
 * Configures a mock client for a successful task creation scenario.
 * Returns a single created task with the specified priority.
 */
export function mockSuccessfulTaskCreation(
  mockClient: ReturnType<typeof createMockDashboardClient>,
  priority: 'critical' | 'high' | 'medium' | 'low' = 'high'
) {
  const priorityScores = {
    critical: 1500,
    high: 1200,
    medium: 800,
    low: 50
  };

  mockClient.createTask.mockResolvedValue(
    mockTaskResponse({
      priority_score: priorityScores[priority],
      title: `Test Task [${priority}]`
    })
  );

  return mockClient;
}

/**
 * Configures a mock client for a successful bulk task creation scenario.
 * Returns a mix of created and skipped tasks to simulate idempotency.
 */
export function mockSuccessfulBulkCreation(
  mockClient: ReturnType<typeof createMockDashboardClient>,
  options: {
    created?: number;
    skipped?: number;
  } = {}
) {
  mockClient.bulkCreateTasks.mockResolvedValue(
    mockBulkCreateResponse({
      created: options.created ?? 5,
      skipped: options.skipped ?? 0
    })
  );

  return mockClient;
}

/**
 * Configures a mock client for an idempotent task creation scenario.
 * First call creates a task, subsequent calls return existing task with 200 OK.
 */
export function mockIdempotentTaskCreation(
  mockClient: ReturnType<typeof createMockDashboardClient>,
  externalId: string = `idempotent-${Date.now()}`
) {
  const existingTask = mockTaskResponse({
    id: 42,
    external_id: externalId,
    title: 'Existing Task'
  });

  // First call: create (201)
  // Subsequent calls: return existing (200)
  mockClient.createTask
    .mockResolvedValueOnce(existingTask)
    .mockResolvedValue(existingTask);

  return mockClient;
}

/**
 * Configures a mock client for a bulk idempotent scenario.
 * First call creates all tasks, second call skips all tasks.
 */
export function mockIdempotentBulkCreation(
  mockClient: ReturnType<typeof createMockDashboardClient>,
  taskCount: number = 3
) {
  // First call: all created
  mockClient.bulkCreateTasks
    .mockResolvedValueOnce(mockBulkCreateResponse({
      created: taskCount,
      skipped: 0
    }))
    // Second call: all skipped
    .mockResolvedValue(mockBulkCreateResponse({
      created: 0,
      skipped: taskCount
    }));

  return mockClient;
}

/**
 * Configures a mock client for a task creation failure scenario.
 */
export function mockTaskCreationFailure(
  mockClient: ReturnType<typeof createMockDashboardClient>,
  errorMessage: string = 'Task creation failed'
) {
  mockClient.createTask.mockRejectedValue(new Error(errorMessage));
  mockClient.bulkCreateTasks.mockRejectedValue(new Error(errorMessage));

  return mockClient;
}

/**
 * Configures a mock client for a network/timeout failure scenario.
 */
export function mockNetworkFailure(
  mockClient: ReturnType<typeof createMockDashboardClient>
) {
  const error = new Error('fetch failed');
  error.name = 'FetchError';

  mockClient.createTask.mockRejectedValue(error);
  mockClient.bulkCreateTasks.mockRejectedValue(error);
  mockClient.listTasks.mockRejectedValue(error);

  return mockClient;
}

// ============================================================================
// Priority Mapping Helpers
// ============================================================================

/**
 * Maps priority strings to priority scores.
 * Matches the mapping in BulkTaskCreationStep.
 */
export function priorityToPriorityScore(priority: 'critical' | 'high' | 'medium' | 'low'): number {
  const mapping = {
    critical: 1500,
    high: 1200,
    medium: 800,
    low: 50
  };
  return mapping[priority];
}

/**
 * Determines if a priority score represents an urgent task.
 * Urgent threshold: priority_score >= 1000
 */
export function isUrgentPriority(priorityScore: number): boolean {
  return priorityScore >= 1000;
}

// ============================================================================
// Assertion Helpers
// ============================================================================

/**
 * Asserts that a BulkTaskCreateResponse has the expected counts.
 */
export function assertBulkCreateResponse(
  response: BulkTaskCreateResponse,
  expected: {
    created: number;
    skipped?: number;
  }
) {
  if (response.created.length !== expected.created) {
    throw new Error(
      `Expected ${expected.created} created tasks, got ${response.created.length}`
    );
  }

  const skippedCount = response.skipped?.length ?? 0;
  const expectedSkipped = expected.skipped ?? 0;
  
  if (skippedCount !== expectedSkipped) {
    throw new Error(
      `Expected ${expectedSkipped} skipped tasks, got ${skippedCount}`
    );
  }
}

/**
 * Asserts that a Task has the expected priority score.
 */
export function assertTaskPriority(
  task: Task,
  expectedPriority: 'critical' | 'high' | 'medium' | 'low'
) {
  const expectedScore = priorityToPriorityScore(expectedPriority);
  if (task.priority_score !== expectedScore) {
    throw new Error(
      `Expected priority_score ${expectedScore} (${expectedPriority}), got ${task.priority_score}`
    );
  }
}
