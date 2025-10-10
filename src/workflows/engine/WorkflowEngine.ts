import fs from 'fs/promises';
import path from 'path';
import { randomUUID } from 'crypto';
import YAML from 'yaml';
import { WorkflowContext, WorkflowConfig } from './WorkflowContext.js';
import { WorkflowStep, WorkflowStepConfig, WorkflowStepFactory, StepResult } from './WorkflowStep.js';
import { WorkflowValidator, SchemaValidationResult } from './WorkflowValidator.js';
import { logger } from '../../logger.js';

/**
 * Result of workflow execution
 */
export interface WorkflowResult {
  workflowId: string;
  status: 'completed' | 'failed' | 'cancelled';
  error?: Error;
  executionSummary: {
    totalSteps: number;
    completedSteps: number;
    failedSteps: number;
    skippedSteps: number;
    totalDuration_ms: number;
  };
  context: WorkflowContext;
}

/**
 * Workflow execution options
 */
export interface WorkflowExecutionOptions {
  workflowId?: string;
  dryRun?: boolean;
  skipValidation?: boolean;
  continueOnError?: boolean;
  maxStepRetries?: number;
  variables?: Record<string, any>;
}

/**
 * Main workflow engine for loading and executing YAML workflows
 */
export class WorkflowEngine {
  private workflowCache = new Map<string, WorkflowConfig>();
  private readonly workflowsDirectory: string;

  constructor(workflowsDirectory: string = './src/workflows/definitions') {
    this.workflowsDirectory = path.resolve(workflowsDirectory);
  }

  /**
   * Load workflow from YAML file
   */
  async loadWorkflow(workflowPath: string): Promise<WorkflowConfig> {
    const fullPath = path.resolve(this.workflowsDirectory, workflowPath);
    
    // Check cache first
    if (this.workflowCache.has(fullPath)) {
      return this.workflowCache.get(fullPath)!;
    }

    try {
      const yamlContent = await fs.readFile(fullPath, 'utf-8');
      const config = YAML.parse(yamlContent) as WorkflowConfig;

      // Validate the workflow
      const validation = WorkflowValidator.validateWithStepTypes(
        config, 
        WorkflowStepFactory.getRegisteredTypes()
      );

      if (!validation.valid) {
        throw new Error(`Invalid workflow configuration in ${workflowPath}:\n${this.formatValidationErrors(validation)}`);
      }

      // Log warnings if any
      if (validation.warnings.length > 0) {
        logger.warn('Workflow validation warnings', {
          workflowPath,
          warnings: validation.warnings
        });
      }

      // Cache the validated config
      this.workflowCache.set(fullPath, config);
      
      return config;
    } catch (error) {
      throw new Error(`Failed to load workflow from ${workflowPath}: ${error}`);
    }
  }

  /**
   * Execute a workflow
   */
  async executeWorkflow(
    workflowPath: string,
    projectId: string,
    repoRoot: string,
    branch: string,
    options: WorkflowExecutionOptions = {}
  ): Promise<WorkflowResult> {
    const workflowId = options.workflowId || randomUUID();
    const config = await this.loadWorkflow(workflowPath);
    
    const context = new WorkflowContext(
      workflowId,
      projectId,
      repoRoot,
      branch,
      config,
      options.variables || {}
    );

    logger.info('Starting workflow execution', {
      workflowId,
      workflowName: config.name,
      workflowVersion: config.version,
      projectId,
      repoRoot,
      branch,
      dryRun: options.dryRun || false
    });

    try {
      // Validate trigger condition if present
      if (config.trigger?.condition && !options.skipValidation) {
        const shouldExecute = await this.evaluateTriggerCondition(config.trigger.condition, context);
        if (!shouldExecute) {
          logger.info('Workflow trigger condition not met, skipping execution', {
            workflowId,
            condition: config.trigger.condition
          });
          
          return {
            workflowId,
            status: 'completed',
            executionSummary: { totalSteps: 0, completedSteps: 0, failedSteps: 0, skippedSteps: 0, totalDuration_ms: 0 },
            context
          };
        }
      }

      // Execute workflow steps
      const stepResults = await this.executeSteps(config.steps, context, options);
      
      const summary = context.getExecutionSummary();
      const hasFailures = summary.failedSteps > 0;

      logger.info('Workflow execution completed', {
        workflowId,
        status: hasFailures ? 'failed' : 'completed',
        summary
      });

      return {
        workflowId,
        status: hasFailures ? 'failed' : 'completed',
        executionSummary: summary,
        context
      };

    } catch (error) {
      logger.error('Workflow execution failed', {
        workflowId,
        error: String(error),
        stack: error instanceof Error ? error.stack : undefined
      });

      return {
        workflowId,
        status: 'failed',
        error: error instanceof Error ? error : new Error(String(error)),
        executionSummary: context.getExecutionSummary(),
        context
      };
    }
  }

  /**
   * Execute workflow steps in order, respecting dependencies
   */
  private async executeSteps(
    stepConfigs: WorkflowStepConfig[],
    context: WorkflowContext,
    options: WorkflowExecutionOptions
  ): Promise<StepResult[]> {
    const results: StepResult[] = [];
    const executedSteps = new Set<string>();
    const pendingSteps = [...stepConfigs];

    while (pendingSteps.length > 0) {
      const readySteps = pendingSteps.filter(step => {
        // Check if all dependencies are satisfied
        if (!step.depends_on) return true;
        return step.depends_on.every(dep => executedSteps.has(dep));
      });

      if (readySteps.length === 0) {
        // No steps are ready - check for circular dependencies or missing steps
        const remainingSteps = pendingSteps.map(s => s.name).join(', ');
        throw new Error(`No steps ready to execute. Remaining steps: ${remainingSteps}. Check for circular dependencies.`);
      }

      // Execute ready steps (could be parallelized in the future)
      for (const stepConfig of readySteps) {
        try {
          const result = await this.executeStep(stepConfig, context, options);
          results.push(result);

          if (result.status === 'success') {
            executedSteps.add(stepConfig.name);
          } else if (result.status === 'failure' && !options.continueOnError) {
            throw new Error(`Step '${stepConfig.name}' failed: ${result.error?.message}`);
          }

        } catch (error) {
          const failureResult: StepResult = {
            status: 'failure',
            error: error instanceof Error ? error : new Error(String(error))
          };
          results.push(failureResult);

          if (!options.continueOnError) {
            throw error;
          }
        }

        // Remove executed step from pending
        const stepIndex = pendingSteps.findIndex(s => s.name === stepConfig.name);
        if (stepIndex >= 0) {
          pendingSteps.splice(stepIndex, 1);
        }
      }
    }

    return results;
  }

  /**
   * Execute a single workflow step
   */
  private async executeStep(
    stepConfig: WorkflowStepConfig,
    context: WorkflowContext,
    options: WorkflowExecutionOptions
  ): Promise<StepResult> {
    const startTime = Date.now();
    context.recordStepStart(stepConfig.name);

    try {
      // Create step instance
      const step = WorkflowStepFactory.createStep(stepConfig);

      // Check if step should be executed based on condition
      const shouldExecute = await step.shouldExecute(context);
      if (!shouldExecute) {
        context.logger.info('Step skipped due to condition', {
          stepName: stepConfig.name,
          condition: stepConfig.condition
        });
        
        const result: StepResult = {
          status: 'skipped',
          metrics: {
            duration_ms: Date.now() - startTime
          }
        };

        context.recordStepComplete(stepConfig.name, 'skipped');
        return result;
      }

      // Validate step
      if (!options.skipValidation) {
        const validation = await step.validate(context);
        if (!validation.valid) {
          throw new Error(`Step validation failed: ${validation.errors.join(', ')}`);
        }

        if (validation.warnings.length > 0) {
          context.logger.warn('Step validation warnings', {
            stepName: stepConfig.name,
            warnings: validation.warnings
          });
        }
      }

      // Execute step with retry logic
      const maxRetries = options.maxStepRetries || stepConfig.retry?.count || 0;
      let lastError: Error | undefined;

      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
          if (attempt > 0) {
            const delay = this.calculateRetryDelay(stepConfig.retry, attempt);
            context.logger.info('Retrying step execution', {
              stepName: stepConfig.name,
              attempt,
              delay_ms: delay
            });
            await this.sleep(delay);
          }

          context.logger.info('Executing step', {
            stepName: stepConfig.name,
            stepType: stepConfig.type,
            attempt: attempt + 1,
            dryRun: options.dryRun || false
          });

          // Execute the step
          const result = options.dryRun 
            ? { status: 'success' as const, data: { dryRun: true }, outputs: { [`${stepConfig.name}_result`]: { dryRun: true } } }
            : await step.execute(context);

          // Store step outputs in context
          if (result.outputs) {
            context.setStepOutput(stepConfig.name, result.outputs);
          }

          // Update metrics
          result.metrics = {
            ...result.metrics,
            duration_ms: Date.now() - startTime
          };

          context.recordStepComplete(stepConfig.name, result.status);

          context.logger.info('Step completed', {
            stepName: stepConfig.name,
            status: result.status,
            duration_ms: result.metrics.duration_ms
          });

          return result;

        } catch (error) {
          lastError = error instanceof Error ? error : new Error(String(error));
          
          if (attempt === maxRetries) {
            // Final attempt failed
            break;
          }

          context.logger.warn('Step execution failed, will retry', {
            stepName: stepConfig.name,
            attempt: attempt + 1,
            maxRetries,
            error: String(error)
          });
        }
      }

      // All attempts failed
      const result: StepResult = {
        status: 'failure',
        error: lastError,
        metrics: {
          duration_ms: Date.now() - startTime
        }
      };

      context.recordStepComplete(stepConfig.name, 'failure', lastError?.message);
      return result;

    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      
      const result: StepResult = {
        status: 'failure',
        error: err,
        metrics: {
          duration_ms: Date.now() - startTime
        }
      };

      context.recordStepComplete(stepConfig.name, 'failure', err.message);
      return result;
    }
  }

  /**
   * Calculate retry delay with exponential backoff
   */
  private calculateRetryDelay(retryConfig: WorkflowStepConfig['retry'], attempt: number): number {
    if (!retryConfig) return 1000; // Default 1 second

    const baseDelay = retryConfig.delay_ms || 1000;
    const multiplier = retryConfig.backoff_multiplier || 2;
    
    return baseDelay * Math.pow(multiplier, attempt - 1);
  }

  /**
   * Sleep for specified milliseconds
   */
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Evaluate trigger condition (placeholder for now)
   */
  private async evaluateTriggerCondition(condition: string, context: WorkflowContext): Promise<boolean> {
    // Simple implementation - can be enhanced with a proper expression engine
    context.logger.debug('Evaluating trigger condition', { condition });
    
    // For now, assume all conditions pass
    // TODO: Implement proper condition evaluation
    return true;
  }

  /**
   * Format validation errors for display
   */
  private formatValidationErrors(validation: { errors: Array<{ path: string; message: string; value?: any }> }): string {
    return validation.errors
      .map(error => `  - ${error.path}: ${error.message}${error.value !== undefined ? ` (value: ${error.value})` : ''}`)
      .join('\n');
  }

  /**
   * Clear workflow cache
   */
  clearCache(): void {
    this.workflowCache.clear();
  }

  /**
   * Get loaded workflows
   */
  getLoadedWorkflows(): string[] {
    return Array.from(this.workflowCache.keys());
  }
}