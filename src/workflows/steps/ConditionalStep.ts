import { WorkflowStep, StepResult, ValidationResult, WorkflowStepConfig } from '../engine/WorkflowStep.js';
import { WorkflowContext } from '../engine/WorkflowContext.js';
import { logger } from '../../logger.js';
import { PersonaRequestStep } from './PersonaRequestStep.js';
import { TaskCreationStep } from './TaskCreationStep.js';
import { TaskUpdateStep } from './TaskUpdateStep.js';

interface ConditionalConfig {
  condition: string;
  thenSteps?: WorkflowStepConfig[];
  elseSteps?: WorkflowStepConfig[];
}


export class ConditionalStep extends WorkflowStep {
  async execute(context: WorkflowContext): Promise<StepResult> {
    const config = this.config.config as ConditionalConfig;
    const { condition, thenSteps = [], elseSteps = [] } = config;

    logger.info(`Evaluating conditional step`, {
      workflowId: context.workflowId,
      condition,
      thenStepsCount: thenSteps.length,
      elseStepsCount: elseSteps.length
    });

    try {
      
      const conditionResult = this.evaluateConditionExpression(condition, context);
      
      logger.info(`Condition evaluated`, {
        workflowId: context.workflowId,
        condition,
        result: conditionResult
      });

      
      const stepsToExecute = conditionResult ? thenSteps : elseSteps;
      
      if (stepsToExecute.length === 0) {
        return {
          status: 'success',
          data: {
            condition,
            conditionResult,
            stepsExecuted: 0
          }
        };
      }

      
      const stepResults: any[] = [];
      let allSuccessful = true;

      for (const stepConfig of stepsToExecute) {
        try {
          
          const step = this.createStepInstance(stepConfig);
          
          
          const result = await step.execute(context);
          stepResults.push({
            name: stepConfig.name,
            type: stepConfig.type,
            result
          });

          if (result.status === 'failure') {
            allSuccessful = false;
            logger.warn(`Conditional step failed`, {
              workflowId: context.workflowId,
              stepName: stepConfig.name,
              error: result.error?.message
            });
          }

        } catch (error: any) {
          allSuccessful = false;
          stepResults.push({
            name: stepConfig.name,
            type: stepConfig.type,
            result: {
              status: 'failure',
              error: new Error(error.message)
            }
          });
          
          logger.error(`Conditional step execution failed`, {
            workflowId: context.workflowId,
            stepName: stepConfig.name,
            error: error.message
          });
        }
      }

      return {
        status: allSuccessful ? 'success' : 'failure',
        data: {
          condition,
          conditionResult,
          stepsExecuted: stepResults.length,
          stepResults
        },
        outputs: {
          conditionResult,
          stepsExecuted: stepResults.length
        }
      };

    } catch (error: any) {
      logger.error(`Conditional step failed`, {
        workflowId: context.workflowId,
        condition,
        error: error.message
      });

      return {
        status: 'failure',
        error: new Error(error.message),
        data: { condition }
      };
    }
  }

  private evaluateConditionExpression(condition: string, context: WorkflowContext): boolean {
    try {
      
      if (condition.includes('qaStatus')) {
        const qaStatus = context.getVariable('qaStatus') || context.getVariable('qa_status');
        
        if (condition.includes('== "fail"') || condition.includes('=== "fail"')) {
          return qaStatus === 'fail';
        }
        if (condition.includes('== "pass"') || condition.includes('=== "pass"')) {
          return qaStatus === 'pass';
        }
        if (condition.includes('!= "pass"') || condition.includes('!== "pass"')) {
          return qaStatus !== 'pass';
        }
      }

      
      if (condition.includes('stepOutput')) {
        
        const match = condition.match(/stepOutput\.(\w+)\.(\w+)\s*(==|!=|===|!==)\s*"([^"]+)"/);
        if (match) {
          const [, stepName, property, operator, value] = match;
          const stepOutput = context.getStepOutput(stepName);
          const actualValue = stepOutput?.[property];
          
          switch (operator) {
            case '==':
            case '===':
              return actualValue === value;
            case '!=':
            case '!==':
              return actualValue !== value;
          }
        }
      }

      const match = condition.match(/(\w+)\s*(==|!=|===|!==)\s*"([^"]+)"/);
      if (match) {
        const [, varName, operator, value] = match;
        const actualValue = context.getVariable(varName);
        
        switch (operator) {
          case '==':
          case '===':
            return actualValue === value;
          case '!=':
          case '!==':
            return actualValue !== value;
        }
      }

      logger.warn(`Unsupported condition pattern, defaulting to false`, {
        condition
      });
      return false;

    } catch (error: any) {
      logger.error(`Condition evaluation failed, defaulting to false`, {
        condition,
        error: error.message
      });
      return false;
    }
  }

  private createStepInstance(stepConfig: WorkflowStepConfig): WorkflowStep {
    switch (stepConfig.type) {
      case 'PersonaRequestStep':
        return new PersonaRequestStep(stepConfig);
      case 'TaskCreationStep':
        return new TaskCreationStep(stepConfig);
      case 'TaskUpdateStep':
        return new TaskUpdateStep(stepConfig);
      default:
        throw new Error(`Unsupported step type: ${stepConfig.type}`);
    }
  }

  protected async validateConfig(_context: WorkflowContext): Promise<ValidationResult> {
    const errors: string[] = [];
    const warnings: string[] = [];
    const config = this.config.config as ConditionalConfig;

    if (!config.condition || typeof config.condition !== 'string') {
      errors.push('ConditionalStep: condition is required and must be a string');
    }

    if (config.thenSteps !== undefined && !Array.isArray(config.thenSteps)) {
      errors.push('ConditionalStep: thenSteps must be an array if provided');
    }

    if (config.elseSteps !== undefined && !Array.isArray(config.elseSteps)) {
      errors.push('ConditionalStep: elseSteps must be an array if provided');
    }

    
    const allSteps = [...(config.thenSteps || []), ...(config.elseSteps || [])];
    for (const stepConfig of allSteps) {
      if (!stepConfig.name || typeof stepConfig.name !== 'string') {
        errors.push(`ConditionalStep: nested step missing or invalid name`);
      }
      if (!stepConfig.type || typeof stepConfig.type !== 'string') {
        errors.push(`ConditionalStep: nested step missing or invalid type`);
      }
    }

    if (!config.thenSteps?.length && !config.elseSteps?.length) {
      warnings.push('ConditionalStep: no steps defined for either condition branch');
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings
    };
  }
}