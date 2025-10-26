import { execFile } from "child_process";
import { promisify } from "util";
import path from "path";
import { cfg } from "../config.js";

const execGit = promisify(execFile);

type GitRunOptions = { cwd?: string };

// Allow tests to override how git is executed without relying on spy semantics on ESM exports
type RunGitImpl = (args: string[], options?: GitRunOptions) => Promise<{ stdout: string; stderr?: string }>;
let runGitImpl: RunGitImpl | null = null;

export function gitEnv(): Record<string, string | undefined> {
  const env = { ...process.env };
  env.GIT_TERMINAL_PROMPT = "0";
  if (cfg.git.sshKeyPath) {
    env.GIT_SSH_COMMAND = `ssh -i "${cfg.git.sshKeyPath}" -o IdentitiesOnly=yes`;
  }
  return env;
}

export async function runGit(args: string[], options: GitRunOptions = {}) {
  if (runGitImpl) return runGitImpl(args, options);
  return execGit("git", args, { cwd: options.cwd, env: gitEnv() });
}

// Test-only hook to override git execution
export function __setRunGitImplForTests(impl?: RunGitImpl | null) {
  runGitImpl = impl || null;
}

export function isWorkspaceRepo(repoRoot: string) {
  try {
    const ws = path.resolve(process.cwd());
    const rr = path.resolve(repoRoot);
    // Treat the current workspace folder as protected (no mutations) unless explicitly allowed
    return rr === ws;
  } catch {
    return false;
  }
}

export function guardWorkspaceMutation(repoRoot: string, op: string) {
  if (isWorkspaceRepo(repoRoot) && !cfg.allowWorkspaceGit) {
    throw new Error(`Workspace git mutation blocked (${op}) at ${repoRoot}. Set MC_ALLOW_WORKSPACE_GIT=1 to override.`);
  }
}
