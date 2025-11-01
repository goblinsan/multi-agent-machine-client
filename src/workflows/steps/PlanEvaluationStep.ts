import {
  WorkflowStep,
  StepResult,
  ValidationResult,
} from "../engine/WorkflowStep.js";
import { WorkflowContext } from "../engine/WorkflowContext.js";
import { logger } from "../../logger.js";

interface PlanEvaluationConfig {
  planSource?: "context" | "input";

  minFeasibilityScore?: number;

  minQualityScore?: number;

  requireRiskAssessment?: boolean;

  maxComplexityScore?: number;

  validateRequirements?: boolean;

  customCriteria?: Array<{
    name: string;
    description: string;
    weight: number;
  }>;
}

interface PlanData {
  title?: string;
  description?: string;
  steps?: Array<{
    step: string;
    description: string;
    rationale?: string;
    risks?: string[];
  }>;
  risks?: Array<{
    description: string;
    impact: "low" | "medium" | "high";
    mitigation: string;
  }>;
  complexity?: "low" | "medium" | "high";
  timeline?: {
    estimated_hours: number;
    confidence: "low" | "medium" | "high";
  };
  requirements?: string[];
  dependencies?: string[];
}

interface EvaluationResult {
  overallScore: number;
  feasibilityScore: number;
  qualityScore: number;
  complexityScore: number;
  completenessScore: number;
  riskScore: number;
  issues: Array<{
    type: "error" | "warning" | "info";
    category: string;
    message: string;
    severity: "low" | "medium" | "high";
  }>;
  recommendations: string[];
  approved: boolean;
}

export class PlanEvaluationStep extends WorkflowStep {
  async execute(context: WorkflowContext): Promise<StepResult> {
    const config = this.config.config as PlanEvaluationConfig;
    const startTime = Date.now();

    try {
      logger.info("Starting plan evaluation", { stepName: this.config.name });

      const planData = this.extractPlanData(context, config);
      if (!planData) {
        return {
          status: "failure",
          error: new Error("No plan data found for evaluation"),
          metrics: { duration_ms: Date.now() - startTime },
        };
      }

      const evaluation = this.evaluatePlan(planData, config);

      const approved = this.isPlanApproved(evaluation, config);
      evaluation.approved = approved;

      logger.info("Plan evaluation completed", {
        stepName: this.config.name,
        overallScore: evaluation.overallScore,
        approved: evaluation.approved,
        issueCount: evaluation.issues.length,
      });

      return {
        status: approved ? "success" : "failure",
        data: {
          evaluation,
          planData,
          approved,
        },
        outputs: {
          evaluationScore: evaluation.overallScore,
          feasibilityScore: evaluation.feasibilityScore,
          qualityScore: evaluation.qualityScore,
          complexityScore: evaluation.complexityScore,
          approved: evaluation.approved,
          issues: evaluation.issues,
          recommendations: evaluation.recommendations,
        },
        metrics: {
          duration_ms: Date.now() - startTime,
          operations_count:
            evaluation.issues.length + evaluation.recommendations.length,
        },
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "Unknown error";
      logger.error("Plan evaluation failed", {
        stepName: this.config.name,
        error: errorMessage,
      });

      return {
        status: "failure",
        error: new Error(`Plan evaluation failed: ${errorMessage}`),
        metrics: { duration_ms: Date.now() - startTime },
      };
    }
  }

  protected async validateConfig(
    _context: WorkflowContext,
  ): Promise<ValidationResult> {
    const config = this.config.config as PlanEvaluationConfig;
    const errors: string[] = [];

    if (
      config.minFeasibilityScore !== undefined &&
      (config.minFeasibilityScore < 0 || config.minFeasibilityScore > 1)
    ) {
      errors.push(
        "PlanEvaluationStep: minFeasibilityScore must be between 0 and 1",
      );
    }

    if (
      config.minQualityScore !== undefined &&
      (config.minQualityScore < 0 || config.minQualityScore > 1)
    ) {
      errors.push(
        "PlanEvaluationStep: minQualityScore must be between 0 and 1",
      );
    }

    if (
      config.maxComplexityScore !== undefined &&
      (config.maxComplexityScore < 0 || config.maxComplexityScore > 1)
    ) {
      errors.push(
        "PlanEvaluationStep: maxComplexityScore must be between 0 and 1",
      );
    }

    if (config.customCriteria) {
      for (const criteria of config.customCriteria) {
        if (!criteria.name || !criteria.description) {
          errors.push(
            "PlanEvaluationStep: Custom criteria must have name and description",
          );
        }
        if (criteria.weight < 0 || criteria.weight > 1) {
          errors.push(
            "PlanEvaluationStep: Custom criteria weight must be between 0 and 1",
          );
        }
      }
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings: [],
    };
  }

  private extractPlanData(
    context: WorkflowContext,
    config: PlanEvaluationConfig,
  ): PlanData | null {
    const source = config.planSource || "context";

    if (source === "context") {
      const planningData = context.getStepOutput("planning");
      if (planningData?.plan) {
        return planningData.plan;
      }

      const stepNames = ["plan", "implementation-plan", "code-generation"];
      for (const stepName of stepNames) {
        const stepOutput = context.getStepOutput(stepName);
        if (stepOutput?.plan || stepOutput?.implementationPlan) {
          return stepOutput.plan || stepOutput.implementationPlan;
        }
      }

      return null;
    } else {
      return null;
    }
  }

  private evaluatePlan(
    planData: PlanData,
    config: PlanEvaluationConfig,
  ): EvaluationResult {
    const issues: EvaluationResult["issues"] = [];
    const recommendations: string[] = [];

    const feasibilityScore = this.evaluateFeasibility(
      planData,
      issues,
      recommendations,
    );

    const qualityScore = this.evaluateQuality(
      planData,
      issues,
      recommendations,
    );

    const complexityScore = this.evaluateComplexity(
      planData,
      issues,
      recommendations,
    );

    const completenessScore = this.evaluateCompleteness(
      planData,
      config,
      issues,
      recommendations,
    );

    const riskScore = this.evaluateRiskAssessment(
      planData,
      config,
      issues,
      recommendations,
    );

    const overallScore =
      feasibilityScore * 0.25 +
      qualityScore * 0.25 +
      completenessScore * 0.25 +
      riskScore * 0.15 +
      (1 - complexityScore) * 0.1;

    return {
      overallScore,
      feasibilityScore,
      qualityScore,
      complexityScore,
      completenessScore,
      riskScore,
      issues,
      recommendations,
      approved: false,
    };
  }

  private evaluateFeasibility(
    planData: PlanData,
    issues: EvaluationResult["issues"],
    recommendations: string[],
  ): number {
    let score = 1.0;

    if (!planData.steps || planData.steps.length === 0) {
      issues.push({
        type: "error",
        category: "feasibility",
        message: "Plan has no implementation steps",
        severity: "high",
      });
      score -= 0.5;
    } else {
      for (const step of planData.steps) {
        if (!step.description || step.description.length < 10) {
          issues.push({
            type: "warning",
            category: "feasibility",
            message: `Step "${step.step}" lacks detailed description`,
            severity: "medium",
          });
          score -= 0.1;
        }
      }
    }

    if (planData.timeline) {
      if (planData.timeline.estimated_hours < 1) {
        issues.push({
          type: "warning",
          category: "feasibility",
          message: "Estimated timeline seems too optimistic",
          severity: "medium",
        });
        score -= 0.1;
      }

      if (planData.timeline.confidence === "low") {
        recommendations.push(
          "Consider breaking down the plan into smaller, more predictable chunks",
        );
        score -= 0.05;
      }
    }

    return Math.max(0, score);
  }

  private evaluateQuality(
    planData: PlanData,
    issues: EvaluationResult["issues"],
    recommendations: string[],
  ): number {
    let score = 1.0;

    if (!planData.title || planData.title.length < 5) {
      issues.push({
        type: "warning",
        category: "quality",
        message: "Plan title is missing or too short",
        severity: "low",
      });
      score -= 0.1;
    }

    if (!planData.description || planData.description.length < 20) {
      issues.push({
        type: "warning",
        category: "quality",
        message: "Plan description is missing or too brief",
        severity: "medium",
      });
      score -= 0.2;
    }

    if (planData.steps) {
      let stepsWithRationale = 0;
      for (const step of planData.steps) {
        if (step.rationale && step.rationale.length > 10) {
          stepsWithRationale++;
        }
      }

      const rationaleRatio = stepsWithRationale / planData.steps.length;
      if (rationaleRatio < 0.5) {
        recommendations.push(
          "Add rationale explanations for more implementation steps",
        );
        score -= 0.1;
      }
    }

    return Math.max(0, score);
  }

  private evaluateComplexity(
    planData: PlanData,
    issues: EvaluationResult["issues"],
    recommendations: string[],
  ): number {
    let complexityFactors = 0;

    if (planData.steps) {
      if (planData.steps.length > 10) complexityFactors += 0.3;
      else if (planData.steps.length > 5) complexityFactors += 0.1;
    }

    if (planData.complexity === "high") complexityFactors += 0.4;
    else if (planData.complexity === "medium") complexityFactors += 0.2;

    if (planData.dependencies && planData.dependencies.length > 3) {
      complexityFactors += 0.2;
    }

    if (planData.timeline?.confidence === "low") {
      complexityFactors += 0.1;
    }

    const complexityScore = Math.min(1, complexityFactors);

    if (complexityScore > 0.7) {
      recommendations.push(
        "Consider breaking this plan into smaller, less complex phases",
      );
    }

    return complexityScore;
  }

  private evaluateCompleteness(
    planData: PlanData,
    config: PlanEvaluationConfig,
    issues: EvaluationResult["issues"],
    recommendations: string[],
  ): number {
    let score = 1.0;

    if (
      config.validateRequirements &&
      (!planData.requirements || planData.requirements.length === 0)
    ) {
      issues.push({
        type: "error",
        category: "completeness",
        message: "Plan missing requirements specification",
        severity: "high",
      });
      score -= 0.3;
    }

    if (!planData.steps || planData.steps.length === 0) {
      issues.push({
        type: "error",
        category: "completeness",
        message: "Plan missing implementation steps",
        severity: "high",
      });
      score -= 0.4;
    }

    if (!planData.timeline) {
      issues.push({
        type: "warning",
        category: "completeness",
        message: "Plan missing timeline estimation",
        severity: "medium",
      });
      score -= 0.2;
    }

    if (!planData.dependencies || planData.dependencies.length === 0) {
      recommendations.push("Consider documenting any external dependencies");
      score -= 0.1;
    }

    return Math.max(0, score);
  }

  private evaluateRiskAssessment(
    planData: PlanData,
    config: PlanEvaluationConfig,
    issues: EvaluationResult["issues"],
    recommendations: string[],
  ): number {
    let score = 1.0;

    if (config.requireRiskAssessment) {
      if (!planData.risks || planData.risks.length === 0) {
        issues.push({
          type: "error",
          category: "risk",
          message: "Plan missing required risk assessment",
          severity: "high",
        });
        score -= 0.5;
      } else {
        let risksWithMitigation = 0;
        for (const risk of planData.risks) {
          if (risk.mitigation && risk.mitigation.length > 10) {
            risksWithMitigation++;
          }
        }

        if (risksWithMitigation < planData.risks.length) {
          issues.push({
            type: "warning",
            category: "risk",
            message: "Some risks lack detailed mitigation strategies",
            severity: "medium",
          });
          score -= 0.2;
        }
      }
    } else if (!planData.risks || planData.risks.length === 0) {
      recommendations.push(
        "Consider adding risk assessment to improve plan robustness",
      );
      score -= 0.1;
    }

    return Math.max(0, score);
  }

  private isPlanApproved(
    evaluation: EvaluationResult,
    config: PlanEvaluationConfig,
  ): boolean {
    const minFeasibility = config.minFeasibilityScore || 0.7;
    const minQuality = config.minQualityScore || 0.6;
    const maxComplexity = config.maxComplexityScore || 0.8;

    if (evaluation.feasibilityScore < minFeasibility) return false;
    if (evaluation.qualityScore < minQuality) return false;
    if (evaluation.complexityScore > maxComplexity) return false;

    const criticalErrors = evaluation.issues.filter(
      (issue) => issue.type === "error" && issue.severity === "high",
    );
    if (criticalErrors.length > 0) return false;

    return true;
  }

  async cleanup(_context: WorkflowContext): Promise<void> {
    logger.debug("Plan evaluation step cleanup completed", {
      stepName: this.config.name,
    });
  }
}
