import fs from "fs/promises";
import path from "path";
import { runGit } from "./gitUtils.js";
import { cfg } from "./config.js";
import { logger } from "./logger.js";

export type Hunk = { oldStart:number, oldCount:number, newStart:number, newCount:number, lines: string[] };
export type UpsertOp = { action: "upsert"; path: string; content?: string; hunks?: Hunk[] };
export type DeleteOp = { action: "delete"; path: string };
export type EditSpec = { ops: Array<UpsertOp | DeleteOp>; warnings?: string[] };

export type ApplyOptions = {
  repoRoot: string;
  maxBytes?: number;
  allowedExts?: string[];
  branchName?: string;
  commitMessage?: string;
};

function normalizeRoot(p: string) { return path.resolve(p); }

function insideRepo(repoRoot: string, relPath: string) {
  const full = path.resolve(repoRoot, relPath);
  const normRoot = repoRoot.endsWith(path.sep) ? repoRoot : repoRoot + path.sep;
  if (!full.startsWith(normRoot)) throw new Error(`Path escapes repo: ${relPath}`);
  return full;
}

function extAllowed(p: string, allowed: string[]) {
  const ext = path.extname(p).toLowerCase();
  return allowed.length === 0 || allowed.includes(ext);
}

async function upsertFile(fullPath: string, content: string, maxBytes: number) {
  const buf = Buffer.from(content, "utf8");
  if (buf.byteLength > maxBytes) throw new Error(`File too large: ${fullPath} (${buf.byteLength} > ${maxBytes})`);
  await fs.mkdir(path.dirname(fullPath), { recursive: true });
  const tmp = fullPath + ".tmp";
  await fs.writeFile(tmp, buf);
  await fs.rename(tmp, fullPath);
}

async function writeDiagnostic(repoRoot: string, targetPath: string, payload: any) {
  
  try {
    
    const { cfg } = await import('./config.js');
    if (!cfg.writeDiagnostics) return undefined;
    const outDir = path.join(repoRoot, 'outputs', 'diagnostics');
    await fs.mkdir(outDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const safe = targetPath.replace(/[^a-zA-Z0-9_.-]/g, '_');
    const file = path.join(outDir, `${stamp}-${safe}.json`);
    await fs.writeFile(file, JSON.stringify(payload, null, 2), 'utf8');
    return file;
  } catch (err) {
    
    return undefined;
  }
}

export { writeDiagnostic };

export async function applyEditOps(jsonText: string, opts: ApplyOptions) {
  const repoRoot = normalizeRoot(opts.repoRoot);
  
  if (repoRoot === process.cwd() && !cfg.allowWorkspaceGit) {
    throw new Error(`Workspace git mutation blocked (applyEditOps) at ${repoRoot}. Set MC_ALLOW_WORKSPACE_GIT=1 to override.`);
  }
  const maxBytes = opts.maxBytes ?? 512 * 1024;
  const allowedExts = opts.allowedExts ?? [".ts",".tsx",".js",".jsx",".py",".md",".json",".yml",".yaml",".css",".html",".sh",".bat"];

  let spec: EditSpec;
  try { spec = JSON.parse(jsonText); } catch { throw new Error("Invalid JSON from model (expected edit spec)"); }
  if (!spec?.ops || !Array.isArray(spec.ops)) throw new Error("Edit spec missing ops[]");

  const branch = opts.branchName || "feat/agent-edit";
  const commitMsg = opts.commitMessage || "agent: apply edits";
  
  const sanitizedCommitMsg = String(commitMsg).replace(/\s+/g, ' ').trim();

  
  
  

  const changed: string[] = [];
  for (const op of spec.ops) {
    if (!op || typeof op !== 'object' || typeof (op as any).action !== 'string') throw new Error('Bad op object');
    if ((op as any).action === 'upsert') {
      const u = op as UpsertOp;
      if (typeof u.path !== "string") throw new Error("Bad upsert op fields");
      if (!extAllowed(u.path, allowedExts)) throw new Error(`Extension not allowed: ${u.path}`);
      const full = insideRepo(repoRoot, u.path);
      let contentToWrite: string | undefined = u.content;
      
      
      
      if (Array.isArray(u.hunks) && u.hunks.length) {
        try {
          
          let baseText: string | null = null;
          try { baseText = await fs.readFile(insideRepo(repoRoot, u.path), 'utf8'); } catch (e) { baseText = null; }
          if (baseText !== null) {
            const baseLines = baseText.split(/\r?\n/);
            const applyResult = applyHunksToLines(baseLines, u.hunks);
            if (applyResult.ok) {
              contentToWrite = applyResult.content;
            } else {
              
              try {
                await writeDiagnostic(repoRoot, u.path, {
                  reason: 'hunk_context_mismatch',
                  path: u.path,
                  hunks: u.hunks,
                  baseSample: baseLines.slice(0, 50).join('\n')
                });
              } catch (e) {
                logger.warn('Failed to write diagnostic for hunk context mismatch', { path: u.path, error: String(e) });
              }
              
            }
          }
        } catch (err) {
          logger.error('Failed to read or apply diff hunks', { path: u.path, error: String(err) });
          throw err;
        }
      }
      if (typeof contentToWrite !== 'string') throw new Error("No content available for upsert");
      await upsertFile(full, contentToWrite, maxBytes);
      
      changed.push(path.relative(repoRoot, full).replace(/\\/g, '/'));
    } else if ((op as any).action === 'delete') {
      const d = op as DeleteOp;
      if (typeof d.path !== 'string') throw new Error('Bad delete op fields');
      const full = insideRepo(repoRoot, d.path);
      
      try { 
        await fs.unlink(full); 
      } catch (err) {
        logger.debug('Failed to delete file (may not exist)', { path: d.path, error: String(err) });
      }
      
      changed.push(path.relative(repoRoot, full).replace(/\\/g, '/'));
    } else {
      throw new Error(`Unsupported action: ${(op as any).action}`);
    }
  }

  if (changed.length) {
    
    
    
    
    
    try {
      await runGit(["add", ...changed], { cwd: repoRoot });
      
      await runGit(["commit", "--no-verify", "-m", sanitizedCommitMsg, "--", ...changed], { cwd: repoRoot });
    } catch (err) {
      try {
        
        await runGit(["add", "--force", ...changed], { cwd: repoRoot });
        await runGit(["commit", "--no-verify", "-m", sanitizedCommitMsg, "--", ...changed], { cwd: repoRoot });
      } catch (err2) {
        
        
        
        try {
          await writeDiagnostic(repoRoot, 'apply-commit-broad-attempt.json', { changed, note: 'attempting git add -A and commit as fallback', error: String(err2) });
        } catch (e) {
          logger.warn('Failed to write diagnostic for commit broad attempt', { error: String(e) });
        }
        try {
          await runGit(["add", "-A"], { cwd: repoRoot });
          await runGit(["commit", "--no-verify", "-m", sanitizedCommitMsg], { cwd: repoRoot });
        } catch (err3) {
          logger.error('Final commit attempt failed', { changed, error: String(err3) });
          try { 
            await writeDiagnostic(repoRoot, 'apply-commit-failure.json', { changed, error: String(err3), stdout: (err3 && (err3 as any).stdout) ? String((err3 as any).stdout) : undefined }); 
          } catch (e) {
            logger.warn('Failed to write diagnostic for commit failure', { error: String(e) });
          }
          throw err3;
        }
      }
    }
    const sha = (await runGit(["rev-parse", "HEAD"], { cwd: repoRoot })).stdout.trim();
    
    
    
    try {
      const remotes = await runGit(["remote"], { cwd: repoRoot });
      const hasRemote = remotes.stdout.trim().length > 0;
      
      if (hasRemote) {
        await runGit(["push", "origin", branch, "--force"], { cwd: repoRoot });
      } else {
        
        try {
          await writeDiagnostic(repoRoot, 'apply-no-remote.json', {
            branch,
            sha,
            changed,
            note: 'No remote configured - skipping push (test environment?)'
          });
        } catch (e) {
          logger.debug('Failed to write diagnostic for no-remote', { repoRoot, error: String(e) });
        }
      }
    } catch (pushErr) {
      
      try {
        await writeDiagnostic(repoRoot, 'apply-push-failure.json', {
          branch,
          sha,
          changed,
          error: String(pushErr)
        });
      } catch (e) {
        logger.debug('Failed to write diagnostic for push-failure', { repoRoot, error: String(e) });
      }
      
      throw new Error(`Failed to push branch ${branch}: ${pushErr}`);
    }
    
    return { changed, branch, sha };
  }
  return { changed: [], branch, sha: "" };
}





export function parseUnifiedDiffToEditSpec(diffText: string, opts?: { allowedExts?: string[], warnings?: string[] }) {
  const allowedExts = opts?.allowedExts ?? [".ts",".tsx",".js",".jsx",".py",".md",".json",".yml",".yaml",".css",".html",".sh",".bat",".scss",".less",".txt",".xml",".properties"];
  const warnings: string[] = opts?.warnings || [];
  const ops: Array<UpsertOp | DeleteOp> = [];
  if (!diffText || !diffText.length) return { ops, warnings };
  
  
  let raw = String(diffText);
  
  
  const rawDiffIdx = raw.indexOf('diff --git');
  if (rawDiffIdx >= 0) raw = raw.slice(rawDiffIdx);
  
  const fenced = /```(?:diff)?\n([\s\S]*?)```/.exec(raw);
  if (fenced && fenced[1]) {
    const inner = fenced[1];
    if (inner.includes('diff --git') || inner.includes('+++ b/') || inner.includes('@@')) {
      raw = inner;
    }
  }
  
  const pre = /<pre[^>]*>([\s\S]*?)<\/pre>/.exec(raw);
  if (pre && pre[1]) raw = pre[1];
  
  const firstIdx = raw.search(/(^|\n)(diff --git |@@ |\+\+\+ b\/)/);
  if (firstIdx >= 0) raw = raw.slice(firstIdx);

  
  let fileSections: string[] = raw.match(/diff --git[\s\S]*?(?=(?:diff --git|$))/g) || [] as string[];
  
  if (fileSections.length === 0 && /^(?:--- |\+\+\+ |@@ )/m.test(raw)) {
    
    
    const headerless: string[] = [];
    const parts = raw.split(/(?=^---\s+)/m);
    for (const part of parts) {
      if (!/\+\+\+\s+/.test(part)) continue;
      headerless.push(part);
    }
  if (headerless.length) fileSections = headerless;
  }
  for (const section of fileSections) {
    const lines = section.split(/\r?\n/);
    
    const gitLine = lines.find(l => l.startsWith('diff --git')) || '';
    const m = /diff --git a\/(.+?) b\/(.+)$/.exec(gitLine);
    let aPath: string | null = null;
    let bPath: string | null = null;
    for (const l of lines) {
      
      const aMatch = /^---\s+(?:a\/)?(?:"([^"]+)"|([^\t\n]+))/.exec(l);
      const bMatch = /^\+\+\+\s+(?:b\/)?(?:"([^"]+)"|([^\t\n]+))/.exec(l);
      if (aMatch) aPath = (aMatch[1] || aMatch[2] || '').trim();
      if (bMatch) bPath = (bMatch[1] || bMatch[2] || '').trim();
    }
    if (m) {
      aPath = aPath || m[1];
      bPath = bPath || m[2];
    }
    
    const deleted = bPath === '/dev/null' || (bPath && bPath.endsWith('/dev/null'));
    const targetPath = bPath && bPath !== '/dev/null' ? bPath : aPath;
    if (!targetPath) continue;

    
    const hunks: Array<{ oldStart:number, oldCount:number, newStart:number, newCount:number, lines: string[] }> = [];
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      
      const h = /^@@\s+-?(\d+)(?:,(\d+))?\s+\+?(\d+)(?:,(\d+))?\s+@@/.exec(line);
      if (h) {
        const oldStart = parseInt(h[1], 10);
        const oldCount = h[2] ? parseInt(h[2], 10) : 1;
        const newStart = parseInt(h[3], 10);
        const newCount = h[4] ? parseInt(h[4], 10) : 1;
        i += 1;
        const hLines: string[] = [];
        while (i < lines.length && !/^@@\s+/.test(lines[i]) && !lines[i].startsWith('diff --git ')) {
          
          if (/^\\ No newline at end of file/.test(lines[i])) { i += 1; continue; }
          hLines.push(lines[i]);
          i += 1;
        }
        hunks.push({ oldStart, oldCount, newStart, newCount, lines: hLines });
        continue;
      }
      i += 1;
    }

    
    if (!extAllowed(targetPath, allowedExts)) {
      warnings.push(`Skipped file with disallowed extension: ${targetPath}`);
      continue;
    }

    
    if (!hunks.length) {
      const plusLines = lines.filter(l => l.startsWith('+') && !l.startsWith('+++')).map(l => l.slice(1));
      if (plusLines.length) {
        const content = plusLines.join('\n') + '\n';
        if (deleted) {
          ops.push({ action: 'delete', path: targetPath });
        } else {
          ops.push({ action: 'upsert', path: targetPath, content });
        }
      } else if (deleted) {
        ops.push({ action: 'delete', path: targetPath });
      }
      continue;
    }

    
    let deletedByHunks = false;
    if (hunks.length && hunks.every(h => h.newCount === 0)) deletedByHunks = true;

    
    
    
    
    const outParts: string[] = [];
    for (const h of hunks) {
      for (const hl of h.lines) {
        if (!hl) continue;
        if (hl.startsWith('+')) {
          outParts.push(hl.slice(1));
        } else if (hl.startsWith(' ')) {
          outParts.push(hl.slice(1));
        } else if (!hl.startsWith('-')) {
          outParts.push(hl);
        }
      }
    }
    
    let content = outParts.join('\n');
    if (content.length) content = content.replace(/\n+$/,'') + '\n';
    const finalDeleted = deleted || deletedByHunks;
    if (finalDeleted) {
      ops.push({ action: 'delete', path: targetPath });
    } else if (content.length) {
      ops.push({ action: 'upsert', path: targetPath, content });
    }
  }

  
  
  
  try {
    if (ops.length === 0) {
      const fallbackOps: Array<UpsertOp | DeleteOp> = [];
  const sections = raw.match(/diff --git[\s\S]*?(?=(?:diff --git|$))/g);
      if (sections && sections.length) {
        for (const sec of sections) {
          const lines = sec.split(/\r?\n/);
          let aPath: string | null = null;
          let bPath: string | null = null;
          for (const l of lines) {
            const aMatch = /^---\s+(?:a\/)?(?:"([^"]+)"|([^\t\n]+))/.exec(l);
            const bMatch = /^\+\+\+\s+(?:b\/)?(?:"([^"]+)"|([^\t\n]+))/.exec(l);
            if (aMatch) aPath = (aMatch[1] || aMatch[2] || '').trim();
            if (bMatch) bPath = (bMatch[1] || bMatch[2] || '').trim();
          }
          const targetPath = bPath && bPath !== '/dev/null' ? bPath : aPath;
          if (!targetPath) continue;
          
          if (!extAllowed(targetPath, allowedExts)) {
            warnings.push(`Skipped file with disallowed extension (fallback parser): ${targetPath}`);
            continue;
          }
          const deleted = bPath === '/dev/null' || (bPath && bPath.endsWith('/dev/null'));
          
          const plusLines = lines.filter((l: string) => l.startsWith('+') && !l.startsWith('+++')).map(l => l.slice(1));
          if (deleted) {
            fallbackOps.push({ action: 'delete', path: targetPath });
          } else if (plusLines.length) {
            let content = plusLines.join('\n');
            if (content.length) content = content.replace(/\n+$/,'') + '\n';
            fallbackOps.push({ action: 'upsert', path: targetPath, content });
          }
        }
      }
      if (fallbackOps.length) return { ops: fallbackOps, warnings } as EditSpec;
    }
  } catch (err) {
    logger.warn('Error parsing edit spec, returning partial ops', { error: String(err), opsCount: ops.length });
  }

  return { ops, warnings } as EditSpec;
}




function applyHunksToLines(baseLines: string[], hunks: Hunk[]): { ok: boolean; content?: string } {
  
  let lines = baseLines.slice();
  
  let offset = 0;
  for (const h of hunks) {
    const oldStartIdx = h.oldStart - 1 + offset;
    const oldCount = h.oldCount;
    
    const newLines: string[] = [];
    for (const l of h.lines) {
      if (l.startsWith('+')) newLines.push(l.slice(1));
      else if (l.startsWith(' ')) newLines.push(l.slice(1));
      else if (!l.startsWith('-')) newLines.push(l);
    }

    
    
    const contextLines: { idx:number, text:string }[] = [];
    
    let scanIdx = h.oldStart - 1;
    for (const l of h.lines) {
      if (l.startsWith(' ') ) {
        contextLines.push({ idx: scanIdx, text: l.slice(1) });
        scanIdx += 1;
      } else if (l.startsWith('-')) {
        scanIdx += 1;
      } else if (!l.startsWith('+')) {
        contextLines.push({ idx: scanIdx, text: l });
        scanIdx += 1;
      }
    }

    for (const c of contextLines) {
      const actualIdx = c.idx + offset;
      if (actualIdx < 0 || actualIdx >= lines.length) {
        
        return { ok: false };
      }
      if (lines[actualIdx] !== c.text) {
        
        return { ok: false };
      }
    }

    
    lines.splice(oldStartIdx, oldCount, ...newLines);
    
    offset += newLines.length - oldCount;
  }

  
  const content = lines.join('\n') + (lines.length ? '\n' : '');
  return { ok: true, content };
}
