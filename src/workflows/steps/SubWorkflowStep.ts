import { WorkflowStep, StepResult, ValidationResult, WorkflowStepConfig } from '../engine/WorkflowStep.js';
import { WorkflowContext } from '../engine/WorkflowContext.js';
import { WorkflowEngine, WorkflowDefinition } from '../WorkflowEngine.js';
import { join } from 'path';
import { logger } from '../../logger.js';

/**
 * Configuration for SubWorkflowStep
 */
interface SubWorkflowConfig {
  workflow: string;              // Name of sub-workflow to execute
  inputs?: Record<string, any>;  // Input variables to pass to sub-workflow
  outputs?: Record<string, string>; // Output mapping: parent_var_name → sub_workflow_var_name
}

/**
 * Step that executes a sub-workflow with isolated context
 * 
 * This enables workflow composition and reusability by allowing workflows
 * to call other workflows as steps, passing inputs and receiving outputs.
 * 
 * Example usage in YAML:
 * ```yaml
 * - name: handle_review_failure
 *   type: SubWorkflowStep
 *   config:
 *     workflow: "review-failure-handling"
 *     inputs:
 *       review_type: "qa"
 *       review_result: "${qa_request_result}"
 *       milestone_context:
 *         id: "${milestone}"
 *         name: "${milestone_name}"
 *     outputs:
 *       tasks_created: "tasks_created"
 *       urgent_count: "urgent_tasks_created"
 * ```
 */
export class SubWorkflowStep extends WorkflowStep {
  private workflowEngine: WorkflowEngine;

  constructor(config: WorkflowStepConfig) {
    super(config);
    this.workflowEngine = new WorkflowEngine();
  }

  /**
   * Validate sub-workflow configuration
   */
  protected async validateConfig(context: WorkflowContext): Promise<ValidationResult> {
    const errors: string[] = [];
    const warnings: string[] = [];
    const stepConfig = this.config.config as SubWorkflowConfig;

    if (!stepConfig.workflow) {
      errors.push('Sub-workflow name is required (config.workflow)');
    }

    if (stepConfig.workflow && typeof stepConfig.workflow !== 'string') {
      errors.push('Sub-workflow name must be a string');
    }

    if (stepConfig.inputs && typeof stepConfig.inputs !== 'object') {
      errors.push('Sub-workflow inputs must be an object');
    }

    if (stepConfig.outputs && typeof stepConfig.outputs !== 'object') {
      errors.push('Sub-workflow output mapping must be an object');
    }

    return { valid: errors.length === 0, errors, warnings };
  }

  /**
   * Execute sub-workflow with isolated context
   */
  async execute(context: WorkflowContext): Promise<StepResult> {
    const stepConfig = this.config.config as SubWorkflowConfig;
    const startTime = Date.now();

    try {
      context.logger.info('Starting sub-workflow execution', {
        stepName: this.config.name,
        subWorkflow: stepConfig.workflow,
        workflowId: context.workflowId
      });

      // Load sub-workflow definition
      const subWorkflowPath = join(
        process.cwd(),
        'src/workflows/sub-workflows',
        `${stepConfig.workflow}.yaml`
      );

      let subWorkflowDef: WorkflowDefinition;
      try {
        subWorkflowDef = await this.workflowEngine.loadWorkflowFromFile(subWorkflowPath);
      } catch (error: any) {
        throw new Error(`Failed to load sub-workflow '${stepConfig.workflow}': ${error.message}`);
      }

      // Prepare input variables for sub-workflow
      const subWorkflowInputs = this.resolveInputs(stepConfig.inputs || {}, context);

      context.logger.info('Sub-workflow inputs prepared', {
        stepName: this.config.name,
        subWorkflow: stepConfig.workflow,
        inputKeys: Object.keys(subWorkflowInputs)
      });

      // Execute sub-workflow with isolated context
      // Pass through parent context variables (projectId, repoRoot, branch)
      const result = await this.workflowEngine.executeWorkflowDefinition(
        subWorkflowDef,
        context.projectId,
        context.repoRoot,
        context.branch,
        subWorkflowInputs
      );

      if (!result.success) {
        const error = result.error || new Error(`Sub-workflow '${stepConfig.workflow}' failed at step '${result.failedStep}'`);
        context.logger.error('Sub-workflow execution failed', {
          stepName: this.config.name,
          subWorkflow: stepConfig.workflow,
          failedStep: result.failedStep,
          error: error.message
        });

        return {
          status: 'failure',
          error,
          metrics: {
            duration_ms: Date.now() - startTime
          }
        };
      }

      // Map sub-workflow outputs back to parent context
      const outputs = this.mapOutputs(stepConfig.outputs || {}, result.finalContext);

      context.logger.info('Sub-workflow completed successfully', {
        stepName: this.config.name,
        subWorkflow: stepConfig.workflow,
        duration_ms: result.duration,
        outputKeys: Object.keys(outputs)
      });

      return {
        status: 'success',
        data: {
          subWorkflow: stepConfig.workflow,
          completedSteps: result.completedSteps,
          duration: result.duration
        },
        outputs,
        metrics: {
          duration_ms: Date.now() - startTime
        }
      };

    } catch (error: any) {
      context.logger.error('Sub-workflow step failed', {
        stepName: this.config.name,
        subWorkflow: stepConfig.workflow,
        error: error.message,
        stack: error.stack
      });

      return {
        status: 'failure',
        error: error instanceof Error ? error : new Error(String(error)),
        metrics: {
          duration_ms: Date.now() - startTime
        }
      };
    }
  }

  /**
   * Resolve input values from parent context
   * Supports direct values and variable references (e.g., "${var_name}")
   */
  private resolveInputs(inputs: Record<string, any>, context: WorkflowContext): Record<string, any> {
    const resolved: Record<string, any> = {};

    for (const [key, value] of Object.entries(inputs)) {
      resolved[key] = this.resolveValue(value, context);
    }

    return resolved;
  }

  /**
   * Recursively resolve a value, handling variable references and nested objects
   */
  private resolveValue(value: any, context: WorkflowContext): any {
    if (value === null || value === undefined) {
      return value;
    }

    // Handle string variable references: "${variable_name}"
    if (typeof value === 'string') {
      const match = value.match(/^\$\{(.+)\}$/);
      if (match) {
        const varName = match[1];
        return context.getVariable(varName);
      }
      return value;
    }

    // Handle arrays
    if (Array.isArray(value)) {
      return value.map(item => this.resolveValue(item, context));
    }

    // Handle objects
    if (typeof value === 'object') {
      const resolved: Record<string, any> = {};
      for (const [k, v] of Object.entries(value)) {
        resolved[k] = this.resolveValue(v, context);
      }
      return resolved;
    }

    // Primitive values pass through
    return value;
  }

  /**
   * Map sub-workflow outputs to parent context variables
   * 
   * @param outputMapping - Map of parent variable names to sub-workflow variable names
   * @param subContext - Sub-workflow context containing outputs
   * @returns Mapped outputs for parent context
   */
  private mapOutputs(
    outputMapping: Record<string, string>,
    subContext: WorkflowContext
  ): Record<string, any> {
    const outputs: Record<string, any> = {};

    for (const [parentVar, subVar] of Object.entries(outputMapping)) {
      const value = subContext.getVariable(subVar);
      if (value !== undefined) {
        outputs[parentVar] = value;
      } else {
        logger.warn('Sub-workflow output variable not found', {
          stepName: this.config.name,
          parentVar,
          subVar
        });
      }
    }

    return outputs;
  }
}
