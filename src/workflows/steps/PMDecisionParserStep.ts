import { WorkflowStep, StepResult, ValidationResult, WorkflowStepConfig } from '../engine/WorkflowStep.js';
import { WorkflowContext } from '../engine/WorkflowContext.js';
import { logger } from '../../logger.js';
import { DecisionParser, PMDecision } from './pm/DecisionParser.js';
import { DecisionNormalizer } from './pm/DecisionNormalizer.js';
import { PriorityMapper } from './pm/PriorityMapper.js';

/**
 * Normalized PM decision structure
 */
export type { PMDecision } from './pm/DecisionParser.js';

/**
 * Configuration for PMDecisionParserStep
 */
interface PMDecisionParserConfig {
  input: any;         // PM persona output (can be various formats)
  normalize: boolean; // Whether to normalize to standard format
  review_type?: string; // Type of review for context (qa, code_review, security, etc.)
  parent_milestone_id?: number; // Parent milestone ID for validation (optional)
}

/**
 * Step that parses and normalizes PM decision outputs
 * 
 * PM personas may return decisions in different formats.
 * This step normalizes them into a consistent structure for
 * downstream steps (especially BulkTaskCreationStep).
 * 
 * Handles multiple formats:
 * - JSON response with decision object
 * - Text response with structured sections
 * - Different formats from different PM prompts
 * 
 * **Backlog Deprecation (Production Bug Fix):**
 * - PM used to return both `backlog` and `follow_up_tasks` fields
 * - This caused 0 tasks to be created (architectural bug)
 * - Now merges `backlog` into `follow_up_tasks` with warning log
 * - PM prompts should be updated to use only `follow_up_tasks`
 * 
 * **Priority Validation:**
 * - QA urgent tasks: priority 1200 (critical/high)
 * - Code/Security/DevOps urgent tasks: priority 1000 (critical/high)
 * - All deferred tasks: priority 50 (medium/low)
 * 
 * **Milestone Routing:**
 * - Urgent tasks (critical/high): link to parent milestone (immediate)
 * - Deferred tasks (medium/low): link to backlog milestone (future)
 * - Missing parent milestone: handled in BulkTaskCreationStep
 * 
 * Example usage in YAML:
 * ```yaml
 * - name: parse_pm_decision
 *   type: PMDecisionParserStep
 *   config:
 *     input: "${pm_evaluation}"
 *     normalize: true
 *     review_type: "qa"
 *     parent_milestone_id: "${milestone.id}"
 *   outputs:
 *     decision: decision
 *     follow_up_tasks: follow_up_tasks
 * ```
 */
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

  /**
   * Validate configuration
   */
  protected async validateConfig(context: WorkflowContext): Promise<ValidationResult> {
    const errors: string[] = [];
    const warnings: string[] = [];
  const stepConfig = (this.config.config as PMDecisionParserConfig) || ({} as PMDecisionParserConfig);

    if (stepConfig.input === undefined) {
      errors.push('input is required');
    }

    if (stepConfig.normalize !== undefined && typeof stepConfig.normalize !== 'boolean') {
      errors.push('normalize must be a boolean');
    }

    return { valid: errors.length === 0, errors, warnings };
  }

  /**
   * Execute PM decision parsing
   */
  async execute(context: WorkflowContext): Promise<StepResult> {
    // Back-compat: attach a basic logger if missing (tests may pass a plain object)
    if (!(context as any).logger) {
      (context as any).logger = logger;
    }
  const stepConfig = (this.config?.config as PMDecisionParserConfig) || ({} as PMDecisionParserConfig);
    const startTime = Date.now();

    try {
      context.logger.info('Parsing PM decision', {
        stepName: this.config.name,
        reviewType: stepConfig?.review_type,
        normalize: stepConfig?.normalize
      });

  const input = stepConfig?.input ?? (context as any).pm_response;

      // Parse decision from input
  let decision: PMDecision;
  const warnings: string[] = [];
      
      if (typeof input === 'string') {
        decision = this.decisionParser.parseFromString(input, stepConfig?.review_type, warnings);
      } else if (typeof input === 'object' && input !== null) {
        decision = this.decisionParser.parseFromObject(input, stepConfig?.review_type, warnings);
      } else {
        throw new Error(`Unsupported input type: ${typeof input}`);
      }

      // Normalize if requested
      if (stepConfig?.normalize ?? true) {
        decision = this.decisionNormalizer.normalizeDecision(decision, stepConfig?.review_type, warnings);
      }

      // Apply priority mapping and milestone routing expected by behavior tests
      const enrichedDecision = this.priorityMapper.applyPriorityAndMilestoneRouting(
        decision,
        stepConfig?.review_type,
        (context as any),
        warnings
      );

      // Add alias fields expected by behavior tests
      const behaviorCompatDecision: any = {
        ...enrichedDecision,
        immediate_fix: enrichedDecision.decision === 'immediate_fix',
        explanation: enrichedDecision.reasoning
      };

      context.logger.info('PM decision parsed successfully', {
        stepName: this.config.name,
        decision: enrichedDecision.decision,
        immediateIssues: enrichedDecision.immediate_issues.length,
        deferredIssues: enrichedDecision.deferred_issues.length,
        followUpTasks: enrichedDecision.follow_up_tasks.length
      });

      // For direct usage in behavior tests: attach result to plain context object
      try {
        (context as any).pm_decision = behaviorCompatDecision as any;
      } catch { /* context assignment may fail in some test scenarios */ }

      return ({
        status: 'success',
        data: { parsed_decision: behaviorCompatDecision },
        outputs: {
          pm_decision: behaviorCompatDecision  // Output the complete decision object
        },
        metrics: {
          duration_ms: Date.now() - startTime
        },
        // Non-standard fields to satisfy behavior tests
        context: context as any,
        warnings
      } as any) as StepResult;

    } catch (error: any) {
      context.logger.error('PM decision parsing failed', {
        stepName: this.config.name,
        error: error.message,
        stack: error.stack
      });

      return ({
        status: 'failure',
        error: error instanceof Error ? error : new Error(String(error)),
        metrics: {
          duration_ms: Date.now() - startTime
        },
        context: context as any,
        warnings: []
      } as any) as StepResult;
    }
  }
}
