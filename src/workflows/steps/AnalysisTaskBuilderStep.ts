import {
  WorkflowStep,
  StepResult,
  ValidationResult,
  WorkflowStepConfig,
} from "../engine/WorkflowStep.js";
import { WorkflowContext } from "../engine/WorkflowContext.js";
import { extractJsonPayloadFromText } from "../../agents/persona.js";
import { TaskPriority } from "./helpers/TaskPriorityCalculator.js";

interface AnalystHypothesis {
  id?: string;
  statement?: string;
  summary?: string;
  confidence?: string | number;
  evidence?: string[];
  affected_components?: string[];
  affected_files?: string[];
  remediation_steps?: string[];
  acceptance_criteria?: string[];
  validation_steps?: string[];
  risks?: string[];
  priority?: TaskPriority;
}

interface AnalystActionPlan {
  title?: string;
  summary?: string;
  rationale?: string;
  steps?: string[];
  remediation_steps?: string[];
  acceptance_criteria?: string[];
  validation_plan?: string[];
  key_files?: string[];
  owners?: string[];
  priority?: TaskPriority;
  labels?: string[];
  blocked_on?: string[];
}

interface AnalystPayload {
  summary?: string;
  root_cause?: string;
  hypotheses?: AnalystHypothesis[];
  action_plan?: AnalystActionPlan;
  recommended_task?: AnalystActionPlan;
}

interface AnalysisReviewPayload {
  status?: string;
  reason?: string;
  notes?: string[];
}

interface AnalysisTaskBuilderConfig {
  analysis_output: unknown;
  review_output?: unknown;
  task?: { id?: string | number; title?: string };
  default_priority?: TaskPriority;
  default_labels?: string[];
}

interface NormalizedPlan {
  title: string;
  summary?: string;
  steps: string[];
  acceptance: string[];
  validation: string[];
  keyFiles: string[];
  priority: TaskPriority;
  labels: string[];
  hypothesis?: AnalystHypothesis;
}

export class AnalysisTaskBuilderStep extends WorkflowStep {
  constructor(config: WorkflowStepConfig) {
    super(config);
  }

  protected async validateConfig(
    _context: WorkflowContext,
  ): Promise<ValidationResult> {
    const cfg = (this.config.config || {}) as AnalysisTaskBuilderConfig;
    const errors: string[] = [];

    if (typeof cfg.analysis_output === "undefined") {
      errors.push("analysis_output is required");
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings: [],
    } satisfies ValidationResult;
  }

  async execute(_context: WorkflowContext): Promise<StepResult> {
    const cfg = (this.config.config || {}) as AnalysisTaskBuilderConfig;
    const analysis = this.normalizePayload<AnalystPayload>(
      cfg.analysis_output,
    );

    if (!analysis) {
      return {
        status: "failure",
        error: new Error("Analysis payload missing or invalid"),
      } satisfies StepResult;
    }

    const review = this.normalizePayload<AnalysisReviewPayload>(
      cfg.review_output,
    );

    if (review && review.status && review.status.toLowerCase() !== "pass") {
      return {
        status: "failure",
        error: new Error(
          review.reason || "Analysis review failed; cannot create tasks",
        ),
      } satisfies StepResult;
    }

    const plan = this.derivePlan(analysis, cfg.default_priority);

    if (!plan) {
      return {
        status: "failure",
        error: new Error(
          "Analysis output did not provide an actionable remediation plan",
        ),
      } satisfies StepResult;
    }

    const taskTitle = plan.title.trim();
    const description = this.composeDescription(plan, analysis, cfg.task);
    const labels = this.sanitizeLabels([
      ...(plan.labels || []),
      ...(cfg.default_labels || []),
      "analysis-derived",
      "ready-for-implementation",
    ]);

    const actionableTasks = [
      {
        title: taskTitle,
        description,
        priority: plan.priority,
        metadata: {
          labels,
          analysis_hypothesis_id: plan.hypothesis?.id || null,
        },
      },
    ];

    return {
      status: "success",
      data: {
        task_count: actionableTasks.length,
        hypothesis_id: plan.hypothesis?.id || null,
      },
      outputs: {
        actionable_tasks: actionableTasks,
        analysis_summary: plan.summary || analysis.summary || analysis.root_cause,
        selected_hypothesis: plan.hypothesis || null,
      },
    } satisfies StepResult;
  }

  private normalizePayload<T>(payload: unknown): T | null {
    if (payload === null || typeof payload === "undefined") {
      return null;
    }

    const normalized = this.unwrapPayload(payload);
    if (normalized && typeof normalized === "object") {
      return normalized as T;
    }

    return null;
  }

  private unwrapPayload(value: unknown): any | null {
    if (value === null || typeof value === "undefined") {
      return null;
    }

    if (typeof value === "string") {
      return this.parseJsonString(value);
    }

    if (typeof value !== "object" || Array.isArray(value)) {
      return null;
    }

    const obj = value as Record<string, unknown>;

    const candidateKeys = [
      "output",
      "result",
      "response",
      "body",
      "preview",
      "data",
    ];

    for (const key of candidateKeys) {
      if (!(key in obj)) continue;
      const nested = this.unwrapPayload(obj[key]);
      if (nested) {
        return nested;
      }
    }

    if (this.looksLikeStructuredPayload(obj)) {
      return obj;
    }

    return obj;
  }

  private looksLikeStructuredPayload(value: Record<string, unknown>): boolean {
    return (
      "summary" in value ||
      "hypotheses" in value ||
      "action_plan" in value ||
      "status" in value ||
      "reason" in value
    );
  }

  private parseJsonString(value: string): any | null {
    const trimmed = value.trim();
    if (!trimmed.length) {
      return null;
    }

    try {
      return JSON.parse(trimmed);
    } catch {
      return extractJsonPayloadFromText(trimmed);
    }
  }

  private derivePlan(
    analysis: AnalystPayload,
    defaultPriority: TaskPriority | undefined,
  ): NormalizedPlan | null {
    const explicit = analysis.action_plan || analysis.recommended_task;
    const selectedHypothesis = this.pickTopHypothesis(analysis.hypotheses);

    if (explicit?.title) {
      return {
        title: explicit.title,
        summary: explicit.summary || analysis.summary || analysis.root_cause,
        steps: this.normalizeList(
          explicit.steps || explicit.remediation_steps,
          "Plan steps",
        ),
        acceptance: this.normalizeList(
          explicit.acceptance_criteria,
          "Acceptance criteria",
        ),
        validation: this.normalizeList(
          explicit.validation_plan,
          "Validation plan",
        ),
        keyFiles: this.normalizeList(explicit.key_files, "Key files"),
        priority: explicit.priority || defaultPriority || "high",
        labels: this.normalizeList(explicit.labels, "Labels"),
        hypothesis: selectedHypothesis || undefined,
      } satisfies NormalizedPlan;
    }

    if (!selectedHypothesis) {
      return null;
    }

    return {
      title:
        selectedHypothesis.statement?.slice(0, 80) ||
        "Implement remediation for reviewer blocker",
      summary:
        analysis.summary ||
        analysis.root_cause ||
        selectedHypothesis.summary ||
        selectedHypothesis.statement,
      steps: this.normalizeList(
        selectedHypothesis.remediation_steps,
        "Remediation steps",
      ),
      acceptance: this.normalizeList(
        selectedHypothesis.acceptance_criteria,
        "Acceptance criteria",
      ),
      validation: this.normalizeList(
        selectedHypothesis.validation_steps,
        "Validation plan",
      ),
      keyFiles: this.normalizeList(
        selectedHypothesis.affected_files ||
          selectedHypothesis.affected_components,
        "Key files",
      ),
      priority: selectedHypothesis.priority || defaultPriority || "high",
      labels: ["analysis"],
      hypothesis: selectedHypothesis,
    } satisfies NormalizedPlan;
  }

  private pickTopHypothesis(
    hypotheses: AnalystHypothesis[] | undefined,
  ): AnalystHypothesis | null {
    if (!hypotheses || hypotheses.length === 0) {
      return null;
    }

    const scored = hypotheses
      .map((hypothesis) => ({
        hypothesis,
        score: this.scoreConfidence(hypothesis.confidence),
      }))
      .sort((a, b) => b.score - a.score);

    return scored[0]?.hypothesis || null;
  }

  private scoreConfidence(value: string | number | undefined): number {
    if (typeof value === "number") {
      return value;
    }

    const normalized = (value || "medium").toString().toLowerCase();

    if (normalized.includes("certain") || normalized.includes("definitive")) {
      return 4;
    }
    if (normalized.includes("high")) {
      return 3;
    }
    if (normalized.includes("medium")) {
      return 2;
    }
    if (normalized.includes("low")) {
      return 1;
    }

    return 0;
  }

  private normalizeList(
    value: string[] | undefined,
    _label: string,
  ): string[] {
    if (!value) {
      return [];
    }

    return value
      .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
      .filter(Boolean);
  }

  private composeDescription(
    plan: NormalizedPlan,
    analysis: AnalystPayload,
    task: AnalysisTaskBuilderConfig["task"],
  ): string {
    const sections: string[] = [];

    if (plan.summary) {
      sections.push(`Summary:\n${plan.summary}`);
    } else if (analysis.summary) {
      sections.push(`Summary:\n${analysis.summary}`);
    }

    if (plan.steps.length) {
      sections.push(
        ["Remediation Steps:", ...plan.steps.map((step, index) => `${index + 1}. ${step}`)].join(
          "\n",
        ),
      );
    }

    if (plan.acceptance.length) {
      sections.push(
        [
          "Acceptance Criteria:",
          ...plan.acceptance.map((criterion) => `- ${criterion}`),
        ].join("\n"),
      );
    }

    if (plan.validation.length) {
      sections.push(
        [
          "Validation Plan:",
          ...plan.validation.map((criterion) => `- ${criterion}`),
        ].join("\n"),
      );
    }

    if (plan.keyFiles.length) {
      sections.push(
        ["Key Files: ", ...plan.keyFiles.map((file) => `- ${file}`)].join("\n"),
      );
    }

    if (plan.hypothesis?.statement) {
      const confidence = plan.hypothesis.confidence
        ? ` (confidence: ${plan.hypothesis.confidence})`
        : "";
      sections.push(
        `Source Hypothesis${confidence}: ${plan.hypothesis.statement}`,
      );
    }

    if (task?.id) {
      sections.push(`Generated for parent task #${task.id}`);
    }

    return sections.join("\n\n");
  }

  private sanitizeLabels(labels: string[]): string[] {
    const blocked = new Set([
      "analysis",
      "analysis_follow_up",
      "analysis-follow-up",
      "review_follow_up",
      "review-follow-up",
    ]);

    const unique = new Set<string>();
    const sanitized: string[] = [];

    for (const label of labels) {
      const normalized = typeof label === "string" ? label.trim() : "";
      if (!normalized) continue;
      const key = normalized.toLowerCase();
      if (blocked.has(key)) continue;
      if (unique.has(key)) continue;
      unique.add(key);
      sanitized.push(normalized);
    }

    return sanitized;
  }
}
