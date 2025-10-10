import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WorkflowCoordinator } from '../src/workflows/WorkflowCoordinator';
import { WorkflowEngine } from '../src/workflows/WorkflowEngine';

describe('WorkflowCoordinator Integration', () => {
  let coordinator: WorkflowCoordinator;
  let mockEngine: WorkflowEngine;

  beforeEach(() => {
    // Create a mock workflow engine
    mockEngine = new WorkflowEngine();
    coordinator = new WorkflowCoordinator(mockEngine);

    // Mock the external dependencies
    vi.mock('../src/dashboard.js', () => ({
      fetchProjectStatus: vi.fn().mockResolvedValue({
        name: 'Test Project',
        slug: 'test-project'
      }),
      fetchProjectStatusDetails: vi.fn().mockResolvedValue({
        milestones: [{
          id: 'milestone-1',
          name: 'Test Milestone',
          tasks: [{
            id: 'task-1',
            name: 'Test Task',
            status: 'open',
            description: 'A test task for workflow processing'
          }]
        }]
      })
    }));

    vi.mock('../src/gitUtils.js', () => ({
      resolveRepoFromPayload: vi.fn().mockResolvedValue({
        repoRoot: '/tmp/test-repo',
        branch: 'main'
      })
    }));
  });

  it('should determine task types correctly', () => {
    // Test hotfix detection
    expect(coordinator['determineTaskType']({ 
      name: 'Urgent hotfix for critical bug',
      description: 'Emergency fix needed' 
    })).toBe('hotfix');

    // Test feature detection
    expect(coordinator['determineTaskType']({ 
      name: 'New feature implementation',
      description: 'Add new user dashboard feature' 
    })).toBe('feature');

    // Test analysis detection
    expect(coordinator['determineTaskType']({ 
      name: 'Code review and analysis',
      description: 'Understand the current architecture' 
    })).toBe('analysis');

    // Test bugfix detection
    expect(coordinator['determineTaskType']({ 
      name: 'Fix broken login',
      description: 'Bug in authentication system' 
    })).toBe('bugfix');

    // Test default
    expect(coordinator['determineTaskType']({ 
      name: 'Regular task',
      description: 'Standard development work' 
    })).toBe('task');
  });

  it('should determine task scope correctly', () => {
    // Test large scope
    expect(coordinator['determineTaskScope']({ 
      name: 'Large comprehensive refactor',
      description: 'Major system overhaul' 
    })).toBe('large');

    // Test small scope
    expect(coordinator['determineTaskScope']({ 
      name: 'Small quick fix',
      description: 'Minor update needed' 
    })).toBe('small');

    // Test default medium scope
    expect(coordinator['determineTaskScope']({ 
      name: 'Standard task',
      description: 'Regular development work' 
    })).toBe('medium');
  });

  it('should normalize task status correctly', () => {
    expect(coordinator['normalizeTaskStatus']('done')).toBe('done');
    expect(coordinator['normalizeTaskStatus']('completed')).toBe('done');
    expect(coordinator['normalizeTaskStatus']('FINISHED')).toBe('done');
    
    expect(coordinator['normalizeTaskStatus']('in_progress')).toBe('in_progress');
    expect(coordinator['normalizeTaskStatus']('IN-PROGRESS')).toBe('in_progress');
    expect(coordinator['normalizeTaskStatus']('active')).toBe('in_progress');
    
    expect(coordinator['normalizeTaskStatus']('open')).toBe('open');
    expect(coordinator['normalizeTaskStatus']('NEW')).toBe('open');
    expect(coordinator['normalizeTaskStatus']('pending')).toBe('open');
    
    expect(coordinator['normalizeTaskStatus']('unknown_status')).toBe('unknown');
    expect(coordinator['normalizeTaskStatus']('')).toBe('unknown');
  });

  it('should extract repository remote correctly', () => {
    const details = { repository: { clone_url: 'https://github.com/test/repo.git' } };
    const projectInfo = { repo: { url: 'https://gitlab.com/test/repo.git' } };
    const payload = { repo: 'https://bitbucket.org/test/repo.git' };

    // Should prefer details first
    expect(coordinator['extractRepoRemote'](details, projectInfo, payload))
      .toBe('https://github.com/test/repo.git');

    // Should fall back to projectInfo
    expect(coordinator['extractRepoRemote']({}, projectInfo, payload))
      .toBe('https://gitlab.com/test/repo.git');

    // Should fall back to payload
    expect(coordinator['extractRepoRemote']({}, {}, payload))
      .toBe('https://bitbucket.org/test/repo.git');

    // Should return empty string if none found
    expect(coordinator['extractRepoRemote']({}, {}, {}))
      .toBe('');
  });

  it('should extract tasks from milestones correctly', () => {
    const details = {
      milestones: [{
        id: 'milestone-1',
        name: 'First Milestone',
        tasks: [
          { id: 'task-1', name: 'Task 1' },
          { id: 'task-2', name: 'Task 2' }
        ]
      }, {
        id: 'milestone-2',
        name: 'Second Milestone',
        tasks: [
          { id: 'task-3', name: 'Task 3' }
        ]
      }]
    };

    const tasks = coordinator['extractTasks'](details, {});
    
    expect(tasks).toHaveLength(3);
    expect(tasks[0]).toMatchObject({
      id: 'task-1',
      name: 'Task 1',
      milestone: { id: 'milestone-1', name: 'First Milestone' }
    });
    expect(tasks[1]).toMatchObject({
      id: 'task-2',
      name: 'Task 2',
      milestone: { id: 'milestone-1', name: 'First Milestone' }
    });
    expect(tasks[2]).toMatchObject({
      id: 'task-3',
      name: 'Task 3',
      milestone: { id: 'milestone-2', name: 'Second Milestone' }
    });
  });

  it('should extract tasks from project info as fallback', () => {
    const projectInfo = {
      tasks: [
        { id: 'direct-task-1', name: 'Direct Task 1' },
        { id: 'direct-task-2', name: 'Direct Task 2' }
      ]
    };

    const tasks = coordinator['extractTasks']({}, projectInfo);
    
    expect(tasks).toHaveLength(2);
    expect(tasks[0]).toMatchObject({ id: 'direct-task-1', name: 'Direct Task 1' });
    expect(tasks[1]).toMatchObject({ id: 'direct-task-2', name: 'Direct Task 2' });
  });

  it('should handle workflow loading', async () => {
    // Mock the loadWorkflowsFromDirectory method
    const mockDefinitions = [
      { 
        name: 'project-loop', 
        description: 'Standard project workflow',
        version: '1.0.0',
        trigger: { condition: 'task_type == "task"' },
        context: { repo_required: true },
        steps: []
      },
      { 
        name: 'hotfix', 
        description: 'Hotfix workflow',
        version: '1.0.0',
        trigger: { condition: 'task_type == "hotfix"' },
        context: { repo_required: true },
        steps: []
      },
      { 
        name: 'feature', 
        description: 'Feature workflow',
        version: '1.0.0',
        trigger: { condition: 'task_type == "feature"' },
        context: { repo_required: true },
        steps: []
      }
    ];

    vi.spyOn(mockEngine, 'loadWorkflowsFromDirectory').mockResolvedValue(mockDefinitions);
    vi.spyOn(mockEngine, 'getWorkflowDefinitions').mockReturnValue(mockDefinitions);

    await coordinator.loadWorkflows();

    expect(mockEngine.loadWorkflowsFromDirectory).toHaveBeenCalledWith(
      expect.stringContaining('src/workflows/definitions')
    );
  });
});

describe('WorkflowCoordinator Task Processing', () => {
  let coordinator: WorkflowCoordinator;
  let mockEngine: WorkflowEngine;

  beforeEach(() => {
    mockEngine = new WorkflowEngine();
    coordinator = new WorkflowCoordinator(mockEngine);

    // Mock successful workflow execution
    vi.spyOn(mockEngine, 'executeWorkflowDefinition').mockResolvedValue({
      success: true,
      completedSteps: ['pull-task', 'context', 'planning', 'code-gen', 'qa'],
      duration: 30000,
      finalContext: {} as any
    });

    // Mock workflow finding
    vi.spyOn(mockEngine, 'findWorkflowByCondition').mockReturnValue({
      name: 'project-loop',
      description: 'Standard project workflow',
      version: '1.0.0',
      trigger: { condition: 'task_type == "task"' },
      context: { repo_required: true },
      steps: []
    } as any);
  });

  it('should process a task with appropriate workflow', async () => {
    const task = {
      id: 'task-1',
      name: 'Implement user authentication',
      status: 'open',
      description: 'Add login functionality'
    };

    const context = {
      workflowId: 'test-workflow-123',
      projectId: 'project-1',
      projectName: 'Test Project',
      projectSlug: 'test-project',
      repoRoot: '/tmp/test-repo',
      branch: 'main'
    };

    const result = await coordinator['processTask'](task, context);

    expect(result).toMatchObject({
      success: true,
      workflowName: 'project-loop',
      taskId: 'task-1',
      completedSteps: ['pull-task', 'context', 'planning', 'code-gen', 'qa']
    });

    expect(mockEngine.findWorkflowByCondition).toHaveBeenCalledWith('task', 'medium');
    expect(mockEngine.executeWorkflowDefinition).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'project-loop' }),
      'project-1',
      '/tmp/test-repo',
      'main',
      expect.objectContaining({
        task,
        taskId: 'task-1',
        taskName: 'Implement user authentication',
        taskType: 'task',
        taskScope: 'medium'
      })
    );
  });

  it('should handle workflow execution failure', async () => {
    vi.spyOn(mockEngine, 'executeWorkflowDefinition').mockResolvedValue({
      success: false,
      completedSteps: ['pull-task', 'context'],
      failedStep: 'planning',
      error: new Error('Planning step failed'),
      duration: 15000,
      finalContext: {} as any
    });

    const task = {
      id: 'task-2',
      name: 'Broken task',
      status: 'open'
    };

    const context = {
      workflowId: 'test-workflow-456',
      projectId: 'project-1',
      projectName: 'Test Project',
      projectSlug: 'test-project',
      repoRoot: '/tmp/test-repo',
      branch: 'main'
    };

    const result = await coordinator['processTask'](task, context);

    expect(result).toMatchObject({
      success: false,
      workflowName: 'project-loop',
      taskId: 'task-2',
      completedSteps: ['pull-task', 'context'],
      failedStep: 'planning',
      error: 'Planning step failed'
    });
  });
});