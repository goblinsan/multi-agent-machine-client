import { WorkflowStep, StepResult, ValidationResult } from '../engine/WorkflowStep.js';
import { WorkflowContext } from '../engine/WorkflowContext.js';

interface VariableSetStepConfig {
  variables: Record<string, string>;
}


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

    
    const resolvedVariables: Record<string, any> = {};
    
    for (const [key, value] of Object.entries(config.variables)) {
      if (typeof value === 'string' && value.includes('${')) {
        
        const resolved = this.resolveTemplateString(value, context);
        resolvedVariables[key] = resolved;
        context.setVariable(key, resolved);
      } else {
        
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

  
  private resolveTemplateString(template: string, context: WorkflowContext): any {
    const match = template.match(/^\$\{([^}]+)\}$/);
    if (match) {
      const varName = match[1];
      return context.getVariable(varName);
    }
    
    
    
    return template;
  }

  protected async validateConfig(_context: WorkflowContext): Promise<ValidationResult> {
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
