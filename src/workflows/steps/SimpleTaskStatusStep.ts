import { WorkflowStep, StepResult, ValidationResult, WorkflowStepConfig } from '../engine/WorkflowStep.js';
import { WorkflowContext } from '../engine/WorkflowContext.js';
import { logger } from '../../logger.js';

interface SimpleTaskStatusConfig {
  status: string;
}

/**
 * SimpleTaskStatusStep - Simple task status update compatible with tests
 * This step directly calls dashboard.updateTaskStatus as expected by legacy tests
 */
export class SimpleTaskStatusStep extends WorkflowStep {
  async execute(context: WorkflowContext): Promise<StepResult> {
    const config = this.config.config as SimpleTaskStatusConfig;
    const { status } = config;

    logger.info(`Updating task status via simple method`, {
      workflowId: context.workflowId,
      status
    });

    try {
      // Get task data from context
      const task = context.getVariable('task');
      if (!task) {
        throw new Error('No task data found in context for update');
      }

      const taskId = task.id || task.taskId;
      if (!taskId) {
        throw new Error('Task ID not found in task data');
      }

      // Import dashboard function dynamically
      const { updateTaskStatus } = await import('../../dashboard.js');
      
      logger.info('Calling dashboard.updateTaskStatus', {
        taskId,
        status,
        workflowId: context.workflowId
      });
      
      // Call the dashboard function directly (this is what tests expect)
      await updateTaskStatus(taskId, status);
      
      // Cleanup task logs if the task is completed
      const normalizedStatus = status.toLowerCase();
      if (['done', 'completed', 'finished', 'closed', 'resolved'].includes(normalizedStatus)) {
        const repoRoot = context.getVariable('effective_repo_path') || context.getVariable('repo_root');
        const branch = context.getVariable('branch');
        const taskTitle = task.title || task.name;
        
        if (repoRoot) {
          try {
            const { cleanupTaskLogs } = await import('../../taskLogCleanup.js');
            await cleanupTaskLogs({
              repoRoot,
              taskId,
              taskTitle,
              branch: branch || null
            });
            logger.info('Task logs cleaned up after completion', {
              taskId,
              workflowId: context.workflowId
            });
          } catch (cleanupErr: any) {
            // Don't fail the task update if cleanup fails
            logger.warn('Task log cleanup failed', {
              taskId,
              workflowId: context.workflowId,
              error: cleanupErr?.message || String(cleanupErr)
            });
          }
        }
      }
      
      // Set completion variables in context
      context.setVariable('taskStatus', status);
      context.setVariable('taskCompleted', true);
      context.setVariable('taskId', taskId);

      logger.info(`Task status updated successfully`, {
        taskId,
        status,
        workflowId: context.workflowId
      });

      return {
        status: 'success',
        data: {
          taskId,
          status,
          updatedAt: new Date().toISOString()
        },
        outputs: {
          taskStatus: status,
          taskCompleted: true,
          taskId
        }
      };

    } catch (error: any) {
      logger.error(`Simple task status update failed`, {
        workflowId: context.workflowId,
        status,
        error: error.message
      });

      return {
        status: 'failure',
        error: new Error(error.message),
        data: { status }
      };
    }
  }

  protected async validateConfig(context: WorkflowContext): Promise<ValidationResult> {
    const errors: string[] = [];
    const config = this.config.config as SimpleTaskStatusConfig;

    if (!config.status || typeof config.status !== 'string') {
      errors.push('SimpleTaskStatusStep: status is required and must be a string');
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings: []
    };
  }
}