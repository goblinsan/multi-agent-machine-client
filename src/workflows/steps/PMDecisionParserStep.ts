import { WorkflowStep, StepResult, ValidationResult, WorkflowStepConfig } from '../engine/WorkflowStep.js';
import { WorkflowContext } from '../engine/WorkflowContext.js';
import { logger } from '../../logger.js';

/**
 * Normalized PM decision structure
 */
interface PMDecision {
  decision: 'immediate_fix' | 'defer';
  reasoning: string;
  detected_stage?: 'early' | 'beta' | 'production';  // For security reviews
  immediate_issues: string[];
  deferred_issues: string[];
  follow_up_tasks: Array<{
    title: string;
    description: string;
    priority: 'critical' | 'high' | 'medium' | 'low';
  }>;
}

/**
 * Configuration for PMDecisionParserStep
 */
interface PMDecisionParserConfig {
  input: any;         // PM persona output (can be various formats)
  normalize: boolean; // Whether to normalize to standard format
  review_type?: string; // Type of review for context (qa, code_review, security, etc.)
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
 * - Legacy formats from different PM prompts
 * 
 * Example usage in YAML:
 * ```yaml
 * - name: parse_pm_decision
 *   type: PMDecisionParserStep
 *   config:
 *     input: "${pm_evaluation}"
 *     normalize: true
 *     review_type: "qa"
 *   outputs:
 *     decision: decision
 *     follow_up_tasks: follow_up_tasks
 * ```
 */
export class PMDecisionParserStep extends WorkflowStep {
  /**
   * Validate configuration
   */
  protected async validateConfig(context: WorkflowContext): Promise<ValidationResult> {
    const errors: string[] = [];
    const warnings: string[] = [];
    const stepConfig = this.config.config as PMDecisionParserConfig;

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
    const stepConfig = this.config.config as PMDecisionParserConfig;
    const startTime = Date.now();

    try {
      context.logger.info('Parsing PM decision', {
        stepName: this.config.name,
        reviewType: stepConfig.review_type,
        normalize: stepConfig.normalize
      });

      const input = stepConfig.input;

      // Parse decision from input
      let decision: PMDecision;
      
      if (typeof input === 'string') {
        decision = this.parseFromString(input, stepConfig.review_type);
      } else if (typeof input === 'object' && input !== null) {
        decision = this.parseFromObject(input, stepConfig.review_type);
      } else {
        throw new Error(`Unsupported input type: ${typeof input}`);
      }

      // Normalize if requested
      if (stepConfig.normalize) {
        decision = this.normalizeDecision(decision, stepConfig.review_type);
      }

      context.logger.info('PM decision parsed successfully', {
        stepName: this.config.name,
        decision: decision.decision,
        immediateIssues: decision.immediate_issues.length,
        deferredIssues: decision.deferred_issues.length,
        followUpTasks: decision.follow_up_tasks.length
      });

      return {
        status: 'success',
        data: { parsed_decision: decision },
        outputs: {
          decision: decision.decision,
          reasoning: decision.reasoning,
          immediate_issues: decision.immediate_issues,
          deferred_issues: decision.deferred_issues,
          follow_up_tasks: decision.follow_up_tasks,
          detected_stage: decision.detected_stage
        },
        metrics: {
          duration_ms: Date.now() - startTime
        }
      };

    } catch (error: any) {
      context.logger.error('PM decision parsing failed', {
        stepName: this.config.name,
        error: error.message,
        stack: error.stack
      });

      return {
        status: 'failure',
        error: error instanceof Error ? error : new Error(String(error)),
        metrics: {
          duration_ms: Date.now() - startTime
        }
      };
    }
  }

  /**
   * Parse PM decision from string response
   */
  private parseFromString(input: string, reviewType?: string): PMDecision {
    // Try to parse as JSON first
    try {
      const parsed = JSON.parse(input);
      if (typeof parsed === 'object' && parsed !== null) {
        return this.parseFromObject(parsed, reviewType);
      }
    } catch {
      // Not JSON, continue to text parsing
    }

    // Parse structured text response
    // Look for common patterns in PM responses
    const decision: PMDecision = {
      decision: input.toLowerCase().includes('defer') ? 'defer' : 'immediate_fix',
      reasoning: '',
      immediate_issues: [],
      deferred_issues: [],
      follow_up_tasks: []
    };

    // Extract reasoning
    const reasoningMatch = input.match(/reasoning[:\s]+([^\n]+)/i);
    if (reasoningMatch) {
      decision.reasoning = reasoningMatch[1].trim();
    }

    // Extract immediate issues
    const immediateMatch = input.match(/immediate[_\s]issues?[:\s]+\[(.*?)\]/is);
    if (immediateMatch) {
      decision.immediate_issues = this.parseArrayString(immediateMatch[1]);
    }

    // Extract deferred issues
    const deferredMatch = input.match(/deferred[_\s]issues?[:\s]+\[(.*?)\]/is);
    if (deferredMatch) {
      decision.deferred_issues = this.parseArrayString(deferredMatch[1]);
    }

    // Extract follow-up tasks
    const tasksMatch = input.match(/follow[_\s]up[_\s]tasks?[:\s]+\[(.*?)\]/is);
    if (tasksMatch) {
      decision.follow_up_tasks = this.parseTasksArray(tasksMatch[1]);
    }

    return decision;
  }

  /**
   * Parse PM decision from object (JSON response)
   */
  private parseFromObject(input: any, reviewType?: string): PMDecision {
    // Handle nested structure (persona response wrapper)
    let decisionObj = input;
    if (input.pm_decision) {
      decisionObj = input.pm_decision;
    } else if (input.decision_object) {
      decisionObj = input.decision_object;
    } else if (input.output && typeof input.output === 'object') {
      decisionObj = input.output;
    }

    const decision: PMDecision = {
      decision: decisionObj.decision === 'defer' ? 'defer' : 'immediate_fix',
      reasoning: decisionObj.reasoning || '',
      immediate_issues: Array.isArray(decisionObj.immediate_issues) 
        ? decisionObj.immediate_issues 
        : [],
      deferred_issues: Array.isArray(decisionObj.deferred_issues)
        ? decisionObj.deferred_issues
        : [],
      follow_up_tasks: Array.isArray(decisionObj.follow_up_tasks)
        ? decisionObj.follow_up_tasks.map((task: any) => ({
            title: task.title || '',
            description: task.description || '',
            priority: this.normalizePriority(task.priority)
          }))
        : []
    };

    // Extract detected stage for security reviews
    if (decisionObj.detected_stage) {
      decision.detected_stage = decisionObj.detected_stage;
    }

    return decision;
  }

  /**
   * Normalize decision (ensure consistency)
   */
  private normalizeDecision(decision: PMDecision, reviewType?: string): PMDecision {
    // Ensure decision value is valid
    if (decision.decision !== 'immediate_fix' && decision.decision !== 'defer') {
      logger.warn('Invalid decision value, defaulting to defer', {
        originalDecision: decision.decision
      });
      decision.decision = 'defer';
    }

    // Ensure arrays are initialized
    decision.immediate_issues = decision.immediate_issues || [];
    decision.deferred_issues = decision.deferred_issues || [];
    decision.follow_up_tasks = decision.follow_up_tasks || [];

    // Normalize task priorities
    decision.follow_up_tasks = decision.follow_up_tasks.map(task => ({
      ...task,
      priority: this.normalizePriority(task.priority)
    }));

    // Apply review-type-specific logic
    if (reviewType === 'security_review' && !decision.detected_stage) {
      // Infer stage from milestone or other context
      decision.detected_stage = this.inferStage(decision);
    }

    return decision;
  }

  /**
   * Normalize priority string to standard values
   */
  private normalizePriority(priority: any): 'critical' | 'high' | 'medium' | 'low' {
    const p = String(priority).toLowerCase();
    if (p.includes('critical') || p.includes('severe')) return 'critical';
    if (p.includes('high') || p.includes('urgent')) return 'high';
    if (p.includes('low') || p.includes('minor')) return 'low';
    return 'medium';
  }

  /**
   * Parse array string (comma-separated values in quotes)
   */
  private parseArrayString(str: string): string[] {
    const items: string[] = [];
    const matches = str.matchAll(/"([^"]*)"/g);
    for (const match of matches) {
      items.push(match[1]);
    }
    return items;
  }

  /**
   * Parse tasks array from string representation
   */
  private parseTasksArray(str: string): Array<{ title: string; description: string; priority: 'critical' | 'high' | 'medium' | 'low' }> {
    const tasks: Array<{ title: string; description: string; priority: 'critical' | 'high' | 'medium' | 'low' }> = [];
    
    // Try to parse as JSON array
    try {
      const parsed = JSON.parse(`[${str}]`);
      if (Array.isArray(parsed)) {
        return parsed.map((task: any) => ({
          title: task.title || '',
          description: task.description || '',
          priority: this.normalizePriority(task.priority)
        }));
      }
    } catch {
      // Fall back to simple parsing
    }

    // Simple text parsing (one task per line or object)
    const taskMatches = str.matchAll(/\{[^}]+\}/g);
    for (const match of taskMatches) {
      try {
        const task = JSON.parse(match[0]);
        tasks.push({
          title: task.title || '',
          description: task.description || '',
          priority: this.normalizePriority(task.priority)
        });
      } catch {
        // Skip malformed tasks
      }
    }

    return tasks;
  }

  /**
   * Infer development stage from decision context
   */
  private inferStage(decision: PMDecision): 'early' | 'beta' | 'production' {
    const reasoningLower = decision.reasoning.toLowerCase();
    
    if (reasoningLower.includes('production') || reasoningLower.includes('release')) {
      return 'production';
    }
    if (reasoningLower.includes('beta') || reasoningLower.includes('testing')) {
      return 'beta';
    }
    return 'early';
  }
}
