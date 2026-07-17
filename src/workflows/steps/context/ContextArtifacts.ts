import { logger } from "../../../logger.js";
import type { FileInfo } from "../../../scanRepo.js";
import {
  publishProjectArtifactToDashboard,
} from "../../helpers/artifactPublisher.js";
import { fetchProjectArtifactContentFromApi } from "../../helpers/artifactReader.js";
import fs from "fs/promises";
import path from "path";

export const CONTEXT_ARTIFACT_KINDS = {
  snapshot: "context_snapshot",
  summary: "context_summary",
  filesNdjson: "context_files_ndjson",
} as const;

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
  headSha?: string | null;
}

export async function writeContextArtifacts(
  repoPath: string,
  snapshot: ContextSnapshotPayload,
  summary: string,
  files: FileInfo[],
  options?: { projectId?: string | number | null; workflowId?: string | null },
): Promise<ContextArtifactPaths> {
  const paths = await ensureContextDir(repoPath);

  const snapshotJson = JSON.stringify(snapshot, null, 2);
  const filesNdjson = buildFilesNdjson(files);

  await fs.writeFile(paths.snapshotPath, snapshotJson, "utf-8");
  await fs.writeFile(paths.summaryPath, summary, "utf-8");
  await fs.writeFile(paths.filesNdjsonPath, filesNdjson, "utf-8");

  logger.info("Context artifacts written", {
    snapshotPath: paths.snapshotPath,
    summaryPath: paths.summaryPath,
    filesNdjsonPath: paths.filesNdjsonPath,
    fileCount: snapshot.totals.files,
  });

  if (options?.projectId) {
    await publishProjectArtifactToDashboard({
      projectId: options.projectId,
      workflowId: options.workflowId ?? null,
      kind: CONTEXT_ARTIFACT_KINDS.snapshot,
      content: snapshotJson,
    });
    await publishProjectArtifactToDashboard({
      projectId: options.projectId,
      workflowId: options.workflowId ?? null,
      kind: CONTEXT_ARTIFACT_KINDS.summary,
      content: summary,
    });
    await publishProjectArtifactToDashboard({
      projectId: options.projectId,
      workflowId: options.workflowId ?? null,
      kind: CONTEXT_ARTIFACT_KINDS.filesNdjson,
      content: filesNdjson,
    });
  }

  return paths;
}

export async function hydrateContextArtifacts(
  repoPath: string,
  projectId: string | number | null | undefined,
): Promise<boolean> {
  if (!projectId) return false;

  const existing = await loadExistingSnapshot(repoPath);
  if (existing.exists) return false;

  const [snapshotJson, summary, filesNdjson] = await Promise.all([
    fetchProjectArtifactContentFromApi({
      projectId,
      kind: CONTEXT_ARTIFACT_KINDS.snapshot,
    }),
    fetchProjectArtifactContentFromApi({
      projectId,
      kind: CONTEXT_ARTIFACT_KINDS.summary,
    }),
    fetchProjectArtifactContentFromApi({
      projectId,
      kind: CONTEXT_ARTIFACT_KINDS.filesNdjson,
    }),
  ]);

  if (snapshotJson === null || summary === null || filesNdjson === null) {
    return false;
  }

  let snapshotTimestamp: number | null = null;
  try {
    const parsed = JSON.parse(snapshotJson);
    snapshotTimestamp =
      typeof parsed?.timestamp === "number" ? parsed.timestamp : null;
  } catch {
    logger.warn("Hydrated context snapshot is not valid JSON, skipping", {
      repoPath,
      projectId,
    });
    return false;
  }

  const paths = await ensureContextDir(repoPath);
  await fs.writeFile(paths.snapshotPath, snapshotJson, "utf-8");
  await fs.writeFile(paths.summaryPath, summary, "utf-8");
  await fs.writeFile(paths.filesNdjsonPath, filesNdjson, "utf-8");

  if (snapshotTimestamp) {
    const stamp = new Date(snapshotTimestamp);
    await Promise.all(
      [paths.snapshotPath, paths.summaryPath, paths.filesNdjsonPath].map(
        (p) => fs.utimes(p, stamp, stamp).catch(() => undefined),
      ),
    );
  }

  logger.info("Hydrated context artifacts from dashboard API", {
    repoPath,
    projectId,
    snapshotTimestamp: snapshotTimestamp
      ? new Date(snapshotTimestamp).toISOString()
      : undefined,
  });
  return true;
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
