import { WorkflowStep, StepResult } from '../engine/WorkflowStep.js';
import { WorkflowContext } from '../engine/WorkflowContext.js';
import { logger } from '../../logger.js';

interface BlockedTaskAnalysisConfig {
  task_id: string;
  project_id: string;
  repo_root: string;
  branch: string;
}

interface BlockageAnalysis {
  reason: string;
  failed_step?: string;
  error_message?: string;
  previous_attempts: Array<{
    attempt_number: number;
    timestamp: number;
    failed_at: string;
    error: string;
  }>;
  context_hints: string[];
}

/**
 * BlockedTaskAnalysisStep - Analyzes why a task was blocked
 * 
 * This step:
 * 1. Retrieves task history from Redis/context
 * 2. Identifies the step that caused the blockage
 * 3. Extracts error messages and context
 * 4. Compiles previous unblock attempts
 * 5. Provides hints for resolution
 * 
 * Outputs:
 * - blockage_analysis: Detailed analysis of why task is blocked
 */
export class BlockedTaskAnalysisStep extends WorkflowStep {
  async execute(context: WorkflowContext): Promise<StepResult> {
    const config = this.config.config as BlockedTaskAnalysisConfig;
    const { task_id, project_id, repo_root, branch } = config;

    logger.info('Analyzing blocked task', {
      workflowId: context.workflowId,
      taskId: task_id,
      projectId: project_id
    });

    try {
      const task = context.getVariable('task');
      
      // Initialize analysis structure
      const analysis: BlockageAnalysis = {
        reason: 'Unknown blockage',
        previous_attempts: [],
        context_hints: []
      };

      // Extract blockage info from task metadata
      if (task?.blocked_reason) {
        analysis.reason = task.blocked_reason;
      }

      if (task?.failed_step) {
        analysis.failed_step = task.failed_step;
      }

      if (task?.error_message || task?.error) {
        analysis.error_message = task.error_message || task.error;
      }

      // Check for workflow failure information in context
      const workflowError = context.getVariable('workflow_error');
      const failedStep = context.getVariable('failed_step');
      
      if (workflowError) {
        analysis.error_message = analysis.error_message || String(workflowError);
      }
      
      if (failedStep) {
        analysis.failed_step = analysis.failed_step || String(failedStep);
      }

      // Extract previous attempt history
      const attemptCount = task?.blocked_attempt_count || 0;
      const attemptHistory = task?.blocked_attempt_history || [];
      
      if (Array.isArray(attemptHistory)) {
        analysis.previous_attempts = attemptHistory;
      }

      // Note: Querying workflow events from transport would require xRange,
      // which is not part of the MessageTransport interface. This is optional
      // enrichment that can be added if needed.
      // For now, analysis relies on context variables and task history.

      // Generate context hints based on failure patterns
      analysis.context_hints = this.generateContextHints(analysis);

      // Store analysis in context for other steps
      context.setVariable('blockage_analysis', analysis);

      logger.info('Completed blockage analysis', {
        workflowId: context.workflowId,
        taskId: task_id,
        reason: analysis.reason,
        failedStep: analysis.failed_step,
        previousAttempts: analysis.previous_attempts.length,
        hints: analysis.context_hints.length
      });

      return {
        status: 'success',
        data: { analysis },
        outputs: { blockage_analysis: analysis }
      };

    } catch (error: any) {
      logger.error('Failed to analyze blocked task', {
        error: error.message,
        taskId: task_id,
        workflowId: context.workflowId
      });

      return {
        status: 'failure',
        error: new Error(`Failed to analyze blockage: ${error.message}`)
      };
    }
  }

  /**
   * Generate helpful hints based on failure patterns
   */
  private generateContextHints(analysis: BlockageAnalysis): string[] {
    const hints: string[] = [];

    // Check for common failure patterns
    if (analysis.failed_step?.includes('context')) {
      hints.push('Context scan may have failed - check repository access');
      hints.push('Verify PROJECT_BASE directory permissions');
    }

    if (analysis.failed_step?.includes('qa')) {
      hints.push('QA validation failed - check test execution');
      hints.push('Review test logs for specific failures');
    }

    if (analysis.failed_step?.includes('implementation')) {
      hints.push('Implementation step failed - review code generation');
      hints.push('Check for compilation or linting errors');
    }

    if (analysis.failed_step?.includes('push') || analysis.error_message?.includes('push')) {
      hints.push('Git push failed - check remote access and branch protection');
      hints.push('Verify git credentials are configured');
    }

    if (analysis.error_message?.includes('timeout')) {
      hints.push('Operation timed out - may need longer timeout or optimization');
    }

    if (analysis.error_message?.includes('permission')) {
      hints.push('Permission error - check file/directory permissions');
      hints.push('Verify git remote access credentials');
    }

    // Check for repeated failures
    if (analysis.previous_attempts.length > 0) {
      const recentFailures = analysis.previous_attempts.slice(-3);
      const sameError = recentFailures.every(a => a.error === analysis.error_message);
      
      if (sameError) {
        hints.push('Same error repeated multiple times - may need different approach');
        hints.push('Consider breaking down into smaller tasks');
      }
    }

    return hints;
  }
}
