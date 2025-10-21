/**
 * GitWorkflowManager - Centralized git operations for workflow execution
 * 
 * Single source of truth for all branch lifecycle management and git operations
 * in the multi-agent workflow system.
 * 
 * Responsibilities:
 * - Branch lifecycle: create, checkout, ensure, cleanup
 * - Commit operations: commit files, push to remote
 * - State queries: current branch, has changes, branch exists
 * 
 * Design principles:
 * - Explicit operations (no hidden side effects)
 * - Single responsibility (only git operations)
 * - Testable (uses existing gitUtils primitives)
 * - Stateless (doesn't cache git state)
 */

import { 
  runGit, 
  getRepoMetadata, 
  checkoutBranchFromBase, 
  commitAndPushPaths,
  ensureBranchPublished,
  detectRemoteDefaultBranch 
} from '../gitUtils.js';
import { logger } from '../logger.js';

export interface BranchOptions {
  /** Repository root path */
  repoRoot: string;
  /** Branch name to create/checkout */
  branchName: string;
  /** Base branch to create from (e.g., 'main') */
  baseBranch?: string;
  /** Whether to force create (overwrite existing branch) */
  force?: boolean;
}

export interface CommitOptions {
  /** Repository root path */
  repoRoot: string;
  /** Files to stage and commit (relative to repoRoot) */
  files: string[];
  /** Commit message */
  message: string;
  /** Branch to commit on (optional, uses current if not specified) */
  branch?: string;
  /** Whether to push to remote after committing */
  push?: boolean;
}

export interface BranchState {
  /** Current checked out branch */
  currentBranch: string;
  /** Whether the branch exists locally */
  existsLocally: boolean;
  /** Whether the branch exists on remote */
  existsRemotely: boolean;
  /** Whether there are uncommitted changes */
  hasChanges: boolean;
  /** Whether there are unpushed commits */
  hasUnpushedCommits: boolean;
}

/**
 * Centralized manager for all git operations in workflow execution
 */
export class GitWorkflowManager {
  /**
   * Create or checkout a branch for workflow execution
   * 
   * This is the primary method for establishing a working branch.
   * Creates the branch from base if it doesn't exist, or checks it out if it does.
   * 
   * @param options - Branch creation options
   * @returns The branch name that was created/checked out
   */
  async ensureBranch(options: BranchOptions): Promise<string> {
    const { repoRoot, branchName, baseBranch, force = false } = options;
    
    logger.debug(`GitWorkflowManager: ensuring branch '${branchName}'`, { repoRoot, baseBranch, force });

    // Get current state
    const meta = await getRepoMetadata(repoRoot);
    const currentBranch = meta.currentBranch;

    // If already on target branch and not forcing, we're done
    if (currentBranch === branchName && !force) {
      logger.debug(`GitWorkflowManager: already on branch '${branchName}'`);
      return branchName;
    }

    // Check if branch exists locally
    const branchesOutput = await runGit(['branch', '--list', branchName], { cwd: repoRoot });
    const branchExists = branchesOutput.stdout.trim().length > 0;

    if (branchExists && !force) {
      // Branch exists, just checkout
      logger.debug(`GitWorkflowManager: checking out existing branch '${branchName}'`);
      await runGit(['checkout', branchName], { cwd: repoRoot });
      return branchName;
    }

    // Need to create branch
    const base = baseBranch || await this.getDefaultBranch(repoRoot);
    logger.info(`GitWorkflowManager: creating branch '${branchName}' from '${base}'`, { force });
    
    if (force) {
      // Force create (overwrites existing)
      await checkoutBranchFromBase(repoRoot, base, branchName);
    } else {
      // Create new branch
      await runGit(['checkout', '-b', branchName, base], { cwd: repoRoot });
    }

    return branchName;
  }

  /**
   * Checkout an existing branch
   * 
   * Fails if branch doesn't exist. Use ensureBranch() if you want to create if missing.
   * 
   * @param repoRoot - Repository root path
   * @param branchName - Branch to checkout
   */
  async checkoutBranch(repoRoot: string, branchName: string): Promise<void> {
    logger.debug(`GitWorkflowManager: checking out branch '${branchName}'`, { repoRoot });
    
    // Check if already on target branch
    const meta = await getRepoMetadata(repoRoot);
    if (meta.currentBranch === branchName) {
      logger.debug(`GitWorkflowManager: already on branch '${branchName}'`);
      return;
    }

    await runGit(['checkout', branchName], { cwd: repoRoot });
  }

  /**
   * Commit files and optionally push to remote
   * 
   * @param options - Commit options
   */
  async commitFiles(options: CommitOptions): Promise<void> {
    const { repoRoot, files, message, branch, push = true } = options;
    
    logger.debug(`GitWorkflowManager: committing ${files.length} files`, { 
      repoRoot, 
      branch, 
      push,
      message: message.substring(0, 50) 
    });

    // If branch specified, ensure we're on it
    if (branch) {
      await this.checkoutBranch(repoRoot, branch);
    }

    // Commit (and push if requested)
    await commitAndPushPaths({
      repoRoot,
      branch: branch || null,
      message,
      paths: files
    });

    logger.info(`GitWorkflowManager: committed ${files.length} files`, { branch });
  }

  /**
   * Push current branch to remote
   * 
   * @param repoRoot - Repository root path
   * @param branchName - Branch to push (optional, uses current if not specified)
   */
  async pushBranch(repoRoot: string, branchName?: string): Promise<void> {
    const meta = await getRepoMetadata(repoRoot);
    const branch = branchName || meta.currentBranch;
    
    if (!branch) {
      throw new Error('GitWorkflowManager: cannot push - no branch specified and no current branch');
    }
    
    logger.debug(`GitWorkflowManager: pushing branch '${branch}'`, { repoRoot });
    
    await ensureBranchPublished(repoRoot, branch);
    
    logger.info(`GitWorkflowManager: pushed branch '${branch}'`);
  }

  /**
   * Get the current branch state
   * 
   * @param repoRoot - Repository root path
   * @param branchName - Branch to check (optional, uses current if not specified)
   * @returns Current branch state
   */
  async getBranchState(repoRoot: string, branchName?: string): Promise<BranchState> {
    const meta = await getRepoMetadata(repoRoot);
    const currentBranch = meta.currentBranch || 'HEAD';
    const targetBranch = branchName || currentBranch;

    // Check local existence
    const localBranches = await runGit(['branch', '--list', targetBranch], { cwd: repoRoot });
    const existsLocally = localBranches.stdout.trim().length > 0;

    // Check remote existence
    let existsRemotely = false;
    try {
      const remoteBranches = await runGit(['branch', '-r', '--list', `origin/${targetBranch}`], { cwd: repoRoot });
      existsRemotely = remoteBranches.stdout.trim().length > 0;
    } catch (err) {
      // Remote might not be configured
      logger.debug(`GitWorkflowManager: could not check remote branch`, { error: String(err) });
    }

    // Check for uncommitted changes
    const status = await runGit(['status', '--porcelain'], { cwd: repoRoot });
    const hasChanges = status.stdout.trim().length > 0;

    // Check for unpushed commits (only if branch exists remotely)
    let hasUnpushedCommits = false;
    if (existsRemotely && currentBranch === targetBranch) {
      try {
        const unpushed = await runGit(['log', `origin/${targetBranch}..HEAD`, '--oneline'], { cwd: repoRoot });
        hasUnpushedCommits = unpushed.stdout.trim().length > 0;
      } catch (err) {
        logger.debug(`GitWorkflowManager: could not check unpushed commits`, { error: String(err) });
      }
    }

    return {
      currentBranch,
      existsLocally,
      existsRemotely,
      hasChanges,
      hasUnpushedCommits
    };
  }

  /**
   * Delete a branch (locally and optionally remotely)
   * 
   * @param repoRoot - Repository root path
   * @param branchName - Branch to delete
   * @param deleteRemote - Whether to also delete from remote
   * @param force - Whether to force delete (even if unmerged)
   */
  async deleteBranch(repoRoot: string, branchName: string, deleteRemote = false, force = false): Promise<void> {
    logger.debug(`GitWorkflowManager: deleting branch '${branchName}'`, { repoRoot, deleteRemote, force });

    // Ensure we're not on the branch we're trying to delete
    const meta = await getRepoMetadata(repoRoot);
    if (meta.currentBranch === branchName) {
      const defaultBranch = await this.getDefaultBranch(repoRoot);
      logger.debug(`GitWorkflowManager: switching to '${defaultBranch}' before deleting '${branchName}'`);
      await runGit(['checkout', defaultBranch], { cwd: repoRoot });
    }

    // Delete local branch
    const deleteFlag = force ? '-D' : '-d';
    try {
      await runGit(['branch', deleteFlag, branchName], { cwd: repoRoot });
      logger.info(`GitWorkflowManager: deleted local branch '${branchName}'`);
    } catch (err) {
      logger.warn(`GitWorkflowManager: could not delete local branch '${branchName}'`, { error: String(err) });
    }

    // Delete remote branch if requested
    if (deleteRemote) {
      try {
        await runGit(['push', 'origin', '--delete', branchName], { cwd: repoRoot });
        logger.info(`GitWorkflowManager: deleted remote branch '${branchName}'`);
      } catch (err) {
        logger.warn(`GitWorkflowManager: could not delete remote branch '${branchName}'`, { error: String(err) });
      }
    }
  }

  /**
   * Get the default branch (main/master) for the repository
   * 
   * @param repoRoot - Repository root path
   * @returns Default branch name
   */
  async getDefaultBranch(repoRoot: string): Promise<string> {
    const detected = await detectRemoteDefaultBranch(repoRoot);
    return detected || 'main';
  }

  /**
   * Get the current branch name
   * 
   * @param repoRoot - Repository root path
   * @returns Current branch name
   */
  async getCurrentBranch(repoRoot: string): Promise<string> {
    const meta = await getRepoMetadata(repoRoot);
    return meta.currentBranch || 'HEAD';
  }
}

/**
 * Singleton instance for use across the application
 */
export const gitWorkflowManager = new GitWorkflowManager();
