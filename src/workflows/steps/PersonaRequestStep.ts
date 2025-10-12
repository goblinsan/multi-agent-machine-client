import { WorkflowStep, StepResult, ValidationResult, WorkflowStepConfig } from '../engine/WorkflowStep.js';
import { WorkflowContext } from '../engine/WorkflowContext.js';
import { sendPersonaRequest, waitForPersonaCompletion } from '../../agents/persona.js';
import { makeRedis } from '../../redisClient.js';
import { logger } from '../../logger.js';
import { cfg } from '../../config.js';

interface PersonaRequestConfig {
  step: string;
  persona: string;
  intent: string;
  payload: Record<string, any>;
  timeout?: number;
  deadlineSeconds?: number;
  maxRetries?: number;
}

/**
 * PersonaRequestStep - Makes persona requests via Redis with exact step names
 * This step implements the exact persona communication pattern expected by legacy tests
 */
export class PersonaRequestStep extends WorkflowStep {
  async execute(context: WorkflowContext): Promise<StepResult> {
    const config = this.config.config as PersonaRequestConfig;
    // Don't default timeout here - let waitForPersonaCompletion use persona-specific timeouts from env
    const { step, persona, intent, payload, timeout, deadlineSeconds = 600 } = config;
    
    // Get max retries from config (per-step override) or use global default
    const maxRetries = config.maxRetries ?? cfg.personaTimeoutMaxRetries ?? 3;

    logger.info(`Making persona request`, {
      workflowId: context.workflowId,
      step,
      persona,
      intent,
      maxRetries
    });

    try {
      const redis = await makeRedis();
      
      // Resolve payload variables from context
      const resolvedPayload = this.resolvePayloadVariables(payload, context);
      
      // Send persona request with exact step name
      // CRITICAL: Always use remote URL for distributed agents, never local path
      // Each agent will resolve the remote to their local PROJECT_BASE location
      const repoForPersona = context.getVariable('repo_remote')
        || context.getVariable('effective_repo_path');
      
      if (!repoForPersona) {
        logger.error('No repository remote URL available for persona request', {
          workflowId: context.workflowId,
          persona,
          step,
          availableVars: Object.keys(context.getAllVariables())
        });
        throw new Error(`Cannot send persona request: no repository remote URL available. Local paths cannot be shared across distributed agents.`);
      }

      // Use the current branch from variables (updated by git operations) or fall back to context.branch
      const currentBranch = context.getVariable('branch') || context.getVariable('currentBranch') || context.branch;
      
      // Retry loop for timeout handling
      let lastCorrId = '';
      let attempt = 0;
      let completion = null;
      
      while (attempt <= maxRetries && !completion) {
        attempt++;
        
        if (attempt > 1) {
          // Backoff delay: wait (attempt - 1) * 30 seconds before retrying
          // First retry waits 30s, second waits 60s, third waits 90s, etc.
          const backoffSeconds = (attempt - 1) * 30;
          const backoffMs = backoffSeconds * 1000;
          
          logger.info(`Retrying persona request after timeout with backoff delay`, {
            workflowId: context.workflowId,
            step,
            persona,
            attempt,
            maxRetries: maxRetries + 1, // +1 because initial attempt + retries
            backoffSeconds,
            backoffMs
          });
          
          // Wait for the backoff period
          await new Promise(resolve => setTimeout(resolve, backoffMs));
          
          logger.info(`Backoff delay completed, sending retry`, {
            workflowId: context.workflowId,
            step,
            persona,
            attempt
          });
        }
        
        const corrId = await sendPersonaRequest(redis, {
          workflowId: context.workflowId,
          toPersona: persona,
          step,
          intent,
          payload: resolvedPayload,
          repo: repoForPersona,
          branch: currentBranch,
          projectId: context.projectId,
          deadlineSeconds
        });

        lastCorrId = corrId;

        logger.info(`Persona request sent`, {
          workflowId: context.workflowId,
          step,
          persona,
          corrId,
          attempt
        });

        // Wait for persona completion
        try {
          completion = await waitForPersonaCompletion(redis, persona, context.workflowId, corrId, timeout);
        } catch (error: any) {
          // Check if this is a timeout error
          if (error.message && error.message.includes('Timed out waiting')) {
            completion = null;
            if (attempt <= maxRetries) {
              const timeoutInfo = timeout ? `${timeout}ms` : 'persona default timeout';
              logger.warn(`Persona request timed out, will retry`, {
                workflowId: context.workflowId,
                step,
                persona,
                corrId,
                attempt,
                timeoutInfo,
                remainingRetries: maxRetries - attempt + 1
              });
            }
          } else {
            // Non-timeout error, rethrow to be caught by outer try-catch
            throw error;
          }
        }
      }
      
      await redis.disconnect();

      if (!completion) {
        const timeoutInfo = timeout ? `${timeout}ms` : 'persona default timeout';
        const totalAttempts = attempt;
        logger.error(`Persona request failed after all retries`, {
          workflowId: context.workflowId,
          step,
          persona,
          totalAttempts,
          timeoutInfo
        });
        return {
          status: 'failure',
          error: new Error(`Persona request timed out after ${totalAttempts} attempts (timeout: ${timeoutInfo})`),
          data: { step, persona, corrId: lastCorrId, totalAttempts }
        };
      }

      // Parse persona response
      const result = completion.fields?.result ? JSON.parse(completion.fields.result) : {};
      
      logger.info(`Persona request completed`, {
        workflowId: context.workflowId,
        step,
        persona,
        corrId: lastCorrId,
        attempt,
        status: result.status || 'unknown'
      });

      // Set output variables in context
      this.setOutputVariables(context, result);

      return {
        status: 'success',
        data: {
          step,
          persona,
          corrId: lastCorrId,
          totalAttempts: attempt,
          result,
          completion
        },
        outputs: result
      };

    } catch (error: any) {
      logger.error(`Persona request failed`, {
        workflowId: context.workflowId,
        step,
        persona,
        error: error.message
      });

      return {
        status: 'failure',
        error: new Error(error.message),
        data: { step, persona }
      };
    }
  }

  private resolvePayloadVariables(payload: Record<string, any>, context: WorkflowContext): Record<string, any> {
    const resolved: Record<string, any> = {};

    for (const [key, value] of Object.entries(payload)) {
      if (typeof value === 'string' && value.startsWith('${') && value.endsWith('}')) {
        // Variable reference like ${variableName}
        const variableName = value.slice(2, -1);
        resolved[key] = context.getVariable(variableName);
      } else if (typeof value === 'object' && value !== null) {
        // Recursively resolve nested objects
        resolved[key] = this.resolvePayloadVariables(value, context);
      } else {
        resolved[key] = value;
      }
    }

    return resolved;
  }

  private setOutputVariables(context: WorkflowContext, result: any): void {
    // Set the main result
    if (this.config.outputs) {
      for (const output of this.config.outputs) {
        context.setVariable(output, result);
      }
    }

    // Also set individual properties if result is an object
    if (result && typeof result === 'object') {
      for (const [key, value] of Object.entries(result)) {
        context.setVariable(`${this.config.name}_${key}`, value);
      }
    }
  }

  protected async validateConfig(context: WorkflowContext): Promise<ValidationResult> {
    const errors: string[] = [];
    const config = this.config.config as PersonaRequestConfig;

    if (!config.step || typeof config.step !== 'string') {
      errors.push('PersonaRequestStep: step is required and must be a string');
    }

    if (!config.persona || typeof config.persona !== 'string') {
      errors.push('PersonaRequestStep: persona is required and must be a string');
    }

    if (!config.intent || typeof config.intent !== 'string') {
      errors.push('PersonaRequestStep: intent is required and must be a string');
    }

    if (!config.payload || typeof config.payload !== 'object') {
      errors.push('PersonaRequestStep: payload is required and must be an object');
    }

    if (config.timeout !== undefined && (typeof config.timeout !== 'number' || config.timeout < 0)) {
      errors.push('PersonaRequestStep: timeout must be a non-negative number');
    }

    if (config.deadlineSeconds !== undefined && (typeof config.deadlineSeconds !== 'number' || config.deadlineSeconds < 0)) {
      errors.push('PersonaRequestStep: deadlineSeconds must be a non-negative number');
    }

    if (config.maxRetries !== undefined && (typeof config.maxRetries !== 'number' || config.maxRetries < 0)) {
      errors.push('PersonaRequestStep: maxRetries must be a non-negative number');
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings: []
    };
  }
}