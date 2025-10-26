import { runGit } from '../gitUtils.js';

/**
 * Git operation result
 */
export interface GitResult {
  success: boolean;
  stdout?: string;
  stderr?: string;
  error?: Error;
}

/**
 * Git apply result with file details
 */
export interface GitApplyResult {
  changed: string[];
  branch: string;
  sha: string;
  remote?: string;
}

/**
 * Git state validation result
 */
export interface GitStateValidation {
  valid: boolean;
  issues: string[];
  currentBranch?: string;
  hasUncommittedChanges?: boolean;
  isClean?: boolean;
  remoteUrl?: string;
}

/**
 * High-level git operations service
 */
export class GitService {
  constructor(private repoRoot: string) {}

  /**
   * Validate current repository state
   */
  async validateState(): Promise<GitStateValidation> {
    try {
      const issues: string[] = [];
      
      // Check if we're in a git repository
      const isGitRepo = await this.isGitRepository();
      if (!isGitRepo) {
        return {
          valid: false,
          issues: ['Not a git repository']
        };
      }

      // Get current branch
      const currentBranch = await this.getCurrentBranch();
      
      // Check for uncommitted changes
      const hasUncommitted = await this.hasUncommittedChanges();
      
      // Check if working directory is clean
      const isClean = await this.isWorkingDirectoryClean();
      
      // Get remote URL
      const remoteUrl = await this.getRemoteUrl();

      return {
        valid: issues.length === 0,
        issues,
        currentBranch: currentBranch || undefined,
        hasUncommittedChanges: hasUncommitted,
        isClean,
        remoteUrl: remoteUrl || undefined
      };

    } catch (error) {
      return {
        valid: false,
        issues: [`Git state validation failed: ${error}`]
      };
    }
  }

  /**
   * Check if directory is a git repository
   */
  async isGitRepository(): Promise<boolean> {
    try {
      await runGit(['status', '--porcelain'], { cwd: this.repoRoot });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Get current branch name
   */
  async getCurrentBranch(): Promise<string | null> {
    try {
      const result = await runGit(['branch', '--show-current'], { cwd: this.repoRoot });
      return result.stdout.trim() || null;
    } catch {
      return null;
    }
  }

  /**
   * Check if there are uncommitted changes
   */
  async hasUncommittedChanges(): Promise<boolean> {
    try {
      const result = await runGit(['status', '--porcelain'], { cwd: this.repoRoot });
      return result.stdout.trim().length > 0;
    } catch {
      return false;
    }
  }

  /**
   * Check if working directory is clean
   */
  async isWorkingDirectoryClean(): Promise<boolean> {
    try {
      await runGit(['diff', '--quiet'], { cwd: this.repoRoot });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Get remote URL
   */
  async getRemoteUrl(remote: string = 'origin'): Promise<string | null> {
    try {
      const result = await runGit(['remote', 'get-url', remote], { cwd: this.repoRoot });
      return result.stdout.trim() || null;
    } catch {
      return null;
    }
  }

  /**
   * Create a new branch from base
   */
  async createBranch(branchName: string, baseBranch: string = 'main'): Promise<GitResult> {
    try {
      // Fetch latest changes
      await runGit(['fetch', 'origin'], { cwd: this.repoRoot });
      
      // Create and checkout new branch
      const result = await runGit(['checkout', '-b', branchName, `origin/${baseBranch}`], { cwd: this.repoRoot });
      
      return {
        success: true,
        stdout: result.stdout
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error : new Error(String(error))
      };
    }
  }

  /**
   * Switch to existing branch
   */
  async switchToBranch(branchName: string): Promise<GitResult> {
    try {
      const result = await runGit(['checkout', branchName], { cwd: this.repoRoot });
      
      return {
        success: true,
        stdout: result.stdout
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error : new Error(String(error))
      };
    }
  }

  /**
   * Commit changes with message
   */
  async commitChanges(message: string, files?: string[]): Promise<GitResult> {
    try {
      // Add files (or all if none specified)
      if (files && files.length > 0) {
        await runGit(['add', ...files], { cwd: this.repoRoot });
      } else {
        await runGit(['add', '-A'], { cwd: this.repoRoot });
      }

      // Commit changes
      const result = await runGit(['commit', '-m', message], { cwd: this.repoRoot });
      
      return {
        success: true,
        stdout: result.stdout
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error : new Error(String(error))
      };
    }
  }

  /**
   * Push branch to remote
   */
  async pushBranch(branchName: string, remote: string = 'origin', force: boolean = false): Promise<GitResult> {
    try {
      const args = ['push', remote, branchName];
      if (force) {
        args.push('--force');
      }

      const result = await runGit(args, { cwd: this.repoRoot });
      
      return {
        success: true,
        stdout: result.stdout
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error : new Error(String(error))
      };
    }
  }

  /**
   * Get commit SHA
   */
  async getCommitSha(ref: string = 'HEAD'): Promise<string | null> {
    try {
      const result = await runGit(['rev-parse', ref], { cwd: this.repoRoot });
      return result.stdout.trim() || null;
    } catch {
      return null;
    }
  }

  /**
   * Stash current changes
   */
  async stashChanges(message?: string): Promise<GitResult> {
    try {
      const args = ['stash', 'push'];
      if (message) {
        args.push('-m', message);
      }

      const result = await runGit(args, { cwd: this.repoRoot });
      
      return {
        success: true,
        stdout: result.stdout
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error : new Error(String(error))
      };
    }
  }

  /**
   * Pop stashed changes
   */
  async popStash(): Promise<GitResult> {
    try {
      const result = await runGit(['stash', 'pop'], { cwd: this.repoRoot });
      
      return {
        success: true,
        stdout: result.stdout
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error : new Error(String(error))
      };
    }
  }

  /**
   * Reset to specific commit or branch
   */
  async reset(ref: string, hard: boolean = false): Promise<GitResult> {
    try {
      const args = ['reset'];
      if (hard) {
        args.push('--hard');
      }
      args.push(ref);

      const result = await runGit(args, { cwd: this.repoRoot });
      
      return {
        success: true,
        stdout: result.stdout
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error : new Error(String(error))
      };
    }
  }

  /**
   * Get branch status relative to remote
   */
  async getBranchStatus(branchName: string, remote: string = 'origin'): Promise<{
    ahead: number;
    behind: number;
    upToDate: boolean;
  }> {
    try {
      // Fetch to ensure we have latest remote info
      await runGit(['fetch', remote], { cwd: this.repoRoot });
      
      // Get ahead/behind count
      const result = await runGit([
        'rev-list', '--left-right', '--count', 
        `${remote}/${branchName}...${branchName}`
      ], { cwd: this.repoRoot });
      
      const [behind, ahead] = result.stdout.trim().split('\t').map(Number);
      
      return {
        ahead: ahead || 0,
        behind: behind || 0,
        upToDate: (ahead || 0) === 0 && (behind || 0) === 0
      };
    } catch {
      return { ahead: 0, behind: 0, upToDate: false };
    }
  }

  /**
   * Get file changes between refs
   */
  async getChangedFiles(fromRef: string, toRef: string = 'HEAD'): Promise<string[]> {
    try {
      const result = await runGit(['diff', '--name-only', fromRef, toRef], { cwd: this.repoRoot });
      return result.stdout.trim().split('\n').filter(Boolean);
    } catch {
      return [];
    }
  }
}