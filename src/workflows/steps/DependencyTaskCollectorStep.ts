import {
  StepResult,
  ValidationResult,
  WorkflowStep,
} from "../engine/WorkflowStep.js";
import { WorkflowContext } from "../engine/WorkflowContext.js";

interface DependencyTaskCollectorConfig {
  primary_ids?: string[] | string | number;
  duplicate_ids?: string[] | string | number;
  extra_ids?: string[] | string | number;
  output_variable?: string;
}

export class DependencyTaskCollectorStep extends WorkflowStep {
  async execute(context: WorkflowContext): Promise<StepResult> {
    const config = this.config.config as DependencyTaskCollectorConfig;
    const outputVariable = config.output_variable || "dependency_task_ids";

    const combined = [
      ...this.normalizeIds(config.primary_ids),
      ...this.normalizeIds(config.duplicate_ids),
      ...this.normalizeIds(config.extra_ids),
    ];

    const unique = Array.from(new Set(combined));
    context.setVariable(outputVariable, unique);

    return {
      status: "success",
      data: {
        dependency_task_ids: unique,
        count: unique.length,
      },
      outputs: {
        dependency_task_ids: unique,
        count: unique.length,
      },
    } satisfies StepResult;
  }

  async validateConfig(
    _context: WorkflowContext,
  ): Promise<ValidationResult> {
    return {
      valid: true,
      errors: [],
      warnings: [],
    } satisfies ValidationResult;
  }

  private normalizeIds(value?: string[] | string | number): string[] {
    if (value === undefined || value === null) {
      return [];
    }

    if (Array.isArray(value)) {
      return value
        .filter((entry) => entry !== null && entry !== undefined)
        .map((entry) => String(entry).trim())
        .filter((entry) => entry.length > 0);
    }

    if (typeof value === "string") {
      return value
        .split(/[\s,]+/)
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0);
    }

    if (typeof value === "number") {
      return [String(value)];
    }

    return [];
  }
}
