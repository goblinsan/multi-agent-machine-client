import {
  WorkflowStep,
  StepResult,
  ValidationResult as _ValidationResult,
} from "../engine/WorkflowStep.js";
import { WorkflowContext } from "../engine/WorkflowContext.js";
import {
  sendPersonaRequest,
  waitForPersonaCompletion,
  interpretPersonaStatus,
} from "../../agents/persona.js";
import { getContextualPrompt } from "../../personas.context.js";
import { logger } from "../../logger.js";
import { runGit } from "../../gitUtils.js";
import fs from "fs/promises";
import path from "path";
import {
  loadContextDirectory,
  summarizePlanResult,
  summarizeEvaluationResult,
  normalizePlanPayload,
  findPlanLanguageViolations,
  collectAllowedLanguages,
  buildSyntheticEvaluationFailure,
  formatPlanArtifact,
  formatEvaluationArtifact,
} from "./helpers/planningHelpers.js";
import { requiresStatus } from "./helpers/personaStatusPolicy.js";

interface PlanningLoopConfig {
  maxIterations?: number;
  plannerPersona: string;
  evaluatorPersona: string;
  planStep: string;
  evaluateStep: string;
  payload: Record<string, any>;
  timeout?: number;
  deadlineSeconds?: number;
}

export class PlanningLoopStep extends WorkflowStep {
  async execute(context: WorkflowContext): Promise<StepResult> {
    const config = this.config.config as PlanningLoopConfig;
    const {
      maxIterations = 5,
      plannerPersona,
      evaluatorPersona,
      planStep,
      evaluateStep,
      payload,
      timeout = 30000,
      deadlineSeconds = 600,
    } = config;

    let currentIteration = 0;
    let planResult: any = null;
    let evaluationResult: any = null;
    let lastEvaluationPassed = false;

    logger.info("Starting planning evaluation loop", {
      workflowId: context.workflowId,
      maxIterations,
      plannerPersona,
      evaluatorPersona,
    });

    const transport = context.transport;

    while (currentIteration < maxIterations) {
      currentIteration++;

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
          previous_evaluation: evaluationResult,
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
          timeout,
        );

        const parsedPlanResult = summarizePlanResult(planResult);
        const { planData } = normalizePlanPayload(planResult);

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

        const taskId = context.getVariable("task")?.id || "unknown";
        const planContent = formatPlanArtifact(planResult, currentIteration);
        await this.commitArtifact(
          context,
          planContent,
          `.ma/tasks/${taskId}/02-plan-iteration-${currentIteration}.md`,
          `docs(ma): plan iteration ${currentIteration} for task ${taskId}`,
        );

        const allowedLanguageInfo = collectAllowedLanguages(contextInsights);
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
            `.ma/tasks/${taskId}/02-plan-eval-iteration-${currentIteration}.md`,
            `docs(ma): plan evaluation ${currentIteration} for task ${taskId}`,
          );
          lastEvaluationPassed = false;
          logger.warn("Plan rejected due to language policy violation", {
            workflowId: context.workflowId,
            iteration: currentIteration,
            violations: languageViolations,
            allowed_languages: allowedLanguageInfo.display,
          });
          continue;
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
          iteration: currentIteration,
          task: context.getVariable("task"),
          repo: repoRemote,
          branch: currentBranch,
          project_id: context.projectId,
          context_summary: contextSummaryMd,
          context_overview: contextOverview,
          context_insights: contextInsights,
          context_primary_language: contextInsights?.primaryLanguage,
          context_frameworks: contextInsights?.frameworks,
          context_potential_issues: contextInsights?.potentialIssues,

          ...(contextualPrompt ? { _system_prompt: contextualPrompt } : {}),
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
          timeout,
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

        const taskId = context.getVariable("task")?.id || "unknown";
        const evalContent = formatEvaluationArtifact(
          evaluationResult,
          currentIteration,
        );
        await this.commitArtifact(
          context,
          evalContent,
          `.ma/tasks/${taskId}/02-plan-eval-iteration-${currentIteration}.md`,
          `docs(ma): plan evaluation ${currentIteration} for task ${taskId}`,
        );

        lastEvaluationPassed = evaluationStatusInfo.status === "pass";

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
          );

          break;
        } else {
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

    const finalResult = {
      plan: planResult,
      evaluation: evaluationResult,
      iterations: currentIteration,
      evaluationPassed: lastEvaluationPassed,
      reachedMaxIterations: currentIteration >= maxIterations,
    };

    logger.info("Planning loop completed", {
      workflowId: context.workflowId,
      totalIterations: currentIteration,
      maxIterations,
      finalEvaluationPassed: lastEvaluationPassed,
      reachedMaxIterations: currentIteration >= maxIterations,
    });

    return {
      status: "success",
      data: finalResult,
      outputs: {
        plan_result: planResult,
        evaluation_result: evaluationResult,
        iterations: currentIteration,
        evaluation_passed: lastEvaluationPassed,
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

    const repoRoot = context.repoRoot;
    const fullPath = path.join(repoRoot, artifactPath);

    try {
      await fs.mkdir(path.dirname(fullPath), { recursive: true });

      await fs.writeFile(fullPath, content, "utf-8");

      const relativePath = path.relative(repoRoot, fullPath);
      await runGit(["add", relativePath], { cwd: repoRoot });
      await runGit(["commit", "--no-verify", "-m", commitMessage], {
        cwd: repoRoot,
      });

      const sha = (
        await runGit(["rev-parse", "HEAD"], { cwd: repoRoot })
      ).stdout.trim();

      logger.info("Artifact committed to git", {
        workflowId: context.workflowId,
        artifactPath,
        sha: sha.substring(0, 7),
        contentLength: content.length,
      });

      try {
        const remotes = await runGit(["remote"], { cwd: repoRoot });
        const hasRemote = remotes.stdout.trim().length > 0;

        if (hasRemote) {
          const branch = context.getCurrentBranch();
          await runGit(["push", "origin", branch], { cwd: repoRoot });
          logger.info("Artifact pushed to remote", {
            workflowId: context.workflowId,
            artifactPath,
            branch,
          });
        }
      } catch (pushErr) {
        logger.warn("Failed to push artifact (will retry later)", {
          workflowId: context.workflowId,
          artifactPath,
          error: pushErr instanceof Error ? pushErr.message : String(pushErr),
        });
      }
    } catch (error) {
      logger.error("Failed to commit artifact", {
        workflowId: context.workflowId,
        artifactPath,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
