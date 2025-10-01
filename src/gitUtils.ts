import fs from "fs/promises";
import path from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import { cfg } from "./config.js";

const execGit = promisify(execFile);

type GitRunOptions = { cwd?: string };

type RemoteInfo = {
  remote: string;
  sanitized: string;
  credentialUrl?: URL;
};

type ParsedRemote = {
  host: string;
  path: string;
};

export type RepoResolution = {
  repoRoot: string;
  branch?: string | null;
  remote?: string | null;
  source: "payload_repo_root" | "payload_repo" | "config_default";
};

function gitEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env } as NodeJS.ProcessEnv;
  env.GIT_TERMINAL_PROMPT = "0";
  if (cfg.git.sshKeyPath) {
    env.GIT_SSH_COMMAND = `ssh -i "${cfg.git.sshKeyPath}" -o IdentitiesOnly=yes`;
  }
  return env;
}

export async function runGit(args: string[], options: GitRunOptions = {}) {
  return execGit("git", args, { cwd: options.cwd, env: gitEnv() });
}

function sanitizeSegment(seg: string) {
  return seg.replace(/[^A-Za-z0-9._-]/g, "-");
}

function parseRemote(remote: string): ParsedRemote {
  const trimmed = remote.trim();
  if (!trimmed) throw new Error("Remote URL is empty");

  const sshMatch = /^(?:[^@]+@)?([^:]+):(.+)$/.exec(trimmed);
  if (sshMatch) {
    return {
      host: sshMatch[1],
      path: sshMatch[2].replace(/^\/+/, "")
    };
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
  if (projectHint && projectHint.trim().length) {
    const segments = projectHint
      .split(/[\\/]+/)
      .map(sanitizeSegment)
      .filter(Boolean);
    if (segments.length === 0) segments.push(cfg.defaultRepoName);
    return path.join(cfg.projectBase, ...segments);
  }

  const parsed = parseRemote(remote);
  const rel = parsed.path.replace(/\.git$/i, "");
  const pieces = rel
    .split(/[\\/]+/)
    .map(sanitizeSegment)
    .filter(Boolean);
  if (pieces.length === 0) pieces.push(cfg.defaultRepoName);
  return path.join(cfg.projectBase, sanitizeSegment(parsed.host), ...pieces);
}

function remoteWithCredentials(remote: string): RemoteInfo {
  const sanitized = maskRemote(remote);
  const secret = cfg.git.token || cfg.git.password;
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
    console.warn(`[git] failed to write credentials store: ${(e as Error).message}`);
    return;
  }

  try {
    await runGit(["config", "credential.helper", `store --file=${credentialsPath}`], { cwd: repoRoot });
  } catch (e) {
    console.warn(`[git] failed to configure credential helper: ${(e as Error).message}`);
  }
}

async function detectRemoteDefaultBranch(repoRoot: string): Promise<string | null> {
  try {
    const symbolic = await runGit(["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"], { cwd: repoRoot });
    const ref = symbolic.stdout.trim();
    if (ref.startsWith("refs/remotes/origin/")) {
      return ref.slice("refs/remotes/origin/".length);
    }
    if (ref.length) return ref;
  } catch {}

  try {
    const remoteShow = await runGit(["remote", "show", "origin"], { cwd: repoRoot });
    const line = remoteShow.stdout
      .split(/\r?\n/)
      .map(s => s.trim())
      .find(s => s.toLowerCase().startsWith("head branch:"));
    if (line) {
      const branch = line.split(":" , 2)[1]?.trim();
      if (branch) return branch;
    }
  } catch {}

  return null;
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

function projectHintFromPayload(payload: any): string | null {
  if (!payload || typeof payload !== "object") return null;
  const candidates = [payload.project_slug, payload.project_name, payload.project, payload.projectId, payload.project_id];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim().length) {
      return candidate.trim();
    }
  }
  return null;
}

function repoUrlFromPayload(payload: any): string | null {
  if (!payload || typeof payload !== "object") return null;
  const candidates = [payload.repo, payload.repository, payload.git_url, payload.gitUrl, payload.remote];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim().length) {
      return candidate.trim();
    }
  }
  return null;
}

export async function resolveRepoFromPayload(payload: any): Promise<RepoResolution> {
  if (payload && typeof payload.repo_root === "string" && payload.repo_root.trim().length) {
    return {
      repoRoot: payload.repo_root.trim(),
      branch: branchFromPayload(payload),
      remote: null,
      source: "payload_repo_root"
    };
  }

  const remote = repoUrlFromPayload(payload);

  if (remote) {
    const branch = branchFromPayload(payload);
    const projectHint = projectHintFromPayload(payload);
    const repoRoot = await ensureRepo(remote, branch, projectHint);
    return { repoRoot, branch, remote, source: "payload_repo" };
  }

  await ensureProjectBase();
  return {
    repoRoot: cfg.repoRoot,
    branch: null,
    remote: null,
    source: "config_default"
  };
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
    console.log(`[git] cloning ${displayRemote} -> ${repoRoot}`);
    await runGit(["clone", remoteInfo.remote, repoRoot]);
  } else if (!gitDirExists) {
    throw new Error(`Cannot reuse ${repoRoot}: path exists but is not a git repo`);
  } else {
    console.log(`[git] updating ${displayRemote} in ${repoRoot}`);
    try {
      await runGit(["remote", "set-url", "origin", remoteInfo.sanitized], { cwd: repoRoot });
    } catch {}
    await runGit(["fetch", "--all", "--tags"], { cwd: repoRoot });
  }

  if (remoteInfo.sanitized !== remoteInfo.remote) {
    try {
      await runGit(["remote", "set-url", "origin", remoteInfo.sanitized], { cwd: repoRoot });
    } catch (e) {
      console.warn(`[git] failed to reset origin url: ${(e as Error).message}`);
    }
  }

  await configureCredentialStore(repoRoot, remoteInfo.credentialUrl);

  if (branch) {
    try {
      await runGit(["checkout", branch], { cwd: repoRoot });
    } catch {
      try {
        await runGit(["checkout", "-B", branch, `origin/${branch}`], { cwd: repoRoot });
      } catch (e) {
        console.warn(`[git] failed to checkout branch ${branch}: ${(e as Error).message}`);
      }
    }
    try {
      await runGit(["pull", "--ff-only", "origin", branch], { cwd: repoRoot });
    } catch (e) {
      console.warn(`[git] pull skipped for ${branch}: ${(e as Error).message}`);
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
          console.warn(`[git] default branch checkout failed (${fallback}): ${(e as Error).message}`);
        }
      }
    }
  }

  return repoRoot;
}
