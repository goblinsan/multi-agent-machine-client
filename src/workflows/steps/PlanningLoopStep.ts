import {
  WorkflowStep,
  StepResult,
  ValidationResult as _ValidationResult,
} from "../engine/WorkflowStep.js";
import { WorkflowContext } from "../engine/WorkflowContext.js";
import {
  sendPersonaRequest,
  waitForPersonaCompletion,
  parseEventResult,
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
} from "./helpers/planningHelpers.js";

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

      try {
        logger.info("Making planning request", {
          workflowId: context.workflowId,
          step: planStep,
          persona: plannerPersona,
          iteration: currentIteration,
        });

        const repoRemote =
          context.getVariable("repo_remote") ||
          context.getVariable("effective_repo_path");
        const currentBranch = context.getCurrentBranch();

        const contextDir = await loadContextDirectory(context.repoRoot);

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
        const planContent = this.formatPlanArtifact(
          planResult,
          currentIteration,
        );
        await this.commitArtifact(
          context,
          planContent,
          `.ma/tasks/${taskId}/02-plan-iteration-${currentIteration}.md`,
          `docs(ma): plan iteration ${currentIteration} for task ${taskId}`,
        );
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

        const repoRemote =
          context.getVariable("repo_remote") ||
          context.getVariable("effective_repo_path");
        const currentBranch = context.getCurrentBranch();

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
        const evalContent = this.formatEvaluationArtifact(
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

          const finalPlanContent = this.formatPlanArtifact(
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

  private formatPlanArtifact(planResult: any, iteration: number): string {
    const fields = planResult?.fields || {};
    const resultText = fields.result || "";
    const parsed = parseEventResult(resultText);

    let content = `# Plan Iteration ${iteration}\n\n`;
    content += `Generated: ${new Date().toISOString()}\n\n`;

    if (parsed?.plan && Array.isArray(parsed.plan)) {
      content += `## Implementation Plan\n\n`;
      parsed.plan.forEach((step: any, idx: number) => {
        content += `### Step ${idx + 1}: ${step.goal || "Untitled Step"}\n\n`;
        if (step.key_files && Array.isArray(step.key_files)) {
          content += `**Files:** ${step.key_files.map((f: string) => `\`${f}\``).join(", ")}\n\n`;
        }
        if (step.owners && Array.isArray(step.owners)) {
          content += `**Owners:** ${step.owners.join(", ")}\n\n`;
        }
        if (step.dependencies && Array.isArray(step.dependencies)) {
          content += `**Dependencies:**\n`;
          step.dependencies.forEach((dep: any) => {
            if (typeof dep === "string") {
              content += `  - ${dep}\n`;
            } else if (dep.goal || dep.dependency) {
              content += `  - ${dep.goal || dep.dependency}\n`;
            }
          });
          content += `\n`;
        }
        if (step.acceptance_criteria && Array.isArray(step.acceptance_criteria)) {
          content += `**Acceptance Criteria:**\n`;
          step.acceptance_criteria.forEach((ac: string) => {
            content += `  - ${ac}\n`;
          });
          content += `\n`;
        }
      });
    } else {
      const planText = typeof parsed?.plan === "string" ? parsed.plan : resultText;
      if (planText) {
        content += `## Plan\n\n${planText}\n\n`;
      }
    }

    if (parsed?.risks && Array.isArray(parsed.risks) && parsed.risks.length > 0) {
      content += `## Risks\n\n`;
      parsed.risks.forEach((risk: any, idx: number) => {
        if (typeof risk === "object") {
          content += `${idx + 1}. **${risk.risk || risk.description || "Unknown Risk"}**\n`;
          if (risk.mitigation) {
            content += `   - Mitigation: ${risk.mitigation}\n`;
          }
        } else {
          content += `${idx + 1}. ${risk}\n`;
        }
      });
      content += `\n`;
    }

    if (parsed?.open_questions && Array.isArray(parsed.open_questions) && parsed.open_questions.length > 0) {
      content += `## Open Questions\n\n`;
      parsed.open_questions.forEach((q: any, idx: number) => {
        if (typeof q === "object") {
          content += `${idx + 1}. ${q.question || q.description || JSON.stringify(q)}\n`;
          if (q.answer) {
            content += `   - Answer: ${q.answer}\n`;
          }
        } else {
          content += `${idx + 1}. ${q}\n`;
        }
      });
      content += `\n`;
    }

    if (parsed?.notes && Array.isArray(parsed.notes) && parsed.notes.length > 0) {
      content += `## Notes\n\n`;
      parsed.notes.forEach((note: any, idx: number) => {
        if (typeof note === "object") {
          content += `${idx + 1}. ${note.note || note.description || JSON.stringify(note)}\n`;
          if (note.author) {
            content += `   - By: ${note.author}\n`;
          }
        } else {
          content += `${idx + 1}. ${note}\n`;
        }
      });
      content += `\n`;
    }

    if (parsed?.metadata) {
      content += `## Metadata\n\n\`\`\`json\n${JSON.stringify(parsed.metadata, null, 2)}\n\`\`\`\n`;
    }

    return content;
  }

  private formatEvaluationArtifact(
    evaluationResult: any,
    iteration: number,
  ): string {
    const fields = evaluationResult?.fields || {};
    const parsed = parseEventResult(fields.result);
    const normalized = interpretPersonaStatus(fields.result);

    let content = `# Plan Evaluation - Iteration ${iteration}\n\n`;
    content += `Generated: ${new Date().toISOString()}\n\n`;
    content += `**Status:** ${normalized.status}\n\n`;

    if (normalized.details) {
      content += `## Evaluation Details\n\n${normalized.details}\n\n`;
    }

    if (parsed && typeof parsed === "object") {
      content += `## Structured Feedback\n\n\`\`\`json\n${JSON.stringify(parsed, null, 2)}\n\`\`\`\n`;
    }

    return content;
  }
}
