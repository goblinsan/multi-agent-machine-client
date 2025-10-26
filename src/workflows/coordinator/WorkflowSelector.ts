import { WorkflowEngine } from "../WorkflowEngine.js";

/**
 * Helper class for workflow selection and task type/scope determination
 */
export class WorkflowSelector {
  /**
   * Determine task type from task data
   */
  determineTaskType(task: any): string {
    const taskType = task?.type || task?.task_type;
    if (taskType) return String(taskType).toLowerCase();
    
    const title = String(task?.title || task?.name || task?.summary || '').toLowerCase();
    const description = String(task?.description || '').toLowerCase();
    const combined = `${title} ${description}`;
    
    if (combined.includes('bug') || combined.includes('fix') || combined.includes('error') || combined.includes('issue')) {
      return 'bug';
    }
    
    if (combined.includes('feature') || combined.includes('implement') || combined.includes('add')) {
      return 'feature';
    }
    
    if (combined.includes('refactor') || combined.includes('improve') || combined.includes('optimize')) {
      return 'refactor';
    }
    
    if (combined.includes('test') || combined.includes('spec')) {
      return 'test';
    }
    
    if (combined.includes('doc') || combined.includes('readme')) {
      return 'documentation';
    }
    
    return 'feature'; // Default to feature
  }

  /**
   * Determine task scope from task data
   */
  determineTaskScope(task: any): string {
    const scope = task?.scope;
    if (scope) return String(scope).toLowerCase();
    
    const title = String(task?.title || task?.name || task?.summary || '').toLowerCase();
    const description = String(task?.description || '').toLowerCase();
    const content = `${title} ${description}`;
    
    if (content.includes('large') || content.includes('complex') || content.includes('major')) {
      return 'large';
    }
    
    if (content.includes('small') || content.includes('minor') || content.includes('quick') || content.includes('simple')) {
      return 'small';
    }
    
    return 'medium';
  }

  /**
   * Select workflow for a task based on its status and characteristics
   */
  selectWorkflowForTask(
    engine: WorkflowEngine,
    task: any
  ): { workflow: any; reason: string } | null {
    const taskType = this.determineTaskType(task);
    const scope = this.determineTaskScope(task);
    const taskStatus = task?.status?.toLowerCase() || 'unknown';
    
    // Check if task is blocked - route to blocked task resolution workflow
    if (taskStatus === 'blocked' || taskStatus.includes('stuck')) {
      const blockedWorkflow = engine.getWorkflowDefinition('blocked-task-resolution');
      if (blockedWorkflow) {
        return {
          workflow: blockedWorkflow,
          reason: 'blocked-task'
        };
      }
    }
    
    // Check if task is in review - route to in-review workflow (skips implementation steps)
    if (taskStatus === 'in_review' || taskStatus.includes('review')) {
      const reviewWorkflow = engine.getWorkflowDefinition('in-review-task-flow');
      if (reviewWorkflow) {
        return {
          workflow: reviewWorkflow,
          reason: 'in-review-task'
        };
      }
    }
    
    // Find workflow by condition (type and scope)
    const matchedWorkflow = engine.findWorkflowByCondition(taskType, scope);
    if (matchedWorkflow) {
      return {
        workflow: matchedWorkflow,
        reason: 'matched-condition'
      };
    }
    
    // Fallback to project-loop workflow
    const fallbackWorkflow = engine.getWorkflowDefinition('project-loop');
    if (fallbackWorkflow) {
      return {
        workflow: fallbackWorkflow,
        reason: 'fallback'
      };
    }
    
    return null;
  }

  /**
   * Compute feature branch name based on task/milestone information
   * Uses same logic as branchUtils.buildBranchName
   */
  computeFeatureBranchName(task: any, projectSlug: string): string {
    // Priority:
    // 1) Explicit milestone.branch
    // 2) Explicit task.branch
    // 3) milestone/{milestone_slug} if available
    // 4) feat/{task_slug} if available
    // 5) milestone/{projectSlug} as fallback
    
    const milestone = task?.milestone;
    const milestoneSlug = task?.milestone?.slug || task?.milestone_slug || null;
    const taskSlug = task?.slug || task?.task_slug || null;
    
    // Check for explicit branch name from milestone
    const fromMilestone = milestone?.branch || milestone?.branch_name || milestone?.branchName;
    if (fromMilestone && typeof fromMilestone === 'string' && fromMilestone.trim()) {
      return fromMilestone.trim();
    }
    
    // Check for explicit branch name from task
    const fromTask = task?.branch || task?.branch_name || task?.branchName;
    if (fromTask && typeof fromTask === 'string' && fromTask.trim()) {
      return fromTask.trim();
    }
    
    // Use milestone slug if available and not generic
    if (milestoneSlug && typeof milestoneSlug === 'string' && milestoneSlug.trim() && milestoneSlug !== 'milestone') {
      return `milestone/${milestoneSlug}`;
    }
    
    // Use task slug if available
    if (taskSlug && typeof taskSlug === 'string' && taskSlug.trim()) {
      return `feat/${taskSlug}`;
    }
    
    // Fallback to project-based milestone branch
    return `milestone/${projectSlug}`;
  }
}
