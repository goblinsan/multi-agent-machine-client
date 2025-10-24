import type { } from 'node:fs';
import { summarize as summarizeFiles, scanRepo } from '../scanRepo.js';

export type ComponentSpec = {
  base?: string;
  include?: string[];
  exclude?: string[];
};

export interface ContextScanOptions {
  include: string[];
  exclude: string[];
  maxFiles?: number;
  maxBytes?: number;
  maxDepth?: number;
  trackLines?: boolean;
  trackHash?: boolean;
  components?: ComponentSpec[];
}

export interface ContextScanResult {
  snapshot: any;
  ndjson: string;
  summaryMd: string;
  perComp: Array<{ component: string; totals: any; largest: any[]; longest: any[] }>;
  global: { totals: any; largest: any[]; longest: any[] };
  allFiles: any[];
}

/**
 * Scan repository and produce context artifacts (snapshot, ndjson, markdown summary)
 * This is a pure function: no git operations and no file writes.
 */
export async function scanRepositoryForContext(repoRoot: string, opts: ContextScanOptions): Promise<ContextScanResult> {
  const include = opts.include || ['**/*'];
  const exclude = opts.exclude || ['**/.git/**'];
  const max_files = opts.maxFiles ?? 5000;
  const max_bytes = opts.maxBytes ?? 10 * 1024 * 1024; // 10 MB default cap
  const max_depth = opts.maxDepth ?? 128;
  const track_lines = opts.trackLines ?? true;
  const track_hash = opts.trackHash ?? false;

  type Comp = { base: string; include: string[]; exclude: string[] };
  const componentsInput = Array.isArray(opts.components) ? opts.components : null;
  const comps: Comp[] = componentsInput && componentsInput.length
    ? componentsInput.map((c:any)=>({
        base: String(c.base||'').replace(/\\/g,'/'),
        include: (c.include||include),
        exclude: (c.exclude||exclude)
      }))
    : [{ base: '', include, exclude }];

  // Always perform a global scan of the repository for accurate totals
  const globalFiles = await scanRepo({
    repo_root: repoRoot,
    include,
    exclude,
    max_files,
    max_bytes,
    max_depth,
    track_lines,
    track_hash
  });
  const allFiles: any[] = [...globalFiles];
  const perComp: any[] = [];

  // Compute per-component stats by filtering the global files by path prefix
  for (const c of comps) {
    const base = (c.base || '').replace(/^\/+|\/+$/g, '');
    const filtered = base
      ? allFiles.filter(f => f.path === base || f.path.startsWith(base + '/'))
      : allFiles;
    const sum = summarizeFiles(filtered);
    const compName = c.base || '.';
    perComp.push({ component: compName, totals: sum.totals, largest: sum.largest.slice(0,10), longest: sum.longest.slice(0,10) });
  }

  const ndjson = allFiles.map(f => JSON.stringify(f)).join('\n') + '\n';
  const global = summarizeFiles(allFiles);

  const summaryMd = buildScanMarkdown(repoRoot, allFiles, perComp, global);

  const snapshot = {
    repo: repoRoot,
    generated_at: new Date().toISOString(),
    totals: global.totals,
    files: allFiles,
    components: perComp,
    hotspots: { largest_files: global.largest, longest_files: global.longest }
  };

  return { snapshot, ndjson, summaryMd, perComp, global, allFiles };
}

function buildScanMarkdown(repoRoot: string, allFiles: any[], perComp: Array<{ component: string; totals: any; largest: any[]; longest: any[] }>, global: { totals: any; largest: any[]; longest: any[] }): string {
  const lines: string[] = [];
  lines.push('# Context Snapshot (Scan)', '', `Repo: ${repoRoot}`, `Generated: ${new Date().toISOString()}`, '', '## Totals');
  lines.push(`- Files: ${global.totals.files}`, `- Bytes: ${global.totals.bytes}`, `- Lines: ${global.totals.lines}`, '', '## Components');
  for (const pc of perComp) {
    lines.push(`### ${pc.component}`, `- Files: ${pc.totals.files}`, `- Bytes: ${pc.totals.bytes}`, `- Lines: ${pc.totals.lines}`);
    lines.push(`- Largest (top 10):`);
    for (const f of pc.largest) lines.push(`  - ${f.path} (${f.bytes} bytes)`);
    lines.push(`- Longest (top 10):`);
    for (const f of pc.longest) lines.push(`  - ${f.path} (${f.lines || 0} lines)`);
    lines.push('');
  }

  // Add complete file tree organized by directory
  lines.push('## File Tree');
  lines.push('');

  // Group files by directory
  const filesByDir = new Map<string, typeof allFiles>();
  for (const file of allFiles) {
    const dirPath = file.path.includes('/') ? file.path.substring(0, file.path.lastIndexOf('/')) : '.';
    if (!filesByDir.has(dirPath)) {
      filesByDir.set(dirPath, []);
    }
    filesByDir.get(dirPath)!.push(file);
  }

  // Sort directories alphabetically
  const sortedDirs = Array.from(filesByDir.keys()).sort();

  for (const dir of sortedDirs) {
    const files = filesByDir.get(dir)!.sort((a, b) => a.path.localeCompare(b.path));
    lines.push(`### ${dir === '.' ? 'Root' : dir}`);
    lines.push('');
    for (const f of files) {
      const fileName = f.path.includes('/') ? f.path.substring(f.path.lastIndexOf('/') + 1) : f.path;
      const sizeInfo = `${f.bytes} bytes${typeof f.lines === 'number' ? `, ${f.lines} lines` : ''}`;
      lines.push(`- **${fileName}** (${sizeInfo})`);
    }
    lines.push('');
  }

  // Alembic detection
  const alembicFiles = allFiles.filter(f => /(^|\/)alembic(\/|$)/i.test(f.path));
  if (alembicFiles.length) {
    const versions = alembicFiles.filter(f => /(^|\/)alembic(\/|).*\bversions\b(\/|).+\.py$/i.test(f.path));
    const latest = [...versions].sort((a,b)=> (b.mtime||0) - (a.mtime||0)).slice(0, 10);
    lines.push('## Alembic Migrations');
    lines.push(`- Alembic tree detected (files: ${alembicFiles.length}, versions: ${versions.length})`);
    lines.push(versions.length ? '- Latest versions (by modified time):' : '- No versioned migrations found under alembic/versions');
    for (const f of latest) {
      lines.push(`  - ${f.path}  (mtime=${new Date(f.mtime).toISOString()}, bytes=${f.bytes}${typeof f.lines==='number'?`, lines=${f.lines}`:''})`);
    }
    lines.push('');
  }
  return lines.join('\n');
}
