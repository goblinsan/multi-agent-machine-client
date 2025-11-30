import fs from "fs/promises";
import path from "path";

import {
  StepResult,
  ValidationResult,
  WorkflowStep,
} from "../engine/WorkflowStep.js";
import { WorkflowContext } from "../engine/WorkflowContext.js";

interface QAArtifactLoadConfig {
  artifact_name?: string;
  artifact_path?: string;
  output_variable?: string;
  allow_missing?: boolean;
}

export class QAArtifactLoadStep extends WorkflowStep {
  async execute(context: WorkflowContext): Promise<StepResult> {
    const config = this.config.config as QAArtifactLoadConfig;
    const artifactName = (config.artifact_name || "qa").trim();
    const outputVariable =
      (config.output_variable && config.output_variable.trim()) ||
      `${artifactName}_previous_result`;
    const allowMissing = config.allow_missing !== false;
    const repoRoot = context.repoRoot;
    const artifactPath = await this.resolveArtifactPath(
      config.artifact_path,
      artifactName,
      context,
    );

    try {
      const raw = await fs.readFile(path.join(repoRoot, artifactPath), "utf-8");
      const parsed = JSON.parse(raw);

      context.setVariable(outputVariable, parsed);
      context.setVariable(`${outputVariable}_path`, artifactPath);
      context.setVariable(`${outputVariable}_loaded_at`, Date.now());

      return {
        status: "success",
        data: {
          artifactPath,
          found: true,
          outputVariable,
        },
      } satisfies StepResult;
    } catch (error: any) {
      if (error?.code === "ENOENT" && allowMissing) {
        context.setVariable(outputVariable, null);
        context.logger.info("QAArtifactLoadStep: artifact missing", {
          workflowId: context.workflowId,
          artifactPath,
        });
        return {
          status: "success",
          data: {
            artifactPath,
            found: false,
            outputVariable,
          },
        } satisfies StepResult;
      }

      context.logger.error("QAArtifactLoadStep: failed to load artifact", {
        workflowId: context.workflowId,
        artifactPath,
        error: error instanceof Error ? error.message : String(error),
      });

      return {
        status: "failure",
        error:
          error instanceof Error
            ? error
            : new Error(String(error ?? "Unknown error")),
      } satisfies StepResult;
    }
  }

  protected async validateConfig(
    _context: WorkflowContext,
  ): Promise<ValidationResult> {
    const config = this.config.config as QAArtifactLoadConfig;
    const errors: string[] = [];

    if (config.artifact_name && typeof config.artifact_name !== "string") {
      errors.push("artifact_name must be a string");
    }

    if (config.output_variable && typeof config.output_variable !== "string") {
      errors.push("output_variable must be a string");
    }

    if (config.artifact_path && typeof config.artifact_path !== "string") {
      errors.push("artifact_path must be a string");
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings: [],
    } satisfies ValidationResult;
  }

  private async resolveArtifactPath(
    overridePath: string | undefined,
    artifactName: string,
    context: WorkflowContext,
  ): Promise<string> {
    if (overridePath && overridePath.trim().length > 0) {
      return overridePath.trim();
    }

    const taskId = this.resolveTaskId(context);
    const fallback = path.join(
      ".ma",
      "tasks",
      String(taskId ?? "unknown"),
      "reviews",
      `${artifactName}.json`,
    );
    return fallback;
  }

  private resolveTaskId(context: WorkflowContext): number | string | null {
    const task = context.getVariable("task");
    if (task && typeof task === "object") {
      if (typeof task.id === "number" || typeof task.id === "string") {
        return task.id;
      }
    }

    const fallback = context.getVariable("taskId");
    if (typeof fallback === "number" || typeof fallback === "string") {
      return fallback;
    }

    return null;
  }
}
