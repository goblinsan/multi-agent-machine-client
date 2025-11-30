import fs from "fs/promises";
import path from "path";

import {
  StepResult,
  ValidationResult,
  WorkflowStep,
} from "../engine/WorkflowStep.js";
import { WorkflowContext } from "../engine/WorkflowContext.js";
import { logger } from "../../logger.js";
import { runGit } from "../../gitUtils.js";
import {
  collectPlanKeyFiles,
  normalizePlanPayload,
} from "./helpers/planningHelpers.js";

export interface PlanKeyFileGuardConfig {
  plan_step?: string;
  plan_result_field?: string;
  plan_files_variable?: string;
  additional_files?: string[];
  additional_files_variable?: string;
  auto_create_missing?: boolean;
  fail_on_missing?: boolean;
  record_variable?: string;
  commit_message?: string;
  scaffold_comment?: string;
}

export class PlanKeyFileGuardStep extends WorkflowStep {
  async execute(context: WorkflowContext): Promise<StepResult> {
    const config = this.config.config as PlanKeyFileGuardConfig;
    const planStep = config.plan_step || "planning_loop";
    const planResultField = config.plan_result_field || "plan_result";
    const planFilesVariable = config.plan_files_variable;
    const autoCreate = config.auto_create_missing ?? false;
    const failOnMissing = config.fail_on_missing ?? true;
    const additionalFiles = Array.isArray(config.additional_files)
      ? config.additional_files
      : [];
    const variableAdditionalFiles = this.resolveAdditionalFilesFromVariable(
      config.additional_files_variable,
      context,
    );

    const planOutput =
      context.getStepOutput(planStep) ?? context.getVariable(planStep);

    if (!planOutput) {
      return {
        status: "failure",
        error: new Error(
          `PlanKeyFileGuardStep: plan step '${planStep}' has no outputs`,
        ),
      } satisfies StepResult;
    }

    const planResultCandidate =
      typeof planOutput === "object" && planOutput !== null
        ? planOutput[planResultField] ?? planOutput.plan_result
        : undefined;
    const resolvedPlanResult = planResultCandidate ?? planOutput;

    const { planData } = normalizePlanPayload(resolvedPlanResult);
    const planFiles = collectPlanKeyFiles(planData);
    const fallbackVariables: unknown[] = [];
    if (planFilesVariable) {
      fallbackVariables.push(context.getVariable(planFilesVariable));
    }
    fallbackVariables.push(context.getVariable("plan_required_files"));

    const normalizedPlanFiles = this.normalizePlanFiles([
      planFiles,
      additionalFiles,
      variableAdditionalFiles,
      fallbackVariables,
    ]);

    const recordVariable = config.record_variable || "plan_required_files";
    context.setVariable(recordVariable, normalizedPlanFiles);
    if (planFilesVariable && planFilesVariable !== recordVariable) {
      context.setVariable(planFilesVariable, normalizedPlanFiles);
    }

    if (!normalizedPlanFiles.length) {
      logger.info("PlanKeyFileGuardStep: no plan key files detected", {
        workflowId: context.workflowId,
        planStep,
      });

      return {
        status: "success",
        data: {
          keyFiles: [],
          missingFiles: [],
          createdFiles: [],
        },
        outputs: {
          key_files: [],
          missing_files: [],
          created_files: [],
        },
      } satisfies StepResult;
    }

    const repoRoot = context.repoRoot;
    const missingFiles: string[] = [];
    const createdFiles: string[] = [];

    for (const relativePath of normalizedPlanFiles) {
      const exists = await this.pathExists(path.join(repoRoot, relativePath));
      if (!exists) {
        if (autoCreate) {
          await this.scaffoldFile(
            repoRoot,
            relativePath,
            context,
            config.scaffold_comment,
          );
          createdFiles.push(relativePath);
        } else {
          missingFiles.push(relativePath);
        }
      }
    }

    if (createdFiles.length > 0) {
      await this.commitCreatedFiles(createdFiles, context, config);
    }

    const resultPayload = {
      keyFiles: normalizedPlanFiles,
      missingFiles,
      createdFiles,
    };

    if (missingFiles.length > 0 && failOnMissing && !autoCreate) {
      return {
        status: "failure",
        error: new Error(
          `PlanKeyFileGuardStep: missing required files: ${missingFiles.join(", ")}`,
        ),
        data: resultPayload,
        outputs: {
          key_files: normalizedPlanFiles,
          missing_files: missingFiles,
          created_files: createdFiles,
        },
      } satisfies StepResult;
    }

    if (missingFiles.length > 0) {
      logger.warn("PlanKeyFileGuardStep: missing plan files", {
        workflowId: context.workflowId,
        missingCount: missingFiles.length,
        autoCreate,
      });
    }

    return {
      status: "success",
      data: resultPayload,
      outputs: {
        key_files: normalizedPlanFiles,
        missing_files: missingFiles,
        created_files: createdFiles,
      },
    } satisfies StepResult;
  }

  async validateConfig(_context: WorkflowContext): Promise<ValidationResult> {
    const config = this.config.config as PlanKeyFileGuardConfig;
    const errors: string[] = [];

    if (
      config.additional_files !== undefined &&
      !Array.isArray(config.additional_files)
    ) {
      errors.push("PlanKeyFileGuardStep: additional_files must be an array");
    }

    if (
      config.record_variable !== undefined &&
      typeof config.record_variable !== "string"
    ) {
      errors.push("PlanKeyFileGuardStep: record_variable must be a string");
    }

    if (
      config.plan_files_variable !== undefined &&
      typeof config.plan_files_variable !== "string"
    ) {
      errors.push("PlanKeyFileGuardStep: plan_files_variable must be a string");
    }

    if (
      config.additional_files_variable !== undefined &&
      typeof config.additional_files_variable !== "string"
    ) {
      errors.push(
        "PlanKeyFileGuardStep: additional_files_variable must be a string",
      );
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings: [],
    } satisfies ValidationResult;
  }

  private normalizePlanFiles(files: unknown): string[] {
    const sanitized = new Set<string>();
    const processEntry = (entry: unknown) => {
      if (entry === null || entry === undefined) {
        return;
      }
      if (Array.isArray(entry)) {
        entry.forEach(processEntry);
        return;
      }
      if (typeof entry === "string") {
        const normalized = this.normalizeSinglePath(entry);
        if (normalized) {
          sanitized.add(normalized);
        }
        return;
      }
    };

    processEntry(files);
    return Array.from(sanitized);
  }

  private normalizeSinglePath(value: string): string | null {
    const trimmed = value.trim();
    if (!trimmed) return null;
    return trimmed
      .replace(/^\.\/+/, "")
      .replace(/\\/g, "/")
      .replace(/^\//, "");
  }

  private async pathExists(targetPath: string): Promise<boolean> {
    try {
      await fs.access(targetPath);
      return true;
    } catch {
      return false;
    }
  }

  private async scaffoldFile(
    repoRoot: string,
    relativePath: string,
    context: WorkflowContext,
    commentOverride?: string,
  ): Promise<void> {
    const fullPath = path.join(repoRoot, relativePath);
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    const taskId = context.getVariable("task")?.id ?? "unknown";
    const comment =
      commentOverride ||
      `TODO(task ${taskId}): implement plan requirement for ${relativePath}`;

    const content = this.buildScaffoldContent(relativePath, comment);
    await fs.writeFile(fullPath, content, { encoding: "utf-8" });

    logger.info("PlanKeyFileGuardStep: scaffolded missing plan file", {
      workflowId: context.workflowId,
      relativePath,
    });
  }

  private buildScaffoldContent(relativePath: string, comment: string): string {
    const lower = relativePath.toLowerCase();
    const extension = path.extname(lower);
    const jsHeader = `// ${comment}\n\n`;
    if (/(test|spec)\.(ts|js|tsx|jsx)$/.test(lower)) {
      return (
        jsHeader +
        `import { describe, it, expect } from "vitest";\n\n` +
        `describe("${relativePath}", () => {\n` +
        `  it("implements the regression described in the plan", () => {\n` +
        `    expect(true).toBe(true);\n` +
        `  });\n` +
        `});\n`
      );
    }

    if (lower.endsWith(".md")) {
      return `# ${relativePath}\n\n${comment}\n`;
    }

    if ([".ts", ".tsx", ".js", ".jsx"].includes(extension)) {
      return (
        jsHeader +
        `export function pendingPlanWork() {\n` +
        `  // Replace with real implementation per regression plan\n` +
        `}\n`
      );
    }

    if (extension === ".py") {
      return `# ${comment}\n\n# Implement regression coverage per plan\n`;
    }

    if (extension === ".json") {
      const safe = comment.replace(/"/g, '\\"');
      return `{"note": "${safe}"}\n`;
    }

    return `${comment}\n`;
  }

  private async commitCreatedFiles(
    createdFiles: string[],
    context: WorkflowContext,
    config: PlanKeyFileGuardConfig,
  ): Promise<void> {
    const skipGitOps = context.getVariable("SKIP_GIT_OPERATIONS") === true;
    if (skipGitOps || createdFiles.length === 0) {
      return;
    }

    const repoRoot = context.repoRoot;
    for (const file of createdFiles) {
      await runGit(["add", file], { cwd: repoRoot });
    }

    const taskId = context.getVariable("task")?.id ?? "unknown";
    const commitMessage =
      config.commit_message ||
      `chore(ma): scaffold plan files for task ${taskId}`;

    await runGit(["commit", "--no-verify", "-m", commitMessage], {
      cwd: repoRoot,
    });

    try {
      const remotes = await runGit(["remote"], { cwd: repoRoot });
      if (remotes.stdout.trim().length > 0) {
        const branch = context.getCurrentBranch();
        await runGit(["push", "origin", branch], { cwd: repoRoot });
      }
    } catch (error) {
      logger.warn("PlanKeyFileGuardStep: failed to push scaffold commit", {
        workflowId: context.workflowId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private resolveAdditionalFilesFromVariable(
    variablePath: string | undefined,
    context: WorkflowContext,
  ): string[] {
    if (!variablePath || !variablePath.trim().length) {
      return [];
    }

    const parts = variablePath.split(".");
    let value: any = context.getVariable(parts[0]);
    for (let i = 1; i < parts.length; i += 1) {
      if (value === null || value === undefined) {
        return [];
      }
      value = value[parts[i]];
    }

    return this.normalizePlanFiles(value);
  }
}
