import { WorkflowStep, StepResult, ValidationResult } from '../engine/WorkflowStep.js';
import { WorkflowContext } from '../engine/WorkflowContext.js';
import { logger } from '../../logger.js';
import { TaskAPI } from '../../dashboard/TaskAPI.js';

const taskAPI = new TaskAPI();

interface SimpleTaskStatusConfig {
  status: string;
}


export class SimpleTaskStatusStep extends WorkflowStep {
  async execute(context: WorkflowContext): Promise<StepResult> {
    const config = this.config.config as SimpleTaskStatusConfig;
    const { status } = config;

    logger.info(`Updating task status via simple method`, {
      workflowId: context.workflowId,
      status
    });

    try {
      
      const task = context.getVariable('task');
      if (!task) {
        throw new Error('No task data found in context for update');
      }

      const taskId = task.id || task.taskId;
      if (!taskId) {
        throw new Error('Task ID not found in task data');
      }

      
      const projectId = context.getVariable('projectId') || context.getVariable('project_id');
      
      logger.info('Calling TaskAPI.updateTaskStatus', {
        taskId,
        status,
        projectId,
        workflowId: context.workflowId
      });
      
      
      await taskAPI.updateTaskStatus(taskId, status, projectId);
      
      
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
            
            logger.warn('Task log cleanup failed', {
              taskId,
              workflowId: context.workflowId,
              error: cleanupErr?.message || String(cleanupErr)
            });
          }
        }
      }
      
      
  context.setVariable('taskStatus', status);
  
  context.setVariable('task_status', status);
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
          task_status: status,
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

  protected async validateConfig(_context: WorkflowContext): Promise<ValidationResult> {
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