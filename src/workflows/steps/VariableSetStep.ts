import { WorkflowStep, StepResult, ValidationResult } from '../engine/WorkflowStep.js';
import { WorkflowContext } from '../engine/WorkflowContext.js';

interface VariableSetStepConfig {
  variables: Record<string, string>;
}

/**
 * Simple step to set workflow variables
 * Useful for updating state based on conditional logic
 */
export class VariableSetStep extends WorkflowStep {
  async execute(context: WorkflowContext): Promise<StepResult> {
    const config = this.config.config as VariableSetStepConfig;
    
    if (!config.variables) {
      return {
        status: 'failure',
        error: new Error('VariableSetStep requires variables configuration')
      };
    }

    context.logger.info('Setting workflow variables', {
      stepName: this.config.name,
      variableKeys: Object.keys(config.variables)
    });

    // Resolve variable values (they may contain template strings)
    const resolvedVariables: Record<string, any> = {};
    
    for (const [key, value] of Object.entries(config.variables)) {
      if (typeof value === 'string' && value.includes('${')) {
        // Variable reference - resolve it
        const resolved = this.resolveTemplateString(value, context);
        resolvedVariables[key] = resolved;
        context.setVariable(key, resolved);
      } else {
        // Literal value
        resolvedVariables[key] = value;
        context.setVariable(key, value);
      }
    }

    context.logger.info('Variables set successfully', {
      stepName: this.config.name,
      variables: resolvedVariables
    });

    return {
      status: 'success',
      data: { variables: resolvedVariables }
    };
  }

  /**
   * Resolve template string like "${variable_name}"
   */
  private resolveTemplateString(template: string, context: WorkflowContext): any {
    const match = template.match(/^\$\{([^}]+)\}$/);
    if (match) {
      const varName = match[1];
      return context.getVariable(varName);
    }
    
    // If not a simple variable reference, return as-is
    // (could be enhanced to support more complex templates)
    return template;
  }

  protected async validateConfig(context: WorkflowContext): Promise<ValidationResult> {
    const config = this.config.config as VariableSetStepConfig;
    const errors: string[] = [];

    if (!config.variables || typeof config.variables !== 'object') {
      errors.push('variables must be an object');
    }

    if (Object.keys(config.variables || {}).length === 0) {
      errors.push('At least one variable must be specified');
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings: []
    };
  }
}
