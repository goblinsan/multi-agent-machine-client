import { cfg } from "../config.js";
import { logger } from "../logger.js";
import { runGit, guardWorkspaceMutation } from "./core.js";
import { getRepoMetadata } from "./queries.js";

export async function ensureBranchPublished(repoRoot: string, branch: string) {
  guardWorkspaceMutation(repoRoot, `ensureBranchPublished ${branch}`);
  if (!branch) return;
  try {
    await runGit(["push", "-u", "origin", branch], { cwd: repoRoot });
  } catch (e: any) {
    const stderr = e?.stderr as string | undefined;
    if (stderr && /set-upstream/.test(stderr)) {
      logger.warn("git push upstream hint", { repoRoot, branch, error: e });
    } else if (stderr && /already exists/.test(stderr)) {
      logger.info("branch already published", { repoRoot, branch });
    } else {
      logger.warn("ensure branch publish failed", {
        repoRoot,
        branch,
        error: e,
      });
    }
  }
}

export async function commitAndPushPaths(options: {
  repoRoot: string;
  branch?: string | null;
  message: string;
  paths: string[];
}) {
  const { repoRoot, message, paths } = options;
  guardWorkspaceMutation(repoRoot, `commitAndPush ${options.branch || ""}`);
  if (!paths || paths.length === 0) {
    return { committed: false, pushed: false, reason: "no_paths" };
  }

  const meta = await getRepoMetadata(repoRoot);
  const targetBranch =
    options.branch || meta.currentBranch || cfg.git.defaultBranch;
  if (!targetBranch) {
    logger.warn("commit skipped: unable to determine branch", { repoRoot });
    return { committed: false, pushed: false, reason: "no_branch" };
  }

  try {
    await runGit(
      ["config", "user.name", cfg.git.userName || "machine-client"],
      { cwd: repoRoot },
    );
    await runGit(
      [
        "config",
        "user.email",
        cfg.git.userEmail || "machine-client@example.com",
      ],
      { cwd: repoRoot },
    );
  } catch (configErr) {
    logger.warn("git identity setup failed", { repoRoot, error: configErr });
  }

  const currentMeta = await getRepoMetadata(repoRoot);
  if (currentMeta.currentBranch !== targetBranch) {
    try {
      await runGit(["checkout", targetBranch], { cwd: repoRoot });
    } catch (e) {
      logger.warn("commit checkout failed", {
        repoRoot,
        branch: targetBranch,
        error: e,
      });
    }
  }

  await runGit(["add", ...paths], { cwd: repoRoot });

  let hasChanges = false;
  try {
    await runGit(["diff", "--cached", "--quiet"], { cwd: repoRoot });
  } catch (e: any) {
    if (typeof e?.code === "number") {
      if (e.code === 1) {
        hasChanges = true;
      } else {
        throw e;
      }
    } else {
      throw e;
    }
  }

  if (!hasChanges) {
    await runGit(["reset", "HEAD"], { cwd: repoRoot });
    logger.info("commit skipped: no changes", {
      repoRoot,
      branch: targetBranch,
      paths,
    });
    return {
      committed: false,
      pushed: false,
      branch: targetBranch,
      reason: "no_changes",
    };
  }

  const sanitized =
    String(message || "")
      .replace(/\s+/g, " ")
      .trim() || "agent: update";
  await runGit(["commit", "--no-verify", "-m", sanitized], { cwd: repoRoot });

  try {
    let remoteBranchExistsFlag = false;
    try {
      await runGit(["ls-remote", "--heads", "origin", targetBranch], {
        cwd: repoRoot,
      });
      const output = await runGit(
        ["ls-remote", "--heads", "origin", targetBranch],
        { cwd: repoRoot },
      );
      remoteBranchExistsFlag = output.stdout.trim().length > 0;
    } catch (e) {
      logger.debug("remote branch check failed, assuming doesn't exist", {
        repoRoot,
        branch: targetBranch,
      });
    }

    if (remoteBranchExistsFlag) {
      await runGit(["push", "origin", targetBranch], { cwd: repoRoot });
    } else {
      await runGit(["push", "-u", "origin", targetBranch], { cwd: repoRoot });
    }
  } catch (e) {
    logger.warn("git push failed", {
      repoRoot,
      branch: targetBranch,
      error: e,
    });
    return {
      committed: true,
      pushed: false,
      branch: targetBranch,
      reason: "push_failed",
    };
  }

  logger.info("context artifacts committed", {
    repoRoot,
    branch: targetBranch,
    paths,
  });
  return { committed: true, pushed: true, branch: targetBranch };
}
