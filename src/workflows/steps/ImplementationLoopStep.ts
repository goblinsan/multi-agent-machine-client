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
import { commitAndPushChanges } from "../../fileops/applyEditOps.js";
import {
  PlanKeyFileGuardStep,
  PlanKeyFileGuardConfig,
} from "./PlanKeyFileGuardStep.js";
import { runGit } from "../../gitUtils.js";
import { runTestCommandWithWorker } from "../helpers/testRunner.js";
import { fetchArtifactContentFromApi } from "../helpers/artifactReader.js";
import {
  ConfigValidationError,
  identifyConfigFiles,
  validateConfigFiles,
} from "../utils/configValidators.js";
import { DiffParser } from "../../agents/parsers/DiffParser.js";
import {
  ImplementationStage,
  resolvePlanStages,
  typecheckErrorSignature,
} from "./helpers/implementationStages.js";
import {
  classifyValidationFailures,
  summarizeScopeExpansion,
} from "./helpers/typecheckDiagnostics.js";
import { repairRelativeImportErrors } from "./helpers/importPathRepair.js";
import {
  extractOffendingProperties,
  extractInvalidUnionLiteralUses,
  extractPrimitiveAssignabilityMismatches,
  extractTypeNamesFromDiagnostics,
  locateTypeDefinitionFiles,
  summarizeTypeDefinitions,
} from "./helpers/typeDefinitionLocator.js";

interface ImplementationLoopConfig {
  maxAttempts?: number;
  implementationTemplate?: string;
  implementationOverrides?: Partial<WorkflowStepConfig>;
  diffConfig?: Partial<DiffApplyStepConfig>;
  planGuard?: Partial<PlanKeyFileGuardConfig>;
  missingFilesVariable?: string;
  stepwise?: boolean;
  enforcePlanScope?: boolean;
  continueOnStageFailure?: boolean;
  planStep?: string;
}

type TypecheckValidationError = ConfigValidationError & {
  code?: string;
  message?: string;
  line?: number;
  column?: number;
};

const MAX_RETRY_DIAGNOSTICS = 8;
const MAX_RETRY_DIAGNOSTICS_PER_FILE = 2;
const MAX_RETRY_REASON_CHARS = 220;
const MAX_RETRY_SUMMARY_CHARS = 6000;
const MAX_AUTO_SNIPPET_FILES = 12;
const MAX_CONVERGENCE_BONUS_ATTEMPTS = 2;
const RUNAWAY_RESPONSE_CHAR_THRESHOLD = 24000;
const REPETITIVE_PREFIX_THRESHOLD = 24;
const REPETITIVE_PREFIX_MIN_RATIO = 0.18;
const NO_EFFECTIVE_CHANGE_MESSAGE =
  "Implementation produced no new committed changes";

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

    const activePlanStep = this.getActivePlanStep(context, cfg);
    const recordedPlan = this.getRecordedPlanMetadata(context);
    let missingFiles = recordedPlan.missingFiles;
    let lastValidationErrors: ConfigValidationError[] = [];

    context.setVariable("implementation_retry_max_attempts", maxAttempts);
    context.setVariable(missingVariable, missingFiles);
    context.setVariable("implementation_config_validation_errors", []);
    context.setVariable("implementation_config_validation_errors_full", []);
    context.setVariable("implementation_config_validation_summary", "");
    context.setVariable("implementation_prefer_full_file", false);
    context.setVariable("implementation_information_request_summary", "");
    context.setVariable("implementation_retry_directives", "");
    this.updateRequiredFilePromptState(context, recordedPlan.planFiles, missingFiles);

    const baselineTypecheck = await this.captureBaselineTypecheck(context);

    const stages =
      cfg.stepwise === false
        ? resolvePlanStages(null, recordedPlan.planFiles)
        : resolvePlanStages(
            context.getStepOutput(activePlanStep)?.plan_result,
            recordedPlan.planFiles,
          );

    context.logger.info("Implementation loop starting", {
      workflowId: context.workflowId,
      stages: stages.length,
      stepwise: stages.length > 1,
      baselineTypecheckErrors: baselineTypecheck ? baselineTypecheck.size : null,
    });

    const fileFailureCounts = new Map<string, number>();
    let totalAttempts = 0;
    const appliedAllStages = new Set<string>();
    let lastCommit: { sha: string; branch: string } | null = null;
    const failedStages: Array<{
      stage: ImplementationStage;
      errors: ConfigValidationError[];
    }> = [];

    for (const stage of stages) {
      const stageFiles =
        stage.files.length > 0 ? stage.files : recordedPlan.planFiles;
      const cumulativeFiles = new Set(
        stages
          .filter((s) => s.index <= stage.index)
          .flatMap((s) => (s.files.length > 0 ? s.files : recordedPlan.planFiles))
          .map((file) => this.normalizeRelativePath(file)),
      );
      this.setStageVariables(context, stage, stages.length, stageFiles);

      const stageOutcome = await this.runStage({
        context,
        cfg,
        personaStep,
        guardStep,
        stage,
        stageFiles,
        cumulativeFiles,
        maxAttempts,
        missingVariable,
        fileFailureCounts,
        baselineTypecheck,
        planFiles: recordedPlan.planFiles,
        missingFiles,
        stagesTotal: stages.length,
      });

      totalAttempts += stageOutcome.attempts;
      missingFiles = stageOutcome.missingFiles;
      lastValidationErrors = stageOutcome.lastValidationErrors;

      if (stageOutcome.kind === "failed") {
        if (stageOutcome.result) {
          return stageOutcome.result;
        }
        if (this.isScopeExpansionActive(context)) {
          context.logger.warn(
            "Scope-expanded plan step failed - stopping before downstream stages",
            {
              workflowId: context.workflowId,
              failedStage: `${stage.index}/${stages.length}`,
              stageGoal: stage.goal || undefined,
            },
          );
          return this.buildExhaustionFailure(
            context,
            stage,
            stages.length,
            maxAttempts,
            totalAttempts,
            missingFiles,
            lastValidationErrors,
            missingVariable,
          );
        }
        if (cfg.continueOnStageFailure && stages.length > 1) {
          failedStages.push({
            stage,
            errors: stageOutcome.lastValidationErrors,
          });
          context.logger.warn(
            "Plan step failed - continuing with remaining steps",
            {
              workflowId: context.workflowId,
              failedStage: `${stage.index}/${stages.length}`,
              stageGoal: stage.goal || undefined,
            },
          );
          continue;
        }
        return this.buildExhaustionFailure(
          context,
          stage,
          stages.length,
          maxAttempts,
          totalAttempts,
          missingFiles,
          lastValidationErrors,
          missingVariable,
        );
      }

      for (const file of stageOutcome.appliedFiles) {
        appliedAllStages.add(file);
      }
      if (stageOutcome.commit) {
        lastCommit = stageOutcome.commit;
      }
    }

    if (failedStages.length > 0) {
      const mergedErrors = failedStages.flatMap((entry) => entry.errors);
      const stageList = failedStages
        .map(
          (entry) =>
            `step ${entry.stage.index}/${stages.length}${entry.stage.goal ? ` ("${entry.stage.goal.slice(0, 60)}")` : ""}`,
        )
        .join(", ");
      context.setVariable("implementation_attempts", totalAttempts);
      context.setVariable(missingVariable, missingFiles);
      context.setVariable(
        "implementation_config_validation_errors_full",
        mergedErrors,
      );
      context.setVariable(
        "implementation_config_validation_errors",
        this.compactValidationErrors(mergedErrors),
      );
      context.setVariable(
        "implementation_config_validation_summary",
        this.formatValidationSummary(mergedErrors),
      );
      context.setVariable("last_applied_files", Array.from(appliedAllStages));
      if (lastCommit) {
        context.setVariable("last_apply_commit_sha", lastCommit.sha);
        context.setVariable("last_apply_branch", lastCommit.branch);
      }

      return {
        status: "failure",
        error: new Error(
          `Implementation completed ${stages.length - failedStages.length}/${stages.length} plan steps; ` +
            `failed: ${stageList}. Completed steps remain committed.`,
        ),
        data: {
          attempts: totalAttempts,
          missingFiles,
          failedStages: failedStages.map((entry) => entry.stage.index),
          completedStages: stages.length - failedStages.length,
          stages: stages.length,
        },
      } satisfies StepResult;
    }

    context.logger.info("Implementation loop completed", {
      workflowId: context.workflowId,
      attempts: totalAttempts,
      stages: stages.length,
      commitSha: lastCommit?.sha,
    });
    context.setVariable("implementation_attempts", totalAttempts);
    context.setVariable(missingVariable, []);
    context.setVariable("implementation_guard_missing_summary", "");
    context.setVariable("implementation_config_validation_errors", []);
    context.setVariable("implementation_config_validation_errors_full", []);
    context.setVariable("implementation_config_validation_summary", "");
    if (lastCommit) {
      context.setVariable("last_apply_commit_sha", lastCommit.sha);
      context.setVariable("last_apply_branch", lastCommit.branch);
      context.setStepOutput("apply_implementation_edits", {
        ...(context.getStepOutput("apply_implementation_edits") || {}),
        commit_sha: lastCommit.sha,
        branch: lastCommit.branch,
      });
    }
    context.setVariable("last_applied_files", Array.from(appliedAllStages));

    return {
      status: "success",
      outputs: {
        attempts: totalAttempts,
        stages: stages.length,
        missing_files: [],
        plan_key_files: recordedPlan.planFiles,
        commit_sha: lastCommit?.sha,
      },
    } satisfies StepResult;
  }

  private async runStage(input: {
    context: WorkflowContext;
    cfg: ImplementationLoopConfig;
    personaStep: PersonaRequestStep;
    guardStep: PlanKeyFileGuardStep;
    stage: ImplementationStage;
    stageFiles: string[];
    cumulativeFiles: Set<string>;
    maxAttempts: number;
    missingVariable: string;
    fileFailureCounts: Map<string, number>;
    baselineTypecheck: Set<string> | null;
    planFiles: string[];
    missingFiles: string[];
    stagesTotal: number;
  }): Promise<
    | {
        kind: "completed";
        attempts: number;
        appliedFiles: string[];
        commit: { sha: string; branch: string } | null;
        missingFiles: string[];
        lastValidationErrors: ConfigValidationError[];
      }
    | {
        kind: "failed";
        attempts: number;
        missingFiles: string[];
        lastValidationErrors: ConfigValidationError[];
        result?: StepResult;
      }
  > {
    const {
      context,
      cfg,
      personaStep,
      guardStep,
      stage,
      stageFiles,
      cumulativeFiles,
      maxAttempts,
      missingVariable,
      fileFailureCounts,
      baselineTypecheck,
      planFiles,
      stagesTotal,
    } = input;

    let missingFiles = input.missingFiles;
    let lastValidationErrors: ConfigValidationError[] = [];
    let previousFailureSummary = "";
    const noEffectiveChangeCounts = new Map<string, number>();
    const extraSnippetFiles = new Set<string>();
    let attempt = 0;
    let effectiveMaxAttempts = maxAttempts;

    while (attempt < effectiveMaxAttempts) {
      attempt++;
      const stageMissing = this.intersectFiles(missingFiles, stageFiles);
      context.logger.info("Implementation loop attempt", {
        workflowId: context.workflowId,
        stage: `${stage.index}/${stagesTotal}`,
        stageGoal: stage.goal || undefined,
        attempt,
        maxAttempts,
        missingBeforeAttempt: stageMissing,
      });

      context.setVariable("implementation_retry_attempt", attempt);
      context.setVariable(missingVariable, stageMissing);
      this.updateRequiredFilePromptState(context, stageFiles, stageMissing);
      context.setVariable(
        "implementation_guard_missing_summary",
        stageMissing.join(", "),
      );

      const attemptCheckpoint = await this.resolveHead(context);
      let appliedFiles: string[] = [];

      if (attempt === maxAttempts) {
        context.setVariable("implementation_prefer_full_file", true);
      }

      await this.loadPlanFileSnippets(
        context,
        Array.from(new Set([...stageFiles, ...extraSnippetFiles])).slice(
          0,
          MAX_AUTO_SNIPPET_FILES,
        ),
      );
      await this.loadPlanArtifactText(context);

      const personaResult = await personaStep.execute(context);
      if (personaResult.status !== "success") {
        if (this.isInformationRequestLoopResult(personaResult)) {
          lastValidationErrors = [
            this.buildNoEditValidationError(
              "Lead engineer repeated information requests instead of returning implementation edits.",
            ),
          ];
          this.recordNoEditFailure(context, lastValidationErrors);
          this.resetImplementationInformationLoopState(context);
        }
        if (attempt < effectiveMaxAttempts) {
          const failureReason =
            personaResult.error?.message || "Unknown persona failure";
          if (/aborted after|timed out/i.test(failureReason)) {
            context.setVariable("implementation_prefer_full_file", false);
            lastValidationErrors = [
              this.buildNoEditValidationError(
                "The previous response was so large that the model timed out before finishing. " +
                  "Respond with SMALL, focused unified diffs for the fewest files possible - do not rewrite whole files.",
              ),
            ];
            this.recordNoEditFailure(context, lastValidationErrors);
            context.logger.warn(
              "Persona request timed out - de-escalating to minimal diff mode for retry",
              {
                workflowId: context.workflowId,
                attempt,
                maxAttempts,
              },
            );
            continue;
          }
          context.logger.warn(
            "Persona request failed, retrying implementation attempt",
            {
              workflowId: context.workflowId,
              attempt,
              maxAttempts,
              failureReason,
            },
          );
          continue;
        }
        return {
          kind: "failed",
          attempts: attempt,
          missingFiles,
          lastValidationErrors,
          result: personaResult,
        };
      }
      this.syncStepOutput(
        context,
        "implementation_request",
        personaResult,
      );
      if (!this.hasImplementationEditContent(personaResult)) {
        const reason = this.isInformationRequestLoopResult(personaResult)
          ? "Lead engineer repeated information requests instead of returning implementation edits."
          : "Lead engineer returned no diff or file rewrite content.";
        lastValidationErrors = [this.buildNoEditValidationError(reason)];
        this.recordNoEditFailure(context, lastValidationErrors);
        if (this.isInformationRequestLoopResult(personaResult)) {
          this.resetImplementationInformationLoopState(context);
        }
        if (attempt < maxAttempts) {
          context.logger.warn(
            "Implementation attempt produced no edits, retrying",
            {
              workflowId: context.workflowId,
              attempt,
              maxAttempts,
              reason,
            },
          );
          continue;
        }
        break;
      }

      const outputHealthErrors =
        this.evaluateImplementationOutputHealth(personaResult);
      if (outputHealthErrors.length > 0) {
        lastValidationErrors = outputHealthErrors;
        this.recordNoEditFailure(context, outputHealthErrors);
        context.setVariable("implementation_prefer_full_file", false);
        context.logger.warn(
          "Implementation response failed output health gate, retrying before diff apply",
          {
            workflowId: context.workflowId,
            attempt,
            maxAttempts,
            errors: outputHealthErrors,
          },
        );
        if (attempt < maxAttempts) {
          continue;
        }
        break;
      }

      const missingPlanGateErrors = this.evaluateMissingPlanFileEditGate(
        personaResult,
        stageMissing,
      );
      if (missingPlanGateErrors.length > 0) {
        lastValidationErrors = missingPlanGateErrors;
        this.recordNoEditFailure(context, missingPlanGateErrors);
        context.logger.warn(
          "Implementation response omitted still-missing plan files before apply",
          {
            workflowId: context.workflowId,
            attempt,
            maxAttempts,
            missingFiles: stageMissing,
            gateErrors: missingPlanGateErrors,
          },
        );
        if (attempt < maxAttempts) {
          continue;
        }
        break;
      }

      const diffStep = new DiffApplyStep({
        name: "apply_implementation_edits",
        type: "DiffApplyStep",
        config: this.buildDiffConfig(
          cfg,
          context,
          attempt,
          stage,
          stagesTotal,
          stageFiles,
          stageMissing,
        ),
      });

      const diffResult = await diffStep.execute(context);
      if (diffResult.status !== "success") {
        const applyFailures = this.extractApplyFailures(diffResult);
        if (applyFailures.length > 0) {
          lastValidationErrors = applyFailures;
          context.setVariable(
            "implementation_config_validation_errors_full",
            applyFailures,
          );
          context.setVariable(
            "implementation_config_validation_errors",
            this.compactValidationErrors(applyFailures),
          );
          context.setVariable(
            "implementation_config_validation_summary",
            this.formatValidationSummary(applyFailures),
          );

          let triggerFullRewrite = false;
          for (const failure of applyFailures) {
            const currentCount = (fileFailureCounts.get(failure.file) || 0) + 1;
            fileFailureCounts.set(failure.file, currentCount);

            const isStructural = /structurally invalid|unbalanced/i.test(failure.reason);
            const isDiffFail = /hunk context does not match|patch does not apply|stale or invented/i.test(failure.reason);

            if (isStructural || isDiffFail) {
              context.logger.info(`Immediate full-file rewrite triggered for ${failure.file} due to apply failure`, {
                reason: failure.reason,
              });
              triggerFullRewrite = true;
            } else {
              context.logger.info(`First diff failure for ${failure.file}. Retrying with diff and better context context/smaller hunks without full-file rewrite.`, {
                reason: failure.reason,
                failureCount: currentCount,
              });
            }
          }

          if (triggerFullRewrite) {
            context.setVariable("implementation_prefer_full_file", true);
          } else {
            context.setVariable("implementation_prefer_full_file", false);
          }
        }
        if (attempt < effectiveMaxAttempts) {
          context.logger.warn(
            "Diff application failed, retrying implementation attempt",
            {
              workflowId: context.workflowId,
              attempt,
              maxAttempts,
              failureReason:
                diffResult.error?.message || "Unknown diff failure",
              applyFailures,
            },
          );
          await this.loadPlanFileSnippets(
            context,
            this.mergeSnippetFiles(stageFiles, applyFailures),
          );
          await this.resetStagedChanges(context);
          continue;
        }
        await this.resetStagedChanges(context);
        return {
          kind: "failed",
          attempts: attempt,
          missingFiles,
          lastValidationErrors,
          result: diffResult,
        };
      }
      this.syncStepOutput(context, "apply_implementation_edits", diffResult);
      appliedFiles = this.extractAppliedFiles(diffResult);

      const scopeTouchErrors = this.evaluateScopeRootCauseTouchGate(
        context,
        appliedFiles,
        stageFiles,
      );
      if (scopeTouchErrors.length > 0) {
        lastValidationErrors = scopeTouchErrors;
        this.recordNoEditFailure(context, scopeTouchErrors);
        for (const failure of scopeTouchErrors) {
          const details = (failure as any).details;
          if (Array.isArray(details?.required_root_cause_files)) {
            for (const file of details.required_root_cause_files) {
              extraSnippetFiles.add(this.normalizeRelativePath(file));
            }
          }
        }
        context.logger.warn(
          "Scope-expanded implementation omitted root-cause edits",
          {
            workflowId: context.workflowId,
            attempt,
            appliedFiles,
            errors: scopeTouchErrors,
          },
        );
        await this.rollbackAttempt(context, attemptCheckpoint, appliedFiles);
        if (attempt < effectiveMaxAttempts) {
          continue;
        }
        break;
      }

      const guardResult = await guardStep.execute(context);
      if (guardResult.status !== "success") {
        await this.rollbackAttempt(context, attemptCheckpoint, appliedFiles);
        return {
          kind: "failed",
          attempts: attempt,
          missingFiles,
          lastValidationErrors,
          result: guardResult,
        };
      }
      this.syncStepOutput(context, "verify_plan_key_files", guardResult);

      missingFiles = this.extractMissingFiles(guardResult);
      const gatedMissing = this.intersectFiles(
        missingFiles,
        Array.from(cumulativeFiles),
      );
      this.updateRequiredFilePromptState(context, stageFiles, gatedMissing);
      const validationErrors = this.evaluateConfigValidation(
        context,
        appliedFiles,
        stageFiles,
      );
      let typecheckErrors = await this.evaluateTypecheckValidation(
        context,
        appliedFiles,
        baselineTypecheck,
      );

      if (typecheckErrors.length > 0) {
        const repairs = await repairRelativeImportErrors(
          context.repoRoot,
          typecheckErrors,
          [...appliedFiles, ...stageFiles],
        );
        if (repairs.length > 0) {
          context.logger.info(
            "Applied deterministic import path repairs, revalidating",
            {
              workflowId: context.workflowId,
              attempt,
              repairs: repairs.map((r) => `${r.file}: ${r.from} -> ${r.to}`),
            },
          );
          for (const repair of repairs) {
            if (!appliedFiles.includes(repair.file)) {
              appliedFiles.push(repair.file);
            }
          }
          typecheckErrors = await this.evaluateTypecheckValidation(
            context,
            appliedFiles,
            baselineTypecheck,
          );
        }
      }

      const combinedValidationErrors = [...validationErrors, ...typecheckErrors];
      lastValidationErrors = combinedValidationErrors;
      const editableValidationFiles = Array.from(
        new Set([
          ...stageFiles,
          ...Array.from(cumulativeFiles),
          ...planFiles,
          ...appliedFiles,
        ].map((file) => this.normalizeRelativePath(file))),
      );
      const scopedFailures = classifyValidationFailures(
        typecheckErrors.filter((error) =>
          /^TS\d+$/.test((error as TypecheckValidationError).code || ""),
        ),
        editableValidationFiles,
      );
      const scopeExpansion = summarizeScopeExpansion(scopedFailures);
      if (scopeExpansion.requiredFiles.length > 0) {
        await this.rollbackAttempt(context, attemptCheckpoint, appliedFiles);
        const decision = {
          status: "requires_scope_expansion",
          reason: "validation_failed_in_out_of_scope_files",
          editable_files: editableValidationFiles,
          required_files: scopeExpansion.requiredFiles,
          blocked_files: scopeExpansion.blockedFiles,
          recommendations: [
            "Regenerate the plan with the required files in scope or merge related baseline repair tasks into a single repair cluster.",
          ],
        };
        context.setVariable("scope_viability", decision);
        context.setVariable("scope_viability_status", decision.status);
        context.setVariable(
          "scope_viability_required_files",
          decision.required_files,
        );
        context.setVariable(
          "scope_viability_blocked_files",
          decision.blocked_files,
        );
        context.setVariable(
          "implementation_config_validation_errors_full",
          combinedValidationErrors,
        );
        context.setVariable(
          "implementation_config_validation_errors",
          this.compactValidationErrors(combinedValidationErrors),
        );
        context.setVariable(
          "implementation_config_validation_summary",
          this.formatValidationSummary(combinedValidationErrors),
        );
        return {
          kind: "failed",
          attempts: attempt,
          missingFiles,
          lastValidationErrors,
          result: {
            status: "failure",
            error: new Error(
              `Implementation requires out-of-scope files: ${scopeExpansion.requiredFiles.join(", ")}`,
            ),
            data: decision,
            outputs: decision,
          },
        };
      }

      if (gatedMissing.length === 0 && combinedValidationErrors.length === 0) {
        let commitResult: { sha: string; branch: string };
        try {
          commitResult = await this.commitValidatedAttempt(
            context,
            appliedFiles,
            this.resolveStageCommitMessage(
              context,
              cfg.diffConfig,
              attempt,
              stage,
              stagesTotal,
            ),
          );
        } catch (error) {
          if (!this.isNoEffectiveChangeError(error)) {
            throw error;
          }

          const noEffectiveChangeSignature =
            this.buildNoEffectiveChangeSignature(appliedFiles);
          const repeatedNoEffectiveChanges =
            (noEffectiveChangeCounts.get(noEffectiveChangeSignature) || 0) + 1;
          noEffectiveChangeCounts.set(
            noEffectiveChangeSignature,
            repeatedNoEffectiveChanges,
          );
          const repeatedNoop = repeatedNoEffectiveChanges >= 2;

          lastValidationErrors = [
            this.buildNoEditValidationError(
              `${repeatedNoop ? "Repeated " : ""}${NO_EFFECTIVE_CHANGE_MESSAGE}. The previous response rewrote files that already matched the working tree. ` +
                "Do not repeat an unchanged full-file rewrite. Make a concrete edit to one of the stage files that addresses the unresolved task, " +
                "or explicitly report that the task is already resolved if no relevant compile error remains.",
            ),
          ];
          this.recordNoEditFailure(context, lastValidationErrors);
          context.setVariable("implementation_prefer_full_file", false);
          for (const file of stageFiles) {
            extraSnippetFiles.add(this.normalizeRelativePath(file));
          }
          context.logger.warn(
            "Implementation attempt produced no effective committed changes, retrying",
            {
              workflowId: context.workflowId,
              attempt,
              maxAttempts,
              appliedFiles,
              stageFiles,
              repeatedNoEffectiveChanges,
            },
          );
          await this.rollbackAttempt(context, attemptCheckpoint, appliedFiles);
          if (repeatedNoop) {
            context.setVariable("implementation_attempts", attempt);
            context.setVariable(
              "implementation_no_effective_change_repeated",
              true,
            );
            context.setVariable(
              "implementation_no_effective_change_signature",
              noEffectiveChangeSignature,
            );
            return {
              kind: "failed",
              attempts: attempt,
              missingFiles,
              lastValidationErrors,
              result: {
                status: "failure",
                error: new Error(
                  "Implementation is repeating the same no-op edit. The stage is already resolved for those files or the repair scope is wrong.",
                ),
                data: {
                  reason: "already_resolved_or_bad_scope",
                  repeatedNoEffectiveChanges,
                  noEffectiveChangeSignature,
                  appliedFiles,
                  stageFiles,
                },
                outputs: {
                  reason: "already_resolved_or_bad_scope",
                  repeatedNoEffectiveChanges,
                  noEffectiveChangeSignature,
                  appliedFiles,
                  stageFiles,
                },
              },
            };
          }
          continue;
        }
        context.logger.info("Implementation stage completed", {
          workflowId: context.workflowId,
          stage: `${stage.index}/${stagesTotal}`,
          stageGoal: stage.goal || undefined,
          attempts: attempt,
          commitSha: commitResult.sha,
        });
        context.setVariable("implementation_config_validation_errors", []);
        context.setVariable("implementation_config_validation_errors_full", []);
        context.setVariable("implementation_config_validation_summary", "");
        return {
          kind: "completed",
          attempts: attempt,
          appliedFiles,
          commit: { sha: commitResult.sha, branch: commitResult.branch },
          missingFiles,
          lastValidationErrors: [],
        };
      }

      if (combinedValidationErrors.length > 0) {
        context.logger.warn("Config validation detected errors", {
          workflowId: context.workflowId,
          attempt,
          files: combinedValidationErrors.map((entry) => entry.file),
        });

        const rawSummary = this.formatValidationSummary(
          combinedValidationErrors,
        );
        const isRepeatFailure =
          rawSummary.length > 0 && rawSummary === previousFailureSummary;
        const madeProgress =
          attempt > 1 &&
          previousFailureSummary.length > 0 &&
          rawSummary !== previousFailureSummary;
        previousFailureSummary = rawSummary;
        if (
          madeProgress &&
          attempt >= effectiveMaxAttempts &&
          effectiveMaxAttempts < maxAttempts + MAX_CONVERGENCE_BONUS_ATTEMPTS
        ) {
          effectiveMaxAttempts++;
          context.logger.info(
            "Validation errors changed between attempts - granting a convergence bonus attempt",
            {
              workflowId: context.workflowId,
              attempt,
              effectiveMaxAttempts,
            },
          );
        }
        if (isRepeatFailure) {
          context.logger.warn(
            "Identical validation failure repeated across attempts - sharpening retry instruction",
            {
              workflowId: context.workflowId,
              attempt,
            },
          );
        }

        for (const failure of combinedValidationErrors) {
          const failureFile = this.normalizeRelativePath(failure.file);
          if (failureFile && !failureFile.startsWith("__")) {
            extraSnippetFiles.add(failureFile);
          }
        }

        const directives: string[] = [];

        if (isRepeatFailure) {
          directives.push(
            "REPEATED FAILURE: your previous attempt produced these exact same errors. " +
              "The file contents provided in this prompt are the source of truth. " +
              "Do NOT change any import or module paths that the diagnostics do not explicitly name, " +
              "and copy unchanged lines exactly as they appear.",
          );
        }

        const typeNames = extractTypeNamesFromDiagnostics(typecheckErrors);
        if (typeNames.length > 0) {
          const definitionFiles = await locateTypeDefinitionFiles(
            context.repoRoot,
            typeNames,
            context.getVariable("repoScan") as Array<{ path: string }> | null,
          );
          if (definitionFiles.length > 0) {
            for (const file of definitionFiles) {
              extraSnippetFiles.add(file);
            }
            const definitionSummary = await summarizeTypeDefinitions(
              context.repoRoot,
              definitionFiles,
              typeNames,
            );
            if (definitionSummary) {
              directives.push(
                "These type definitions are authoritative:\n" +
                  definitionSummary,
              );
            }
            const offending = extractOffendingProperties(typecheckErrors);
            if (offending.length > 0) {
              directives.push(
                `The properties ${offending.map((p) => `'${p}'`).join(", ")} do NOT exist on the type(s) above. ` +
                  "Remove or replace every occurrence in the file - including object literals AND test assertions " +
                  "that read those properties. Choose replacements only from the properties the definitions declare. " +
                  "Do not use type casts to bypass these errors.",
              );
            }
            const invalidLiterals = extractInvalidUnionLiteralUses(typecheckErrors);
            if (invalidLiterals.length > 0) {
              const invalidList = invalidLiterals
                .map((item) => `"${item.literal}" for ${item.typeName}`)
                .join(", ");
              directives.push(
                `The literal value(s) ${invalidList} are not members of the target union type(s). ` +
                  "Replace them with literal values declared in the authoritative definitions above. " +
                  "Do not write casts such as `as LogEventType` or `as any` to silence the compiler.",
              );
            }
          }
        }
        const primitiveDirective =
          await this.buildPrimitiveAssignabilityDirective(
            context.repoRoot,
            typecheckErrors,
          );
        if (primitiveDirective) {
          directives.push(primitiveDirective);
        }

        context.setVariable(
          "implementation_retry_directives",
          directives.join("\n\n"),
        );
        context.setVariable(
          "implementation_config_validation_errors_full",
          combinedValidationErrors,
        );
        context.setVariable(
          "implementation_config_validation_errors",
          this.compactValidationErrors(combinedValidationErrors),
        );
        context.setVariable(
          "implementation_config_validation_summary",
          rawSummary,
        );

        let triggerFullRewrite = false;
        for (const failure of combinedValidationErrors) {
          const currentCount = (fileFailureCounts.get(failure.file) || 0) + 1;
          fileFailureCounts.set(failure.file, currentCount);

          const isStructural = /structurally invalid|unbalanced/i.test(failure.reason);
          if (isStructural) {
            context.logger.info(`Immediate full-file rewrite triggered for ${failure.file} due to structural validation error`, {
              reason: failure.reason,
            });
            triggerFullRewrite = true;
          } else if (currentCount >= 2) {
            context.logger.info(`Full-file rewrite triggered for ${failure.file} after ${currentCount} validation failures`, {
              reason: failure.reason,
            });
            triggerFullRewrite = true;
          }
        }

        if (triggerFullRewrite) {
          context.setVariable("implementation_prefer_full_file", true);
        } else {
          context.setVariable("implementation_prefer_full_file", false);
        }

        await this.rollbackAttempt(context, attemptCheckpoint, appliedFiles);
        if (attempt >= effectiveMaxAttempts) {
          break;
        }
        continue;
      }

      if (attempt >= effectiveMaxAttempts) {
        await this.rollbackAttempt(context, attemptCheckpoint, appliedFiles);
        break;
      }

      context.logger.warn("Plan files still missing after attempt", {
        workflowId: context.workflowId,
        attempt,
        missingFiles: gatedMissing,
      });
      this.updateRequiredFilePromptState(context, stageFiles, gatedMissing);
      await this.rollbackAttempt(context, attemptCheckpoint, appliedFiles);
    }

    return {
      kind: "failed",
      attempts: attempt,
      missingFiles,
      lastValidationErrors,
    };
  }

  private buildExhaustionFailure(
    context: WorkflowContext,
    stage: ImplementationStage,
    stagesTotal: number,
    maxAttempts: number,
    totalAttempts: number,
    missingFiles: string[],
    lastValidationErrors: ConfigValidationError[],
    missingVariable: string,
  ): StepResult {
    context.setVariable("implementation_attempts", totalAttempts);
    context.setVariable(missingVariable, missingFiles);
    context.setVariable(
      "implementation_guard_missing_summary",
      missingFiles.join(", "),
    );
    context.setVariable(
      "implementation_config_validation_errors_full",
      lastValidationErrors,
    );
    context.setVariable(
      "implementation_config_validation_errors",
      this.compactValidationErrors(lastValidationErrors),
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
    const stageLabel =
      stagesTotal > 1
        ? ` on plan step ${stage.index}/${stagesTotal}${stage.goal ? ` ("${stage.goal.slice(0, 80)}")` : ""}; earlier completed steps remain committed`
        : "";
    const errorMessage = `Implementation loop exhausted ${maxAttempts} attempt(s)${stageLabel} (${reasonSummary}).`;

    return {
      status: "failure",
      error: new Error(errorMessage),
      data: {
        attempts: totalAttempts,
        missingFiles,
        failedStage: stage.index,
        stages: stagesTotal,
      },
    } satisfies StepResult;
  }

  private setStageVariables(
    context: WorkflowContext,
    stage: ImplementationStage,
    stagesTotal: number,
    stageFiles: string[],
  ): void {
    const stepwise = stagesTotal > 1;
    context.setVariable("implementation_step_index", stage.index);
    context.setVariable("implementation_step_total", stagesTotal);
    context.setVariable(
      "implementation_step_goal",
      stepwise ? stage.goal : "",
    );
    context.setVariable("implementation_step_files", stageFiles);
    context.setVariable(
      "implementation_step_files_summary",
      stageFiles.join(", "),
    );
    context.setVariable("implementation_step_acceptance", stage.acceptance);
  }

  private intersectFiles(files: string[], scope: string[]): string[] {
    const scopeSet = new Set(
      scope.map((file) => this.normalizeRelativePath(file)),
    );
    return this.normalizeStringArray(files).filter((file) =>
      scopeSet.has(this.normalizeRelativePath(file)),
    );
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
    cfg: ImplementationLoopConfig,
    context: WorkflowContext,
    attempt: number,
    stage: ImplementationStage,
    stagesTotal: number,
    stageFiles: string[],
    stageMissing: string[],
  ): DiffApplyStepConfig {
    const diffConfig = cfg.diffConfig;
    const commitMessage = this.resolveStageCommitMessage(
      context,
      diffConfig,
      attempt,
      stage,
      stagesTotal,
    );

    const allowedPaths =
      cfg.enforcePlanScope === false
        ? undefined
        : Array.from(new Set([...stageFiles, ...stageMissing]));

    return {
      source_output: diffConfig?.source_output || "implementation_request",
      source_variable: diffConfig?.source_variable,
      validation: diffConfig?.validation || "syntax_check",
      backup: diffConfig?.backup,
      max_file_size: diffConfig?.max_file_size,
      blocked_extensions: diffConfig?.blocked_extensions,
      commit_message: diffConfig?.commit_message || commitMessage,
      commit: false,
      dry_run: diffConfig?.dry_run,
      allowed_paths: allowedPaths,
    } satisfies DiffApplyStepConfig;
  }

  private resolveStageCommitMessage(
    context: WorkflowContext,
    diffConfig: Partial<DiffApplyStepConfig> | undefined,
    attempt: number,
    stage: ImplementationStage,
    stagesTotal: number,
  ): string {
    if (diffConfig?.commit_message) {
      return diffConfig.commit_message;
    }
    const baseCommit = this.resolveCommitMessage(context);
    const stageSuffix =
      stagesTotal > 1
        ? ` (step ${stage.index}/${stagesTotal}${stage.goal ? `: ${stage.goal.slice(0, 50)}` : ""})`
        : "";
    const attemptSuffix = attempt > 1 ? ` (attempt ${attempt})` : "";
    return `${baseCommit}${stageSuffix}${attemptSuffix}`;
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
    const activePlanStep = this.getActivePlanStep(context, {
      planStep: guardOverride?.plan_step,
    } as ImplementationLoopConfig);
    const additionalFromOverride = Array.isArray(
      guardOverride?.additional_files,
    )
      ? guardOverride?.additional_files ?? []
      : [];
    const additionalFiles = Array.from(
      new Set([...(recorded.planFiles || []), ...additionalFromOverride]),
    );

    return {
      plan_step: activePlanStep,
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

  private getActivePlanStep(
    context: WorkflowContext,
    cfg: Pick<ImplementationLoopConfig, "planStep">,
  ): string {
    const fromContext = context.getVariable("implementation_plan_step");
    if (typeof fromContext === "string" && fromContext.trim().length > 0) {
      return fromContext.trim();
    }
    if (cfg.planStep && cfg.planStep.trim().length > 0) {
      return cfg.planStep.trim();
    }
    return "planning_loop";
  }

  private getRecordedPlanMetadata(context: WorkflowContext) {
    const recordOutput = context.getStepOutput("record_plan_key_files");
    const planFiles =
      this.firstNonEmptyStringArray(
        context.getVariable("plan_required_files"),
        context.getVariable("planning_loop_plan_files"),
        recordOutput?.key_files,
        recordOutput?.keyFiles,
      );
    const planFileSet = new Set(planFiles);
    const missingFiles = this.firstNonEmptyStringArray(
      recordOutput?.missing_files,
      recordOutput?.missingFiles,
    ).filter((file) => planFileSet.size === 0 || planFileSet.has(file));

    return { planFiles, missingFiles } as {
      planFiles: string[];
      missingFiles: string[];
    };
  }

  private firstNonEmptyStringArray(...values: unknown[]): string[] {
    for (const value of values) {
      const normalized = this.normalizeStringArray(value);
      if (normalized.length > 0) {
        return normalized;
      }
    }
    return [];
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

  private updateRequiredFilePromptState(
    context: WorkflowContext,
    planFiles: string[],
    missingFiles: string[],
  ): void {
    const requiredFiles = Array.from(
      new Set([
        ...this.normalizeStringArray(planFiles),
        ...this.normalizeStringArray(missingFiles),
      ]),
    );
    const missing = this.normalizeStringArray(missingFiles);

    context.setVariable("implementation_required_files", requiredFiles);
    context.setVariable("implementation_missing_plan_files", missing);
    context.setVariable(
      "implementation_required_files_summary",
      requiredFiles.join(", "),
    );
    context.setVariable(
      "implementation_missing_plan_files_summary",
      missing.join(", "),
    );
  }

  private mergeSnippetFiles(
    planFiles: string[],
    failures: ConfigValidationError[],
  ): string[] {
    const failureFiles = failures.map((failure) => failure.file);
    return Array.from(
      new Set([
        ...this.normalizeStringArray(planFiles),
        ...this.normalizeStringArray(failureFiles),
      ]),
    ).slice(0, MAX_AUTO_SNIPPET_FILES);
  }

  private isInformationRequestLoopResult(result: StepResult): boolean {
    const data = result.data as any;
    const outputs = result.outputs as any;
    return Boolean(
      data?.forcedInformationFailure ||
        data?.forcedCompletion ||
        outputs?.forcedCompletion ||
        outputs?.system_note?.reason ===
          "forced_completion_due_to_duplicate_information_requests",
    );
  }

  private evaluateMissingPlanFileEditGate(
    result: StepResult,
    missingFiles: string[],
  ): ConfigValidationError[] {
    const requiredMissing = this.normalizeStringArray(missingFiles).map((file) =>
      this.normalizeRelativePath(file),
    );
    if (requiredMissing.length === 0) {
      return [];
    }

    const editedFiles = this.extractEditedFilesFromPersonaResult(result);
    const omitted = requiredMissing.filter((file) => !editedFiles.has(file));
    if (omitted.length === 0) {
      return [];
    }

    return omitted.map((file) => ({
      file,
      reason:
        "Implementation response did not include edits for this still-missing plan file. " +
        "Create or update every missing plan file in the same response before any edits are applied.",
    }));
  }

  private evaluateScopeRootCauseTouchGate(
    context: WorkflowContext,
    appliedFiles: string[],
    stageFiles: string[],
  ): ConfigValidationError[] {
    if (!this.isScopeExpansionActive(context)) {
      return [];
    }

    const requiredRootCauseFiles = this.normalizeStringArray([
      ...this.normalizeStringArray(
        context.getVariable("scope_viability_root_cause_files"),
      ),
      ...this.normalizeStringArray(
        context.getVariable("scope_viability_required_files"),
      ),
    ]);
    if (requiredRootCauseFiles.length === 0) {
      return [];
    }

    const stageFileSet = new Set(this.normalizeStringArray(stageFiles));
    const requiredInStage = requiredRootCauseFiles.filter((file) =>
      stageFileSet.has(file),
    );
    if (requiredInStage.length === 0) {
      return [];
    }

    const touchedFiles = new Set(this.normalizeStringArray(appliedFiles));
    const touchedRootCauseFiles = requiredInStage.filter((file) =>
      touchedFiles.has(file),
    );
    if (touchedRootCauseFiles.length > 0) {
      return [];
    }

    const touchedSummary =
      touchedFiles.size > 0 ? Array.from(touchedFiles).join(", ") : "none";
    return [
      {
        file: "__scope_viability__",
        reason:
          "Scope expansion determined this task cannot pass by editing only downstream files. " +
          `This stage must edit at least one root-cause file (${requiredInStage.join(", ")}), ` +
          `but the implementation only touched: ${touchedSummary}. ` +
          "Patch the shared schema/default/type source first, then make downstream test edits if still needed.",
        details: {
          required_root_cause_files: requiredInStage,
          applied_files: Array.from(touchedFiles),
        },
      } as ConfigValidationError,
    ];
  }

  private isScopeExpansionActive(context: WorkflowContext): boolean {
    return context.getVariable("scope_viability_status") === "requires_scope_expansion";
  }

  private extractEditedFilesFromPersonaResult(result: StepResult): Set<string> {
    const editedFiles = new Set<string>();
    for (const candidate of [result.outputs, result.data]) {
      this.collectEditedFiles(candidate, editedFiles);
    }
    return editedFiles;
  }

  private collectEditedFiles(value: unknown, editedFiles: Set<string>): void {
    if (!value) return;
    if (typeof value === "string") {
      const parseResult = DiffParser.parsePersonaResponse(value);
      if (parseResult.success && parseResult.editSpec?.ops) {
        for (const op of parseResult.editSpec.ops) {
          editedFiles.add(this.normalizeRelativePath(op.path));
        }
      }
      return;
    }
    if (Array.isArray(value)) {
      for (const entry of value) {
        this.collectEditedFiles(entry, editedFiles);
      }
      return;
    }
    if (typeof value !== "object") {
      return;
    }

    const output = value as Record<string, unknown>;
    if (Array.isArray(output.ops)) {
      for (const op of output.ops) {
        if (op && typeof op === "object" && typeof (op as any).path === "string") {
          editedFiles.add(this.normalizeRelativePath((op as any).path));
        }
      }
    }

    for (const field of [
      "diffs",
      "code_diffs",
      "implementation_diff",
      "diff",
      "output",
      "result",
    ]) {
      this.collectEditedFiles(output[field], editedFiles);
    }
  }

  private hasImplementationEditContent(result: StepResult): boolean {
    const candidates = [result.outputs, result.data];
    for (const candidate of candidates) {
      if (this.outputContainsEditContent(candidate)) {
        return true;
      }
    }
    return false;
  }

  private evaluateImplementationOutputHealth(
    result: StepResult,
  ): ConfigValidationError[] {
    const text = this.collectOutputText([result.outputs, result.data]);
    const truncated = this.hasTruncatedOutputMarker(result);
    const repetition = this.detectRunawayRepetition(text);

    if (!truncated && !repetition) {
      return [];
    }

    const reasons: string[] = [];
    if (truncated) {
      reasons.push(
        "the persona response was truncated at the model output token limit",
      );
    }
    if (repetition) {
      reasons.push(
        `the response appears to be stuck repeating variants of '${repetition.prefix}' (${repetition.count} similar lines)`,
      );
    }

    return [
      this.buildNoEditValidationError(
        `Lead engineer response was rejected before diff parsing because ${reasons.join(" and ")}. ` +
          "Retry with a SMALL, focused edit. Do not generate exhaustive test/config permutations or renamed variants. " +
          "When schema/defaults disagree, make one direct schema/defaults decision and patch only the necessary declarations.",
      ),
    ];
  }

  private hasTruncatedOutputMarker(result: StepResult): boolean {
    const candidates = [result.outputs, result.data];
    const visit = (value: unknown): boolean => {
      if (!value) return false;
      if (typeof value !== "object") return false;
      if (Array.isArray(value)) return value.some(visit);
      const record = value as Record<string, unknown>;
      if (record.truncated === true) return true;
      if (record.result && visit(record.result)) return true;
      if (record.output && visit(record.output)) return true;
      if (record.data && visit(record.data)) return true;
      return false;
    };
    return candidates.some(visit);
  }

  private collectOutputText(values: unknown[]): string {
    const chunks: string[] = [];
    const visit = (value: unknown): void => {
      if (!value) return;
      if (typeof value === "string") {
        chunks.push(value);
        return;
      }
      if (Array.isArray(value)) {
        value.forEach(visit);
        return;
      }
      if (typeof value !== "object") return;
      const record = value as Record<string, unknown>;
      for (const field of [
        "diffs",
        "code_diffs",
        "implementation_diff",
        "diff",
        "output",
        "result",
        "response",
        "data",
      ]) {
        visit(record[field]);
      }
    };
    values.forEach(visit);
    return chunks.join("\n");
  }

  private detectRunawayRepetition(
    text: string,
  ): { prefix: string; count: number; ratio: number } | null {
    if (text.length < RUNAWAY_RESPONSE_CHAR_THRESHOLD) {
      return null;
    }

    const prefixCounts = new Map<string, number>();
    let considered = 0;
    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (line.length < 32) continue;
      const identifierMatch = line.match(/\b[A-Za-z_$][A-Za-z0-9_$]{24,}\b/);
      if (!identifierMatch) continue;
      const prefix = this.repetitionPrefix(identifierMatch[0]);
      if (prefix.length < 16) continue;
      considered++;
      prefixCounts.set(prefix, (prefixCounts.get(prefix) || 0) + 1);
    }

    if (considered === 0) return null;

    let best: { prefix: string; count: number } | null = null;
    for (const [prefix, count] of prefixCounts) {
      if (!best || count > best.count) {
        best = { prefix, count };
      }
    }
    if (!best) return null;

    const ratio = best.count / considered;
    if (
      best.count >= REPETITIVE_PREFIX_THRESHOLD &&
      ratio >= REPETITIVE_PREFIX_MIN_RATIO
    ) {
      return { ...best, ratio };
    }
    return null;
  }

  private repetitionPrefix(identifier: string): string {
    const camelBoundary = identifier.search(/[A-Z][a-z0-9]*$/);
    if (camelBoundary >= 16) {
      return identifier.slice(0, camelBoundary);
    }
    return identifier.slice(0, 32);
  }

  private outputContainsEditContent(value: unknown): boolean {
    if (!value) return false;
    if (typeof value === "string") {
      return this.stringContainsEditContent(value);
    }
    if (Array.isArray(value)) {
      return value.some((entry) => this.outputContainsEditContent(entry));
    }
    if (typeof value !== "object") {
      return false;
    }

    const output = value as Record<string, unknown>;
    if (Array.isArray(output.ops) && output.ops.length > 0) {
      return true;
    }

    const directFields = [
      "diffs",
      "code_diffs",
      "implementation_diff",
      "diff",
      "output",
    ];
    for (const field of directFields) {
      const fieldValue = output[field];
      if (
        typeof fieldValue === "string" &&
        this.stringContainsEditContent(fieldValue)
      ) {
        return true;
      }
    }

    return this.outputContainsEditContent(output.result);
  }

  private stringContainsEditContent(value: string): boolean {
    const trimmed = value.trim();
    if (!trimmed) return false;
    return (
      /```(?:diff|file)\b/i.test(trimmed) ||
      /^<<<<<<< SEARCH$/m.test(trimmed) ||
      /^---\s+(?:a\/|\/dev\/null)/m.test(trimmed) ||
      /^\+\+\+\s+(?:b\/|\/dev\/null)/m.test(trimmed)
    );
  }

  private buildNoEditValidationError(reason: string): ConfigValidationError {
    return {
      file: "__implementation_request__",
      reason,
    };
  }

  private recordNoEditFailure(
    context: WorkflowContext,
    errors: ConfigValidationError[],
  ): void {
    const summary = this.formatValidationSummary(errors);
    const compactErrors = this.compactValidationErrors(errors);
    const infoBlocks = context.getVariable(
      "implementation_request_information_blocks",
    );
    const blocks = Array.isArray(infoBlocks)
      ? infoBlocks.map((entry) => String(entry))
      : [];
    const infoSummary = blocks.length > 0
      ? blocks.slice(-4).join("\n\n")
      : summary;
    context.setVariable("implementation_config_validation_errors_full", errors);
    context.setVariable("implementation_config_validation_errors", compactErrors);
    context.setVariable("implementation_config_validation_summary", summary);
    context.setVariable(
      "implementation_information_request_summary",
      infoSummary,
    );
  }

  private resetImplementationInformationLoopState(
    context: WorkflowContext,
  ): void {
    context.setVariable(
      "implementation_request_force_synthesis_due_to_duplicates",
      false,
    );
    context.setVariable(
      "implementation_request_duplicate_request_iterations",
      0,
    );
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

  private extractApplyFailures(result: StepResult): ConfigValidationError[] {
    const fromError = (result.error as any)?.failures;
    const fromData = (result.data as any)?.apply_failures;
    const raw = Array.isArray(fromError)
      ? fromError
      : Array.isArray(fromData)
        ? fromData
        : [];
    return raw
      .filter(
        (entry: any) =>
          entry &&
          typeof entry.path === "string" &&
          typeof entry.reason === "string",
      )
      .map((entry: any) => ({ file: entry.path, reason: entry.reason }));
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
      context.setVariable("implementation_config_validation_errors_full", []);
      context.setVariable("implementation_config_validation_summary", "");
      return [];
    }

    const errors = validateConfigFiles(context.repoRoot, candidates);
    const summary = this.formatValidationSummary(errors);
    context.setVariable("implementation_config_validation_errors_full", errors);
    context.setVariable(
      "implementation_config_validation_errors",
      this.compactValidationErrors(errors),
    );
    context.setVariable("implementation_config_validation_summary", summary);
    return errors;
  }

  private async captureBaselineTypecheck(
    context: WorkflowContext,
  ): Promise<Set<string> | null> {
    const command = await this.detectTypecheckCommand(context.repoRoot);
    if (!command) return null;

    try {
      await runTestCommandWithWorker({
        command,
        cwd: context.repoRoot,
        timeoutMs: 120000,
        idleTimeoutMs: 30000,
      });
      context.setVariable("implementation_typecheck_baseline_count", 0);
      return new Set();
    } catch (error: any) {
      const output =
        [error?.stdout, error?.stderr].filter(Boolean).join("\n") ||
        String(error?.message || "");
      const parsed = this.parseTypecheckErrors(output, context.repoRoot);
      if (parsed.length === 0) {
        context.logger.warn(
          "Baseline typecheck failed with unparseable output - strict typecheck gating in effect",
          { workflowId: context.workflowId },
        );
        return null;
      }
      context.setVariable(
        "implementation_typecheck_baseline_count",
        parsed.length,
      );
      context.logger.info(
        "Captured pre-existing typecheck errors as baseline",
        {
          workflowId: context.workflowId,
          baselineErrorCount: parsed.length,
        },
      );
      return new Set(parsed.map((entry) => typecheckErrorSignature(entry)));
    }
  }

  private async evaluateTypecheckValidation(
    context: WorkflowContext,
    appliedFiles: string[],
    baseline: Set<string> | null,
  ): Promise<ConfigValidationError[]> {
    const command = await this.detectTypecheckCommand(context.repoRoot);
    if (!command) {
      context.setVariable("implementation_typecheck_validation_errors", []);
      context.setVariable("implementation_typecheck_validation_errors_full", []);
      context.setVariable("implementation_typecheck_validation_summary", "");
      return [];
    }

    try {
      await runTestCommandWithWorker({
        command,
        cwd: context.repoRoot,
        timeoutMs: 120000,
        idleTimeoutMs: 30000,
      });
      context.setVariable("implementation_typecheck_validation_errors", []);
      context.setVariable("implementation_typecheck_validation_errors_full", []);
      context.setVariable("implementation_typecheck_validation_summary", "");
      return [];
    } catch (error: any) {
      const output =
        [error?.stdout, error?.stderr].filter(Boolean).join("\n") ||
        String(error?.message || "");
      const parsedErrors = this.parseTypecheckErrors(output, context.repoRoot);
      context.setVariable(
        "implementation_typecheck_validation_errors_full",
        parsedErrors,
      );

      const newErrors = baseline
        ? parsedErrors.filter(
            (entry) => !baseline.has(typecheckErrorSignature(entry)),
          )
        : parsedErrors;
      const preExisting = parsedErrors.length - newErrors.length;

      if (parsedErrors.length > 0 && newErrors.length === 0) {
        const ignoredSummary = this.formatValidationSummary(
          this.compactValidationErrors(parsedErrors),
        );
        context.setVariable("implementation_typecheck_preexisting_errors", parsedErrors);
        context.setVariable(
          "implementation_typecheck_preexisting_summary",
          ignoredSummary,
        );
        context.setVariable("implementation_typecheck_validation_errors", []);
        context.setVariable("implementation_typecheck_validation_summary", "");
        context.logger.info(
          "Typecheck failures are all pre-existing on the base revision - not counting against this change",
          {
            workflowId: context.workflowId,
            preExistingErrorCount: parsedErrors.length,
            appliedFiles,
          },
        );
        return [];
      }

      const errors =
        newErrors.length > 0
          ? newErrors
          : [
              {
                file: "typecheck",
                reason: `${command} failed${output ? `: ${this.truncateDiagnostic(output, MAX_RETRY_REASON_CHARS)}` : ""}`,
              },
            ];
      if (preExisting > 0) {
        context.logger.info("Typecheck delta computed", {
          workflowId: context.workflowId,
          newErrorCount: newErrors.length,
          preExistingErrorCount: preExisting,
        });
      }
      const summary = this.formatValidationSummary(errors);
      context.setVariable(
        "implementation_typecheck_validation_errors",
        this.compactValidationErrors(errors),
      );
      context.setVariable("implementation_typecheck_validation_summary", summary);
      return errors;
    }
  }

  private async detectTypecheckCommand(repoRoot: string): Promise<string | null> {
    try {
      const pkgRaw = await fs.readFile(path.join(repoRoot, "package.json"), "utf-8");
      const pkg = JSON.parse(pkgRaw);
      if (pkg?.scripts && typeof pkg.scripts.typecheck === "string") {
        return "npm run typecheck";
      }
    } catch {
      void 0;
    }

    try {
      await fs.access(path.join(repoRoot, "tsconfig.json"));
      return "npx tsc --noEmit";
    } catch {
      return null;
    }
  }

  private parseTypecheckErrors(
    output: string,
    repoRoot: string,
  ): TypecheckValidationError[] {
    const errors: TypecheckValidationError[] = [];
    const seen = new Set<string>();
    const lineRegex =
      /^([A-Za-z0-9_./\\:@+-]+\.(?:ts|tsx|js|jsx|mts|cts))\((\d+),(\d+)\):\s+error\s+(TS\d+):\s+(.+)$/;

    for (const rawLine of output.split(/\r?\n/)) {
      const line = rawLine.trim();
      const match = line.match(lineRegex);
      if (!match) continue;
      const file = this.normalizeDiagnosticPath(match[1], repoRoot);
      const key = `${file}:${match[2]}:${match[3]}:${match[4]}:${match[5]}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      errors.push({
        file,
        reason: `Typecheck ${match[4]} at ${file}:${match[2]}:${match[3]} - ${this.truncateDiagnostic(match[5], MAX_RETRY_REASON_CHARS)}`,
        code: match[4],
        message: match[5],
        line: Number(match[2]),
        column: Number(match[3]),
      });
    }

    return errors;
  }

  private async buildPrimitiveAssignabilityDirective(
    repoRoot: string,
    errors: ConfigValidationError[],
  ): Promise<string> {
    const mismatches = extractPrimitiveAssignabilityMismatches(errors);
    if (mismatches.length === 0) return "";

    const details: string[] = [];
    const seen = new Set<string>();
    for (const error of errors as TypecheckValidationError[]) {
      const message = error.message || error.reason || "";
      const matching = mismatches.find((mismatch) =>
        message.includes(
          `Type '${mismatch.actualType}' is not assignable to type '${mismatch.expectedType}'`,
        ),
      );
      if (!matching) continue;

      const property = await this.inferObjectPropertyFromDiagnosticLine(
        repoRoot,
        error,
      );
      const label = property
        ? `Property '${property}'`
        : `A value in ${error.file}`;
      const detail =
        `${label} is currently ${matching.actualType}, but the declared type requires ${matching.expectedType}.`;
      if (!seen.has(detail)) {
        seen.add(detail);
        details.push(detail);
      }
    }

    const fallback = mismatches
      .map(
        (mismatch) =>
          `A value is ${mismatch.actualType}, but the declared type requires ${mismatch.expectedType}.`,
      );
    const summary = details.length > 0 ? details : fallback;

    return (
      "Primitive type mismatches must be fixed by changing the value shape, not by casting. " +
      `${summary.join(" ")} ` +
      "For timestamp-like string fields, use an ISO string or other explicit string value instead of Date.now()."
    );
  }

  private async inferObjectPropertyFromDiagnosticLine(
    repoRoot: string,
    error: TypecheckValidationError,
  ): Promise<string | null> {
    if (!error.file || !error.line || !Number.isInteger(error.line)) {
      return null;
    }
    try {
      const content = await fs.readFile(path.join(repoRoot, error.file), "utf-8");
      const line = content.split(/\r?\n/)[error.line - 1] || "";
      const beforeColumn = error.column && error.column > 0
        ? line.slice(0, Math.max(0, error.column - 1))
        : line;
      const match =
        beforeColumn.match(/([A-Za-z_$][\w$]*)\s*:\s*[^:]*$/) ||
        line.match(/([A-Za-z_$][\w$]*)\s*:/);
      return match?.[1] || null;
    } catch {
      return null;
    }
  }

  private async commitValidatedAttempt(
    context: WorkflowContext,
    appliedFiles: string[],
    commitMessage: string,
  ) {
    const changedFiles = this.normalizeStringArray(appliedFiles);
    if (changedFiles.length === 0) {
      throw new Error("Implementation validation passed but no files were changed");
    }
    const result = await commitAndPushChanges(
      context.repoRoot,
      changedFiles,
      context.getCurrentBranch(),
      commitMessage,
    );
    if (result.noop === true) {
      throw new Error(
        `${NO_EFFECTIVE_CHANGE_MESSAGE}; retry with a concrete edit or mark the task already resolved before implementation`,
      );
    }
    return result;
  }

  private isNoEffectiveChangeError(error: unknown): boolean {
    return error instanceof Error &&
      error.message.includes(NO_EFFECTIVE_CHANGE_MESSAGE);
  }

  private buildNoEffectiveChangeSignature(appliedFiles: string[]): string {
    const files = this.normalizeStringArray(appliedFiles)
      .map((file) => this.normalizeRelativePath(file))
      .sort();
    return files.length > 0 ? files.join("|") : "__no_files__";
  }

  private async resolveHead(context: WorkflowContext): Promise<string> {
    const result = await runGit(["rev-parse", "HEAD"], { cwd: context.repoRoot });
    return result.stdout.trim();
  }

  private async rollbackAttempt(
    context: WorkflowContext,
    checkpoint: string,
    appliedFiles: string[],
  ): Promise<void> {
    const files = this.normalizeStringArray(appliedFiles);
    if (!checkpoint || files.length === 0) return;

    for (const file of files) {
      try {
        const existedAtCheckpoint = await this.pathExistsAtCommit(
          context.repoRoot,
          checkpoint,
          file,
        );
        if (existedAtCheckpoint) {
          await runGit(["checkout", checkpoint, "--", file], {
            cwd: context.repoRoot,
          });
        } else {
          await fs.rm(path.join(context.repoRoot, file), {
            force: true,
            recursive: true,
          });
        }
      } catch (error) {
        context.logger.warn("Failed to roll back implementation attempt file", {
          workflowId: context.workflowId,
          file,
          checkpoint,
          error: String(error),
        });
      }
    }

    try {
      await runGit(["reset", "--", ...files], { cwd: context.repoRoot });
    } catch {
      void 0;
    }

    context.logger.info("Rolled back failed implementation attempt", {
      workflowId: context.workflowId,
      checkpoint,
      files,
    });
  }

  private async pathExistsAtCommit(
    repoRoot: string,
    commit: string,
    file: string,
  ): Promise<boolean> {
    try {
      await runGit(["cat-file", "-e", `${commit}:${file}`], { cwd: repoRoot });
      return true;
    } catch {
      return false;
    }
  }

  private formatValidationSummary(errors: ConfigValidationError[]): string {
    if (errors.length === 0) {
      return "";
    }
    const compact = this.compactValidationErrors(errors);
    const summary = compact
      .map((entry) => `${entry.file}: ${entry.reason}`)
      .join("; ");
    if (summary.length <= MAX_RETRY_SUMMARY_CHARS) {
      return summary;
    }
    return `${summary.slice(0, MAX_RETRY_SUMMARY_CHARS)}... Additional diagnostics omitted due to prompt budget. Run npm run typecheck after edits.`;
  }

  private compactValidationErrors(
    errors: ConfigValidationError[],
  ): ConfigValidationError[] {
    const compact: ConfigValidationError[] = [];
    const perFile = new Map<string, number>();
    let omitted = 0;

    for (const error of errors) {
      const file = this.normalizeRelativePath(error.file || "unknown");
      const count = perFile.get(file) || 0;
      if (
        compact.length >= MAX_RETRY_DIAGNOSTICS ||
        count >= MAX_RETRY_DIAGNOSTICS_PER_FILE
      ) {
        omitted++;
        continue;
      }
      perFile.set(file, count + 1);
      compact.push({
        file,
        reason: this.truncateDiagnostic(error.reason, MAX_RETRY_REASON_CHARS),
      });
    }

    if (omitted > 0) {
      compact.push({
        file: "typecheck",
        reason:
          `${omitted} additional diagnostic(s) omitted due to prompt budget. ` +
          "Run npm run typecheck after edits.",
      });
    }

    return compact;
  }

  private truncateDiagnostic(value: string, maxChars: number): string {
    const normalized = String(value || "")
      .replace(/\s+/g, " ")
      .trim();
    if (normalized.length <= maxChars) {
      return normalized;
    }
    return `${normalized.slice(0, Math.max(0, maxChars - 3))}...`;
  }

  private normalizeDiagnosticPath(file: string, repoRoot: string): string {
    const normalized = file.replace(/\\/g, "/");
    const absolute = path.isAbsolute(normalized)
      ? normalized
      : path.resolve(repoRoot, normalized);
    const relative = path.relative(repoRoot, absolute).replace(/\\/g, "/");
    if (!relative.startsWith("../") && relative !== "..") {
      return this.normalizeRelativePath(relative);
    }
    return this.normalizeRelativePath(normalized);
  }

  private normalizeRelativePath(file: string): string {
    return String(file || "")
      .replace(/\\/g, "/")
      .replace(/^\.\/+/, "")
      .replace(/^\/+/, "")
      .trim();
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

    const apiContent = await fetchArtifactContentFromApi({
      projectId: context.projectId,
      taskId,
      kind: "plan_final",
    });
    if (apiContent !== null) {
      context.setVariable("implementation_plan_text", apiContent);
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
