import fs from "fs/promises";
import path from "path";
import { runGit } from "./gitUtils.js";
import { cfg } from "./config.js";

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
  // Honor configuration: only write diagnostics when explicitly enabled
  try {
    // Lazy import to avoid circulars
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
    // never crash on diagnostics
    return undefined;
  }
}

export { writeDiagnostic };

export async function applyEditOps(jsonText: string, opts: ApplyOptions) {
  const repoRoot = normalizeRoot(opts.repoRoot);
  // Prevent accidental mutations in the developer workspace by default
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
  // Ensure commit message is a single line
  const sanitizedCommitMsg = String(commitMsg).replace(/\s+/g, ' ').trim();

  // NOTE: Caller must ensure they are on the correct branch before calling this function.
  // This function only applies file edits - it does not manage git branches.
  // Branch creation/checkout is now centralized in GitWorkflowManager.

  const changed: string[] = [];
  for (const op of spec.ops) {
    if (!op || typeof op !== 'object' || typeof (op as any).action !== 'string') throw new Error('Bad op object');
    if ((op as any).action === 'upsert') {
      const u = op as UpsertOp;
      if (typeof u.path !== "string") throw new Error("Bad upsert op fields");
      if (!extAllowed(u.path, allowedExts)) throw new Error(`Extension not allowed: ${u.path}`);
      const full = insideRepo(repoRoot, u.path);
      let contentToWrite: string | undefined = u.content;
      // If hunks are provided and the target file exists, try to apply hunks against
      // the on-disk file for a precise patch. If that fails, fall back to provided content
      // or the best-effort reconstruction included in the op.
      if (Array.isArray(u.hunks) && u.hunks.length) {
        try {
          // read existing file if present
          let baseText: string | null = null;
          try { baseText = await fs.readFile(insideRepo(repoRoot, u.path), 'utf8'); } catch (e) { baseText = null; }
          if (baseText !== null) {
            const baseLines = baseText.split(/\r?\n/);
            const applyResult = applyHunksToLines(baseLines, u.hunks);
            if (applyResult.ok) {
              contentToWrite = applyResult.content;
            } else {
              // emit diagnostics so we can inspect real persona outputs in CI
              try {
                await writeDiagnostic(repoRoot, u.path, {
                  reason: 'hunk_context_mismatch',
                  path: u.path,
                  hunks: u.hunks,
                  baseSample: baseLines.slice(0, 50).join('\n')
                });
              } catch (e) {
                // swallow
              }
              // leave contentToWrite as-is (fallback to op.content)
            }
          }
        } catch (err) {
          // ignore hunk-apply errors and fall back
        }
      }
      if (typeof contentToWrite !== 'string') throw new Error("No content available for upsert");
      await upsertFile(full, contentToWrite, maxBytes);
      // Normalize to POSIX-style separators for stability in tests and logs
      changed.push(path.relative(repoRoot, full).replace(/\\/g, '/'));
    } else if ((op as any).action === 'delete') {
      const d = op as DeleteOp;
      if (typeof d.path !== 'string') throw new Error('Bad delete op fields');
      const full = insideRepo(repoRoot, d.path);
      // attempt to remove file if exists
      try { await fs.unlink(full); } catch (err) { /* ignore if not exist */ }
      // mark as changed so commit will capture removal
      changed.push(path.relative(repoRoot, full).replace(/\\/g, '/'));
    } else {
      throw new Error(`Unsupported action: ${(op as any).action}`);
    }
  }

  if (changed.length) {
    // Attempt to add and commit just the changed paths. If the commit fails
    // (for example because files were ignored or add didn't stage them),
    // retry with a force-add for those paths and then commit. Emit a
    // diagnostic if we still cannot commit so the coordinator can surface
    // the failure for debugging.
    try {
      await runGit(["add", ...changed], { cwd: repoRoot });
      // Commit only the changed files to avoid failing due to other unstaged files
      await runGit(["commit", "--no-verify", "-m", sanitizedCommitMsg, "--", ...changed], { cwd: repoRoot });
    } catch (err) {
      try {
        // Retry by force-adding the specific paths (this can override .gitignore)
        await runGit(["add", "--force", ...changed], { cwd: repoRoot });
        await runGit(["commit", "--no-verify", "-m", sanitizedCommitMsg, "--", ...changed], { cwd: repoRoot });
      } catch (err2) {
        // As a last-resort, try a broad add of all changes and commit. This may
        // include unrelated local edits but increases the chance the agent's
        // edits are committed in environments where the index is dirty.
        try {
          await writeDiagnostic(repoRoot, 'apply-commit-broad-attempt.json', { changed, note: 'attempting git add -A and commit as fallback', error: String(err2) });
        } catch (e) { /* ignore */ }
        try {
          await runGit(["add", "-A"], { cwd: repoRoot });
          await runGit(["commit", "--no-verify", "-m", sanitizedCommitMsg], { cwd: repoRoot });
        } catch (err3) {
          // write diagnostic and rethrow so callers can handle the failure
          try { await writeDiagnostic(repoRoot, 'apply-commit-failure.json', { changed, error: String(err3), stdout: (err3 && (err3 as any).stdout) ? String((err3 as any).stdout) : undefined }); } catch (e) { /* swallow */ }
          throw err3;
        }
      }
    }
    const sha = (await runGit(["rev-parse", "HEAD"], { cwd: repoRoot })).stdout.trim();
    
    // Push changes to remote so distributed agents can see them
    // Only push if a remote exists (skip for test repos without remotes)
    try {
      const remotes = await runGit(["remote"], { cwd: repoRoot });
      const hasRemote = remotes.stdout.trim().length > 0;
      
      if (hasRemote) {
        await runGit(["push", "origin", branch, "--force"], { cwd: repoRoot });
      } else {
        // Log warning that no remote exists (typically only in tests)
        try {
          await writeDiagnostic(repoRoot, 'apply-no-remote.json', {
            branch,
            sha,
            changed,
            note: 'No remote configured - skipping push (test environment?)'
          });
        } catch (e) { /* swallow */ }
      }
    } catch (pushErr) {
      // Log push failure but don't fail the operation - caller can retry push
      try {
        await writeDiagnostic(repoRoot, 'apply-push-failure.json', {
          branch,
          sha,
          changed,
          error: String(pushErr)
        });
      } catch (e) { /* swallow */ }
      // Rethrow so workflow knows push failed
      throw new Error(`Failed to push branch ${branch}: ${pushErr}`);
    }
    
    return { changed, branch, sha };
  }
  return { changed: [], branch, sha: "" };
}

// Parse a unified diff (git diff --git style) into an EditSpec suitable for applyEditOps.
// This is a best-effort parser: it reconstructs the new file contents by applying
// hunks and keeping context and added lines while ignoring deletions. It works well
// for new files and many modification hunks where context lines are present.
export function parseUnifiedDiffToEditSpec(diffText: string, opts?: { allowedExts?: string[], warnings?: string[] }) {
  const allowedExts = opts?.allowedExts ?? [".ts",".tsx",".js",".jsx",".py",".md",".json",".yml",".yaml",".css",".html",".sh",".bat",".scss",".less",".txt",".xml",".properties"];
  const warnings: string[] = opts?.warnings || [];
  const ops: Array<UpsertOp | DeleteOp> = [];
  if (!diffText || !diffText.length) return { ops, warnings };
  // Preprocess: try to extract the inner diff if wrapped in fenced code blocks or HTML
  // Examples handled: ```diff ... ```, ``` ... ```, <pre>...</pre>
  let raw = String(diffText);
  // If the raw text already contains a diff marker somewhere, prefer slicing
  // directly at the first 'diff --git' to avoid nested/mismatched fences.
  const rawDiffIdx = raw.indexOf('diff --git');
  if (rawDiffIdx >= 0) raw = raw.slice(rawDiffIdx);
  // extract fenced code block first, but prefer using it only if it contains diff markers
  const fenced = /```(?:diff)?\n([\s\S]*?)```/.exec(raw);
  if (fenced && fenced[1]) {
    const inner = fenced[1];
    if (inner.includes('diff --git') || inner.includes('+++ b/') || inner.includes('@@')) {
      raw = inner;
    }
  }
  // strip HTML pre tags
  const pre = /<pre[^>]*>([\s\S]*?)<\/pre>/.exec(raw);
  if (pre && pre[1]) raw = pre[1];
  // If the text contains some header lines before the first diff, drop them
  const firstIdx = raw.search(/(^|\n)(diff --git |@@ |\+\+\+ b\/)/);
  if (firstIdx >= 0) raw = raw.slice(firstIdx);

  // Split into file sections. Prefer 'diff --git' blocks when present.
  let fileSections: string[] = raw.match(/diff --git[\s\S]*?(?=(?:diff --git|$))/g) || [] as string[];
  // Fallback: some diffs omit 'diff --git' and only include '--- a/...' and '+++ b/...'.
  if (fileSections.length === 0 && /^(?:--- |\+\+\+ |@@ )/m.test(raw)) {
    // Heuristically split by file header lines '--- ' that precede '+++ '
    // and include following hunks until the next header.
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
    // Find the 'a/...' and 'b/...' paths
    const gitLine = lines.find(l => l.startsWith('diff --git')) || '';
    const m = /diff --git a\/(.+?) b\/(.+)$/.exec(gitLine);
    let aPath: string | null = null;
    let bPath: string | null = null;
    for (const l of lines) {
      // tolerate formats like '--- a/path', '--- a/path\t' and also when paths are quoted
      const aMatch = /^---\s+(?:a\/)?(?:"([^"]+)"|([^\t\n]+))/.exec(l);
      const bMatch = /^\+\+\+\s+(?:b\/)?(?:"([^"]+)"|([^\t\n]+))/.exec(l);
      if (aMatch) aPath = (aMatch[1] || aMatch[2] || '').trim();
      if (bMatch) bPath = (bMatch[1] || bMatch[2] || '').trim();
    }
    if (m) {
      aPath = aPath || m[1];
      bPath = bPath || m[2];
    }
    // If bPath is /dev/null, this file was deleted
    const deleted = bPath === '/dev/null' || (bPath && bPath.endsWith('/dev/null'));
    const targetPath = bPath && bPath !== '/dev/null' ? bPath : aPath;
    if (!targetPath) continue;

    // Parse hunks and reconstruct the new file content by applying hunks
    const hunks: Array<{ oldStart:number, oldCount:number, newStart:number, newCount:number, lines: string[] }> = [];
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      // support optional counts: @@ -1 +1 @@ or @@ -1,0 +1,2 @@ etc.
      const h = /^@@\s+-?(\d+)(?:,(\d+))?\s+\+?(\d+)(?:,(\d+))?\s+@@/.exec(line);
      if (h) {
        const oldStart = parseInt(h[1], 10);
        const oldCount = h[2] ? parseInt(h[2], 10) : 1;
        const newStart = parseInt(h[3], 10);
        const newCount = h[4] ? parseInt(h[4], 10) : 1;
        i += 1;
        const hLines: string[] = [];
        while (i < lines.length && !/^@@\s+/.test(lines[i]) && !lines[i].startsWith('diff --git ')) {
          // ignore (no newline at end of file) markers
          if (/^\\ No newline at end of file/.test(lines[i])) { i += 1; continue; }
          hLines.push(lines[i]);
          i += 1;
        }
        hunks.push({ oldStart, oldCount, newStart, newCount, lines: hLines });
        continue;
      }
      i += 1;
    }

    // Filter out files with disallowed extensions before processing
    if (!extAllowed(targetPath, allowedExts)) {
      warnings.push(`Skipped file with disallowed extension: ${targetPath}`);
      continue;
    }

    // If there are no hunks but there are + lines (new file content), capture them
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

    // If any hunk indicates newCount === 0, treat the file as a deletion
    let deletedByHunks = false;
    if (hunks.length && hunks.every(h => h.newCount === 0)) deletedByHunks = true;

    // Apply hunks to build the new content. Since we may not have the original content,
    // we reconstruct by concatenating context and added lines in order of hunks. We try
    // to preserve context lines and ignore deletion-only lines. This is still best-effort
    // but handles multiple hunks per file and optional hunk header formats.
    const outParts: string[] = [];
    for (const h of hunks) {
      for (const hl of h.lines) {
        if (!hl) continue;
        if (hl.startsWith('+')) {
          outParts.push(hl.slice(1));
        } else if (hl.startsWith('-')) {
          // deletion: skip
        } else if (hl.startsWith(' ')) {
          // context lines often start with a space in some diffs
          outParts.push(hl.slice(1));
        } else {
          // fallback: include as-is (covers contexts without leading space)
          outParts.push(hl);
        }
      }
    }
    // Trim trailing empty lines introduced by missing context to make output stable
    let content = outParts.join('\n');
    if (content.length) content = content.replace(/\n+$/,'') + '\n';
    const finalDeleted = deleted || deletedByHunks;
    if (finalDeleted) {
      ops.push({ action: 'delete', path: targetPath });
    } else if (content.length) {
      ops.push({ action: 'upsert', path: targetPath, content });
    }
  }

  // Fallback: if the main parser produced no ops, try a looser scan for 'diff --git' sections
  // and reconstruct files by collecting added lines. This handles some persona outputs
  // that include extra markdown or slightly non-standard formatting.
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
          // Filter out files with disallowed extensions in fallback parser too
          if (!extAllowed(targetPath, allowedExts)) {
            warnings.push(`Skipped file with disallowed extension (fallback parser): ${targetPath}`);
            continue;
          }
          const deleted = bPath === '/dev/null' || (bPath && bPath.endsWith('/dev/null'));
          // collect plus lines (ignore +++ header)
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
    // swallow fallback errors and return original empty ops
  }

  return { ops, warnings } as EditSpec;
}
// Apply hunks to an array of base lines. This is a best-effort but more accurate
// application: for each hunk we validate context lines around the hunk where possible
// and then replace the old-range with the new hunk contents. If any hunk fails
// context validation we return { ok: false } so callers can fallback.
function applyHunksToLines(baseLines: string[], hunks: Hunk[]): { ok: boolean; content?: string } {
  // Work on a mutable copy
  let lines = baseLines.slice();
  // offset tracks the shift in line indices as we modify the lines array
  let offset = 0;
  for (const h of hunks) {
    const oldStartIdx = h.oldStart - 1 + offset;
    const oldCount = h.oldCount;
    // Build the new lines for this hunk from h.lines
    const newLines: string[] = [];
    for (const l of h.lines) {
      if (l.startsWith('+')) newLines.push(l.slice(1));
      else if (l.startsWith('-')) {
        // deletion: skip
      } else if (l.startsWith(' ')) newLines.push(l.slice(1));
      else newLines.push(l);
    }

    // Validate that context lines match where possible. We'll compare the intersection
    // of the old-range in the base with context lines from the hunk (lines starting with ' ')
    const contextLines: { idx:number, text:string }[] = [];
    // h.lines includes context, additions and deletions; build expected old-lines slice
    let scanIdx = h.oldStart - 1;
    for (const l of h.lines) {
      if (l.startsWith(' ') ) {
        contextLines.push({ idx: scanIdx, text: l.slice(1) });
        scanIdx += 1;
      } else if (l.startsWith('-')) {
        // deletion consumes an old line
        scanIdx += 1;
      } else if (l.startsWith('+')) {
        // addition doesn't consume old line
      } else {
        // treat as context
        contextLines.push({ idx: scanIdx, text: l });
        scanIdx += 1;
      }
    }

    for (const c of contextLines) {
      const actualIdx = c.idx + offset;
      if (actualIdx < 0 || actualIdx >= lines.length) {
        // context outside current file; fail
        return { ok: false };
      }
      if (lines[actualIdx] !== c.text) {
        // context mismatch; fail
        return { ok: false };
      }
    }

    // If validation passed, perform the splice: remove oldCount lines at oldStartIdx and insert newLines
    lines.splice(oldStartIdx, oldCount, ...newLines);
    // update offset: newCount - oldCount
    offset += newLines.length - oldCount;
  }

  // Join lines with newline and ensure trailing newline if original had one
  const content = lines.join('\n') + (lines.length ? '\n' : '');
  return { ok: true, content };
}
