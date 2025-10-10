import { WorkflowStep, StepResult, ValidationResult, WorkflowStepConfig } from '../engine/WorkflowStep.js';
import { WorkflowContext } from '../engine/WorkflowContext.js';
import { logger } from '../../logger.js';

interface GitOperationConfig {
  operation: 'checkoutBranchFromBase' | 'commitAndPushPaths' | 'verifyRemoteBranchHasDiff' | 'ensureBranchPublished';
  repoRoot?: string;
  baseBranch?: string;
  newBranch?: string;
  branch?: string;
  message?: string;
  paths?: string[];
}

/**
 * GitOperationStep - Handles git operations like checkout, commit, push, verification
 * This step performs git operations that tests expect to be called during workflows
 */
export class GitOperationStep extends WorkflowStep {
  async execute(context: WorkflowContext): Promise<StepResult> {
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
      const paths = config.paths || context.getVariable('changedPaths') || [];

      let result: any;

      switch (operation) {
        case 'checkoutBranchFromBase':
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

    const validOperations = ['checkoutBranchFromBase', 'commitAndPushPaths', 'verifyRemoteBranchHasDiff', 'ensureBranchPublished'];
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