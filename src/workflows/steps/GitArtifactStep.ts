import { WorkflowStep, WorkflowStepConfig, StepResult, ValidationResult } from '../engine/WorkflowStep.js';
import { WorkflowContext } from '../engine/WorkflowContext.js';
import { runGit } from '../../gitUtils.js';
import fs from 'fs/promises';
import path from 'path';

/**
 * Configuration for git artifact step
 */
interface GitArtifactStepConfig {
  source_output: string;              // Step output key or variable containing data
  artifact_path: string;              // Path in .ma/ directory (e.g., ".ma/tasks/${task.id}/03-plan-final.md")
  commit_message: string;             // Git commit message
  format?: 'markdown' | 'json';       // Output format (default: markdown)
  extract_field?: string;             // Optional: extract nested field from source data
  template?: string;                  // Optional: template path for formatting
}

/**
 * GitArtifactStep - Commits persona outputs to .ma/ directory for git-based persistence
 * 
 * This step replaces the broken ephemeral transport layer approach by committing
 * all workflow artifacts (plans, evaluations, QA results) to git as the source of truth.
 * 
 * Example usage:
 * ```yaml
 * - name: commit_approved_plan
 *   type: GitArtifactStep
 *   config:
 *     source_output: "planning_loop_plan_result"
 *     artifact_path: ".ma/tasks/${task.id}/03-plan-final.md"
 *     commit_message: "docs(ma): approved plan for task ${task.id}"
 *     extract_field: "plan"
 * ```
 */
export class GitArtifactStep extends WorkflowStep {
  constructor(config: WorkflowStepConfig) {
    super(config);
  }

  async execute(context: WorkflowContext): Promise<StepResult> {
    const config = this.config.config as GitArtifactStepConfig;
    const startTime = Date.now();

    // Validate required fields
    if (!config.source_output) {
      throw new Error('GitArtifactStep: source_output is required');
    }
    if (!config.artifact_path) {
      throw new Error('GitArtifactStep: artifact_path is required');
    }
    if (!config.commit_message) {
      throw new Error('GitArtifactStep: commit_message is required');
    }

    // Test bypass: skip git operations in test mode
    const skipGitOps = ((): boolean => {
      try {
        return context.getVariable('SKIP_GIT_OPERATIONS') === true;
      } catch {
        return false;
      }
    })();

    if (skipGitOps) {
      context.logger.info('GitArtifactStep bypassed due to SKIP_GIT_OPERATIONS', {
        stepName: this.config.name,
        artifactPath: config.artifact_path
      });
      return {
        status: 'success',
        data: {
          path: config.artifact_path,
          sha: 'skipped',
          bypassed: true
        },
        outputs: {
          [`${this.config.name}_sha`]: 'skipped',
          [`${this.config.name}_path`]: config.artifact_path
        }
      };
    }

    try {
      // 1. Extract data from workflow context
      let data: any;
      try {
        data = context.getVariable(config.source_output);
      } catch (err) {
        throw new Error(`GitArtifactStep: Failed to get data from source_output '${config.source_output}': ${err}`);
      }

      // 2. Extract nested field if specified
      if (config.extract_field) {
        if (data && typeof data === 'object' && config.extract_field in data) {
          data = data[config.extract_field];
        } else {
          throw new Error(`GitArtifactStep: extract_field '${config.extract_field}' not found in source data`);
        }
      }

      if (data === undefined || data === null) {
        throw new Error(`GitArtifactStep: No data found at source_output '${config.source_output}'${config.extract_field ? `.${config.extract_field}` : ''}`);
      }

      // 3. Format content
      const format = config.format || 'markdown';
      const content = format === 'json' 
        ? JSON.stringify(data, null, 2)
        : this.formatMarkdown(data, config.template);

      // 4. Resolve artifact path with variables
      const resolvedPath = this.resolveVariables(config.artifact_path, context);
      
      // Validate path is within .ma/ directory (security)
      if (!resolvedPath.startsWith('.ma/')) {
        throw new Error(`GitArtifactStep: artifact_path must start with '.ma/' for security (got: ${resolvedPath})`);
      }

      const repoRoot = context.repoRoot;
      const fullPath = path.join(repoRoot, resolvedPath);

      context.logger.info('Writing artifact to git', {
        stepName: this.config.name,
        artifactPath: resolvedPath,
        contentLength: content.length,
        format
      });

      // 5. Write file to git working tree
      await fs.mkdir(path.dirname(fullPath), { recursive: true });
      await fs.writeFile(fullPath, content, 'utf-8');

      // 6. Commit to git
      const commitMsg = this.resolveVariables(config.commit_message, context);
      const relativePath = path.relative(repoRoot, fullPath);

      try {
        await runGit(['add', relativePath], { cwd: repoRoot });
        await runGit(['commit', '-m', commitMsg], { cwd: repoRoot });
      } catch (err) {
        // Retry with force add if initial commit fails
        context.logger.warn('Initial commit failed, retrying with force add', {
          error: err instanceof Error ? err.message : String(err)
        });
        await runGit(['add', '--force', relativePath], { cwd: repoRoot });
        await runGit(['commit', '-m', commitMsg], { cwd: repoRoot });
      }

      // 7. Get commit SHA
      const sha = (await runGit(['rev-parse', 'HEAD'], { cwd: repoRoot })).stdout.trim();

      context.logger.info('Artifact committed to git', {
        stepName: this.config.name,
        artifactPath: resolvedPath,
        sha: sha.substring(0, 7),
        commitMessage: commitMsg
      });

      // 8. Push to remote
      const branch = context.getCurrentBranch();
      try {
        // Check if remote exists before attempting push
        const remotes = await runGit(['remote'], { cwd: repoRoot });
        const hasRemote = remotes.stdout.trim().length > 0;

        if (hasRemote) {
          await runGit(['push', 'origin', branch], { cwd: repoRoot });
          context.logger.info('Artifact pushed to remote', {
            stepName: this.config.name,
            branch,
            sha: sha.substring(0, 7)
          });
        } else {
          context.logger.warn('No remote configured, skipping push', {
            stepName: this.config.name,
            note: 'Typical in test environments'
          });
        }
      } catch (pushErr) {
        // Log push failure but don't fail the workflow
        // Distributed agents can still pull once network recovers
        context.logger.warn('Failed to push artifact (will retry later)', {
          stepName: this.config.name,
          branch,
          sha: sha.substring(0, 7),
          error: pushErr instanceof Error ? pushErr.message : String(pushErr)
        });
      }

      const elapsed = Date.now() - startTime;

      return {
        status: 'success',
        data: {
          path: resolvedPath,
          sha,
          contentLength: content.length,
          format,
          elapsed
        },
        outputs: {
          [`${this.config.name}_sha`]: sha,
          [`${this.config.name}_path`]: resolvedPath
        }
      };

    } catch (error) {
      context.logger.error('GitArtifactStep failed', {
        stepName: this.config.name,
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined
      });

      return {
        status: 'failure',
        error: error instanceof Error ? error : new Error(String(error)),
        data: {
          path: config.artifact_path,
          failed: true
        }
      };
    }
  }

  async validate(_context: WorkflowContext): Promise<ValidationResult> {
    const config = this.config.config as GitArtifactStepConfig;
    const errors: string[] = [];
    const warnings: string[] = [];

    if (!config.source_output || typeof config.source_output !== 'string') {
      errors.push('GitArtifactStep: source_output is required and must be a string');
    }

    if (!config.artifact_path || typeof config.artifact_path !== 'string') {
      errors.push('GitArtifactStep: artifact_path is required and must be a string');
    } else if (!config.artifact_path.startsWith('.ma/')) {
      errors.push('GitArtifactStep: artifact_path must start with \'.ma/\' for security');
    }

    if (!config.commit_message || typeof config.commit_message !== 'string') {
      errors.push('GitArtifactStep: commit_message is required and must be a string');
    }

    if (config.format && !['markdown', 'json'].includes(config.format)) {
      errors.push('GitArtifactStep: format must be \'markdown\' or \'json\'');
    }

    if (config.extract_field && typeof config.extract_field !== 'string') {
      errors.push('GitArtifactStep: extract_field must be a string');
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings
    };
  }

  /**
   * Format data as markdown
   */
  private formatMarkdown(data: any, template?: string): string {
    // If data is already a string, use it directly
    if (typeof data === 'string') {
      return data;
    }

    // If template provided, use it (future enhancement)
    if (template) {
      // TODO: Load and render template
      // For now, just stringify
    }

    // Default markdown format: JSON pretty-print wrapped in code fence
    if (typeof data === 'object') {
      return `# Workflow Artifact\n\nGenerated: ${new Date().toISOString()}\n\n\`\`\`json\n${JSON.stringify(data, null, 2)}\n\`\`\`\n`;
    }

    // Fallback: convert to string
    return String(data);
  }

  /**
   * Resolve ${variable} placeholders in strings
   * Supports nested access like ${task.id} or ${milestone.name}
   */
  private resolveVariables(str: string, context: WorkflowContext): string {
    return str.replace(/\$\{([^}]+)\}/g, (match, varPath) => {
      try {
        const parts = varPath.trim().split('.');
        let value: any = context.getVariable(parts[0]);
        
        // Traverse nested properties
        for (let i = 1; i < parts.length; i++) {
          if (value && typeof value === 'object' && parts[i] in value) {
            value = value[parts[i]];
          } else {
            // Property not found, return original placeholder
            return match;
          }
        }
        
        if (value === undefined || value === null) {
          // Return original placeholder if variable not found
          return match;
        }
        return String(value);
      } catch {
        // Return original placeholder if variable not found
        return match;
      }
    });
  }
}
