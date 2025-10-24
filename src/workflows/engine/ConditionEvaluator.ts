import type { WorkflowContext } from './WorkflowContext';
import { logger } from '../../logger.js';

/**
 * Handles evaluation of workflow conditions and expressions
 */
export class ConditionEvaluator {
  /**
   * Evaluate a simple condition string against context
   * Supports:
   * - Single equality: "${var} == 'value'"
   * - OR conditions: "${var} == 'value1' || ${var} == 'value2'"
   * - AND conditions: "${var1} == 'value1' && ${var2} == 'value2'"
   */
  evaluateSimpleCondition(condition: string, context: WorkflowContext): boolean {
    try {
      // Handle OR conditions (||)
      if (condition.includes('||')) {
        const parts = condition.split('||').map(s => s.trim());
        return parts.some(part => this.evaluateSingleComparison(part, context));
      }
      
      // Handle AND conditions (&&)
      if (condition.includes('&&')) {
        const parts = condition.split('&&').map(s => s.trim());
        return parts.every(part => this.evaluateSingleComparison(part, context));
      }
      
      // Single comparison
      return this.evaluateSingleComparison(condition, context);
    } catch (error: any) {
      console.warn(`Failed to evaluate condition '${condition}': ${error.message}`);
      return false;
    }
  }

  /**
   * Evaluate a single comparison expression
   */
  private evaluateSingleComparison(condition: string, context: WorkflowContext): boolean {
    if (condition.includes('==')) {
      const [left, right] = condition.split('==').map(s => s.trim());
      
      // Handle ${variable} syntax in left side
      let leftVariableName = left.replace(/['"]/g, '');
      if (leftVariableName.startsWith('${') && leftVariableName.endsWith('}')) {
        leftVariableName = leftVariableName.slice(2, -1);
      }
      
      const leftValue = this.getNestedValue(context, leftVariableName);
      const rightValue = right.replace(/['"]/g, '');
      
      const result = String(leftValue) === rightValue;
      
      logger.debug('Condition comparison', {
        condition,
        variableName: leftVariableName,
        leftValue,
        rightValue,
        result,
        workflowId: context.workflowId
      });
      
      return result;
    }
    
    return true; // Default to true for unhandled conditions
  }

  /**
   * Evaluate workflow trigger condition
   */
  evaluateTriggerCondition(condition: string, taskType: string, scope?: string): boolean {
    try {
      // Replace variables in condition
      const resolved = condition
        .replace(/task_type/g, `"${taskType}"`)
        .replace(/scope/g, `"${scope || ''}"`);
      
      // Simple condition evaluation
      if (resolved.includes('||')) {
        return resolved.split('||').some(part => this.evaluateSimpleTriggerComparison(part.trim()));
      } else if (resolved.includes('&&')) {
        return resolved.split('&&').every(part => this.evaluateSimpleTriggerComparison(part.trim()));
      } else {
        return this.evaluateSimpleTriggerComparison(resolved);
      }
    } catch (error: any) {
      console.warn(`Failed to evaluate trigger condition '${condition}': ${error.message}`);
      return false;
    }
  }

  /**
   * Evaluate simple comparison for trigger conditions
   */
  private evaluateSimpleTriggerComparison(comparison: string): boolean {
    if (comparison.includes('==')) {
      const [left, right] = comparison.split('==').map(s => s.trim().replace(/['"]/g, ''));
      return left === right;
    }
    return false;
  }

  /**
   * Get nested value from context
   */
  private getNestedValue(context: WorkflowContext, path: string): any {
    // Handle special context variables
    if (path === 'REPO_PATH') {
      logger.warn('REPO_PATH is deprecated. Use repo_remote for distributed agent coordination.');
      return context.repoRoot;
    }
    if (path === 'repoRoot') {
      logger.warn('repoRoot reference in workflow. Using repo_remote for distributed coordination.');
      return context.getVariable('repo_remote') || context.repoRoot;
    }
    if (path === 'REDIS_STREAM_NAME') return context.getVariable('REDIS_STREAM_NAME') || process.env.REDIS_STREAM_NAME || 'workflow-tasks';
    if (path === 'CONSUMER_GROUP') return context.getVariable('CONSUMER_GROUP') || process.env.CONSUMER_GROUP || 'workflow-consumers';
    if (path === 'CONSUMER_ID') return context.getVariable('CONSUMER_ID') || process.env.CONSUMER_ID || 'workflow-engine';
    
    // Try to get from variables first
    const variable = context.getVariable(path);
    if (variable !== undefined) {
      return variable;
    }
    
    // Try to get from step outputs
    if (path.includes('.')) {
      const [stepName, ...propertyPath] = path.split('.');
      const stepOutput = context.getStepOutput(stepName);
      if (stepOutput) {
        return propertyPath.reduce((current, key) => current?.[key], stepOutput);
      }
    }
    
    return undefined;
  }
}
