import fs from "fs/promises";
import path from "path";
import crypto from "crypto";
import { Minimatch } from "minimatch";
import { runGit } from "../../../gitUtils.js";
import { logger } from "../../../logger.js";
import { scanRepo, ScanSpec, FileInfo } from "../../../scanRepo.js";

export type GitDelta = { ok: boolean; changed: Set<string> };

export type ContextDelta = {
  added: string[];
  modified: string[];
  removed: string[];
};

export type IncrementalScanResult = {
  files: FileInfo[];
  readCount: number;
  carriedCount: number;
};

export async function getHeadSha(repoRoot: string): Promise<string | null> {
  try {
    const result = await runGit(["rev-parse", "HEAD"], { cwd: repoRoot });
    const sha = result.stdout.trim();
    return sha.length ? sha : null;
  } catch {
    return null;
  }
}

export async function getGitDelta(
  repoRoot: string,
  sinceSha: string,
): Promise<GitDelta> {
  try {
    const changed = new Set<string>();

    const diff = await runGit(["diff", "--name-only", sinceSha, "HEAD"], {
      cwd: repoRoot,
    });
    for (const line of diff.stdout.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed) changed.add(trimmed);
    }

    const status = await runGit(["status", "--porcelain"], { cwd: repoRoot });
    for (const line of status.stdout.split(/\r?\n/)) {
      if (!line.trim()) continue;
      const entry = line.slice(3).trim();
      if (!entry) continue;
      const renameParts = entry.split(" -> ");
      for (const part of renameParts) {
        const cleaned = part.replace(/^"|"$/g, "").trim();
        if (cleaned) changed.add(cleaned);
      }
    }

    return { ok: true, changed };
  } catch (error) {
    logger.debug("Git delta unavailable, falling back to stat comparison", {
      repoRoot,
      sinceSha: sinceSha.slice(0, 8),
      error: error instanceof Error ? error.message : String(error),
    });
    return { ok: false, changed: new Set() };
  }
}

export function filterPathsBySpec(
  paths: Iterable<string>,
  include: string[],
  exclude: string[],
): Set<string> {
  const inc = include.map((p) => new Minimatch(p, { dot: true }));
  const exc = exclude.map((p) => new Minimatch(p, { dot: true }));
  const result = new Set<string>();
  for (const p of paths) {
    const normalized = p.split(path.sep).join("/");
    if (exc.some((m) => m.match(normalized))) continue;
    if (!inc.some((m) => m.match(normalized))) continue;
    result.add(normalized);
  }
  return result;
}

export async function incrementalScan(
  spec: ScanSpec,
  previousFiles: FileInfo[],
  gitChanged: Set<string> | null,
): Promise<IncrementalScanResult> {
  const statEntries = await scanRepo({
    ...spec,
    track_lines: false,
    track_hash: false,
  });

  const prevByPath = new Map(previousFiles.map((f) => [f.path, f]));
  const files: FileInfo[] = [];
  let readCount = 0;
  let carriedCount = 0;

  for (const entry of statEntries) {
    const prev = prevByPath.get(entry.path);
    const statUnchanged =
      !!prev && prev.bytes === entry.bytes && prev.mtime === entry.mtime;
    const gitUnchanged =
      !!prev &&
      prev.bytes === entry.bytes &&
      gitChanged !== null &&
      !gitChanged.has(entry.path);
    const carriedDataComplete =
      !!prev && (!spec.track_lines || typeof prev.lines === "number");

    if ((statUnchanged || gitUnchanged) && carriedDataComplete) {
      files.push({
        ...entry,
        lines: prev!.lines,
        ...(prev!.sha1 ? { sha1: prev!.sha1 } : {}),
      });
      carriedCount += 1;
      continue;
    }

    if (spec.track_lines && entry.bytes < 5_000_000) {
      try {
        const txt = await fs.readFile(
          path.join(spec.repo_root, entry.path),
          "utf8",
        );
        entry.lines = txt.split(/\r?\n/).length;
        if (spec.track_hash) {
          entry.sha1 = crypto.createHash("sha1").update(txt).digest("hex");
        }
      } catch (error) {
        logger.debug("Failed to read file during incremental scan", {
          path: entry.path,
          error: String(error),
        });
      }
    }
    files.push(entry);
    readCount += 1;
  }

  return { files, readCount, carriedCount };
}

export function computeDelta(
  previousFiles: FileInfo[],
  currentFiles: FileInfo[],
  gitChanged: Set<string> | null,
): ContextDelta {
  const prevByPath = new Map(previousFiles.map((f) => [f.path, f]));
  const currentPaths = new Set(currentFiles.map((f) => f.path));

  const added: string[] = [];
  const modified: string[] = [];
  const removed: string[] = [];

  for (const file of currentFiles) {
    const prev = prevByPath.get(file.path);
    if (!prev) {
      added.push(file.path);
      continue;
    }
    const contentDiffers =
      prev.bytes !== file.bytes ||
      (typeof prev.lines === "number" &&
        typeof file.lines === "number" &&
        prev.lines !== file.lines) ||
      (prev.sha1 && file.sha1 && prev.sha1 !== file.sha1) ||
      (gitChanged !== null && gitChanged.has(file.path));
    if (contentDiffers) modified.push(file.path);
  }

  for (const prev of previousFiles) {
    if (!currentPaths.has(prev.path)) removed.push(prev.path);
  }

  return { added, modified, removed };
}

const STRUCTURAL_BASENAME_PATTERNS = [
  "package.json",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "deno.json*",
  "tsconfig*.json",
  "jsconfig.json",
  "*.config.js",
  "*.config.ts",
  "*.config.mjs",
  "*.config.cjs",
  "go.mod",
  "go.sum",
  "Cargo.toml",
  "Cargo.lock",
  "pyproject.toml",
  "requirements*.txt",
  "Pipfile*",
  "setup.py",
  "setup.cfg",
  "Gemfile*",
  "pom.xml",
  "build.gradle*",
  "settings.gradle*",
  "Package.swift",
  "Dockerfile*",
  "docker-compose*",
  "Makefile",
  "makefile",
].map((p) => new Minimatch(p, { dot: true, nocase: false }));

const STRUCTURAL_PATH_PATTERNS = [".github/workflows/**"].map(
  (p) => new Minimatch(p, { dot: true }),
);

export function isStructuralPath(relPath: string): boolean {
  const normalized = relPath.split(path.sep).join("/");
  if (STRUCTURAL_PATH_PATTERNS.some((m) => m.match(normalized))) return true;
  const base = path.posix.basename(normalized);
  return STRUCTURAL_BASENAME_PATTERNS.some((m) => m.match(base));
}

export type AnalysisReuseAssessment = {
  reusable: boolean;
  reason: string;
};

export function assessAnalysisReuse(
  delta: ContextDelta,
  previousFiles: FileInfo[],
  maxChangedFiles = 10,
): AnalysisReuseAssessment {
  const changedPaths = [...delta.added, ...delta.modified, ...delta.removed];

  if (changedPaths.length === 0) {
    return { reusable: true, reason: "no content changes" };
  }

  if (changedPaths.length > maxChangedFiles) {
    return {
      reusable: false,
      reason: `${changedPaths.length} changed files exceeds reuse threshold of ${maxChangedFiles}`,
    };
  }

  const structural = changedPaths.filter(isStructuralPath);
  if (structural.length > 0) {
    return {
      reusable: false,
      reason: `structural files changed: ${structural.slice(0, 5).join(", ")}`,
    };
  }

  const previousExtensions = new Set(
    previousFiles.map((f) => path.posix.extname(f.path).toLowerCase()),
  );
  const newExtensions = delta.added
    .map((p) => path.posix.extname(p).toLowerCase())
    .filter((ext) => ext && !previousExtensions.has(ext));
  if (newExtensions.length > 0) {
    return {
      reusable: false,
      reason: `new file extensions introduced: ${[...new Set(newExtensions)].join(", ")}`,
    };
  }

  return {
    reusable: true,
    reason: `${changedPaths.length} non-structural file change(s)`,
  };
}
