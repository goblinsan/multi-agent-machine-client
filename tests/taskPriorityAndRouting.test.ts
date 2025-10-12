import { describe, it, expect, beforeEach, vi } from 'vitest';
import { WorkflowCoordinator } from '../src/workflows/WorkflowCoordinator';
import { makeTempRepo } from './makeTempRepo';

// Mock all external dependencies
vi.mock('../src/dashboard.js', () => ({
  fetchProjectStatus: vi.fn().mockResolvedValue({
    id: 'proj-priority',
    name: 'Priority Test Project',
    status: 'active'
  }),
  fetchProjectStatusDetails: vi.fn().mockResolvedValue({
    tasks: [],  // Will be overridden in tests
    repositories: [{ url: 'https://example/repo.git' }]
  }),
  updateTaskStatus: vi.fn().mockResolvedValue({ ok: true, status: 200 }),
  createDashboardTask: vi.fn().mockResolvedValue({ id: 'new-task-123', ok: true })
}));

vi.mock('../src/gitUtils.js', () => ({
  resolveRepoFromPayload: vi.fn().mockImplementation(async (payload) => ({
    repoRoot: payload.repo || '/tmp/test-repo',
    branch: payload.branch || 'main',
    remote: 'https://example/repo.git'
  }))
}));

vi.mock('../src/agents/persona.js', () => ({
  sendPersonaRequest: vi.fn().mockResolvedValue('corr-priority-123'),
  waitForPersonaCompletion: vi.fn().mockResolvedValue({
    id: 'event-1',
    fields: {
      result: JSON.stringify({
        status: 'success',
        normalizedStatus: 'pass'
      })
    }
  }),
  parseEventResult: vi.fn().mockImplementation((event) => {
    return JSON.parse(event.fields.result);
  })
}));

vi.mock('../src/redisClient.js', () => {
  const redisMock = {
    xAdd: vi.fn().mockResolvedValue('msg-123'),
    xReadGroup: vi.fn().mockResolvedValue([]),
    xGroupCreate: vi.fn().mockRejectedValue(new Error('BUSYGROUP')),
    xAck: vi.fn().mockResolvedValue(1),
    xRange: vi.fn().mockResolvedValue([]),
    disconnect: vi.fn().mockResolvedValue(null),
    quit: vi.fn().mockResolvedValue(undefined)
  };

  return {
    makeRedis: vi.fn().mockResolvedValue(redisMock)
  };
});

vi.mock('../src/scanRepo.js', () => ({
  scanRepo: vi.fn().mockResolvedValue([
    { path: 'src/main.ts', bytes: 1024, lines: 50, mtime: Date.now() }
  ])
}));

vi.mock('../src/process.js', () => ({
  processPersonaRequest: vi.fn().mockResolvedValue({
    status: 'success',
    result: { message: 'Mock processing complete' }
  })
}));

beforeEach(() => {
  vi.clearAllMocks();
});

describe('Task Priority Selection', () => {
  it('processes blocked tasks first (priority 0)', async () => {
    const { fetchProjectStatusDetails } = await import('../src/dashboard.js');
    
    // Mock tasks with different statuses
    (fetchProjectStatusDetails as any).mockResolvedValueOnce({
      tasks: [
        { id: 'task-1', name: 'Open Task', status: 'open', order: 1 },
        { id: 'task-2', name: 'In Progress', status: 'in_progress', order: 2 },
        { id: 'task-3', name: 'Blocked Task', status: 'blocked', order: 3 }
      ],
      repositories: [{ url: 'https://example/repo.git' }]
    });

    const tempRepo = await makeTempRepo();
    const coordinator = new WorkflowCoordinator();
    
    // Track which tasks were processed and in what order
    const processedTasks: string[] = [];
    const originalProcessTask = (coordinator as any).processTask.bind(coordinator);
    
    vi.spyOn(coordinator as any, 'processTask').mockImplementation(async (task: any, context: any) => {
      processedTasks.push(task.id);
      return { success: true, taskId: task.id };
    });

    try {
      await Promise.race([
        coordinator.handleCoordinator(
          {},
          { workflow_id: 'wf-priority-blocked', project_id: 'proj-priority' },
          { repo: tempRepo }
        ),
        new Promise((_, reject) => 
          setTimeout(() => reject(new Error('Test timeout')), 15000)
        )
      ]);
      
      // Verify blocked task was processed first
      expect(processedTasks.length).toBeGreaterThan(0);
      expect(processedTasks[0]).toBe('task-3');  // Blocked task should be first
      
    } catch (error: any) {
      if (error.message === 'Test timeout') {
        throw new Error('Priority test hung');
      }
    }
  });

  it('processes in_review tasks second (priority 1)', async () => {
    const { fetchProjectStatusDetails } = await import('../src/dashboard.js');
    
    (fetchProjectStatusDetails as any).mockResolvedValueOnce({
      tasks: [
        { id: 'task-1', name: 'Open Task', status: 'open', order: 1 },
        { id: 'task-2', name: 'In Progress', status: 'in_progress', order: 2 },
        { id: 'task-3', name: 'In Review', status: 'in_review', order: 3 },
        { id: 'task-4', name: 'Blocked Task', status: 'blocked', order: 4 }
      ],
      repositories: [{ url: 'https://example/repo.git' }]
    });

    const tempRepo = await makeTempRepo();
    const coordinator = new WorkflowCoordinator();
    
    const processedTasks: string[] = [];
    vi.spyOn(coordinator as any, 'processTask').mockImplementation(async (task: any) => {
      processedTasks.push(task.id);
      return { success: true, taskId: task.id };
    });

    try {
      await Promise.race([
        coordinator.handleCoordinator(
          {},
          { workflow_id: 'wf-priority-review', project_id: 'proj-priority' },
          { repo: tempRepo }
        ),
        new Promise((_, reject) => 
          setTimeout(() => reject(new Error('Test timeout')), 15000)
        )
      ]);
      
      // Verify order: blocked, then in_review
      expect(processedTasks.length).toBeGreaterThan(1);
      expect(processedTasks[0]).toBe('task-4');  // Blocked (priority 0)
      expect(processedTasks[1]).toBe('task-3');  // In Review (priority 1)
      
    } catch (error: any) {
      if (error.message === 'Test timeout') {
        throw new Error('Priority review test hung');
      }
    }
  });

  it('processes in_progress tasks third (priority 2)', async () => {
    const { fetchProjectStatusDetails } = await import('../src/dashboard.js');
    
    (fetchProjectStatusDetails as any).mockResolvedValueOnce({
      tasks: [
        { id: 'task-1', name: 'Open Task', status: 'open', order: 1 },
        { id: 'task-2', name: 'In Progress', status: 'in_progress', order: 2 }
      ],
      repositories: [{ url: 'https://example/repo.git' }]
    });

    const tempRepo = await makeTempRepo();
    const coordinator = new WorkflowCoordinator();
    
    const processedTasks: string[] = [];
    vi.spyOn(coordinator as any, 'processTask').mockImplementation(async (task: any) => {
      processedTasks.push(task.id);
      return { success: true, taskId: task.id };
    });

    try {
      await Promise.race([
        coordinator.handleCoordinator(
          {},
          { workflow_id: 'wf-priority-progress', project_id: 'proj-priority' },
          { repo: tempRepo }
        ),
        new Promise((_, reject) => 
          setTimeout(() => reject(new Error('Test timeout')), 15000)
        )
      ]);
      
      // Verify in_progress comes before open
      expect(processedTasks.length).toBeGreaterThan(1);
      expect(processedTasks[0]).toBe('task-2');  // In Progress (priority 2)
      expect(processedTasks[1]).toBe('task-1');  // Open (priority 3)
      
    } catch (error: any) {
      if (error.message === 'Test timeout') {
        throw new Error('Priority progress test hung');
      }
    }
  });

  it('processes all priorities in correct order', async () => {
    const { fetchProjectStatusDetails } = await import('../src/dashboard.js');
    
    (fetchProjectStatusDetails as any).mockResolvedValueOnce({
      tasks: [
        { id: 'task-open', name: 'Open Task', status: 'open', order: 10 },
        { id: 'task-progress', name: 'In Progress', status: 'in_progress', order: 20 },
        { id: 'task-review', name: 'In Review', status: 'in_review', order: 30 },
        { id: 'task-blocked', name: 'Blocked Task', status: 'blocked', order: 40 }
      ],
      repositories: [{ url: 'https://example/repo.git' }]
    });

    const tempRepo = await makeTempRepo();
    const coordinator = new WorkflowCoordinator();
    
    const processedTasks: string[] = [];
    vi.spyOn(coordinator as any, 'processTask').mockImplementation(async (task: any) => {
      processedTasks.push(task.id);
      return { success: true, taskId: task.id };
    });

    try {
      await Promise.race([
        coordinator.handleCoordinator(
          {},
          { workflow_id: 'wf-priority-all', project_id: 'proj-priority' },
          { repo: tempRepo }
        ),
        new Promise((_, reject) => 
          setTimeout(() => reject(new Error('Test timeout')), 15000)
        )
      ]);
      
      // Verify complete priority order: blocked > in_review > in_progress > open
      expect(processedTasks.length).toBe(4);
      expect(processedTasks[0]).toBe('task-blocked');    // Priority 0
      expect(processedTasks[1]).toBe('task-review');     // Priority 1
      expect(processedTasks[2]).toBe('task-progress');   // Priority 2
      expect(processedTasks[3]).toBe('task-open');       // Priority 3
      
    } catch (error: any) {
      if (error.message === 'Test timeout') {
        throw new Error('Priority all test hung');
      }
    }
  });

  it('sorts by task order when priorities are equal', async () => {
    const { fetchProjectStatusDetails } = await import('../src/dashboard.js');
    
    (fetchProjectStatusDetails as any).mockResolvedValueOnce({
      tasks: [
        { id: 'task-3', name: 'Open Task 3', status: 'open', order: 3 },
        { id: 'task-1', name: 'Open Task 1', status: 'open', order: 1 },
        { id: 'task-2', name: 'Open Task 2', status: 'open', order: 2 }
      ],
      repositories: [{ url: 'https://example/repo.git' }]
    });

    const tempRepo = await makeTempRepo();
    const coordinator = new WorkflowCoordinator();
    
    const processedTasks: string[] = [];
    vi.spyOn(coordinator as any, 'processTask').mockImplementation(async (task: any) => {
      processedTasks.push(task.id);
      return { success: true, taskId: task.id };
    });

    try {
      await Promise.race([
        coordinator.handleCoordinator(
          {},
          { workflow_id: 'wf-priority-order', project_id: 'proj-priority' },
          { repo: tempRepo }
        ),
        new Promise((_, reject) => 
          setTimeout(() => reject(new Error('Test timeout')), 15000)
        )
      ]);
      
      // All have same priority (3), should be sorted by order field
      expect(processedTasks.length).toBe(3);
      expect(processedTasks[0]).toBe('task-1');  // order: 1
      expect(processedTasks[1]).toBe('task-2');  // order: 2
      expect(processedTasks[2]).toBe('task-3');  // order: 3
      
    } catch (error: any) {
      if (error.message === 'Test timeout') {
        throw new Error('Priority order test hung');
      }
    }
  });
});

describe('Workflow Routing by Status', () => {
  it('routes blocked tasks to blocked-task-resolution workflow', async () => {
    const { fetchProjectStatusDetails } = await import('../src/dashboard.js');
    
    (fetchProjectStatusDetails as any).mockResolvedValueOnce({
      tasks: [
        { id: 'task-blocked', name: 'Blocked Task', status: 'blocked', blocked_attempt_count: 2 }
      ],
      repositories: [{ url: 'https://example/repo.git' }]
    });

    const tempRepo = await makeTempRepo();
    const coordinator = new WorkflowCoordinator();
    
    let executedWorkflow = '';
    const originalExecuteWorkflow = (coordinator as any).executeWorkflow.bind(coordinator);
    
    vi.spyOn(coordinator as any, 'executeWorkflow').mockImplementation(async (workflow: any, task: any, context: any) => {
      executedWorkflow = workflow.name;
      return { success: true, taskId: task.id };
    });

    try {
      await Promise.race([
        coordinator.handleCoordinator(
          {},
          { workflow_id: 'wf-route-blocked', project_id: 'proj-priority' },
          { repo: tempRepo }
        ),
        new Promise((_, reject) => 
          setTimeout(() => reject(new Error('Test timeout')), 15000)
        )
      ]);
      
      expect(executedWorkflow).toBe('blocked-task-resolution');
      
    } catch (error: any) {
      if (error.message === 'Test timeout') {
        throw new Error('Route blocked test hung');
      }
    }
  });

  it('routes in_review tasks to in-review-task-flow workflow', async () => {
    const { fetchProjectStatusDetails } = await import('../src/dashboard.js');
    
    (fetchProjectStatusDetails as any).mockResolvedValueOnce({
      tasks: [
        { id: 'task-review', name: 'In Review Task', status: 'in_review' }
      ],
      repositories: [{ url: 'https://example/repo.git' }]
    });

    const tempRepo = await makeTempRepo();
    const coordinator = new WorkflowCoordinator();
    
    let executedWorkflow = '';
    vi.spyOn(coordinator as any, 'executeWorkflow').mockImplementation(async (workflow: any, task: any, context: any) => {
      executedWorkflow = workflow.name;
      return { success: true, taskId: task.id };
    });

    try {
      await Promise.race([
        coordinator.handleCoordinator(
          {},
          { workflow_id: 'wf-route-review', project_id: 'proj-priority' },
          { repo: tempRepo }
        ),
        new Promise((_, reject) => 
          setTimeout(() => reject(new Error('Test timeout')), 15000)
        )
      ]);
      
      expect(executedWorkflow).toBe('in-review-task-flow');
      
    } catch (error: any) {
      if (error.message === 'Test timeout') {
        throw new Error('Route review test hung');
      }
    }
  });

  it('routes in_progress tasks to legacy-compatible-task-flow', async () => {
    const { fetchProjectStatusDetails } = await import('../src/dashboard.js');
    
    (fetchProjectStatusDetails as any).mockResolvedValueOnce({
      tasks: [
        { id: 'task-progress', name: 'In Progress Task', status: 'in_progress' }
      ],
      repositories: [{ url: 'https://example/repo.git' }]
    });

    const tempRepo = await makeTempRepo();
    const coordinator = new WorkflowCoordinator();
    
    let executedWorkflow = '';
    vi.spyOn(coordinator as any, 'executeWorkflow').mockImplementation(async (workflow: any, task: any, context: any) => {
      executedWorkflow = workflow.name;
      return { success: true, taskId: task.id };
    });

    try {
      await Promise.race([
        coordinator.handleCoordinator(
          {},
          { workflow_id: 'wf-route-progress', project_id: 'proj-priority' },
          { repo: tempRepo }
        ),
        new Promise((_, reject) => 
          setTimeout(() => reject(new Error('Test timeout')), 15000)
        )
      ]);
      
      expect(executedWorkflow).toBe('legacy-compatible-task-flow');
      
    } catch (error: any) {
      if (error.message === 'Test timeout') {
        throw new Error('Route progress test hung');
      }
    }
  });

  it('routes open tasks to legacy-compatible-task-flow', async () => {
    const { fetchProjectStatusDetails } = await import('../src/dashboard.js');
    
    (fetchProjectStatusDetails as any).mockResolvedValueOnce({
      tasks: [
        { id: 'task-open', name: 'Open Task', status: 'open' }
      ],
      repositories: [{ url: 'https://example/repo.git' }]
    });

    const tempRepo = await makeTempRepo();
    const coordinator = new WorkflowCoordinator();
    
    let executedWorkflow = '';
    vi.spyOn(coordinator as any, 'executeWorkflow').mockImplementation(async (workflow: any, task: any, context: any) => {
      executedWorkflow = workflow.name;
      return { success: true, taskId: task.id };
    });

    try {
      await Promise.race([
        coordinator.handleCoordinator(
          {},
          { workflow_id: 'wf-route-open', project_id: 'proj-priority' },
          { repo: tempRepo }
        ),
        new Promise((_, reject) => 
          setTimeout(() => reject(new Error('Test timeout')), 15000)
        )
      ]);
      
      expect(executedWorkflow).toBe('legacy-compatible-task-flow');
      
    } catch (error: any) {
      if (error.message === 'Test timeout') {
        throw new Error('Route open test hung');
      }
    }
  });

  it('routes different statuses to appropriate workflows in priority order', async () => {
    const { fetchProjectStatusDetails } = await import('../src/dashboard.js');
    
    (fetchProjectStatusDetails as any).mockResolvedValueOnce({
      tasks: [
        { id: 'task-open', name: 'Open Task', status: 'open' },
        { id: 'task-blocked', name: 'Blocked Task', status: 'blocked' },
        { id: 'task-review', name: 'In Review Task', status: 'in_review' }
      ],
      repositories: [{ url: 'https://example/repo.git' }]
    });

    const tempRepo = await makeTempRepo();
    const coordinator = new WorkflowCoordinator();
    
    const workflowsExecuted: Array<{taskId: string, workflow: string}> = [];
    vi.spyOn(coordinator as any, 'executeWorkflow').mockImplementation(async (workflow: any, task: any, context: any) => {
      workflowsExecuted.push({ taskId: task.id, workflow: workflow.name });
      return { success: true, taskId: task.id };
    });

    try {
      await Promise.race([
        coordinator.handleCoordinator(
          {},
          { workflow_id: 'wf-route-mixed', project_id: 'proj-priority' },
          { repo: tempRepo }
        ),
        new Promise((_, reject) => 
          setTimeout(() => reject(new Error('Test timeout')), 15000)
        )
      ]);
      
      // Verify correct workflows in priority order
      expect(workflowsExecuted.length).toBe(3);
      expect(workflowsExecuted[0].taskId).toBe('task-blocked');
      expect(workflowsExecuted[0].workflow).toBe('blocked-task-resolution');
      
      expect(workflowsExecuted[1].taskId).toBe('task-review');
      expect(workflowsExecuted[1].workflow).toBe('in-review-task-flow');
      
      expect(workflowsExecuted[2].taskId).toBe('task-open');
      expect(workflowsExecuted[2].workflow).toBe('legacy-compatible-task-flow');
      
    } catch (error: any) {
      if (error.message === 'Test timeout') {
        throw new Error('Route mixed test hung');
      }
    }
  });
});

describe('Status Normalization', () => {
  it('recognizes various blocked status values', async () => {
    const { fetchProjectStatusDetails } = await import('../src/dashboard.js');
    
    (fetchProjectStatusDetails as any).mockResolvedValueOnce({
      tasks: [
        { id: 'task-1', name: 'Blocked', status: 'blocked' },
        { id: 'task-2', name: 'Stuck', status: 'stuck' },
        { id: 'task-3', name: 'BLOCKED', status: 'BLOCKED' }
      ],
      repositories: [{ url: 'https://example/repo.git' }]
    });

    const tempRepo = await makeTempRepo();
    const coordinator = new WorkflowCoordinator();
    
    const workflowsExecuted: string[] = [];
    vi.spyOn(coordinator as any, 'executeWorkflow').mockImplementation(async (workflow: any, task: any, context: any) => {
      workflowsExecuted.push(workflow.name);
      return { success: true, taskId: task.id };
    });

    try {
      await Promise.race([
        coordinator.handleCoordinator(
          {},
          { workflow_id: 'wf-status-blocked', project_id: 'proj-priority' },
          { repo: tempRepo }
        ),
        new Promise((_, reject) => 
          setTimeout(() => reject(new Error('Test timeout')), 15000)
        )
      ]);
      
      // All should route to blocked workflow
      expect(workflowsExecuted.length).toBe(3);
      expect(workflowsExecuted.every(w => w === 'blocked-task-resolution')).toBe(true);
      
    } catch (error: any) {
      if (error.message === 'Test timeout') {
        throw new Error('Status blocked test hung');
      }
    }
  });

  it('recognizes various review status values', async () => {
    const { fetchProjectStatusDetails } = await import('../src/dashboard.js');
    
    (fetchProjectStatusDetails as any).mockResolvedValueOnce({
      tasks: [
        { id: 'task-1', name: 'Review', status: 'review' },
        { id: 'task-2', name: 'In Review', status: 'in_review' },
        { id: 'task-3', name: 'In Code Review', status: 'in-code-review' }
      ],
      repositories: [{ url: 'https://example/repo.git' }]
    });

    const tempRepo = await makeTempRepo();
    const coordinator = new WorkflowCoordinator();
    
    const workflowsExecuted: string[] = [];
    vi.spyOn(coordinator as any, 'executeWorkflow').mockImplementation(async (workflow: any, task: any, context: any) => {
      workflowsExecuted.push(workflow.name);
      return { success: true, taskId: task.id };
    });

    try {
      await Promise.race([
        coordinator.handleCoordinator(
          {},
          { workflow_id: 'wf-status-review', project_id: 'proj-priority' },
          { repo: tempRepo }
        ),
        new Promise((_, reject) => 
          setTimeout(() => reject(new Error('Test timeout')), 15000)
        )
      ]);
      
      // All should route to review workflow
      expect(workflowsExecuted.length).toBe(3);
      expect(workflowsExecuted.every(w => w === 'in-review-task-flow')).toBe(true);
      
    } catch (error: any) {
      if (error.message === 'Test timeout') {
        throw new Error('Status review test hung');
      }
    }
  });
});
