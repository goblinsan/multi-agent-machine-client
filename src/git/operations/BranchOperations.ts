import fs from "fs/promises";
import path from "path";
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

function hasDuplicateJsonKeys(raw: string): boolean {
  const keyPattern = /"([^"]+)"\s*:/g;
  const keys: string[] = [];
  let match;
  while ((match = keyPattern.exec(raw)) !== null) {
    keys.push(match[1]);
  }
  const unique = new Set(keys);
  return unique.size < keys.length;
}

function deepMergeJson(
  ours: Record<string, any>,
  theirs: Record<string, any>,
): Record<string, any> {
  const merged = { ...ours };
  for (const key of Object.keys(theirs)) {
    if (
      typeof theirs[key] === "object" &&
      theirs[key] !== null &&
      !Array.isArray(theirs[key]) &&
      typeof merged[key] === "object" &&
      merged[key] !== null &&
      !Array.isArray(merged[key])
    ) {
      merged[key] = { ...merged[key], ...theirs[key] };
    } else {
      merged[key] = theirs[key];
    }
  }
  return merged;
}

async function resolveJsonConflict(repoRoot: string, file: string): Promise<boolean> {
  const absPath = path.join(repoRoot, file);
  let oursRaw: string;
  let theirsRaw: string;
  try {
    const oursResult = await runGit(["show", `:2:${file}`], { cwd: repoRoot });
    oursRaw = oursResult.stdout;
    const theirsResult = await runGit(["show", `:3:${file}`], { cwd: repoRoot });
    theirsRaw = theirsResult.stdout;
  } catch {
    return false;
  }

  let oursParsed: Record<string, any> | null = null;
  let theirsParsed: Record<string, any> | null = null;
  const oursCorrupt = hasDuplicateJsonKeys(oursRaw);
  const theirsCorrupt = hasDuplicateJsonKeys(theirsRaw);

  try { oursParsed = JSON.parse(oursRaw); } catch { void 0; }
  try { theirsParsed = JSON.parse(theirsRaw); } catch { void 0; }

  let resolved: Record<string, any> | null = null;

  if (oursParsed && theirsParsed && !oursCorrupt && !theirsCorrupt) {
    resolved = deepMergeJson(oursParsed, theirsParsed);
  } else if (oursParsed && !oursCorrupt) {
    if (theirsParsed && theirsCorrupt) {
      resolved = deepMergeJson(oursParsed, theirsParsed);
    } else {
      resolved = oursParsed;
    }
  } else if (theirsParsed && !theirsCorrupt) {
    resolved = theirsParsed;
  } else if (oursParsed) {
    resolved = oursParsed;
  } else if (theirsParsed) {
    resolved = theirsParsed;
  }

  if (!resolved) return false;

  await fs.writeFile(absPath, JSON.stringify(resolved, null, 2) + "\n");
  await runGit(["add", "--", file], { cwd: repoRoot });
  logger.info("Auto-resolved JSON conflict via deep merge", {
    repoRoot,
    file,
    oursCorrupt,
    theirsCorrupt,
  });
  return true;
}

const CORRUPTION_PATTERNS = [
  /^export\s+default\b.*\n[\s\S]*^export\s+default\b/m,
  /^module\.exports\s*=.*\n[\s\S]*^module\.exports\s*=/m,
];

async function resolveWithValidation(repoRoot: string, file: string): Promise<boolean> {
  await runGit(["checkout", "--theirs", "--", file], { cwd: repoRoot });

  const absPath = path.join(repoRoot, file);
  const content = await fs.readFile(absPath, "utf-8");

  const isCorrupt = CORRUPTION_PATTERNS.some((re) => re.test(content));
  if (isCorrupt) {
    logger.warn("Source branch version has corruption markers, preferring target", {
      repoRoot,
      file,
    });
    try {
      await runGit(["checkout", "--ours", "--", file], { cwd: repoRoot });
    } catch {
      return false;
    }
  }

  await runGit(["add", "--", file], { cwd: repoRoot });
  return true;
}

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
      if (file.endsWith(".json")) {
        const jsonResolved = await resolveJsonConflict(repoRoot, file);
        if (jsonResolved) continue;
      }
      const validated = await resolveWithValidation(repoRoot, file);
      if (!validated) {
        logger.warn("Could not auto-resolve conflict", { repoRoot, file });
        return false;
      }
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
