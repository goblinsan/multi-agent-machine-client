import { logger } from "../../logger.js";
import { runGit, guardWorkspaceMutation } from "../core.js";
import {
  branchExists,
  remoteBranchExists,
  hasLocalChanges,
} from "../queries.js";

async function handleCheckoutError(
  repoRoot: string,
  branch: string,
  error: any,
): Promise<never> {
  if (await hasLocalChanges(repoRoot)) {
    const message = `Cannot checkout ${branch}: uncommitted changes detected in local repository at ${repoRoot}. Commit, stash, or discard the changes and try again.`;
    throw new Error(message, { cause: error });
  }
  throw error;
}

export async function checkoutBranchFromBase(
  repoRoot: string,
  baseBranch: string,
  newBranch: string,
) {
  guardWorkspaceMutation(
    repoRoot,
    `checkoutBranchFromBase ${newBranch} from ${baseBranch}`,
  );

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
        await runGit(["pull", "--ff-only", "origin", newBranch], {
          cwd: repoRoot,
        });
        logger.debug("git pull successful", {
          repoRoot,
          branch: newBranch,
        });
      } catch (error) {
        logger.warn("git pull branch failed", {
          repoRoot,
          branch: newBranch,
          error,
        });

        try {
          if (!(await hasLocalChanges(repoRoot))) {
            await runGit(["fetch", "origin", newBranch], {
              cwd: repoRoot,
            }).catch(() => {});
            await runGit(["reset", "--hard", `origin/${newBranch}`], {
              cwd: repoRoot,
            });
            logger.info("git branch aligned to origin after non-FF pull", {
              repoRoot,
              branch: newBranch,
            });
          }
        } catch (alignErr) {
          logger.warn("git align to origin failed", {
            repoRoot,
            branch: newBranch,
            error: alignErr,
          });
        }
      }
    } else {
      logger.debug("Branch exists locally but not on remote, skipping pull", {
        repoRoot,
        branch: newBranch,
      });
    }
    return;
  }

  if (await remoteBranchExists(repoRoot, newBranch)) {
    try {
      await runGit(["checkout", "-B", newBranch, `origin/${newBranch}`], {
        cwd: repoRoot,
      });
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
      await runGit(["checkout", "-B", baseBranch, `origin/${baseBranch}`], {
        cwd: repoRoot,
      });
    } catch (error) {
      await handleCheckoutError(repoRoot, baseBranch, error);
    }
  } else {
    throw new Error(
      `Base branch ${baseBranch} not found in repository ${repoRoot}`,
    );
  }

  try {
    await runGit(["pull", "--ff-only", "origin", baseBranch], {
      cwd: repoRoot,
    });
  } catch (error) {
    logger.warn("git pull branch failed", {
      repoRoot,
      branch: baseBranch,
      error,
    });
  }

  try {
    await runGit(["checkout", "-B", newBranch, baseBranch], { cwd: repoRoot });
  } catch (error) {
    await handleCheckoutError(repoRoot, newBranch, error);
  }
}

const CONTEXT_PATH_PREFIXES = [".ma/context/", ".ma/"];

async function getConflictedFiles(repoRoot: string): Promise<string[]> {
  const result = await runGit(["diff", "--name-only", "--diff-filter=U"], { cwd: repoRoot });
  return result.stdout
    .split("\n")
    .map((f: string) => f.trim())
    .filter(Boolean);
}

function isContextFile(filePath: string): boolean {
  return CONTEXT_PATH_PREFIXES.some((prefix) => filePath.startsWith(prefix));
}

async function tryResolveConflicts(
  repoRoot: string,
  sourceBranch: string,
  targetBranch: string,
): Promise<boolean> {
  const conflicted = await getConflictedFiles(repoRoot);
  if (conflicted.length === 0) return false;

  const contextFiles = conflicted.filter(isContextFile);
  const otherFiles = conflicted.filter((f) => !isContextFile(f));

  if (contextFiles.length > 0) {
    await runGit(["checkout", "--theirs", "--", ...contextFiles], { cwd: repoRoot });
    await runGit(["add", "--", ...contextFiles], { cwd: repoRoot });
    logger.info("Auto-resolved context file conflicts (using source branch)", {
      repoRoot,
      files: contextFiles,
    });
  }

  for (const file of otherFiles) {
    try {
      await runGit(["checkout", "--theirs", "--", file], { cwd: repoRoot });
      await runGit(["add", "--", file], { cwd: repoRoot });
      logger.info("Auto-resolved conflict using source branch version", {
        repoRoot,
        file,
      });
    } catch {
      logger.warn("Could not auto-resolve conflict", { repoRoot, file });
      return false;
    }
  }

  const remaining = await getConflictedFiles(repoRoot);
  if (remaining.length > 0) {
    logger.warn("Unresolved conflicts remain after auto-resolution", {
      repoRoot,
      files: remaining,
    });
    return false;
  }

  await runGit(
    ["commit", "--no-edit"],
    { cwd: repoRoot },
  );
  logger.info("Merge committed after auto-resolving conflicts", {
    repoRoot,
    sourceBranch,
    targetBranch,
    resolvedFiles: conflicted,
  });
  return true;
}

export async function mergeBranchToMain(
  repoRoot: string,
  sourceBranch: string,
  targetBranch: string = "main",
): Promise<{ merged: boolean; alreadyUpToDate: boolean }> {
  guardWorkspaceMutation(
    repoRoot,
    `mergeBranchToMain ${sourceBranch} into ${targetBranch}`,
  );

  try {
    await runGit(["fetch", "origin", targetBranch], { cwd: repoRoot });
  } catch {
    logger.debug("Could not fetch target branch from origin", {
      repoRoot,
      targetBranch,
    });
  }

  try {
    await runGit(["fetch", "origin", sourceBranch], { cwd: repoRoot });
  } catch {
    logger.debug("Could not fetch source branch from origin", {
      repoRoot,
      sourceBranch,
    });
  }

  if (await branchExists(repoRoot, targetBranch)) {
    await runGit(["checkout", targetBranch], { cwd: repoRoot });
  } else if (await remoteBranchExists(repoRoot, targetBranch)) {
    await runGit(["checkout", "-B", targetBranch, `origin/${targetBranch}`], {
      cwd: repoRoot,
    });
  } else {
    throw new Error(
      `Target branch ${targetBranch} not found in repository ${repoRoot}`,
    );
  }

  if (await remoteBranchExists(repoRoot, targetBranch)) {
    try {
      await runGit(["pull", "--ff-only", "origin", targetBranch], {
        cwd: repoRoot,
      });
    } catch (pullErr) {
      logger.warn("Pull failed on target branch, proceeding", {
        repoRoot,
        targetBranch,
        error: pullErr,
      });
    }
  }

  try {
    const mergeResult = await runGit(
      ["merge", "--no-ff", sourceBranch, "-m", `Merge ${sourceBranch} into ${targetBranch}`],
      { cwd: repoRoot },
    );
    const alreadyUpToDate = mergeResult.stdout?.includes("Already up to date");
    logger.info("Branch merged successfully", {
      repoRoot,
      sourceBranch,
      targetBranch,
      alreadyUpToDate,
    });

    if (await remoteBranchExists(repoRoot, targetBranch)) {
      await runGit(["push", "origin", targetBranch], { cwd: repoRoot });
    }

    return { merged: true, alreadyUpToDate: !!alreadyUpToDate };
  } catch (mergeErr: any) {
    logger.warn("Merge has conflicts, attempting auto-resolution", {
      repoRoot,
      sourceBranch,
      targetBranch,
    });

    const resolved = await tryResolveConflicts(repoRoot, sourceBranch, targetBranch);
    if (resolved) {
      if (await remoteBranchExists(repoRoot, targetBranch)) {
        await runGit(["push", "origin", targetBranch], { cwd: repoRoot });
      }
      return { merged: true, alreadyUpToDate: false };
    }

    logger.error("Merge conflict auto-resolution failed, aborting", {
      repoRoot,
      sourceBranch,
      targetBranch,
      error: mergeErr.message,
    });
    try {
      await runGit(["merge", "--abort"], { cwd: repoRoot });
    } catch {
      void 0;
    }
    throw new Error(
      `Failed to merge ${sourceBranch} into ${targetBranch}: ${mergeErr.message}`,
    );
  }
}
