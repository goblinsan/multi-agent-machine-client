import {
  WorkflowStep,
  StepResult,
  ValidationResult,
  WorkflowStepConfig,
} from "../engine/WorkflowStep.js";
import { WorkflowContext } from "../engine/WorkflowContext.js";
import { logger } from "../../logger.js";
import {
  TaskDuplicateDetector,
  type ExistingTask,
  type TaskForDuplication,
} from "./helpers/TaskDuplicateDetector.js";

interface ReviewFollowUpFilterConfig {
  tasks?: any;
  existing_tasks?: ExistingTask[];
  milestone_context?: Record<string, any> | null;
  task?: Record<string, any> | null;
  review_type?: string;
  diff_changed_files?: string[];
  min_keyword_overlap?: number;
}

interface DroppedTaskInfo {
  title: string;
  reason: string;
}

export class ReviewFollowUpFilterStep extends WorkflowStep {
  private duplicateDetector: TaskDuplicateDetector;

  constructor(config: WorkflowStepConfig) {
    super(config);
    this.duplicateDetector = new TaskDuplicateDetector();
  }

  protected async validateConfig(
    _context: WorkflowContext,
  ): Promise<ValidationResult> {
    return { valid: true, errors: [], warnings: [] };
  }

  async execute(_context: WorkflowContext): Promise<StepResult> {
    const startTime = Date.now();
    const config = (this.config.config || {}) as ReviewFollowUpFilterConfig;
    const tasks = Array.isArray(config.tasks) ? config.tasks : [];

    if (tasks.length === 0) {
      return this.successResult([], [], 0, startTime);
    }

    const existingTasks = Array.isArray(config.existing_tasks)
      ? config.existing_tasks
      : [];
    const milestoneSlug = this.resolveMilestoneSlug(config.milestone_context);
    const allowedKeywords = this.buildAllowedKeywords(config);
    const changedFiles = this.normalizeChangedFiles(
      config.diff_changed_files,
    );

    const filtered: any[] = [];
    const dropped: DroppedTaskInfo[] = [];

    for (const candidate of tasks) {
      const normalized = this.normalizeTask(candidate);
      if (!normalized) {
        dropped.push({
          title: this.toTitle(candidate),
          reason: "invalid_task_shape",
        });
        continue;
      }

      const forceInclude = Boolean(
        candidate &&
          typeof candidate === "object" &&
          (candidate as any).metadata?.auto_generated,
      );

      if (
        this.isDuplicateOfExisting(normalized, existingTasks, milestoneSlug)
      ) {
        dropped.push({
          title: normalized.title,
          reason: "duplicate_existing_task",
        });
        continue;
      }

      if (
        !forceInclude &&
        !this.matchesAllowedKeywords(normalized, allowedKeywords)
      ) {
        dropped.push({
          title: normalized.title,
          reason: "unaligned_with_milestone",
        });
        continue;
      }

      if (
        !forceInclude &&
        this.referencesUnknownFiles(normalized, changedFiles) &&
        changedFiles.length > 0
      ) {
        dropped.push({
          title: normalized.title,
          reason: "file_not_in_current_diff",
        });
        continue;
      }

      filtered.push(candidate);
    }

    if (dropped.length > 0) {
      logger.info("Follow-up task filter dropped recommendations", {
        stepName: this.config.name,
        dropped,
      });
    }

    return this.successResult(filtered, dropped, tasks.length, startTime);
  }

  private successResult(
    filtered: any[],
    dropped: DroppedTaskInfo[],
    originalCount: number,
    startTime: number,
  ): StepResult {
    return {
      status: "success",
      data: { filtered_tasks: filtered, dropped_tasks: dropped },
      outputs: { filtered_tasks: filtered, dropped_tasks: dropped },
      metrics: {
        duration_ms: Date.now() - startTime,
        operations_count: originalCount,
      },
    } satisfies StepResult;
  }

  private normalizeTask(task: any):
    | { title: string; description: string; text: string }
    | null {
    if (!task || typeof task !== "object") {
      return null;
    }

    const title = this.toTitle(task);
    if (!title) {
      return null;
    }

    const description = typeof task.description === "string"
      ? task.description
      : "";

    return {
      title,
      description,
      text: `${title}\n${description}`.toLowerCase(),
    };
  }

  private toTitle(task: any): string {
    if (!task) {
      return "";
    }
    if (typeof task.title === "string" && task.title.trim().length > 0) {
      return task.title.trim();
    }
    if (typeof task.name === "string" && task.name.trim().length > 0) {
      return task.name.trim();
    }
    return "";
  }

  private isDuplicateOfExisting(
    normalizedTask: { title: string; description: string },
    existingTasks: ExistingTask[],
    milestoneSlug?: string,
  ): boolean {
    if (!existingTasks || existingTasks.length === 0) {
      return false;
    }

    const candidate: TaskForDuplication = {
      title: normalizedTask.title,
      description: normalizedTask.description,
      milestone_slug: milestoneSlug,
    };

    const duplicate = this.duplicateDetector.findDuplicateWithDetails(
      candidate,
      existingTasks,
      "title_and_milestone",
    );

    if (duplicate) {
      logger.info("Detected duplicate follow-up task candidate", {
        title: normalizedTask.title,
        duplicateOf: duplicate.duplicate.id,
        matchScore: duplicate.matchScore,
      });
    }

    return Boolean(duplicate);
  }

  private buildAllowedKeywords(
    config: ReviewFollowUpFilterConfig,
  ): Set<string> {
    const keywords = new Set<string>();
    const add = (text?: string) => {
      if (typeof text !== "string") return;
      for (const token of this.tokenize(text)) {
        keywords.add(token);
      }
    };

    add(config.task?.title);
    add(config.task?.description);

    const milestone = config.milestone_context || {};
    add(milestone?.name);
    add(milestone?.description);

    if (Array.isArray(milestone?.objectives)) {
      milestone.objectives.forEach((objective: any) => add(String(objective)));
    }

    if (Array.isArray(config.task?.labels)) {
      config.task.labels.forEach((label: any) => add(String(label)));
    }

    if (Array.isArray(config.diff_changed_files)) {
      config.diff_changed_files.forEach((file) => add(file));
    }

    return keywords;
  }

  private tokenize(text: string): string[] {
    return text
      .toLowerCase()
      .split(/[^a-z0-9]+/i)
      .map((token) => token.trim())
      .filter((token) => token.length >= 4);
  }

  private matchesAllowedKeywords(
    task: { text: string },
    allowedKeywords: Set<string>,
  ): boolean {
    if (allowedKeywords.size === 0) {
      return true;
    }

    for (const keyword of allowedKeywords) {
      if (task.text.includes(keyword)) {
        return true;
      }
    }
    return false;
  }

  private normalizeChangedFiles(files?: string[]): string[] {
    if (!Array.isArray(files)) {
      return [];
    }
    return files
      .map((file) => file.toLowerCase())
      .filter((file) => file.length > 0);
  }

  private referencesUnknownFiles(
    task: { text: string },
    changedFiles: string[],
  ): boolean {
    if (changedFiles.length === 0) {
      return false;
    }

    const referenced = this.extractFileReferences(task.text);
    if (referenced.length === 0) {
      return false;
    }

    const matchesDiff = referenced.some((ref) =>
      changedFiles.some((file) => file.endsWith(ref)),
    );

    return !matchesDiff;
  }

  private extractFileReferences(text: string): string[] {
    const matches = text.match(/[a-z0-9_/\\.-]+\.[a-z0-9]+/gi);
    if (!matches) {
      return [];
    }
    return matches.map((match) => match.toLowerCase());
  }

  private resolveMilestoneSlug(
    milestone: Record<string, any> | null | undefined,
  ): string | undefined {
    if (!milestone) {
      return undefined;
    }
    if (typeof milestone.slug === "string" && milestone.slug.length > 0) {
      return milestone.slug;
    }
    if (
      typeof milestone.milestone_slug === "string" &&
      milestone.milestone_slug.length > 0
    ) {
      return milestone.milestone_slug;
    }
    return undefined;
  }
}
