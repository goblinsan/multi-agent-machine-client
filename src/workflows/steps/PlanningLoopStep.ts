import { WorkflowStep, StepResult, ValidationResult, WorkflowStepConfig } from '../engine/WorkflowStep.js';
import { WorkflowContext } from '../engine/WorkflowContext.js';
import { sendPersonaRequest, waitForPersonaCompletion } from '../../agents/persona.js';
import { makeRedis } from '../../redisClient.js';
import { logger } from '../../logger.js';

interface PlanningLoopConfig {
  maxIterations?: number;
  plannerPersona: string;
  evaluatorPersona: string;
  planStep: string;
  evaluateStep: string;
  payload: Record<string, any>;
  timeout?: number;
  deadlineSeconds?: number;
}

/**
 * PlanningLoopStep - Encapsulates plan creation and evaluation loop
 * Repeatedly creates plans and evaluates them until evaluation passes or max iterations reached
 */
export class PlanningLoopStep extends WorkflowStep {
  async execute(context: WorkflowContext): Promise<StepResult> {
    const config = this.config.config as PlanningLoopConfig;
    const { 
      maxIterations = 5, 
      plannerPersona, 
      evaluatorPersona, 
      planStep, 
      evaluateStep, 
      payload, 
      timeout = 30000, 
      deadlineSeconds = 600 
    } = config;

    let currentIteration = 0;
    let planResult: any = null;
    let evaluationResult: any = null;
    let lastEvaluationPassed = false;

    logger.info('Starting planning evaluation loop', {
      workflowId: context.workflowId,
      maxIterations,
      plannerPersona,
      evaluatorPersona
    });

    const redis = await makeRedis();

    while (currentIteration < maxIterations) {
      currentIteration++;
      
      logger.info(`Planning loop iteration ${currentIteration}/${maxIterations}`, {
        workflowId: context.workflowId,
        step: planStep
      });

      // Step 1: Request plan from planner persona
      try {
        logger.info('Making planning request', {
          workflowId: context.workflowId,
          step: planStep,
          persona: plannerPersona,
          iteration: currentIteration
        });

        const payloadWithContext = {
          ...payload,
          iteration: currentIteration,
          previous_evaluation: evaluationResult,
          is_revision: currentIteration > 1,
          task: context.getVariable('task'),
          repo: context.repoRoot,
          project_id: context.projectId
        };

        const planCorrId = await sendPersonaRequest(redis, {
          workflowId: context.workflowId,
          toPersona: plannerPersona,
          step: planStep,
          intent: 'planning',
          payload: payloadWithContext,
          repo: context.repoRoot,
          branch: context.branch,
          projectId: context.projectId,
          deadlineSeconds
        });

        planResult = await waitForPersonaCompletion(redis, plannerPersona, context.workflowId, planCorrId, timeout);
        
        logger.info('Planning request completed', {
          workflowId: context.workflowId,
          step: planStep,
          persona: plannerPersona,
          iteration: currentIteration,
          status: planResult?.status || 'unknown'
        });

      } catch (error) {
        logger.error('Planning request failed', {
          workflowId: context.workflowId,
          step: planStep,
          persona: plannerPersona,
          iteration: currentIteration,
          error: error instanceof Error ? error.message : String(error)
        });
        
        if (currentIteration === maxIterations) {
          // On final iteration, proceed with whatever we have
          break;
        }
        continue;
      }

      // Step 2: Evaluate the plan
      try {
        logger.info('Making evaluation request', {
          workflowId: context.workflowId,
          step: evaluateStep,
          persona: evaluatorPersona,
          iteration: currentIteration
        });

        const evalPayload = {
          ...payload,
          plan: planResult,
          iteration: currentIteration,
          task: context.getVariable('task'),
          repo: context.repoRoot,
          project_id: context.projectId
        };

        const evalCorrId = await sendPersonaRequest(redis, {
          workflowId: context.workflowId,
          toPersona: evaluatorPersona,
          step: evaluateStep,
          intent: 'evaluation',
          payload: evalPayload,
          repo: context.repoRoot,
          branch: context.branch,
          projectId: context.projectId,
          deadlineSeconds
        });

        evaluationResult = await waitForPersonaCompletion(redis, evaluatorPersona, context.workflowId, evalCorrId, timeout);
        
        logger.info('Evaluation request completed', {
          workflowId: context.workflowId,
          step: evaluateStep,
          persona: evaluatorPersona,
          iteration: currentIteration,
          status: evaluationResult?.status || 'unknown'
        });

        // Check if evaluation passed
        lastEvaluationPassed = evaluationResult?.status === 'success' || 
                              evaluationResult?.approved === true ||
                              evaluationResult?.result === 'approved';

        if (lastEvaluationPassed) {
          logger.info('Plan evaluation passed, exiting loop', {
            workflowId: context.workflowId,
            iteration: currentIteration,
            totalIterations: currentIteration
          });
          break;
        } else {
          logger.info('Plan evaluation failed, continuing loop', {
            workflowId: context.workflowId,
            iteration: currentIteration,
            remainingIterations: maxIterations - currentIteration
          });
        }

      } catch (error) {
        logger.error('Evaluation request failed', {
          workflowId: context.workflowId,
          step: evaluateStep,
          persona: evaluatorPersona,
          iteration: currentIteration,
          error: error instanceof Error ? error.message : String(error)
        });
        
        if (currentIteration === maxIterations) {
          // On final iteration, proceed anyway
          break;
        }
        continue;
      }
    }

    const finalResult = {
      plan: planResult,
      evaluation: evaluationResult,
      iterations: currentIteration,
      evaluationPassed: lastEvaluationPassed,
      reachedMaxIterations: currentIteration >= maxIterations
    };

    logger.info('Planning loop completed', {
      workflowId: context.workflowId,
      totalIterations: currentIteration,
      maxIterations,
      finalEvaluationPassed: lastEvaluationPassed,
      reachedMaxIterations: currentIteration >= maxIterations
    });

    return {
      status: 'success',
      data: finalResult,
      outputs: {
        plan_result: planResult,
        evaluation_result: evaluationResult,
        iterations: currentIteration,
        evaluation_passed: lastEvaluationPassed
      }
    };
  }
}