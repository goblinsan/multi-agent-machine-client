import fs from "fs/promises";
import os from "os";
import path from "path";

import { runGit } from "../gitUtils.js";
import { cfg } from "../config.js";
import { logger } from "../logger.js";
import {
  buildExtensionPolicy,
  evaluatePolicy,
  isGloballyBlockedPath,
} from "../fileopsPolicy.js";

export type GitApplyOutcome =
  | { ok: true; changedFiles: string[] }
  | { ok: false; reason: string };

export async function tryGitApply(
  repoRoot: string,
  diffText: string,
  opts?: { blockedExts?: string[] },
): Promise<GitApplyOutcome> {
  if (!diffText || !diffText.trim().length) {
    return { ok: false, reason: "empty diff text" };
  }

  const text = diffText.endsWith("\n") ? diffText : diffText + "\n";
  const tmpFile = path.join(
    os.tmpdir(),
    `ma-git-apply-${Date.now()}-${Math.random().toString(36).slice(2)}.patch`,
  );

  try {
    await fs.writeFile(tmpFile, text, "utf8");

    let numstatOut: string;
    try {
      const numstat = await runGit(
        ["apply", "--numstat", "--recount", tmpFile],
        { cwd: repoRoot },
      );
      numstatOut = numstat.stdout;
    } catch (err) {
      return {
        ok: false,
        reason: `git could not parse diff: ${extractGitStderr(err)}`,
      };
    }

    const targets = parseNumstatPaths(numstatOut);
    if (!targets.length) {
      return { ok: false, reason: "diff contains no file changes" };
    }

    const extensionPolicy = buildExtensionPolicy([
      ...(cfg.blockedExts || []),
      ...(opts?.blockedExts || []),
    ]);
    for (const target of targets) {
      if (isGloballyBlockedPath(target)) {
        return { ok: false, reason: `path blocked by policy: ${target}` };
      }
      if (!evaluatePolicy(target, extensionPolicy).allowed) {
        return {
          ok: false,
          reason: `extension blocked by policy: ${target}`,
        };
      }
    }

    try {
      await runGit(["apply", "--recount", "--whitespace=nowarn", tmpFile], {
        cwd: repoRoot,
      });
    } catch (err) {
      return {
        ok: false,
        reason: `git apply rejected diff: ${extractGitStderr(err)}`,
      };
    }

    logger.info("Diff applied via git apply", {
      repoRoot,
      fileCount: targets.length,
      files: targets,
    });
    return { ok: true, changedFiles: targets };
  } finally {
    try {
      await fs.unlink(tmpFile);
    } catch {
      void 0;
    }
  }
}

function parseNumstatPaths(numstatOutput: string): string[] {
  const paths: string[] = [];
  for (const line of numstatOutput.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const parts = line.split("\t");
    if (parts.length < 3) continue;
    const rawPath = parts.slice(2).join("\t").trim();
    if (!rawPath) continue;
    const renameMatch = /\{?.* => (.+?)\}?$/.exec(rawPath);
    const resolved = renameMatch ? renameMatch[1] : rawPath;
    paths.push(resolved.replace(/\\/g, "/"));
  }
  return Array.from(new Set(paths));
}

function extractGitStderr(error: unknown): string {
  if (error && typeof error === "object") {
    const stderr = (error as any).stderr;
    if (typeof stderr === "string" && stderr.trim().length) {
      return stderr.trim().slice(0, 600);
    }
    if (stderr instanceof Buffer) {
      const text = stderr.toString("utf8").trim();
      if (text.length) return text.slice(0, 600);
    }
  }
  return error instanceof Error ? error.message.slice(0, 600) : String(error);
}
