import { runGit } from '../gitUtils.js';


export interface GitResult {
  success: boolean;
  stdout?: string;
  stderr?: string;
  error?: Error;
}


export interface GitApplyResult {
  changed: string[];
  branch: string;
  sha: string;
  remote?: string;
}


export interface GitStateValidation {
  valid: boolean;
  issues: string[];
  currentBranch?: string;
  hasUncommittedChanges?: boolean;
  isClean?: boolean;
  remoteUrl?: string;
}


export class GitService {
  constructor(private repoRoot: string) {}

  
  async validateState(): Promise<GitStateValidation> {
    try {
      const issues: string[] = [];
      
      
      const isGitRepo = await this.isGitRepository();
      if (!isGitRepo) {
        return {
          valid: false,
          issues: ['Not a git repository']
        };
      }

      
      const currentBranch = await this.getCurrentBranch();
      
      
      const hasUncommitted = await this.hasUncommittedChanges();
      
      
      const isClean = await this.isWorkingDirectoryClean();
      
      
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

  
  async isGitRepository(): Promise<boolean> {
    try {
      await runGit(['status', '--porcelain'], { cwd: this.repoRoot });
      return true;
    } catch {
      return false;
    }
  }

  
  async getCurrentBranch(): Promise<string | null> {
    try {
      const result = await runGit(['branch', '--show-current'], { cwd: this.repoRoot });
      return result.stdout.trim() || null;
    } catch {
      return null;
    }
  }

  
  async hasUncommittedChanges(): Promise<boolean> {
    try {
      const result = await runGit(['status', '--porcelain'], { cwd: this.repoRoot });
      return result.stdout.trim().length > 0;
    } catch {
      return false;
    }
  }

  
  async isWorkingDirectoryClean(): Promise<boolean> {
    try {
      await runGit(['diff', '--quiet'], { cwd: this.repoRoot });
      return true;
    } catch {
      return false;
    }
  }

  
  async getRemoteUrl(remote: string = 'origin'): Promise<string | null> {
    try {
      const result = await runGit(['remote', 'get-url', remote], { cwd: this.repoRoot });
      return result.stdout.trim() || null;
    } catch {
      return null;
    }
  }

  
  async createBranch(branchName: string, baseBranch: string = 'main'): Promise<GitResult> {
    try {
      
      await runGit(['fetch', 'origin'], { cwd: this.repoRoot });
      
      
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

  
  async commitChanges(message: string, files?: string[]): Promise<GitResult> {
    try {
      
      if (files && files.length > 0) {
        await runGit(['add', ...files], { cwd: this.repoRoot });
      } else {
        await runGit(['add', '-A'], { cwd: this.repoRoot });
      }

      
      const result = await runGit(['commit', '--no-verify', '-m', message], { cwd: this.repoRoot });
      
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

  
  async getCommitSha(ref: string = 'HEAD'): Promise<string | null> {
    try {
      const result = await runGit(['rev-parse', ref], { cwd: this.repoRoot });
      return result.stdout.trim() || null;
    } catch {
      return null;
    }
  }

  
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

  
  async getBranchStatus(branchName: string, remote: string = 'origin'): Promise<{
    ahead: number;
    behind: number;
    upToDate: boolean;
  }> {
    try {
      
      await runGit(['fetch', remote], { cwd: this.repoRoot });
      
      
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

  
  async getChangedFiles(fromRef: string, toRef: string = 'HEAD'): Promise<string[]> {
    try {
      const result = await runGit(['diff', '--name-only', fromRef, toRef], { cwd: this.repoRoot });
      return result.stdout.trim().split('\n').filter(Boolean);
    } catch {
      return [];
    }
  }
}