import { WorkflowStep, StepResult } from "../engine/WorkflowStep.js";
import { WorkflowContext } from "../engine/WorkflowContext.js";
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
    if (!cfg.analystPersona || !cfg.reviewerPersona) {
      throw new Error(
        "AnalysisReviewLoopStep requires analystPersona and reviewerPersona",
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

      lastAnalysis = extractPersonaOutputs(analystStepResult);
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
        persona: cfg.reviewerPersona,
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
        cfg.reviewerPersona,
        lastReview,
      );
      finalStatus = reviewerStatus;

      if (reviewerStatus === "pass") {
        break;
      }

      reviewHistory.push({
        iteration,
        raw: lastReview,
        normalized: normalizeReviewFeedback(lastReview),
      });

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
      status: "success",
      outputs: {
        analysis_request_result: lastAnalysis,
        analysis_review_result: lastReview,
        analysis_review_status: finalStatus,
        analysis_iterations: iteration,
        analysis_auto_pass: autoPass,
      },
    } satisfies StepResult;
  }
}
