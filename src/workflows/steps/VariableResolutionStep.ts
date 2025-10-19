import { WorkflowStep, StepResult, ValidationResult, WorkflowStepConfig } from '../engine/WorkflowStep.js';
import { WorkflowContext } from '../engine/WorkflowContext.js';
import { logger } from '../../logger.js';

interface VariableConfig {
  variables: Record<string, any>;
}

/**
 * VariableResolutionStep - Resolves and sets workflow variables
 * 
 * This step evaluates expressions and sets variables in the workflow context.
 * Useful for computing derived values, setting defaults, or normalizing inputs.
 * 
 * Example:
 * ```yaml
 * - name: resolve_vars
 *   type: VariableResolutionStep
 *   config:
 *     variables:
 *       current_tdd_stage: "${task.metadata.tdd_stage || tdd_stage || 'implementation'}"
 *       is_urgent: "${task.priority == 'critical' || task.priority == 'high'}"
 *       milestone_id: "${milestone_context.id}"
 * ```
 */
export class VariableResolutionStep extends WorkflowStep {
  async execute(context: WorkflowContext): Promise<StepResult> {
    const config = this.config.config as VariableConfig;
    const { variables } = config;

    if (!variables || Object.keys(variables).length === 0) {
      return {
        status: 'success',
        data: {
          variablesSet: 0,
          message: 'No variables to resolve'
        }
      };
    }

    logger.info(`Resolving variables`, {
      workflowId: context.workflowId,
      stepName: this.config.name,
      variableCount: Object.keys(variables).length,
      variables: Object.keys(variables)
    });

    try {
      const resolvedVariables: Record<string, any> = {};
      const errors: Record<string, string> = {};

      // Resolve each variable
      for (const [key, expression] of Object.entries(variables)) {
        try {
          // Check if expression is a string that needs variable substitution
          const resolvedValue = typeof expression === 'string' && expression.includes('${')
            ? this.resolveVariableExpression(expression, context)
            : expression;

          // Set in context
          context.setVariable(key, resolvedValue);
          resolvedVariables[key] = resolvedValue;

          logger.debug(`Variable resolved`, {
            workflowId: context.workflowId,
            stepName: this.config.name,
            key,
            expression,
            resolvedValue: typeof resolvedValue === 'object' 
              ? JSON.stringify(resolvedValue).substring(0, 100) 
              : resolvedValue
          });

        } catch (error: any) {
          errors[key] = error.message;
          logger.warn(`Failed to resolve variable`, {
            workflowId: context.workflowId,
            stepName: this.config.name,
            key,
            expression,
            error: error.message
          });
        }
      }

      // Return outputs for each variable (accessible via context)
      const outputs = Object.entries(resolvedVariables).map(([key, value]) => ({
        name: key,
        value
      }));

      // Set outputs in context (outputs are stored in step data, accessible via context)
      // Note: WorkflowContext.setStepOutput only takes stepName and data
      // Outputs are accessed via context.getVariable('<stepName>.<outputName>')

      const hasErrors = Object.keys(errors).length > 0;
      
      return {
        status: hasErrors ? 'failure' : 'success',
        data: {
          variablesSet: Object.keys(resolvedVariables).length,
          variables: resolvedVariables,
          errors: hasErrors ? errors : undefined,
          outputs
        }
      };

    } catch (error: any) {
      logger.error(`Variable resolution step failed`, {
        workflowId: context.workflowId,
        stepName: this.config.name,
        error: error.message
      });

      return {
        status: 'failure',
        error: new Error(`Failed to resolve variables: ${error.message}`),
        data: {
          variablesSet: 0
        }
      };
    }
  }

  async validate(context: WorkflowContext): Promise<ValidationResult> {
    const config = this.config.config as VariableConfig;

    if (!config.variables) {
      return {
        valid: false,
        errors: ['VariableResolutionStep requires "variables" configuration'],
        warnings: []
      };
    }

    if (typeof config.variables !== 'object' || Array.isArray(config.variables)) {
      return {
        valid: false,
        errors: ['VariableResolutionStep "variables" must be an object'],
        warnings: []
      };
    }

    if (Object.keys(config.variables).length === 0) {
      return {
        valid: false,
        errors: ['VariableResolutionStep "variables" cannot be empty'],
        warnings: ['No variables defined - step will do nothing']
      };
    }

    return { 
      valid: true,
      errors: [],
      warnings: []
    };
  }

  /**
   * Resolve variable expression with ${var} syntax
   */
  private resolveVariableExpression(expression: string, context: WorkflowContext): any {
    // Match ${variable} or ${variable.path} patterns
    const variablePattern = /\$\{([^}]+)\}/g;
    let result: string = expression;
    let match: RegExpExecArray | null;

    while ((match = variablePattern.exec(expression)) !== null) {
      const fullMatch = match[0]; // ${variable}
      const variablePath = match[1]; // variable or variable.path

      // Handle complex expressions (e.g., ${a || b || 'default'})
      const resolvedValue = this.evaluateExpression(variablePath, context);
      
      // If the entire expression is just a variable reference, return the value directly
      if (expression === fullMatch) {
        return resolvedValue;
      }

      // Otherwise, replace in string
      result = result.replace(fullMatch, String(resolvedValue ?? ''));
    }

    return result;
  }

  /**
   * Evaluate expression with variable access and operators
   */
  private evaluateExpression(expression: string, context: WorkflowContext): any {
    // Handle logical OR operator (||)
    if (expression.includes('||')) {
      const parts = expression.split('||').map(p => p.trim());
      for (const part of parts) {
        const value = this.evaluateSingleExpression(part, context);
        if (value !== null && value !== undefined && value !== '') {
          return value;
        }
      }
      return null;
    }

    // Handle logical AND operator (&&)
    if (expression.includes('&&')) {
      const parts = expression.split('&&').map(p => p.trim());
      for (const part of parts) {
        const value = this.evaluateSingleExpression(part, context);
        if (!value) {
          return false;
        }
      }
      return true;
    }

    // Handle comparison operators
    if (expression.includes('==')) {
      const [left, right] = expression.split('==').map(p => p.trim());
      const leftValue = this.evaluateSingleExpression(left, context);
      const rightValue = this.evaluateSingleExpression(right, context);
      return leftValue == rightValue;
    }

    if (expression.includes('!=')) {
      const [left, right] = expression.split('!=').map(p => p.trim());
      const leftValue = this.evaluateSingleExpression(left, context);
      const rightValue = this.evaluateSingleExpression(right, context);
      return leftValue != rightValue;
    }

    // Single expression
    return this.evaluateSingleExpression(expression, context);
  }

  /**
   * Evaluate single expression (variable path or literal)
   */
  private evaluateSingleExpression(expr: string, context: WorkflowContext): any {
    expr = expr.trim();

    // String literal
    if ((expr.startsWith("'") && expr.endsWith("'")) || 
        (expr.startsWith('"') && expr.endsWith('"'))) {
      return expr.slice(1, -1);
    }

    // Number literal
    if (!isNaN(Number(expr))) {
      return Number(expr);
    }

    // Boolean literal
    if (expr === 'true') return true;
    if (expr === 'false') return false;
    if (expr === 'null') return null;
    if (expr === 'undefined') return undefined;

    // Variable path (e.g., "task.metadata.tdd_stage")
    return this.getVariableByPath(expr, context);
  }

  /**
   * Get variable value by dot-notation path
   */
  private getVariableByPath(path: string, context: WorkflowContext): any {
    const parts = path.split('.');
    let value: any = context.getVariable(parts[0]);

    for (let i = 1; i < parts.length; i++) {
      if (value === null || value === undefined) {
        return undefined;
      }
      value = value[parts[i]];
    }

    return value;
  }
}
