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
  | {
      ok: true;
      changedFiles: string[];
      method: "git-apply-strict" | "git-apply-ignore-whitespace" | "git-apply-3way";
    }
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
    const originalContents = new Map<string, string | null>();
    for (const target of targets) {
      let fullPath: string;
      try {
        fullPath = insideRepo(repoRoot, target);
      } catch (err) {
        return { ok: false, reason: `Path traversal detected: ${target}` };
      }
      try {
        const content = await fs.readFile(fullPath, "utf8");
        originalContents.set(target, content);
      } catch (err) {
        originalContents.set(target, null);
      }
    }

    let applyMethod: "git-apply-strict" | "git-apply-ignore-whitespace" | "git-apply-3way";
    try {
      logger.info("tryGitApply: Attempting strict apply");
      await runGit(["apply", "--recount", "--whitespace=nowarn", tmpFile], {
        cwd: repoRoot,
      });
      applyMethod = "git-apply-strict";
      logger.info("tryGitApply: Strict apply succeeded");
    } catch (strictErr) {
      logger.info("tryGitApply: Strict apply failed, trying whitespace-tolerant apply", {
        error: extractGitStderr(strictErr),
      });

      try {
        await runGit(
          ["apply", "--recount", "--whitespace=nowarn", "--ignore-whitespace", tmpFile],
          { cwd: repoRoot },
        );
        applyMethod = "git-apply-ignore-whitespace";
        logger.info("tryGitApply: Whitespace-tolerant apply succeeded");
      } catch (wsErr) {
        logger.info("tryGitApply: Whitespace-tolerant apply failed, trying 3-way apply", {
          error: extractGitStderr(wsErr),
        });

        try {
          await runGit(
            ["apply", "--recount", "--whitespace=nowarn", "--3way", tmpFile],
            { cwd: repoRoot },
          );
          applyMethod = "git-apply-3way";
          logger.info("tryGitApply: 3-way apply succeeded");
        } catch (threeWayErr) {
          logger.warn("tryGitApply: All git apply attempts failed. Restoring original file contents.", {
            error: extractGitStderr(threeWayErr),
          });

          try {
            await runGit(["reset", "HEAD", "--", ...targets], { cwd: repoRoot }).catch(() => {});
          } catch (resetErr) {
            logger.warn("tryGitApply: Failed to reset git index after failed apply", {
              error: String(resetErr),
            });
          }

          for (const [target, originalContent] of originalContents.entries()) {
            const fullPath = path.resolve(repoRoot, target);
            try {
              if (originalContent === null) {
                await fs.unlink(fullPath).catch(() => {});
              } else {
                await fs.writeFile(fullPath, originalContent, "utf8");
              }
            } catch (restoreErr) {
              logger.error(`tryGitApply: Failed to restore ${target}`, {
                error: String(restoreErr),
              });
            }
          }

          return {
            ok: false,
            reason: `git apply sequence failed. Strict: ${extractGitStderr(strictErr)}; WS: ${extractGitStderr(wsErr)}; 3Way: ${extractGitStderr(threeWayErr)}`,
          };
        }
      }
    }

    logger.info("Diff applied via git apply", {
      repoRoot,
      fileCount: targets.length,
      files: targets,
      method: applyMethod,
    });
    return { ok: true, changedFiles: targets, method: applyMethod };
  } finally {
    try {
      await fs.unlink(tmpFile);
    } catch {
      void 0;
    }
  }
}

function insideRepo(repoRoot: string, relPath: string): string {
  const full = path.resolve(repoRoot, relPath);
  const normRoot = repoRoot.endsWith(path.sep) ? repoRoot : repoRoot + path.sep;
  if (!full.startsWith(normRoot)) {
    throw new Error(`Path escapes repo: ${relPath}`);
  }
  return full;
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
