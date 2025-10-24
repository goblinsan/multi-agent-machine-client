import type { WorkflowStep, WorkflowStepConfig } from './WorkflowStep';
import type { WorkflowContext } from './WorkflowContext';
import type { WorkflowDefinition, WorkflowStepDefinition } from '../WorkflowEngine';
import { ConfigResolver } from './ConfigResolver';
import { personaTimeoutMs } from '../../util.js';
import { cfg } from '../../config.js';
import { logger } from '../../logger.js';

/**
 * Handles step execution, timeout management, and instance creation
 */
export class StepExecutor {
  private stepRegistry: Map<string, new (...args: any[]) => WorkflowStep>;
  private configResolver: ConfigResolver;

  constructor(stepRegistry: Map<string, new (...args: any[]) => WorkflowStep>) {
    this.stepRegistry = stepRegistry;
    this.configResolver = new ConfigResolver();
  }

  /**
   * Execute a single workflow step
   */
  async executeStep(
    stepDef: WorkflowStepDefinition,
    context: WorkflowContext,
    workflowDef: WorkflowDefinition
  ): Promise<boolean> {
    try {
      // Create step instance
      const step = this.createStepInstance(stepDef, context);
      
      // Record step start
      context.recordStepStart(stepDef.name);
      
      // Set up timeout
      const timeout = this.getStepTimeout(stepDef, workflowDef);
      
      // Log timeout for persona request steps
      if (stepDef.type === 'PersonaRequestStep') {
        context.logger.info('Step timeout configured', {
          workflowId: context.workflowId,
          step: stepDef.name,
          persona: stepDef.config.persona,
          timeoutMs: timeout,
          timeoutMinutes: (timeout / 60000).toFixed(2)
        });
      }
      
      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error(`Step '${stepDef.name}' timed out after ${timeout}ms`)), timeout);
      });

      // Execute step with timeout
      const stepPromise = step.execute(context);
      const result = await Promise.race([stepPromise, timeoutPromise]);

      // Store step outputs - prioritize outputs field, fall back to data
      if (result.outputs) {
        context.setStepOutput(stepDef.name, result.outputs);
      } else if (result.data) {
        context.setStepOutput(stepDef.name, result.data);
      }

      // Record completion
      context.recordStepComplete(stepDef.name, result.status === 'success' ? 'success' : 'failure');

      return result.status === 'success';

    } catch (error: any) {
      context.recordStepComplete(stepDef.name, 'failure', error.message);
      throw error;
    }
  }

  /**
   * Create a step instance from definition
   */
  private createStepInstance(stepDef: WorkflowStepDefinition, context: WorkflowContext): WorkflowStep {
    const StepClass = this.stepRegistry.get(stepDef.type);
    if (!StepClass) {
      throw new Error(`Unknown step type: ${stepDef.type}`);
    }

    // Resolve configuration values from context
    const resolvedConfig = this.configResolver.resolveConfiguration(stepDef.config, context);

    const stepConfig: WorkflowStepConfig = {
      name: stepDef.name,
      type: stepDef.type,
      description: stepDef.description,
      depends_on: stepDef.depends_on,
      condition: stepDef.condition,
      config: resolvedConfig,
      outputs: stepDef.outputs
    };

    return new StepClass(stepConfig);
  }

  /**
   * Get timeout for a step
   */
  private getStepTimeout(stepDef: WorkflowStepDefinition, workflowDef: WorkflowDefinition): number {
    const timeouts = workflowDef.timeouts || {};
    
    // Check for step-specific timeout
    const stepTimeout = timeouts[`${stepDef.name}_timeout`] || timeouts[`${stepDef.type.toLowerCase()}_step`];
    if (stepTimeout) {
      return stepTimeout;
    }
    
    // For PersonaRequestStep, calculate timeout based on persona config + retries + backoff
    if (stepDef.type === 'PersonaRequestStep' && stepDef.config.persona) {
      const persona = String(stepDef.config.persona).toLowerCase();
      const maxRetries = stepDef.config.maxRetries ?? cfg.personaTimeoutMaxRetries ?? 3;
      
      // Get persona-specific timeout using centralized util function
      const personaTimeout = personaTimeoutMs(persona, cfg);
      
      // Calculate total timeout: (maxRetries + 1 initial) * personaTimeout + sum of backoff delays
      // Backoff delays: 30s, 60s, 90s, ... = 30 * (1 + 2 + 3 + ... + maxRetries)
      // Sum formula: n * (n + 1) / 2
      const totalBackoffMs = maxRetries > 0 ? (30 * 1000 * maxRetries * (maxRetries + 1)) / 2 : 0;
      const totalPersonaTimeMs = (maxRetries + 1) * personaTimeout;
      const calculatedTimeout = totalPersonaTimeMs + totalBackoffMs + 30000; // +30s buffer
      
      logger.info('Calculated PersonaRequestStep timeout to accommodate retries', {
        step: stepDef.name,
        persona,
        personaTimeoutMs: personaTimeout,
        personaTimeoutMinutes: (personaTimeout / 60000).toFixed(2),
        maxRetries,
        totalBackoffMs,
        totalBackoffMinutes: (totalBackoffMs / 60000).toFixed(2),
        totalPersonaTimeMs,
        calculatedTimeout,
        calculatedTimeoutMinutes: (calculatedTimeout / 60000).toFixed(2)
      });
      
      return calculatedTimeout;
    }
    
    // Default timeout
    return timeouts.default_step || 300000; // 5 minutes
  }

  /**
   * Build step execution order based on dependencies
   */
  buildExecutionOrder(steps: WorkflowStepDefinition[]): string[] {
    const order: string[] = [];
    const visited = new Set<string>();
    const visiting = new Set<string>();
    
    const visit = (stepName: string) => {
      if (visiting.has(stepName)) {
        throw new Error(`Circular dependency detected involving step: ${stepName}`);
      }
      
      if (visited.has(stepName)) {
        return;
      }
      
      visiting.add(stepName);
      
      const step = steps.find(s => s.name === stepName);
      if (!step) {
        throw new Error(`Step not found: ${stepName}`);
      }
      
      // Visit dependencies first
      if (step.depends_on) {
        for (const dependency of step.depends_on) {
          visit(dependency);
        }
      }
      
      visiting.delete(stepName);
      visited.add(stepName);
      order.push(stepName);
    };
    
    // Visit all steps
    for (const step of steps) {
      visit(step.name);
    }
    
    return order;
  }
}
