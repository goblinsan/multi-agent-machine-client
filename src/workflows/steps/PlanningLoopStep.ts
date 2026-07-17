import {
  WorkflowStep,
  StepResult,
  ValidationResult,
} from "../engine/WorkflowStep.js";
import { WorkflowContext } from "../engine/WorkflowContext.js";
import {
  sendPersonaRequest,
  waitForPersonaCompletion,
  interpretPersonaStatus,
} from "../../agents/persona.js";
import { getContextualPrompt } from "../../personas.context.js";
import { logger } from "../../logger.js";
import { cfg } from "../../config.js";
import { personaTimeoutMs } from "../../util.js";
import {
  loadContextDirectory,
  summarizePlanResult,
  summarizeEvaluationResult,
  normalizePlanPayload,
  findPlanLanguageViolations,
  collectAllowedLanguages,
  collectPlanKeyFiles,
  findAmbiguousPlanKeyFiles,
  buildSyntheticEvaluationFailure,
  formatPlanArtifact,
  formatEvaluationArtifact,
  repairScopeExpandedPlan,
  repairTargetedScopePlan,
  extractTargetedBaselineCompileFiles,
  validateDeterministicPlan,
} from "./helpers/planningHelpers.js";
import { requiresStatus } from "./helpers/personaStatusPolicy.js";
import { loadTaskFileSnippets } from "./helpers/analysisReview/taskContext.js";
import {
  publishArtifactToDashboard,
} from "../helpers/artifactPublisher.js";

export class PlanningLoopStep extends WorkflowStep {
  async execute(context: WorkflowContext): Promise<StepResult> {
    const config = this.config.config as any;
    const maxIterations = config.maxIterations ?? config.max_iterations ?? 4;
    const {
      planStep,
      evaluateStep,
      payload,
      timeout,
      deadlineSeconds = 1200,
    } = config;
    const plannerPersona = config.plannerPersona || "implementation-planner";
    const evaluatorPersona = config.evaluatorPersona || "plan-evaluator";
    const evaluatorEnabled = this.isEvaluatorEnabled(config);
    const deterministicPlanningEnabled =
      this.isDeterministicPlanningEnabled(config);

    const resolveTimeout = (persona: string) => {
      if (typeof timeout === "number" && Number.isFinite(timeout) && timeout > 0)
        return timeout;
      return personaTimeoutMs(persona, cfg);
    };

    const plannerTimeoutMs = resolveTimeout(plannerPersona);
    const evaluatorTimeoutMs = evaluatorEnabled
      ? resolveTimeout(evaluatorPersona)
      : 0;

    let currentIteration = 0;
    let planResult: any = null;
    let evaluationResult: any = null;
    let lastEvaluationPassed = false;
    let latestPlanKeyFiles: string[] = [];
    let stalled = false;
    let lastFailureSignature: string | null = null;
    const iterationHistory: Array<{
      iteration: number;
      planPreview: string;
      evaluationStatus: string;
      evaluationReason: string;
    }> = [];

    logger.info("Starting planning evaluation loop", {
      workflowId: context.workflowId,
      maxIterations,
      plannerPersona,
      evaluatorPersona,
      evaluatorEnabled,
      deterministicPlanningEnabled,
    });

    const transport = context.transport;

    if (deterministicPlanningEnabled) {
      return this.executeDeterministicPlan(context, {
        payload,
        planStep,
      });
    }

    while (currentIteration < maxIterations) {
      currentIteration++;

      const taskId = this.resolveTaskId(context);
      const planIterationArtifactPath = `.ma/tasks/${taskId}/02-plan-iteration-${currentIteration}.md`;
      const planEvalArtifactPath = `.ma/tasks/${taskId}/02-plan-eval-iteration-${currentIteration}.md`;

      logger.info(
        `Planning loop iteration ${currentIteration}/${maxIterations}`,
        {
          workflowId: context.workflowId,
          step: planStep,
        },
      );

      const repoRemote =
        context.getVariable("repo_remote") ||
        context.getVariable("effective_repo_path");
      const currentBranch = context.getCurrentBranch();

      const contextDir = await loadContextDirectory(context.repoRoot);
      const contextAnalysis = context.getVariable("context_request_result");
      const contextSummaryMd =
        context.getVariable("context_summary_md") ||
        contextDir["summary.md"] ||
        contextDir["summary.txt"];
      const contextInsights = context.getVariable("context_insights");
      const contextOverview = this.buildContextOverview(
        contextInsights,
        contextSummaryMd,
      );
      let deterministicPlanPassed = false;

      const task = context.getVariable("task");
      const taskDescription = task?.description || "";
      const taskTitle = task?.title || "";
      const taskFileSnippets = await loadTaskFileSnippets(
        context.repoRoot,
        task,
        undefined,
        `${taskTitle}\n${taskDescription}`
      );
      logger.info("Loaded task file snippets for planner", {
        workflowId: context.workflowId,
        fileCount: taskFileSnippets.length,
        files: taskFileSnippets.map((s) => s.path),
      });

      try {
        logger.info("Making planning request", {
          workflowId: context.workflowId,
          step: planStep,
          persona: plannerPersona,
          iteration: currentIteration,
        });

        const payloadWithContext = {
          ...payload,
          iteration: currentIteration,
          planIteration: currentIteration,
          snippets: taskFileSnippets,
          previous_evaluation: evaluationResult,
          planning_history: this.buildPlanningHistory(iterationHistory),
          is_revision: currentIteration > 1,
          task: context.getVariable("task"),
          repo: repoRemote,
          branch: currentBranch,
          project_id: context.projectId,
          context_directory: contextDir,
          context_analysis: contextAnalysis || payload.context,
          context_summary: contextSummaryMd,
          context_overview: contextOverview,
          context_insights: contextInsights,
          context_primary_language: contextInsights?.primaryLanguage,
          context_frameworks: contextInsights?.frameworks,
          context_potential_issues: contextInsights?.potentialIssues,
        };

        const planCorrId = await sendPersonaRequest(transport, {
          workflowId: context.workflowId,
          toPersona: plannerPersona,
          step: planStep,
          intent: "planning",
          payload: payloadWithContext,
          repo: repoRemote,
          branch: currentBranch,
          projectId: context.projectId,
          deadlineSeconds,
        });

        planResult = await waitForPersonaCompletion(
          transport,
          plannerPersona,
          context.workflowId,
          planCorrId,
          plannerTimeoutMs,
        );

        const parsedPlanResult = summarizePlanResult(planResult);
        const { planData, parsed } = normalizePlanPayload(planResult);

        const planEmpty =
          !Array.isArray(planData?.plan) || planData.plan.length === 0;
        if (planEmpty && parsed?.truncated === true) {
          const reason =
            "Your previous plan response was TRUNCATED at the output token limit before the JSON was complete - it had far too many steps. " +
            "Produce a plan with AT MOST 6 steps, grouping related small fixes (multiple imports, types, or annotations in the same file) into a single step. " +
            "Keep goals and acceptance criteria to one short sentence each.";
          evaluationResult = buildSyntheticEvaluationFailure(
            reason,
            { truncated: true },
            "response_truncated",
          );

          const syntheticEvalContent = formatEvaluationArtifact(
            evaluationResult,
            currentIteration,
          );
          await this.commitArtifact(
            context,
            syntheticEvalContent,
            planEvalArtifactPath,
            `docs(ma): plan evaluation ${currentIteration} for task ${taskId}`,
            { kind: "plan_eval", iteration: currentIteration },
          );

          lastEvaluationPassed = false;
          logger.warn("Plan rejected: response truncated at max_tokens", {
            workflowId: context.workflowId,
            iteration: currentIteration,
          });
          this.recordIteration(
            iterationHistory,
            currentIteration,
            planResult,
            "fail",
            reason,
          );
          if (this.isRepeatFailure(reason, lastFailureSignature)) {
            stalled = true;
            logger.warn("Planning loop stalled on repeated truncation", {
              workflowId: context.workflowId,
              iteration: currentIteration,
            });
            break;
          }
          lastFailureSignature = this.normalizeFailureSignature(reason);
          continue;
        }

        latestPlanKeyFiles = collectPlanKeyFiles(planData);
        context.setVariable("planning_loop_plan_files", latestPlanKeyFiles);

        const repoScan = context.getVariable("repoScan") as any[] || [];
        const existingPaths = new Set(repoScan.map((f: any) => f.path.replace(/\\/g, "/")));
        const allowedLanguageInfo = collectAllowedLanguages(contextInsights);
        const scopeViabilityStatus = context.getVariable("scope_viability_status");
        const requiredScopeFiles = scopeViabilityStatus === "requires_scope_expansion"
          ? this.normalizeStringArray(
            context.getVariable("scope_viability_root_cause_files"),
          )
          : [];
        let deterministicValidation = validateDeterministicPlan(planData, {
          existingPaths,
          allowedLanguages: allowedLanguageInfo.normalized,
          taskTitle,
          taskDescription,
          requiredScopeFiles,
        });

        if (
          !deterministicValidation.valid &&
          requiredScopeFiles.length === 0 &&
          this.isTargetedScopeOnlyFailure(deterministicValidation.issues)
        ) {
          const targetedFiles = extractTargetedBaselineCompileFiles(
            `${taskTitle}\n${taskDescription}`,
          );
          const clamp = repairTargetedScopePlan(
            planData,
            targetedFiles,
            deterministicValidation.issues,
          );
          if (clamp.changed) {
            planResult = this.withRepairedPlanResult(planResult, planData);
            latestPlanKeyFiles = collectPlanKeyFiles(planData);
            context.setVariable("planning_loop_plan_files", latestPlanKeyFiles);
            deterministicValidation = validateDeterministicPlan(planData, {
              existingPaths,
              allowedLanguages: allowedLanguageInfo.normalized,
              taskTitle,
              taskDescription,
              requiredScopeFiles,
            });

            logger.info(
              "Clamped premature root-cause plan to targeted scope; scope viability will decide any expansion",
              {
                workflowId: context.workflowId,
                iteration: currentIteration,
                targetedFiles,
                removedFiles: clamp.removedFiles,
                clampedToTargets: clamp.clampedToTargets,
                validationPassed: deterministicValidation.valid,
              },
            );
          }
        }

        if (
          !deterministicValidation.valid &&
          requiredScopeFiles.length > 0 &&
          this.hasRepairableScopeExpansionIssues(deterministicValidation.issues)
        ) {
          const scopeRepair = repairScopeExpandedPlan(
            planData,
            requiredScopeFiles,
            deterministicValidation.issues,
          );

          if (scopeRepair.changed) {
            planResult = this.withRepairedPlanResult(planResult, planData);
            latestPlanKeyFiles = collectPlanKeyFiles(planData);
            context.setVariable("planning_loop_plan_files", latestPlanKeyFiles);
            deterministicValidation = validateDeterministicPlan(planData, {
              existingPaths,
              allowedLanguages: allowedLanguageInfo.normalized,
              taskTitle,
              taskDescription,
              requiredScopeFiles,
            });

            logger.info(
              "Deterministically repaired scope-expanded plan structure",
              {
                workflowId: context.workflowId,
                iteration: currentIteration,
                addedFiles: scopeRepair.addedFiles,
                removedFiles: scopeRepair.removedFiles,
                targetStepIndex: scopeRepair.targetStepIndex,
                rootStageFiles: scopeRepair.rootStageFiles,
                planSteps: Array.isArray(planData?.plan)
                  ? planData.plan.length
                  : undefined,
                validationPassed: deterministicValidation.valid,
              },
            );
          }
        }
        deterministicPlanPassed = deterministicValidation.valid;

        if (!deterministicValidation.valid) {
          const reason = deterministicValidation.issues
            .map((issue) => issue.reason)
            .join(" ");
          evaluationResult = buildSyntheticEvaluationFailure(
            reason,
            {
              issues: deterministicValidation.issues,
            },
            "deterministic_plan_validation",
          );

          const syntheticEvalContent = formatEvaluationArtifact(
            evaluationResult,
            currentIteration,
          );
          await this.commitArtifact(
            context,
            syntheticEvalContent,
            planEvalArtifactPath,
            `docs(ma): plan evaluation ${currentIteration} for task ${taskId}`,
            { kind: "plan_eval", iteration: currentIteration },
          );

          lastEvaluationPassed = false;
          logger.warn("Plan rejected by deterministic validation", {
            workflowId: context.workflowId,
            iteration: currentIteration,
            issues: deterministicValidation.issues,
          });
          this.recordIteration(
            iterationHistory,
            currentIteration,
            planResult,
            "fail",
            reason,
          );
          if (this.isRepeatFailure(reason, lastFailureSignature)) {
            stalled = true;
            logger.warn("Planning loop stalled on repeated deterministic validation failure", {
              workflowId: context.workflowId,
              iteration: currentIteration,
              reason,
            });
            break;
          }
          lastFailureSignature = this.normalizeFailureSignature(reason);
          continue;
        }

        let pathViolationReason: string | null = null;
        const invalidFiles: string[] = [];

        for (const file of latestPlanKeyFiles) {
          const fileNorm = file.replace(/\\/g, "/");
          if (!existingPaths.has(fileNorm)) {
            const matches = findNearbyPaths(fileNorm, existingPaths);
            if (matches.length > 0) {
              invalidFiles.push(`- '${file}' does not exist. Did you mean: ${matches.map(m => `'${m}'`).join(" or ")}?`);
            }
          }
        }

        if (invalidFiles.length > 0) {
          pathViolationReason = "Plan references nonexistent files that appear to be typos of existing repository files:\n" + invalidFiles.join("\n") + "\nPlease correct these paths in the plan's key_files.";
          evaluationResult = buildSyntheticEvaluationFailure(
            pathViolationReason,
            {
              invalid_files: invalidFiles,
            },
            "path_violations",
          );

          const syntheticEvalContent = formatEvaluationArtifact(
            evaluationResult,
            currentIteration,
          );
          await this.commitArtifact(
            context,
            syntheticEvalContent,
            planEvalArtifactPath,
            `docs(ma): plan evaluation ${currentIteration} for task ${taskId}`,
            { kind: "plan_eval", iteration: currentIteration },
          );

          lastEvaluationPassed = false;
          logger.warn("Plan rejected due to nonexistent plan key files", {
            workflowId: context.workflowId,
            iteration: currentIteration,
            invalidFiles,
          });
          this.recordIteration(
            iterationHistory,
            currentIteration,
            planResult,
            "fail",
            pathViolationReason,
          );
          if (this.isRepeatFailure(pathViolationReason, lastFailureSignature)) {
            stalled = true;
            logger.warn("Planning loop stalled on repeated guard failure", {
              workflowId: context.workflowId,
              iteration: currentIteration,
              reason: pathViolationReason,
            });
            break;
          }
          lastFailureSignature = this.normalizeFailureSignature(pathViolationReason);
          continue;
        }

        const ambiguousKeyFiles = findAmbiguousPlanKeyFiles(planData);
        if (ambiguousKeyFiles.length > 0) {
          const summaryPreview = ambiguousKeyFiles
            .slice(0, 3)
            .map((entry) => `${entry.stepGoal}: ${entry.variants.join(" vs ")}`)
            .join("; ");
          const reason =
            "Plan lists multiple alternative file paths for the same deliverable. Choose exactly one concrete path per step." +
            (summaryPreview ? ` Conflicts: ${summaryPreview}` : "");
          evaluationResult = buildSyntheticEvaluationFailure(
            reason,
            {
              ambiguous_key_files: ambiguousKeyFiles,
            },
            "ambiguous_key_files",
          );

          const syntheticEvalContent = formatEvaluationArtifact(
            evaluationResult,
            currentIteration,
          );
          await this.commitArtifact(
            context,
            syntheticEvalContent,
            planEvalArtifactPath,
            `docs(ma): plan evaluation ${currentIteration} for task ${taskId}`,
            { kind: "plan_eval", iteration: currentIteration },
          );

          lastEvaluationPassed = false;
          logger.warn("Plan rejected due to ambiguous key files", {
            workflowId: context.workflowId,
            iteration: currentIteration,
            ambiguous_key_files: ambiguousKeyFiles,
          });
          this.recordIteration(
            iterationHistory,
            currentIteration,
            planResult,
            "fail",
            reason,
          );
          if (this.isRepeatFailure(reason, lastFailureSignature)) {
            stalled = true;
            logger.warn("Planning loop stalled on repeated guard failure", {
              workflowId: context.workflowId,
              iteration: currentIteration,
              reason,
            });
            break;
          }
          lastFailureSignature = this.normalizeFailureSignature(reason);
          continue;
        }

        logger.info("Planning request completed", {
          workflowId: context.workflowId,
          step: planStep,
          persona: plannerPersona,
          iteration: currentIteration,
          status: planResult?.status || "unknown",
        });

        if (parsedPlanResult) {
          logger.info("Planning loop plan output", {
            workflowId: context.workflowId,
            step: planStep,
            persona: plannerPersona,
            iteration: currentIteration,
            plan: parsedPlanResult,
          });
        }

        const planContent = formatPlanArtifact(planResult, currentIteration);
        await this.commitArtifact(
          context,
          planContent,
          planIterationArtifactPath,
          `docs(ma): plan iteration ${currentIteration} for task ${taskId}`,
          { kind: "plan", iteration: currentIteration },
        );

        const languageViolations = findPlanLanguageViolations(
          planData,
          allowedLanguageInfo.normalized,
        );

        if (languageViolations.length > 0) {
          const allowedLabel =
            allowedLanguageInfo.display.length > 0
              ? allowedLanguageInfo.display.join(", ")
              : "none detected";
          const violationSummary = languageViolations
            .map((violation) => `${violation.file} (${violation.language})`)
            .join(", ");
          const reason = `Plan references files in languages outside the repository context: ${violationSummary}. Allowed languages: ${allowedLabel}.`;
          evaluationResult = buildSyntheticEvaluationFailure(reason, {
            allowed_languages: allowedLanguageInfo.display,
            violations: languageViolations,
          });

          const syntheticEvalContent = formatEvaluationArtifact(
            evaluationResult,
            currentIteration,
          );
          await this.commitArtifact(
            context,
            syntheticEvalContent,
            planEvalArtifactPath,
            `docs(ma): plan evaluation ${currentIteration} for task ${taskId}`,
            { kind: "plan_eval", iteration: currentIteration },
          );
          lastEvaluationPassed = false;
          logger.warn("Plan rejected due to language policy violation", {
            workflowId: context.workflowId,
            iteration: currentIteration,
            violations: languageViolations,
            allowed_languages: allowedLanguageInfo.display,
          });
          this.recordIteration(
            iterationHistory,
            currentIteration,
            planResult,
            "fail",
            reason,
          );
          if (this.isRepeatFailure(reason, lastFailureSignature)) {
            stalled = true;
            logger.warn("Planning loop stalled on repeated guard failure", {
              workflowId: context.workflowId,
              iteration: currentIteration,
              reason,
            });
            break;
          }
          lastFailureSignature = this.normalizeFailureSignature(reason);
          continue;
        }

        if (!evaluatorEnabled) {
          lastEvaluationPassed = true;
          evaluationResult = null;
          this.recordIteration(
            iterationHistory,
            currentIteration,
            planResult,
            "deterministic_pass",
            "Plan accepted by deterministic validation; LLM evaluator disabled.",
          );

          logger.info(
            "Plan accepted by deterministic validation; skipping LLM evaluator",
            {
              workflowId: context.workflowId,
              iteration: currentIteration,
              evaluatorPersona,
            },
          );

          const finalPlanContent = formatPlanArtifact(
            planResult,
            currentIteration,
          );
          await this.commitArtifact(
            context,
            finalPlanContent,
            `.ma/tasks/${taskId}/03-plan-final.md`,
            `docs(ma): approved plan for task ${taskId}`,
            { kind: "plan_final" },
          );

          break;
        }
      } catch (error) {
        logger.error("Planning request failed", {
          workflowId: context.workflowId,
          step: planStep,
          persona: plannerPersona,
          iteration: currentIteration,
          error: error instanceof Error ? error.message : String(error),
        });

        if (currentIteration === maxIterations) {
          break;
        }
        continue;
      }

      try {
        logger.info("Making evaluation request", {
          workflowId: context.workflowId,
          step: evaluateStep,
          persona: evaluatorPersona,
          iteration: currentIteration,
        });

        let evalContext = "planning";
        if (currentIteration > 3) {
          evalContext = "revision";
        }

        const contextualPrompt = getContextualPrompt(
          evaluatorPersona,
          evalContext,
        );

        const evalPayload = {
          ...payload,
          plan: planResult,
          plan_artifact: planIterationArtifactPath,
          plan_iteration_artifact: planIterationArtifactPath,
          plan_iteration: currentIteration,
          iteration: currentIteration,
          task: context.getVariable("task"),
          repo: repoRemote,
          branch: currentBranch,
          project_id: context.projectId,
          repo_root: context.repoRoot,
          context_summary: contextSummaryMd,
          context_overview: contextOverview,
          context_insights: contextInsights,
          context_primary_language: contextInsights?.primaryLanguage,
          context_frameworks: contextInsights?.frameworks,
          context_potential_issues: contextInsights?.potentialIssues,

          ...(contextualPrompt
            ? { extra_system_messages: [contextualPrompt] }
            : {}),
        };

        const evalCorrId = await sendPersonaRequest(transport, {
          workflowId: context.workflowId,
          toPersona: evaluatorPersona,
          step: evaluateStep,
          intent: "evaluation",
          payload: evalPayload,
          repo: repoRemote,
          branch: currentBranch,
          projectId: context.projectId,
          deadlineSeconds,
        });

        evaluationResult = await waitForPersonaCompletion(
          transport,
          evaluatorPersona,
          context.workflowId,
          evalCorrId,
          evaluatorTimeoutMs,
        );

        const parsedEvaluation = summarizeEvaluationResult(evaluationResult);

        const evaluationStatusInfo = interpretPersonaStatus(
          evaluationResult?.fields?.result,
          {
            persona: evaluatorPersona,
            statusRequired: requiresStatus(evaluatorPersona),
          },
        );

        logger.info("Evaluation request completed", {
          workflowId: context.workflowId,
          step: evaluateStep,
          persona: evaluatorPersona,
          iteration: currentIteration,
          eventStatus: evaluationResult?.fields?.status || "unknown",
          interpretedStatus: evaluationStatusInfo.status,
        });

        if (parsedEvaluation) {
          logger.info("Planning loop evaluation result", {
            workflowId: context.workflowId,
            step: evaluateStep,
            persona: evaluatorPersona,
            iteration: currentIteration,
            evaluation: parsedEvaluation,
            interpretedStatus: evaluationStatusInfo.status,
          });
        }

        const evalContent = formatEvaluationArtifact(
          evaluationResult,
          currentIteration,
        );
        await this.commitArtifact(
          context,
          evalContent,
          planEvalArtifactPath,
          `docs(ma): plan evaluation ${currentIteration} for task ${taskId}`,
          { kind: "plan_eval", iteration: currentIteration },
        );

        lastEvaluationPassed = evaluationStatusInfo.status === "pass";

        let evaluationReason =
          (evaluationStatusInfo.payload &&
          typeof evaluationStatusInfo.payload.reason === "string"
            ? evaluationStatusInfo.payload.reason
            : "") ||
          evaluationStatusInfo.details ||
          "";

        if (evaluationStatusInfo.status === "unknown" && !evaluationReason) {
          evaluationReason = "unknown evaluator status";
        }
        this.recordIteration(
          iterationHistory,
          currentIteration,
          planResult,
          evaluationStatusInfo.status,
          evaluationReason,
        );

        if (!lastEvaluationPassed && deterministicPlanPassed) {
          logger.warn(
            "Plan evaluator rejected a deterministically valid plan; treating rejection as advisory",
            {
              workflowId: context.workflowId,
              iteration: currentIteration,
              evaluationStatus: evaluationStatusInfo.status,
              evaluationReason: evaluationReason.substring(0, 500),
            },
          );
          lastEvaluationPassed = true;
          evaluationReason = "";
        }

        if (lastEvaluationPassed) {
          logger.info("Plan evaluation passed, exiting loop", {
            workflowId: context.workflowId,
            iteration: currentIteration,
            totalIterations: currentIteration,
            evaluationStatus: evaluationStatusInfo.status,
          });

          const finalPlanContent = formatPlanArtifact(
            planResult,
            currentIteration,
          );
          await this.commitArtifact(
            context,
            finalPlanContent,
            `.ma/tasks/${taskId}/03-plan-final.md`,
            `docs(ma): approved plan for task ${taskId}`,
            { kind: "plan_final" },
          );

          break;
        } else {
          if (this.isRepeatFailure(evaluationReason, lastFailureSignature)) {
            stalled = true;
            logger.warn(
              "Planning loop stalled: evaluator rejected consecutive plans for the same reason",
              {
                workflowId: context.workflowId,
                iteration: currentIteration,
                reason: evaluationReason.substring(0, 300),
              },
            );
            break;
          }
          lastFailureSignature =
            this.normalizeFailureSignature(evaluationReason);

          logger.info("Plan evaluation failed or unknown, continuing loop", {
            workflowId: context.workflowId,
            iteration: currentIteration,
            remainingIterations: maxIterations - currentIteration,
            evaluationStatus: evaluationStatusInfo.status,
            details: evaluationStatusInfo.details?.substring(0, 200),
          });
        }
      } catch (error) {
        logger.error("Evaluation request failed", {
          workflowId: context.workflowId,
          step: evaluateStep,
          persona: evaluatorPersona,
          iteration: currentIteration,
          error: error instanceof Error ? error.message : String(error),
        });

        if (currentIteration === maxIterations) {
          break;
        }
        continue;
      }
    }

    context.setVariable("planning_loop_plan_files", latestPlanKeyFiles);
    context.setVariable("plan_required_files", latestPlanKeyFiles);

    const finalResult = {
      plan: planResult,
      evaluation: evaluationResult,
      iterations: currentIteration,
      evaluationPassed: lastEvaluationPassed,
      reachedMaxIterations: currentIteration >= maxIterations,
      stalled,
    };

    logger.info("Planning loop completed", {
      workflowId: context.workflowId,
      totalIterations: currentIteration,
      maxIterations,
      finalEvaluationPassed: lastEvaluationPassed,
      reachedMaxIterations: currentIteration >= maxIterations,
      stalled,
    });

    return {
      status: lastEvaluationPassed ? "success" : "failure",
      data: finalResult,
      error: lastEvaluationPassed
        ? undefined
        : new Error(
            stalled
              ? "Planning loop stalled: evaluator rejected consecutive plans for the same reason"
              : `Planning loop failed after ${currentIteration} iteration(s)`,
          ),
      outputs: {
        plan_result: planResult,
        evaluation_result: evaluationResult,
        iterations: currentIteration,
        evaluation_passed: lastEvaluationPassed,
        plan_key_files: latestPlanKeyFiles,
        stalled,
      },
    };
  }

  private recordIteration(
    history: Array<{
      iteration: number;
      planPreview: string;
      evaluationStatus: string;
      evaluationReason: string;
    }>,
    iteration: number,
    planResult: any,
    evaluationStatus: string,
    evaluationReason: string,
  ): void {
    const summary = summarizePlanResult(planResult);
    history.push({
      iteration,
      planPreview: summary?.planPreview || "",
      evaluationStatus,
      evaluationReason: (evaluationReason || "").substring(0, 1000),
    });
  }

  private buildPlanningHistory(
    history: Array<{
      iteration: number;
      planPreview: string;
      evaluationStatus: string;
      evaluationReason: string;
    }>,
  ): string | undefined {
    if (!history.length) return undefined;
    const recent = history.slice(-3);
    const parts = recent.map((entry) => {
      const lines = [
        `Iteration ${entry.iteration} evaluation: ${entry.evaluationStatus.toUpperCase()}`,
      ];
      if (entry.evaluationReason) {
        lines.push(`Rejection reason: ${entry.evaluationReason}`);
      }
      if (entry.planPreview) {
        lines.push(`Plan excerpt: ${entry.planPreview}`);
      }
      return lines.join("\n");
    });
    return (
      "Your previous plan(s) for this task were rejected. You MUST address " +
      "the rejection reasons below in your next plan — do not resubmit the " +
      "same plan.\n\n" +
      parts.join("\n\n---\n\n")
    );
  }

  private normalizeFailureSignature(reason: string): string {
    return (reason || "")
      .toLowerCase()
      .replace(/\s+/g, " ")
      .trim()
      .substring(0, 400);
  }

  private isRepeatFailure(
    reason: string,
    lastSignature: string | null,
  ): boolean {
    if (!lastSignature) return false;
    const current = this.normalizeFailureSignature(reason);
    return current.length > 0 && current === lastSignature;
  }

  private hasRepairableScopeExpansionIssues(
    issues: Array<{ guard: string }>,
  ): boolean {
    const repairableGuards = new Set([
      "scope_viability_required_files",
      "targeted_task_scope",
    ]);
    return (
      issues.length > 0 &&
      issues.every((issue) => repairableGuards.has(issue.guard))
    );
  }

  private isTargetedScopeOnlyFailure(
    issues: Array<{ guard: string }>,
  ): boolean {
    return (
      issues.length > 0 &&
      issues.every((issue) => issue.guard === "targeted_task_scope")
    );
  }

  private withRepairedPlanResult(planResult: any, planData: any): any {
    const repairedResult = JSON.stringify(planData);
    if (!planResult || typeof planResult !== "object") {
      return {
        fields: {
          status: "done",
          result: repairedResult,
        },
      };
    }

    return {
      ...planResult,
      fields: {
        ...(planResult.fields ?? {}),
        result: repairedResult,
      },
    };
  }

  private buildContextOverview(
    insights: any,
    summary: string | undefined,
  ): string | undefined {
    if (insights && typeof insights === "object") {
      const parts: string[] = [];

      if (
        typeof insights.primaryLanguage === "string" &&
        insights.primaryLanguage.length > 0
      ) {
        parts.push(`Primary Language: ${insights.primaryLanguage}`);
      }

      if (
        Array.isArray(insights.frameworks) &&
        insights.frameworks.length > 0
      ) {
        parts.push(`Frameworks: ${insights.frameworks.join(", ")}`);
      }

      if (
        Array.isArray(insights.potentialIssues) &&
        insights.potentialIssues.length > 0
      ) {
        parts.push(`Potential Issues: ${insights.potentialIssues.join("; ")}`);
      }

      if (parts.length > 0) {
        return parts.join("\n");
      }
    }

    if (typeof summary === "string" && summary.length > 0) {
      const statsIndex = summary.indexOf("## Statistics");
      const overview =
        statsIndex >= 0 ? summary.slice(0, statsIndex).trim() : summary.trim();
      return overview.length > 0 ? overview : undefined;
    }

    return undefined;
  }

  private async commitArtifact(
    context: WorkflowContext,
    content: string,
    artifactPath: string,
    commitMessage: string,
    artifact?: { kind: string; iteration?: number },
  ): Promise<void> {
    const skipGitOps = ((): boolean => {
      try {
        return context.getVariable("SKIP_GIT_OPERATIONS") === true;
      } catch {
        return false;
      }
    })();
    if (skipGitOps) {
      logger.debug("Skipping artifact commit (SKIP_GIT_OPERATIONS)", {
        artifactPath,
      });
      return;
    }

    if (artifact) {
      await publishArtifactToDashboard({
        projectId: context.projectId,
        taskId: this.resolveTaskId(context),
        workflowId: context.workflowId,
        kind: artifact.kind,
        iteration: artifact.iteration ?? null,
        content,
      });
    }

  }

  private resolveTaskId(context: WorkflowContext): string {
    const task = context.getVariable("task");
    if (!task) return "unknown";
    if (task.id !== undefined && task.id !== null) {
      return String(task.id);
    }
    if (task.data?.id !== undefined && task.data.id !== null) {
      return String(task.data.id);
    }
    return "unknown";
  }

  private isEvaluatorEnabled(config: any): boolean {
    const configured =
      config.planningEvaluator ??
      config.planning_evaluator ??
      config.enableEvaluator ??
      config.enable_evaluator;
    if (configured !== undefined) {
      return this.parseEvaluatorFlag(configured);
    }
    return this.parseEvaluatorFlag(process.env.PLANNING_EVALUATOR ?? "off");
  }

  private isDeterministicPlanningEnabled(config: any): boolean {
    const configured =
      config.planningMode ??
      config.planning_mode ??
      config.plannerMode ??
      config.planner_mode;
    const value = configured ?? process.env.PLANNING_MODE;
    if (value === undefined || value === null) return false;
    const normalized = String(value).trim().toLowerCase();
    return ["deterministic", "static", "off", "disabled"].includes(normalized);
  }

  private async executeDeterministicPlan(
    context: WorkflowContext,
    options: {
      payload: any;
      planStep?: string;
    },
  ): Promise<StepResult> {
    const task = context.getVariable("task") ?? {};
    const planData = this.buildDeterministicPlanData(task, options.payload);
    const latestPlanKeyFiles = collectPlanKeyFiles(planData);
    const planResult = {
      id: "deterministic-plan",
      status: "success",
      fields: {
        status: "done",
        corr_id: `deterministic-${context.workflowId}`,
        result: JSON.stringify(planData),
      },
    };

    context.setVariable("planning_loop_plan_files", latestPlanKeyFiles);
    context.setVariable("plan_required_files", latestPlanKeyFiles);

    const taskId = this.resolveTaskId(context);
    await this.commitArtifact(
      context,
      formatPlanArtifact(planResult, 1),
      `.ma/tasks/${taskId}/03-plan-final.md`,
      `docs(ma): deterministic plan for task ${taskId}`,
      { kind: "plan_final" },
    );

    logger.info("Planning loop bypassed with deterministic task plan", {
      workflowId: context.workflowId,
      step: options.planStep,
      taskId,
      planFiles: latestPlanKeyFiles,
      planSteps: planData.plan.length,
    });

    return {
      status: latestPlanKeyFiles.length > 0 ? "success" : "failure",
      data: {
        plan: planResult,
        evaluation: null,
        iterations: 0,
        evaluationPassed: latestPlanKeyFiles.length > 0,
        reachedMaxIterations: false,
        stalled: false,
      },
      error:
        latestPlanKeyFiles.length > 0
          ? undefined
          : new Error("Deterministic planning could not find concrete task files"),
      outputs: {
        plan_result: planResult,
        evaluation_result: null,
        iterations: 0,
        evaluation_passed: latestPlanKeyFiles.length > 0,
        plan_key_files: latestPlanKeyFiles,
        stalled: false,
      },
    };
  }

  private buildDeterministicPlanData(task: any, payload: any): any {
    const title = this.extractTaskText(task, "title", "name", "summary");
    const description = this.extractTaskText(task, "description", "body");
    const fallbackText = this.extractTaskText(
      payload?.task,
      "title",
      "description",
      "body",
    );
    const taskText = [title, description, fallbackText]
      .filter(Boolean)
      .join("\n");
    const files = this.extractConcreteTaskFiles(taskText);

    return {
      plan: files.map((file, index) => ({
        goal: this.buildDeterministicStepGoal(file, index, title),
        key_files: [file],
        acceptance_criteria: [
          `Implement the requested change for ${file} and keep validation passing.`,
        ],
      })),
      risks: [],
      metadata: {
        source: "deterministic_task_files",
        planning_mode: "deterministic",
      },
    };
  }

  private extractTaskText(value: any, ...keys: string[]): string {
    if (!value || typeof value !== "object") return "";
    const parts: string[] = [];
    for (const key of keys) {
      const candidate = value[key] ?? value.data?.[key];
      if (typeof candidate === "string" && candidate.trim().length > 0) {
        parts.push(candidate.trim());
      }
    }
    return parts.join("\n");
  }

  private extractConcreteTaskFiles(text: string): string[] {
    const files = new Set<string>();
    const pathPattern =
      /(?:^|[\s`"'(:])((?:\.\/)?(?:src|tests|test|app|components|lib|packages|scripts|public|config|__tests__)\/[A-Za-z0-9_./@+-]+\.(?:ts|tsx|js|jsx|mjs|cjs|json|css|scss|html|md|yml|yaml))(?=$|[\s`"',).:;])/g;
    let match: RegExpExecArray | null;
    while ((match = pathPattern.exec(text)) !== null) {
      const normalized = match[1]
        .replace(/\\/g, "/")
        .replace(/^\.\/+/, "")
        .replace(/\/{2,}/g, "/");
      if (
        normalized &&
        !normalized.includes("..") &&
        !normalized.includes("*")
      ) {
        files.add(normalized);
      }
    }
    return Array.from(files);
  }

  private buildDeterministicStepGoal(
    file: string,
    index: number,
    taskTitle: string,
  ): string {
    const action = index === 0 ? "Implement" : "Update";
    const title = taskTitle ? ` for task: ${taskTitle}` : "";
    return `${action} ${file}${title}`;
  }

  private parseEvaluatorFlag(value: unknown): boolean {
    if (typeof value === "boolean") return value;
    if (typeof value === "number") return value !== 0;
    const normalized = String(value || "").trim().toLowerCase();
    return ["1", "true", "yes", "on", "enabled"].includes(normalized);
  }

  private normalizeStringArray(value: unknown): string[] {
    if (!value) return [];
    if (Array.isArray(value)) {
      return value
        .map((entry) =>
          typeof entry === "string" ? entry.trim() : String(entry ?? "").trim(),
        )
        .filter((entry) => entry.length > 0);
    }
    if (typeof value === "string" && value.trim().length > 0) {
      return [value.trim()];
    }
    return [];
  }

  protected async validateConfig(
    _context: WorkflowContext,
  ): Promise<ValidationResult> {
    const config = this.config.config as any;
    const errors: string[] = [];
    const warnings: string[] = [];

    const maxIterations = config.maxIterations ?? config.max_iterations ?? 4;
    const deadlineSeconds = config.deadlineSeconds ?? 1200;
    const stepTimeoutMs = deadlineSeconds * 1000;

    const plannerPersona = config.plannerPersona || "implementation-planner";
    const evaluatorPersona = config.evaluatorPersona || "plan-evaluator";
    const evaluatorEnabled = this.isEvaluatorEnabled(config);

    const plannerTimeoutMs = personaTimeoutMs(plannerPersona, cfg);
    const evaluatorTimeoutMs = evaluatorEnabled
      ? personaTimeoutMs(evaluatorPersona, cfg)
      : 0;
    const maxPersonaTimeoutMs = Math.max(plannerTimeoutMs, evaluatorTimeoutMs);

    const callsPerIteration = evaluatorEnabled ? 2 : 1;
    const totalPotentialWaitMs =
      maxPersonaTimeoutMs * maxIterations * callsPerIteration;

    if (totalPotentialWaitMs > stepTimeoutMs) {
      const msg = `WARNING: PlanningLoopStep timeout budget mismatch! Total potential wait time of persona calls (${totalPotentialWaitMs / 1000}s) exceeds step deadline (${deadlineSeconds}s) by ${Math.ceil((totalPotentialWaitMs - stepTimeoutMs) / 1000)}s. Lower maxIterations or increase deadlineSeconds/timeout.`;
      logger.warn(msg);
      console.warn(`\x1b[33m${msg}\x1b[0m`);
      warnings.push(msg);
    }

    return {
      valid: true,
      errors,
      warnings,
    };
  }
}

function findNearbyPaths(file: string, existingPaths: Set<string>): string[] {
  const fileNorm = file.replace(/\\/g, "/");
  const fileLower = fileNorm.toLowerCase();
  const fileBase = fileNorm.split("/").pop() || "";
  const fileBaseLower = fileBase.toLowerCase();

  const matches: string[] = [];

  for (const p of existingPaths) {
    const pLower = p.toLowerCase();
    const pBase = p.split("/").pop() || "";
    const pBaseLower = pBase.toLowerCase();

    if (pLower === fileLower) {
      matches.push(p);
      continue;
    }

    const fileBaseNoExt = fileBase.substring(0, fileBase.lastIndexOf(".")) || fileBase;
    const pBaseNoExt = pBase.substring(0, pBase.lastIndexOf(".")) || pBase;

    if (fileBaseLower === pBaseLower) {
      matches.push(p);
      continue;
    }
    if (fileBaseNoExt.toLowerCase() === pBaseNoExt.toLowerCase() && p.split("/").slice(0, -1).join("/") === fileNorm.split("/").slice(0, -1).join("/")) {
      matches.push(p);
      continue;
    }

    if (p.endsWith("/" + fileNorm) || fileNorm.endsWith("/" + p)) {
      matches.push(p);
      continue;
    }
  }

  if (matches.length === 0) {
    for (const p of existingPaths) {
      const pBase = p.split("/").pop() || "";
      const dist = levenshteinDistance(fileBase.toLowerCase(), pBase.toLowerCase());
      if (dist <= 2 && fileBase.length > 3) {
        matches.push(p);
      }
    }
  }

  return [...new Set(matches)].slice(0, 3);
}

function levenshteinDistance(a: string, b: string): number {
  const matrix = Array.from({ length: a.length + 1 }, () => Array(b.length + 1).fill(0));
  for (let i = 0; i <= a.length; i++) matrix[i][0] = i;
  for (let j = 0; j <= b.length; j++) matrix[0][j] = j;

  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      if (a[i - 1] === b[j - 1]) {
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        matrix[i][j] = Math.min(
          matrix[i - 1][j] + 1,
          matrix[i][j - 1] + 1,
          matrix[i - 1][j - 1] + 1
        );
      }
    }
  }
  return matrix[a.length][b.length];
}
