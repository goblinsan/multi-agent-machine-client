import { WorkflowStep, StepResult, ValidationResult, WorkflowStepConfig } from '../engine/WorkflowStep.js';
import { WorkflowContext } from '../engine/WorkflowContext.js';
import { logger } from '../../logger.js';
import { TaskAPI, CreateTaskInput } from '../../dashboard/TaskAPI.js';
import { ProjectAPI } from '../../dashboard/ProjectAPI.js';

const taskAPI = new TaskAPI();
const projectAPI = new ProjectAPI();

/**
 * Configuration for ReviewFailureTasksStep
 */
interface ReviewFailureTasksConfig {
  /**
   * Variable name containing the normalized PM decision from PMDecisionParserStep
   * Expected format: { decision, reasoning, immediate_issues, deferred_issues, follow_up_tasks }
   */
  pmDecisionVariable: string;
  
  /**
   * Type of review that failed
   */
  reviewType: 'code_review' | 'security_review' | 'qa' | 'devops';
  
  /**
   * Priority score for urgent tasks
   * - QA: 1200 (test failures block all work)
   * - Code/Security/DevOps: 1000
   * If not specified, uses review type defaults
   */
  urgentPriorityScore?: number;
  
  /**
   * Priority score for deferred tasks (default: 50)
   */
  deferredPriorityScore?: number;
  
  /**
   * Whether to create tasks for deferred issues (default: true)
   */
  createDeferredTasks?: boolean;
  
  /**
   * Milestone slug for backlog tasks (default: 'future-enhancements')
   */
  backlogMilestoneSlug?: string;
}

/**
 * ReviewFailureTasksStep creates follow-up tasks based on PM review failure prioritization
 * 
 * **IMPORTANT:** This step requires normalized PM decision from PMDecisionParserStep.
 * The legacy parsePMDecision() method has been REMOVED (44% code reduction).
 * 
 * This step:
 * 1. Gets normalized PM decision from PMDecisionParserStep (via context variable)
 * 2. Creates high-priority urgent tasks for critical/high priority issues
 * 3. Optionally creates backlog tasks for medium/low priority issues
 * 4. Returns summary of created tasks
 * 
 * Expected PM decision format (from PMDecisionParserStep):
 * {
 *   "decision": "immediate_fix" | "defer",
 *   "reasoning": "...",
 *   "immediate_issues": ["issue1", "issue2"],
 *   "deferred_issues": ["issue3", "issue4"],
 *   "follow_up_tasks": [
 *     {"title": "...", "description": "...", "priority": "critical|high|medium|low"}
 *   ]
 * }
 * 
 * **Assignee Logic (Simplified):**
 * All follow-up tasks are assigned to 'implementation-planner' persona.
 * This must precede engineering work. Review-type-specific assignee logic removed.
 * 
 * **Priority Tiers:**
 * - QA urgent: 1200 (test failures block all work)
 * - Code/Security/DevOps urgent: 1000
 * - All deferred: 50
 * 
 * **Workflow Integration:**
 * ```yaml
 * # In review-failure-handling.yaml:
 * - name: parse_pm_decision
 *   type: PMDecisionParserStep
 *   config:
 *     input: "${pm_evaluation}"
 *     normalize: true
 *     review_type: "${review_type}"
 *   outputs:
 *     pm_decision: parsed_decision
 * 
 * - name: create_follow_up_tasks
 *   type: ReviewFailureTasksStep
 *   config:
 *     pmDecisionVariable: "pm_decision"  # Uses PMDecisionParserStep output
 *     reviewType: "${review_type}"
 * ```
 */
export class ReviewFailureTasksStep extends WorkflowStep {
  async execute(context: WorkflowContext): Promise<StepResult> {
    const config = this.config.config as ReviewFailureTasksConfig;
    const startTime = Date.now();
    
    try {
      logger.info('Creating review failure follow-up tasks', {
        stepName: this.config.name,
        reviewType: config.reviewType,
        pmDecisionVariable: config.pmDecisionVariable
      });
      
      // Get normalized PM decision from PMDecisionParserStep output
      const pmDecision = context.getVariable(config.pmDecisionVariable);
      
      if (!pmDecision) {
        logger.error('No PM decision found in context - ensure PMDecisionParserStep runs before this step', {
          stepName: this.config.name,
          variable: config.pmDecisionVariable,
          availableVariables: Object.keys(context['variables'] || {})
        });
        return {
          status: 'failure' as const,
          error: new Error(`Missing PM decision variable: ${config.pmDecisionVariable}. Ensure PMDecisionParserStep runs first.`),
          metrics: {
            duration_ms: Date.now() - startTime
          }
        };
      }
      
      // Validate PM decision structure (should be normalized by PMDecisionParserStep)
      if (!pmDecision.follow_up_tasks || !Array.isArray(pmDecision.follow_up_tasks)) {
        logger.error('PM decision missing follow_up_tasks array - expected normalized output from PMDecisionParserStep', {
          stepName: this.config.name,
          hasFollowUpTasks: !!pmDecision.follow_up_tasks,
          pmDecisionType: typeof pmDecision,
          pmDecisionKeys: Object.keys(pmDecision)
        });
        return {
          status: 'failure' as const,
          error: new Error('Invalid PM decision format - follow_up_tasks array required. Ensure PMDecisionParserStep normalization is enabled.'),
          metrics: {
            duration_ms: Date.now() - startTime
          }
        };
      }
      
      // Get context variables for task creation
      const projectId = context.getVariable('projectId');
      const milestoneId = context.getVariable('milestoneId');
      const task = context.getVariable('task');
      const parentTaskId = task?.id || context.getVariable('taskId');
      
      if (!projectId) {
        throw new Error('Missing required projectId in context');
      }
      
      logger.info('PM decision validated', {
        stepName: this.config.name,
        decision: pmDecision.decision,
        immediateIssuesCount: pmDecision.immediate_issues?.length || 0,
        deferredIssuesCount: pmDecision.deferred_issues?.length || 0,
        followUpTasksCount: pmDecision.follow_up_tasks.length
      });
      
      // Fetch existing tasks for duplicate detection
      const existingTasks = await projectAPI.fetchProjectTasks(projectId);
      logger.debug('Fetched existing tasks for duplicate detection', {
        stepName: this.config.name,
        existingTasksCount: existingTasks.length
      });
      
      // Create tasks
      let urgentTasksCreated = 0;
      let deferredTasksCreated = 0;
      let skippedDuplicates = 0;
      
      // Create follow-up tasks
      if (pmDecision.follow_up_tasks.length > 0) {
        for (const followUpTask of pmDecision.follow_up_tasks) {
          const isUrgent = ['critical', 'high'].includes(followUpTask.priority?.toLowerCase() || '');
          
          try {
            // Calculate priority score based on review type and urgency
            // QA urgent: 1200 (test failures block all work)
            // Code/Security/DevOps urgent: 1000
            // All deferred: 50
            const defaultUrgentPriority = config.reviewType === 'qa' ? 1200 : 1000;
            const priorityScore = isUrgent 
              ? (config.urgentPriorityScore || defaultUrgentPriority)
              : (config.deferredPriorityScore || 50);
            
            const taskTitle = this.formatTaskTitle(followUpTask.title, config.reviewType, isUrgent);
            const taskDescription = this.formatTaskDescription(
              followUpTask.description,
              pmDecision,
              config.reviewType,
              parentTaskId
            );
            
            // Check for duplicate tasks
            if (this.isDuplicateTask(followUpTask, existingTasks, taskTitle)) {
              skippedDuplicates++;
              logger.info('Skipping duplicate task', {
                stepName: this.config.name,
                title: taskTitle,
                originalTitle: followUpTask.title
              });
              continue;
            }
            
            // Urgent tasks go to the same milestone, deferred tasks go to backlog
            const targetMilestoneId = isUrgent ? milestoneId : null;
            const targetMilestoneSlug = isUrgent ? undefined : (config.backlogMilestoneSlug || 'future-enhancements');
            
            logger.info('Creating follow-up task', {
              stepName: this.config.name,
              title: taskTitle,
              priority: followUpTask.priority,
              isUrgent,
              priorityScore,
              parentTaskId,
              assignee: 'implementation-planner'
            });
            
            const result = await taskAPI.createDashboardTask({
              projectId,
              milestoneId: targetMilestoneId,
              milestoneSlug: targetMilestoneSlug,
              parentTaskId,
              title: taskTitle,
              description: taskDescription,
              priorityScore,
              options: {
                create_milestone_if_missing: !isUrgent // Only auto-create backlog milestone
              }
            });
            
            if (result?.ok) {
              if (isUrgent) {
                urgentTasksCreated++;
              } else {
                deferredTasksCreated++;
              }
              
              logger.info('Follow-up task created successfully', {
                stepName: this.config.name,
                taskId: result.createdId,
                title: taskTitle,
                isUrgent
              });
            } else {
              logger.error('Failed to create follow-up task', {
                stepName: this.config.name,
                title: taskTitle,
                error: result?.error,
                status: result?.status
              });
            }
          } catch (error) {
            logger.error('Error creating follow-up task', {
              stepName: this.config.name,
              taskTitle: followUpTask.title,
              error: String(error)
            });
          }
        }
      }
      
      const totalTasksCreated = urgentTasksCreated + deferredTasksCreated;
      
      logger.info('Review failure tasks created', {
        stepName: this.config.name,
        reviewType: config.reviewType,
        totalTasksCreated,
        urgentTasksCreated,
        deferredTasksCreated,
        skippedDuplicates,
        pmDecision: pmDecision.decision
      });
      
      return {
        status: 'success' as const,
        outputs: {
          tasks_created: totalTasksCreated,
          urgent_tasks_created: urgentTasksCreated,
          deferred_tasks_created: deferredTasksCreated,
          skipped_duplicates: skippedDuplicates,
          pm_decision: pmDecision.decision,
          has_urgent_tasks: urgentTasksCreated > 0
        },
        metrics: {
          duration_ms: Date.now() - startTime
        }
      };
      
    } catch (error: any) {
      logger.error('ReviewFailureTasksStep execution failed', {
        stepName: this.config.name,
        error: error.message,
        stack: error.stack
      });
      
      return {
        status: 'failure' as const,
        error: error,
        metrics: {
          duration_ms: Date.now() - startTime
        }
      };
    }
  }
  
  /**
   * Check if a task is a duplicate of an existing task
   * Compares normalized title and description keywords (50% overlap threshold)
   */
  private isDuplicateTask(followUpTask: any, existingTasks: any[], formattedTitle: string): boolean {
    if (!followUpTask || !existingTasks || existingTasks.length === 0) {
      return false;
    }
    
    // Normalize titles for comparison (remove prefixes, emojis, brackets)
    const normalizeTitle = (title: string): string => {
      return title
        .toLowerCase()
        .replace(/🚨|📋|⚠️|✅/g, '') // Remove emojis
        .replace(/\[.*?\]/g, '') // Remove [Code Review] etc
        .replace(/urgent/gi, '') // Remove urgent markers
        .replace(/\s+/g, ' ') // Normalize whitespace
        .trim();
    };
    
    const normalizedNewTitle = normalizeTitle(followUpTask.title);
    const normalizedFormattedTitle = normalizeTitle(formattedTitle);
    
    // Extract key phrases from description (words 5+ chars)
    const extractKeyPhrases = (text: string): Set<string> => {
      if (!text) return new Set();
      return new Set(
        text
          .toLowerCase()
          .match(/\b\w{5,}\b/g) || []
      );
    };
    
    const newKeyPhrases = extractKeyPhrases(followUpTask.description || '');
    
    for (const existingTask of existingTasks) {
      const existingTitle = existingTask.title || '';
      const normalizedExistingTitle = normalizeTitle(existingTitle);
      
      // Title similarity check
      const titleMatch = 
        normalizedExistingTitle.includes(normalizedNewTitle) ||
        normalizedNewTitle.includes(normalizedExistingTitle) ||
        normalizedExistingTitle === normalizedFormattedTitle;
      
      if (titleMatch) {
        // If titles match closely, check description overlap
        const existingKeyPhrases = extractKeyPhrases(existingTask.description || '');
        const overlapCount = [...newKeyPhrases].filter(phrase => 
          existingKeyPhrases.has(phrase)
        ).length;
        
        // If >50% of key phrases overlap, consider it a duplicate
        const overlapRatio = newKeyPhrases.size > 0 
          ? overlapCount / newKeyPhrases.size 
          : 0;
        
        if (overlapRatio > 0.5) {
          logger.debug('Duplicate task detected', {
            newTitle: followUpTask.title,
            existingTitle: existingTask.title,
            overlapRatio,
            overlapPercentage: `${(overlapRatio * 100).toFixed(1)}%`,
            existingTaskId: existingTask.id
          });
          return true;
        }
      }
    }
    
    return false;
  }
  
  /**
   * Format task title with review type prefix and urgency indicator
   */
  private formatTaskTitle(title: string, reviewType: string, isUrgent: boolean): string {
    const prefix = isUrgent ? '🚨 URGENT' : '📋';
    
    const reviewLabels: Record<string, string> = {
      'code_review': 'Code Review',
      'security_review': 'Security Review',
      'qa': 'QA',
      'devops': 'DevOps'
    };
    
    const reviewLabel = reviewLabels[reviewType] || reviewType;
    
    // If title already has the review type, don't duplicate
    if (title.toLowerCase().includes(reviewLabel.toLowerCase())) {
      return `${prefix} ${title}`;
    }
    
    return `${prefix} [${reviewLabel}] ${title}`;
  }
  
  /**
   * Format task description with context and links
   */
  private formatTaskDescription(
    description: string,
    pmDecision: any,
    reviewType: string,
    parentTaskId?: string
  ): string {
    const reviewLabels: Record<string, string> = {
      'code_review': 'Code Review',
      'security_review': 'Security Review',
      'qa': 'QA',
      'devops': 'DevOps'
    };
    
    const reviewLabel = reviewLabels[reviewType] || reviewType;
    
    let formatted = `## ${reviewLabel} Follow-up\n\n`;
    formatted += `${description}\n\n`;
    
    if (parentTaskId) {
      formatted += `**Original Task:** #${parentTaskId}\n\n`;
    }
    
    if (pmDecision.reasoning) {
      formatted += `**PM Decision Reasoning:**\n${pmDecision.reasoning}\n\n`;
    }
    
    if (pmDecision.immediate_issues && pmDecision.immediate_issues.length > 0) {
      formatted += `**Immediate Issues Identified:**\n`;
      pmDecision.immediate_issues.forEach((issue: string, idx: number) => {
        formatted += `${idx + 1}. ${issue}\n`;
      });
      formatted += `\n`;
    }
    
    formatted += `---\n`;
    formatted += `*Auto-created from ${reviewLabel} failure analysis*\n`;
    formatted += `*Assignee: implementation-planner (must precede engineering)*\n`;
    
    return formatted;
  }
  
  async validate(context: WorkflowContext): Promise<ValidationResult> {
    const config = this.config.config as ReviewFailureTasksConfig;
    const errors: string[] = [];
    const warnings: string[] = [];
    
    if (!config.pmDecisionVariable) {
      errors.push('ReviewFailureTasksStep: pmDecisionVariable is required');
    }
    
    if (!config.reviewType) {
      errors.push('ReviewFailureTasksStep: reviewType is required');
    } else if (!['code_review', 'security_review', 'qa', 'devops'].includes(config.reviewType)) {
      errors.push('ReviewFailureTasksStep: reviewType must be one of: code_review, security_review, qa, devops');
    }
    
    if (config.urgentPriorityScore !== undefined && config.urgentPriorityScore < 0) {
      errors.push('ReviewFailureTasksStep: urgentPriorityScore must be non-negative');
    }
    
    if (config.deferredPriorityScore !== undefined && config.deferredPriorityScore < 0) {
      errors.push('ReviewFailureTasksStep: deferredPriorityScore must be non-negative');
    }
    
    // Warning if pmDecisionVariable doesn't suggest it's from PMDecisionParserStep
    if (config.pmDecisionVariable && 
        !config.pmDecisionVariable.includes('pm_decision') && 
        !config.pmDecisionVariable.includes('parsed_decision')) {
      warnings.push(`ReviewFailureTasksStep: pmDecisionVariable "${config.pmDecisionVariable}" should typically be "pm_decision" or "parsed_decision" from PMDecisionParserStep`);
    }
    
    return {
      valid: errors.length === 0,
      errors,
      warnings
    };
  }
}
