import { runGit } from "../../../gitUtils.js";
import { logger } from "../../../logger.js";
import type { FileInfo } from "../../../scanRepo.js";
import fs from "fs/promises";
import path from "path";

export interface ContextArtifactPaths {
  contextDir: string;
  snapshotPath: string;
  summaryPath: string;
  filesNdjsonPath: string;
}

export interface ContextArtifactMetadata {
  fileCount: number;
}

export async function ensureContextDir(repoPath: string): Promise<ContextArtifactPaths> {
  const contextDir = path.join(repoPath, ".ma", "context");
  const snapshotPath = path.join(contextDir, "snapshot.json");
  const summaryPath = path.join(contextDir, "summary.md");
  const filesNdjsonPath = path.join(contextDir, "files.ndjson");

  await fs.mkdir(contextDir, { recursive: true });

  return { contextDir, snapshotPath, summaryPath, filesNdjsonPath };
}

export function buildFilesNdjson(files: FileInfo[]): string {
  if (!files.length) return "";

  const serialized = files
    .map((file) =>
      JSON.stringify({
        path: file.path,
        bytes: file.bytes,
        lines: file.lines,
        sha1: file.sha1,
        mtime: file.mtime,
      }),
    )
    .join("\n");

  return serialized + "\n";
}

export interface ContextSnapshotPayload {
  timestamp: number;
  repoPath: string;
  files: FileInfo[];
  totals: {
    files: number;
    bytes: number;
    depth?: number;
  };
}

export async function writeContextArtifacts(
  repoPath: string,
  snapshot: ContextSnapshotPayload,
  summary: string,
  files: FileInfo[],
): Promise<ContextArtifactPaths> {
  const paths = await ensureContextDir(repoPath);

  await fs.writeFile(paths.snapshotPath, JSON.stringify(snapshot, null, 2), "utf-8");
  await fs.writeFile(paths.summaryPath, summary, "utf-8");
  await fs.writeFile(paths.filesNdjsonPath, buildFilesNdjson(files), "utf-8");

  logger.info("Context artifacts written", {
    snapshotPath: paths.snapshotPath,
    summaryPath: paths.summaryPath,
    filesNdjsonPath: paths.filesNdjsonPath,
    fileCount: snapshot.totals.files,
  });

  try {
    await runGit(
      [
        "add",
        ".ma/context/snapshot.json",
        ".ma/context/summary.md",
        ".ma/context/files.ndjson",
      ],
      { cwd: repoPath },
    );

    const commitMsg = `chore(ma): update context scan (${snapshot.totals.files} files)`;
    await runGit(["commit", "--no-verify", "-m", commitMsg], { cwd: repoPath });

    const branchResult = await runGit([
      "rev-parse",
      "--abbrev-ref",
      "HEAD",
    ], {
      cwd: repoPath,
    });
    const branch = branchResult.stdout.trim();

    try {
      const remotes = await runGit(["remote"], { cwd: repoPath });
      if (remotes.stdout.trim().length > 0) {
        await runGit(["push", "origin", branch], { cwd: repoPath });
        logger.info("Context artifacts pushed to remote", { branch });
      }
    } catch (pushErr: any) {
      logger.warn("Failed to push context artifacts (will retry later)", {
        error: pushErr.message,
      });
    }

    logger.debug("Context artifacts staged", {
      repoPath,
    });
  } catch (gitError: any) {
    logger.warn("Failed to commit context artifacts", {
      repoPath,
      error: gitError.message,
    });
  }

  return paths;
}

export async function loadExistingSnapshot(
  repoPath: string,
): Promise<{
  exists: boolean;
  snapshotExists: boolean;
  summaryExists: boolean;
  snapshotPath: string;
  summaryPath: string;
  filesNdjsonExists: boolean;
  filesNdjsonPath: string;
}> {
  const paths = await ensureContextDir(repoPath);

  const snapshotExists = await fs
    .access(paths.snapshotPath)
    .then(() => true)
    .catch(() => false);

  const summaryExists = await fs
    .access(paths.summaryPath)
    .then(() => true)
    .catch(() => false);

  const filesNdjsonExists = await fs
    .access(paths.filesNdjsonPath)
    .then(() => true)
    .catch(() => false);

  return {
    exists: snapshotExists && summaryExists && filesNdjsonExists,
    snapshotExists,
    summaryExists,
    snapshotPath: paths.snapshotPath,
    summaryPath: paths.summaryPath,
    filesNdjsonExists,
    filesNdjsonPath: paths.filesNdjsonPath,
  };
}
