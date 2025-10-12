import { WorkflowStep, StepResult, ValidationResult } from '../engine/WorkflowStep.js';
import { WorkflowContext } from '../engine/WorkflowContext.js';
import { sendPersonaRequest, waitForPersonaCompletion, parseEventResult } from '../../agents/persona.js';
import { applyEditOps } from '../../fileops.js';
import { DiffParser } from '../../agents/parsers/DiffParser.js';
import { commitAndPushPaths } from '../../gitUtils.js';
import { makeRedis } from '../../redisClient.js';
import { PERSONAS } from '../../personaNames.js';
import { cfg } from '../../config.js';
import crypto from 'crypto';

interface QAIterationLoopConfig {
  /**
   * Maximum QA retries. Set to null for unlimited
   * @default cfg.coordinatorMaxRevisionAttempts
   */
  maxIterations?: number | null;
  
  /**
   * Step name for planning requests
   */
  planningStep?: string;
  
  /**
   * Step name for implementation requests
   */
  implementationStep?: string;
  
  /**
   * Step name for QA retest requests
   */
  qaRetestStep?: string;
}

/**
 * QAIterationLoopStep - Iteratively fixes QA failures
 * 
 * Loop: QA fails → Plan fixes → Implement → Apply → Commit → QA retest → repeat until pass or max iterations
 * 
 * Supports unlimited iterations via maxIterations: null
 */
export class QAIterationLoopStep extends WorkflowStep {
  async execute(context: WorkflowContext): Promise<StepResult> {
    const config = this.config.config as QAIterationLoopConfig || {};
    const {
      maxIterations = cfg.coordinatorMaxRevisionAttempts,
      planningStep = 'qa-fix-planning',
      implementationStep = 'qa-fix-implementation',
      qaRetestStep = 'qa-retest'
    } = config;

    const redis = await makeRedis();
    
    try {
      let currentIteration = 0;
      let qaResult = context.getVariable('qa_request_result');
      let qaPassed = false;
      const iterationHistory: any[] = [];

      // Determine if unlimited
      const isUnlimited = maxIterations === null;
      const effectiveMax = isUnlimited ? Infinity : maxIterations;

      context.logger.info('Starting QA iteration loop', {
        stepName: this.config.name,
        maxIterations: isUnlimited ? 'unlimited' : effectiveMax,
        initialQaStatus: context.getVariable('qa_request_status')
      });

      while (currentIteration < effectiveMax && !qaPassed) {
        currentIteration++;
        
        context.logger.info(`QA iteration ${currentIteration}${isUnlimited ? '' : `/${effectiveMax}`}`, {
          stepName: this.config.name,
          iteration: currentIteration
        });

        try {
          // 1. Plan fixes based on QA feedback
          const plan = await this.planFixes(context, redis, qaResult, iterationHistory, planningStep, currentIteration);
          
          // 2. Implement fixes
          const implementation = await this.implementFixes(context, redis, plan, implementationStep, currentIteration);
          
          // 3. Apply diffs
          const applyResult = await this.applyDiffs(context, implementation, currentIteration);
          
          // 4. Commit changes
          await this.commitChanges(context, applyResult, currentIteration);
          
          // 5. Retest QA with full history
          qaResult = await this.retestQA(context, redis, plan, implementation, qaRetestStep, currentIteration, iterationHistory);
          
          // 6. Check if QA passed
          qaPassed = this.parseQAStatus(qaResult) === 'pass';
          
          // Store iteration history
          iterationHistory.push({
            iteration: currentIteration,
            plan,
            implementation,
            qaResult,
            passed: qaPassed
          });

          if (qaPassed) {
            context.logger.info('QA passed after iteration', {
              stepName: this.config.name,
              iteration: currentIteration,
              totalIterations: currentIteration
            });
            
            // Update context variables for downstream steps
            context.setVariable('qa_request_status', 'pass');
            context.setVariable('qa_request_result', qaResult);
            context.setVariable('qa_iteration_count', currentIteration);
            
            break;
          } else {
            context.logger.warn('QA failed, continuing iteration', {
              stepName: this.config.name,
              iteration: currentIteration,
              remaining: isUnlimited ? 'unlimited' : (effectiveMax - currentIteration)
            });
          }
          
        } catch (error: any) {
          context.logger.error('QA iteration failed with error', {
            stepName: this.config.name,
            iteration: currentIteration,
            error: error.message
          });
          
          iterationHistory.push({
            iteration: currentIteration,
            error: error.message,
            passed: false
          });
          
          // Continue to next iteration unless we hit max
          if (currentIteration >= effectiveMax) {
            throw error;
          }
        }
      }

      if (!qaPassed) {
        context.logger.error('QA iteration loop exhausted without passing', {
          stepName: this.config.name,
          totalIterations: currentIteration,
          maxIterations: isUnlimited ? 'unlimited' : effectiveMax
        });
        
        return {
          status: 'failure',
          error: new Error(`QA failed after ${currentIteration} iteration${currentIteration > 1 ? 's' : ''}`),
          data: {
            totalIterations: currentIteration,
            iterationHistory,
            finalQaResult: qaResult
          }
        };
      }

      return {
        status: 'success',
        data: {
          totalIterations: currentIteration,
          iterationHistory,
          finalQaResult: qaResult,
          qaPassed: true
        }
      };
      
    } finally {
      await redis.disconnect();
    }
  }

  private async planFixes(
    context: WorkflowContext,
    redis: any,
    qaResult: any,
    history: any[],
    stepName: string,
    iteration: number
  ): Promise<any> {
    const corrId = crypto.randomUUID();
    const currentBranch = context.getCurrentBranch();
    
    await sendPersonaRequest(redis, {
      workflowId: context.workflowId,
      toPersona: PERSONAS.IMPLEMENTATION_PLANNER,
      step: `${stepName}-${iteration}`,
      intent: 'qa_fix_planning',
      payload: {
        task: context.getVariable('task'),
        qa_failure: qaResult,
        iteration,
        planIteration: iteration,
        previous_attempts: history,
        context: context.getVariable('context_request_result'),
        repo: context.getVariable('repo_remote'),
        branch: currentBranch,
        project_id: context.getVariable('projectId')
      },
      corrId,
      repo: context.getVariable('repoRoot'),
      branch: currentBranch,
      projectId: context.getVariable('projectId')
    });

    const planEvent = await waitForPersonaCompletion(
      redis,
      PERSONAS.IMPLEMENTATION_PLANNER,
      context.workflowId,
      corrId
    );

    return parseEventResult(planEvent.fields.result);
  }

  private async implementFixes(
    context: WorkflowContext,
    redis: any,
    plan: any,
    stepName: string,
    iteration: number
  ): Promise<any> {
    const corrId = crypto.randomUUID();
    const currentBranch = context.getCurrentBranch();
    
    await sendPersonaRequest(redis, {
      workflowId: context.workflowId,
      toPersona: PERSONAS.LEAD_ENGINEER,
      step: `${stepName}-${iteration}`,
      intent: 'implementation',
      payload: {
        task: context.getVariable('task'),
        plan,
        iteration,
        branch: currentBranch,
        context: context.getVariable('context_request_result'),
        repo: context.getVariable('repo_remote'),
        project_id: context.getVariable('projectId')
      },
      corrId,
      repo: context.getVariable('repoRoot'),
      branch: currentBranch,
      projectId: context.getVariable('projectId')
    });

    const implEvent = await waitForPersonaCompletion(
      redis,
      PERSONAS.LEAD_ENGINEER,
      context.workflowId,
      corrId
    );

    return parseEventResult(implEvent.fields.result);
  }

  private async applyDiffs(
    context: WorkflowContext,
    implementation: any,
    iteration: number
  ): Promise<any> {
    const diffContent = typeof implementation === 'string' 
      ? implementation 
      : implementation.output || JSON.stringify(implementation);

    const parseResult = DiffParser.parsePersonaResponse(diffContent);

    if (!parseResult.success || !parseResult.editSpec || parseResult.editSpec.ops.length === 0) {
      throw new Error(`QA iteration ${iteration}: No valid diffs to apply`);
    }

    const editSpecJson = JSON.stringify(parseResult.editSpec);
    const currentBranch = context.getVariable('branch') || context.branch;

    const applyResult = await applyEditOps(editSpecJson, {
      repoRoot: context.repoRoot,
      maxBytes: 512 * 1024,
      allowedExts: ['.ts', '.tsx', '.js', '.jsx', '.py', '.md', '.json', '.yml', '.yaml', '.css', '.html', '.sh', '.bat'],
      branchName: currentBranch,
      commitMessage: `fix(qa-iteration-${iteration}): address QA feedback`
    });

    if (!applyResult.changed || applyResult.changed.length === 0) {
      throw new Error(`QA iteration ${iteration}: No file changes after applying diffs`);
    }

    context.logger.info(`QA iteration ${iteration}: Applied ${applyResult.changed.length} file changes`, {
      files: applyResult.changed
    });

    return applyResult;
  }

  private async commitChanges(
    context: WorkflowContext,
    applyResult: any,
    iteration: number
  ): Promise<void> {
    const currentBranch = context.getCurrentBranch();
    
    const commitResult = await commitAndPushPaths({
      repoRoot: context.repoRoot,
      branch: currentBranch,
      message: `fix(qa-iteration-${iteration}): address QA feedback`,
      paths: ['*']
    });

    if (!commitResult.committed) {
      context.logger.warn(`QA iteration ${iteration}: Commit skipped (no changes)`, {
        reason: commitResult.reason
      });
    } else {
      context.logger.info(`QA iteration ${iteration}: Changes committed and pushed`, {
        committed: commitResult.committed,
        pushed: commitResult.pushed
      });
    }
  }

  private async retestQA(
    context: WorkflowContext,
    redis: any,
    plan: any,
    implementation: any,
    stepName: string,
    iteration: number,
    previousHistory?: any[]
  ): Promise<any> {
    const corrId = crypto.randomUUID();
    
    // Detect TDD context
    const task = context.getVariable('task');
    const tddStage = context.getVariable('tdd_stage') || task?.tdd_stage;
    const isFailingTestStage = tddStage === 'write_failing_test' || tddStage === 'failing_test';
    
    const currentBranch = context.getCurrentBranch();
    
    await sendPersonaRequest(redis, {
      workflowId: context.workflowId,
      toPersona: PERSONAS.TESTER_QA,
      step: `${stepName}-${iteration}`,
      intent: 'qa',
      payload: {
        task: context.getVariable('task'),
        plan,
        implementation,
        iteration,
        previous_attempts: previousHistory || [],
        tdd_stage: tddStage,
        is_tdd_failing_test_stage: isFailingTestStage,
        branch: currentBranch,
        repo: context.getVariable('repo_remote'),
        project_id: context.getVariable('projectId')
      },
      corrId,
      repo: context.getVariable('repoRoot'),
      branch: currentBranch,
      projectId: context.getVariable('projectId')
    });

    const qaEvent = await waitForPersonaCompletion(
      redis,
      PERSONAS.TESTER_QA,
      context.workflowId,
      corrId
    );

    return parseEventResult(qaEvent.fields.result);
  }

  private parseQAStatus(qaResult: any): string {
    try {
      if (typeof qaResult === 'string') {
        const parsed = JSON.parse(qaResult);
        return parsed.status || 'unknown';
      }
      
      if (typeof qaResult === 'object') {
        const payload = qaResult.payload || qaResult;
        return payload.status || qaResult.status || 'unknown';
      }
      
      return 'unknown';
    } catch (error) {
      return 'unknown';
    }
  }

  protected async validateConfig(context: WorkflowContext): Promise<ValidationResult> {
    const config = this.config.config as QAIterationLoopConfig || {};
    const errors: string[] = [];

    if (config.maxIterations !== undefined && config.maxIterations !== null) {
      if (!Number.isInteger(config.maxIterations) || config.maxIterations < 1) {
        errors.push('maxIterations must be a positive integer or null for unlimited');
      }
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings: []
    };
  }
}
