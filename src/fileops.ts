import fs from "fs/promises";
import path from "path";
import { runGit } from "./gitUtils.js";

export type UpsertOp = { action: "upsert"; path: string; content: string };
export type EditSpec = { ops: UpsertOp[] };

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

export async function applyEditOps(jsonText: string, opts: ApplyOptions) {
  const repoRoot = normalizeRoot(opts.repoRoot);
  const maxBytes = opts.maxBytes ?? 512 * 1024;
  const allowedExts = opts.allowedExts ?? [".ts",".tsx",".js",".jsx",".py",".md",".json",".yml",".yaml",".css",".html",".sh",".bat"];

  let spec: EditSpec;
  try { spec = JSON.parse(jsonText); } catch { throw new Error("Invalid JSON from model (expected edit spec)"); }
  if (!spec?.ops || !Array.isArray(spec.ops)) throw new Error("Edit spec missing ops[]");

  const branch = opts.branchName || "feat/agent-edit";
  const commitMsg = opts.commitMessage || "agent: apply edits";

  await runGit(["checkout", "-B", branch], { cwd: repoRoot });

  const changed: string[] = [];
  for (const op of spec.ops) {
    if (op.action !== "upsert") throw new Error(`Unsupported action: ${op.action}`);
    if (typeof op.path !== "string" || typeof op.content !== "string") throw new Error("Bad op fields");
    if (!extAllowed(op.path, allowedExts)) throw new Error(`Extension not allowed: ${op.path}`);
    const full = insideRepo(repoRoot, op.path);
    await upsertFile(full, op.content, maxBytes);
    changed.push(path.relative(repoRoot, full));
  }

  if (changed.length) {
    await runGit(["add", ...changed], { cwd: repoRoot });
    await runGit(["commit", "-m", commitMsg], { cwd: repoRoot });
    const sha = (await runGit(["rev-parse", "HEAD"], { cwd: repoRoot })).stdout.trim();
    return { changed, branch, sha };
  }
  return { changed: [], branch, sha: "" };
}
