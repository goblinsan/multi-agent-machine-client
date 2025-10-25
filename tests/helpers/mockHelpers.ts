import { vi } from 'vitest';
import { ProjectAPI } from '../../src/dashboard/ProjectAPI.js';
import { TaskAPI } from '../../src/dashboard/TaskAPI.js';
import * as persona from '../../src/agents/persona.js';
import * as tasks from '../../src/tasks/taskManager.js';
import * as fileops from '../../src/fileops.js';
import * as gitUtils from '../../src/gitUtils.js';
import { sent } from '../testCapture.js';

/**
 * Common test helper utilities for mocking Redis, personas, dashboard, and git operations.
 * Extracted from successful tests to promote reusability and consistency.
 */

/**
 * Redis client mock that prevents actual Redis connections during tests.
 * Use this mock at module level: vi.mock('../src/redisClient.js', () => createRedisMock())
 */
export function createRedisMock() {
  return {
    makeRedis: vi.fn().mockResolvedValue({
      xGroupCreate: vi.fn().mockResolvedValue(null),
      xReadGroup: vi.fn().mockResolvedValue([]),
      xAck: vi.fn().mockResolvedValue(null),
      disconnect: vi.fn().mockResolvedValue(null),
      quit: vi.fn().mockResolvedValue(null),
      xRevRange: vi.fn().mockResolvedValue([]),
      xAdd: vi.fn().mockResolvedValue('test-id'),
      exists: vi.fn().mockResolvedValue(1)
    })
  };
}

/**
 * Project structure for testing with tasks and milestones
 */
export interface TestProject {
  id: string;
  name: string;
  tasks: Array<{ id: string; name: string; status: string; lock_version?: number }>;
  next_milestone?: { id: string; name: string };
  repositories?: Array<{ url: string }>;
}

/**
 * Milestone structure for testing
 */
export interface TestMilestone {
  id: string;
  name: string;
  slug: string;
  tasks: Array<{ id: string; name: string; status: string }>;
}

/**
 * Dashboard API mocking utilities
 */
export class DashboardMockHelper {
  private project: TestProject;
  private milestones: TestMilestone[];
  private updatedTasks: Record<string, string> = {};
  public updateTaskStatusSpy: any;
  private projectAPIMock: any;
  private taskAPIMock: any;

  constructor(project: TestProject, milestones: TestMilestone[] = []) {
    this.project = project;
    this.milestones = milestones;
  }

  /**
   * Set up all dashboard API mocks for a test scenario
   */
  setupMocks() {
    // Mock ProjectAPI prototype methods
    vi.spyOn(ProjectAPI.prototype, 'fetchProjectStatus').mockImplementation(async () => {
      // Filter out tasks that have been marked as done
      const openTasks = this.project.tasks.filter(t => this.updatedTasks[t.id] !== 'done');
      return { ...this.project, tasks: openTasks } as any;
    });

    vi.spyOn(ProjectAPI.prototype, 'fetchProjectStatusDetails').mockImplementation(async () => {
      // Return fresh milestone data that reflects current task statuses
      return this.milestones.length > 0 ? { milestones: this.milestones } as any : null as any;
    });

    vi.spyOn(ProjectAPI.prototype, 'fetchProjectMilestones').mockResolvedValue(this.milestones as any);

    // Mock TaskAPI prototype methods
    vi.spyOn(TaskAPI.prototype, 'fetchTask').mockImplementation(async (taskId: string) => {
      const task = this.project.tasks.find(t => t.id === taskId);
      return { ...task, lock_version: task?.lock_version || 0 } as any;
    });

    this.updateTaskStatusSpy = vi.spyOn(TaskAPI.prototype, 'updateTaskStatus').mockImplementation(async (taskId: string, status: string) => {
      this.updatedTasks[taskId] = status;
      
      // Update task in project
      const task = this.project.tasks.find(t => t.id === taskId);
      if (task) {
        task.status = status;
      }
      
      // Update task in milestones
      this.milestones.forEach(m => {
        const task = m.tasks.find(t => t.id === taskId);
        if (task) {
          task.status = status;
        }
      });
      
      return { ok: true, status: 200, body: {} } as any;
    });

    return this;
  }

  /**
   * Get the current task status updates
   */
  getUpdatedTasks() {
    return { ...this.updatedTasks };
  }

  /**
   * Reset task status tracking
   */
  resetTaskUpdates() {
    this.updatedTasks = {};
    return this;
  }
}

/**
 * Persona completion responses for different workflow steps
 */
export interface PersonaCompletions {
  [stepKey: string]: any;
}

/**
 * Persona mocking utilities
 */
export class PersonaMockHelper {
  private completions: PersonaCompletions = {};

  constructor(completions: PersonaCompletions = {}) {
    this.completions = {
      // Default completions
      '1-context': { fields: { result: JSON.stringify({}) }, id: 'evt-context' },
      '2-plan': { fields: { result: JSON.stringify({ payload: { plan: [{ goal: 'implement feature' }] } }) }, id: 'evt-plan' },
      '2-implementation': { fields: { result: JSON.stringify({ status: 'ok', output: 'built', ops: [{ action: 'upsert', path: 'dummy.txt', content: 'hello' }] }) }, id: 'evt-impl' },
      '3-qa': { fields: { result: JSON.stringify({ status: 'pass', details: 'tests passed' }) }, id: 'evt-qa' },
      '3-code-review': { fields: { result: JSON.stringify({ status: 'pass', details: 'review ok' }) }, id: 'evt-cr' },
      '3-security': { fields: { result: JSON.stringify({ status: 'pass', details: 'security ok' }) }, id: 'evt-sec' },
      '3-devops': { fields: { result: JSON.stringify({ status: 'pass', details: 'deployed' }) }, id: 'evt-devops' },
      '4-implementation-plan': { fields: { result: JSON.stringify({ payload: { plan: [{ goal: 'followup' }] } }) }, id: 'evt-final-plan' },
      // Plan evaluation completions
      'plan-evaluator-pass': { fields: { result: JSON.stringify({ status: 'pass' }) }, id: 'evt-eval-pass' },
      'plan-evaluator-fail': { fields: { result: JSON.stringify({ status: 'fail', reason: 'Plan not relevant to feedback' }) }, id: 'evt-eval-fail' },
      // QA failure related completions
      '3.6-plan-revision': { fields: { result: JSON.stringify({ payload: { plan: [{ goal: 'address QA feedback' }] }, output: '' }) }, id: 'evt-plan-revised' },
      '3.7-evaluate-qa-plan-revised': { fields: { result: JSON.stringify({ status: 'pass' }) }, id: 'evt-eval-pass-revised' },
      'qa-created-tasks': { fields: { result: JSON.stringify({ payload: { plan: [{ goal: 'followup' }] } }) }, id: 'evt-planner-followup' },
      ...completions
    };
  }

  /**
   * Set up persona request and completion mocking
   */
  setupMocks() {
    // Clear sent array for test
    sent.length = 0;

    vi.spyOn(persona, 'sendPersonaRequest').mockImplementation(async (_r: any, opts: any) => {
      const corrId = opts.corrId || `corr-${sent.length + 1}`;
      const fullOpts = { ...opts, corrId };
      sent.push(fullOpts);
      return corrId;
    });

    vi.spyOn(persona, 'waitForPersonaCompletion').mockImplementation(async (_r: any, toPersona: string, workflowId: string, corrId: string, _timeoutMs?: number) => {
      const match = sent.find(s => s.corrId === corrId) as any;
      
      if (!match) {
        // Fallback: if corrId looks like a step name, use that
        if (this.completions[corrId]) {
          return this.completions[corrId];
        }
        return { fields: { result: JSON.stringify({ status: 'ok' }) }, id: 'evt-default' } as any;
      }

      const step = match.step;
      
      // Handle specific persona routing
      if (match.toPersona === 'plan-evaluator') {
        const plan = match.payload?.plan;
        if (plan && this.shouldEvaluatorFail(plan)) {
          return this.completions['plan-evaluator-fail'];
        } else {
          return this.completions['plan-evaluator-pass'];
        }
      }

      if (match.toPersona === 'project-manager') {
        const task = match.payload?.task;
        if (task) {
          // Task status update is handled by the mocked TaskAPI.updateTaskStatus
          // No need to call it directly here
        }
        return { fields: { result: JSON.stringify({ status: 'pass' }) }, id: 'evt-pm' };
      }

      // Handle step-based completions
      if (this.completions[step]) {
        const completion = this.completions[step];
        
        // Special handling for devops step to mark tasks as done
        if (step === '3-devops') {
          const task = match.payload?.task;
          if (task && task.id) {
            // Task status update is handled by the mocked TaskAPI.updateTaskStatus
            // The actual workflow will call it, no need to duplicate here
          }
        }
        
        return completion;
      }

      // Default fallback
      return { fields: { result: JSON.stringify({ status: 'ok' }) }, id: 'evt-unknown' } as any;
    });

    return this;
  }

  /**
   * Add or override completion responses
   */
  addCompletion(stepKey: string, completion: any) {
    this.completions[stepKey] = completion;
    return this;
  }

  /**
   * Override evaluator failure logic for testing plan evaluation failures
   */
  private shouldEvaluatorFail(plan: any): boolean {
    // Default logic: fail if plan goal is 'implement new feature' (irrelevant to QA feedback)
    if (plan?.payload?.plan?.[0]?.goal === 'implement new feature') {
      return true;
    }
    if (plan?.plan?.[0]?.goal === 'implement new feature') {
      return true;
    }
    return false;
  }
}

/**
 * Git utilities mocking for tests
 */
export class GitMockHelper {
  private verifyCounter = 0;
  private localShaCounter = 0;
  private remoteShaCounter = 0;

  /**
   * Set up all git utility mocks for testing
   */
  setupMocks() {
    vi.spyOn(fileops, 'applyEditOps').mockResolvedValue({ 
      changed: ['dummy.txt'], 
      branch: 'feat/agent-edit', 
      sha: '12345' 
    });

    vi.spyOn(gitUtils, 'commitAndPushPaths').mockResolvedValue({ 
      committed: true, 
      pushed: true, 
      branch: 'feat/agent-edit' 
    });

    vi.spyOn(gitUtils, 'verifyRemoteBranchHasDiff').mockImplementation(async () => {
      this.verifyCounter += 1;
      return { 
        ok: true, 
        hasDiff: true, 
        branch: 'feat/agent-edit', 
        baseBranch: 'main', 
        branchSha: `verify-sha-${this.verifyCounter}`, 
        baseSha: 'base', 
        aheadCount: 1, 
        diffSummary: '1 file changed' 
      } as any;
    });

    vi.spyOn(gitUtils, 'getBranchHeadSha').mockImplementation(async ({ remote }) => {
      if (remote) {
        this.remoteShaCounter += 1;
        if (this.remoteShaCounter === 1) return null;
        return `remote-sha-${this.remoteShaCounter}`;
      }
      this.localShaCounter += 1;
      return `local-sha-${this.localShaCounter}`;
    });

    vi.spyOn(gitUtils, 'resolveRepoFromPayload').mockResolvedValue({ 
      repoRoot: '/tmp/repo', 
      branch: 'main', 
      remote: 'https://example/repo.git' 
    } as any);

    vi.spyOn(gitUtils, 'getRepoMetadata').mockResolvedValue({ 
      remoteSlug: 'example/repo', 
      currentBranch: 'main' 
    } as any);

    vi.spyOn(gitUtils, 'checkoutBranchFromBase').mockResolvedValue(undefined as any);
    vi.spyOn(gitUtils, 'ensureBranchPublished').mockResolvedValue(undefined as any);

    return this;
  }

  /**
   * Reset counters for fresh test state
   */
  resetCounters() {
    this.verifyCounter = 0;
    this.localShaCounter = 0;
    this.remoteShaCounter = 0;
    return this;
  }
}

/**
 * Task management mocking utilities
 */
export class TaskMockHelper {
  /**
   * Set up task creation mocks
   */
  setupMocks() {
    vi.spyOn(tasks, 'createDashboardTaskEntriesWithSummarizer').mockResolvedValue([
      { 
        title: 'auto-task', 
        externalId: 'ext-x', 
        createdId: 'created-x', 
        description: 'auto-created task' 
      } as any
    ]);

    return this;
  }

  /**
   * Set up QA failure task creation
   */
  setupQAFailureMocks() {
    vi.spyOn(tasks, 'createDashboardTaskEntriesWithSummarizer').mockResolvedValue([
      { 
        title: 'QA failure task', 
        externalId: 'ext-1', 
        createdId: 't-1', 
        description: 'Condensed description about missing tests' 
      } as any
    ]);

    return this;
  }
}

/**
 * Coordinator mocking to prevent Redis issues in tests
 */
export async function setupCoordinatorMocks() {
  // Mock the internal Redis usage for persona requests
  vi.mock('../../src/redisClient.js', async () => {
    const actual = await vi.importActual('../../src/redisClient.js') as any;
    return {
      ...actual,
      makeRedis: vi.fn().mockResolvedValue({
        xGroupCreate: vi.fn().mockResolvedValue(null),
        xReadGroup: vi.fn().mockResolvedValue([]),
        xAck: vi.fn().mockResolvedValue(null),
        disconnect: vi.fn().mockResolvedValue(null),
        quit: vi.fn().mockResolvedValue(null),
        xRevRange: vi.fn().mockResolvedValue([]),
        xAdd: vi.fn().mockResolvedValue('test-id'),
        exists: vi.fn().mockResolvedValue(1)
      })
    };
  });
}

/**
 * Complete test setup helper that configures all common mocks
 */
export function setupAllMocks(
  project: TestProject, 
  milestones: TestMilestone[] = [], 
  personaCompletions: PersonaCompletions = {}
) {
  const dashboardHelper = new DashboardMockHelper(project, milestones).setupMocks();
  const personaHelper = new PersonaMockHelper(personaCompletions).setupMocks();
  const gitHelper = new GitMockHelper().setupMocks();
  const taskHelper = new TaskMockHelper().setupMocks();
  
  setupCoordinatorMocks();

  return {
    dashboard: dashboardHelper,
    persona: personaHelper,
    git: gitHelper,
    task: taskHelper,
    getSentRequests: () => sent,
    clearSentRequests: () => { sent.length = 0; }
  };
}

// Re-export WorkflowCoordinator for convenience  
export * as coordinatorMod from '../../src/workflows/WorkflowCoordinator.js';