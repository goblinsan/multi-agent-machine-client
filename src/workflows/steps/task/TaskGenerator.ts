import { logger } from "../../../logger.js";

export interface TaskDefinition {
  id: string;
  title: string;
  description: string;
  priority: "critical" | "high" | "medium" | "low";
  category: string;
  estimatedHours?: number;
  confidence: number;
  assignedPersona?: string;
  labels: string[];
  subtasks?: TaskDefinition[];
  sourceData: {
    type:
      | "qa-failure"
      | "plan-issue"
      | "coverage-gap"
      | "recommendation"
      | "manual";
    sourceId: string;
    confidence: number;
  };
  dependencies?: string[];
  acceptanceCriteria: string[];
}

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

export class TaskGenerator {
  private static readonly DEFAULT_TEMPLATES = {
    "syntax-error": {
      title: "Fix syntax error in {file}",
      description: "Syntax error detected:\n{error}\n\nLocation: {location}",
      labels: ["bug", "syntax"],
      estimatedHours: 0.5,
    },
    "type-error": {
      title: "Resolve type error in {file}",
      description:
        "Type mismatch:\n{error}\n\nExpected: {expected}\nActual: {actual}",
      labels: ["bug", "typing"],
      estimatedHours: 1,
    },
    "test-failure": {
      title: "Fix failing test: {testName}",
      description: "Test failure:\n{error}\n\nTest: {testName}\nFile: {file}",
      labels: ["test", "bug"],
      estimatedHours: 2,
    },
    "coverage-gap": {
      title: "Add test coverage for {component}",
      description:
        "Coverage gap detected in {component}\n\nCurrent coverage: {coverage}%\nTarget: 80%",
      labels: ["testing", "coverage"],
      estimatedHours: 3,
    },
  };

  generateTasks(
    sourceData: any[],
    config: TaskCreationConfig,
  ): TaskDefinition[] {
    const tasks: TaskDefinition[] = [];
    let taskCounter = 0;

    for (const source of sourceData) {
      switch (source.type) {
        case "qa-analysis":
          tasks.push(
            ...this.generateQAAnalysisTasks(source.data, config, taskCounter),
          );
          taskCounter = tasks.length;
          break;

        case "qa-results":
          tasks.push(
            ...this.generateQAResultsTasks(source.data, config, taskCounter),
          );
          taskCounter = tasks.length;
          break;

        case "plan-evaluation":
          tasks.push(
            ...this.generatePlanEvaluationTasks(
              source.data,
              config,
              taskCounter,
            ),
          );
          taskCounter = tasks.length;
          break;

        case "context":
          tasks.push(
            ...this.generateContextTasks(
              source.data,
              source.stepName,
              config,
              taskCounter,
            ),
          );
          taskCounter = tasks.length;
          break;
      }
    }

    logger.info("Tasks generated from source data", {
      totalTasks: tasks.length,
      sourceTypes: sourceData.map((s) => s.type),
    });

    return tasks;
  }

  private generateQAAnalysisTasks(
    analysis: any,
    config: TaskCreationConfig,
    startId: number,
  ): TaskDefinition[] {
    const tasks: TaskDefinition[] = [];

    const failures = analysis.failureAnalyses || analysis.failures;
    if (failures && Array.isArray(failures)) {
      for (let i = 0; i < failures.length; i++) {
        const failure = failures[i];
        const taskId = `qa-failure-${startId + i}`;

        const task: TaskDefinition = {
          id: taskId,
          title: `Fix ${failure.category || "test"} issue: ${failure.pattern || "Unknown"}`,
          description: this.formatTaskDescription(failure, "qa-failure"),
          priority: this.mapSeverityToPriority(failure.severity || "medium"),
          category: failure.category || "qa",
          confidence: failure.confidence || 0.7,
          labels: [
            "qa",
            failure.category || "test",
            failure.severity || "medium",
          ],
          sourceData: {
            type: "qa-failure",
            sourceId: taskId,
            confidence: failure.confidence || 0.7,
          },
          acceptanceCriteria: [
            "Test passes consistently",
            "No regression in related tests",
            "Root cause is addressed",
          ],
        };

        if (config.includeEffortEstimates && failure.estimatedHours) {
          task.estimatedHours = failure.estimatedHours;
        }

        if (config.assignToPersonas) {
          task.assignedPersona = "lead-engineer";
        }

        tasks.push(task);
      }
    }

    if (analysis.recommendations && Array.isArray(analysis.recommendations)) {
      for (let i = 0; i < analysis.recommendations.length; i++) {
        const rec = analysis.recommendations[i];
        const taskId = `qa-recommendation-${startId + tasks.length + i}`;

        tasks.push({
          id: taskId,
          title: rec.title || `QA Recommendation ${i + 1}`,
          description: rec.description || rec,
          priority: rec.priority || "medium",
          category: "improvement",
          confidence: 0.6,
          labels: ["qa", "recommendation"],
          sourceData: {
            type: "recommendation",
            sourceId: taskId,
            confidence: 0.6,
          },
          acceptanceCriteria: [
            "Recommendation is implemented",
            "QA metrics improved",
          ],
        });
      }
    }

    return tasks;
  }

  private generateQAResultsTasks(
    qaResults: any,
    config: TaskCreationConfig,
    startId: number,
  ): TaskDefinition[] {
    const tasks: TaskDefinition[] = [];

    if (qaResults.failures && Array.isArray(qaResults.failures)) {
      for (let i = 0; i < qaResults.failures.length; i++) {
        const failure = qaResults.failures[i];
        const taskId = `qa-test-failure-${startId + i}`;

        tasks.push({
          id: taskId,
          title: `Fix failing test: ${failure.testName || failure.name || "Unknown test"}`,
          description: `Test failure detected:\n\n**Error:** ${failure.error || failure.message || "Unknown error"}\n\n**File:** ${failure.file || "Unknown"}\n\n**Stack:** ${failure.stack || "N/A"}`,
          priority: "high",
          category: "test-failure",
          confidence: 0.9,
          labels: ["qa", "test-failure", "bug"],
          sourceData: {
            type: "qa-failure",
            sourceId: taskId,
            confidence: 0.9,
          },
          acceptanceCriteria: ["Test passes", "Fix is verified"],
        });
      }
    }

    return tasks;
  }

  private generatePlanEvaluationTasks(
    evaluation: any,
    config: TaskCreationConfig,
    startId: number,
  ): TaskDefinition[] {
    const tasks: TaskDefinition[] = [];

    if (evaluation.issues && Array.isArray(evaluation.issues)) {
      for (let i = 0; i < evaluation.issues.length; i++) {
        const issue = evaluation.issues[i];
        const taskId = `plan-issue-${startId + i}`;

        const task: TaskDefinition = {
          id: taskId,
          title: issue.title || `Address plan issue ${i + 1}`,
          description: issue.description || issue,
          priority: this.mapSeverityToPriority(
            issue.severity || issue.priority || "medium",
          ),
          category: issue.category || "planning",
          confidence: issue.confidence || 0.7,
          labels: ["planning", issue.category || "issue"],
          sourceData: {
            type: "plan-issue",
            sourceId: taskId,
            confidence: issue.confidence || 0.7,
          },
          acceptanceCriteria: [
            "Issue is resolved in plan",
            "Plan evaluation passes",
          ],
        };

        if (issue.blockedBy) {
          task.dependencies = Array.isArray(issue.blockedBy)
            ? issue.blockedBy
            : [issue.blockedBy];
        }

        tasks.push(task);
      }
    }

    if (
      evaluation.missingComponents &&
      Array.isArray(evaluation.missingComponents)
    ) {
      for (let i = 0; i < evaluation.missingComponents.length; i++) {
        const component = evaluation.missingComponents[i];
        const taskId = `missing-component-${startId + tasks.length + i}`;

        tasks.push({
          id: taskId,
          title: `Implement missing component: ${component}`,
          description: `Component identified as missing in plan:\n\n**Component:** ${component}\n\n**Reason:** Required for feature completion`,
          priority: "high",
          category: "implementation",
          confidence: 0.8,
          labels: ["implementation", "planning"],
          sourceData: {
            type: "plan-issue",
            sourceId: taskId,
            confidence: 0.8,
          },
          acceptanceCriteria: [
            "Component is implemented",
            "Tests are added",
            "Documentation is updated",
          ],
        });
      }
    }

    return tasks;
  }

  private generateContextTasks(
    data: any,
    stepName: string,
    config: TaskCreationConfig,
    startId: number,
  ): TaskDefinition[] {
    const tasks: TaskDefinition[] = [];

    if (data.actionItems && Array.isArray(data.actionItems)) {
      for (let i = 0; i < data.actionItems.length; i++) {
        const item = data.actionItems[i];
        const taskId = `context-${stepName}-${startId + i}`;

        tasks.push({
          id: taskId,
          title: item.title || `Action from ${stepName}`,
          description: item.description || item,
          priority: item.priority || "medium",
          category: stepName,
          confidence: 0.5,
          labels: [stepName, "action-item"],
          sourceData: {
            type: "manual",
            sourceId: taskId,
            confidence: 0.5,
          },
          acceptanceCriteria: ["Action is completed", "Verification is done"],
        });
      }
    }

    return tasks;
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
}
