import type { PMDecision } from './DecisionParser';


export class PriorityMapper {
  
  applyPriorityAndMilestoneRouting(
    decision: PMDecision,
    reviewType: string | undefined,
    ctx: any,
    warnings: string[]
  ): PMDecision {
    const parentMilestone = ctx.parent_task_milestone_id || ctx.milestone_id;
    const backlogMilestone = ctx.backlog_milestone_id || ctx.backlog_milestone || 'backlog-milestone';

    const urgentPriority = (title: string, prio: string) => {
      const p = prio.toLowerCase();
      const isUrgent = p === 'critical' || p === 'high';
      if (!isUrgent) return null;
      
      if (reviewType === 'qa' || /\[qa\]/i.test(title)) return 1200;
      return 1000;
    };

    const routed = {
      ...decision,
      follow_up_tasks: (decision.follow_up_tasks || []).map(task => {
        const title = task.title || '';
        const p = String(task.priority).toLowerCase();
        const urgent = urgentPriority(title, p);
        let numericPriority = urgent ?? (p === 'medium' || p === 'low' ? 50 : 50);

        let milestone_id: string | null = null;
        if (urgent != null) {
          if (parentMilestone) {
            milestone_id = parentMilestone;
          } else {
            milestone_id = backlogMilestone;
            warnings.push('Parent milestone not found - routing urgent task to backlog');
          }
        } else {
          milestone_id = backlogMilestone;
        }

        return {
          ...task,
          priority: numericPriority as any,
          milestone_id,
          assignee_persona: 'implementation-planner'
        };
      })
    };

    return routed;
  }
}
