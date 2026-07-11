import {
  StepResult,
  ValidationResult,
  WorkflowStep,
} from "../engine/WorkflowStep.js";
import { WorkflowContext } from "../engine/WorkflowContext.js";

interface BaselineHealthSynthesisConfig {
  errors_variable?: string;
  max_tasks?: number;
  priority?: "critical" | "high" | "medium" | "low";
  labels?: string[];
}

type BaselineCompileError = {
  file: string;
  errorCount: number;
  sample: string[];
};

type RepairTask = {
  title: string;
  description: string;
  priority: string;
  external_id: string;
  labels?: string[];
};

export class BaselineHealthSynthesisStep extends WorkflowStep {
  async execute(context: WorkflowContext): Promise<StepResult> {
    const config = this.config.config as BaselineHealthSynthesisConfig;
    const errorsVariable = config.errors_variable || "baseline_compile_errors";
    const maxTasks = Math.max(1, config.max_tasks ?? 5);
    const priority = config.priority || "high";

    const rawErrors = context.getVariable(errorsVariable);
    const errors: BaselineCompileError[] = Array.isArray(rawErrors)
      ? rawErrors.filter(
          (entry: any) =>
            entry &&
            typeof entry.file === "string" &&
            entry.file.trim().length > 0,
        )
      : [];

    if (errors.length === 0) {
      context.setVariable("baseline_repair_tasks", []);
      return {
        status: "success",
        outputs: { repair_tasks: [], repair_task_count: 0 },
      } satisfies StepResult;
    }

    const sorted = [...errors].sort(
      (a, b) => (b.errorCount || 0) - (a.errorCount || 0),
    );

    const tasks: RepairTask[] = sorted.slice(0, maxTasks).map((entry) => {
      const file = entry.file.replace(/\\/g, "/");
      const sample = Array.isArray(entry.sample) ? entry.sample : [];
      const description = [
        `Details: ${file} has ${entry.errorCount} pre-existing compile/typecheck error(s) on the base branch, detected during the repository context scan. These errors block the delta-based validation gates for every task that touches this file.`,
        "",
        "Sample diagnostics:",
        ...sample.map((line) => String(line)),
        "",
        "Acceptance criteria:",
        `- npx tsc --noEmit reports zero errors for ${file}`,
        "- Existing exports keep their names and shapes",
        "- No unrelated files are modified",
      ].join("\n");

      return {
        title: `Fix baseline compile errors in ${file}`,
        description,
        priority,
        external_id: `baseline-repair-${file.replace(/[^a-zA-Z0-9_.-]/g, "_")}`,
        labels: config.labels,
      };
    });

    context.setVariable("baseline_repair_tasks", tasks);
    context.logger.info("Synthesized baseline repair tasks", {
      workflowId: context.workflowId,
      brokenFiles: errors.length,
      tasksCreated: tasks.length,
      files: tasks.map((t) => t.title),
    });

    return {
      status: "success",
      outputs: {
        repair_tasks: tasks,
        repair_task_count: tasks.length,
        broken_file_count: errors.length,
      },
    } satisfies StepResult;
  }

  protected async validateConfig(
    _context: WorkflowContext,
  ): Promise<ValidationResult> {
    const config = this.config.config as BaselineHealthSynthesisConfig;
    const errors: string[] = [];

    if (
      config.max_tasks !== undefined &&
      (typeof config.max_tasks !== "number" || config.max_tasks < 1)
    ) {
      errors.push("BaselineHealthSynthesisStep: max_tasks must be >= 1");
    }
    if (
      config.priority !== undefined &&
      !["critical", "high", "medium", "low"].includes(config.priority)
    ) {
      errors.push(
        "BaselineHealthSynthesisStep: priority must be critical|high|medium|low",
      );
    }

    return { valid: errors.length === 0, errors, warnings: [] };
  }
}
