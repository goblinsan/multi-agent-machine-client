import type { PMDecision } from './DecisionParser';
import { logger } from '../../../logger.js';

/**
 * Normalizes and validates PM decisions
 */
export class DecisionNormalizer {
  /**
   * Normalize priority string to standard values
   */
  normalizePriority(priority: any): 'critical' | 'high' | 'medium' | 'low' {
    const p = String(priority).toLowerCase();
    if (p.includes('critical') || p.includes('severe')) return 'critical';
    if (p.includes('high') || p.includes('urgent')) return 'high';
    if (p.includes('low') || p.includes('minor')) return 'low';
    return 'medium';
  }

  /**
   * Normalize decision (ensure consistency)
   */
  normalizeDecision(decision: PMDecision, reviewType?: string, warnings?: string[]): PMDecision {
    // Ensure decision value is valid
    if (decision.decision !== 'immediate_fix' && decision.decision !== 'defer') {
      logger.warn('Invalid decision value, defaulting to defer', {
        originalDecision: decision.decision
      });
      decision.decision = 'defer';
    }

    // Ensure arrays are initialized
    decision.immediate_issues = decision.immediate_issues || [];
    decision.deferred_issues = decision.deferred_issues || [];
    decision.follow_up_tasks = decision.follow_up_tasks || [];

    // Validate immediate_fix decision has follow-up tasks
    if (decision.decision === 'immediate_fix' && decision.follow_up_tasks.length === 0) {
      const msg = 'PM set immediate_fix=true but provided no tasks';
      logger.warn('PM decision is immediate_fix but no follow_up_tasks provided - defaulting to defer', {
        reviewType,
        immediateIssues: decision.immediate_issues.length,
        deferredIssues: decision.deferred_issues.length
      });
      if (warnings) warnings.push(msg);
      decision.decision = 'defer';
    }

    // Normalize task priorities and add validation
    decision.follow_up_tasks = decision.follow_up_tasks.map(task => {
      const normalizedPriority = this.normalizePriority(task.priority);
      
      // Log priority validation (QA=1200, others=1000 for urgent)
      if (reviewType === 'qa' && (normalizedPriority === 'critical' || normalizedPriority === 'high')) {
        logger.debug('QA review urgent task will receive priority 1200', {
          taskTitle: task.title,
          priority: normalizedPriority
        });
      } else if (normalizedPriority === 'critical' || normalizedPriority === 'high') {
        logger.debug('Review urgent task will receive priority 1000', {
          reviewType,
          taskTitle: task.title,
          priority: normalizedPriority
        });
      }
      
      return {
        ...task,
        priority: normalizedPriority
      };
    });

    // Apply review-type-specific logic
    if (reviewType === 'security_review' && !decision.detected_stage) {
      decision.detected_stage = this.inferStage(decision);
    }

    return decision;
  }

  /**
   * Infer development stage from decision context
   */
  private inferStage(decision: PMDecision): 'early' | 'beta' | 'production' {
    const reasoningLower = decision.reasoning.toLowerCase();
    
    if (reasoningLower.includes('production') || reasoningLower.includes('release')) {
      return 'production';
    }
    if (reasoningLower.includes('beta') || reasoningLower.includes('testing')) {
      return 'beta';
    }
    return 'early';
  }
}
