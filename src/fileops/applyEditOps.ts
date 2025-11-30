import fs from "fs/promises";
import path from "path";

import { runGit } from "../gitUtils.js";
import { cfg } from "../config.js";
import { logger } from "../logger.js";
import {
  buildExtensionPolicy,
  evaluatePolicy,
  isGloballyBlockedPath,
} from "../fileopsPolicy.js";
import type {
  ApplyOptions,
  DeleteOp,
  EditSpec,
  Hunk,
  UpsertOp,
} from "../fileops.js";

type ApplyEditOpsResult = {
  changed: string[];
  branch: string;
  sha: string;
  noop?: boolean;
};

export async function applyEditOps(
  jsonText: string,
  opts: ApplyOptions,
): Promise<ApplyEditOpsResult> {
  const repoRoot = normalizeRoot(opts.repoRoot);

  if (repoRoot === process.cwd() && !cfg.allowWorkspaceGit) {
    throw new Error(
      `Workspace git mutation blocked (applyEditOps) at ${repoRoot}. Set MC_ALLOW_WORKSPACE_GIT=1 to override.`,
    );
  }

  const maxBytes = opts.maxBytes ?? 512 * 1024;
  const blockedPolicy = [
    ...(cfg.blockedExts || []),
    ...(opts.blockedExts || []),
  ];
  const extensionPolicy = buildExtensionPolicy(blockedPolicy);

  let spec: EditSpec;
  try {
    spec = JSON.parse(jsonText);
  } catch {
    throw new Error("Invalid JSON from model (expected edit spec)");
  }
  if (!spec?.ops || !Array.isArray(spec.ops)) {
    throw new Error("Edit spec missing ops[]");
  }

  const branch = opts.branchName || "feat/agent-edit";
  const commitMsg = opts.commitMessage || "agent: apply edits";
  const sanitizedCommitMsg = String(commitMsg).replace(/\s+/g, " ").trim();

  const changed: string[] = [];
  for (const op of spec.ops) {
    if (!op || typeof op !== "object" || typeof (op as any).action !== "string") {
      throw new Error("Bad op object");
    }

    if ((op as any).action === "upsert") {
      const u = op as UpsertOp;
      if (typeof u.path !== "string") {
        throw new Error("Bad upsert op fields");
      }
      if (isGloballyBlockedPath(u.path)) {
        throw new Error(`Path blocked by policy: ${u.path}`);
      }
      const verdict = evaluatePolicy(u.path, extensionPolicy);
      if (!verdict.allowed) {
        throw new Error(`Extension blocked by policy: ${u.path}`);
      }

      const full = insideRepo(repoRoot, u.path);
      let contentToWrite: string | undefined = u.content;

      if (Array.isArray(u.hunks) && u.hunks.length) {
        try {
          let baseText: string | null = null;
          try {
            baseText = await fs.readFile(insideRepo(repoRoot, u.path), "utf8");
          } catch {
            baseText = null;
          }
          if (baseText !== null) {
            const baseLines = baseText.split(/\r?\n/);
            const applyResult = applyHunksToLines(baseLines, u.hunks);
            if (applyResult.ok) {
              contentToWrite = applyResult.content;
            } else {
              try {
                await writeDiagnostic(repoRoot, u.path, {
                  reason: "hunk_context_mismatch",
                  path: u.path,
                  hunks: u.hunks,
                  baseSample: baseLines.slice(0, 50).join("\n"),
                });
              } catch (error) {
                logger.warn("Failed to write diagnostic for hunk context mismatch", {
                  path: u.path,
                  error: String(error),
                });
              }
            }
          }
        } catch (error) {
          logger.error("Failed to read or apply diff hunks", {
            path: u.path,
            error: String(error),
          });
          throw error;
        }
      }

      if (typeof contentToWrite !== "string") {
        throw new Error("No content available for upsert");
      }
      await upsertFile(full, contentToWrite, maxBytes);
      changed.push(path.relative(repoRoot, full).replace(/\\/g, "/"));
      continue;
    }

    if ((op as any).action === "delete") {
      const d = op as DeleteOp;
      if (typeof d.path !== "string") {
        throw new Error("Bad delete op fields");
      }
      if (isGloballyBlockedPath(d.path)) {
        throw new Error(`Path blocked by policy: ${d.path}`);
      }
      const verdict = evaluatePolicy(d.path, extensionPolicy);
      if (!verdict.allowed) {
        throw new Error(`Extension blocked by policy: ${d.path}`);
      }
      const full = insideRepo(repoRoot, d.path);

      try {
        await fs.unlink(full);
      } catch (error) {
        logger.debug("Failed to delete file (may not exist)", {
          path: d.path,
          error: String(error),
        });
      }

      changed.push(path.relative(repoRoot, full).replace(/\\/g, "/"));
      continue;
    }

    throw new Error(`Unsupported action: ${(op as any).action}`);
  }

  if (!changed.length) {
    return { changed: [], branch, sha: "" };
  }

  try {
    await runGit(["add", ...changed], { cwd: repoRoot });
    await runGit(
      ["commit", "--no-verify", "-m", sanitizedCommitMsg, "--", ...changed],
      { cwd: repoRoot },
    );
  } catch (err) {
    if (isNoopCommitError(err)) {
      return await buildNoopResult(repoRoot, branch, changed);
    }

    const fallbackResult = await handleCommitFailure(
      repoRoot,
      branch,
      changed,
      sanitizedCommitMsg,
      err,
    );
    if (fallbackResult) {
      return fallbackResult;
    }
  }

  const sha = (
    await runGit(["rev-parse", "HEAD"], { cwd: repoRoot })
  ).stdout.trim();

  await pushChanges(repoRoot, branch, sha, changed);
  return { changed, branch, sha };
}

function normalizeRoot(p: string) {
  return path.resolve(p);
}

function insideRepo(repoRoot: string, relPath: string) {
  const full = path.resolve(repoRoot, relPath);
  const normRoot = repoRoot.endsWith(path.sep) ? repoRoot : repoRoot + path.sep;
  if (!full.startsWith(normRoot)) {
    throw new Error(`Path escapes repo: ${relPath}`);
  }
  return full;
}

async function upsertFile(fullPath: string, content: string, maxBytes: number) {
  const buf = Buffer.from(content, "utf8");
  if (buf.byteLength > maxBytes) {
    throw new Error(
      `File too large: ${fullPath} (${buf.byteLength} > ${maxBytes})`,
    );
  }
  await fs.mkdir(path.dirname(fullPath), { recursive: true });
  const tmp = `${fullPath}.tmp`;
  await fs.writeFile(tmp, buf);
  await fs.rename(tmp, fullPath);
}

async function handleCommitFailure(
  repoRoot: string,
  branch: string,
  changed: string[],
  commitMsg: string,
  initialError: unknown,
): Promise<ApplyEditOpsResult | null> {
  if (isNoopCommitError(initialError)) {
    return await buildNoopResult(repoRoot, branch, changed);
  }

  logGitFailure("git add/commit targeted", initialError, {
    repoRoot,
    changedCount: changed.length,
  });

  try {
    await runGit(["add", "--force", ...changed], { cwd: repoRoot });
    await runGit(
      ["commit", "--no-verify", "-m", commitMsg, "--", ...changed],
      { cwd: repoRoot },
    );
    return null;
  } catch (err2) {
    if (isNoopCommitError(err2)) {
      return await buildNoopResult(repoRoot, branch, changed);
    }

    logGitFailure("git add/commit force", err2, {
      repoRoot,
      changedCount: changed.length,
    });

    try {
      await writeDiagnostic(repoRoot, "apply-commit-broad-attempt.json", {
        changed,
        note: "attempting git add -A and commit as fallback",
        error: String(err2),
      });
    } catch (diagError) {
      logger.warn("Failed to write diagnostic for commit broad attempt", {
        error: String(diagError),
      });
    }

    try {
      await runGit(["add", "-A"], { cwd: repoRoot });
      await runGit(["commit", "--no-verify", "-m", commitMsg], {
        cwd: repoRoot,
      });
      return null;
    } catch (err3) {
      if (isNoopCommitError(err3)) {
        return await buildNoopResult(repoRoot, branch, changed);
      }

      logGitFailure("git add/commit -A", err3, {
        repoRoot,
        changedCount: changed.length,
      });
      logger.error("Final commit attempt failed", {
        changed,
        repoRoot,
        error: String(err3),
        ...extractGitErrorDetails(err3),
      });

      try {
        await writeDiagnostic(repoRoot, "apply-commit-failure.json", {
          changed,
          error: String(err3),
          stdout:
            err3 && (err3 as any).stdout
              ? String((err3 as any).stdout)
              : undefined,
        });
      } catch (diagError) {
        logger.warn("Failed to write diagnostic for commit failure", {
          error: String(diagError),
        });
      }

      await resetWorkingTree(repoRoot, changed);
      throw err3;
    }
  }
}

async function pushChanges(
  repoRoot: string,
  branch: string,
  sha: string,
  changed: string[],
) {
  try {
    const remotes = await runGit(["remote"], { cwd: repoRoot });
    const hasRemote = remotes.stdout.trim().length > 0;

    if (!hasRemote) {
      try {
        await writeDiagnostic(repoRoot, "apply-no-remote.json", {
          branch,
          sha,
          changed,
          note: "No remote configured - skipping push (test environment?)",
        });
      } catch (diagError) {
        logger.debug("Failed to write diagnostic for no-remote", {
          repoRoot,
          error: String(diagError),
        });
      }
      return;
    }

    await runGit(["push", "origin", branch, "--force"], { cwd: repoRoot });
  } catch (pushErr) {
    logger.error("Git push failed", {
      branch,
      repoRoot,
      error: String(pushErr),
      ...extractGitErrorDetails(pushErr),
    });

    try {
      await writeDiagnostic(repoRoot, "apply-push-failure.json", {
        branch,
        sha,
        changed,
        error: String(pushErr),
        ...extractGitErrorDetails(pushErr),
      });
    } catch (diagError) {
      logger.debug("Failed to write diagnostic for push-failure", {
        repoRoot,
        error: String(diagError),
      });
    }

    throw new Error(`Failed to push branch ${branch}: ${pushErr}`);
  }
}

async function resetWorkingTree(repoRoot: string, changed: string[]) {
  try {
    await runGit(["reset", "--hard", "HEAD"], { cwd: repoRoot });
    await runGit(["clean", "-fd"], { cwd: repoRoot });
    logger.info("Working tree reset after git failure", {
      repoRoot,
      changedCount: changed.length,
    });
  } catch (error) {
    logger.warn("Failed to reset working tree after git failure", {
      repoRoot,
      changedCount: changed.length,
      error: String(error),
      ...extractGitErrorDetails(error),
    });
  }
}

export async function writeDiagnostic(
  repoRoot: string,
  targetPath: string,
  payload: Record<string, unknown>,
) {
  if (!cfg.writeDiagnostics) {
    return;
  }
  try {
    const outDir = path.join(repoRoot, "outputs", "diagnostics");
    await fs.mkdir(outDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const safe = targetPath.replace(/[^a-zA-Z0-9_.-]/g, "_");
    const file = path.join(outDir, `${stamp}-${safe}.json`);
    await fs.writeFile(file, JSON.stringify(payload, null, 2));
  } catch (error) {
    logger.warn("Failed to write diagnostic", {
      repoRoot,
      targetPath,
      error: String(error),
    });
  }
}

function applyHunksToLines(
  baseLines: string[],
  hunks: Hunk[],
): { ok: boolean; content?: string } {
  let lines = baseLines.slice();
  let offset = 0;

  for (const h of hunks) {
    const oldStartIdx = h.oldStart - 1 + offset;
    const oldCount = h.oldCount;

    const newLines: string[] = [];
    for (const l of h.lines) {
      if (l.startsWith("+")) newLines.push(l.slice(1));
      else if (l.startsWith(" ")) newLines.push(l.slice(1));
      else if (!l.startsWith("-")) newLines.push(l);
    }

    const contextLines: { idx: number; text: string }[] = [];
    let scanIdx = h.oldStart - 1;
    for (const l of h.lines) {
      if (l.startsWith(" ")) {
        contextLines.push({ idx: scanIdx, text: l.slice(1) });
        scanIdx += 1;
      } else if (l.startsWith("-")) {
        scanIdx += 1;
      } else if (!l.startsWith("+")) {
        contextLines.push({ idx: scanIdx, text: l });
        scanIdx += 1;
      }
    }

    for (const c of contextLines) {
      const actualIdx = c.idx + offset;
      if (actualIdx < 0 || actualIdx >= lines.length) {
        return { ok: false };
      }
      if (lines[actualIdx] !== c.text) {
        return { ok: false };
      }
    }

    lines.splice(oldStartIdx, oldCount, ...newLines);
    offset += newLines.length - oldCount;
  }

  const content = lines.join("\n") + (lines.length ? "\n" : "");
  return { ok: true, content };
}

function extractGitErrorDetails(error: unknown): Record<string, unknown> {
  if (!error || typeof error !== "object") return {};
  const details: Record<string, unknown> = {};
  const stdout = normalizeGitBuffer((error as any).stdout);
  const stderr = normalizeGitBuffer((error as any).stderr);
  if (stdout) details.stdout = stdout;
  if (stderr) details.stderr = stderr;
  if (typeof (error as any).cmd === "string") {
    details.cmd = (error as any).cmd;
  }
  if ((error as any).code !== undefined) {
    details.code = (error as any).code;
  }
  if ((error as any).signal !== undefined) {
    details.signal = (error as any).signal;
  }
  return details;
}

function normalizeGitBuffer(value: unknown): string | undefined {
  if (!value) return undefined;
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  if (value instanceof Buffer) {
    const text = value.toString("utf8").trim();
    return text.length > 0 ? text : undefined;
  }
  return undefined;
}

function logGitFailure(
  stage: string,
  error: unknown,
  extra?: Record<string, unknown>,
) {
  logger.warn("Git command failed", {
    stage,
    error: String(error),
    ...(extra || {}),
    ...extractGitErrorDetails(error),
  });
}

function isNoopCommitError(error: unknown): boolean {
  const signals = [
    "nothing to commit",
    "working tree clean",
    "no changes added to commit",
  ];
  const values: string[] = [];
  const stdout = normalizeGitBuffer((error as any)?.stdout);
  const stderr = normalizeGitBuffer((error as any)?.stderr);
  if (stdout) values.push(stdout);
  if (stderr) values.push(stderr);
  if (error instanceof Error && error.message) {
    values.push(error.message);
  }
  if (typeof error === "string") {
    values.push(error);
  }
  if (values.length === 0) {
    return false;
  }
  const haystack = values.join("\n").toLowerCase();
  return signals.some((signal) => haystack.includes(signal));
}

async function buildNoopResult(
  repoRoot: string,
  branch: string,
  changed: string[],
): Promise<ApplyEditOpsResult> {
  logger.info("No new changes detected after applying edit ops", {
    repoRoot,
    branch,
    attemptedFiles: changed.length,
  });
  const sha = (
    await runGit(["rev-parse", "HEAD"], { cwd: repoRoot })
  ).stdout.trim();
  return { changed, branch, sha, noop: true };
}
