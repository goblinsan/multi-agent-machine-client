import {
  runGit,
  getRepoMetadata,
  checkoutBranchFromBase,
  commitAndPushPaths,
  ensureBranchPublished,
  detectRemoteDefaultBranch,
} from "../gitUtils.js";
import { logger } from "../logger.js";

export interface BranchOptions {
  repoRoot: string;

  branchName: string;

  baseBranch?: string;

  force?: boolean;
}

export interface CommitOptions {
  repoRoot: string;

  files: string[];

  message: string;

  branch?: string;

  push?: boolean;
}

export interface BranchState {
  currentBranch: string;

  existsLocally: boolean;

  existsRemotely: boolean;

  hasChanges: boolean;

  hasUnpushedCommits: boolean;
}

export class GitWorkflowManager {
  async ensureBranch(options: BranchOptions): Promise<string> {
    const { repoRoot, branchName, baseBranch, force = false } = options;

    logger.debug(`GitWorkflowManager: ensuring branch '${branchName}'`, {
      repoRoot,
      baseBranch,
      force,
    });

    const meta = await getRepoMetadata(repoRoot);
    const currentBranch = meta.currentBranch;

    if (currentBranch === branchName && !force) {
      logger.debug(`GitWorkflowManager: already on branch '${branchName}'`);
      return branchName;
    }

    const branchesOutput = await runGit(["branch", "--list", branchName], {
      cwd: repoRoot,
    });
    const branchExists = branchesOutput.stdout.trim().length > 0;

    if (branchExists && !force) {
      logger.debug(
        `GitWorkflowManager: checking out existing branch '${branchName}'`,
      );
      await runGit(["checkout", branchName], { cwd: repoRoot });
      return branchName;
    }

    const base = baseBranch || (await this.getDefaultBranch(repoRoot));
    logger.info(
      `GitWorkflowManager: creating branch '${branchName}' from '${base}'`,
      { force },
    );

    if (force) {
      await checkoutBranchFromBase(repoRoot, base, branchName);
    } else {
      await runGit(["checkout", "-b", branchName, base], { cwd: repoRoot });
    }

    return branchName;
  }

  async checkoutBranch(repoRoot: string, branchName: string): Promise<void> {
    logger.debug(`GitWorkflowManager: checking out branch '${branchName}'`, {
      repoRoot,
    });

    const meta = await getRepoMetadata(repoRoot);
    if (meta.currentBranch === branchName) {
      logger.debug(`GitWorkflowManager: already on branch '${branchName}'`);
      return;
    }

    await runGit(["checkout", branchName], { cwd: repoRoot });
  }

  async commitFiles(options: CommitOptions): Promise<void> {
    const { repoRoot, files, message, branch, push = true } = options;

    logger.debug(`GitWorkflowManager: committing ${files.length} files`, {
      repoRoot,
      branch,
      push,
      message: message.substring(0, 50),
    });

    if (branch) {
      await this.checkoutBranch(repoRoot, branch);
    }

    await commitAndPushPaths({
      repoRoot,
      branch: branch || null,
      message,
      paths: files,
    });

    logger.info(`GitWorkflowManager: committed ${files.length} files`, {
      branch,
    });
  }

  async pushBranch(repoRoot: string, branchName?: string): Promise<void> {
    const meta = await getRepoMetadata(repoRoot);
    const branch = branchName || meta.currentBranch;

    if (!branch) {
      throw new Error(
        "GitWorkflowManager: cannot push - no branch specified and no current branch",
      );
    }

    logger.debug(`GitWorkflowManager: pushing branch '${branch}'`, {
      repoRoot,
    });

    await ensureBranchPublished(repoRoot, branch);

    logger.info(`GitWorkflowManager: pushed branch '${branch}'`);
  }

  async getBranchState(
    repoRoot: string,
    branchName?: string,
  ): Promise<BranchState> {
    const meta = await getRepoMetadata(repoRoot);
    const currentBranch = meta.currentBranch || "HEAD";
    const targetBranch = branchName || currentBranch;

    const localBranches = await runGit(["branch", "--list", targetBranch], {
      cwd: repoRoot,
    });
    const existsLocally = localBranches.stdout.trim().length > 0;

    let existsRemotely = false;
    try {
      const remoteBranches = await runGit(
        ["branch", "-r", "--list", `origin/${targetBranch}`],
        { cwd: repoRoot },
      );
      existsRemotely = remoteBranches.stdout.trim().length > 0;
    } catch (err) {
      logger.debug(`GitWorkflowManager: could not check remote branch`, {
        error: String(err),
      });
    }

    const status = await runGit(["status", "--porcelain"], { cwd: repoRoot });
    const hasChanges = status.stdout.trim().length > 0;

    let hasUnpushedCommits = false;
    if (existsRemotely && currentBranch === targetBranch) {
      try {
        const unpushed = await runGit(
          ["log", `origin/${targetBranch}..HEAD`, "--oneline"],
          { cwd: repoRoot },
        );
        hasUnpushedCommits = unpushed.stdout.trim().length > 0;
      } catch (err) {
        logger.debug(`GitWorkflowManager: could not check unpushed commits`, {
          error: String(err),
        });
      }
    }

    return {
      currentBranch,
      existsLocally,
      existsRemotely,
      hasChanges,
      hasUnpushedCommits,
    };
  }

  async deleteBranch(
    repoRoot: string,
    branchName: string,
    deleteRemote = false,
    force = false,
  ): Promise<void> {
    logger.debug(`GitWorkflowManager: deleting branch '${branchName}'`, {
      repoRoot,
      deleteRemote,
      force,
    });

    const meta = await getRepoMetadata(repoRoot);
    if (meta.currentBranch === branchName) {
      const defaultBranch = await this.getDefaultBranch(repoRoot);
      logger.debug(
        `GitWorkflowManager: switching to '${defaultBranch}' before deleting '${branchName}'`,
      );
      await runGit(["checkout", defaultBranch], { cwd: repoRoot });
    }

    const deleteFlag = force ? "-D" : "-d";
    try {
      await runGit(["branch", deleteFlag, branchName], { cwd: repoRoot });
      logger.info(`GitWorkflowManager: deleted local branch '${branchName}'`);
    } catch (err) {
      logger.warn(
        `GitWorkflowManager: could not delete local branch '${branchName}'`,
        { error: String(err) },
      );
    }

    if (deleteRemote) {
      try {
        await runGit(["push", "origin", "--delete", branchName], {
          cwd: repoRoot,
        });
        logger.info(
          `GitWorkflowManager: deleted remote branch '${branchName}'`,
        );
      } catch (err) {
        logger.warn(
          `GitWorkflowManager: could not delete remote branch '${branchName}'`,
          { error: String(err) },
        );
      }
    }
  }

  async getDefaultBranch(repoRoot: string): Promise<string> {
    const detected = await detectRemoteDefaultBranch(repoRoot);
    return detected || "main";
  }

  async getCurrentBranch(repoRoot: string): Promise<string> {
    const meta = await getRepoMetadata(repoRoot);
    return meta.currentBranch || "HEAD";
  }
}

export const gitWorkflowManager = new GitWorkflowManager();
