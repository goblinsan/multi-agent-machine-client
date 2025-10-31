import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WorkflowContext } from '../src/workflows/engine/WorkflowContext.js';
import { PullTaskStep } from '../src/workflows/steps/PullTaskStep.js';
import { ContextStep } from '../src/workflows/steps/ContextStep.js';
import { CodeGenStep } from '../src/workflows/steps/CodeGenStep.js';
import { QAStep } from '../src/workflows/steps/QAStep.js';
import { PlanningStep } from '../src/workflows/steps/PlanningStep.js';
import { TaskUpdateStep } from '../src/workflows/steps/TaskUpdateStep.js';
import { PlanEvaluationStep } from '../src/workflows/steps/PlanEvaluationStep.js';
import { QAAnalysisStep } from '../src/workflows/steps/QAAnalysisStep.js';
import { TaskCreationStep } from '../src/workflows/steps/TaskCreationStep.js';
import { GitOperationStep } from '../src/workflows/steps/GitOperationStep.js';
import { PersonaRequestStep } from '../src/workflows/steps/PersonaRequestStep.js';
import * as gitUtils from '../src/gitUtils.js';
import { abortWorkflowDueToPushFailure, abortWorkflowWithReason } from '../src/workflows/helpers/workflowAbort.js';
import { sendPersonaRequest, waitForPersonaCompletion } from '../src/agents/persona.js';

// Mock external dependencies
vi.mock('../src/redisClient.js', () => {
  const redisMock = {
    xGroupCreate: vi.fn().mockResolvedValue(null),
    xReadGroup: vi.fn().mockResolvedValue({
      'test-stream': {
        messages: [{
          id: 'test-id-123',
          fields: {
            type: 'code-task',
            persona: 'lead_engineer',
            data: JSON.stringify({ description: 'Test task' })
          }
        }]
      }
    }),
    xAck: vi.fn().mockResolvedValue(null),
    xRange: vi.fn().mockResolvedValue([]),
    xDel: vi.fn().mockResolvedValue(0),
    quit: vi.fn().mockResolvedValue(null),
    disconnect: vi.fn().mockResolvedValue(null)
  };

  return {
    makeRedis: vi.fn().mockResolvedValue(redisMock),
    redisMock
  };
});

vi.mock('../src/workflows/helpers/workflowAbort.js', () => ({
  abortWorkflowDueToPushFailure: vi.fn().mockResolvedValue(undefined),
  abortWorkflowWithReason: vi.fn().mockResolvedValue({ cleanupResult: { removed: 0, acked: 0 } })
}));

vi.mock('../src/agents/persona.js', () => ({
  sendPersonaRequest: vi.fn().mockResolvedValue('corr-123'),
  waitForPersonaCompletion: vi.fn().mockResolvedValue({
    id: 'event-1',
    fields: {
      result: JSON.stringify({ status: 'success', normalizedStatus: 'pass' })
    }
  }),
  interpretPersonaStatus: vi.fn().mockReturnValue({
    status: 'pass',
    details: '',
    raw: ''
  })
}));

vi.mock('../src/scanRepo.js', () => ({
  scanRepo: vi.fn().mockResolvedValue([
    { path: 'src/main.ts', bytes: 1024, lines: 50, mtime: Date.now() },
    { path: 'package.json', bytes: 512, lines: 25, mtime: Date.now() }
  ])
}));

vi.mock('fs/promises', () => ({
  default: {
    access: vi.fn().mockRejectedValue(new Error('File not found')),
    stat: vi.fn().mockResolvedValue({
      isDirectory: () => true,
      mtime: new Date()
    }),
    readFile: vi.fn().mockResolvedValue('{}'),
    writeFile: vi.fn().mockResolvedValue(undefined),
    mkdir: vi.fn().mockResolvedValue(undefined)
  }
}));

vi.mock('../src/gitUtils.js', () => ({
  runGit: vi.fn().mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 }),
  getCurrentBranch: vi.fn().mockResolvedValue('main'),
  ensureGitRepo: vi.fn().mockResolvedValue(undefined),
  describeWorkingTree: vi.fn().mockResolvedValue({
    dirty: false,
    branch: 'main',
    entries: [],
    summary: { staged: 0, unstaged: 0, untracked: 0, total: 0 },
    porcelain: []
  }),
  commitAndPushPaths: vi.fn().mockResolvedValue(undefined),
  checkoutBranchFromBase: vi.fn().mockResolvedValue(undefined)
}));

vi.mock('../src/lmstudio.js', () => ({
  callLMStudio: vi.fn().mockResolvedValue({
    content: 'Generated code response with diffs\n```diff\n--- a/test.ts\n+++ b/test.ts\n@@ -1,1 +1,2 @@\n console.log("hello");\n+console.log("world");\n```',
    raw: {}
  })
}));

vi.mock('../src/logger.js', () => ({
  logger: {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  }
}));

describe('Workflow Steps', () => {
  let context: WorkflowContext;
  let mockTransport: any;

  beforeEach(() => {
    // Create mock transport with all necessary methods
    mockTransport = {
      xGroupCreate: vi.fn().mockResolvedValue(null),
      xReadGroup: vi.fn().mockResolvedValue({
        'test-stream': {
          messages: [{
            id: 'test-id-123',
            fields: {
              type: 'code-task',
              persona: 'lead_engineer',
              data: JSON.stringify({ description: 'Test task' })
            }
          }]
        }
      }),
      xAck: vi.fn().mockResolvedValue(null),
      xRange: vi.fn().mockResolvedValue([]),
      xDel: vi.fn().mockResolvedValue(0),
      xAdd: vi.fn().mockResolvedValue('1-0'),
      disconnect: vi.fn().mockResolvedValue(null),
      connect: vi.fn().mockResolvedValue(null)
    };

    const mockConfig = {
      name: 'test-workflow',
      version: '1.0.0',
      steps: []
    };
    context = new WorkflowContext(
      'test-workflow-id',
      'test-project-id', 
      '/test/repo',
      'main',
      mockConfig,
      mockTransport,
      {}
    );
    // Disable persona bypass for tests that verify persona request behavior
    context.setVariable('SKIP_PERSONA_OPERATIONS', false);
    vi.clearAllMocks();
    vi.mocked(sendPersonaRequest).mockResolvedValue('corr-123');
    vi.mocked(waitForPersonaCompletion).mockResolvedValue({
      id: 'event-1',
      fields: {
        result: JSON.stringify({ status: 'success', normalizedStatus: 'pass' })
      }
    } as any);
  });

  describe('PullTaskStep', () => {
    it('should pull task from Redis stream', async () => {
      const config = {
        name: 'pull-task',
        type: 'PullTaskStep',
        config: {
          streamName: 'test-stream',
          consumerGroup: 'test-group',
          consumerId: 'test-consumer'
        }
      };

      const step = new PullTaskStep(config);
      const result = await step.execute(context);

      expect(result.status).toBe('success');
      expect(result.data).toBeDefined();
      expect(result.outputs?.task).toBeDefined();
      expect(result.outputs?.taskId).toBe('test-id-123');
      
      // Check context variables
      const task = context.getVariable('task');
      expect(task).toBeDefined();
      expect(task.type).toBe('code-task');
      expect(task.persona).toBe('lead_engineer');
    });

    it('should validate configuration', async () => {
      const config = {
        name: 'pull-task',
        type: 'PullTaskStep',
        config: {
          streamName: 'test-stream'
          // Missing required fields
        }
      };

      const step = new PullTaskStep(config);
      const validation = await step.validate(context);

      expect(validation.valid).toBe(false);
      expect(validation.errors).toContain('PullTaskStep: consumerGroup is required and must be a string');
    });
  });

  describe('ContextStep', () => {
    it('should gather repository context', async () => {
      const config = {
        name: 'context',
        type: 'ContextStep',
        config: {
          repoPath: '/test/repo'
        }
      };

      const step = new ContextStep(config);
      const result = await step.execute(context);

      if (result.status === 'failure') {
        console.error('ContextStep failed:', result.error);
      }
      
      expect(result.status).toBe('success');
      expect(result.data).toBeDefined();
      expect(result.outputs?.context).toBeDefined();
      expect(result.outputs?.repoScan).toBeDefined();
      
      // Check context variables
      const contextData = context.getVariable('context');
      expect(contextData).toBeDefined();
      expect(contextData.metadata.fileCount).toBe(2);
    });

    it('should validate repository path', async () => {
      const config = {
        name: 'context',
        type: 'ContextStep',
        config: {}
      };

      const step = new ContextStep(config);
      const validation = await step.validate(context);

      expect(validation.valid).toBe(false);
      expect(validation.errors).toContain('ContextStep: repoPath is required and must be a string');
    });
  });

  describe('CodeGenStep', () => {
    it('should generate code using LLM', async () => {
      // Set up task in context
      context.setVariable('task', {
        id: 'test-123',
        type: 'code-task',
        persona: 'lead_engineer',
        data: { description: 'Generate test code' }
      });

      const config = {
        name: 'codegen',
        type: 'CodeGenStep',
        config: {
          persona: 'lead_engineer',
          temperature: 0.7
        }
      };

      const step = new CodeGenStep(config);
      const result = await step.execute(context);

      expect(result.status).toBe('success');
      expect(result.data).toBeDefined();
      expect(result.outputs?.response).toBeDefined();
      expect(result.outputs?.diffs).toBeDefined();
      expect(result.outputs?.diffs.length).toBeGreaterThan(0);
      
      // Check context variables
      const response = context.getVariable('response');
      expect(response).toBeDefined();
      expect(response).toContain('Generated code response');
    });

    it('should parse diff blocks correctly', async () => {
      context.setVariable('task', {
        id: 'test-123',
        type: 'code-task',
        persona: 'lead_engineer',
        data: { description: 'Test task' }
      });

      const config = {
        name: 'codegen',
        type: 'CodeGenStep',
        config: {
          persona: 'lead_engineer'
        }
      };

      const step = new CodeGenStep(config);
      const result = await step.execute(context);

      expect(result.status).toBe('success');
      const diffs = result.outputs?.diffs;
      expect(diffs).toBeDefined();
      expect(diffs.length).toBe(1);
      expect(diffs[0].parsed.filePath).toBe('test.ts');
    });
  });

  describe('PersonaRequestStep', () => {
    it('sends repo reference using effective_repo_path when available', async () => {
      context.setVariable('effective_repo_path', 'https://example.com/repo.git');
      context.setVariable('repo_remote', 'https://example.com/repo.git');

      const config = {
        name: 'context-request',
        type: 'PersonaRequestStep',
        config: {
          step: '1-context',
          persona: 'contextualizer',
          intent: 'context_gathering',
          payload: {
            repo_path: '${effective_repo_path}'
          }
        },
        outputs: ['context_request_result']
      } as any;

      const step = new PersonaRequestStep(config);
      const result = await step.execute(context);

      expect(result.status).toBe('success');
      expect(sendPersonaRequest).toHaveBeenCalledWith(
        expect.any(Object),
        expect.objectContaining({
          workflowId: context.workflowId,
          repo: 'https://example.com/repo.git'
        })
      );

      const resolvedPayload = vi.mocked(sendPersonaRequest).mock.calls[0][1]?.payload;
      expect(resolvedPayload?.repo_path).toBe('https://example.com/repo.git');
    });
  });

  describe('PlanningStep', () => {
    it('should create implementation plans', async () => {
      // Set up task in context
      context.setVariable('task', {
        id: 'test-123',
        type: 'feature-task',
        persona: 'lead_engineer',
        data: { 
          description: 'Implement new feature',
          requirements: ['requirement 1', 'requirement 2']
        }
      });

      // Mock structured JSON response
      const mockLLMResponse = {
        content: JSON.stringify({
          plan: 'Implement the feature in 3 phases',
          breakdown: [
            {
              step: 1,
              title: 'Phase 1: Setup',
              description: 'Set up the basic structure',
              dependencies: [],
              estimatedDuration: '2 hours',
              complexity: 'low'
            }
          ],
          risks: [
            {
              description: 'Integration complexity',
              severity: 'medium',
              mitigation: 'Start with small changes'
            }
          ]
        }),
        raw: {}
      };

      vi.mocked(await import('../src/lmstudio.js')).callLMStudio.mockResolvedValueOnce(mockLLMResponse);

      const config = {
        name: 'planning',
        type: 'PlanningStep',
        config: {
          persona: 'lead_engineer',
          temperature: 0.3
        }
      };

      const step = new PlanningStep(config);
      const result = await step.execute(context);

      expect(result.status).toBe('success');
      expect(result.data).toBeDefined();
      expect(result.outputs?.plan).toBeDefined();
      expect(result.outputs?.breakdown).toBeDefined();
      expect(result.outputs?.risks).toBeDefined();
      
      // Check structured data
      const planningResult = context.getVariable('planningResult');
      expect(planningResult).toBeDefined();
      expect(planningResult.breakdown.length).toBe(1);
      expect(planningResult.risks.length).toBe(1);
    });
  });

  describe('QAStep', () => {
    it('should execute tests and analyze results', async () => {
      // Mock successful test execution
      const mockSpawn = {
        stdout: { on: vi.fn() },
        stderr: { on: vi.fn() },
        on: vi.fn((event, callback) => {
          if (event === 'close') {
            // Simulate successful test run
            setTimeout(() => callback(0), 10);
          }
        }),
        kill: vi.fn()
      };

      const mockChildProcess = {
        spawn: vi.fn().mockReturnValue(mockSpawn)
      };

      // Mock test output
      setTimeout(() => {
        const dataCallback = mockSpawn.stdout.on.mock.calls.find(call => call[0] === 'data')?.[1];
        if (dataCallback) {
          dataCallback('✓ 5 passed\nTests: 5 passed, 5 total\n');
        }
      }, 5);

      vi.doMock('child_process', () => mockChildProcess);

      const config = {
        name: 'qa',
        type: 'QAStep',
        config: {
          testCommand: 'npm test',
          timeout: 1000
        }
      };

      const step = new QAStep(config);
      const result = await step.execute(context);

      expect(result.status).toBe('success');
      expect(result.data).toBeDefined();
      expect(result.outputs?.testsPassed).toBe(true);
    });
  });

  describe('TaskUpdateStep', () => {
    it('should update task status', async () => {
      // Set up task in context
      context.setVariable('task', {
        id: 'test-task-123',
        type: 'code-task'
      });

      const config = {
        name: 'task-update',
        type: 'TaskUpdateStep',
        config: {
          updateType: 'status',
          status: 'in_progress',
          message: 'Task is now in progress'
        }
      };

      const step = new TaskUpdateStep(config);
      const result = await step.execute(context);

      expect(result.status).toBe('success');
      expect(result.data).toBeDefined();
      expect(result.outputs?.updated).toBe(true);
      expect(result.outputs?.taskId).toBe('test-task-123');
      
      // Check context variables
      const updateResult = context.getVariable('updateResult');
      expect(updateResult).toBeDefined();
      expect(updateResult.taskId).toBe('test-task-123');
      expect(updateResult.updateType).toBe('status');
    });

    it('should update task progress', async () => {
      context.setVariable('task', {
        id: 'test-task-456',
        type: 'code-task'
      });

      const config = {
        name: 'task-progress',
        type: 'TaskUpdateStep',
        config: {
          updateType: 'progress',
          progress: 75,
          message: 'Task is 75% complete'
        }
      };

      const step = new TaskUpdateStep(config);
      const result = await step.execute(context);

      expect(result.status).toBe('success');
      expect(result.outputs?.updated).toBe(true);
    });

    it('should validate configuration', async () => {
      const config = {
        name: 'task-update',
        type: 'TaskUpdateStep',
        config: {
          updateType: 'invalid-type'
        }
      };

      const step = new TaskUpdateStep(config);
      const validation = await step.validate(context);

      expect(validation.valid).toBe(false);
      expect(validation.errors).toContain('TaskUpdateStep: updateType must be one of: status, progress, result, failure');
    });
  });

  // New workflow steps tests
  describe('PlanEvaluationStep', () => {
    beforeEach(() => {
      // Add mock plan data to context
      context.setStepOutput('planning', {
        plan: {
          title: 'Test Implementation Plan',
          description: 'A comprehensive plan for testing',
          steps: [
            {
              step: 'Setup tests',
              description: 'Create test infrastructure',
              rationale: 'Tests ensure code quality'
            },
            {
              step: 'Implement feature',
              description: 'Add core functionality',
              rationale: 'Delivers required behavior'
            }
          ],
          risks: [
            {
              description: 'Test complexity',
              impact: 'medium',
              mitigation: 'Start with simple tests'
            }
          ],
          complexity: 'medium',
          timeline: {
            estimated_hours: 8,
            confidence: 'medium'
          },
          requirements: ['Feature A', 'Feature B'],
          dependencies: ['Library X']
        }
      });
    });

    it('should evaluate a good quality plan successfully', async () => {
      const config = {
        name: 'plan-evaluation',
        type: 'PlanEvaluationStep',
        config: {
          minFeasibilityScore: 0.7,
          minQualityScore: 0.6,
          requireRiskAssessment: true
        }
      };

      const step = new PlanEvaluationStep(config);
      const result = await step.execute(context);

      expect(result.status).toBe('success');
      expect(result.outputs?.approved).toBe(true);
      expect(result.outputs?.evaluationScore).toBeGreaterThan(0.5);
      expect(result.outputs?.feasibilityScore).toBeGreaterThan(0);
      expect(result.outputs?.qualityScore).toBeGreaterThan(0);
    });

    it('should fail evaluation for poor quality plan', async () => {
      // Override with poor quality plan
      context.setStepOutput('planning', {
        plan: {
          title: 'Bad',
          description: 'Too short',
          steps: [],
          complexity: 'high'
          // Missing required fields
        }
      });

      const config = {
        name: 'plan-evaluation',
        type: 'PlanEvaluationStep',
        config: {
          minFeasibilityScore: 0.7,
          minQualityScore: 0.6,
          requireRiskAssessment: true
        }
      };

      const step = new PlanEvaluationStep(config);
      const result = await step.execute(context);

      expect(result.status).toBe('failure');
      expect(result.outputs?.approved).toBe(false);
      expect(result.outputs?.issues).toBeDefined();
      expect(result.outputs?.issues.length).toBeGreaterThan(0);
    });

    it('should validate configuration properly', async () => {
      const config = {
        name: 'plan-evaluation',
        type: 'PlanEvaluationStep',
        config: {
          minFeasibilityScore: 1.5,
          minQualityScore: -0.1,
          customCriteria: [
            {
              name: 'test',
              description: 'test criteria',
              weight: 2.0
            }
          ]
        }
      };

      const step = new PlanEvaluationStep(config);
      const validation = await step.validate(context);

      expect(validation.valid).toBe(false);
      expect(validation.errors.length).toBeGreaterThan(0);
      expect(validation.errors.some(e => e.includes('minFeasibilityScore'))).toBe(true);
      expect(validation.errors.some(e => e.includes('minQualityScore'))).toBe(true);
      expect(validation.errors.some(e => e.includes('weight'))).toBe(true);
    });

    it('should handle missing plan data', async () => {
      // Clear plan data
      context.setStepOutput('planning', {});

      const config = {
        name: 'plan-evaluation',
        type: 'PlanEvaluationStep',
        config: {}
      };

      const step = new PlanEvaluationStep(config);
      const result = await step.execute(context);

      expect(result.status).toBe('failure');
      expect(result.error?.message).toContain('No plan data found');
    });
  });

  describe('QAAnalysisStep', () => {
    beforeEach(() => {
      // Add mock QA results to context
      context.setStepOutput('qa', {
        qaResults: {
          status: 'failed',
          totalTests: 10,
          passedTests: 7,
          failedTests: 3,
          skippedTests: 0,
          coverage: {
            statements: 85,
            branches: 75,
            functions: 90,
            lines: 80
          },
          failures: [
            {
              testName: 'should handle user input',
              error: 'TypeError: Cannot read property of undefined',
              stackTrace: 'at test.js:10:5',
              file: 'test.js',
              line: 10
            },
            {
              testName: 'should validate syntax',
              error: 'SyntaxError: Unexpected token',
              file: 'parser.js',
              line: 25
            },
            {
              testName: 'should process timeout',
              error: 'Test timeout after 5000ms',
              file: 'async.test.js'
            }
          ],
          executionTime: 5000
        }
      });
    });

    it('should analyze QA results successfully', async () => {
      const config = {
        name: 'qa-analysis',
        type: 'QAAnalysisStep',
        config: {
          categorizeFailures: true,
          suggestFixes: true,
          analyzeCoverage: true
        }
      };

      const step = new QAAnalysisStep(config);
      const result = await step.execute(context);

      expect(result.status).toBe('success');
      expect(result.outputs?.overallStatus).toBeOneOf(['critical', 'concerning', 'manageable', 'good']);
      expect(result.outputs?.failureCount).toBe(3);
      expect(result.outputs?.recommendations).toBeDefined();
      expect(result.outputs?.nextActions).toBeDefined();
      expect(result.data?.analysis.failureCategories).toBeDefined();
      expect(result.data?.analysis.coverageAnalysis).toBeDefined();
    });

    it('should categorize failures correctly', async () => {
      const config = {
        name: 'qa-analysis',
        type: 'QAAnalysisStep',
        config: {
          categorizeFailures: true,
          customCategories: [
            {
              name: 'Custom Error',
              patterns: ['custom pattern'],
              severity: 'high',
              description: 'Custom error type'
            }
          ]
        }
      };

      const step = new QAAnalysisStep(config);
      const result = await step.execute(context);

      expect(result.status).toBe('success');
      const categories = result.data?.analysis.failureCategories;
      expect(categories).toBeDefined();
      expect(categories.length).toBeGreaterThan(0);
      
      // Should categorize TypeErrors and SyntaxErrors
      expect(categories.some((c: any) => c.name === 'Type Error')).toBe(true);
      expect(categories.some((c: any) => c.name === 'Syntax Error')).toBe(true);
    });

    it('should handle good QA results', async () => {
      // Override with passing tests
      context.setStepOutput('qa', {
        qaResults: {
          status: 'passed',
          totalTests: 10,
          passedTests: 10,
          failedTests: 0,
          skippedTests: 0,
          failures: [],
          executionTime: 2000
        }
      });

      const config = {
        name: 'qa-analysis',
        type: 'QAAnalysisStep',
        config: {}
      };

      const step = new QAAnalysisStep(config);
      const result = await step.execute(context);

      expect(result.status).toBe('success');
      expect(result.outputs?.overallStatus).toBe('good');
      expect(result.outputs?.failureCount).toBe(0);
    });

    it('should validate configuration', async () => {
      const config = {
        name: 'qa-analysis',
        type: 'QAAnalysisStep',
        config: {
          maxFailuresToAnalyze: 0,
          customCategories: [
            {
              name: '',
              patterns: [],
              severity: 'high',
              description: ''
            }
          ]
        }
      };

      const step = new QAAnalysisStep(config);
      const validation = await step.validate(context);

      expect(validation.valid).toBe(false);
      expect(validation.errors.some(e => e.includes('maxFailuresToAnalyze'))).toBe(true);
      expect(validation.errors.some(e => e.includes('Custom categories'))).toBe(true);
    });

    it('should handle missing QA results', async () => {
      // Clear QA data
      context.setStepOutput('qa', {});

      const config = {
        name: 'qa-analysis',
        type: 'QAAnalysisStep',
        config: {}
      };

      const step = new QAAnalysisStep(config);
      const result = await step.execute(context);

      expect(result.status).toBe('failure');
      expect(result.error?.message).toContain('No QA results found');
    });
  });

  describe('GitOperationStep', () => {
    it('should abort workflow when working tree is dirty before checkout', async () => {
      const abortSpy = vi.mocked(abortWorkflowWithReason);

      const describeSpy = vi.spyOn(gitUtils, 'describeWorkingTree').mockResolvedValue({
        dirty: true,
        branch: 'feature/dirty',
        entries: [
          { status: ' M', path: 'src/app.ts' }
        ],
        summary: {
          staged: 0,
          unstaged: 1,
          untracked: 0,
          total: 1
        },
        porcelain: [' M src/app.ts']
      } as any);

      const checkoutSpy = vi.spyOn(gitUtils, 'checkoutBranchFromBase').mockResolvedValue(undefined as any);

      const config = {
        name: 'checkout-step',
        type: 'GitOperationStep',
        config: {
          operation: 'checkoutBranchFromBase',
          repoRoot: '/tmp/dirty-repo',
          baseBranch: 'main',
          newBranch: 'feature/dirty'
        }
      };

      const step = new GitOperationStep(config as any);
      const result = await step.execute(context);

      expect(result.status).toBe('failure');
      expect(result.error?.message).toContain('uncommitted changes');
      expect(checkoutSpy).not.toHaveBeenCalled();
      expect(abortSpy).toHaveBeenCalledTimes(1);
      expect(abortSpy).toHaveBeenCalledWith(
        expect.any(WorkflowContext),
        'dirty_working_tree',
        expect.objectContaining({
          repoRoot: '/tmp/dirty-repo',
          baseBranch: 'main',
          branch: 'feature/dirty'
        })
      );

      describeSpy.mockRestore();
      checkoutSpy.mockRestore();
    });

    it('should abort workflow when push fails', async () => {
      const commitResult = {
        committed: true,
        pushed: false,
        branch: 'feat/agent-edit',
        reason: 'push_failed'
      };

      const commitSpy = vi.spyOn(gitUtils, 'commitAndPushPaths').mockResolvedValueOnce(commitResult as any);
      const abortSpy = vi.mocked(abortWorkflowDueToPushFailure);

      const config = {
        name: 'commit-step',
        type: 'GitOperationStep',
        config: {
          operation: 'commitAndPushPaths',
          repoRoot: '/tmp/repo',
          branch: 'feat/agent-edit',
          message: 'feat: update',
          paths: ['src/file.ts']
        }
      };

      const step = new GitOperationStep(config as any);
      const result = await step.execute(context);

      expect(commitSpy).toHaveBeenCalledOnce();
      expect(result.status).toBe('failure');
      expect(result.error?.message).toContain('Git push failed');
      expect(abortSpy).toHaveBeenCalledTimes(1);
      expect(abortSpy).toHaveBeenCalledWith(
        expect.any(WorkflowContext),
        commitResult,
        expect.objectContaining({ message: 'feat: update', paths: ['src/file.ts'] })
      );

      commitSpy.mockRestore();
    });
  });

  describe('TaskCreationStep', () => {
    beforeEach(() => {
      // Add mock QA analysis results
      context.setStepOutput('qa-analysis', {
        analysis: {
          overallAssessment: {
            status: 'concerning',
            confidence: 0.8,
            summary: 'Multiple test failures detected'
          },
          failureAnalyses: [
            {
              category: 'Type Error',
              severity: 'high',
              rootCause: 'Undefined variable access',
              suggestedFix: 'Add null checks',
              confidence: 0.9,
              pattern: 'type',
              relatedFailures: []
            },
            {
              category: 'Timeout',
              severity: 'medium',
              rootCause: 'Slow async operation',
              suggestedFix: 'Optimize or increase timeout',
              confidence: 0.7,
              pattern: 'timeout',
              relatedFailures: []
            }
          ],
          recommendations: [
            {
              priority: 'high',
              action: 'Fix critical type errors',
              rationale: 'Blocking basic functionality',
              estimatedEffort: '2 hours'
            }
          ]
        }
      });

      // Add mock plan evaluation results
      context.setStepOutput('plan-evaluation', {
        evaluation: {
          issues: [
            {
              type: 'error',
              category: 'completeness',
              message: 'Missing risk assessment',
              severity: 'high'
            }
          ],
          recommendations: [
            'Add more detailed timeline estimates',
            'Include dependency analysis'
          ]
        }
      });
    });

    it('should create tasks from QA analysis successfully', async () => {
      const config = {
        name: 'task-creation',
        type: 'TaskCreationStep',
        config: {
          dataSource: 'qa-analysis',
          maxTasks: 10,
          minConfidenceThreshold: 0.6
        }
      };

      const step = new TaskCreationStep(config);
      const result = await step.execute(context);

      expect(result.status).toBe('success');
      expect(result.outputs?.tasksCreated).toBeGreaterThan(0);
      expect(result.outputs?.tasks).toBeDefined();
      expect(result.outputs?.tasksByPriority).toBeDefined();
      
      const tasks = result.outputs?.tasks as any[];
      // TaskGenerator preserves the original category from failureAnalyses
      expect(tasks.length).toBeGreaterThan(0);
      expect(tasks.some(t => t.priority === 'critical' || t.priority === 'high')).toBe(true);
    });

    it('should create tasks from plan evaluation', async () => {
      const config = {
        name: 'task-creation',
        type: 'TaskCreationStep',
        config: {
          dataSource: 'plan-evaluation',
          maxTasks: 5
        }
      };

      const step = new TaskCreationStep(config);
      const result = await step.execute(context);

      expect(result.status).toBe('success');
      expect(result.outputs?.tasksCreated).toBeGreaterThan(0);
      
      const tasks = result.outputs?.tasks as any[];
      // TaskGenerator preserves issue.category from plan evaluation
      expect(tasks.some(t => t.category === 'completeness')).toBe(true);
    });

    it('should filter tasks by confidence threshold', async () => {
      const config = {
        name: 'task-creation',
        type: 'TaskCreationStep',
        config: {
          dataSource: 'qa-analysis',
          minConfidenceThreshold: 0.95
        }
      };

      const step = new TaskCreationStep(config);
      const result = await step.execute(context);

      expect(result.status).toBe('success');
      
      const tasks = result.outputs?.tasks as any[];
      // Should filter out the medium confidence timeout task (0.7)
      expect(tasks.every(t => t.confidence >= 0.95)).toBe(true);
    });

    it('should limit number of tasks created', async () => {
      const config = {
        name: 'task-creation',
        type: 'TaskCreationStep',
        config: {
          dataSource: 'all',
          maxTasks: 2
        }
      };

      const step = new TaskCreationStep(config);
      const result = await step.execute(context);

      expect(result.status).toBe('success');
      expect(result.outputs?.tasksCreated).toBeLessThanOrEqual(2);
    });

    it('should group related issues when enabled', async () => {
      // Add multiple similar failures
      context.setStepOutput('qa-analysis', {
        analysis: {
          failureAnalyses: [
            {
              category: 'Type Error',
              severity: 'high',
              rootCause: 'Issue 1',
              suggestedFix: 'Fix 1',
              confidence: 0.9,
              pattern: 'type'
            },
            {
              category: 'Type Error',
              severity: 'high',
              rootCause: 'Issue 2',
              suggestedFix: 'Fix 2',
              confidence: 0.8,
              pattern: 'type'
            }
          ]
        }
      });

      const config = {
        name: 'task-creation',
        type: 'TaskCreationStep',
        config: {
          dataSource: 'qa-analysis',
          groupRelatedIssues: true
        }
      };

      const step = new TaskCreationStep(config);
      const result = await step.execute(context);

      expect(result.status).toBe('success');
      
      const tasks = result.outputs?.tasks as any[];
      // Should create grouped task
      expect(tasks.some(t => t.title && t.title.includes('Type Error'))).toBe(true);
    });

    it('should validate configuration', async () => {
      const config = {
        name: 'task-creation',
        type: 'TaskCreationStep',
        config: {
          maxTasks: 0,
          minConfidenceThreshold: 1.5,
          taskTemplates: {
            'test': {
              title: '',
              description: ''
            }
          }
        }
      };

      const step = new TaskCreationStep(config);
      const validation = await step.validate(context);

      expect(validation.valid).toBe(false);
      expect(validation.errors.some(e => e.includes('maxTasks'))).toBe(true);
      expect(validation.errors.some(e => e.includes('minConfidenceThreshold'))).toBe(true);
      expect(validation.errors.some(e => e.includes('title and description'))).toBe(true);
    });

    it('should handle missing source data gracefully', async () => {
      // Clear all source data
      context.setStepOutput('qa-analysis', {});
      context.setStepOutput('plan-evaluation', {});

      const config = {
        name: 'task-creation',
        type: 'TaskCreationStep',
        config: {
          dataSource: 'all'
        }
      };

      const step = new TaskCreationStep(config);
      const result = await step.execute(context);

      expect(result.status).toBe('success');
      expect(result.outputs?.tasksCreated).toBe(0);
      expect(result.outputs?.summary).toContain('No tasks created');
    });
  });
});