import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as gitUtils from '../src/gitUtils.js';
import { cfg } from '../src/config.js';
import path from 'path';
import { makeTempRepo } from './makeTempRepo.js';

describe('resolveRepoFromPayload respects PROJECT_BASE and remote URLs', () => {
  const originalProjectBase = cfg.projectBase;
  const tmpBase = path.resolve(process.cwd(), 'tmp-project-base-tests');
  let calls: Array<{ args: string[]; cwd?: string }>;

  beforeEach(async () => {
    // Point PROJECT_BASE to a temp folder for the duration of this test run
    (cfg as any).projectBase = tmpBase;
    (cfg as any).repoRoot = tmpBase;
    await (await import('fs/promises')).mkdir(tmpBase, { recursive: true });
    calls = [];
    gitUtils.__setRunGitImplForTests(async (args, options) => {
      calls.push({ args: [...args], cwd: options?.cwd });
      return { stdout: '' } as any;
    });
  });

  afterEach(async () => {
    (cfg as any).projectBase = originalProjectBase;
    (cfg as any).repoRoot = originalProjectBase;
    try { await (await import('fs/promises')).rm(tmpBase, { recursive: true, force: true }); } catch {}
    gitUtils.__setRunGitImplForTests(null);
  });

  it('clones HTTPS remote under PROJECT_BASE using repoDirectoryFor', async () => {
    const payload = {
      repo: 'https://github.com/goblinsan/machine-client-log-summarizer.git',
      project_name: 'test-repo'
    };

    const res = await gitUtils.resolveRepoFromPayload(payload);
    expect(res.repoRoot).toContain(tmpBase);
    // Ensure path includes a sanitized project hint
    expect(res.repoRoot.replace(/\\/g, '/')).toMatch(/test-repo$/);

    // First call should be clone with cwd=PROJECT_BASE
    const cloneCall = calls.find(c => Array.isArray(c.args) && c.args[0] === 'clone');
    expect(cloneCall?.cwd).toBe(tmpBase);
  });

  it('ignores local filesystem paths as repo remotes and uses PROJECT_BASE + remote', async () => {
    const payload = {
      // This is a local path-looking string; repoUrlFromPayload should ignore it
      repo: 'C:/Users/jamescoghlan/code/machine-client-log-summarizer',
      // Provide the actual remote via repository field
      repository: 'https://github.com/goblinsan/machine-client-log-summarizer.git',
      project_name: 'test-repo'
    };

    const res = await gitUtils.resolveRepoFromPayload(payload);
    expect(res.repoRoot).toContain(tmpBase);
    expect(res.repoRoot.replace(/\\/g, '/')).toMatch(/test-repo$/);

    // Ensure no git command tried to use the local path as remote
    const joined = calls.map(c => c.args.join(' ')).join('\n');
    expect(joined).not.toContain('C:/Users/jamescoghlan/code/machine-client-log-summarizer');
  });

  it('uses local repo when payload.repo points to a valid git repo', async () => {
    const tempRepo = await makeTempRepo();

    const res = await gitUtils.resolveRepoFromPayload({ repo: tempRepo });
    expect(res.repoRoot.replace(/\\/g, '/')).toEqual(tempRepo.replace(/\\/g, '/'));
    // No clone/fetch invoked by resolveRepoFromPayload when using local repo path
    expect(calls.find(c => c.args[0] === 'clone' || c.args[0] === 'fetch')).toBeUndefined();
  });
});
