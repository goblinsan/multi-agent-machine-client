import type { WorkflowContext } from './WorkflowContext';
import { evaluateCondition as evaluateConditionUtil } from './conditionUtils';


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


export interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}


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


export abstract class WorkflowStep {
  constructor(
    public readonly config: WorkflowStepConfig
  ) {}

  
  abstract execute(context: WorkflowContext): Promise<StepResult>;

  
  async validate(context: WorkflowContext): Promise<ValidationResult> {
    const errors: string[] = [];
    const warnings: string[] = [];

    
    if (!this.config.name) {
      errors.push('Step name is required');
    }

    if (!this.config.type) {
      errors.push('Step type is required');
    }

    
    if (this.config.depends_on) {
      for (const dep of this.config.depends_on) {
        if (!context.hasStepOutput(dep)) {
          errors.push(`Dependency '${dep}' not found in context`);
        }
      }
    }

    
    const subValidation = await this.validateConfig(context);
    errors.push(...subValidation.errors);
    warnings.push(...subValidation.warnings);

    return {
      valid: errors.length === 0,
      errors,
      warnings
    };
  }

  
  async rollback?(context: WorkflowContext): Promise<void>;

  
  getEstimatedDuration(): number {
    return this.config.timeout || 60000;
  }

  
  async shouldExecute(context: WorkflowContext): Promise<boolean> {
    if (!this.config.condition) {
      return true;
    }

    try {
      
      
      const result = evaluateConditionUtil(this.config.condition, context);
      
      
      context.logger.info('Condition evaluated', {
        step: this.config.name,
        condition: this.config.condition,
        result,
        willExecute: result
      });
      
      return result;
    } catch (error) {
      context.logger.warn('Condition evaluation failed, defaulting to true', {
        step: this.config.name,
        condition: this.config.condition,
        error: String(error)
      });
      return true;
    }
  }

  
  protected async validateConfig(_context: WorkflowContext): Promise<ValidationResult> {
    return { valid: true, errors: [], warnings: [] };
  }
}


export class WorkflowStepFactory {
  private static stepTypes = new Map<string, new (config: WorkflowStepConfig) => WorkflowStep>();

  
  static registerStep<T extends WorkflowStep>(
    type: string,
    stepClass: new (config: WorkflowStepConfig) => T
  ): void {
    this.stepTypes.set(type, stepClass);
  }

  
  static createStep(config: WorkflowStepConfig): WorkflowStep {
    const StepClass = this.stepTypes.get(config.type);
    if (!StepClass) {
      throw new Error(`Unknown step type: ${config.type}`);
    }

    return new StepClass(config);
  }

  
  static getRegisteredTypes(): string[] {
    return Array.from(this.stepTypes.keys());
  }
}