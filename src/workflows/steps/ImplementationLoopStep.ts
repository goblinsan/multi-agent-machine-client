import fs from "fs/promises";
import path from "path";
import {
  WorkflowStep,
  WorkflowStepConfig,
  StepResult,
} from "../engine/WorkflowStep.js";
import { WorkflowContext } from "../engine/WorkflowContext.js";
import { templateLoader } from "../engine/TemplateLoader.js";
import { PersonaRequestStep } from "./PersonaRequestStep.js";
import {
  DiffApplyStep,
  DiffApplyStepConfig,
} from "./DiffApplyStep.js";
import {
  PlanKeyFileGuardStep,
  PlanKeyFileGuardConfig,
} from "./PlanKeyFileGuardStep.js";
import { runGit } from "../../gitUtils.js";
import {
  ConfigValidationError,
  identifyConfigFiles,
  validateConfigFiles,
} from "../utils/configValidators.js";

interface ImplementationLoopConfig {
  maxAttempts?: number;
  implementationTemplate?: string;
  implementationOverrides?: Partial<WorkflowStepConfig>;
  diffConfig?: Partial<DiffApplyStepConfig>;
  planGuard?: Partial<PlanKeyFileGuardConfig>;
  missingFilesVariable?: string;
}

export class ImplementationLoopStep extends WorkflowStep {
  async execute(context: WorkflowContext): Promise<StepResult> {
    const cfg = this.config.config as ImplementationLoopConfig;
    const maxAttempts = Math.max(1, cfg.maxAttempts ?? 3);
    const missingVariable =
      cfg.missingFilesVariable || "implementation_guard_missing_files";

    const implementationStepConfig = this.buildImplementationStepConfig(
      cfg.implementationTemplate,
      cfg.implementationOverrides,
    );
    const personaStep = new PersonaRequestStep(implementationStepConfig);

    const guardStep = new PlanKeyFileGuardStep({
      name: "verify_plan_key_files",
      type: "PlanKeyFileGuardStep",
      config: this.buildPlanGuardConfig(cfg.planGuard, context),
    });

    const recordedPlan = this.getRecordedPlanMetadata(context);
    let missingFiles = recordedPlan.missingFiles;
    let lastValidationErrors: ConfigValidationError[] = [];

    context.setVariable("implementation_retry_max_attempts", maxAttempts);
    context.setVariable(missingVariable, missingFiles);
    context.setVariable("implementation_config_validation_errors", []);
    context.setVariable("implementation_config_validation_summary", "");

    let attempt = 0;

    while (attempt < maxAttempts) {
      attempt++;
      context.logger.info("Implementation loop attempt", {
        workflowId: context.workflowId,
        attempt,
        maxAttempts,
        missingBeforeAttempt: missingFiles,
      });

      context.setVariable("implementation_retry_attempt", attempt);
      context.setVariable(missingVariable, missingFiles);
      context.setVariable(
        "implementation_guard_missing_summary",
        missingFiles.join(", "),
      );

      if (attempt === maxAttempts) {
        context.setVariable("implementation_prefer_full_file", true);
      }

      await this.loadPlanFileSnippets(context, recordedPlan.planFiles);
      await this.loadPlanArtifactText(context);

      const personaResult = await personaStep.execute(context);
      if (personaResult.status !== "success") {
        if (attempt < maxAttempts) {
          context.logger.warn(
            "Persona request failed, retrying implementation attempt",
            {
              workflowId: context.workflowId,
              attempt,
              maxAttempts,
              failureReason:
                personaResult.error?.message || "Unknown persona failure",
            },
          );
          continue;
        }
        return personaResult;
      }
      this.syncStepOutput(
        context,
        "implementation_request",
        personaResult,
      );

      const diffStep = new DiffApplyStep({
        name: "apply_implementation_edits",
        type: "DiffApplyStep",
        config: this.buildDiffConfig(cfg.diffConfig, context, attempt),
      });

      const diffResult = await diffStep.execute(context);
      if (diffResult.status !== "success") {
        if (attempt < maxAttempts) {
          context.logger.warn(
            "Diff application failed, retrying implementation attempt",
            {
              workflowId: context.workflowId,
              attempt,
              maxAttempts,
              failureReason:
                diffResult.error?.message || "Unknown diff failure",
            },
          );
          await this.resetStagedChanges(context);
          continue;
        }
        return diffResult;
      }
      this.syncStepOutput(context, "apply_implementation_edits", diffResult);
      const appliedFiles = this.extractAppliedFiles(diffResult);

      const guardResult = await guardStep.execute(context);
      if (guardResult.status !== "success") {
        return guardResult;
      }
      this.syncStepOutput(context, "verify_plan_key_files", guardResult);

      missingFiles = this.extractMissingFiles(guardResult);
      const validationErrors = this.evaluateConfigValidation(
        context,
        appliedFiles,
        recordedPlan.planFiles,
      );
      lastValidationErrors = validationErrors;

      if (missingFiles.length === 0 && validationErrors.length === 0) {
        context.logger.info("Implementation loop completed", {
          workflowId: context.workflowId,
          attempts: attempt,
        });
        context.setVariable("implementation_attempts", attempt);
        context.setVariable(missingVariable, []);
        context.setVariable("implementation_guard_missing_summary", "");
        context.setVariable("implementation_config_validation_errors", []);
        context.setVariable("implementation_config_validation_summary", "");
        return {
          status: "success",
          outputs: {
            attempts: attempt,
            missing_files: [],
            plan_key_files: recordedPlan.planFiles,
          },
        } satisfies StepResult;
      }

      if (validationErrors.length > 0) {
        context.logger.warn("Config validation detected errors", {
          workflowId: context.workflowId,
          attempt,
          files: validationErrors.map((entry) => entry.file),
        });
        if (attempt >= maxAttempts) {
          break;
        }
        await this.resetCorruptedFiles(context, validationErrors);
        continue;
      }

      if (attempt >= maxAttempts) {
        break;
      }

      context.logger.warn("Plan files still missing after attempt", {
        workflowId: context.workflowId,
        attempt,
        missingFiles,
      });
    }

    context.setVariable("implementation_attempts", attempt);
    context.setVariable(missingVariable, missingFiles);
    context.setVariable(
      "implementation_guard_missing_summary",
      missingFiles.join(", "),
    );
    context.setVariable(
      "implementation_config_validation_errors",
      lastValidationErrors,
    );
    context.setVariable(
      "implementation_config_validation_summary",
      this.formatValidationSummary(lastValidationErrors),
    );

    const failureReasons: string[] = [];
    if (missingFiles.length > 0) {
      failureReasons.push(
        `missing plan files: ${missingFiles.join(", ")}`,
      );
    }
    if (lastValidationErrors.length > 0) {
      failureReasons.push(
        `config validation errors: ${this.formatValidationSummary(lastValidationErrors)}`,
      );
    }
    const reasonSummary =
      failureReasons.length > 0
        ? failureReasons.join(" | ")
        : "unresolved guard conditions";
    const errorMessage = `Implementation loop exhausted ${maxAttempts} attempt(s) (${reasonSummary}).`;

    return {
      status: "failure",
      error: new Error(errorMessage),
      data: {
        attempts: attempt,
        missingFiles,
      },
    } satisfies StepResult;
  }

  private buildImplementationStepConfig(
    templateName: string | undefined,
    overrides?: Partial<WorkflowStepConfig>,
  ): WorkflowStepConfig {
    const resolvedTemplate = templateName || "implementation";
    return templateLoader.expandTemplate(
      resolvedTemplate,
      "implementation_request",
      overrides,
    );
  }

  private buildDiffConfig(
    diffConfig: Partial<DiffApplyStepConfig> | undefined,
    context: WorkflowContext,
    attempt: number,
  ): DiffApplyStepConfig {
    const baseCommit = this.resolveCommitMessage(context);
    const commitMessage =
      attempt > 1 ? `${baseCommit} (attempt ${attempt})` : baseCommit;

    return {
      source_output: diffConfig?.source_output || "implementation_request",
      source_variable: diffConfig?.source_variable,
      validation: diffConfig?.validation || "syntax_check",
      backup: diffConfig?.backup,
      max_file_size: diffConfig?.max_file_size,
      blocked_extensions: diffConfig?.blocked_extensions,
      commit_message: diffConfig?.commit_message || commitMessage,
      dry_run: diffConfig?.dry_run,
    } satisfies DiffApplyStepConfig;
  }

  private resolveCommitMessage(context: WorkflowContext): string {
    const task = context.getVariable("task");
    const taskName =
      context.getVariable("taskName") ||
      task?.name ||
      task?.title ||
      task?.summary ||
      "task";
    return `feat: implement ${taskName}`;
  }

  private buildPlanGuardConfig(
    guardOverride: Partial<PlanKeyFileGuardConfig> | undefined,
    context: WorkflowContext,
  ): PlanKeyFileGuardConfig {
    const recorded = this.getRecordedPlanMetadata(context);
    const additionalFromOverride = Array.isArray(
      guardOverride?.additional_files,
    )
      ? guardOverride?.additional_files ?? []
      : [];
    const additionalFiles = Array.from(
      new Set([...(recorded.planFiles || []), ...additionalFromOverride]),
    );

    return {
      plan_step: guardOverride?.plan_step || "planning_loop",
      plan_result_field: guardOverride?.plan_result_field,
      plan_files_variable:
        guardOverride?.plan_files_variable || "planning_loop_plan_files",
      additional_files: additionalFiles,
      additional_files_variable: guardOverride?.additional_files_variable,
      auto_create_missing: guardOverride?.auto_create_missing ?? false,
      fail_on_missing: false,
      record_variable: guardOverride?.record_variable || "plan_required_files",
      commit_message: guardOverride?.commit_message,
      scaffold_comment: guardOverride?.scaffold_comment,
    } satisfies PlanKeyFileGuardConfig;
  }

  private getRecordedPlanMetadata(context: WorkflowContext) {
    const recordOutput = context.getStepOutput("record_plan_key_files");
    const planFiles =
      this.normalizeStringArray(recordOutput?.key_files) ||
      this.normalizeStringArray(recordOutput?.keyFiles) ||
      this.normalizeStringArray(context.getVariable("plan_required_files"));
    const missingFiles =
      this.normalizeStringArray(recordOutput?.missing_files) ||
      this.normalizeStringArray(recordOutput?.missingFiles) ||
      [];

    return { planFiles, missingFiles } as {
      planFiles: string[];
      missingFiles: string[];
    };
  }

  private normalizeStringArray(value: unknown): string[] {
    if (!value) return [];
    if (Array.isArray(value)) {
      return value
        .map((entry) =>
          typeof entry === "string" ? entry.trim() : String(entry ?? ""),
        )
        .filter((entry) => entry.length > 0);
    }
    if (typeof value === "string" && value.trim().length > 0) {
      return [value.trim()];
    }
    return [];
  }

  private extractMissingFiles(result: StepResult): string[] {
    const outputs = result.outputs ?? result.data;
    if (outputs && typeof outputs === "object") {
      const explicit = (outputs as any).missing_files || (outputs as any).missingFiles;
      if (Array.isArray(explicit)) {
        return explicit.filter((entry) => typeof entry === "string").map((entry) => entry.trim());
      }
    }
    return [];
  }

  private extractAppliedFiles(result: StepResult): string[] {
    const outputs = result.outputs ?? result.data;
    if (outputs && typeof outputs === "object") {
      const files = (outputs as any).applied_files || (outputs as any).applyResult?.changed || [];
      if (Array.isArray(files)) {
        return this.normalizeStringArray(files);
      }
    }
    return [];
  }

  private evaluateConfigValidation(
    context: WorkflowContext,
    appliedFiles: string[],
    watchFiles: string[] = [],
  ): ConfigValidationError[] {
    const candidates = identifyConfigFiles(
      Array.from(new Set([...(appliedFiles || []), ...(watchFiles || [])])),
    );
    if (candidates.length === 0) {
      context.setVariable("implementation_config_validation_errors", []);
      context.setVariable("implementation_config_validation_summary", "");
      return [];
    }

    const errors = validateConfigFiles(context.repoRoot, candidates);
    const summary = this.formatValidationSummary(errors);
    context.setVariable("implementation_config_validation_errors", errors);
    context.setVariable("implementation_config_validation_summary", summary);
    return errors;
  }

  private formatValidationSummary(errors: ConfigValidationError[]): string {
    if (errors.length === 0) {
      return "";
    }
    return errors
      .map((entry) => `${entry.file}: ${entry.reason}`)
      .join("; ");
  }

  private async resetCorruptedFiles(
    context: WorkflowContext,
    errors: ConfigValidationError[],
  ): Promise<void> {
    const files = errors.map((e) => e.file);
    try {
      await runGit(["checkout", "HEAD~1", "--", ...files], { cwd: context.repoRoot });
      context.logger.info("Reset corrupted config files to pre-edit state", {
        workflowId: context.workflowId,
        files,
      });
    } catch (err) {
      context.logger.warn("Failed to reset corrupted config files", {
        workflowId: context.workflowId,
        files,
        error: String(err),
      });
    }
  }

  private syncStepOutput(
    context: WorkflowContext,
    stepName: string,
    result: StepResult,
  ): void {
    if (result.outputs) {
      context.setStepOutput(stepName, result.outputs);
    } else if (result.data) {
      context.setStepOutput(stepName, result.data);
    }
  }

  private async loadPlanFileSnippets(
    context: WorkflowContext,
    planFiles: string[],
  ): Promise<void> {
    const MAX_SNIPPET_BYTES = 16384;
    const snippets: Array<{ path: string; content: string }> = [];
    const repoRoot = context.repoRoot;
    if (!repoRoot || !planFiles.length) {
      context.setVariable("implementation_file_snippets", []);
      return;
    }
    for (const relPath of planFiles) {
      try {
        const absPath = path.resolve(repoRoot, relPath);
        if (!absPath.startsWith(repoRoot)) continue;
        const stat = await fs.stat(absPath);
        if (stat.size > MAX_SNIPPET_BYTES) continue;
        const content = await fs.readFile(absPath, "utf-8");
        snippets.push({ path: relPath, content });
      } catch {
        void 0;
      }
    }
    context.setVariable("implementation_file_snippets", snippets);
    context.logger.info("Loaded plan file snippets for implementation", {
      workflowId: context.workflowId,
      fileCount: snippets.length,
      totalFiles: planFiles.length,
      files: snippets.map((s) => s.path),
    });
  }

  private async loadPlanArtifactText(
    context: WorkflowContext,
  ): Promise<void> {
    const task = context.getVariable("task");
    const taskId = task?.id || task?.taskId;
    const repoRoot = context.repoRoot;
    if (!taskId || !repoRoot) {
      context.setVariable("implementation_plan_text", "");
      return;
    }
    const artifactPath = path.resolve(
      repoRoot,
      `.ma/tasks/${taskId}/03-plan-final.md`,
    );
    try {
      const content = await fs.readFile(artifactPath, "utf-8");
      context.setVariable("implementation_plan_text", content);
    } catch {
      context.setVariable("implementation_plan_text", "");
    }
  }

  private async resetStagedChanges(context: WorkflowContext): Promise<void> {
    try {
      await runGit(["checkout", "."], { cwd: context.repoRoot });
      context.logger.info("Reset staged changes before retry", {
        workflowId: context.workflowId,
      });
    } catch (err) {
      context.logger.warn("Failed to reset staged changes", {
        workflowId: context.workflowId,
        error: String(err),
      });
    }
  }
}
