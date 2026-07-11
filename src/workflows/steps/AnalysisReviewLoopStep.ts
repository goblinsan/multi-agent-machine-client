import { WorkflowStep, StepResult } from "../engine/WorkflowStep.js";
import { WorkflowContext } from "../engine/WorkflowContext.js";
import { extractJsonPayloadFromText } from "../../agents/persona.js";
import {
  AnalysisReviewLoopConfig,
  PersonaStatus,
  ReviewHistoryEntry,
  buildAnalysisGoal,
  buildContextOverview,
  buildQaFindingsText,
  buildReviewFeedbackHistoryDigest,
  buildRevisionDirective,
  detectReviewType,
  executePersonaInvocation,
  extractAcceptanceCriteria,
  extractParentTaskId,
  extractPersonaOutputs,
  extractTaskDescription,
  formatReviewType,
  loadReviewFailureLog,
  loadTaskFileSnippets,
  normalizeReviewFeedback,
  resolvePersonaStatus,
  serializeReviewHistory,
  stringifyForPrompt,
  unwrapTask,
  wrapAutoPass,
} from "./helpers/AnalysisReviewHelpers.js";

export class AnalysisReviewLoopStep extends WorkflowStep {
  async execute(context: WorkflowContext): Promise<StepResult> {
    const cfg = this.config.config as AnalysisReviewLoopConfig;
    const maxIterations = cfg.maxIterations ?? 5;
    const reviewerEnabled = this.isReviewerEnabled(cfg);
    const reviewerPersona = cfg.reviewerPersona || "analysis-reviewer";
    if (!cfg.analystPersona) {
      throw new Error(
        "AnalysisReviewLoopStep requires analystPersona",
      );
    }

    const basePayload = cfg.payload || {};
    const baseReviewPayload = cfg.reviewPayload || {};
    const contextRequest = context.getVariable("context_request_result");
    const contextSummaryMd = context.getVariable("context_summary_md");
    const contextSummary = contextRequest || contextSummaryMd;
    const contextInsights = context.getVariable("context_insights");
    const contextOverview = buildContextOverview(contextInsights);
    const existingTasks =
      basePayload.existing_tasks ??
      context.getVariable("review_existing_tasks") ??
      [];
    const repoRemote =
      context.getVariable("repo_remote") ||
      context.getVariable("effective_repo_path");
    if (!repoRemote) {
      throw new Error(
        "AnalysisReviewLoopStep requires repo_remote or effective_repo_path",
      );
    }
    const branch = context.getCurrentBranch();
    const task = context.getVariable("task");
    const taskRecord = unwrapTask(task);
    const parentTaskId = extractParentTaskId(taskRecord, task);
    const reviewType = detectReviewType(taskRecord, task);
    const reviewTypeLabel = reviewType ? formatReviewType(reviewType) : undefined;
    const reviewArtifact = await loadReviewFailureLog(
      context.repoRoot,
      parentTaskId,
      reviewType,
    );
    const analysisGoal = buildAnalysisGoal(
      basePayload,
      taskRecord,
      reviewTypeLabel,
    );
    const taskAcceptanceCriteria = extractAcceptanceCriteria(taskRecord);
    const qaFindingsText = buildQaFindingsText(
      taskRecord,
      taskAcceptanceCriteria,
    );
    const taskDescription = extractTaskDescription(taskRecord, task);

    const analystFileSnippets = await loadTaskFileSnippets(
      context.repoRoot,
      taskRecord,
      task,
      [taskDescription, reviewArtifact.logText, qaFindingsText]
        .filter((part): part is string => typeof part === "string")
        .join("\n"),
    );
    context.logger.info("Loaded task file snippets for analyst", {
      step: this.config.name,
      fileCount: analystFileSnippets.length,
      files: analystFileSnippets.map((snippet) => snippet.path),
    });
    context.setVariable("analyst_file_snippets", analystFileSnippets);

    let iteration = 0;
    let lastAnalysis: any = null;
    let lastReview: any = null;
    let previousReview: any = null;
    let initialAnalysis: any = null;
    let previousAnalysisOutput: any = null;
    let finalStatus: PersonaStatus = "unknown";
    let autoPass = false;
    const reviewHistory: ReviewHistoryEntry[] = [];

    while (iteration < maxIterations) {
      iteration++;
      context.logger.info("Analysis loop iteration", {
        step: this.config.name,
        iteration,
        maxIterations,
      });

      const normalizedFeedback = normalizeReviewFeedback(previousReview);
      const reviewHistoryText = buildReviewFeedbackHistoryDigest(reviewHistory);

      const revisionContext =
        iteration > 1
          ? {
              goal: analysisGoal,
              initial_analysis_text: stringifyForPrompt(initialAnalysis),
              last_analysis_text: stringifyForPrompt(previousAnalysisOutput),
              reviewer_feedback_text: normalizedFeedback?.text,
            }
          : undefined;

      const analysisPayload: Record<string, any> = {
        ...basePayload,
        iteration,
        attempt: iteration,
        is_revision: iteration > 1,
        review_feedback: previousReview,
        review_feedback_text: normalizedFeedback?.text,
        review_feedback_summary: normalizedFeedback?.summary,
        review_feedback_required_revisions: normalizedFeedback?.requiredRevisions,
        review_feedback_reason: normalizedFeedback?.reason,
        review_feedback_status: normalizedFeedback?.status,
        previous_review: previousReview,
        task,
        repo: repoRemote,
        branch,
        project_id: context.projectId,
        repo_root: context.repoRoot,
        context_summary: contextSummary,
        context_request_result: contextRequest,
        context_summary_md: contextSummaryMd,
        context_analysis: contextRequest,
        context_overview: contextOverview,
        context_insights: contextInsights,
        existing_tasks: existingTasks,
        ...(analystFileSnippets.length
          ? { snippets: "${analyst_file_snippets || []}" }
          : {}),
        ...(reviewType ? { review_type: reviewType } : {}),
        ...(reviewTypeLabel ? { review_type_label: reviewTypeLabel } : {}),
        ...(parentTaskId ? { parent_task_id: parentTaskId } : {}),
        ...(analysisGoal ? { analysis_goal_text: analysisGoal } : {}),
        ...(qaFindingsText ? { qa_findings_text: qaFindingsText } : {}),
        ...(reviewArtifact.logText
          ? { review_failure_log: reviewArtifact.logText }
          : {}),
        ...(reviewArtifact.sourcePath
          ? { review_failure_source: reviewArtifact.sourcePath }
          : {}),
        ...(taskAcceptanceCriteria && taskAcceptanceCriteria.length
          ? { task_acceptance_criteria: taskAcceptanceCriteria }
          : {}),
        ...(taskDescription ? { task_description: taskDescription } : {}),
      } satisfies Record<string, any>;

      if (revisionContext) {
        analysisPayload.analysis_revision_context = revisionContext;
        analysisPayload.analysis_revision_directive =
          buildRevisionDirective(normalizedFeedback) ||
          "Improve the original analysis so it satisfies the reviewer feedback instead of reframing the problem.";
      }
      if (previousAnalysisOutput) {
        analysisPayload.previous_analysis_output = previousAnalysisOutput;
      }
      if (initialAnalysis) {
        analysisPayload.initial_analysis_output = initialAnalysis;
      }
      if (reviewHistory.length > 0) {
        analysisPayload.review_feedback_history = serializeReviewHistory(
          reviewHistory,
        );
      }
      if (reviewHistoryText) {
        analysisPayload.review_feedback_history_text = reviewHistoryText;
      }

      const analystStepResult = await executePersonaInvocation(context, {
        name: `${this.config.name}_analysis_${iteration}`,
        step: cfg.analysisStep || "analysis-root-cause",
        persona: cfg.analystPersona,
        intent: cfg.analysisIntent || "root_cause_analysis",
        payload: analysisPayload,
        promptTemplate: cfg.analysisPromptTemplate,
        timeout: cfg.analysisTimeout,
        deadlineSeconds: cfg.deadlineSeconds,
        maxRetries: cfg.analysisMaxRetries,
        abortOnFailure: true,
      });

      if (analystStepResult.status !== "success") {
        return {
          status: "failure",
          error:
            analystStepResult.error ||
            new Error("Analyst request failed before review"),
        } satisfies StepResult;
      }

      lastAnalysis = this.normalizeAnalysisOutput(
        extractPersonaOutputs(analystStepResult),
      );
      if (!lastAnalysis) {
        return {
          status: "failure",
          error: new Error("Analyst response missing payload"),
        } satisfies StepResult;
      }
      if (!initialAnalysis) {
        initialAnalysis = lastAnalysis;
      }

      previousAnalysisOutput = lastAnalysis;

      const deterministicReview = this.validateAnalysisOutput(lastAnalysis);
      if (!deterministicReview.valid) {
        finalStatus = "fail";
        lastReview = {
          status: "fail",
          deterministic: true,
          reason: deterministicReview.reason,
          required_revisions: deterministicReview.requiredRevisions,
        };
        reviewHistory.push({
          iteration,
          raw: lastReview,
          normalized: normalizeReviewFeedback(lastReview),
        });

        if (iteration >= maxIterations) {
          break;
        }

        previousReview = lastReview;
        continue;
      }

      if (!reviewerEnabled) {
        finalStatus = "pass";
        lastReview = {
          status: "pass",
          deterministic: true,
          reviewer_disabled: true,
          reason:
            "Analysis accepted by deterministic structure validation; LLM reviewer disabled.",
        };
        context.logger.info(
          "Analysis accepted by deterministic validation; skipping LLM reviewer",
          {
            step: this.config.name,
            iteration,
            reviewerPersona,
          },
        );
        break;
      }

      const reviewPayload = {
        ...baseReviewPayload,
        task,
        repo: repoRemote,
        branch,
        project_id: context.projectId,
        existing_tasks: existingTasks,
        repo_root: context.repoRoot,
        analysis_output: lastAnalysis,
        analysis_output_text: stringifyForPrompt(lastAnalysis) ?? "",
        iteration,
        previous_review: previousReview,
        context_summary: contextSummary,
        context_request_result: contextRequest,
        context_summary_md: contextSummaryMd,
        context_overview: contextOverview,
        context_insights: contextInsights,
        ...(analystFileSnippets.length
          ? { snippets: "${analyst_file_snippets || []}" }
          : {}),
        ...(reviewType ? { review_type: reviewType } : {}),
        ...(reviewTypeLabel ? { review_type_label: reviewTypeLabel } : {}),
        ...(parentTaskId ? { parent_task_id: parentTaskId } : {}),
        ...(qaFindingsText ? { qa_findings_text: qaFindingsText } : {}),
        ...(reviewArtifact.logText
          ? { review_failure_log: reviewArtifact.logText }
          : {}),
        ...(reviewArtifact.sourcePath
          ? { review_failure_source: reviewArtifact.sourcePath }
          : {}),
        ...(taskAcceptanceCriteria && taskAcceptanceCriteria.length
          ? { task_acceptance_criteria: taskAcceptanceCriteria }
          : {}),
        ...(taskDescription ? { task_description: taskDescription } : {}),
      } satisfies Record<string, any>;

      const reviewerStepName = `${this.config.name}_review_${iteration}`;
      const reviewerStepResult = await executePersonaInvocation(context, {
        name: reviewerStepName,
        step: cfg.reviewStep || "analysis-review",
        persona: reviewerPersona,
        intent: cfg.reviewIntent || "analysis_evaluation",
        payload: reviewPayload,
        promptTemplate: cfg.reviewPromptTemplate,
        timeout: cfg.reviewTimeout,
        deadlineSeconds: cfg.deadlineSeconds,
        maxRetries: cfg.reviewMaxRetries,
        abortOnFailure: false,
      });

      if (reviewerStepResult.status !== "success") {
        return {
          status: "failure",
          error:
            reviewerStepResult.error ||
            new Error("Review request failed during analysis loop"),
        } satisfies StepResult;
      }

      lastReview = extractPersonaOutputs(reviewerStepResult);
      const reviewerStatus = resolvePersonaStatus(
        context,
        reviewerStepName,
        reviewerPersona,
        lastReview,
      );
      finalStatus = reviewerStatus;

      if (reviewerStatus === "pass") {
        break;
      }

      const currentFeedback = normalizeReviewFeedback(lastReview);
      reviewHistory.push({
        iteration,
        raw: lastReview,
        normalized: currentFeedback,
      });

      const staleFeedbackThreshold = Math.min(3, maxIterations);
      if (reviewHistory.length >= staleFeedbackThreshold) {
        const recent = reviewHistory.slice(-staleFeedbackThreshold);
        const reasons = recent.map((r) => r.normalized?.reason ?? r.normalized?.text ?? "");
        const allIdentical = reasons.every((r) => r === reasons[0] && r.length > 0);
        if (allIdentical) {
          autoPass = true;
          finalStatus = "pass";
          lastReview = wrapAutoPass(
            lastReview,
            iteration,
            `Reviewer gave identical feedback ${staleFeedbackThreshold} times — auto-passing`,
          );
          context.logger.warn("Analysis auto-pass: repeated identical feedback", {
            step: this.config.name,
            iteration,
            repeatedReason: reasons[0],
          });
          break;
        }
      }

      if (iteration >= maxIterations) {
        autoPass = true;
        finalStatus = "pass";
        lastReview = wrapAutoPass(lastReview, iteration, cfg.autoPassReason);
        context.logger.warn("Analysis auto-pass applied", {
          step: this.config.name,
          iteration,
          reason: cfg.autoPassReason || "max iterations reached",
        });
        break;
      }

      previousReview = lastReview;
    }

    context.setVariable("analysis_request_result", lastAnalysis);
    context.setVariable("analysis_review_result", lastReview);
    context.setVariable("analysis_review_status", finalStatus);
    context.setVariable("analysis_iterations", iteration);
    context.setVariable("analysis_auto_pass", autoPass);

    return {
      status: finalStatus === "fail" ? "failure" : "success",
      error:
        finalStatus === "fail"
          ? new Error(
              lastReview?.reason ||
                "Analysis failed deterministic validation",
            )
          : undefined,
      outputs: {
        analysis_request_result: lastAnalysis,
        analysis_review_result: lastReview,
        analysis_review_status: finalStatus,
        analysis_iterations: iteration,
        analysis_auto_pass: autoPass,
      },
    } satisfies StepResult;
  }

  private isReviewerEnabled(cfg: AnalysisReviewLoopConfig): boolean {
    const configured =
      cfg.analysisReviewer ??
      cfg.analysis_reviewer ??
      cfg.enableReviewer ??
      cfg.enable_reviewer;
    if (configured !== undefined) {
      return this.parseReviewerFlag(configured);
    }
    return this.parseReviewerFlag(process.env.ANALYSIS_REVIEWER ?? "off");
  }

  private parseReviewerFlag(value: unknown): boolean {
    if (typeof value === "boolean") return value;
    if (typeof value === "number") return value !== 0;
    const normalized = String(value || "").trim().toLowerCase();
    return ["1", "true", "yes", "on", "enabled"].includes(normalized);
  }

  private normalizeAnalysisOutput(analysis: any): any {
    if (typeof analysis === "string") {
      return extractJsonPayloadFromText(analysis) ?? analysis;
    }

    if (!analysis || typeof analysis !== "object" || Array.isArray(analysis)) {
      return analysis;
    }

    for (const key of ["output", "result", "response", "data"]) {
      const value = analysis[key];
      if (typeof value === "string") {
        const parsed = extractJsonPayloadFromText(value);
        if (parsed && typeof parsed === "object") {
          return parsed;
        }
      } else if (value && typeof value === "object" && !Array.isArray(value)) {
        return value;
      }
    }

    return analysis;
  }

  private validateAnalysisOutput(analysis: any): {
    valid: boolean;
    reason?: string;
    requiredRevisions?: string[];
  } {
    if (!analysis || typeof analysis !== "object" || Array.isArray(analysis)) {
      return {
        valid: false,
        reason: "Analyst output must be a structured JSON object.",
        requiredRevisions: ["Return a JSON object with summary and remediation fields."],
      };
    }

    const hasUsefulContent = [
      "summary",
      "root_cause",
      "hypotheses",
      "action_plan",
      "actionPlan",
      "remediation_steps",
      "follow_up_tasks",
    ].some((key) => {
      const value = analysis[key];
      return Array.isArray(value)
        ? value.length > 0
        : typeof value === "object"
          ? value !== null
          : typeof value === "string" && value.trim().length > 0;
    });

    if (!hasUsefulContent) {
      return {
        valid: false,
        reason:
          "Analyst output must include a non-empty summary, hypothesis, action plan, remediation steps, or follow-up tasks.",
        requiredRevisions: [
          "Provide a concrete analysis summary and remediation-ready action plan.",
        ],
      };
    }

    return { valid: true };
  }
}
