import type { WorkflowContext } from './WorkflowContext';
import { evaluateCondition } from './conditionUtils';
import { logger } from '../../logger.js';

/**
 * Handles evaluation of workflow trigger conditions.
 * 
 * ARCHITECTURE NOTE:
 * This class delegates to conditionUtils.evaluateCondition() to ensure
 * ALL condition evaluation logic lives in one place (conditionUtils.ts).
 * This prevents duplication and ensures trigger conditions and step conditions
 * use identical evaluation logic.
 * 
 * For step conditions during workflow execution, use WorkflowStep.shouldExecute()
 * which also uses conditionUtils.evaluateCondition().
 */
export class ConditionEvaluator {
  /**
   * Evaluate a condition string against context.
   * Delegates to conditionUtils.evaluateCondition() for consistency.
   * 
   * DEPRECATED: This method exists only for backward compatibility.
   * For step conditions, use WorkflowStep.shouldExecute() instead.
   * 
   * Supports:
   * - Equality: "${var} == 'value'" or "${var} == true"
   * - Inequality: "${var} != 'value'" or "${var} != false"
   * - OR conditions: "${var} == 'value1' || ${var} == 'value2'"
   * - AND conditions: "${var1} == 'value1' && ${var2} == 'value2'"
   * - Dot notation: "${step_name.output_property} == 'value'"
   * - Boolean values: true, false (without quotes)
   */
  evaluateSimpleCondition(condition: string, context: WorkflowContext): boolean {
    return evaluateCondition(condition, context);
  }

  /**
   * Evaluate workflow trigger condition.
   * This is the primary use case for ConditionEvaluator - matching workflows to tasks.
   * 
   * Creates a temporary context with task_type and scope variables, then delegates
   * to the standard condition evaluation logic in WorkflowStep.
   */
  evaluateTriggerCondition(condition: string, taskType: string, scope?: string): boolean {
    try {
      // Create a minimal context with trigger variables
      // We need this to evaluate trigger conditions like "task_type == 'feature'"
      const tempContext = {
        workflowId: '__trigger_evaluation__',
        variables: new Map([
          ['task_type', taskType],
          ['scope', scope || '']
        ]),
        getVariable(name: string) {
          return this.variables.get(name);
        },
        getStepOutput(_name: string) {
          return undefined;
        },
        logger
      } as any as WorkflowContext;

      // Use the unified condition evaluator
      return this.evaluateSimpleCondition(condition, tempContext);
    } catch (error: any) {
      logger.warn('Failed to evaluate trigger condition', {
        condition,
        taskType,
        scope,
        error: error.message
      });
      return false;
    }
  }
}
