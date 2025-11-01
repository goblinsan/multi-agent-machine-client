import { WorkflowEngine } from "../WorkflowEngine.js";


export class WorkflowSelector {
  
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
    
    return 'feature';
  }

  
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

  
  selectWorkflowForTask(
    engine: WorkflowEngine,
    task: any
  ): { workflow: any; reason: string } | null {
    const taskType = this.determineTaskType(task);
    const scope = this.determineTaskScope(task);
    const taskStatus = task?.status?.toLowerCase() || 'unknown';
    
    
    if (taskStatus === 'blocked' || taskStatus.includes('stuck')) {
      const blockedWorkflow = engine.getWorkflowDefinition('blocked-task-resolution');
      if (blockedWorkflow) {
        return {
          workflow: blockedWorkflow,
          reason: 'blocked-task'
        };
      }
    }
    
    
    if (taskStatus === 'in_review' || taskStatus.includes('review')) {
      const reviewWorkflow = engine.getWorkflowDefinition('in-review-task-flow');
      if (reviewWorkflow) {
        return {
          workflow: reviewWorkflow,
          reason: 'in-review-task'
        };
      }
    }
    
    const matchedWorkflow = engine.findWorkflowByCondition(taskType, scope);
    if (matchedWorkflow) {
      return {
        workflow: matchedWorkflow,
        reason: 'matched-condition'
      };
    }
    
    const fallbackWorkflow = engine.getWorkflowDefinition('task-flow');
    if (fallbackWorkflow) {
      return {
        workflow: fallbackWorkflow,
        reason: 'fallback'
      };
    }
    
    return null;
  }

  
  computeFeatureBranchName(task: any, projectSlug: string): string {
    
    
    
    
    
    
    
    const milestone = task?.milestone;
    const milestoneSlug = task?.milestone?.slug || task?.milestone_slug || null;
    const taskSlug = task?.slug || task?.task_slug || null;
    
    
    const fromMilestone = milestone?.branch || milestone?.branch_name || milestone?.branchName;
    if (fromMilestone && typeof fromMilestone === 'string' && fromMilestone.trim()) {
      return fromMilestone.trim();
    }
    
    
    const fromTask = task?.branch || task?.branch_name || task?.branchName;
    if (fromTask && typeof fromTask === 'string' && fromTask.trim()) {
      return fromTask.trim();
    }
    
    
    if (milestoneSlug && typeof milestoneSlug === 'string' && milestoneSlug.trim() && milestoneSlug !== 'milestone') {
      return `milestone/${milestoneSlug}`;
    }
    
    
    if (taskSlug && typeof taskSlug === 'string' && taskSlug.trim()) {
      return `feat/${taskSlug}`;
    }
    
    
    return `milestone/${projectSlug}`;
  }
}
