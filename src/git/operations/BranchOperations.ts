import { logger } from "../../logger.js";
import { runGit, guardWorkspaceMutation } from "../core.js";
import { branchExists, remoteBranchExists, hasLocalChanges } from "../queries.js";




async function handleCheckoutError(repoRoot: string, branch: string, error: any): Promise<never> {
  if (await hasLocalChanges(repoRoot)) {
    const message = `Cannot checkout ${branch}: uncommitted changes detected in local repository at ${repoRoot}. Commit, stash, or discard the changes and try again.`;
    throw new Error(message, { cause: error });
  }
  throw error;
}


export async function checkoutBranchFromBase(repoRoot: string, baseBranch: string, newBranch: string) {
  guardWorkspaceMutation(repoRoot, `checkoutBranchFromBase ${newBranch} from ${baseBranch}`);
  
  const fetchBranch = async (branch: string, warnOnError: boolean) => {
    if (!branch) return;
    try {
      await runGit(["fetch", "origin", branch], { cwd: repoRoot });
    } catch (error) {
      const meta = { repoRoot, branch, error };
      if (warnOnError) {
        logger.warn("git fetch branch failed", meta);
      } else {
        logger.debug("git fetch branch failed", meta);
      }
    }
  };

  await fetchBranch(baseBranch, true);
  await fetchBranch(newBranch, false);

  if (await branchExists(repoRoot, newBranch)) {
    try {
      await runGit(["checkout", newBranch], { cwd: repoRoot });
    } catch (error) {
      await handleCheckoutError(repoRoot, newBranch, error);
    }

    
    const remoteExists = await remoteBranchExists(repoRoot, newBranch);
    if (remoteExists) {
      try {
        await runGit(["pull", "--ff-only", "origin", newBranch], { cwd: repoRoot });
      } catch (error) {
        logger.warn("git pull branch failed", { repoRoot, branch: newBranch, error });
        
        try {
          if (!(await hasLocalChanges(repoRoot))) {
            await runGit(["fetch", "origin", newBranch], { cwd: repoRoot }).catch(() => {});
            await runGit(["reset", "--hard", `origin/${newBranch}`], { cwd: repoRoot });
            logger.info("git branch aligned to origin after non-FF pull", { repoRoot, branch: newBranch });
          }
        } catch (alignErr) {
          logger.warn("git align to origin failed", { repoRoot, branch: newBranch, error: alignErr });
        }
      }
    } else {
      logger.debug("Branch exists locally but not on remote, skipping pull", { repoRoot, branch: newBranch });
    }
    return;
  }

  if (await remoteBranchExists(repoRoot, newBranch)) {
    try {
      await runGit(["checkout", "-B", newBranch, `origin/${newBranch}`], { cwd: repoRoot });
    } catch (error) {
      await handleCheckoutError(repoRoot, newBranch, error);
    }
    return;
  }

  if (await branchExists(repoRoot, baseBranch)) {
    try {
      await runGit(["checkout", baseBranch], { cwd: repoRoot });
    } catch (error) {
      await handleCheckoutError(repoRoot, baseBranch, error);
    }
  } else if (await remoteBranchExists(repoRoot, baseBranch)) {
    try {
      await runGit(["checkout", "-B", baseBranch, `origin/${baseBranch}`], { cwd: repoRoot });
    } catch (error) {
      await handleCheckoutError(repoRoot, baseBranch, error);
    }
  } else {
    throw new Error(`Base branch ${baseBranch} not found in repository ${repoRoot}`);
  }

  try {
    await runGit(["pull", "--ff-only", "origin", baseBranch], { cwd: repoRoot });
  } catch (error) {
    logger.warn("git pull branch failed", { repoRoot, branch: baseBranch, error });
  }

  try {
    await runGit(["checkout", "-B", newBranch, baseBranch], { cwd: repoRoot });
  } catch (error) {
    await handleCheckoutError(repoRoot, newBranch, error);
  }
}
