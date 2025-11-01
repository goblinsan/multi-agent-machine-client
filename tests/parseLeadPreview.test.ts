import { expect, test } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import { parseUnifiedDiffToEditSpec } from '../src/fileops';

test('parse lead engineer preview into ops', async () => {
  const p = path.join(process.cwd(), 'scripts', 'lead_preview.txt');
  const txt = await fs.readFile(p, 'utf8');
  const spec = parseUnifiedDiffToEditSpec(txt as string);
  expect(spec).toBeDefined();
  expect(Array.isArray(spec.ops)).toBe(true);
  
  const paths = spec.ops.filter(o => (o as any).action === 'upsert').map(o => (o as any).path);
  expect(paths).toContain('README.md');
  expect(paths).toContain('src/App.test.tsx');
  
  const readmeOp = spec.ops.find(o => (o as any).path === 'README.md' && (o as any).action === 'upsert') as any;
  expect(readmeOp).toBeTruthy();
  expect(readmeOp.content).toContain('# Machine Client Log Summarizer');
});
