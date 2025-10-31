import path from "path";
import { cfg } from "../../config.js";
import { parseRemote } from "../utils/remoteUtils.js";
import { sanitizeSegment, directoryExists } from "../utils/fsUtils.js";
import { ensureRepo } from "../setup/RepoSetup.js";

export type RepoResolution = {
  repoRoot: string;
  branch?: string | null;
  remote?: string | null;
  source: "payload_repo_root" | "payload_repo";
};

/**
 * RepoResolver - Resolves repository information from task payloads
 * 
 * Responsibilities:
 * - Extract branch, remote, and project hints from payloads
 * - Resolve local repo paths or clone remotes
 * - Validate repo paths and handle workspace protection
 */

/**
 * Extract branch from various payload fields
 */
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

/**
 * Check if a value looks like a UUID or numeric ID
 */
function isUuidLike(value: string) {
  const s = value.trim();
  // v1-v5 UUID pattern
  const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  // plain numeric IDs
  const numericRe = /^[0-9]+$/;
  return uuidRe.test(s) || numericRe.test(s);
}

/**
 * Extract human-friendly project name hint from payload
 */
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

/**
 * Extract repository URL from payload
 */
function repoUrlFromPayload(payload: any): string | null {
  if (!payload || typeof payload !== "object") return null;
  const candidates = [payload.repo, payload.repository, payload.git_url, payload.gitUrl, payload.remote];
  for (const candidate of candidates) {
    if (typeof candidate !== "string") continue;
    const trimmed = candidate.trim();
    if (!trimmed.length) continue;
    // Skip local filesystem-looking paths
    if (/^(?:[A-Za-z]:[/\\]|\\\\|\/)/.test(trimmed)) continue;
    // Only treat as a remote if it parses as an SSH/HTTPS git remote. Ignore local filesystem paths.
    try {
      // Will throw for local paths like C:\\... or /Users/...
      parseRemote(trimmed);
      return trimmed;
    } catch { /* not a valid git remote */ }
  }
  return null;
}

/**
 * Resolve repository from task payload
 * Handles local paths, remote URLs, and project hints
 */
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
    if (!/^(?:[A-Za-z]:[/\\]|\\\\|\/)/.test(trimmed)) continue; // not an absolute local path
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
