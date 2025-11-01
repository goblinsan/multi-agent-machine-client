import { logger } from "../logger.js";
import { runGit } from "./core.js";

export async function detectRemoteDefaultBranch(
  repoRoot: string,
): Promise<string | null> {
  try {
    const symbolic = await runGit(
      ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"],
      { cwd: repoRoot },
    );
    const ref = symbolic.stdout.trim();
    if (ref.startsWith("refs/remotes/origin/")) {
      return ref.slice("refs/remotes/origin/".length);
    }
    if (ref.length) return ref;
  } catch (e) {
    logger.debug("Failed to detect remote default branch via symbolic-ref", {
      repoRoot,
      error: String(e),
    });
  }

  try {
    const remoteShow = await runGit(["remote", "show", "origin"], {
      cwd: repoRoot,
    });
    const line = remoteShow.stdout
      .split(/\r?\n/)
      .map((s) => s.trim())
      .find((s) => s.toLowerCase().startsWith("head branch:"));
    if (line) {
      const branch = line.split(":", 2)[1]?.trim();
      if (branch) return branch;
    }
  } catch (e) {
    logger.debug("Failed to check remote HEAD ref", {
      repoRoot,
      error: String(e),
    });
  }

  return null;
}

export async function branchExists(repoRoot: string, branch: string) {
  if (!branch) return false;
  try {
    await runGit(["rev-parse", "--verify", branch], { cwd: repoRoot });
    return true;
  } catch {
    return false;
  }
}

export async function remoteBranchExists(repoRoot: string, branch: string) {
  if (!branch) return false;
  try {
    await runGit(["rev-parse", "--verify", `origin/${branch}`], {
      cwd: repoRoot,
    });
    return true;
  } catch {
    return false;
  }
}

export async function hasLocalChanges(repoRoot: string) {
  const status = await runGit(["status", "--porcelain"], { cwd: repoRoot });
  const stdout = status.stdout?.toString?.() ?? "";
  return stdout.trim().length > 0;
}

export type WorkingTreeEntry = {
  status: string;
  path: string;
  secondaryPath?: string;
};

export type WorkingTreeSummary = {
  dirty: boolean;
  branch?: string | null;
  entries: WorkingTreeEntry[];
  summary: {
    staged: number;
    unstaged: number;
    untracked: number;
    total: number;
  };
  porcelain: string[];
  error?: string;
};

export async function describeWorkingTree(
  repoRoot: string,
): Promise<WorkingTreeSummary> {
  try {
    const status = await runGit(["status", "--porcelain", "--branch"], {
      cwd: repoRoot,
    });
    const stdout = status.stdout?.toString?.() ?? "";
    const lines = stdout.split(/\r?\n/).filter(Boolean);

    let branch: string | null = null;
    const entries: WorkingTreeEntry[] = [];

    for (const line of lines) {
      if (line.startsWith("##")) {
        const branchInfo = line.slice(2).trim();
        const branchName = branchInfo.split("...")[0]?.trim();
        branch = branchName || branchInfo || null;
        continue;
      }

      const statusCode = line.slice(0, 2);
      const remainder = line.slice(3);
      if (!remainder) continue;

      const renameParts = remainder.split(" -> ");
      const primaryPath = renameParts[0];
      const secondaryPath = renameParts[1];

      entries.push({
        status: statusCode,
        path: primaryPath,
        secondaryPath,
      });
    }

    const staged = entries.filter(
      (entry) => entry.status[0] !== " " && entry.status[0] !== "?",
    ).length;
    const untracked = entries.filter((entry) => entry.status === "??").length;
    const unstaged = entries.filter(
      (entry) => entry.status[1] !== " " && entry.status !== "??",
    ).length;
    const total = entries.length;

    return {
      dirty: total > 0,
      branch,
      entries,
      summary: {
        staged,
        unstaged,
        untracked,
        total,
      },
      porcelain: lines.filter((line) => !line.startsWith("##")),
    };
  } catch (error) {
    return {
      dirty: true,
      branch: null,
      entries: [],
      summary: {
        staged: 0,
        unstaged: 0,
        untracked: 0,
        total: 0,
      },
      porcelain: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function remoteSlug(remote: string | null | undefined) {
  if (!remote) return null;
  try {
    const trimmed = remote.trim();
    if (trimmed.includes("://")) {
      const url = new URL(trimmed);
      return `${url.host}${url.pathname}`.replace(/\.git$/i, "");
    }

    const sshMatch = /^(?:[^@]+@)?([^:]+):(.+)$/.exec(trimmed);
    if (sshMatch) {
      return `${sshMatch[1]}/${sshMatch[2]}`.replace(/\.git$/i, "");
    }
    return null;
  } catch {
    return null;
  }
}

export async function getRepoMetadata(repoRoot: string) {
  let remoteUrl: string | null = null;
  let remoteSlugValue: string | null = null;
  let currentBranch: string | null = null;

  try {
    const remoteRes = await runGit(["remote", "get-url", "origin"], {
      cwd: repoRoot,
    });
    const remote = remoteRes.stdout.trim();
    if (remote.length) {
      remoteUrl = remote;
      remoteSlugValue = remoteSlug(remote);
    }
  } catch (e) {
    logger.debug("No remote origin URL found", { repoRoot, error: String(e) });
  }

  try {
    const branchRes = await runGit(["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd: repoRoot,
    });
    const branch = branchRes.stdout.trim();
    if (branch && branch !== "HEAD") currentBranch = branch;
  } catch (e) {
    logger.debug("Failed to get current branch", {
      repoRoot,
      error: String(e),
    });
  }

  return { remoteUrl, remoteSlug: remoteSlugValue, currentBranch };
}

export type RemoteDiffVerification = {
  ok: boolean;
  hasDiff: boolean;
  branch: string;
  baseBranch?: string | null;
  branchSha?: string | null;
  baseSha?: string | null;
  aheadCount?: number;
  diffSummary?: string;
  reason?: string;
  error?: string;
};

export async function verifyRemoteBranchHasDiff(options: {
  repoRoot: string;
  branch: string;
  baseBranch?: string | null;
}): Promise<RemoteDiffVerification> {
  const { repoRoot } = options;
  const branch = options.branch?.trim();
  const baseBranch = options.baseBranch?.trim() || null;

  if (!branch) {
    return {
      ok: false,
      hasDiff: false,
      branch: "",
      baseBranch,
      reason: "missing_branch",
    };
  }

  const branchRef = `origin/${branch}`;
  let branchSha: string | null = null;
  let baseSha: string | null = null;
  let aheadCount = 0;
  let diffSummary = "";

  const fetchTarget = async (target: string | null) => {
    if (!target) return;
    try {
      await runGit(["fetch", "origin", target], { cwd: repoRoot });
    } catch (err) {
      logger.debug("verifyRemoteBranchHasDiff: fetch failed", {
        repoRoot,
        target,
        error: err,
      });
    }
  };

  await fetchTarget(branch);
  if (baseBranch && baseBranch !== branch) {
    await fetchTarget(baseBranch);
  }

  try {
    branchSha = (
      await runGit(["rev-parse", branchRef], { cwd: repoRoot })
    ).stdout.trim();
  } catch (err: any) {
    const errorMessage = err?.message || String(err);
    return {
      ok: false,
      hasDiff: false,
      branch,
      baseBranch,
      branchSha: null,
      baseSha: null,
      aheadCount,
      diffSummary,
      reason: "branch_not_found",
      error: errorMessage,
    };
  }

  let baseRef: string | null = null;
  if (baseBranch && baseBranch !== branch) {
    baseRef = `origin/${baseBranch}`;
    try {
      baseSha = (
        await runGit(["rev-parse", baseRef], { cwd: repoRoot })
      ).stdout.trim();
    } catch (err) {
      logger.debug("verifyRemoteBranchHasDiff: base branch missing", {
        repoRoot,
        baseBranch,
        error: err,
      });
      baseRef = null;
      baseSha = null;
    }
  }

  const hasMeaningfulDiff = (text: string | null | undefined) => {
    if (!text) return false;
    const trimmed = text.trim();
    if (!trimmed) return false;
    return !/0 files changed/i.test(trimmed);
  };

  if (baseRef) {
    try {
      const revList = await runGit(
        ["rev-list", "--count", `${baseRef}..${branchRef}`],
        { cwd: repoRoot },
      );
      aheadCount = Number.parseInt(revList.stdout.trim() || "0", 10) || 0;
    } catch (err) {
      logger.debug("verifyRemoteBranchHasDiff: rev-list failed", {
        repoRoot,
        baseRef,
        branchRef,
        error: err,
      });
    }

    try {
      const diffRes = await runGit(
        ["diff", "--stat", `${baseRef}..${branchRef}`],
        { cwd: repoRoot },
      );
      diffSummary = diffRes.stdout.trim();
    } catch (err) {
      logger.debug("verifyRemoteBranchHasDiff: diff stat failed", {
        repoRoot,
        baseRef,
        branchRef,
        error: err,
      });
      diffSummary = "";
    }

    const ok = aheadCount > 0 || hasMeaningfulDiff(diffSummary);
    return {
      ok,
      hasDiff: ok,
      branch,
      baseBranch,
      branchSha,
      baseSha,
      aheadCount,
      diffSummary,
      reason: ok ? undefined : "no_diff",
    };
  }

  try {
    const showRes = await runGit(
      ["show", "--stat", "--format=medium", "-1", branchRef],
      { cwd: repoRoot },
    );
    diffSummary = showRes.stdout.trim();
  } catch (err: any) {
    const errorMessage = err?.message || String(err);
    return {
      ok: false,
      hasDiff: false,
      branch,
      baseBranch,
      branchSha,
      baseSha,
      aheadCount,
      diffSummary: "",
      reason: "diff_inspection_failed",
      error: errorMessage,
    };
  }

  const ok = hasMeaningfulDiff(diffSummary);
  return {
    ok,
    hasDiff: ok,
    branch,
    baseBranch,
    branchSha,
    baseSha,
    aheadCount,
    diffSummary,
    reason: ok ? undefined : "no_diff_no_base",
  };
}

export async function getBranchHeadSha(options: {
  repoRoot: string;
  branch: string;
  remote?: boolean;
}): Promise<string | null> {
  const { repoRoot, branch, remote } = options;
  if (!branch) return null;
  const ref = remote ? `origin/${branch}` : branch;
  try {
    const result = await runGit(["rev-parse", "--verify", ref], {
      cwd: repoRoot,
    });
    const sha = result.stdout.trim();
    return sha.length ? sha : null;
  } catch {
    return null;
  }
}
