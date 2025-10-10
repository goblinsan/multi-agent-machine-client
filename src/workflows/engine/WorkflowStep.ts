import { WorkflowContext } from './WorkflowContext.js';

/**
 * Result of a workflow step execution
 */
export interface StepResult {
  status: 'success' | 'failure' | 'skipped';
  data?: Record<string, any>;
  error?: Error;
  outputs?: Record<string, any>;
  metrics?: {
    duration_ms: number;
    memory_mb?: number;
    operations_count?: number;
  };
}

/**
 * Validation result for step configuration
 */
export interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

/**
 * Configuration for a workflow step from YAML
 */
export interface WorkflowStepConfig {
  name: string;
  type: string;
  description?: string;
  persona?: string;
  depends_on?: string[];
  condition?: string;
  config?: Record<string, any>;
  outputs?: string[];
  timeout?: number;
  retry?: {
    count: number;
    delay_ms: number;
    backoff_multiplier?: number;
  };
}

/**
 * Abstract base class for all workflow steps
 */
export abstract class WorkflowStep {
  constructor(
    public readonly config: WorkflowStepConfig
  ) {}

  /**
   * Execute the workflow step
   */
  abstract execute(context: WorkflowContext): Promise<StepResult>;

  /**
   * Validate step configuration and context requirements
   */
  async validate(context: WorkflowContext): Promise<ValidationResult> {
    const errors: string[] = [];
    const warnings: string[] = [];

    // Basic validation
    if (!this.config.name) {
      errors.push('Step name is required');
    }

    if (!this.config.type) {
      errors.push('Step type is required');
    }

    // Check dependencies
    if (this.config.depends_on) {
      for (const dep of this.config.depends_on) {
        if (!context.hasStepOutput(dep)) {
          errors.push(`Dependency '${dep}' not found in context`);
        }
      }
    }

    // Allow subclasses to add their own validation
    const subValidation = await this.validateConfig(context);
    errors.push(...subValidation.errors);
    warnings.push(...subValidation.warnings);

    return {
      valid: errors.length === 0,
      errors,
      warnings
    };
  }

  /**
   * Rollback changes made by this step (optional)
   */
  async rollback?(context: WorkflowContext): Promise<void>;

  /**
   * Get estimated execution time for planning purposes
   */
  getEstimatedDuration(): number {
    return this.config.timeout || 60000; // Default 1 minute
  }

  /**
   * Check if step should be executed based on condition
   */
  async shouldExecute(context: WorkflowContext): Promise<boolean> {
    if (!this.config.condition) {
      return true;
    }

    try {
      // Simple condition evaluation - can be enhanced with a proper expression engine
      return this.evaluateCondition(this.config.condition, context);
    } catch (error) {
      context.logger.warn('Condition evaluation failed, defaulting to true', {
        step: this.config.name,
        condition: this.config.condition,
        error: String(error)
      });
      return true;
    }
  }

  /**
   * Subclasses can override this for custom validation
   */
  protected async validateConfig(context: WorkflowContext): Promise<ValidationResult> {
    return { valid: true, errors: [], warnings: [] };
  }

  /**
   * Simple condition evaluation - can be enhanced with a proper expression engine
   */
  private evaluateCondition(condition: string, context: WorkflowContext): boolean {
    // For now, support simple equality checks
    // Example: "plan_status == 'pass'"
    const eqMatch = condition.match(/^(\w+)\s*==\s*'([^']*)'$/);
    if (eqMatch) {
      const [, variable, value] = eqMatch;
      const contextValue = context.getVariable(variable);
      return contextValue === value;
    }

    // Add more condition types as needed
    throw new Error(`Unsupported condition format: ${condition}`);
  }
}

/**
 * Factory for creating workflow steps from configuration
 */
export class WorkflowStepFactory {
  private static stepTypes = new Map<string, new (config: WorkflowStepConfig) => WorkflowStep>();

  /**
   * Register a step type
   */
  static registerStep<T extends WorkflowStep>(
    type: string,
    stepClass: new (config: WorkflowStepConfig) => T
  ): void {
    this.stepTypes.set(type, stepClass);
  }

  /**
   * Create a step instance from configuration
   */
  static createStep(config: WorkflowStepConfig): WorkflowStep {
    const StepClass = this.stepTypes.get(config.type);
    if (!StepClass) {
      throw new Error(`Unknown step type: ${config.type}`);
    }

    return new StepClass(config);
  }

  /**
   * Get all registered step types
   */
  static getRegisteredTypes(): string[] {
    return Array.from(this.stepTypes.keys());
  }
}