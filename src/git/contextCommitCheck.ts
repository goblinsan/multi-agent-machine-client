import { runGit } from "../gitUtils.js";
import { logger } from "../logger.js";

export async function isLastCommitContextOnly(
  repoRoot: string,
): Promise<boolean> {
  try {
    const result = await runGit(
      ["diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD"],
      { cwd: repoRoot },
    );

    const changedFiles = result.stdout
      .trim()
      .split("\n")
      .filter((f) => f.trim().length > 0);

    if (changedFiles.length === 0) {
      logger.info("Last commit has no files", { repoRoot });
      return true;
    }

    const contextFilePattern =
      /^\.ma\/context\/(snapshot\.json|summary\.md|files\.ndjson)$/;
    const allContextFiles = changedFiles.every((file) =>
      contextFilePattern.test(file),
    );

    logger.info("Checked last commit files", {
      repoRoot,
      changedFiles,
      allContextFiles,
    });

    return allContextFiles;
  } catch (error: any) {
    logger.warn("Failed to check last commit files, assuming rescan needed", {
      repoRoot,
      error: error.message,
    });
    return false;
  }
}

export async function hasCommitsSinceLastContextScan(
  repoRoot: string,
): Promise<boolean> {
  try {
    const lastContextCommit = await runGit(
      ["log", "-1", "--format=%H", "--", ".ma/context/snapshot.json"],
      { cwd: repoRoot },
    );

    const contextCommitSha = lastContextCommit.stdout.trim();

    if (!contextCommitSha) {
      logger.info("No previous context scan found", { repoRoot });
      return true;
    }

    const newCodeCommits = await runGit(
      ["rev-list", `${contextCommitSha}..HEAD`, "--", ".", ":(exclude).ma/**"],
      { cwd: repoRoot },
    );

    const hasNewCommits = newCodeCommits.stdout.trim().length > 0;

    const headCommit = await runGit(["rev-parse", "HEAD"], { cwd: repoRoot });
    const headSha = headCommit.stdout.trim();

    logger.info("Checked commits since last context scan", {
      repoRoot,
      lastContextCommit: contextCommitSha.slice(0, 8),
      headCommit: headSha.slice(0, 8),
      hasNewCommits,
    });

    return hasNewCommits;
  } catch (error: any) {
    logger.warn(
      "Failed to check commits since last scan, assuming rescan needed",
      {
        repoRoot,
        error: error.message,
      },
    );
    return true;
  }
}
