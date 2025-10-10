import { WorkflowStep, WorkflowStepConfig, StepResult } from '../engine/WorkflowStep.js';
import { WorkflowContext } from '../engine/WorkflowContext.js';

/**
 * Simple test step for validating workflow engine
 */
export class TestStep extends WorkflowStep {
  constructor(config: WorkflowStepConfig) {
    super(config);
  }

  async execute(context: WorkflowContext): Promise<StepResult> {
    const stepConfig = this.config.config || {};
    const message = stepConfig.message || 'Test step executed';
    const delay = stepConfig.delay_ms || 0;

    context.logger.info('Test step starting', {
      stepName: this.config.name,
      message,
      delay
    });

    // Simulate some work
    if (delay > 0) {
      await new Promise(resolve => setTimeout(resolve, delay));
    }

    const result = {
      message,
      timestamp: new Date().toISOString(),
      stepName: this.config.name
    };

    context.logger.info('Test step completed', {
      stepName: this.config.name,
      result
    });

    return {
      status: 'success',
      data: result,
      outputs: {
        test_result: result
      }
    };
  }
}