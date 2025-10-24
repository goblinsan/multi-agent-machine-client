import { describe, it, expect, beforeEach } from 'vitest';
import { WorkflowEngine } from '../src/workflows/WorkflowEngine.js';
import { WorkflowStepFactory } from '../src/workflows/engine/WorkflowStep.js';
import { TestStep } from '../src/workflows/steps/TestStep.js';
import { DiffApplyStep } from '../src/workflows/steps/DiffApplyStep.js';
import { makeTempRepo } from './makeTempRepo.js';
import path from 'path';
import fs from 'fs/promises';

describe('WorkflowEngine', () => {
  let tempRepo: string;
  let engine: WorkflowEngine;

  beforeEach(async () => {
    // Register test steps
    WorkflowStepFactory.registerStep('TestStep', TestStep);
    WorkflowStepFactory.registerStep('DiffApplyStep', DiffApplyStep);

    // Create temp repo for testing
    tempRepo = await makeTempRepo();
    
    // Use the dedicated test workflows directory
    const testWorkflowsDir = path.join(process.cwd(), 'tests', 'workflows');
    
    engine = new WorkflowEngine(testWorkflowsDir);
  });

  it('should load and validate workflow configuration', async () => {
    const config = await engine.loadWorkflow('test-workflow.yaml');
    
    expect(config.name).toBe('test-workflow');
    expect(config.version).toBe('1.0');
    expect(config.steps).toHaveLength(2);
    expect(config.steps[0].name).toBe('test_step');
    expect(config.steps[1].name).toBe('dependent_step');
    expect(config.steps[1].depends_on).toEqual(['test_step']);
  });

  it('should execute simple workflow successfully', async () => {
    const result = await engine.executeWorkflow(
      'test-workflow.yaml',
      'test-project',
      tempRepo,
      'main',
      {
        workflowId: 'test-workflow-1',
        variables: { test_var: 'test_value' }
      }
    );

    expect(result.status).toBe('completed');
    expect(result.workflowId).toBe('test-workflow-1');
    expect(result.executionSummary.totalSteps).toBe(2);
    expect(result.executionSummary.completedSteps).toBe(2);
    expect(result.executionSummary.failedSteps).toBe(0);
    
    // Check that steps executed in correct order
    const history = result.context.getExecutionHistory();
    expect(history).toHaveLength(2);
    expect(history[0].stepName).toBe('test_step');
    expect(history[1].stepName).toBe('dependent_step');
    
    // Check step outputs
    const testStepOutput = result.context.getStepOutput('test_step');
    expect(testStepOutput).toBeDefined();
    expect(testStepOutput.test_result.message).toBe('Hello from workflow engine!');
  });

  it('should handle step dependencies correctly', async () => {
    // Modify workflow to have invalid dependency
    const invalidWorkflowContent = `
name: "invalid-workflow"
version: "1.0"
steps:
  - name: "step1"
    type: "TestStep"
    depends_on: ["nonexistent_step"]
    config:
      message: "This should fail"
`;

    const workflowsDir = path.dirname(await engine.getLoadedWorkflows()[0] || path.join(tempRepo, 'workflows'));
    await fs.writeFile(path.join(workflowsDir, 'invalid-workflow.yaml'), invalidWorkflowContent);

    await expect(engine.loadWorkflow('invalid-workflow.yaml')).rejects.toThrow();
  });

  it('should support dry run mode', async () => {
    const result = await engine.executeWorkflow(
      'test-workflow.yaml',
      'test-project',
      tempRepo,
      'main',
      {
        dryRun: true
      }
    );

    expect(result.status).toBe('completed');
    // In dry run, steps should still execute but with dry run flag
    expect(result.executionSummary.completedSteps).toBe(2);
  });

  it('should handle workflow execution failures gracefully', async () => {
    // Create a workflow with a step that will fail
    const failingWorkflowContent = `
name: "failing-workflow"
version: "1.0"
steps:
  - name: "failing_step"
    type: "NonExistentStepType"
    config:
      message: "This will fail"
`;

    const workflowsDir = path.dirname(await engine.getLoadedWorkflows()[0] || path.join(tempRepo, 'workflows'));
    await fs.writeFile(path.join(workflowsDir, 'failing-workflow.yaml'), failingWorkflowContent);

    await expect(engine.loadWorkflow('failing-workflow.yaml')).rejects.toThrow();
  });

  it('should cache loaded workflows', async () => {
    // Load workflow twice
    const config1 = await engine.loadWorkflow('test-workflow.yaml');
    const config2 = await engine.loadWorkflow('test-workflow.yaml');
    
    // Should be the same object reference (cached)
    expect(config1).toBe(config2);
    
    // Clear cache and load again
    engine.clearCache();
    const config3 = await engine.loadWorkflow('test-workflow.yaml');
    
    // Should be different object reference but same content
    expect(config3).not.toBe(config1);
    expect(config3.name).toBe(config1.name);
  });
});

describe('WorkflowStepFactory', () => {
  it('should register and create step types', () => {
    WorkflowStepFactory.registerStep('TestStep', TestStep);
    
    const stepConfig = {
      name: 'test',
      type: 'TestStep',
      config: { message: 'test' }
    };
    
    const step = WorkflowStepFactory.createStep(stepConfig);
    expect(step).toBeInstanceOf(TestStep);
    expect(step.config.name).toBe('test');
  });

  it('should throw error for unknown step types', () => {
    const stepConfig = {
      name: 'test',
      type: 'UnknownStepType',
      config: {}
    };
    
    expect(() => WorkflowStepFactory.createStep(stepConfig)).toThrow('Unknown step type: UnknownStepType');
  });

  it('should list registered step types', () => {
    WorkflowStepFactory.registerStep('TestStep', TestStep);
    WorkflowStepFactory.registerStep('DiffApplyStep', DiffApplyStep);
    
    const types = WorkflowStepFactory.getRegisteredTypes();
    expect(types).toContain('TestStep');
    expect(types).toContain('DiffApplyStep');
  });
});