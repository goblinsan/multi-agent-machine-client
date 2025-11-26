import { WorkflowEngine } from "../WorkflowEngine.js";

export class WorkflowSelector {
  determineTaskType(task: any): string {
    if (this.isReviewFollowUpTask(task)) {
      return "analysis";
    }

    const taskType = task?.type || task?.task_type;
    if (taskType) {
      const normalized = String(taskType).toLowerCase();
      return normalized === "analysis" ? "analysis" : normalized;
    }

    const title = String(
      task?.title || task?.name || task?.summary || "",
    ).toLowerCase();
    const description = String(task?.description || "").toLowerCase();
    const combined = `${title} ${description}`;

    if (
      combined.includes("bug") ||
      combined.includes("fix") ||
      combined.includes("error") ||
      combined.includes("issue")
    ) {
      return "bug";
    }

    if (
      combined.includes("feature") ||
      combined.includes("implement") ||
      combined.includes("add")
    ) {
      return "feature";
    }

    if (
      combined.includes("refactor") ||
      combined.includes("improve") ||
      combined.includes("optimize")
    ) {
      return "refactor";
    }

    if (combined.includes("test") || combined.includes("spec")) {
      return "test";
    }

    if (combined.includes("doc") || combined.includes("readme")) {
      return "documentation";
    }

    return "feature";
  }

  private isReviewFollowUpTask(task: any): boolean {
    if (!task || typeof task !== "object") {
      return false;
    }

    const title = this.extractLower(
      task?.title || task?.name || task?.summary || "",
    );
    const description = this.extractLower(task?.description || "");
    const labels = new Set([
      ...this.normalizeList(task?.labels),
      ...this.normalizeList(task?.metadata?.labels),
    ]);

    const implementationLabels = new Set([
      "analysis-derived",
      "ready-for-implementation",
      "implementation_ready",
    ]);

    for (const label of implementationLabels) {
      if (labels.has(label)) {
        return false;
      }
    }

    if (this.hasLabelSignal(labels)) {
      return true;
    }

    if (this.hasTitleSignal(title)) {
      return true;
    }

    if (this.hasDescriptionSignal(description)) {
      return true;
    }

    const metadataSource = this.extractLower(task?.metadata?.coverage_source);
    if (metadataSource.includes("review") || metadataSource.includes("qa")) {
      return true;
    }

    return false;
  }

  private normalizeList(value: any): string[] {
    if (!Array.isArray(value)) {
      return [];
    }
    return value
      .map((entry) => (typeof entry === "string" ? entry.toLowerCase() : ""))
      .filter(Boolean);
  }

  private extractLower(value: any): string {
    return typeof value === "string" ? value.toLowerCase() : "";
  }

  private hasLabelSignal(labels: Set<string>): boolean {
    if (labels.size === 0) {
      return false;
    }
    const labelSignals = [
      "qa_follow_up",
      "review_follow_up",
      "follow-up",
      "follow_up",
      "qa gap",
      "review gap",
      "coordination",
    ];
    for (const label of labels) {
      if (labelSignals.some((signal) => label.includes(signal))) {
        return true;
      }
    }
    return false;
  }

  private hasTitleSignal(title: string): boolean {
    if (!title) {
      return false;
    }
    const titleSignals = [
      "qa follow_up",
      "qa follow up",
      "review gap",
      "qa gap",
      "follow up",
      "follow-up",
    ];
    return titleSignals.some((signal) => title.includes(signal));
  }

  private hasDescriptionSignal(description: string): boolean {
    if (!description) {
      return false;
    }
    const descriptionSignals = [
      "category: follow_up",
      "review reported the following issue",
      "qa gap:",
      "review gap",
      "source: normalized_",
      "source: qa",
      "source: code_review",
      "source: security_review",
      "source: devops_review",
    ];
    return descriptionSignals.some((signal) =>
      description.includes(signal.toLowerCase()),
    );
  }

  determineTaskScope(task: any): string {
    const scope = task?.scope;
    if (scope) return String(scope).toLowerCase();

    const title = String(
      task?.title || task?.name || task?.summary || "",
    ).toLowerCase();
    const description = String(task?.description || "").toLowerCase();
    const content = `${title} ${description}`;

    if (
      content.includes("large") ||
      content.includes("complex") ||
      content.includes("major")
    ) {
      return "large";
    }

    if (
      content.includes("small") ||
      content.includes("minor") ||
      content.includes("quick") ||
      content.includes("simple")
    ) {
      return "small";
    }

    return "medium";
  }

  selectWorkflowForTask(
    engine: WorkflowEngine,
    task: any,
  ): { workflow: any; reason: string } | null {
    const taskType = this.determineTaskType(task);
    const scope = this.determineTaskScope(task);
    const taskStatus = task?.status?.toLowerCase() || "unknown";

    if (taskStatus === "blocked" || taskStatus.includes("stuck")) {
      const blockedWorkflow = engine.getWorkflowDefinition(
        "blocked-task-resolution",
      );
      if (blockedWorkflow) {
        return {
          workflow: blockedWorkflow,
          reason: "blocked-task",
        };
      }
    }

    if (taskStatus === "in_review" || taskStatus.includes("review")) {
      const reviewWorkflow = engine.getWorkflowDefinition(
        "in-review-task-flow",
      );
      if (reviewWorkflow) {
        return {
          workflow: reviewWorkflow,
          reason: "in-review-task",
        };
      }
    }

    const matchedWorkflow = engine.findWorkflowByCondition(taskType, scope);
    if (matchedWorkflow) {
      return {
        workflow: matchedWorkflow,
        reason: "matched-condition",
      };
    }

    const fallbackWorkflow = engine.getWorkflowDefinition("task-flow");
    if (fallbackWorkflow) {
      return {
        workflow: fallbackWorkflow,
        reason: "fallback",
      };
    }

    return null;
  }

  computeFeatureBranchName(task: any, repoSlug: string): string {
    const milestone = task?.milestone;
    const milestoneSlug = task?.milestone?.slug || task?.milestone_slug || null;
    const taskSlug = task?.slug || task?.task_slug || null;

    const fromMilestone =
      milestone?.branch || milestone?.branch_name || milestone?.branchName;
    if (
      fromMilestone &&
      typeof fromMilestone === "string" &&
      fromMilestone.trim()
    ) {
      return fromMilestone.trim();
    }

    const fromTask = task?.branch || task?.branch_name || task?.branchName;
    if (fromTask && typeof fromTask === "string" && fromTask.trim()) {
      return fromTask.trim();
    }

    if (
      milestoneSlug &&
      typeof milestoneSlug === "string" &&
      milestoneSlug.trim() &&
      milestoneSlug !== "milestone"
    ) {
      return `milestone/${milestoneSlug}`;
    }

    if (taskSlug && typeof taskSlug === "string" && taskSlug.trim()) {
      return `feat/${taskSlug}`;
    }

    return `milestone/${repoSlug}`;
  }
}
