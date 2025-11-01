import fs from "fs/promises";
import path from "path";
import crypto from "crypto";
import { Minimatch } from "minimatch";
import { logger } from "./logger.js";

export type ScanSpec = {
  repo_root: string;
  include: string[];
  exclude: string[];
  max_files: number;
  max_bytes: number;
  max_depth: number;
  track_lines: boolean;
  track_hash: boolean;
};

export type FileInfo = {
  path: string;
  bytes: number;
  lines?: number;
  sha1?: string;
  mtime: number;
};

export async function scanRepo(spec: ScanSpec): Promise<FileInfo[]> {
  const root = path.resolve(spec.repo_root);
  const inc = spec.include.map((p) => new Minimatch(p, { dot: true }));
  const exc = spec.exclude.map((p) => new Minimatch(p, { dot: true }));
  const results: FileInfo[] = [];
  let bytesSeen = 0;

  async function walk(dir: string, depth: number) {
    if (depth > spec.max_depth) return;
    let ents: any[] = [];
    try {
      ents = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of ents) {
      const abs = path.join(dir, e.name);
      const rel = path.relative(root, abs);
      const relUnix = rel.split(path.sep).join("/");
      if (rel.startsWith("..")) continue;
      if (exc.some((m) => m.match(relUnix))) continue;

      if (e.isDirectory()) {
        await walk(abs, depth + 1);
      } else {
        if (!inc.some((m) => m.match(relUnix))) continue;
        let stat;
        try {
          stat = await fs.stat(abs);
        } catch {
          continue;
        }
        bytesSeen += stat.size;
        if (results.length >= spec.max_files || bytesSeen > spec.max_bytes)
          return;
        const fi: FileInfo = {
          path: relUnix,
          bytes: stat.size,
          mtime: stat.mtimeMs,
        };
        if (spec.track_lines && stat.size < 5_000_000) {
          try {
            const txt = await fs.readFile(abs, "utf8");
            fi.lines = txt.split(/\r?\n/).length;
            if (spec.track_hash)
              fi.sha1 = crypto.createHash("sha1").update(txt).digest("hex");
          } catch (e) {
            logger.debug("Failed to read file for scanning", {
              path: rel,
              error: String(e),
            });
          }
        }
        results.push(fi);
      }
    }
  }

  await walk(root, 0);
  return results;
}

export function summarize(files: FileInfo[]) {
  const totals = files.reduce(
    (a, f) => ({
      files: a.files + 1,
      bytes: a.bytes + f.bytes,
      lines: a.lines + (f.lines || 0),
    }),
    { files: 0, bytes: 0, lines: 0 },
  );
  const largest = [...files].sort((a, b) => b.bytes - a.bytes).slice(0, 20);
  const longest = [...files]
    .filter((f) => typeof f.lines === "number")
    .sort((a, b) => (b.lines || 0) - (a.lines || 0))
    .slice(0, 20);
  return { totals, largest, longest };
}
