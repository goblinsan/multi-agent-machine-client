export type TaskPriority = "critical" | "high" | "medium" | "low";

export interface PriorityMapping {
  critical: number;
  high: number;
  medium: number;
  low: number;
}

export const DEFAULT_PRIORITY_MAPPING: PriorityMapping = {
  critical: 1500,
  high: 1200,
  medium: 800,
  low: 50,
};

export class TaskPriorityCalculator {
  private priorityMapping: PriorityMapping;

  constructor(priorityMapping?: Partial<PriorityMapping>) {
    this.priorityMapping = {
      ...DEFAULT_PRIORITY_MAPPING,
      ...priorityMapping,
    };
  }

  calculateScore(priority?: TaskPriority): number {
    if (!priority) {
      return 500;
    }

    return this.priorityMapping[priority] ?? 500;
  }

  isUrgent(priority?: TaskPriority): boolean {
    return priority === "critical" || priority === "high";
  }

  isUrgentByScore(score: number): boolean {
    return score >= 1000;
  }

  getPriorityMapping(): PriorityMapping {
    return { ...this.priorityMapping };
  }

  calculateWithTitleInference(title: string, priority?: TaskPriority): number {
    if (!this.isUrgent(priority)) {
      return 50;
    }

    const type = this.inferTaskType(title);

    switch (type) {
      case "qa":
        return 1200;
      case "code":
      case "security":
      case "devops":
        return 1000;
      default:
        return 1000;
    }
  }

  private inferTaskType(
    title: string,
  ): "qa" | "code" | "security" | "devops" | "other" {
    const lowerTitle = title.toLowerCase();

    if (lowerTitle.includes("[qa]")) return "qa";
    if (lowerTitle.includes("[code]")) return "code";
    if (lowerTitle.includes("[security]")) return "security";
    if (lowerTitle.includes("[devops]")) return "devops";

    return "other";
  }

  addTitlePrefix(title: string, isUrgent: boolean): string {
    if (isUrgent) {
      return /^🚨/.test(title) ? title : `🚨 ${title}`;
    }
    return /^📋/.test(title) ? title : `📋 ${title}`;
  }
}
