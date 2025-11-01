import { describe, it, expect, beforeEach as _beforeEach, afterEach } from 'vitest';
import { makeTempRepo } from './makeTempRepo.js';
import { isLastCommitContextOnly, hasCommitsSinceLastContextScan } from '../src/git/contextCommitCheck.js';
import { runGit } from '../src/gitUtils.js';
import fs from 'fs/promises';
import path from 'path';

describe('contextCommitCheck', () => {
  let repoRoot: string;

  afterEach(async () => {
    if (repoRoot) {
      try {
        await fs.rm(repoRoot, { recursive: true, force: true });
      } catch (_e) { void 0; }
    }
  });

  describe('isLastCommitContextOnly', () => {
    it('returns true when last commit only has context files', async () => {
      repoRoot = await makeTempRepo();
      
      
      const contextDir = path.join(repoRoot, '.ma', 'context');
      await fs.mkdir(contextDir, { recursive: true });
      await fs.writeFile(path.join(contextDir, 'snapshot.json'), '{}');
      await fs.writeFile(path.join(contextDir, 'summary.md'), '# Summary');
      await fs.writeFile(path.join(contextDir, 'files.ndjson'), '');

      
      await runGit(['add', '.ma/context/'], { cwd: repoRoot });
      await runGit(['commit', '-m', 'context: update'], { cwd: repoRoot });

      const result = await isLastCommitContextOnly(repoRoot);
      expect(result).toBe(true);
    });

    it('returns false when last commit has code files', async () => {
      repoRoot = await makeTempRepo();
      
      
      await fs.writeFile(path.join(repoRoot, 'app.ts'), 'console.log("hello");');
      
      
      await runGit(['add', 'app.ts'], { cwd: repoRoot });
      await runGit(['commit', '-m', 'feat: add app'], { cwd: repoRoot });

      const result = await isLastCommitContextOnly(repoRoot);
      expect(result).toBe(false);
    });

    it('returns false when last commit has both context and code files', async () => {
      repoRoot = await makeTempRepo();
      
      
      const contextDir = path.join(repoRoot, '.ma', 'context');
      await fs.mkdir(contextDir, { recursive: true });
      await fs.writeFile(path.join(contextDir, 'snapshot.json'), '{}');
      
      
      await fs.writeFile(path.join(repoRoot, 'app.ts'), 'console.log("hello");');
      
      
      await runGit(['add', '.'], { cwd: repoRoot });
      await runGit(['commit', '-m', 'feat: add app and context'], { cwd: repoRoot });

      const result = await isLastCommitContextOnly(repoRoot);
      expect(result).toBe(false);
    });

    it('returns true when last commit has no files (empty commit)', async () => {
      repoRoot = await makeTempRepo();
      
      
      await runGit(['commit', '--allow-empty', '-m', 'empty commit'], { cwd: repoRoot });

      const result = await isLastCommitContextOnly(repoRoot);
      expect(result).toBe(true);
    });
  });

  describe('hasCommitsSinceLastContextScan', () => {
    it('returns false when HEAD is the last context commit', async () => {
      repoRoot = await makeTempRepo();
      
      
      const contextDir = path.join(repoRoot, '.ma', 'context');
      await fs.mkdir(contextDir, { recursive: true });
      await fs.writeFile(path.join(contextDir, 'snapshot.json'), '{}');

      
      await runGit(['add', '.ma/context/'], { cwd: repoRoot });
      await runGit(['commit', '-m', 'context: scan'], { cwd: repoRoot });

      const result = await hasCommitsSinceLastContextScan(repoRoot);
      expect(result).toBe(false);
    });

    it('returns true when there are commits after the last context scan', async () => {
      repoRoot = await makeTempRepo();
      
      
      const contextDir = path.join(repoRoot, '.ma', 'context');
      await fs.mkdir(contextDir, { recursive: true });
      await fs.writeFile(path.join(contextDir, 'snapshot.json'), '{}');
      await runGit(['add', '.ma/context/'], { cwd: repoRoot });
      await runGit(['commit', '-m', 'context: scan'], { cwd: repoRoot });

      
      await fs.writeFile(path.join(repoRoot, 'app.ts'), 'console.log("hello");');
      await runGit(['add', 'app.ts'], { cwd: repoRoot });
      await runGit(['commit', '-m', 'feat: add app'], { cwd: repoRoot });

      const result = await hasCommitsSinceLastContextScan(repoRoot);
      expect(result).toBe(true);
    });

    it('returns true when no previous context scan exists', async () => {
      repoRoot = await makeTempRepo();
      
      const result = await hasCommitsSinceLastContextScan(repoRoot);
      expect(result).toBe(true);
    });

    it('returns false after updating context scan', async () => {
      repoRoot = await makeTempRepo();
      
      
      const contextDir = path.join(repoRoot, '.ma', 'context');
      await fs.mkdir(contextDir, { recursive: true });
      await fs.writeFile(path.join(contextDir, 'snapshot.json'), '{"version": 1}');
      await runGit(['add', '.ma/context/'], { cwd: repoRoot });
      await runGit(['commit', '-m', 'context: initial scan'], { cwd: repoRoot });

      
      await fs.writeFile(path.join(repoRoot, 'app.ts'), 'console.log("hello");');
      await runGit(['add', 'app.ts'], { cwd: repoRoot });
      await runGit(['commit', '-m', 'feat: add app'], { cwd: repoRoot });

      
      let result = await hasCommitsSinceLastContextScan(repoRoot);
      expect(result).toBe(true);

      
      await fs.writeFile(path.join(contextDir, 'snapshot.json'), '{"version": 2}');
      await runGit(['add', '.ma/context/'], { cwd: repoRoot });
      await runGit(['commit', '-m', 'context: updated scan'], { cwd: repoRoot });

      
      result = await hasCommitsSinceLastContextScan(repoRoot);
      expect(result).toBe(false);
    });
  });

  describe('integration: scan skip logic', () => {
    it('should skip scan when last commit is context-only and no new commits', async () => {
      repoRoot = await makeTempRepo();
      
      
      const contextDir = path.join(repoRoot, '.ma', 'context');
      await fs.mkdir(contextDir, { recursive: true });
      await fs.writeFile(path.join(contextDir, 'snapshot.json'), '{}');
      await fs.writeFile(path.join(contextDir, 'summary.md'), '# Summary');
      await fs.writeFile(path.join(contextDir, 'files.ndjson'), '');
      await runGit(['add', '.ma/context/'], { cwd: repoRoot });
      await runGit(['commit', '-m', 'context: scan'], { cwd: repoRoot });

      const isContextOnly = await isLastCommitContextOnly(repoRoot);
      const hasNewCommits = await hasCommitsSinceLastContextScan(repoRoot);

      
      expect(isContextOnly).toBe(true);
      expect(hasNewCommits).toBe(false);
    });

    it('should not skip scan when last commit has code changes', async () => {
      repoRoot = await makeTempRepo();
      
      
      const contextDir = path.join(repoRoot, '.ma', 'context');
      await fs.mkdir(contextDir, { recursive: true });
      await fs.writeFile(path.join(contextDir, 'snapshot.json'), '{}');
      await runGit(['add', '.ma/context/'], { cwd: repoRoot });
      await runGit(['commit', '-m', 'context: scan'], { cwd: repoRoot });

      
      await fs.writeFile(path.join(repoRoot, 'app.ts'), 'console.log("hello");');
      await runGit(['add', 'app.ts'], { cwd: repoRoot });
      await runGit(['commit', '-m', 'feat: add app'], { cwd: repoRoot });

      const isContextOnly = await isLastCommitContextOnly(repoRoot);
      const hasNewCommits = await hasCommitsSinceLastContextScan(repoRoot);

      
      expect(isContextOnly).toBe(false);
      expect(hasNewCommits).toBe(true);
    });

    it('should not skip scan when there are new commits after context scan', async () => {
      repoRoot = await makeTempRepo();
      
      
      await fs.writeFile(path.join(repoRoot, 'app.ts'), 'console.log("hello");');
      await runGit(['add', 'app.ts'], { cwd: repoRoot });
      await runGit(['commit', '-m', 'feat: add app'], { cwd: repoRoot });

      
      const contextDir = path.join(repoRoot, '.ma', 'context');
      await fs.mkdir(contextDir, { recursive: true });
      await fs.writeFile(path.join(contextDir, 'snapshot.json'), '{}');
      await runGit(['add', '.ma/context/'], { cwd: repoRoot });
      await runGit(['commit', '-m', 'context: scan'], { cwd: repoRoot });

      
      await fs.writeFile(path.join(repoRoot, 'app.ts'), 'console.log("updated");');
      await runGit(['add', 'app.ts'], { cwd: repoRoot });
      await runGit(['commit', '-m', 'feat: update app'], { cwd: repoRoot });

      const isContextOnly = await isLastCommitContextOnly(repoRoot);
      const hasNewCommits = await hasCommitsSinceLastContextScan(repoRoot);

      
      expect(isContextOnly).toBe(false);
      expect(hasNewCommits).toBe(true);
    });
  });
});
