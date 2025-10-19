import { WorkflowStep, StepResult, ValidationResult } from '../engine/WorkflowStep.js';
import { WorkflowContext } from '../engine/WorkflowContext.js';
import { createDashboardTaskEntriesWithSummarizer } from '../../tasks/taskManager.js';
import { sendPersonaRequest, waitForPersonaCompletion, parseEventResult, interpretPersonaStatus } from '../../agents/persona.js';
import { makeRedis } from '../../redisClient.js';
import { PERSONAS } from '../../personaNames.js';
import { logger } from '../../logger.js';
import * as crypto from 'crypto';

/**
 * Configuration for ReviewCoordinationStep base class
 */
export interface ReviewCoordinationConfig {
  /**
   * Type of review being coordinated (qa, code_review, security_review)
   */
  reviewType: 'qa' | 'code_review' | 'security_review';
  
  /**
   * Variable name containing the review result
   * @default "{reviewType}_request_result"
   */
  reviewResultVariable?: string;
  
  /**
   * Max iterations for plan revision when review fails
   * @default 5
   */
  maxPlanRevisions?: number;
  
  /**
   * Whether to create new tasks for review failures or just iterate
   * @default "auto" - decides based on task history and context
   */
  taskCreationStrategy?: "always" | "never" | "auto";
  
  /**
   * TDD awareness - when true, considers failing tests as potentially valid goals
   * @default true for qa, false for code_review/security_review
   */
  tddAware?: boolean;
  
  /**
   * Step name for plan evaluation requests
   * @default "evaluate-{reviewType}-plan"
   */
  evaluationStep?: string;
  
  /**
   * Step name for plan revision requests  
   * @default "{reviewType}-plan-revision"
   */
  revisionStep?: string;
  
  /**
   * Step name for created tasks forwarding
   * @default "{reviewType}-created-tasks"
   */
  createdTasksStep?: string;
  
  /**
   * Priority score for urgent review failures (critical issues, blocking bugs)
   * @default 1200 for qa, 1000 for code_review, 1100 for security_review
   */
  urgentPriorityScore?: number;
  
  /**
   * Priority score for deferred review improvements
   * @default 50
   */
  deferredPriorityScore?: number;
  
  /**
   * Whether to support iterative fix loops (like QA)
   * @default true for qa, false for others
   */
  supportsIteration?: boolean;
}

/**
 * Parsed review status with standardized fields
 */
export interface ParsedReviewStatus {
  status: 'pass' | 'fail' | 'unknown';
  details?: string;
  tasks?: any[];
}

/**
 * Context information for TDD scenarios
 */
export interface TDDContext {
  isFailingTestStage: boolean;
  stage?: string;
}

/**
 * ReviewCoordinationStep is a base class that standardizes review failure coordination
 * across QA, code review, and security review workflows.
 * 
 * Common pattern extracted from QAFailureCoordinationStep and ReviewFailureTasksStep:
 * 1. Parse review result using interpretPersonaStatus() for consistent status extraction
 * 2. Detect special contexts (TDD, previous failures, etc.)
 * 3. Decide: create new tasks vs iterate on existing plan
 * 4. Execute PM evaluation and plan revision cycle
 * 5. Forward created tasks to implementation planner
 * 
 * Subclasses can override specific methods to customize behavior:
 * - parseReviewStatus() - custom parsing logic
 * - detectTDDContext() - custom TDD detection
 * - shouldCreateNewTasks() - custom task creation logic
 * - isUrgentFailure() - custom urgency detection
 * - createReviewFailureTasks() - custom task creation
 * 
 * This eliminates duplicate code and ensures bugs like the interpretPersonaStatus()
 * issues we just fixed can't recur in multiple places.
 */
export abstract class ReviewCoordinationStep extends WorkflowStep {
  
  async execute(context: WorkflowContext): Promise<StepResult> {
    const stepConfig = this.config.config as ReviewCoordinationConfig;
    const config = this.getResolvedConfig(stepConfig);
    
    try {
      const redis = await makeRedis();
      
      try {
        // Get review result from context
        let reviewResult = context.getVariable(config.reviewResultVariable);
        
        // If not available as a variable, get it from step output
        if (!reviewResult) {
          const reviewStepResult = context.getStepOutput(config.reviewType + '_request');
          if (reviewStepResult?.result) {
            reviewResult = reviewStepResult.result;
          }
        }
        
        if (!reviewResult) {
          return {
            status: 'failure',
            error: new Error(`${config.reviewType} result is required for review coordination`)
          };
        }
        
        // Parse review result to determine failure details
        const reviewStatus = this.parseReviewStatus(reviewResult);
        
        // Treat 'unknown' status as failure - this handles cases where tests pass
        // but review agent identifies issues/recommendations that need PM review
        if (reviewStatus.status !== 'fail' && reviewStatus.status !== 'unknown') {
          // No review failure, nothing to coordinate
          return {
            status: 'success',
            data: { action: 'no_failure', reviewStatus }
          };
        }
        
        logger.info(`${config.reviewType} failure detected, starting coordination`, {
          workflowId: context.workflowId,
          reviewType: config.reviewType,
          reviewStatus,
          isUnknownStatus: reviewStatus.status === 'unknown',
          tddAware: config.tddAware,
          taskCreationStrategy: config.taskCreationStrategy
        });
        
        const task = context.getVariable('task');
        const plan = context.getVariable('planning_loop_plan_result');
        
        // Determine if this is a TDD scenario where failure might be expected
        const tddContext = this.detectTDDContext(context, task);
        const isExpectedFailure = config.tddAware && tddContext.isFailingTestStage;
        
        if (isExpectedFailure) {
          logger.info('TDD failing test stage detected, treating review failure as acceptable', {
            workflowId: context.workflowId,
            reviewType: config.reviewType,
            tddStage: tddContext.stage
          });
          
          return {
            status: 'success',
            data: { 
              action: 'tdd_expected_failure',
              tddContext,
              reviewStatus
            }
          };
        }
        
        // Determine task creation strategy
        const shouldCreateNewTasks = this.shouldCreateNewTasks(
          config,
          context,
          task,
          reviewResult,
          reviewStatus
        );
        
        let createdTasks: any[] = [];
        let revisedPlan: any = null;
        
        if (shouldCreateNewTasks) {
          // Create new tasks for review failures
          createdTasks = await this.createReviewFailureTasks(
            context,
            redis,
            reviewResult,
            reviewStatus,
            config
          );
          
          if (createdTasks.length > 0 && config.createdTasksStep) {
            // Forward created tasks to implementation planner
            await this.forwardCreatedTasksToPlanner(
              context,
              redis,
              createdTasks,
              reviewResult,
              config
            );
          }
        }
        
        // Execute plan revision cycle if supported
        if (config.supportsIteration && plan) {
          revisedPlan = await this.executePlanRevisionCycle(
            context,
            redis,
            plan,
            reviewResult,
            config
          );
        }
        
        // Set variables for subsequent workflow steps
        const action = shouldCreateNewTasks ? 'created_tasks_and_revised' : 'revised_plan_only';
        context.setVariable(`${config.reviewType}_failure_action`, action);
        context.setVariable(`${config.reviewType}_failure_created_tasks`, createdTasks);
        context.setVariable(`${config.reviewType}_revised_plan_final`, revisedPlan);
        context.setVariable(`${config.reviewType}_failure_tdd_context`, tddContext);
        
        logger.info(`${config.reviewType} coordination completed successfully`, {
          workflowId: context.workflowId,
          action,
          createdTasksCount: createdTasks.length,
          revisedPlan: !!revisedPlan
        });
        
        return {
          status: 'success',
          data: {
            action,
            createdTasks,
            revisedPlan,
            reviewStatus,
            tddContext
          }
        };
      } finally {
        await redis.disconnect();
      }
    } catch (error: any) {
      logger.error(`${stepConfig.reviewType} coordination failed`, {
        workflowId: context.workflowId,
        error: error.message,
        stack: error.stack
      });
      return {
        status: 'failure',
        error: error
      };
    }
  }
  
  /**
   * Parse review status using interpretPersonaStatus() for consistent extraction
   * Subclasses can override to add custom parsing logic
   */
  protected parseReviewStatus(reviewResult: any): ParsedReviewStatus {
    try {
      // Use the same interpretation logic as PersonaRequestStep for consistency
      // Review result can be:
      // 1. Raw string output from persona
      // 2. Parsed object with 'output' field from parseEventResult
      // 3. Already parsed status object
      const rawOutput = reviewResult?.output || (typeof reviewResult === 'string' ? reviewResult : JSON.stringify(reviewResult));
      const statusInfo = interpretPersonaStatus(rawOutput);
      
      // Extract tasks if present in the payload
      const tasks = statusInfo.payload?.tasks || statusInfo.payload?.suggested_tasks || [];
      
      return {
        status: statusInfo.status as 'pass' | 'fail' | 'unknown',
        details: statusInfo.details,
        tasks
      };
    } catch (error) {
      const stepConfig = this.config.config as ReviewCoordinationConfig;
      logger.warn('Failed to parse review result, defaulting to fail status', { 
        reviewType: stepConfig.reviewType,
        error: error instanceof Error ? error.message : String(error) 
      });
      return { status: 'fail', details: String(reviewResult), tasks: [] };
    }
  }
  
  /**
   * Detect TDD context from task and workflow variables
   * Subclasses can override to add custom TDD detection logic
   */
  protected detectTDDContext(context: WorkflowContext, task: any): TDDContext {
    // Check for TDD stage indicators
    const tddStage = context.getVariable('tdd_stage') || task?.tdd_stage;
    const isFailingTestStage = tddStage === 'write_failing_test' || tddStage === 'failing_test';
    
    // Check for TDD labels
    const labels = task?.labels || task?.tags || [];
    const hasTDDLabels = labels.some((label: string) => 
      label.includes('tdd') || label.includes('failing_test') || label.includes('red_green_refactor')
    );
    
    return {
      isFailingTestStage: isFailingTestStage || hasTDDLabels,
      stage: tddStage
    };
  }
  
  /**
   * Determine whether to create new tasks or iterate on existing plan
   * Subclasses can override to customize task creation logic
   */
  protected shouldCreateNewTasks(
    config: Required<ReviewCoordinationConfig>,
    context: WorkflowContext,
    task: any,
    reviewResult: any,
    reviewStatus: ParsedReviewStatus
  ): boolean {
    if (config.taskCreationStrategy === 'always') return true;
    if (config.taskCreationStrategy === 'never') return false;
    
    // Auto strategy: create tasks for new failures, iterate on repeated failures
    const taskId = task?.id || task?.external_id;
    const parentTaskId = task?.parent_task_id || task?.parent_id;
    
    // If this task was created from a previous review failure, iterate instead of creating new tasks
    const isReviewFollowupTask = Boolean(parentTaskId && task?.stage === config.reviewType);
    
    if (isReviewFollowupTask) {
      logger.info(`${config.reviewType} failure on followup task, will iterate instead of creating new tasks`, {
        workflowId: context.workflowId,
        taskId,
        parentTaskId
      });
      return false;
    }
    
    // For fresh tasks, create new tasks if review suggests specific issues
    const hasSuggestedTasks = reviewStatus.tasks && reviewStatus.tasks.length > 0;
    const hasDetailedFailures = reviewStatus.details && reviewStatus.details.length > 5;
    
    logger.info(`Determining task creation for ${config.reviewType}`, {
      workflowId: context.workflowId,
      taskId,
      hasSuggestedTasks,
      hasDetailedFailures,
      detailsLength: reviewStatus.details ? reviewStatus.details.length : 0
    });
    
    return Boolean(hasSuggestedTasks || hasDetailedFailures);
  }
  
  /**
   * Determine if a review failure is urgent based on the failure characteristics
   * Subclasses can override to implement custom urgency logic
   */
  protected isUrgentFailure(reviewResult: any, reviewStatus: ParsedReviewStatus, config: Required<ReviewCoordinationConfig>): boolean {
    // Default: treat all review failures as urgent since they block progress
    return true;
  }
  
  /**
   * Create tasks for review failures
   * Subclasses can override to customize task creation
   */
  protected async createReviewFailureTasks(
    context: WorkflowContext,
    redis: any,
    reviewResult: any,
    reviewStatus: ParsedReviewStatus,
    config: Required<ReviewCoordinationConfig>
  ): Promise<any[]> {
    const task = context.getVariable('task');
    const projectId = context.getVariable('projectId');
    const milestone = context.getVariable('milestone');
    
    // Determine if this is an urgent review failure
    const isUrgent = this.isUrgentFailure(reviewResult, reviewStatus, config);
    const priorityScore = isUrgent ? config.urgentPriorityScore : config.deferredPriorityScore;
    
    // Extract or generate suggested tasks from review failure
    let suggestedTasks = reviewStatus.tasks || [];
    
    if (!suggestedTasks.length && reviewStatus.details) {
      // Generate a task from review failure details
      const title = `${config.reviewType} failure: ${reviewStatus.details.split('\n')[0].slice(0, 120)}`;
      suggestedTasks = [{
        title,
        description: reviewStatus.details.slice(0, 5000),
        schedule: isUrgent ? 'urgent' : 'medium',
        priority_score: priorityScore,
        assigneePersona: 'implementation-planner',
        stage: config.reviewType,
        parent_task_id: task?.id || task?.external_id
      }];
    }
    
    // Add priority_score to existing suggested tasks if not already set
    suggestedTasks = suggestedTasks.map(t => ({
      ...t,
      priority_score: t.priority_score || priorityScore,
      assigneePersona: t.assigneePersona || 'implementation-planner',
      stage: t.stage || config.reviewType,
      parent_task_id: t.parent_task_id || task?.id || task?.external_id
    }));
    
    logger.info(`Creating ${config.reviewType} failure tasks`, {
      workflowId: context.workflowId,
      tasksCount: suggestedTasks.length,
      isUrgent,
      priorityScore
    });
    
    // Create tasks on dashboard using the same pattern as QAFailureCoordinationStep
    try {
      const createOpts = {
        stage: config.reviewType as any,
        milestoneDescriptor: milestone,
        parentTaskDescriptor: task,
        projectId,
        projectName: context.getVariable('projectName'),
        scheduleHint: isUrgent ? 'urgent' : 'medium'
      };
      
      const created = await createDashboardTaskEntriesWithSummarizer(
        redis,
        context.workflowId,
        suggestedTasks,
        createOpts
      );
      
      logger.info(`Created ${config.reviewType} failure tasks`, {
        workflowId: context.workflowId,
        createdCount: created.length,
        taskTitles: created.map(t => t.title)
      });
      
      return created;
    } catch (error) {
      logger.error(`Failed to create ${config.reviewType} failure tasks`, {
        workflowId: context.workflowId,
        error: error instanceof Error ? error.message : String(error)
      });
      return [];
    }
  }
  
  /**
   * Forward created tasks to implementation planner for execution
   */
  protected async forwardCreatedTasksToPlanner(
    context: WorkflowContext,
    redis: any,
    createdTasks: any[],
    reviewResult: any,
    config: Required<ReviewCoordinationConfig>
  ): Promise<void> {
    const task = context.getVariable('task');
    const milestone = context.getVariable('milestone');
    const currentBranch = context.getCurrentBranch();
    
    logger.info(`Forwarding ${config.reviewType} failure tasks to implementation planner`, {
      workflowId: context.workflowId,
      taskCount: createdTasks.length,
      stepName: config.createdTasksStep
    });
    
    try {
      const corrId = crypto.randomUUID();
      
      await sendPersonaRequest(redis, {
        workflowId: context.workflowId,
        toPersona: PERSONAS.IMPLEMENTATION_PLANNER,
        step: config.createdTasksStep,
        intent: `handle_${config.reviewType}_created_followups`,
        payload: {
          created_tasks: createdTasks,
          review_result: reviewResult,
          stage: config.reviewType,
          milestone,
          branch: currentBranch,
          parent_task: task,
          project_id: context.getVariable('projectId')
        },
        corrId,
        repo: context.getVariable('repoRoot'),
        branch: currentBranch,
        projectId: context.getVariable('projectId')
      });
      
      // Wait for planner response
      const plannerEvent = await waitForPersonaCompletion(
        redis,
        PERSONAS.IMPLEMENTATION_PLANNER,
        context.workflowId,
        corrId
      );
      
      const plannerResult = parseEventResult(plannerEvent.fields.result);
      
      // Store planner result for potential use by subsequent steps
      context.setVariable(`${config.reviewType}_created_tasks_planner_result`, plannerResult);
      
      logger.info('Forwarded created tasks to planner successfully', {
        workflowId: context.workflowId,
        tasksCount: createdTasks.length,
        stepName: config.createdTasksStep
      });
      
    } catch (error) {
      logger.error('Failed to forward created tasks to planner', {
        workflowId: context.workflowId,
        stepName: config.createdTasksStep,
        error: error instanceof Error ? error.message : String(error)
      });
      throw error;
    }
  }
  
  /**
   * Execute plan revision cycle with PM evaluation
   */
  protected async executePlanRevisionCycle(
    context: WorkflowContext,
    redis: any,
    originalPlan: any,
    reviewResult: any,
    config: Required<ReviewCoordinationConfig>
  ): Promise<any> {
    logger.info(`Starting plan revision cycle for ${config.reviewType}`, {
      workflowId: context.workflowId,
      maxRevisions: config.maxPlanRevisions
    });
    
    let currentPlan = originalPlan;
    let approved = false;
    let iteration = 0;
    
    for (iteration = 0; iteration < config.maxPlanRevisions; iteration++) {
      // Evaluate current plan against review feedback
      const evalResult = await this.evaluatePlanAgainstReview(
        context,
        redis,
        currentPlan,
        reviewResult,
        config,
        iteration
      );
      
      if (evalResult.status === 'pass') {
        approved = true;
        break;
      }
      
      // Revise plan based on evaluator feedback
      currentPlan = await this.revisePlanWithReviewFeedback(
        context,
        redis,
        currentPlan,
        reviewResult,
        evalResult,
        config,
        iteration
      );
    }
    
    if (!approved) {
      logger.warn(`Plan revision cycle completed without approval for ${config.reviewType}`, {
        workflowId: context.workflowId,
        maxRevisions: config.maxPlanRevisions
      });
    }
    
    // Store results for use by subsequent steps
    context.setVariable(`${config.reviewType}_revised_plan`, currentPlan);
    context.setVariable(`${config.reviewType}_plan_approved`, approved);
    
    return {
      plan: currentPlan,
      approved,
      iterations: approved ? iteration + 1 : config.maxPlanRevisions
    };
  }
  
  /**
   * Evaluate plan against review feedback
   */
  protected async evaluatePlanAgainstReview(
    context: WorkflowContext,
    redis: any,
    plan: any,
    reviewResult: any,
    config: Required<ReviewCoordinationConfig>,
    iteration: number
  ): Promise<{ status: string; reason?: string }> {
    try {
      const corrId = crypto.randomUUID();
      const currentBranch = context.getCurrentBranch();
      
      await sendPersonaRequest(redis, {
        workflowId: context.workflowId,
        toPersona: PERSONAS.PLAN_EVALUATOR,
        step: iteration === 0 ? config.evaluationStep : config.evaluationStep + '-revised',
        intent: "evaluate_plan_relevance",
        payload: {
          review_feedback: reviewResult,
          plan: plan,
          iteration,
          branch: currentBranch,
          require_citations: true
        },
        corrId,
        repo: context.getVariable('repoRoot'),
        branch: currentBranch,
        projectId: context.getVariable('projectId')
      });
      
      const evalEvent = await waitForPersonaCompletion(
        redis,
        PERSONAS.PLAN_EVALUATOR,
        context.workflowId,
        corrId
      );
      
      const evalResult = parseEventResult(evalEvent.fields.result);
      
      return {
        status: evalResult?.status || 'unknown',
        reason: evalResult?.reason || evalResult?.details || evalResult?.message
      };
      
    } catch (error) {
      logger.error('Plan evaluation failed', {
        workflowId: context.workflowId,
        reviewType: config.reviewType,
        iteration,
        error: error instanceof Error ? error.message : String(error)
      });
      return { status: 'fail', reason: 'Evaluation failed due to error' };
    }
  }
  
  /**
   * Revise plan based on review feedback
   */
  protected async revisePlanWithReviewFeedback(
    context: WorkflowContext,
    redis: any,
    currentPlan: any,
    reviewResult: any,
    evalResult: any,
    config: Required<ReviewCoordinationConfig>,
    iteration: number
  ): Promise<any> {
    try {
      const corrId = crypto.randomUUID();
      const currentBranch = context.getCurrentBranch();
      
      await sendPersonaRequest(redis, {
        workflowId: context.workflowId,
        toPersona: PERSONAS.IMPLEMENTATION_PLANNER,
        step: config.revisionStep,
        intent: "revise_plan",
        payload: {
          review_feedback: reviewResult,
          evaluator_feedback: evalResult,
          previous_plan: currentPlan,
          iteration: iteration + 1,
          branch: currentBranch,
          revision_guidelines: [
            "Only include steps that directly address evaluator comments and review failures.",
            "Keep steps small, verifiable, and cite the failing test, error, or acceptance criteria they address.",
            "Remove unrelated or speculative work."
          ].join("\n"),
          require_plan_changes_mapping: true,
          require_citations: true
        },
        corrId,
        repo: context.getVariable('repoRoot'),
        branch: currentBranch,
        projectId: context.getVariable('projectId')
      });
      
      const revisionEvent = await waitForPersonaCompletion(
        redis,
        PERSONAS.IMPLEMENTATION_PLANNER,
        context.workflowId,
        corrId
      );
      
      const revisedPlan = parseEventResult(revisionEvent.fields.result);
      
      logger.info('Plan revision completed', {
        workflowId: context.workflowId,
        reviewType: config.reviewType,
        iteration: iteration + 1,
        hasRevisedPlan: Boolean(revisedPlan)
      });
      
      return revisedPlan || currentPlan;
      
    } catch (error) {
      logger.error('Plan revision failed', {
        workflowId: context.workflowId,
        reviewType: config.reviewType,
        iteration,
        error: error instanceof Error ? error.message : String(error)
      });
      return currentPlan; // Return unchanged plan on error
    }
  }
  
  /**
   * Get resolved configuration with defaults
   */
  protected getResolvedConfig(stepConfig: ReviewCoordinationConfig): Required<ReviewCoordinationConfig> {
    const reviewType = stepConfig.reviewType;
    
    // Default priority scores based on review type
    const defaultUrgentPriority = reviewType === 'qa' ? 1200 : reviewType === 'security_review' ? 1100 : 1000;
    
    return {
      reviewType,
      reviewResultVariable: stepConfig.reviewResultVariable || `${reviewType}_request_result`,
      maxPlanRevisions: stepConfig.maxPlanRevisions ?? 5,
      taskCreationStrategy: stepConfig.taskCreationStrategy || 'auto',
      tddAware: stepConfig.tddAware ?? (reviewType === 'qa'),
      evaluationStep: stepConfig.evaluationStep || `evaluate-${reviewType}-plan`,
      revisionStep: stepConfig.revisionStep || `${reviewType}-plan-revision`,
      createdTasksStep: stepConfig.createdTasksStep || `${reviewType}-created-tasks`,
      urgentPriorityScore: stepConfig.urgentPriorityScore ?? defaultUrgentPriority,
      deferredPriorityScore: stepConfig.deferredPriorityScore ?? 50,
      supportsIteration: stepConfig.supportsIteration ?? (reviewType === 'qa')
    };
  }
  
  protected async validateConfig(context: WorkflowContext): Promise<ValidationResult> {
    const config = this.config.config as ReviewCoordinationConfig;
    const errors: string[] = [];
    const warnings: string[] = [];
    
    if (!config.reviewType) {
      errors.push('ReviewCoordinationStep: reviewType is required');
    } else if (!['qa', 'code_review', 'security_review'].includes(config.reviewType)) {
      errors.push('ReviewCoordinationStep: reviewType must be "qa", "code_review", or "security_review"');
    }
    
    if (config.maxPlanRevisions !== undefined && config.maxPlanRevisions < 0) {
      errors.push('ReviewCoordinationStep: maxPlanRevisions must be non-negative');
    }
    
    if (config.urgentPriorityScore !== undefined && config.urgentPriorityScore < 0) {
      errors.push('ReviewCoordinationStep: urgentPriorityScore must be non-negative');
    }
    
    if (config.deferredPriorityScore !== undefined && config.deferredPriorityScore < 0) {
      errors.push('ReviewCoordinationStep: deferredPriorityScore must be non-negative');
    }
    
    if (config.taskCreationStrategy && !['always', 'never', 'auto'].includes(config.taskCreationStrategy)) {
      errors.push('ReviewCoordinationStep: taskCreationStrategy must be "always", "never", or "auto"');
    }
    
    return {
      valid: errors.length === 0,
      errors,
      warnings
    };
  }
}
