import { describe, it, expect } from 'vitest';
import path from 'path';
import fs from 'fs/promises';
import { gitWorkflowManager } from '../src/git/workflowManager.js';
import { runGit } from '../src/gitUtils.js';
import { makeTempRepo } from './makeTempRepo.js';

describe('GitWorkflowManager', () => {
  it('ensures branch, commits files, reports state, and deletes branch', async () => {
    const repoRoot = await makeTempRepo({
      'src/index.ts': 'export const x = 1\n',
      'README.md': '# Temp Repo\n'
    });

    // Ensure a new feature branch from main
    const branchName = 'feature/wm-test-1';
    const ensured = await gitWorkflowManager.ensureBranch({ repoRoot, branchName, baseBranch: 'main' });
    expect(ensured).toBe(branchName);

    // Verify current branch is the new branch
    const current = await gitWorkflowManager.getCurrentBranch(repoRoot);
    expect(current).toBe(branchName);

    // Add a new file and commit via manager
    const relFile = 'src/new-file.txt';
    await fs.mkdir(path.join(repoRoot, 'src'), { recursive: true });
    await fs.writeFile(path.join(repoRoot, relFile), 'hello world\n', 'utf8');

    // commitFiles should not throw even if push fails (no remote in temp repo)
    await gitWorkflowManager.commitFiles({
      repoRoot,
      files: [relFile],
      message: 'feat: add new-file for wm test',
      branch: branchName,
      // push flag is not used internally (commitAndPushPaths handles push gracefully)
      push: false
    });

    // Verify commit landed on HEAD
    const lastCommit = await runGit(['log', '--oneline', '-1'], { cwd: repoRoot });
    expect(lastCommit.stdout).toMatch(/feat: add new-file for wm test/);

    // Verify file is tracked
    const lsFiles = await runGit(['ls-files', relFile], { cwd: repoRoot });
    expect(lsFiles.stdout.trim()).toBe(relFile);

    // Inspect branch state (no remote in temp repo)
    const state = await gitWorkflowManager.getBranchState(repoRoot);
    expect(state.currentBranch).toBe(branchName);
    expect(state.existsLocally).toBe(true);
    expect(state.existsRemotely).toBe(false);
    expect(state.hasChanges).toBe(false);
    // hasUnpushedCommits only checked when remote exists; should be false here
    expect(state.hasUnpushedCommits).toBe(false);

    // Default branch should be main in temp repos
    const defaultBranch = await gitWorkflowManager.getDefaultBranch(repoRoot);
    expect(defaultBranch).toBe('main');

    // Delete the feature branch; manager will switch away automatically if needed
    await gitWorkflowManager.deleteBranch(repoRoot, branchName, false, true);
    const branchesAfter = await runGit(['branch', '--list', branchName], { cwd: repoRoot });
    expect(branchesAfter.stdout.trim()).toBe('');
  });
});
