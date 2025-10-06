import { describe, it, expect } from 'vitest'
import fs from 'fs/promises'
import path from 'path'
import os from 'os'
import { applyEditOps } from '../src/fileops'

// util to create a temp git repo similar to other tests
async function makeRepo() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mc-repo-'))
  await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: 'tmp' }))
  // init git
  // run git commands using child_process.execSync to keep test simple and deterministic
  const child = await import('child_process')
  const execSync = child.execSync;
  execSync('git init -b main', { cwd: dir });
  execSync('git add .', { cwd: dir });
  execSync('git commit -m init', { cwd: dir });
  return dir;
}

describe('applyEditOps hunks application', () => {
  it('applies hunks to an existing file when context matches', async () => {
    const repo = await makeRepo();
    const target = path.join(repo, 'src');
    await fs.mkdir(target, { recursive: true });
    const filePath = path.join(target, 'file.js');
    const base = "line1\nline2-old\nline3\n";
    await fs.writeFile(filePath, base, 'utf8');
    // commit base file
  const child = await import('child_process')
  child.execSync('git add . && git commit -m base', { cwd: repo });

    const editSpec = {
      ops: [
        {
          action: 'upsert',
          path: 'src/file.js',
          hunks: [
            { oldStart: 1, oldCount: 3, newStart: 1, newCount: 3, lines: [" line1","-line2-old","+line2-new"," line3"] }
          ]
        }
      ]
    };

    const res = await applyEditOps(JSON.stringify(editSpec), { repoRoot: repo, branchName: 'feat/test-hunks', commitMessage: 'apply hunks' });
    expect(res.changed && res.changed.includes('src/file.js')).toBeTruthy();
    // verify content on disk
    const out = await fs.readFile(filePath, 'utf8');
    expect(out).toContain('line2-new');
  });

  it('falls back to provided content if context mismatch', async () => {
    const repo = await makeRepo();
    const target = path.join(repo, 'src');
    await fs.mkdir(target, { recursive: true });
    const filePath = path.join(target, 'file2.js');
    const base = "THIS_DOES_NOT_MATCH\n";
    await fs.writeFile(filePath, base, 'utf8');
  const child = await import('child_process')
  child.execSync('git add . && git commit -m base', { cwd: repo });

    const editSpec = {
      ops: [
        {
          action: 'upsert',
          path: 'src/file2.js',
          content: 'fallback-content\n',
          hunks: [
            { oldStart: 1, oldCount: 1, newStart: 1, newCount: 1, lines: [" line1","-line-old","+line-new"] }
          ]
        }
      ]
    };

    const res = await applyEditOps(JSON.stringify(editSpec), { repoRoot: repo, branchName: 'feat/test-hunks-2', commitMessage: 'apply hunks' });
    expect(res.changed && res.changed.includes('src/file2.js')).toBeTruthy();
    const out = await fs.readFile(filePath, 'utf8');
    expect(out).toBe('fallback-content\n');
    // diagnostics should have been written into outputs/diagnostics
    const diagDir = path.join(repo, 'outputs', 'diagnostics');
    const diags = await fs.readdir(diagDir).catch(() => []);
    expect(diags.length).toBeGreaterThan(0);
    // read the first diagnostic and assert it mentions hunk_context_mismatch
    const first = diags[0];
    const data = JSON.parse(await fs.readFile(path.join(diagDir, first), 'utf8'));
    expect(data.reason).toBe('hunk_context_mismatch');
  })
})
