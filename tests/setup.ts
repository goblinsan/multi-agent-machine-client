import os from 'os';
import path from 'path';
import fs from 'fs';
import { execSync } from 'child_process';
import { beforeEach, afterEach, afterAll } from 'vitest';

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
});
