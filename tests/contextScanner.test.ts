import { describe, it, expect } from 'vitest';
import path from 'path';
import fs from 'fs/promises';
import { makeTempRepo } from './makeTempRepo.js';
import { scanRepositoryForContext } from '../src/git/contextScanner.js';

describe('ContextScanner', () => {
  it('scans repo and produces snapshot, ndjson, and markdown summary with components', async () => {
    const repoRoot = await makeTempRepo({
      'README.md': '# Project\nSome docs here.\n',
      'src/a.ts': 'export function a() { return 1; }\n',
      'tests/b.test.ts': 'import { a } from "../src/a"; test("a", ()=>{ expect(a()).toBe(1); });\n',
      'alembic/versions/001_init.py': '# migration\nprint("init")\n'
    });

    const result = await scanRepositoryForContext(repoRoot, {
      include: ['**/*'],
      exclude: ['**/.git/**'],
      components: [
        { base: 'src' },
        { base: 'tests' }
      ],
      maxFiles: 1000,
      maxBytes: 5 * 1024 * 1024,
      maxDepth: 32,
      trackLines: true,
      trackHash: false
    });

    // Basic structure checks
    expect(result.snapshot).toBeTruthy();
    expect(result.snapshot.repo).toBe(repoRoot);
    expect(typeof result.ndjson).toBe('string');
    expect(typeof result.summaryMd).toBe('string');
    expect(Array.isArray(result.allFiles)).toBe(true);

    // Totals should match file count (README, src/a.ts, tests/b.test.ts, alembic/versions/001_init.py)
    const expectedFileCount = 4;
    expect(result.snapshot.totals.files).toBe(expectedFileCount);
    const ndjsonLines = result.ndjson.split('\n').filter(Boolean);
    expect(ndjsonLines.length).toBe(expectedFileCount);

    // Components should include src and tests with 1 file each
    const compNames = result.perComp.map(c => c.component);
    expect(compNames).toContain('src');
    expect(compNames).toContain('tests');
    const srcComp = result.perComp.find(c => c.component === 'src');
    const testsComp = result.perComp.find(c => c.component === 'tests');
    expect(srcComp?.totals.files).toBe(1);
    expect(testsComp?.totals.files).toBe(1);

    // Markdown should contain header, file tree, and Alembic section
    expect(result.summaryMd).toMatch(/^# Context Snapshot \(Scan\)/);
    expect(result.summaryMd).toContain('## File Tree');
    expect(result.summaryMd).toContain('alembic');
    expect(result.summaryMd).toContain('## Alembic Migrations');
  });
});
