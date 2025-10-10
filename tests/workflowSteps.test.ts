import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WorkflowContext } from '../src/workflows/engine/WorkflowContext.js';
import { PullTaskStep } from '../src/workflows/steps/PullTaskStep.js';
import { ContextStep } from '../src/workflows/steps/ContextStep.js';
import { CodeGenStep } from '../src/workflows/steps/CodeGenStep.js';
import { QAStep } from '../src/workflows/steps/QAStep.js';
import { PlanningStep } from '../src/workflows/steps/PlanningStep.js';

// Mock external dependencies
vi.mock('../src/redisClient.js', () => ({
  makeRedis: vi.fn().mockResolvedValue({
    xGroupCreate: vi.fn().mockResolvedValue(null),
    xReadGroup: vi.fn().mockResolvedValue([{
      name: 'test-stream',
      messages: [{
        id: 'test-id-123',
        message: {
          type: 'code-task',
          persona: 'lead_engineer',
          data: JSON.stringify({ description: 'Test task' })
        }
      }]
    }]),
    xAck: vi.fn().mockResolvedValue(null),
    disconnect: vi.fn().mockResolvedValue(null)
  })
}));

vi.mock('../src/scanRepo.js', () => ({
  scanRepo: vi.fn().mockResolvedValue([
    { path: 'src/main.ts', bytes: 1024, lines: 50, mtime: Date.now() },
    { path: 'package.json', bytes: 512, lines: 25, mtime: Date.now() }
  ])
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

  beforeEach(() => {
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
      {}
    );
    vi.clearAllMocks();
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
          timeout: 30000
        }
      };

      const step = new QAStep(config);
      const result = await step.execute(context);

      expect(result.status).toBe('success');
      expect(result.data).toBeDefined();
      expect(result.outputs?.testsPassed).toBe(true);
    });
  });
});