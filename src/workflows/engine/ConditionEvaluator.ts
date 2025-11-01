import type { WorkflowContext } from './WorkflowContext';
import { evaluateCondition } from './conditionUtils';
import { logger } from '../../logger.js';


export class ConditionEvaluator {
  
  evaluateSimpleCondition(condition: string, context: WorkflowContext): boolean {
    return evaluateCondition(condition, context);
  }

  
  evaluateTriggerCondition(condition: string, taskType: string, scope?: string): boolean {
    try {
      
      
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
