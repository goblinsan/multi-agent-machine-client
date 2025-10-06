import os from 'os';
import path from 'path';
import fs from 'fs';
import { execSync } from 'child_process';
import { beforeEach, afterEach, afterAll, vi } from 'vitest';
import * as childProcess from 'child_process';

function safeGit(cmd: string): string | null {
  try {
    return execSync(cmd, { stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
  } catch {
    return null;
  }
}

function isGitRepo(): boolean {
  const res = safeGit('git rev-parse --is-inside-work-tree');
  return res === 'true';
}

function currentBranch(): string | null {
  return safeGit('git rev-parse --abbrev-ref HEAD');
}

// Create an isolated PROJECT_BASE for any repo operations during tests
const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-tests-'));
process.env.PROJECT_BASE = tmpBase;

const originalWasRepo = isGitRepo();
const originalBranch = originalWasRepo ? (currentBranch() || null) : null;
let branchBeforeEach: string | null = null;

beforeEach(() => {
  if (originalWasRepo) branchBeforeEach = currentBranch();
});

afterEach(() => {
  if (!originalWasRepo) return;
  const now = currentBranch();
  if (branchBeforeEach && now && branchBeforeEach !== now) {
    // Try to restore to the branch active before this test started
    safeGit(`git checkout ${branchBeforeEach}`);
  }
});

afterAll(() => {
  if (originalWasRepo && originalBranch) {
    const now = currentBranch();
    if (now !== originalBranch) {
      safeGit(`git checkout ${originalBranch}`);
    }
  }
  // Clean up PROJECT_BASE tmp directory for CI hygiene
  try {
    fs.rmSync(tmpBase, { recursive: true, force: true });
  } catch {}
});

// Guard: prevent git commands from running outside tmp directories during tests
const origExec = childProcess.exec;
const origExecSync = childProcess.execSync;
const origSpawn = childProcess.spawn;
const origSpawnSync = childProcess.spawnSync;

function ensureTmpCwd(opts?: any) {
  // Only enforce when an explicit cwd is provided (to avoid false positives)
  const cwd = opts && typeof opts === 'object' && 'cwd' in opts ? (opts.cwd || '') : '';
  if (!cwd) return; // no explicit cwd passed, skip guard
  const allowed = String(cwd).startsWith(os.tmpdir());
  if (!allowed) {
    throw new Error(`Test guard: git command attempted outside tmp dir. cwd=${cwd}`);
  }
}

// Install spies once per test worker
try {
  // exec
  // @ts-ignore
  if (!vi.isMockFunction((childProcess as any).exec)) {
    vi.spyOn(childProcess as any, 'exec').mockImplementation((...args: any[]) => {
      const command = args[0];
      const options = args[1];
      if (typeof command === 'string' && /\bgit\b/.test(command)) ensureTmpCwd(options);
      return (origExec as any).apply(childProcess, args);
    });
  }
  // execSync
  // @ts-ignore
  if (!vi.isMockFunction((childProcess as any).execSync)) {
    vi.spyOn(childProcess as any, 'execSync').mockImplementation((...args: any[]) => {
      const command = args[0];
      const options = args[1];
      if (typeof command === 'string' && /\bgit\b/.test(command)) ensureTmpCwd(options);
      return (origExecSync as any).apply(childProcess, args);
    });
  }
  // spawn
  // @ts-ignore
  if (!vi.isMockFunction((childProcess as any).spawn)) {
    vi.spyOn(childProcess as any, 'spawn').mockImplementation((...args: any[]) => {
      const command = args[0];
      const options = args[2];
      if (command === 'git') ensureTmpCwd(options);
      return (origSpawn as any).apply(childProcess, args);
    });
  }
  // spawnSync
  // @ts-ignore
  if (!vi.isMockFunction((childProcess as any).spawnSync)) {
    vi.spyOn(childProcess as any, 'spawnSync').mockImplementation((...args: any[]) => {
      const command = args[0];
      const options = args[2];
      if (command === 'git') ensureTmpCwd(options);
      return (origSpawnSync as any).apply(childProcess, args);
    });
  }
} catch (e) {
  // If spying fails for any reason, continue without the global guard.
}
