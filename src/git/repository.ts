import fs from "fs/promises";
import path from "path";
import { cfg } from "../config.js";
import { logger } from "../logger.js";
import { runGit, guardWorkspaceMutation } from "./core.js";
import { hasLocalChanges, branchExists, remoteBranchExists, detectRemoteDefaultBranch } from "./queries.js";

export type RepoResolution = {
  repoRoot: string;
  branch?: string | null;
  remote?: string | null;
  source: "payload_repo_root" | "payload_repo";
};

type RemoteInfo = {
  remote: string;
  sanitized: string;
  credentialUrl?: URL;
};

type ParsedRemote = {
  host: string;
  path: string;
};

function sanitizeSegment(seg: string) {
  // Normalize to lowercase to ensure consistent repo paths regardless of casing in project hints
  // This prevents /Multi-Agent-Log-Summarizer and /machine-client-log-summarizer from being different paths
  return seg.replace(/[^A-Za-z0-9._-]/g, "-").toLowerCase();
}

function parseRemote(remote: string): ParsedRemote {
  const trimmed = remote.trim();
  if (!trimmed) throw new Error("Remote URL is empty");

  // Guard: reject obvious local filesystem paths (Windows drive letters, UNC, POSIX absolute)
  // when they do not include a URL scheme. These are not git remotes.
  const isWindowsDrive = /^[A-Za-z]:[\\\/]/.test(trimmed);
  const isUnc = /^\\\\/.test(trimmed);
  const isPosixAbs = /^\//.test(trimmed);
  if (!trimmed.includes("://") && (isWindowsDrive || isUnc || isPosixAbs)) {
    throw new Error(`Local path is not a git remote: ${trimmed}`);
  }

  if (!trimmed.includes("://")) {
    const sshMatch = /^(?:[^@]+@)?([^:]+):(.+)$/.exec(trimmed);
    if (sshMatch) {
      return {
        host: sshMatch[1],
        path: sshMatch[2].replace(/^\/+/, "")
      };
    }
  }

  try {
    const url = new URL(trimmed);
    return {
      host: url.host,
      path: url.pathname.replace(/^\/+/, "")
    };
  } catch {
    throw new Error(`Unable to parse git remote: ${trimmed}`);
  }
}

function maskRemote(remote: string) {
  try {
    const url = new URL(remote);
    url.username = "";
    url.password = "";
    return `${url.protocol}//${url.host}${url.pathname}${url.search}`;
  } catch {
    return remote;
  }
}

async function directoryExists(p: string) {
  try {
    return (await fs.stat(p)).isDirectory();
  } catch {
    return false;
  }
}

async function ensureProjectBase() {
  await fs.mkdir(cfg.projectBase, { recursive: true });
}

function repoDirectoryFor(remote: string, projectHint?: string | null) {
  // Always prefer projectHint when available to avoid deep nested paths like PROJECT_BASE/github.com/org/repo
  if (projectHint && projectHint.trim().length) {
    const segments = projectHint
      .split(/[\\/]+/)
      .map(sanitizeSegment)
      .filter(Boolean);
    if (segments.length > 0) {
      return path.join(cfg.projectBase, ...segments);
    }
  }

  // Fallback: extract project name from remote URL path, but DON'T include hostname
  // This gives us PROJECT_BASE/project-name instead of PROJECT_BASE/github.com/org/project-name
  const parsed = parseRemote(remote);
  const rel = parsed.path.replace(/\.git$/i, "");
  const pieces = rel
    .split(/[\\/]+/)
    .map(sanitizeSegment)
    .filter(Boolean);
  
  // Use only the last segment (project name) from the remote path
  // e.g., "goblinsan/project-name" -> use "project-name"
  if (pieces.length > 0) {
    const projectName = pieces[pieces.length - 1];
    return path.join(cfg.projectBase, projectName);
  }
  
  // Last resort fallback
  return path.join(cfg.projectBase, cfg.defaultRepoName);
}

function remoteWithCredentials(remote: string): RemoteInfo {
  const secret = cfg.git.token || cfg.git.password;
  const hasSshKey = Boolean(cfg.git.sshKeyPath && cfg.git.sshKeyPath.length);

  if (hasSshKey) {
    try {
      const parsed = parseRemote(remote);
      const host = parsed.host.replace(/^https?:/i, "");
      const sshRemote = `git@${host}:${parsed.path}`;
      return { remote: sshRemote, sanitized: sshRemote };
    } catch {
      // fall through and let HTTPS handling take over
    }
  }

  const sanitized = maskRemote(remote);
  if (!secret) {
    return { remote, sanitized };
  }

  try {
    const url = new URL(remote);
    const username = (cfg.git.username || (cfg.git.token ? "git" : "")).trim() || "git";
    if (!url.username) url.username = username;
    url.password = secret;
    const credentialUrl = new URL(url.toString());
    return { remote: url.toString(), sanitized, credentialUrl };
  } catch {
    return { remote, sanitized };
  }
}

async function configureCredentialStore(repoRoot: string, credentialUrl?: URL) {
  if (!credentialUrl) return;
  if (!cfg.git.credentialsPath) return;
  const credentialsPath = cfg.git.credentialsPath;

  try {
    await fs.mkdir(path.dirname(credentialsPath), { recursive: true });
  } catch {}

  const username = credentialUrl.username || (cfg.git.username || (cfg.git.token ? "git" : ""));
  const password = credentialUrl.password || cfg.git.token || cfg.git.password;
  if (!password) return;

  const entry = `${credentialUrl.protocol}//${encodeURIComponent(username)}:${encodeURIComponent(password)}@${credentialUrl.host}`;

  try {
    await fs.writeFile(credentialsPath, `${entry}\n`, { mode: 0o600 });
  } catch (e) {
    logger.warn("git credential store write failed", { error: e, path: credentialsPath });
    return;
  }

  try {
    await runGit(["config", "credential.helper", `store --file=${credentialsPath}`], { cwd: repoRoot });
  } catch (e) {
    logger.warn("git credential helper config failed", { error: e, repoRoot, credentialsPath });
  }
}

function branchFromPayload(payload: any): string | null {
  if (!payload || typeof payload !== "object") return null;
  const candidates = [payload.branch, payload.ref, payload.default_branch, payload.target_branch];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim().length) {
      return candidate.trim();
    }
  }
  return null;
}

function isUuidLike(value: string) {
  const s = value.trim();
  // v1-v5 UUID pattern
  const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  // plain numeric IDs
  const numericRe = /^[0-9]+$/;
  return uuidRe.test(s) || numericRe.test(s);
}

function projectHintFromPayload(payload: any): string | null {
  if (!payload || typeof payload !== "object") return null;
  // Prefer human-friendly names/slugs; explicitly ignore UUIDs and bare numeric IDs
  const candidates = [
    payload.project_name,
    payload.projectName,
    payload.project_title,
    payload.projectTitle,
    payload.project_slug,
    payload.projectSlug,
    payload.project,
    payload.projectId,
    payload.project_id
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim().length) {
      const trimmed = candidate.trim();
      if (isUuidLike(trimmed)) continue; // skip UUIDs and numeric ids
      return trimmed;
    }
  }
  return null;
}

function repoUrlFromPayload(payload: any): string | null {
  if (!payload || typeof payload !== "object") return null;
  const candidates = [payload.repo, payload.repository, payload.git_url, payload.gitUrl, payload.remote];
  for (const candidate of candidates) {
    if (typeof candidate !== "string") continue;
    const trimmed = candidate.trim();
    if (!trimmed.length) continue;
    // Skip local filesystem-looking paths
    if (/^(?:[A-Za-z]:[\\\/]|\\\\|\/)/.test(trimmed)) continue;
    // Only treat as a remote if it parses as an SSH/HTTPS git remote. Ignore local filesystem paths.
    try {
      // Will throw for local paths like C:\\... or /Users/...
      parseRemote(trimmed);
      return trimmed;
    } catch {}
  }
  return null;
}

export async function resolveRepoFromPayload(payload: any): Promise<RepoResolution> {
  const branch = branchFromPayload(payload);
  const remote = repoUrlFromPayload(payload);
  const hint = projectHintFromPayload(payload);

  // Support: if a local repository path is provided via repo/repository fields and it's a git repo, use it
  const localPathCandidates: Array<string | undefined> = [
    typeof payload?.repo === 'string' ? payload.repo : undefined,
    typeof payload?.repository === 'string' ? payload.repository : undefined,
    typeof payload?.repo_root === 'string' ? payload.repo_root : undefined
  ];
  for (const cand of localPathCandidates) {
    if (!cand || typeof cand !== 'string') continue;
    const trimmed = cand.trim();
    if (!trimmed) continue;
    if (!/^(?:[A-Za-z]:[\\\/]|\\\\|\/)/.test(trimmed)) continue; // not an absolute local path
    const gitDir = path.join(trimmed, ".git");
    if (await directoryExists(gitDir).catch(() => false)) {
      // Avoid mutating the current workspace by default
      if (!cfg.allowWorkspaceGit && path.resolve(trimmed) === path.resolve(process.cwd())) {
        if (!remote) {
          throw new Error("Workspace repo provided but workspace mutations are disabled. Provide a repository remote URL so we can clone into PROJECT_BASE, or set MC_ALLOW_WORKSPACE_GIT=1 to opt-in.");
        }
        const ensured = await ensureRepo(remote, branch, hint);
        return { repoRoot: ensured.repoRoot, branch, remote: ensured.remote, source: "payload_repo" };
      }
      return { repoRoot: trimmed, branch, remote: null, source: "payload_repo_root" };
    }
  }

  // If a repo_root is provided, only use it when it's an actual git repo.
  if (payload && typeof payload.repo_root === "string" && payload.repo_root.trim().length) {
    const root = payload.repo_root.trim();
    // Avoid treating the workspace repo as an editable target unless explicitly allowed
    if (!cfg.allowWorkspaceGit && path.resolve(root) === path.resolve(process.cwd())) {
      if (!remote) {
        throw new Error("Workspace repo_root provided but workspace mutations are disabled. Provide a repository remote URL so we can clone into PROJECT_BASE, or set MC_ALLOW_WORKSPACE_GIT=1 to opt-in.");
      }
      const ensured = await ensureRepo(remote, branch, hint);
      return { repoRoot: ensured.repoRoot, branch, remote: ensured.remote, source: "payload_repo" };
    }
    const gitDir = path.join(root, ".git");
    const isRepo = await directoryExists(gitDir).catch(() => false);
    if (isRepo) {
      return { repoRoot: root, branch, remote: null, source: "payload_repo_root" };
    }
    // Try repo_root + project hint (common case when a parent folder is provided)
    if (hint && hint.trim().length) {
      const candidate = path.join(root, sanitizeSegment(hint));
      const candGit = path.join(candidate, ".git");
      if (await directoryExists(candGit).catch(() => false)) {
        return { repoRoot: candidate, branch, remote: null, source: "payload_repo_root" };
      }
    }
    // If remote is available, fall back to cloning/ensuring under our projectBase
    if (remote) {
      const ensured = await ensureRepo(remote, branch, hint);
      return { repoRoot: ensured.repoRoot, branch, remote: ensured.remote, source: "payload_repo" };
    }
    // As a last resort, fall through to config default
  }

  if (remote) {
    const ensured = await ensureRepo(remote, branch, hint);
    return { repoRoot: ensured.repoRoot, branch, remote: ensured.remote, source: "payload_repo" };
  }

  // No valid repo_root and no remote to resolve from: refuse to return a placeholder
  throw new Error("No repository remote provided and repo_root is not a git repository. Configure the project's repository URL in the dashboard or provide a valid repo_root.");
}

async function ensureRepo(remote: string, branch: string | null, projectHint: string | null) {
  await ensureProjectBase();
  const remoteInfo = remoteWithCredentials(remote);
  const repoRoot = repoDirectoryFor(remote, projectHint);
  const displayRemote = maskRemote(remoteInfo.sanitized);

  const repoExists = await directoryExists(repoRoot);
  const gitDirExists = await directoryExists(path.join(repoRoot, ".git"));

  if (!repoExists) {
    await fs.mkdir(path.dirname(repoRoot), { recursive: true });
    logger.info("git clone", { remote: displayRemote, repoRoot });
    // Always run clone with an explicit cwd to avoid inheriting the process cwd
    await runGit(["clone", remoteInfo.remote, repoRoot], { cwd: cfg.projectBase });
  } else if (!gitDirExists) {
    throw new Error(`Cannot reuse ${repoRoot}: path exists but is not a git repo`);
  } else {
    logger.info("git fetch", { remote: displayRemote, repoRoot });
    try {
      await runGit(["remote", "set-url", "origin", remoteInfo.sanitized], { cwd: repoRoot });
    } catch {}
    await runGit(["fetch", "--all", "--tags"], { cwd: repoRoot });
  }

  if (remoteInfo.sanitized !== remoteInfo.remote) {
    try {
      await runGit(["remote", "set-url", "origin", remoteInfo.sanitized], { cwd: repoRoot });
    } catch (e) {
      logger.warn("git set-url origin failed", { error: e, repoRoot, url: remoteInfo.sanitized });
    }
  }

  await configureCredentialStore(repoRoot, remoteInfo.credentialUrl);

  if (branch) {
    const remoteExists = await remoteBranchExists(repoRoot, branch);
    
    try {
      await runGit(["checkout", branch], { cwd: repoRoot });
    } catch {
      try {
        if (remoteExists) {
          await runGit(["checkout", "-B", branch, `origin/${branch}`], { cwd: repoRoot });
        } else {
          // Branch doesn't exist locally or remotely, will be created later
          logger.debug("Branch does not exist locally or remotely", { repoRoot, branch });
        }
      } catch (e) {
        logger.warn("git checkout branch failed", { error: e, repoRoot, branch });
      }
    }
    
    // Only try to pull if remote branch exists
    if (remoteExists) {
      try {
        await runGit(["pull", "--ff-only", "origin", branch], { cwd: repoRoot });
      } catch (e) {
        logger.warn("git pull failed", { error: e, repoRoot, branch });
        // Safe realignment if no local changes exist
        try {
          if (!(await hasLocalChanges(repoRoot))) {
            await runGit(["fetch", "origin", branch], { cwd: repoRoot }).catch(()=>{});
            await runGit(["reset", "--hard", `origin/${branch}`], { cwd: repoRoot });
            logger.info("git branch aligned to origin after non-FF pull (ensureRepo)", { repoRoot, branch });
          }
        } catch (alignErr) {
          logger.warn("git align to origin failed (ensureRepo)", { repoRoot, branch, error: alignErr });
        }
      }
    } else {
      logger.debug("Skipping pull for new branch", { repoRoot, branch });
    }
  } else {
    let current = "";
    try {
      current = (await runGit(["rev-parse", "--abbrev-ref", "HEAD"], { cwd: repoRoot })).stdout.trim();
    } catch {}

    if (!current || current === "HEAD") {
      const fallback = (await detectRemoteDefaultBranch(repoRoot)) || cfg.git.defaultBranch;
      if (fallback) {
        try {
          await runGit(["checkout", fallback], { cwd: repoRoot });
        } catch (e) {
          logger.warn("git default branch checkout failed", { error: e, repoRoot, fallback });
        }
      }
    }
  }

  return { repoRoot, remote: remoteInfo.sanitized };
}

async function handleCheckoutError(repoRoot: string, branch: string, error: any): Promise<never> {
  if (await hasLocalChanges(repoRoot)) {
    const message = `Cannot checkout ${branch}: uncommitted changes detected in local repository at ${repoRoot}. Commit, stash, or discard the changes and try again.`;
    throw new Error(message, { cause: error });
  }
  throw error;
}

export async function checkoutBranchFromBase(repoRoot: string, baseBranch: string, newBranch: string) {
  guardWorkspaceMutation(repoRoot, `checkoutBranchFromBase ${newBranch} from ${baseBranch}`);
  
  const fetchBranch = async (branch: string, warnOnError: boolean) => {
    if (!branch) return;
    try {
      await runGit(["fetch", "origin", branch], { cwd: repoRoot });
    } catch (error) {
      const meta = { repoRoot, branch, error };
      if (warnOnError) {
        logger.warn("git fetch branch failed", meta);
      } else {
        logger.debug("git fetch branch failed", meta);
      }
    }
  };

  await fetchBranch(baseBranch, true);
  await fetchBranch(newBranch, false);

  if (await branchExists(repoRoot, newBranch)) {
    try {
      await runGit(["checkout", newBranch], { cwd: repoRoot });
    } catch (error) {
      await handleCheckoutError(repoRoot, newBranch, error);
    }

    // Only pull if the remote branch exists
    const remoteExists = await remoteBranchExists(repoRoot, newBranch);
    if (remoteExists) {
      try {
        await runGit(["pull", "--ff-only", "origin", newBranch], { cwd: repoRoot });
      } catch (error) {
        logger.warn("git pull branch failed", { repoRoot, branch: newBranch, error });
        // If there are no local changes, align the branch to the remote to recover from divergence
        try {
          if (!(await hasLocalChanges(repoRoot))) {
            await runGit(["fetch", "origin", newBranch], { cwd: repoRoot }).catch(() => {});
            await runGit(["reset", "--hard", `origin/${newBranch}`], { cwd: repoRoot });
            logger.info("git branch aligned to origin after non-FF pull", { repoRoot, branch: newBranch });
          }
        } catch (alignErr) {
          logger.warn("git align to origin failed", { repoRoot, branch: newBranch, error: alignErr });
        }
      }
    } else {
      logger.debug("Branch exists locally but not on remote, skipping pull", { repoRoot, branch: newBranch });
    }
    return;
  }

  if (await remoteBranchExists(repoRoot, newBranch)) {
    try {
      await runGit(["checkout", "-B", newBranch, `origin/${newBranch}`], { cwd: repoRoot });
    } catch (error) {
      await handleCheckoutError(repoRoot, newBranch, error);
    }
    return;
  }

  if (await branchExists(repoRoot, baseBranch)) {
    try {
      await runGit(["checkout", baseBranch], { cwd: repoRoot });
    } catch (error) {
      await handleCheckoutError(repoRoot, baseBranch, error);
    }
  } else if (await remoteBranchExists(repoRoot, baseBranch)) {
    try {
      await runGit(["checkout", "-B", baseBranch, `origin/${baseBranch}`], { cwd: repoRoot });
    } catch (error) {
      await handleCheckoutError(repoRoot, baseBranch, error);
    }
  } else {
    throw new Error(`Base branch ${baseBranch} not found in repository ${repoRoot}`);
  }

  try {
    await runGit(["pull", "--ff-only", "origin", baseBranch], { cwd: repoRoot });
  } catch (error) {
    logger.warn("git pull branch failed", { repoRoot, branch: baseBranch, error });
  }

  try {
    await runGit(["checkout", "-B", newBranch, baseBranch], { cwd: repoRoot });
  } catch (error) {
    await handleCheckoutError(repoRoot, newBranch, error);
  }
}
