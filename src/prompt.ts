import fs from "fs/promises";
import { cfg } from "./config.js";

const PROMPT_FILE_MAX_TOTAL_CHARS = Math.max(2000, Math.floor(cfg.promptFileMaxChars || 48000));
const PROMPT_FILE_MAX_PER_FILE_CHARS = Math.max(500, Math.floor(cfg.promptFileMaxPerFileChars || 12000));
const PROMPT_FILE_MAX_FILES = Math.max(1, Math.floor(cfg.promptFileMaxFiles || 8));
const PROMPT_FILE_ALLOWED_EXTS = new Set(
  (cfg.promptFileAllowedExts && cfg.promptFileAllowedExts.length ? cfg.promptFileAllowedExts : [
    ".ts", ".tsx", ".js", ".jsx", ".json", ".css", ".md", ".html", ".yml", ".yaml"
  ]).map(ext => ext.toLowerCase())
);
const PROMPT_FILE_ALWAYS_INCLUDE = new Set([
  "package.json",
  "tsconfig.json",
  "vite.config.ts",
  "project.json",
  "README.md"
].map(path => path.toLowerCase()));


function normalizeRepoRelativePath(value: string): string {
    return value
      .replace(/^\.\/+/, "")
      .replace(/^\/+/, "")
      .replace(/\\/g, "/")
      .replace(/\.\/+/g, "")
      .trim();
  }
  
  export function extractMentionedPaths(text: string | null | undefined): string[] {
    if (!text) return [];
    const found = new Set<string>();
    const quotedRegex = /[`'"]([^`'"\n]+\.(?:ts|tsx|js|jsx|json|css|md|html|yml|yaml))[`'"]/gi;
    let match: RegExpExecArray | null;
    while ((match = quotedRegex.exec(text))) {
      const raw = match[1]?.trim();
      if (!raw) continue;
      const normalized = normalizeRepoRelativePath(raw);
      if (!normalized.length || normalized.includes("..") || normalized.startsWith(".ma/")) continue;
      found.add(normalized);
    }
    const slashRegex = /(^|[^A-Za-z0-9._/-])((?:src|app|lib|components|tests|public)\/[A-Za-z0-9._/-]+\.(?:ts|tsx|js|jsx|json|css|md|html|yml|yaml))/gi;
    while ((match = slashRegex.exec(text))) {
      const raw = match[2]?.trim();
      if (!raw) continue;
      const normalized = normalizeRepoRelativePath(raw);
      if (!normalized.length || normalized.includes("..") || normalized.startsWith(".ma/")) continue;
      found.add(normalized);
    }
    return Array.from(found).slice(0, 50);
  }
  
  type PromptFileSnippet = {
    path: string;
    content: string;
    truncated: boolean;
  };
  
  export async function gatherPromptFileSnippets(repoRoot: string, preferredPaths: string[]): Promise<PromptFileSnippet[]> {
    const fs = await import("fs/promises");
    const pathMod = await import("path");
    const ndjsonPath = pathMod.resolve(repoRoot, ".ma/context/files.ndjson");
    let lines: string[] = [];
    try {
      const raw = await fs.readFile(ndjsonPath, "utf8");
      lines = raw.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    } catch {
      return [];
    }
  
    type Entry = { path: string; bytes: number };
    const entryMap = new Map<string, Entry>();
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line);
        const value = typeof parsed.path === "string" ? parsed.path : "";
        const normalized = normalizeRepoRelativePath(value);
        if (!normalized || normalized.includes("..")) continue;
        if (normalized.startsWith(".ma/") || normalized.startsWith("node_modules/") || normalized.startsWith("dist/")) continue;
        entryMap.set(normalized, {
          path: normalized,
          bytes: Number(parsed.bytes) || 0
        });
      } catch {
        continue;
      }
    }
  
    if (!entryMap.size) return [];
  
    const preferredSet = new Set(preferredPaths.map(normalizeRepoRelativePath));
    const seen = new Set<string>();
    const ordered: Entry[] = [];
  
    function scoreFor(pathValue: string): number {
      const lower = pathValue.toLowerCase();
      let score = 0;
      if (preferredSet.has(pathValue)) score += 1000;
      if (PROMPT_FILE_ALWAYS_INCLUDE.has(lower)) score += 600;
      if (pathValue.startsWith("src/")) score += 400;
      if (/\.(tsx?|jsx?)$/i.test(pathValue)) score += 200;
      if (/\.(css|json)$/i.test(pathValue)) score += 120;
      if (/\.(md|html|yml|yaml)$/i.test(pathValue)) score += 80;
      return score;
    }
  
    function take(pathValue: string) {
      const normalized = normalizeRepoRelativePath(pathValue);
      const entry = entryMap.get(normalized);
      if (!entry) return;
      if (seen.has(entry.path)) return;
      seen.add(entry.path);
      ordered.push(entry);
    }
  
    for (const p of preferredSet) take(p);
  
    const remaining = Array.from(entryMap.values()).filter(entry => !seen.has(entry.path));
    remaining.sort((a, b) => {
      const scoreDiff = scoreFor(b.path) - scoreFor(a.path);
      if (scoreDiff !== 0) return scoreDiff;
      return (a.bytes || 0) - (b.bytes || 0);
    });
    for (const entry of remaining) take(entry.path);
  
    const snippets: PromptFileSnippet[] = [];
    let totalChars = 0;
  
    for (const entry of ordered) {
      if (snippets.length >= PROMPT_FILE_MAX_FILES) break;
      const normalizedPath = entry.path;
      const lower = normalizedPath.toLowerCase();
      const ext = pathMod.extname(lower);
      const include = PROMPT_FILE_ALLOWED_EXTS.has(ext) || PROMPT_FILE_ALWAYS_INCLUDE.has(lower);
      if (!include) continue;
  
      const absolute = pathMod.resolve(repoRoot, normalizedPath);
      try {
        const stat = await fs.stat(absolute);
        if (!stat.isFile()) continue;
        let content = await fs.readFile(absolute, "utf8");
        let truncated = false;
        if (content.length > PROMPT_FILE_MAX_PER_FILE_CHARS) {
          content = content.slice(0, PROMPT_FILE_MAX_PER_FILE_CHARS) + "\n... (truncated for prompt)\n";
          truncated = true;
        }
        if (totalChars + content.length > PROMPT_FILE_MAX_TOTAL_CHARS) {
          if (totalChars === 0) {
            content = content.slice(0, PROMPT_FILE_MAX_TOTAL_CHARS) + "\n... (truncated for prompt)\n";
            truncated = true;
            snippets.push({ path: normalizedPath, content, truncated });
          }
          break;
        }
        snippets.push({ path: normalizedPath, content, truncated });
        totalChars += content.length;
      } catch {
        continue;
      }
    }
  
    return snippets;
  }
