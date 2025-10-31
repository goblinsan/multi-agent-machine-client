/**
 * Task Priority Calculator
 * 
 * Handles priority score calculation and mapping for tasks.
 * Supports custom priority mappings and converts priority strings to numeric scores.
 */

export type TaskPriority = 'critical' | 'high' | 'medium' | 'low';

export interface PriorityMapping {
  critical: number;
  high: number;
  medium: number;
  low: number;
}

/**
 * Default priority mapping used across the system
 */
export const DEFAULT_PRIORITY_MAPPING: PriorityMapping = {
  critical: 1500,
  high: 1200,
  medium: 800,
  low: 50
};

/**
 * TaskPriorityCalculator handles all priority-related calculations
 */
export class TaskPriorityCalculator {
  private priorityMapping: PriorityMapping;

  constructor(priorityMapping?: Partial<PriorityMapping>) {
    this.priorityMapping = {
      ...DEFAULT_PRIORITY_MAPPING,
      ...priorityMapping
    };
  }

  /**
   * Convert priority string to numeric priority score
   * 
   * @param priority - Priority level (critical, high, medium, low)
   * @returns Priority score (1500 for critical, 1200 for high, 800 for medium, 50 for low)
   */
  calculateScore(priority?: TaskPriority): number {
    if (!priority) {
      return 500;
    }

    return this.priorityMapping[priority] ?? 500;
  }

  /**
   * Check if a priority level is considered urgent (critical or high)
   * 
   * @param priority - Priority level
   * @returns True if priority is critical or high
   */
  isUrgent(priority?: TaskPriority): boolean {
    return priority === 'critical' || priority === 'high';
  }

  /**
   * Check if a priority score indicates urgency (>= 1000)
   * 
   * @param score - Priority score
   * @returns True if score indicates urgent task
   */
  isUrgentByScore(score: number): boolean {
    return score >= 1000;
  }

  /**
   * Get the priority mapping being used
   */
  getPriorityMapping(): PriorityMapping {
    return { ...this.priorityMapping };
  }

  /**
   * Infer task type from title and calculate adjusted priority
   * Used in behavior tests
   * 
   * @param title - Task title
   * @param priority - Base priority
   * @returns Adjusted priority score
   */
  calculateWithTitleInference(title: string, priority?: TaskPriority): number {
    if (!this.isUrgent(priority)) {
      return 50;
    }

    const type = this.inferTaskType(title);
    
    switch (type) {
      case 'qa':
        return 1200;
      case 'code':
      case 'security':
      case 'devops':
        return 1000;
      default:
        return 1000;
    }
  }

  /**
   * Infer task type from title markers
   * 
   * @param title - Task title
   * @returns Task type
   */
  private inferTaskType(title: string): 'qa' | 'code' | 'security' | 'devops' | 'other' {
    const lowerTitle = title.toLowerCase();
    
    if (lowerTitle.includes('[qa]')) return 'qa';
    if (lowerTitle.includes('[code]')) return 'code';
    if (lowerTitle.includes('[security]')) return 'security';
    if (lowerTitle.includes('[devops]')) return 'devops';
    
    return 'other';
  }

  /**
   * Add title prefix based on urgency
   * 
   * @param title - Original title
   * @param isUrgent - Whether task is urgent
   * @returns Title with appropriate prefix
   */
  addTitlePrefix(title: string, isUrgent: boolean): string {
    if (isUrgent) {
      return /^🚨/.test(title) ? title : `🚨 ${title}`;
    }
    return /^📋/.test(title) ? title : `📋 ${title}`;
  }
}
