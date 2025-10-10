import { WorkflowStep, WorkflowStepConfig, StepResult, ValidationResult } from '../engine/WorkflowStep.js';
import { WorkflowContext } from '../engine/WorkflowContext.js';
import { DiffParser, DiffParseResult } from '../../agents/parsers/DiffParser.js';
import { applyEditOps } from '../../fileops.js';

/**
 * Configuration for diff apply step
 */
interface DiffApplyStepConfig {
  source_output?: string;           // Step output key containing diffs
  source_variable?: string;         // Context variable containing diffs
  validation?: 'none' | 'syntax_check' | 'full';
  backup?: boolean;
  max_file_size?: number;
  allowed_extensions?: string[];
  commit_message?: string;
  dry_run?: boolean;
}

/**
 * Workflow step for parsing and applying code diffs to repository
 */
export class DiffApplyStep extends WorkflowStep {
  constructor(config: WorkflowStepConfig) {
    super(config);
  }

  async execute(context: WorkflowContext): Promise<StepResult> {
    const stepConfig = this.config.config as DiffApplyStepConfig || {};
    const startTime = Date.now();

    try {
      context.logger.info('Starting diff application', {
        stepName: this.config.name,
        sourceOutput: stepConfig.source_output,
        sourceVariable: stepConfig.source_variable,
        validation: stepConfig.validation || 'syntax_check',
        dryRun: stepConfig.dry_run || false
      });

      // Get diff content from step output or context variable
      const diffContent = this.getDiffContent(context, stepConfig);
      if (!diffContent) {
        throw new Error('No diff content found in specified source');
      }

      // Parse the diff content
      const parseResult = DiffParser.parsePersonaResponse(diffContent);
      
      if (!parseResult.success) {
        context.logger.error('Diff parsing failed', {
          stepName: this.config.name,
          errors: parseResult.errors,
          warnings: parseResult.warnings
        });
        
        throw new Error(`Diff parsing failed: ${parseResult.errors.join(', ')}`);
      }

      // Log parsing results
      context.logger.info('Diff parsing completed', {
        stepName: this.config.name,
        diffBlocksFound: parseResult.diffBlocks.length,
        operationsFound: parseResult.editSpec?.ops.length || 0,
        warnings: parseResult.warnings
      });

      if (parseResult.warnings.length > 0) {
        context.logger.warn('Diff parsing warnings', {
          stepName: this.config.name,
          warnings: parseResult.warnings
        });
      }

      if (!parseResult.editSpec || parseResult.editSpec.ops.length === 0) {
        context.logger.warn('No edit operations found in diff', {
          stepName: this.config.name
        });
        
        return {
          status: 'success',
          data: { message: 'No changes to apply' },
          outputs: {
            applied_files: [],
            commit_sha: null,
            operations_count: 0
          },
          metrics: {
            duration_ms: Date.now() - startTime
          }
        };
      }

      // Apply validation if requested
      if (stepConfig.validation && stepConfig.validation !== 'none') {
        await this.validateChanges(parseResult.editSpec, context, stepConfig);
      }

      // Apply the changes if not in dry-run mode
      let applyResult;
      if (stepConfig.dry_run) {
        context.logger.info('Dry run mode - changes not applied', {
          stepName: this.config.name,
          operationsCount: parseResult.editSpec.ops.length
        });
        
        applyResult = {
          changed: parseResult.editSpec.ops.map(op => op.path),
          branch: context.branch,
          sha: 'dry-run'
        };
      } else {
        // Create edit spec JSON for fileops
        const editSpecJson = JSON.stringify(parseResult.editSpec);
        
        // Apply the edits
        applyResult = await applyEditOps(editSpecJson, {
          repoRoot: context.repoRoot,
          maxBytes: stepConfig.max_file_size || 512 * 1024,
          allowedExts: stepConfig.allowed_extensions || [
            '.ts', '.tsx', '.js', '.jsx', '.py', '.md', '.json', 
            '.yml', '.yaml', '.css', '.html', '.sh', '.bat'
          ],
          branchName: context.branch,
          commitMessage: stepConfig.commit_message || this.generateCommitMessage(context)
        });
      }

      context.logger.info('Diff application completed', {
        stepName: this.config.name,
        filesChanged: applyResult.changed.length,
        commitSha: applyResult.sha,
        branch: applyResult.branch
      });

      return {
        status: 'success',
        data: {
          parseResult,
          applyResult
        },
        outputs: {
          applied_files: applyResult.changed,
          commit_sha: applyResult.sha,
          operations_count: parseResult.editSpec.ops.length,
          branch: applyResult.branch
        },
        metrics: {
          duration_ms: Date.now() - startTime,
          operations_count: parseResult.editSpec.ops.length
        }
      };

    } catch (error) {
      context.logger.error('Diff application failed', {
        stepName: this.config.name,
        error: String(error),
        stack: error instanceof Error ? error.stack : undefined
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

  protected async validateConfig(context: WorkflowContext): Promise<ValidationResult> {
    const errors: string[] = [];
    const warnings: string[] = [];
    const stepConfig = this.config.config as DiffApplyStepConfig || {};

    // Check that we have a source for diff content
    if (!stepConfig.source_output && !stepConfig.source_variable) {
      errors.push('Must specify either source_output or source_variable for diff content');
    }

    // Validate source exists
    if (stepConfig.source_output && !context.hasStepOutput(stepConfig.source_output)) {
      errors.push(`Source output '${stepConfig.source_output}' not found in context`);
    }

    if (stepConfig.source_variable && !context.getVariable(stepConfig.source_variable)) {
      warnings.push(`Source variable '${stepConfig.source_variable}' not found in context`);
    }

    // Validate validation setting
    if (stepConfig.validation && !['none', 'syntax_check', 'full'].includes(stepConfig.validation)) {
      errors.push(`Invalid validation setting: ${stepConfig.validation}`);
    }

    // Validate max file size
    if (stepConfig.max_file_size !== undefined && stepConfig.max_file_size <= 0) {
      errors.push('max_file_size must be positive');
    }

    return { valid: errors.length === 0, errors, warnings };
  }

  /**
   * Get diff content from specified source
   */
  private getDiffContent(context: WorkflowContext, config: DiffApplyStepConfig): string | null {
    // Try step output first
    if (config.source_output) {
      const output = context.getStepOutput(config.source_output);
      if (output) {
        // Handle different output formats
        if (typeof output === 'string') {
          return output;
        } else if (output.diffs || output.code_diffs) {
          return output.diffs || output.code_diffs;
        } else if (output.result) {
          return output.result;
        }
      }
    }

    // Try context variable
    if (config.source_variable) {
      const variable = context.getVariable(config.source_variable);
      if (typeof variable === 'string') {
        return variable;
      }
    }

    return null;
  }

  /**
   * Validate changes before applying (placeholder for now)
   */
  private async validateChanges(editSpec: any, context: WorkflowContext, config: DiffApplyStepConfig): Promise<void> {
    if (config.validation === 'syntax_check') {
      // TODO: Implement syntax checking for different file types
      context.logger.debug('Syntax validation not yet implemented', {
        stepName: this.config.name
      });
    } else if (config.validation === 'full') {
      // TODO: Implement full validation (compilation, tests, etc.)
      context.logger.debug('Full validation not yet implemented', {
        stepName: this.config.name
      });
    }
  }

  /**
   * Generate a commit message based on context
   */
  private generateCommitMessage(context: WorkflowContext): string {
    const task = context.getVariable('selected_task');
    const milestone = context.getVariable('selected_milestone');
    
    if (task?.name) {
      return `feat: ${task.name}`;
    } else if (milestone?.name) {
      return `feat: ${milestone.name}`;
    } else {
      return 'feat: apply agent changes';
    }
  }
}