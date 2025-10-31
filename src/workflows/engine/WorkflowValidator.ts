import { WorkflowConfig as _WorkflowConfig } from './WorkflowContext.js';

/**
 * Schema validation error
 */
export interface SchemaValidationError {
  path: string;
  message: string;
  value?: any;
}

/**
 * Schema validation result
 */
export interface SchemaValidationResult {
  valid: boolean;
  errors: SchemaValidationError[];
  warnings: SchemaValidationError[];
}

/**
 * Workflow configuration validator
 */
export class WorkflowValidator {
  /**
   * Validate a workflow configuration
   */
  static validateWorkflow(config: any): SchemaValidationResult {
    const errors: SchemaValidationError[] = [];
    const warnings: SchemaValidationError[] = [];

    // Check required fields
    if (!config.name) {
      errors.push({ path: 'name', message: 'Workflow name is required' });
    }

    if (!config.version) {
      errors.push({ path: 'version', message: 'Workflow version is required' });
    }

    if (!config.steps || !Array.isArray(config.steps)) {
      errors.push({ path: 'steps', message: 'Workflow must have steps array' });
    } else {
      // Validate each step
      config.steps.forEach((step: any, index: number) => {
        const stepErrors = this.validateStep(step, `steps[${index}]`);
        errors.push(...stepErrors.errors);
        warnings.push(...stepErrors.warnings);
      });

      // Validate step dependencies
      const dependencyErrors = this.validateStepDependencies(config.steps);
      errors.push(...dependencyErrors);
    }

    // Validate trigger if present
    if (config.trigger) {
      const triggerErrors = this.validateTrigger(config.trigger);
      errors.push(...triggerErrors);
    }

    // Validate context if present
    if (config.context) {
      const contextErrors = this.validateContext(config.context);
      errors.push(...contextErrors);
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings
    };
  }

  /**
   * Validate a single workflow step
   */
  private static validateStep(step: any, path: string): SchemaValidationResult {
    const errors: SchemaValidationError[] = [];
    const warnings: SchemaValidationError[] = [];

    // Required fields
    if (!step.name) {
      errors.push({ path: `${path}.name`, message: 'Step name is required' });
    }

    if (!step.type) {
      errors.push({ path: `${path}.type`, message: 'Step type is required' });
    }

    // Validate name format (alphanumeric, underscores, hyphens)
    if (step.name && !/^[a-zA-Z0-9_-]+$/.test(step.name)) {
      errors.push({
        path: `${path}.name`,
        message: 'Step name must contain only alphanumeric characters, underscores, and hyphens',
        value: step.name
      });
    }

    // Validate dependencies
    if (step.depends_on) {
      if (!Array.isArray(step.depends_on)) {
        errors.push({
          path: `${path}.depends_on`,
          message: 'depends_on must be an array of step names'
        });
      } else {
        step.depends_on.forEach((dep: any, depIndex: number) => {
          if (typeof dep !== 'string') {
            errors.push({
              path: `${path}.depends_on[${depIndex}]`,
              message: 'Dependency must be a string (step name)'
            });
          }
        });
      }
    }

    // Validate outputs
    if (step.outputs) {
      if (!Array.isArray(step.outputs)) {
        errors.push({
          path: `${path}.outputs`,
          message: 'outputs must be an array of strings'
        });
      } else {
        step.outputs.forEach((output: any, outputIndex: number) => {
          if (typeof output !== 'string') {
            errors.push({
              path: `${path}.outputs[${outputIndex}]`,
              message: 'Output must be a string'
            });
          }
        });
      }
    }

    // Validate timeout
    if (step.timeout !== undefined) {
      if (typeof step.timeout !== 'number' || step.timeout <= 0) {
        errors.push({
          path: `${path}.timeout`,
          message: 'timeout must be a positive number (milliseconds)',
          value: step.timeout
        });
      }
    }

    // Validate retry configuration
    if (step.retry) {
      if (typeof step.retry.count !== 'number' || step.retry.count < 0) {
        errors.push({
          path: `${path}.retry.count`,
          message: 'retry.count must be a non-negative number',
          value: step.retry.count
        });
      }

      if (typeof step.retry.delay_ms !== 'number' || step.retry.delay_ms < 0) {
        errors.push({
          path: `${path}.retry.delay_ms`,
          message: 'retry.delay_ms must be a non-negative number',
          value: step.retry.delay_ms
        });
      }

      if (step.retry.backoff_multiplier !== undefined) {
        if (typeof step.retry.backoff_multiplier !== 'number' || step.retry.backoff_multiplier <= 0) {
          errors.push({
            path: `${path}.retry.backoff_multiplier`,
            message: 'retry.backoff_multiplier must be a positive number',
            value: step.retry.backoff_multiplier
          });
        }
      }
    }

    return { valid: errors.length === 0, errors, warnings };
  }

  /**
   * Validate step dependencies for circular references and missing steps
   */
  private static validateStepDependencies(steps: any[]): SchemaValidationError[] {
    const errors: SchemaValidationError[] = [];
    const stepNames = new Set(steps.map(step => step.name).filter(Boolean));

    // Check for missing dependencies
    steps.forEach((step, index) => {
      if (step.depends_on && Array.isArray(step.depends_on)) {
        step.depends_on.forEach((dep: string) => {
          if (!stepNames.has(dep)) {
            errors.push({
              path: `steps[${index}].depends_on`,
              message: `Dependency '${dep}' not found in workflow steps`,
              value: dep
            });
          }
        });
      }
    });

    // Check for circular dependencies
    const visited = new Set<string>();
    const recursionStack = new Set<string>();

    const hasCircularDependency = (stepName: string): boolean => {
      if (recursionStack.has(stepName)) {
        return true;
      }

      if (visited.has(stepName)) {
        return false;
      }

      visited.add(stepName);
      recursionStack.add(stepName);

      const step = steps.find(s => s.name === stepName);
      if (step?.depends_on) {
        for (const dep of step.depends_on) {
          if (hasCircularDependency(dep)) {
            return true;
          }
        }
      }

      recursionStack.delete(stepName);
      return false;
    };

    for (const step of steps) {
      if (step.name && hasCircularDependency(step.name)) {
        errors.push({
          path: 'steps',
          message: `Circular dependency detected involving step '${step.name}'`,
          value: step.name
        });
        break;
      }
    }

    return errors;
  }

  /**
   * Validate workflow trigger configuration
   */
  private static validateTrigger(trigger: any): SchemaValidationError[] {
    const errors: SchemaValidationError[] = [];

    if (trigger.condition && typeof trigger.condition !== 'string') {
      errors.push({
        path: 'trigger.condition',
        message: 'trigger.condition must be a string',
        value: trigger.condition
      });
    }

    return errors;
  }

  /**
   * Validate workflow context configuration
   */
  private static validateContext(context: any): SchemaValidationError[] {
    const errors: SchemaValidationError[] = [];

    if (context.repo_required !== undefined && typeof context.repo_required !== 'boolean') {
      errors.push({
        path: 'context.repo_required',
        message: 'context.repo_required must be a boolean',
        value: context.repo_required
      });
    }

    if (context.branch_strategy !== undefined && typeof context.branch_strategy !== 'string') {
      errors.push({
        path: 'context.branch_strategy',
        message: 'context.branch_strategy must be a string',
        value: context.branch_strategy
      });
    }

    return errors;
  }

  /**
   * Validate workflow configuration against known step types
   */
  static validateWithStepTypes(config: any, availableStepTypes: string[]): SchemaValidationResult {
    const baseValidation = this.validateWorkflow(config);
    const errors = [...baseValidation.errors];
    const warnings = [...baseValidation.warnings];

    if (config.steps && Array.isArray(config.steps)) {
      config.steps.forEach((step: any, index: number) => {
        if (step.type && !availableStepTypes.includes(step.type)) {
          errors.push({
            path: `steps[${index}].type`,
            message: `Unknown step type '${step.type}'. Available types: ${availableStepTypes.join(', ')}`,
            value: step.type
          });
        }
      });
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings
    };
  }
}