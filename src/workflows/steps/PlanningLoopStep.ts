import { WorkflowStep, StepResult, ValidationResult, WorkflowStepConfig } from '../engine/WorkflowStep.js';
import { WorkflowContext } from '../engine/WorkflowContext.js';
import { sendPersonaRequest, waitForPersonaCompletion, parseEventResult, interpretPersonaStatus } from '../../agents/persona.js';
import { getContextualPrompt } from '../../personas.context.js';
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

        // Get the remote URL for distributed agent coordination
        const repoRemote = context.getVariable('repo_remote') || context.getVariable('effective_repo_path');
        const currentBranch = context.getCurrentBranch();
        
        const payloadWithContext = {
          ...payload,
          iteration: currentIteration,
          planIteration: currentIteration,
          previous_evaluation: evaluationResult,
          is_revision: currentIteration > 1,
          task: context.getVariable('task'),
          repo: repoRemote,
          branch: currentBranch,
          project_id: context.projectId
        };

        const planCorrId = await sendPersonaRequest(redis, {
          workflowId: context.workflowId,
          toPersona: plannerPersona,
          step: planStep,
          intent: 'planning',
          payload: payloadWithContext,
          repo: repoRemote,
          branch: currentBranch,
          projectId: context.projectId,
          deadlineSeconds
        });

        planResult = await waitForPersonaCompletion(redis, plannerPersona, context.workflowId, planCorrId, timeout);

        const parsedPlanResult = summarizePlanResult(planResult);

        logger.info('Planning request completed', {
          workflowId: context.workflowId,
          step: planStep,
          persona: plannerPersona,
          iteration: currentIteration,
          status: planResult?.status || 'unknown'
        });

        if (parsedPlanResult) {
          logger.info('Planning loop plan output', {
            workflowId: context.workflowId,
            step: planStep,
            persona: plannerPersona,
            iteration: currentIteration,
            plan: parsedPlanResult
          });
        }

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

        // Get the remote URL for distributed agent coordination
        const repoRemote = context.getVariable('repo_remote') || context.getVariable('effective_repo_path');
        const currentBranch = context.getCurrentBranch();
        
        // Determine evaluation context based on iteration count and step
        let evalContext = 'planning'; // default for initial planning loop
        if (currentIteration > 3) {
          evalContext = 'revision'; // Be more lenient after multiple iterations
        }
        
        // Get contextual prompt for the evaluator
        const contextualPrompt = getContextualPrompt(evaluatorPersona, evalContext);
        
        const evalPayload = {
          ...payload,
          plan: planResult,
          iteration: currentIteration,
          task: context.getVariable('task'),
          repo: repoRemote,
          branch: currentBranch,
          project_id: context.projectId,
          // Include custom system prompt if available
          ...(contextualPrompt ? { _system_prompt: contextualPrompt } : {})
        };

        const evalCorrId = await sendPersonaRequest(redis, {
          workflowId: context.workflowId,
          toPersona: evaluatorPersona,
          step: evaluateStep,
          intent: 'evaluation',
          payload: evalPayload,
          repo: repoRemote,
          branch: currentBranch,
          projectId: context.projectId,
          deadlineSeconds
        });

        evaluationResult = await waitForPersonaCompletion(redis, evaluatorPersona, context.workflowId, evalCorrId, timeout);

        const parsedEvaluation = summarizeEvaluationResult(evaluationResult);

        // Parse the actual evaluation status from the result field
        const evaluationStatusInfo = interpretPersonaStatus(evaluationResult?.fields?.result);

        logger.info('Evaluation request completed', {
          workflowId: context.workflowId,
          step: evaluateStep,
          persona: evaluatorPersona,
          iteration: currentIteration,
          eventStatus: evaluationResult?.fields?.status || 'unknown',
          interpretedStatus: evaluationStatusInfo.status
        });

        if (parsedEvaluation) {
          logger.info('Planning loop evaluation result', {
            workflowId: context.workflowId,
            step: evaluateStep,
            persona: evaluatorPersona,
            iteration: currentIteration,
            evaluation: parsedEvaluation,
            interpretedStatus: evaluationStatusInfo.status
          });
        }

        // Check if evaluation passed using the interpreted status
        // The event status is "done" when complete, but we need to check the actual evaluation result
        lastEvaluationPassed = evaluationStatusInfo.status === 'pass';

        if (lastEvaluationPassed) {
          logger.info('Plan evaluation passed, exiting loop', {
            workflowId: context.workflowId,
            iteration: currentIteration,
            totalIterations: currentIteration,
            evaluationStatus: evaluationStatusInfo.status
          });
          break;
        } else {
          logger.info('Plan evaluation failed or unknown, continuing loop', {
            workflowId: context.workflowId,
            iteration: currentIteration,
            remainingIterations: maxIterations - currentIteration,
            evaluationStatus: evaluationStatusInfo.status,
            details: evaluationStatusInfo.details?.substring(0, 200)
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

function truncate(value: any, max = 1000): string | undefined {
  if (value === undefined || value === null) return undefined;
  const text = typeof value === 'string' ? value : (() => {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  })();

  if (text.length <= max) return text;
  return `${text.slice(0, max)}…(+${text.length - max} chars)`;
}

function summarizePlanResult(event: any) {
  if (!event) return null;
  const fields = event.fields ?? {};
  const parsed = parseEventResult(fields.result);
  const planText = typeof parsed?.plan === 'string' ? parsed.plan : fields.result ?? undefined;
  const breakdown = Array.isArray(parsed?.breakdown) ? parsed.breakdown : undefined;
  const risks = Array.isArray(parsed?.risks) ? parsed.risks : undefined;

  const breakdownPreview = breakdown ? truncate(breakdown, 2000) : undefined;
  const risksPreview = risks ? truncate(risks, 1500) : undefined;

  return {
    corrId: fields.corr_id,
    status: event.status ?? fields.status ?? 'unknown',
    planPreview: truncate(planText, 2000),
    breakdownSteps: breakdown?.length,
    breakdownPreview,
    riskCount: risks?.length,
    risksPreview,
    metadata: parsed?.metadata,
    rawLength: typeof fields.result === 'string' ? fields.result.length : undefined
  };
}

function summarizeEvaluationResult(event: any) {
  if (!event) return null;
  const fields = event.fields ?? {};
  const payload = parseEventResult(fields.result);
  const normalized = interpretPersonaStatus(fields.result);

  return {
    corrId: fields.corr_id,
    status: event.status ?? fields.status ?? normalized.status ?? 'unknown',
    normalizedStatus: normalized.status,
    statusDetails: truncate(normalized.details, 2000),
    payloadPreview: payload ? truncate(payload, 2000) : undefined,
    rawLength: typeof fields.result === 'string' ? fields.result.length : undefined
  };
}