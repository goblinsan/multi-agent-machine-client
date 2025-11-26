import {
  WorkflowStep,
  StepResult,
  ValidationResult,
} from "../engine/WorkflowStep.js";
import { WorkflowContext } from "../engine/WorkflowContext.js";
import { FollowUpTask } from "./reviewFollowUpTypes.js";

interface MergeConfig {
  auto_follow_up_tasks?: FollowUpTask[] | null;
  pm_follow_up_tasks?: FollowUpTask[] | null;
}

export class ReviewFollowUpMergeStep extends WorkflowStep {
  protected async validateConfig(
    _context: WorkflowContext,
  ): Promise<ValidationResult> {
    return { valid: true, errors: [], warnings: [] };
  }

  async execute(context: WorkflowContext): Promise<StepResult> {
    const startedAt = Date.now();
    const config = (this.config.config || {}) as MergeConfig;
    const autoTasks = this.normalizeTasks(config.auto_follow_up_tasks);
    const pmTasks = this.normalizeTasks(config.pm_follow_up_tasks);

    const merged = this.mergeTasks(autoTasks, pmTasks);

    context.logger.info("Merged follow-up tasks", {
      stepName: this.config.name,
      autoTaskCount: autoTasks.length,
      pmTaskCount: pmTasks.length,
      mergedCount: merged.length,
    });

    return {
      status: "success",
      outputs: {
        merged_tasks: merged,
        auto_task_count: autoTasks.length,
        pm_task_count: pmTasks.length,
      },
      data: {
        merged,
      },
      metrics: {
        duration_ms: Date.now() - startedAt,
        merged_count: merged.length,
      },
    } satisfies StepResult;
  }

  private normalizeTasks(tasks?: FollowUpTask[] | null): FollowUpTask[] {
    if (!Array.isArray(tasks)) {
      return [];
    }
    return tasks.filter((task) => task && typeof task === "object");
  }

  private mergeTasks(
    autoTasks: FollowUpTask[],
    pmTasks: FollowUpTask[],
  ): FollowUpTask[] {
    const merged: FollowUpTask[] = [];
    const seen = new Set<string>();

    for (const task of [...autoTasks, ...pmTasks]) {
      const key = this.buildKey(task);
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      merged.push(task);
    }

    return merged;
  }

  private buildKey(task: FollowUpTask): string {
    const title = (task.title || "").toLowerCase();
    const description = (task.description || "").toLowerCase();
    return `${title}::${description}`;
  }
}
