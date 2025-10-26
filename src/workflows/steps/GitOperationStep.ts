import { WorkflowStep, StepResult, ValidationResult } from '../engine/WorkflowStep.js';
import { WorkflowContext } from '../engine/WorkflowContext.js';
import { logger } from '../../logger.js';
import { abortWorkflowDueToPushFailure, abortWorkflowWithReason } from '../helpers/workflowAbort.js';

interface GitOperationConfig {
  operation: 'checkoutBranchFromBase' | 'commitAndPushPaths' | 'verifyRemoteBranchHasDiff' | 'ensureBranchPublished' | 'checkContextFreshness';
  repoRoot?: string;
  baseBranch?: string;
  newBranch?: string;
  branch?: string;
  message?: string;
  paths?: string[];
  taskId?: string | number;
  artifactPath?: string;
}

/**
 * GitOperationStep - Handles git operations like checkout, commit, push, verification
 * This step performs git operations that tests expect to be called during workflows
 */
export class GitOperationStep extends WorkflowStep {
  async execute(context: WorkflowContext): Promise<StepResult> {
    // Test mode: allow skipping git operations entirely
    if (context.getVariable('SKIP_GIT_OPERATIONS') === true) {
      return {
        status: 'success',
        data: { skipped: true },
        outputs: { operation: 'skipped', skipped: true }
      };
    }
    const config = this.config.config as GitOperationConfig;
    const { operation } = config;

    logger.info(`Executing git operation`, {
      workflowId: context.workflowId,
      operation,
      config
    });

    try {
      // Import git utilities dynamically
      const gitUtils = await import('../../gitUtils.js');
      
      // Resolve variables from context
      const repoRoot = this.resolveVariable(config.repoRoot, context) || context.repoRoot;
      const baseBranch = this.resolveVariable(config.baseBranch, context) || context.getVariable('baseBranch') || 'main';
      const newBranch = this.resolveVariable(config.newBranch, context) || context.getVariable('newBranch') || context.getVariable('branch') || 'feat/task';
      const branch = this.resolveVariable(config.branch, context) || context.getVariable('branch') || newBranch;
      const message = this.resolveVariable(config.message, context) || 'feat: automated changes';
      const rawPaths = config.paths ?? context.getVariable('changedPaths') ?? [];
      const paths = Array.isArray(rawPaths)
        ? rawPaths
        : typeof rawPaths === 'string'
          ? [rawPaths]
          : [];

      let result: any;

      switch (operation) {
        case 'checkoutBranchFromBase':
          try {
            if (typeof gitUtils.describeWorkingTree === 'function') {
              const workingTree = await gitUtils.describeWorkingTree(repoRoot);
              if (workingTree.dirty) {
                const branchInfo = workingTree.branch || branch || newBranch;
                const detailPreview = workingTree.porcelain.slice(0, 20);

                context.logger.error('Dirty working tree detected before branch checkout', {
                  workflowId: context.workflowId,
                  repoRoot,
                  branch: branchInfo,
                  baseBranch,
                  summary: workingTree.summary,
                  sample: detailPreview
                });

                await abortWorkflowWithReason(context, 'dirty_working_tree', {
                  repoRoot,
                  baseBranch,
                  branch: branchInfo,
                  workingTree
                });

                return {
                  status: 'failure',
                  error: new Error(`Workflow aborted: repository at ${repoRoot} has uncommitted changes.`),
                  data: {
                    operation,
                    repoRoot,
                    workingTree
                  }
                } satisfies StepResult;
              }
            }
          } catch (dirtyCheckError: any) {
            context.logger.warn('Unable to evaluate working tree cleanliness', {
              workflowId: context.workflowId,
              repoRoot,
              error: dirtyCheckError instanceof Error ? dirtyCheckError.message : String(dirtyCheckError)
            });
          }

          logger.info('Checking out branch from base', {
            repoRoot,
            baseBranch,
            newBranch,
            workflowId: context.workflowId
          });
          
          await gitUtils.checkoutBranchFromBase(repoRoot, baseBranch, newBranch);
          result = { repoRoot, baseBranch, newBranch };
          
          // Set branch context for subsequent steps
          context.setVariable('branch', newBranch);
          context.setVariable('currentBranch', newBranch);
          context.setVariable('baseBranch', baseBranch);
          break;

        case 'commitAndPushPaths':
          logger.info('Committing and pushing paths', {
            repoRoot,
            branch,
            message,
            pathsCount: paths.length,
            workflowId: context.workflowId
          });
          
          result = await gitUtils.commitAndPushPaths({
            repoRoot,
            branch,
            message,
            paths
          });
          
          // Set commit result in context
          context.setVariable('commitResult', result);
          context.setVariable('committed', result.committed);
          context.setVariable('pushed', result.pushed);

          if ((result?.committed && result?.pushed === false) || result?.reason === 'push_failed') {
            await abortWorkflowDueToPushFailure(context, result, {
              message,
              paths
            });

            return {
              status: 'failure',
              error: new Error(`Git push failed for branch ${branch || 'unknown'}`),
              data: {
                operation,
                result
              },
              outputs: {
                operation,
                result,
                commitResult: result
              }
            } satisfies StepResult;
          }
          break;

        case 'verifyRemoteBranchHasDiff':
          logger.info('Verifying remote branch has diff', {
            repoRoot,
            branch,
            baseBranch,
            workflowId: context.workflowId
          });
          
          result = await gitUtils.verifyRemoteBranchHasDiff({
            repoRoot,
            branch,
            baseBranch
          });
          
          // Set verification result in context
          context.setVariable('diffVerification', result);
          context.setVariable('hasDiff', result.hasDiff);
          context.setVariable('diffSummary', result.diffSummary);
          break;

        case 'ensureBranchPublished':
          logger.info('Ensuring branch is published', {
            repoRoot,
            branch,
            workflowId: context.workflowId
          });
          
          await gitUtils.ensureBranchPublished(repoRoot, branch);
          result = { repoRoot, branch, published: true };
          
          context.setVariable('branchPublished', true);
          break;

        case 'checkContextFreshness': {
          logger.info('Checking context freshness', {
            repoRoot,
            workflowId: context.workflowId
          });
          
          // Check if context artifact exists
          const fs = await import('fs/promises');
          const path = await import('path');
          
          // Resolve taskId and artifact path
          const taskId = this.resolveVariable(config.taskId?.toString(), context) || context.getVariable('taskId') || context.getVariable('task_id') || context.getVariable('task')?.id;
          const artifactPath = this.resolveVariable(config.artifactPath, context) || `.ma/tasks/${taskId}/01-context.md`;
          const fullArtifactPath = path.join(repoRoot, artifactPath);
          
          let contextExists = false;
          let hasNewFiles = true;  // Default to true (needs scan) if we can't determine
          
          try {
            await fs.access(fullArtifactPath);
            contextExists = true;
            logger.info('Context artifact exists', { artifactPath, fullArtifactPath });
            
            // Get the commit time when the artifact was last modified using git log
            try {
              // Get the commit hash of the last commit that modified this artifact
              const artifactGitArgs = ['log', '-1', '--pretty=format:%H', '--', artifactPath];
              const artifactGitResult = await gitUtils.runGit(artifactGitArgs, { cwd: repoRoot });
              const artifactCommitHash = artifactGitResult.stdout.trim();
              
              if (!artifactCommitHash) {
                // Artifact exists but isn't in git history - default to needing scan
                logger.warn('Artifact exists but not in git history', { artifactPath });
                hasNewFiles = true;
              } else {
                // Get all commits after the artifact commit, excluding .ma/ changes
                // Using commit_hash..HEAD gets commits after (not including) the artifact commit
                const newCommitsArgs = ['log', `${artifactCommitHash}..HEAD`, '--name-status', '--pretty=format:', '--', '.', ':(exclude).ma/'];
                const newCommitsResult = await gitUtils.runGit(newCommitsArgs, { cwd: repoRoot });
                const newCommitsOutput = newCommitsResult.stdout.trim();
                
                if (!newCommitsOutput) {
                  // No new commits after artifact
                  hasNewFiles = false;
                } else {
                  // Check if there are any file additions or modifications
                  const lines = newCommitsOutput.split('\n').filter((line: string) => line.trim());
                  hasNewFiles = lines.some((line: string) => {
                    const trimmed = line.trim();
                    return trimmed.startsWith('A\t') || trimmed.startsWith('M\t');
                  });
                }
                
                logger.info('Git log check completed', {
                  artifactPath,
                  artifactCommitHash,
                  hasNewFiles
                });
              }
            } catch (gitError: any) {
              logger.warn('Could not check git history for new files', {
                artifactPath,
                error: gitError.message
              });
              // Default to true (needs rescan) if git check fails
              hasNewFiles = true;
            }
          } catch (accessError) {
            // Context artifact doesn't exist
            contextExists = false;
            hasNewFiles = true;  // No context = needs scan
            logger.info('Context artifact does not exist', { artifactPath });
          }
          
          // Set context variables for workflow conditions
          const needsRescan = !contextExists || hasNewFiles;
          context.setVariable('context_exists', contextExists);
          context.setVariable('has_new_files', hasNewFiles);
          context.setVariable('needs_rescan', needsRescan);
          
          result = {
            contextExists,
            hasNewFiles,
            needsRescan,
            artifactPath
          };
          
          logger.info('Context freshness check complete', {
            contextExists,
            hasNewFiles,
            needsRescan,
            artifactPath
          });
          break;
        }

        default:
          throw new Error(`Unsupported git operation: ${operation}`);
      }

      logger.info(`Git operation completed successfully`, {
        workflowId: context.workflowId,
        operation,
        result
      });

      return {
        status: 'success',
        data: result,
        outputs: {
          operation,
          result,
          ...result
        }
      };

    } catch (error: any) {
      logger.error(`Git operation failed`, {
        workflowId: context.workflowId,
        operation,
        error: error.message
      });

      return {
        status: 'failure',
        error: new Error(error.message),
        data: { operation }
      };
    }
  }

  private resolveVariable(value: string | undefined, context: WorkflowContext): string | undefined {
    if (!value) return undefined;
    
    if (typeof value === 'string' && value.startsWith('${') && value.endsWith('}')) {
      const variableName = value.slice(2, -1);
      return context.getVariable(variableName);
    }
    
    return value;
  }

  protected async validateConfig(context: WorkflowContext): Promise<ValidationResult> {
    const errors: string[] = [];
    const config = this.config.config as GitOperationConfig;

    if (!config.operation) {
      errors.push('GitOperationStep: operation is required');
    }

    const validOperations = ['checkoutBranchFromBase', 'commitAndPushPaths', 'verifyRemoteBranchHasDiff', 'ensureBranchPublished', 'checkContextFreshness'];
    if (config.operation && !validOperations.includes(config.operation)) {
      errors.push(`GitOperationStep: operation must be one of: ${validOperations.join(', ')}`);
    }

    // Validate operation-specific requirements
    if (config.operation === 'checkoutBranchFromBase') {
      if (!config.baseBranch && !context.getVariable('baseBranch')) {
        errors.push('GitOperationStep: checkoutBranchFromBase requires baseBranch');
      }
      if (!config.newBranch && !context.getVariable('newBranch') && !context.getVariable('branch')) {
        errors.push('GitOperationStep: checkoutBranchFromBase requires newBranch');
      }
    }

    if (config.operation === 'commitAndPushPaths') {
      if (!config.paths && !context.getVariable('changedPaths')) {
        errors.push('GitOperationStep: commitAndPushPaths requires paths');
      }
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings: []
    };
  }
}