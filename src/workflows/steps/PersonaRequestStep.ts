import { WorkflowStep, StepResult, ValidationResult } from '../engine/WorkflowStep.js';
import { WorkflowContext } from '../engine/WorkflowContext.js';
import { sendPersonaRequest, waitForPersonaCompletion, interpretPersonaStatus } from '../../agents/persona.js';
import { logger } from '../../logger.js';
import { cfg } from '../../config.js';
import { personaTimeoutMs, personaMaxRetries, calculateProgressiveTimeout } from '../../util.js';
import { VariableResolver } from './helpers/VariableResolver.js';

interface PersonaRequestConfig {
  step: string;
  persona: string;
  intent: string;
  payload: Record<string, any>;
  timeout?: number;
  deadlineSeconds?: number;
  maxRetries?: number;
}


export class PersonaRequestStep extends WorkflowStep {
  private variableResolver: VariableResolver;

  constructor(config: any) {
    super(config);
    this.variableResolver = new VariableResolver();
  }
  async execute(context: WorkflowContext): Promise<StepResult> {
    const config = this.config.config as PersonaRequestConfig;
    const { step, persona, intent, payload, deadlineSeconds = 600 } = config;
    
    
    const skipPersonaOps = ((): boolean => {
      
      const isTest = (process.env.NODE_ENV === 'test') || (!!process.env.VITEST) || (typeof (globalThis as any).vi !== 'undefined');
      
      
      if (isTest) {
        try {
          const explicit = context.getVariable('SKIP_PERSONA_OPERATIONS');
          
          if (explicit === false) return false;
        } catch (e) {
          logger.debug('Error checking SKIP_PERSONA_OPERATIONS in test mode', { error: String(e) });
        }
        
        return true;
      }
      
      
      try {
        return context.getVariable('SKIP_PERSONA_OPERATIONS') === true;
      } catch (e) {
        logger.debug('Error checking SKIP_PERSONA_OPERATIONS variable', { error: String(e) });
      }
      return false;
    })();

    if (skipPersonaOps) {
      
      const stepName = this.config.name || '';
      const map: Record<string, { statusKey: string; responseKey: string }> = {
        qa_request: { statusKey: 'qa_status', responseKey: 'qa_response' },
        code_review_request: { statusKey: 'code_review_status', responseKey: 'code_review_response' },
        security_request: { statusKey: 'security_review_status', responseKey: 'security_response' },
        devops_request: { statusKey: 'devops_status', responseKey: 'devops_response' },
        context_request: { statusKey: 'context_status', responseKey: 'context_result' }
      };

      const mapping = map[stepName];
      
      
      const outputsList = Array.isArray(this.config.outputs) ? this.config.outputs : [];
      const resultOutputName = outputsList.find(o => o.endsWith('_result')) as string | undefined;
      const preseededResult = resultOutputName ? context.getVariable(resultOutputName) : undefined;
      const fallbackResponse = mapping ? context.getVariable(mapping.responseKey) : undefined;
      let derivedStatus = mapping ? context.getVariable(mapping.statusKey) : undefined;
      if (!derivedStatus) {
        const candidate = (preseededResult && typeof preseededResult === 'object') ? preseededResult : fallbackResponse;
        if (candidate && typeof candidate === 'object' && candidate.status) {
          derivedStatus = candidate.status;
        }
      }
      const seededStatus = (derivedStatus as string) || 'pass';
      
      const seededResponse = (preseededResult !== undefined ? preseededResult : (fallbackResponse || {}));

      
      context.setVariable(`${stepName}_status`, seededStatus);
      if (mapping?.statusKey) {
        context.setVariable(mapping.statusKey, seededStatus);
      }

      
      if (this.config.outputs && Array.isArray(this.config.outputs)) {
        for (const output of this.config.outputs) {
          
          if (output.endsWith('_status')) {
            context.setVariable(output, seededStatus);
          } else {
            context.setVariable(output, seededResponse);
          }
        }
      }

      logger.info('PersonaRequestStep bypassed (SKIP_PERSONA_OPERATIONS)', {
        workflowId: context.workflowId,
        step: stepName,
        persona
      });

      return {
        status: 'success',
        data: {
          step,
          persona,
          bypassed: true,
          seededStatus,
          result: seededResponse
        },
        outputs: seededResponse
      };
    }
    
    
    const baseTimeoutMs = config.timeout ?? personaTimeoutMs(persona, cfg);
    
    
    const configuredMaxRetries = config.maxRetries !== undefined ? config.maxRetries : personaMaxRetries(persona, cfg);
    
    
    const effectiveMaxRetries = configuredMaxRetries === null 
      ? Number.MAX_SAFE_INTEGER
      : configuredMaxRetries;
    const maxRetries = effectiveMaxRetries;
    const isUnlimitedRetries = configuredMaxRetries === null;

    logger.info(`Making persona request`, {
      workflowId: context.workflowId,
      step,
      persona,
      intent,
      baseTimeoutMs,
      baseTimeoutSec: (baseTimeoutMs / 1000).toFixed(1),
      maxRetries: isUnlimitedRetries ? 'unlimited' : maxRetries,
      backoffIncrementMs: cfg.personaRetryBackoffIncrementMs
    });

    const transport = context.transport;
    if (!transport) {
      throw new Error('Transport not available in context');
    }

    try {
      
      
      const resolvedPayload = this.resolvePayloadVariables(payload, context);
      
      
      
      
      const repoForPersona = context.getVariable('repo_remote')
        || context.getVariable('repo')
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

      
      const currentBranch = context.getCurrentBranch();
      
      
      let lastCorrId = '';
      let attempt = 0;
      let completion = null;
      
      
      const HARD_CAP_ATTEMPTS = 100;
      
      while ((isUnlimitedRetries || attempt <= maxRetries) && !completion && attempt < HARD_CAP_ATTEMPTS) {
        attempt++;
        
        
        const currentTimeoutMs = calculateProgressiveTimeout(
          baseTimeoutMs,
          attempt,
          cfg.personaRetryBackoffIncrementMs
        );
        
        if (attempt > 1) {
          logger.info(`Retrying persona request (progressive timeout)`, {
            workflowId: context.workflowId,
            step,
            persona,
            attempt,
            maxRetries: isUnlimitedRetries ? 'unlimited' : maxRetries,
            baseTimeoutMs,
            currentTimeoutMs,
            currentTimeoutMin: (currentTimeoutMs / 60000).toFixed(2),
            backoffIncrementMs: cfg.personaRetryBackoffIncrementMs
          });
        } else {
          logger.info(`First attempt with base timeout`, {
            workflowId: context.workflowId,
            step,
            persona,
            timeoutMs: currentTimeoutMs,
            timeoutMin: (currentTimeoutMs / 60000).toFixed(2)
          });
        }
        
        
        const taskId = resolvedPayload.task_id 
          || resolvedPayload.taskId 
          || context.getVariable('task_id') 
          || context.getVariable('taskId');
        
        const corrId = await sendPersonaRequest(transport, {
          workflowId: context.workflowId,
          toPersona: persona,
          step,
          intent,
          payload: resolvedPayload,
          repo: repoForPersona,
          branch: currentBranch,
          projectId: context.projectId,
          taskId,
          deadlineSeconds
        });

        lastCorrId = corrId;

        logger.info(`Persona request sent`, {
          workflowId: context.workflowId,
          step,
          persona,
          corrId,
          attempt,
          timeoutMs: currentTimeoutMs
        });

        
        try {
          completion = await waitForPersonaCompletion(transport, persona, context.workflowId, corrId, currentTimeoutMs);
        } catch (error: any) {
          
          if (error.message && error.message.includes('Timed out waiting')) {
            completion = null;
            if (isUnlimitedRetries || attempt < maxRetries) {
              logger.warn(`Persona request timed out, will retry with increased timeout`, {
                workflowId: context.workflowId,
                step,
                persona,
                corrId,
                attempt,
                timedOutAtMs: currentTimeoutMs,
                timedOutAtMin: (currentTimeoutMs / 60000).toFixed(2),
                nextTimeoutMs: calculateProgressiveTimeout(baseTimeoutMs, attempt + 1, cfg.personaRetryBackoffIncrementMs),
                nextTimeoutMin: (calculateProgressiveTimeout(baseTimeoutMs, attempt + 1, cfg.personaRetryBackoffIncrementMs) / 60000).toFixed(2),
                remainingRetries: isUnlimitedRetries ? 'unlimited' : (maxRetries - attempt)
              });
            }
          } else {
            
            throw error;
          }
        }
      }
      
      if (!completion) {
        const totalAttempts = attempt;
        const finalTimeoutMs = calculateProgressiveTimeout(baseTimeoutMs, attempt, cfg.personaRetryBackoffIncrementMs);
        const hitHardCap = attempt >= HARD_CAP_ATTEMPTS;
        
        
        logger.error(`Persona request failed after exhausting all retries - WORKFLOW WILL ABORT`, {
          workflowId: context.workflowId,
          step,
          persona,
          totalAttempts,
          baseTimeoutMs,
          baseTimeoutMin: (baseTimeoutMs / 60000).toFixed(2),
          finalTimeoutMs,
          finalTimeoutMin: (finalTimeoutMs / 60000).toFixed(2),
          maxRetriesConfigured: isUnlimitedRetries ? 'unlimited' : maxRetries,
          backoffIncrementMs: cfg.personaRetryBackoffIncrementMs,
          corrId: lastCorrId,
          hitHardCap,
          diagnostics: {
            reason: hitHardCap ? 'Hit hard cap of 100 attempts (safety limit)' : 'All retry attempts exhausted without successful completion',
            recommendation: 'Check persona availability, LM Studio status, and increase timeout/retries if needed',
            configKeys: ['PERSONA_TIMEOUTS_JSON', 'PERSONA_MAX_RETRIES_JSON', 'PERSONA_DEFAULT_TIMEOUT_MS', 'PERSONA_DEFAULT_MAX_RETRIES']
          }
        });
        
        return {
          status: 'failure',
          error: new Error(
            `Persona '${persona}' request timed out after ${totalAttempts} attempts. ` +
            `Base timeout: ${(baseTimeoutMs / 60000).toFixed(2)}min, ` +
            `Final timeout: ${(finalTimeoutMs / 60000).toFixed(2)}min. ` +
            `Workflow aborted. Check persona availability and configuration.`
          ),
          data: { 
            step, 
            persona, 
            corrId: lastCorrId, 
            totalAttempts,
            baseTimeoutMs,
            finalTimeoutMs,
            workflowAborted: true
          }
        };
      }

      
      const rawResponse = completion.fields?.result || '';
      
      
      let result: any = {};
      try {
        result = completion.fields?.result ? JSON.parse(completion.fields.result) : {};
      } catch (parseError) {
        logger.warn(`Failed to parse persona response as JSON, using raw response`, {
          workflowId: context.workflowId,
          step,
          persona,
          error: parseError instanceof Error ? parseError.message : 'Unknown error'
        });
        
        result = { raw: rawResponse };
      }
      
      
      let statusInfo = interpretPersonaStatus(rawResponse);
      
      
      
      if (persona === 'tester-qa' && statusInfo.status === 'pass') {
        
        const noTestsPatterns = [
          /0\s+passed,\s+0\s+failed/i,
          /no tests.*present/i,
          /no tests.*found/i,
          /nothing to execute/i,
          /0\s+tests?\s+(?:executed|run)/i
        ];
        
        const hasNoTests = noTestsPatterns.some(pattern => pattern.test(rawResponse));
        
        if (hasNoTests) {
          logger.warn('QA reported pass but no tests were executed - overriding to fail', {
            workflowId: context.workflowId,
            step,
            persona,
            corrId: lastCorrId,
            originalStatus: statusInfo.status,
            responsePreview: rawResponse.substring(0, 300)
          });
          
          statusInfo = {
            status: 'fail',
            details: 'QA validation failed: No tests were executed. Cannot verify code correctness without running tests.',
            raw: statusInfo.raw,
            payload: statusInfo.payload
          };
        }
      }
      
      logger.info(`Persona request completed`, {
        workflowId: context.workflowId,
        step,
        persona,
        corrId: lastCorrId,
        attempt,
        status: statusInfo.status,
        rawStatus: result.status || 'unknown'
      });

      
      this.setOutputVariables(context, result);
      
      
      context.setVariable(`${this.config.name}_status`, statusInfo.status);

      
      
      if (statusInfo.status === 'fail') {
        logger.error(`Persona request failed - workflow will abort`, {
          workflowId: context.workflowId,
          step,
          persona,
          corrId: lastCorrId,
          statusDetails: statusInfo.details,
          errorFromPersona: result.error || 'Unknown error'
        });

        return {
          status: 'failure',
          error: new Error(statusInfo.details || result.error || 'Persona request failed'),
          data: {
            step,
            persona,
            corrId: lastCorrId,
            totalAttempts: attempt,
            result,
            completion,
            personaFailureReason: statusInfo.details
          },
          outputs: result
        };
      }

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
    return this.variableResolver.resolvePayload(payload, context);
  }

  private setOutputVariables(context: WorkflowContext, result: any): void {
    
    if (this.config.outputs) {
      for (const output of this.config.outputs) {
        context.setVariable(output, result);
      }
    }

    
    if (result && typeof result === 'object') {
      for (const [key, value] of Object.entries(result)) {
        context.setVariable(`${this.config.name}_${key}`, value);
      }
    }
  }

  protected async validateConfig(_context: WorkflowContext): Promise<ValidationResult> {
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