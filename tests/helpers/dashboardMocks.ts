

import { vi } from 'vitest';
import type {
  Task,
  TaskCreateInput,
  TaskUpdateInput,
  BulkTaskCreateResponse,
  TaskListResponse
} from '../../src/services/DashboardClient';






export function createMockDashboardClient() {
  return {
    createTask: vi.fn().mockResolvedValue(mockTaskResponse({ id: 1 })),
    bulkCreateTasks: vi.fn().mockResolvedValue(mockBulkCreateResponse()),
    updateTask: vi.fn().mockResolvedValue(mockTaskResponse({ id: 1 })),
    listTasks: vi.fn().mockResolvedValue(mockListTasksResponse()),
    getTask: vi.fn().mockResolvedValue(mockTaskResponse({ id: 1 }))
  };
}






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


export function mockTaskUpdateInput(overrides: Partial<TaskUpdateInput> = {}): TaskUpdateInput {
  return {
    status: 'in_progress',
    ...overrides
  };
}






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


export function mockIdempotentTaskCreation(
  mockClient: ReturnType<typeof createMockDashboardClient>,
  externalId: string = `idempotent-${Date.now()}`
) {
  const existingTask = mockTaskResponse({
    id: 42,
    external_id: externalId,
    title: 'Existing Task'
  });

  
  
  mockClient.createTask
    .mockResolvedValueOnce(existingTask)
    .mockResolvedValue(existingTask);

  return mockClient;
}


export function mockIdempotentBulkCreation(
  mockClient: ReturnType<typeof createMockDashboardClient>,
  taskCount: number = 3
) {
  
  mockClient.bulkCreateTasks
    .mockResolvedValueOnce(mockBulkCreateResponse({
      created: taskCount,
      skipped: 0
    }))
    
    .mockResolvedValue(mockBulkCreateResponse({
      created: 0,
      skipped: taskCount
    }));

  return mockClient;
}


export function mockTaskCreationFailure(
  mockClient: ReturnType<typeof createMockDashboardClient>,
  errorMessage: string = 'Task creation failed'
) {
  mockClient.createTask.mockRejectedValue(new Error(errorMessage));
  mockClient.bulkCreateTasks.mockRejectedValue(new Error(errorMessage));

  return mockClient;
}


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






export function priorityToPriorityScore(priority: 'critical' | 'high' | 'medium' | 'low'): number {
  const mapping = {
    critical: 1500,
    high: 1200,
    medium: 800,
    low: 50
  };
  return mapping[priority];
}


export function isUrgentPriority(priorityScore: number): boolean {
  return priorityScore >= 1000;
}






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
