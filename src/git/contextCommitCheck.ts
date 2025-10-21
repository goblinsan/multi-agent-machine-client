import { runGit } from "../gitUtils.js";
import { logger } from "../logger.js";

/**
 * Check if the most recent commit only contains context files (.ma/context/*)
 * Returns true if only context files, false if there are other code changes
 */
export async function isLastCommitContextOnly(repoRoot: string): Promise<boolean> {
  try {
    // Get the files changed in the last commit
    const result = await runGit(
      ["diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD"],
      { cwd: repoRoot }
    );

    const changedFiles = result.stdout
      .trim()
      .split('\n')
      .filter(f => f.trim().length > 0);

    if (changedFiles.length === 0) {
      // No files in last commit - treat as context-only (no code changes)
      logger.info('Last commit has no files', { repoRoot });
      return true;
    }

    // Check if ALL changed files are in .ma/context/
    const contextFilePattern = /^\.ma\/context\/(snapshot\.json|summary\.md|files\.ndjson)$/;
    const allContextFiles = changedFiles.every(file => contextFilePattern.test(file));

    logger.info('Checked last commit files', {
      repoRoot,
      changedFiles,
      allContextFiles
    });

    return allContextFiles;
  } catch (error: any) {
    // If we can't determine, assume we need to rescan
    logger.warn('Failed to check last commit files, assuming rescan needed', {
      repoRoot,
      error: error.message
    });
    return false;
  }
}

/**
 * Check if there have been any commits since the last context scan
 * Returns true if there are new commits (need to rescan), false if no new commits
 */
export async function hasCommitsSinceLastContextScan(repoRoot: string): Promise<boolean> {
  try {
    // Get the commit that last modified context files
    const lastContextCommit = await runGit(
      ["log", "-1", "--format=%H", "--", ".ma/context/snapshot.json"],
      { cwd: repoRoot }
    );

    const contextCommitSha = lastContextCommit.stdout.trim();
    
    if (!contextCommitSha) {
      // No previous context scan found
      logger.info('No previous context scan found', { repoRoot });
      return true;
    }

    // Get commits since last context scan that touch files outside .ma/ directory
    // This excludes planning logs, QA logs, context files, etc.
    const newCodeCommits = await runGit(
      ["rev-list", `${contextCommitSha}..HEAD`, "--", ".", ":(exclude).ma/**"],
      { cwd: repoRoot }
    );

    const hasNewCommits = newCodeCommits.stdout.trim().length > 0;

    // Get head commit for logging
    const headCommit = await runGit(
      ["rev-parse", "HEAD"],
      { cwd: repoRoot }
    );
    const headSha = headCommit.stdout.trim();

    logger.info('Checked commits since last context scan', {
      repoRoot,
      lastContextCommit: contextCommitSha.slice(0, 8),
      headCommit: headSha.slice(0, 8),
      hasNewCommits
    });

    return hasNewCommits;
  } catch (error: any) {
    // If we can't determine, assume we need to rescan
    logger.warn('Failed to check commits since last scan, assuming rescan needed', {
      repoRoot,
      error: error.message
    });
    return true;
  }
}
