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
  
  const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  
  const numericRe = /^[0-9]+$/;
  return uuidRe.test(s) || numericRe.test(s);
}


function projectHintFromPayload(payload: any): string | null {
  if (!payload || typeof payload !== "object") return null;
  
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
      if (isUuidLike(trimmed)) continue;
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
    
    if (/^(?:[A-Za-z]:[/\\]|\\\\|\/)/.test(trimmed)) continue;
    
    try {
      
      parseRemote(trimmed);
      return trimmed;
    } catch {  }
  }
  return null;
}


export async function resolveRepoFromPayload(payload: any): Promise<RepoResolution> {
  const branch = branchFromPayload(payload);
  const remote = repoUrlFromPayload(payload);
  const hint = projectHintFromPayload(payload);

  
  const localPathCandidates: Array<string | undefined> = [
    typeof payload?.repo === 'string' ? payload.repo : undefined,
    typeof payload?.repository === 'string' ? payload.repository : undefined,
    typeof payload?.repo_root === 'string' ? payload.repo_root : undefined
  ];
  for (const cand of localPathCandidates) {
    if (!cand || typeof cand !== 'string') continue;
    const trimmed = cand.trim();
    if (!trimmed) continue;
    if (!/^(?:[A-Za-z]:[/\\]|\\\\|\/)/.test(trimmed)) continue;
    const gitDir = path.join(trimmed, ".git");
    if (await directoryExists(gitDir).catch(() => false)) {
      
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

  
  if (payload && typeof payload.repo_root === "string" && payload.repo_root.trim().length) {
    const root = payload.repo_root.trim();
    
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
    
    if (hint && hint.trim().length) {
      const candidate = path.join(root, sanitizeSegment(hint));
      const candGit = path.join(candidate, ".git");
      if (await directoryExists(candGit).catch(() => false)) {
        return { repoRoot: candidate, branch, remote: null, source: "payload_repo_root" };
      }
    }
    
    if (remote) {
      const ensured = await ensureRepo(remote, branch, hint);
      return { repoRoot: ensured.repoRoot, branch, remote: ensured.remote, source: "payload_repo" };
    }
    
  }

  if (remote) {
    const ensured = await ensureRepo(remote, branch, hint);
    return { repoRoot: ensured.repoRoot, branch, remote: ensured.remote, source: "payload_repo" };
  }

  
  throw new Error("No repository remote provided and repo_root is not a git repository. Configure the project's repository URL in the dashboard or provide a valid repo_root.");
}
