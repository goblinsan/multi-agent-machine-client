import { WorkflowStep, StepResult, ValidationResult, WorkflowStepConfig } from '../engine/WorkflowStep.js';
import { WorkflowContext } from '../engine/WorkflowContext.js';
import { logger } from '../../logger.js';
import { createDashboardTask, fetchProjectTasks } from '../../dashboard.js';

/**
 * Configuration for ReviewFailureTasksStep
 */
interface ReviewFailureTasksConfig {
  /**
   * Variable name containing the PM decision result
   */
  pmDecisionVariable: string;
  
  /**
   * Type of review that failed
   */
  reviewType: 'code_review' | 'security_review';
  
  /**
   * Priority score for urgent tasks (default: 1000 for immediate attention)
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
 * This step:
 * 1. Parses the PM decision from the review failure evaluation
 * 2. Creates high-priority urgent tasks for SEVERE/HIGH issues
 * 3. Optionally creates backlog tasks for MEDIUM/LOW issues
 * 4. Returns summary of created tasks
 * 
 * Expected PM decision format:
 * {
 *   "decision": "immediate_fix" | "defer",
 *   "reasoning": "...",
 *   "immediate_issues": ["issue1", "issue2"],
 *   "deferred_issues": ["issue3", "issue4"],
 *   "follow_up_tasks": [
 *     {"title": "...", "description": "...", "priority": "critical|high|medium|low"}
 *   ]
 * }
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
      
      // Get PM decision from context
      const pmDecisionRaw = context.getVariable(config.pmDecisionVariable);
      if (!pmDecisionRaw) {
        logger.warn('No PM decision found in context', {
          stepName: this.config.name,
          variable: config.pmDecisionVariable
        });
        return {
          status: 'success' as const,
          outputs: {
            tasks_created: 0,
            urgent_tasks_created: 0,
            deferred_tasks_created: 0
          },
          metrics: {
            duration_ms: Date.now() - startTime
          }
        };
      }
      
      // Parse PM decision
      const pmDecision = this.parsePMDecision(pmDecisionRaw);
      if (!pmDecision) {
        logger.warn('Failed to parse PM decision', {
          stepName: this.config.name,
          rawDecision: typeof pmDecisionRaw === 'string' ? pmDecisionRaw.substring(0, 200) : JSON.stringify(pmDecisionRaw).substring(0, 200)
        });
        return {
          status: 'success' as const,
          outputs: {
            tasks_created: 0,
            urgent_tasks_created: 0,
            deferred_tasks_created: 0
          },
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
      
      logger.info('PM decision parsed', {
        stepName: this.config.name,
        decision: pmDecision.decision,
        immediateIssuesCount: pmDecision.immediate_issues?.length || 0,
        deferredIssuesCount: pmDecision.deferred_issues?.length || 0,
        followUpTasksCount: pmDecision.follow_up_tasks?.length || 0
      });
      
      // Fetch existing tasks for duplicate detection
      const existingTasks = await fetchProjectTasks(projectId);
      logger.debug('Fetched existing tasks for duplicate detection', {
        stepName: this.config.name,
        existingTasksCount: existingTasks.length
      });
      
      // Create tasks
      let urgentTasksCreated = 0;
      let deferredTasksCreated = 0;
      let skippedDuplicates = 0;
      
      // Create urgent/immediate fix tasks
      if (pmDecision.follow_up_tasks && pmDecision.follow_up_tasks.length > 0) {
        for (const followUpTask of pmDecision.follow_up_tasks) {
          const isUrgent = ['critical', 'high'].includes(followUpTask.priority?.toLowerCase() || '');
          
          try {
            const priorityScore = isUrgent 
              ? (config.urgentPriorityScore || 1000)
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
              parentTaskId
            });
            
            const result = await createDashboardTask({
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
   * Parse PM decision from various formats
   */
  private parsePMDecision(rawDecision: any): any {
    try {
      let parsed: any = null;
      
      // If it's already an object, check if it has a 'raw' field (from PersonaRequestStep JSON.parse failure)
      if (typeof rawDecision === 'object' && rawDecision !== null) {
        if (rawDecision.raw && typeof rawDecision.raw === 'string') {
          // PersonaRequestStep failed to parse, stored as { raw: "..." }
          // Try to parse the raw field
          rawDecision = rawDecision.raw;
        } else {
          // Already a proper object, use it
          parsed = rawDecision;
        }
      }
      
      // If it's a string, try to parse as JSON
      if (typeof rawDecision === 'string') {
        // Try to extract JSON from markdown code blocks or other wrapping
        let jsonStr = rawDecision.trim();
        
        // Remove markdown code fences
        jsonStr = jsonStr.replace(/^```(?:json)?\s*/gm, '').replace(/```\s*$/gm, '');
        
        // Try to find JSON object in the string
        const jsonMatch = jsonStr.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          parsed = JSON.parse(jsonMatch[0]);
        } else {
          // Try parsing the whole string
          parsed = JSON.parse(jsonStr);
        }
      }
      
      if (!parsed) {
        return null;
      }
      
      // Log the raw parsed data before normalization
      logger.debug('PM decision before normalization', {
        hasFollowUpTasks: !!parsed.follow_up_tasks,
        followUpTasksLength: parsed.follow_up_tasks?.length || 0,
        followUpTasksType: Array.isArray(parsed.follow_up_tasks) ? 'array' : typeof parsed.follow_up_tasks,
        hasBacklog: !!parsed.backlog,
        backlogLength: parsed.backlog?.length || 0,
        hasDecision: !!parsed.decision,
        decisionValue: parsed.decision,
        hasStatus: !!parsed.status,
        statusValue: parsed.status
      });
      
      // NORMALIZATION: Handle different PM response formats
      
      // 1. PM sometimes returns "backlog" instead of "follow_up_tasks"
      // Map backlog to follow_up_tasks if follow_up_tasks is missing or empty
      if ((!parsed.follow_up_tasks || parsed.follow_up_tasks.length === 0) && 
          parsed.backlog && 
          Array.isArray(parsed.backlog) && 
          parsed.backlog.length > 0) {
        parsed.follow_up_tasks = parsed.backlog;
        logger.debug('Normalized PM decision: mapped backlog to follow_up_tasks', {
          tasksCount: parsed.backlog.length
        });
      }
      
      // 2. PM sometimes returns "status" field instead of "decision" field
      // Map "status" to "decision" for consistency
      // If status is "pass", we interpret it as "defer" (PM approved but wants backlog tasks)
      // If status is "fail", we interpret it as "immediate_fix"
      if (!parsed.decision && parsed.status) {
        const status = String(parsed.status).toLowerCase();
        if (status === 'pass' || status === 'approved' || status === 'defer') {
          parsed.decision = 'defer';
        } else if (status === 'fail' || status === 'failed' || status === 'reject' || status === 'immediate_fix') {
          parsed.decision = 'immediate_fix';
        } else {
          // Unknown status, default to defer with backlog tasks
          parsed.decision = 'defer';
        }
        
        logger.debug('Normalized PM decision: mapped status to decision', {
          originalStatus: parsed.status,
          mappedDecision: parsed.decision
        });
      }
      
      // 3. Ensure we have a decision field (fallback to 'defer' if missing)
      if (!parsed.decision) {
        parsed.decision = 'defer';
        logger.debug('Normalized PM decision: defaulted to defer (no decision or status field)');
      }
      
      // Log the final normalized data
      logger.debug('PM decision after normalization', {
        decision: parsed.decision,
        hasFollowUpTasks: !!parsed.follow_up_tasks,
        followUpTasksLength: parsed.follow_up_tasks?.length || 0,
        hasBacklog: !!parsed.backlog,
        backlogLength: parsed.backlog?.length || 0
      });
      
      return parsed;
    } catch (error) {
      logger.warn('Failed to parse PM decision JSON', {
        error: String(error),
        rawType: typeof rawDecision
      });
      return null;
    }
  }
  
  /**
   * Check if a task is a duplicate of an existing task
   * Compares normalized title and description keywords
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
            existingTaskId: existingTask.id
          });
          return true;
        }
      }
    }
    
    return false;
  }
  
  /**
   * Format task title with review type prefix
   */
  private formatTaskTitle(title: string, reviewType: string, isUrgent: boolean): string {
    const prefix = isUrgent ? '🚨 URGENT' : '📋';
    const reviewLabel = reviewType === 'code_review' ? 'Code Review' : 'Security Review';
    
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
    const reviewLabel = reviewType === 'code_review' ? 'Code Review' : 'Security Review';
    
    let formatted = `## ${reviewLabel} Follow-up\n\n`;
    formatted += `${description}\n\n`;
    
    if (parentTaskId) {
      formatted += `**Original Task:** ${parentTaskId}\n\n`;
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
    formatted += `*Auto-created from ${reviewLabel.toLowerCase()} failure analysis*\n`;
    
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
    } else if (!['code_review', 'security_review'].includes(config.reviewType)) {
      errors.push('ReviewFailureTasksStep: reviewType must be either "code_review" or "security_review"');
    }
    
    if (config.urgentPriorityScore !== undefined && config.urgentPriorityScore < 0) {
      errors.push('ReviewFailureTasksStep: urgentPriorityScore must be non-negative');
    }
    
    if (config.deferredPriorityScore !== undefined && config.deferredPriorityScore < 0) {
      errors.push('ReviewFailureTasksStep: deferredPriorityScore must be non-negative');
    }
    
    return {
      valid: errors.length === 0,
      errors,
      warnings
    };
  }
}
