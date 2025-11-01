import {
  WorkflowStep,
  StepResult,
  ValidationResult,
  WorkflowStepConfig,
} from "../engine/WorkflowStep.js";
import { WorkflowContext } from "../engine/WorkflowContext.js";
import { logger } from "../../logger.js";
import { TaskGenerator, TaskDefinition } from "./task/TaskGenerator.js";
import { TaskFilterPrioritizer } from "./task/TaskFilterPrioritizer.js";
import { TaskGrouper } from "./task/TaskGrouper.js";

interface TaskCreationConfig {
  dataSource?: "qa-analysis" | "plan-evaluation" | "context" | "all";

  maxTasks?: number;

  highPriorityOnly?: boolean;

  groupRelatedIssues?: boolean;

  priorityStrategy?:
    | "severity-based"
    | "impact-based"
    | "effort-based"
    | "balanced";

  includeEffortEstimates?: boolean;

  createSubtasks?: boolean;

  taskTemplates?: Record<
    string,
    {
      title: string;
      description: string;
      labels?: string[];
      estimatedHours?: number;
    }
  >;

  minConfidenceThreshold?: number;

  assignToPersonas?: boolean;
}

interface TaskCreationResult {
  tasksCreated: number;
  tasksByPriority: {
    critical: number;
    high: number;
    medium: number;
    low: number;
  };
  tasksByCategory: Record<string, number>;
  skippedIssues: Array<{
    reason: string;
    sourceData: any;
  }>;
  recommendations: string[];
  summary: string;
}

export class TaskCreationStep extends WorkflowStep {
  private taskGenerator: TaskGenerator;
  private taskFilterPrioritizer: TaskFilterPrioritizer;
  private taskGrouper: TaskGrouper;

  constructor(config: WorkflowStepConfig) {
    super(config);
    this.taskGenerator = new TaskGenerator();
    this.taskFilterPrioritizer = new TaskFilterPrioritizer();
    this.taskGrouper = new TaskGrouper();
  }

  async execute(context: WorkflowContext): Promise<StepResult> {
    const config = this.config.config as TaskCreationConfig;
    const startTime = Date.now();

    try {
      logger.info("Starting task creation", { stepName: this.config.name });

      const sourceData = this.gatherSourceData(context, config);

      const tasks = this.taskGenerator.generateTasks(sourceData, config);

      let finalTasks = this.taskFilterPrioritizer.filterAndPrioritize(
        tasks,
        config,
      );

      if (config.groupRelatedIssues) {
        finalTasks = this.taskGrouper.groupRelatedTasks(finalTasks);
      }

      const result = this.createSummary(finalTasks, tasks);

      logger.info("Task creation completed", {
        stepName: this.config.name,
        tasksCreated: finalTasks.length,
        totalIssuesAnalyzed: tasks.length,
      });

      return {
        status: "success",
        data: {
          tasks: finalTasks,
          result,
        },
        outputs: {
          tasks: finalTasks,
          tasksCreated: finalTasks.length,
          tasksByPriority: result.tasksByPriority,
          tasksByCategory: result.tasksByCategory,
          summary: result.summary,
        },
        metrics: {
          duration_ms: Date.now() - startTime,
          operations_count: finalTasks.length,
        },
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "Unknown error";
      logger.error("Task creation failed", {
        stepName: this.config.name,
        error: errorMessage,
      });

      return {
        status: "failure",
        error: new Error(`Task creation failed: ${errorMessage}`),
        metrics: { duration_ms: Date.now() - startTime },
      };
    }
  }

  protected async validateConfig(
    context: WorkflowContext,
  ): Promise<ValidationResult> {
    const config = this.config.config as TaskCreationConfig;
    const errors: string[] = [];
    const warnings: string[] = [];

    if (config.maxTasks !== undefined && config.maxTasks < 1) {
      errors.push("TaskCreationStep: maxTasks must be at least 1");
    }

    if (
      config.minConfidenceThreshold !== undefined &&
      (config.minConfidenceThreshold < 0 || config.minConfidenceThreshold > 1)
    ) {
      errors.push(
        "TaskCreationStep: minConfidenceThreshold must be between 0 and 1",
      );
    }

    if (config.taskTemplates) {
      for (const [key, template] of Object.entries(config.taskTemplates)) {
        if (!template.title || !template.description) {
          errors.push(
            `TaskCreationStep: Task template '${key}' must have title and description`,
          );
        }
      }
    }

    const dataSource = config.dataSource || "all";
    if (dataSource === "qa-analysis" || dataSource === "all") {
      if (
        !context.hasStepOutput("qa-analysis") &&
        !context.hasStepOutput("qa")
      ) {
        warnings.push(
          "TaskCreationStep: No QA analysis data found. QA-based tasks will not be created.",
        );
      }
    }

    if (dataSource === "plan-evaluation" || dataSource === "all") {
      if (
        !context.hasStepOutput("plan-evaluation") &&
        !context.hasStepOutput("planning")
      ) {
        warnings.push(
          "TaskCreationStep: No plan evaluation data found. Plan-based tasks will not be created.",
        );
      }
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings,
    };
  }

  private gatherSourceData(
    context: WorkflowContext,
    config: TaskCreationConfig,
  ): any[] {
    const sourceData: any[] = [];
    const dataSource = config.dataSource || "all";

    if (dataSource === "qa-analysis" || dataSource === "all") {
      const qaAnalysis = context.getStepOutput("qa-analysis");
      if (qaAnalysis?.analysis) {
        sourceData.push({
          type: "qa-analysis",
          data: qaAnalysis.analysis,
        });
      }

      const qaResults = context.getStepOutput("qa");
      if (qaResults?.qaResults || qaResults?.testResults) {
        sourceData.push({
          type: "qa-results",
          data: qaResults.qaResults || qaResults.testResults,
        });
      }
    }

    if (dataSource === "plan-evaluation" || dataSource === "all") {
      const planEvaluation = context.getStepOutput("plan-evaluation");
      if (planEvaluation?.evaluation) {
        sourceData.push({
          type: "plan-evaluation",
          data: planEvaluation.evaluation,
        });
      }
    }

    if (dataSource === "context" || dataSource === "all") {
      const stepNames = ["code-generation", "implementation", "review"];
      for (const stepName of stepNames) {
        const stepOutput = context.getStepOutput(stepName);
        if (stepOutput) {
          sourceData.push({
            type: "context",
            stepName,
            data: stepOutput,
          });
        }
      }
    }

    return sourceData;
  }

  private createSummary(
    finalTasks: TaskDefinition[],
    allTasks: TaskDefinition[],
  ): TaskCreationResult {
    const tasksByPriority = {
      critical: finalTasks.filter((t) => t.priority === "critical").length,
      high: finalTasks.filter((t) => t.priority === "high").length,
      medium: finalTasks.filter((t) => t.priority === "medium").length,
      low: finalTasks.filter((t) => t.priority === "low").length,
    };

    const tasksByCategory: Record<string, number> = {};
    finalTasks.forEach((task) => {
      tasksByCategory[task.category] =
        (tasksByCategory[task.category] || 0) + 1;
    });

    const skippedIssues = allTasks
      .filter((task) => !finalTasks.some((ft) => ft.id === task.id))
      .map((task) => ({
        reason: task.confidence < 0.3 ? "Low confidence" : "Filtered out",
        sourceData: task.sourceData,
      }));

    const summary = this.generateSummaryText(finalTasks, tasksByPriority);

    return {
      tasksCreated: finalTasks.length,
      tasksByPriority,
      tasksByCategory,
      skippedIssues,
      recommendations: [
        "Review high-priority tasks first",
        "Consider grouping related tasks for efficiency",
        "Update task estimates based on actual effort",
      ],
      summary,
    };
  }

  private generateSummaryText(
    tasks: TaskDefinition[],
    byPriority: any,
  ): string {
    const total = tasks.length;
    const critical = byPriority.critical;
    const high = byPriority.high;

    if (total === 0) {
      return "No tasks created - all issues may have been resolved or filtered out";
    }

    let summary = `Created ${total} task(s) from analysis. `;

    if (critical > 0) {
      summary += `${critical} critical issue(s) require immediate attention. `;
    }

    if (high > 0) {
      summary += `${high} high-priority task(s) should be addressed soon. `;
    }

    const topCategory = Object.entries(
      tasks.reduce(
        (acc, task) => {
          acc[task.category] = (acc[task.category] || 0) + 1;
          return acc;
        },
        {} as Record<string, number>,
      ),
    ).sort(([, a], [, b]) => b - a)[0];

    if (topCategory) {
      summary += `Most issues are related to ${topCategory[0]} (${topCategory[1]} task(s)).`;
    }

    return summary;
  }

  private mapSeverityToPriority(severity: string): TaskDefinition["priority"] {
    switch (severity.toLowerCase()) {
      case "high":
        return "critical";
      case "medium":
        return "high";
      case "low":
        return "medium";
      default:
        return "low";
    }
  }

  private formatTaskDescription(failure: any, type: string): string {
    let description = "";

    if (type === "qa-failure") {
      description = `QA Analysis identified a ${failure.severity} severity issue:\n\n`;
      description += `**Root Cause:** ${failure.rootCause}\n\n`;
      description += `**Suggested Fix:** ${failure.suggestedFix}\n\n`;
      description += `**Pattern:** ${failure.pattern}\n\n`;
      description += `**Confidence:** ${(failure.confidence * 100).toFixed(1)}%`;

      if (failure.relatedFailures && failure.relatedFailures.length > 0) {
        description += `\n\n**Related Issues:** ${failure.relatedFailures.join(", ")}`;
      }
    }

    return description;
  }

  async cleanup(_context: WorkflowContext): Promise<void> {
    logger.debug("Task creation step cleanup completed", {
      stepName: this.config.name,
    });
  }
}
