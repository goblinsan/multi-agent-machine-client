import { WorkflowStep, StepResult, ValidationResult, WorkflowStepConfig } from '../engine/WorkflowStep.js';
import { WorkflowContext } from '../engine/WorkflowContext.js';
import { sendPersonaRequest, waitForPersonaCompletion } from '../../agents/persona.js';
import { makeRedis } from '../../redisClient.js';
import { logger } from '../../logger.js';

interface PersonaRequestConfig {
  step: string;
  persona: string;
  intent: string;
  payload: Record<string, any>;
  timeout?: number;
  deadlineSeconds?: number;
}

/**
 * PersonaRequestStep - Makes persona requests via Redis with exact step names
 * This step implements the exact persona communication pattern expected by legacy tests
 */
export class PersonaRequestStep extends WorkflowStep {
  async execute(context: WorkflowContext): Promise<StepResult> {
    const config = this.config.config as PersonaRequestConfig;
    const { step, persona, intent, payload, timeout = 30000, deadlineSeconds = 600 } = config;

    logger.info(`Making persona request`, {
      workflowId: context.workflowId,
      step,
      persona,
      intent
    });

    try {
      const redis = await makeRedis();
      
      // Resolve payload variables from context
      const resolvedPayload = this.resolvePayloadVariables(payload, context);
      
      // Send persona request with exact step name
      const corrId = await sendPersonaRequest(redis, {
        workflowId: context.workflowId,
        toPersona: persona,
        step,
        intent,
        payload: resolvedPayload,
        repo: context.repoRoot,
        branch: context.branch,
        projectId: context.projectId,
        deadlineSeconds
      });

      logger.info(`Persona request sent`, {
        workflowId: context.workflowId,
        step,
        persona,
        corrId
      });

      // Wait for persona completion
      const completion = await waitForPersonaCompletion(redis, persona, context.workflowId, corrId, timeout);
      
      await redis.disconnect();

      if (!completion) {
        return {
          status: 'failure',
          error: new Error(`Persona request timed out after ${timeout}ms`),
          data: { step, persona, corrId }
        };
      }

      // Parse persona response
      const result = completion.fields?.result ? JSON.parse(completion.fields.result) : {};
      
      logger.info(`Persona request completed`, {
        workflowId: context.workflowId,
        step,
        persona,
        corrId,
        status: result.status || 'unknown'
      });

      // Set output variables in context
      this.setOutputVariables(context, result);

      return {
        status: 'success',
        data: {
          step,
          persona,
          corrId,
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

    return {
      valid: errors.length === 0,
      errors,
      warnings: []
    };
  }
}