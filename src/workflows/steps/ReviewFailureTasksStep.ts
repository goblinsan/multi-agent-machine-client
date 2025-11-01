import { WorkflowStep, StepResult, ValidationResult } from '../engine/WorkflowStep.js';
import { WorkflowContext } from '../engine/WorkflowContext.js';
import { logger } from '../../logger.js';
import { TaskAPI, CreateTaskInput as _CreateTaskInput } from '../../dashboard/TaskAPI.js';
import { ProjectAPI } from '../../dashboard/ProjectAPI.js';
import { TaskDuplicateDetector } from './helpers/TaskDuplicateDetector.js';

const taskAPI = new TaskAPI();
const projectAPI = new ProjectAPI();


interface ReviewFailureTasksConfig {
  
  pmDecisionVariable: string;
  
  
  reviewType: 'code_review' | 'security_review' | 'qa' | 'devops';
  
  
  urgentPriorityScore?: number;
  
  
  deferredPriorityScore?: number;
  
  
  createDeferredTasks?: boolean;
  
  
  backlogMilestoneSlug?: string;
}


export class ReviewFailureTasksStep extends WorkflowStep {
  
  private static readonly REVIEW_TYPE_LABELS: Record<string, string> = {
    'code_review': 'Code Review',
    'security_review': 'Security Review',
    'qa': 'QA',
    'devops': 'DevOps'
  };

  async execute(context: WorkflowContext): Promise<StepResult> {
    const config = this.config.config as ReviewFailureTasksConfig;
    const startTime = Date.now();
    
    try {
      logger.info('Creating review failure follow-up tasks', {
        stepName: this.config.name,
        reviewType: config.reviewType,
        pmDecisionVariable: config.pmDecisionVariable
      });
      
      
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
      
      
      const existingTasks = await projectAPI.fetchProjectTasks(projectId);
      logger.debug('Fetched existing tasks for duplicate detection', {
        stepName: this.config.name,
        existingTasksCount: existingTasks.length
      });
      
      
      let urgentTasksCreated = 0;
      let deferredTasksCreated = 0;
      let skippedDuplicates = 0;
      
      
      if (pmDecision.follow_up_tasks.length > 0) {
        for (const followUpTask of pmDecision.follow_up_tasks) {
          const isUrgent = ['critical', 'high'].includes(followUpTask.priority?.toLowerCase() || '');
          
          try {
            
            
            
            
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
            
            
            if (this.isDuplicateTask(followUpTask, existingTasks, taskTitle)) {
              skippedDuplicates++;
              logger.info('Skipping duplicate task', {
                stepName: this.config.name,
                title: taskTitle,
                originalTitle: followUpTask.title
              });
              continue;
            }
            
            
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
                create_milestone_if_missing: !isUrgent
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
  
  
  private isDuplicateTask(followUpTask: any, existingTasks: any[], formattedTitle: string): boolean {
    if (!followUpTask || !existingTasks || existingTasks.length === 0) {
      return false;
    }
    
    
    const detector = new TaskDuplicateDetector();
    
    
    const taskForDetection = {
      title: formattedTitle,
      description: followUpTask.description || '',
      external_id: followUpTask.external_id,
      milestone_id: followUpTask.milestone_id
    };
    
    
    const result = detector.findDuplicateWithDetails(
      taskForDetection,
      existingTasks,
      'title_and_milestone'
    );
    
    if (result && result.matchScore >= 50) {
      logger.debug('Duplicate task detected', {
        newTitle: followUpTask.title,
        formattedTitle: formattedTitle,
        existingTitle: result.duplicate.title,
        matchScore: result.matchScore,
        titleOverlap: result.titleOverlap,
        descriptionOverlap: result.descriptionOverlap,
        existingTaskId: result.duplicate.id
      });
      return true;
    }
    
    return false;
  }
  
  
  private formatTaskTitle(title: string, reviewType: string, isUrgent: boolean): string {
    const prefix = isUrgent ? '🚨 URGENT' : '📋';
    const reviewLabel = ReviewFailureTasksStep.REVIEW_TYPE_LABELS[reviewType] || reviewType;
    
    
    if (title.toLowerCase().includes(reviewLabel.toLowerCase())) {
      return `${prefix} ${title}`;
    }
    
    return `${prefix} [${reviewLabel}] ${title}`;
  }
  
  
  private formatTaskDescription(
    description: string,
    pmDecision: any,
    reviewType: string,
    parentTaskId?: string
  ): string {
    const reviewLabel = ReviewFailureTasksStep.REVIEW_TYPE_LABELS[reviewType] || reviewType;
    
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
  
  async validate(_context: WorkflowContext): Promise<ValidationResult> {
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
