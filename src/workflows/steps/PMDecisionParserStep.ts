import {
  WorkflowStep,
  StepResult,
  ValidationResult,
  WorkflowStepConfig,
} from "../engine/WorkflowStep.js";
import { WorkflowContext } from "../engine/WorkflowContext.js";
import { logger } from "../../logger.js";
import { DecisionParser, PMDecision } from "./pm/DecisionParser.js";
import { DecisionNormalizer } from "./pm/DecisionNormalizer.js";
import { PriorityMapper } from "./pm/PriorityMapper.js";

export type { PMDecision } from "./pm/DecisionParser.js";

interface PMDecisionParserConfig {
  input: any;
  normalize: boolean;
  review_type?: string;
  parent_milestone_id?: number;
}

export class PMDecisionParserStep extends WorkflowStep {
  private decisionParser: DecisionParser;
  private decisionNormalizer: DecisionNormalizer;
  private priorityMapper: PriorityMapper;

  constructor(config: WorkflowStepConfig) {
    super(config);
    this.decisionParser = new DecisionParser();
    this.decisionNormalizer = new DecisionNormalizer();
    this.priorityMapper = new PriorityMapper();
  }

  protected async validateConfig(
    _context: WorkflowContext,
  ): Promise<ValidationResult> {
    const errors: string[] = [];
    const warnings: string[] = [];
    const stepConfig =
      (this.config.config as PMDecisionParserConfig) ||
      ({} as PMDecisionParserConfig);

    if (stepConfig.input === undefined) {
      errors.push("input is required");
    }

    if (
      stepConfig.normalize !== undefined &&
      typeof stepConfig.normalize !== "boolean"
    ) {
      errors.push("normalize must be a boolean");
    }

    return { valid: errors.length === 0, errors, warnings };
  }

  async execute(context: WorkflowContext): Promise<StepResult> {
    if (!(context as any).logger) {
      (context as any).logger = logger;
    }
    const stepConfig =
      (this.config?.config as PMDecisionParserConfig) ||
      ({} as PMDecisionParserConfig);
    const startTime = Date.now();

    try {
      context.logger.info("Parsing PM decision", {
        stepName: this.config.name,
        reviewType: stepConfig?.review_type,
        normalize: stepConfig?.normalize,
      });

      const input = stepConfig?.input ?? (context as any).pm_response;

      let decision: PMDecision;
      const warnings: string[] = [];

      if (typeof input === "string") {
        decision = this.decisionParser.parseFromString(
          input,
          stepConfig?.review_type,
          warnings,
        );
      } else if (typeof input === "object" && input !== null) {
        decision = this.decisionParser.parseFromObject(
          input,
          stepConfig?.review_type,
          warnings,
        );
      } else {
        throw new Error(`Unsupported input type: ${typeof input}`);
      }

      if (stepConfig?.normalize ?? true) {
        decision = this.decisionNormalizer.normalizeDecision(
          decision,
          stepConfig?.review_type,
          warnings,
        );
      }

      const enrichedDecision =
        this.priorityMapper.applyPriorityAndMilestoneRouting(
          decision,
          stepConfig?.review_type,
          context as any,
          warnings,
        );

      const behaviorCompatDecision: any = {
        ...enrichedDecision,
        immediate_fix: enrichedDecision.decision === "immediate_fix",
        explanation: enrichedDecision.reasoning,
      };

      const outputs = {
        pm_decision: behaviorCompatDecision,
        decision: enrichedDecision.decision,
        reasoning: enrichedDecision.reasoning,
        immediate_issues: enrichedDecision.immediate_issues,
        deferred_issues: enrichedDecision.deferred_issues,
        follow_up_tasks: enrichedDecision.follow_up_tasks,
        detected_stage: enrichedDecision.detected_stage ?? null,
      } as const;

      context.logger.info("PM decision parsed successfully", {
        stepName: this.config.name,
        decision: enrichedDecision.decision,
        immediateIssues: enrichedDecision.immediate_issues.length,
        deferredIssues: enrichedDecision.deferred_issues.length,
        followUpTasks: enrichedDecision.follow_up_tasks.length,
      });

      const setVariable = (context as any).setVariable as
        | ((key: string, value: any) => void)
        | undefined;
      if (typeof setVariable === "function") {
        setVariable.call(context, "pm_decision", behaviorCompatDecision);
        setVariable.call(context, "pm_follow_up_tasks", enrichedDecision.follow_up_tasks);
        setVariable.call(context, "pm_immediate_issues", enrichedDecision.immediate_issues);
        setVariable.call(context, "pm_deferred_issues", enrichedDecision.deferred_issues);
      }

      try {
        (context as any).pm_decision = behaviorCompatDecision;
      } catch (e) {
        logger.debug("Failed to set pm_decision on context", {
          error: String(e),
        });
      }

      return {
        status: "success",
        data: {
          parsed_decision: behaviorCompatDecision,
          decision: enrichedDecision.decision,
          follow_up_tasks: enrichedDecision.follow_up_tasks,
        },
        outputs: { ...outputs },
        metrics: {
          duration_ms: Date.now() - startTime,
        },

        context: context as any,
        warnings,
      } as any as StepResult;
    } catch (error: any) {
      context.logger.error("PM decision parsing failed", {
        stepName: this.config.name,
        error: error.message,
        stack: error.stack,
      });

      return {
        status: "failure",
        error: error instanceof Error ? error : new Error(String(error)),
        metrics: {
          duration_ms: Date.now() - startTime,
        },
        context: context as any,
        warnings: [],
      } as any as StepResult;
    }
  }
}
