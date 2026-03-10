import path from "path";

import type { Hunk } from "../fileops.js";
import { logger } from "../logger.js";

function trimEnd(s: string): string {
  return s.replace(/\s+$/, "");
}

function extractHunkParts(h: Hunk): {
  newLines: string[];
  contextLines: { relIdx: number; text: string }[];
} {
  const newLines: string[] = [];
  const contextLines: { relIdx: number; text: string }[] = [];
  let scanRel = 0;
  for (const l of h.lines) {
    if (l.startsWith("+")) {
      newLines.push(l.slice(1));
    } else if (l.startsWith(" ")) {
      newLines.push(l.slice(1));
      contextLines.push({ relIdx: scanRel, text: l.slice(1) });
      scanRel += 1;
    } else if (l.startsWith("-")) {
      scanRel += 1;
    } else {
      newLines.push(l);
      contextLines.push({ relIdx: scanRel, text: l });
      scanRel += 1;
    }
  }
  return { newLines, contextLines };
}

function verifyContext(
  lines: string[],
  baseIdx: number,
  contextLines: { relIdx: number; text: string }[],
  fuzzy: boolean,
): boolean {
  for (const c of contextLines) {
    const actualIdx = baseIdx + c.relIdx;
    if (actualIdx < 0 || actualIdx >= lines.length) return false;
    if (fuzzy) {
      if (trimEnd(lines[actualIdx]) !== trimEnd(c.text)) return false;
    } else {
      if (lines[actualIdx] !== c.text) return false;
    }
  }
  return true;
}

function tryApplyHunks(
  baseLines: string[],
  hunks: Hunk[],
  fuzzy: boolean,
): { ok: boolean; content?: string } {
  const lines = baseLines.slice();
  let offset = 0;

  for (const h of hunks) {
    let startIdx = h.oldStart - 1 + offset;
    const { newLines, contextLines } = extractHunkParts(h);

    let matched = verifyContext(lines, startIdx, contextLines, fuzzy);

    if (!matched && fuzzy && contextLines.length > 0) {
      const searchRadius = 30;
      for (let delta = 1; delta <= searchRadius; delta++) {
        for (const d of [-delta, delta]) {
          const candidate = startIdx + d;
          if (candidate < 0 || candidate >= lines.length) continue;
          if (verifyContext(lines, candidate, contextLines, true)) {
            startIdx = candidate;
            matched = true;
            break;
          }
        }
        if (matched) break;
      }
    }

    if (!matched) return { ok: false };

    lines.splice(startIdx, h.oldCount, ...newLines);
    offset += newLines.length - h.oldCount;
  }

  const content = lines.join("\n") + (lines.length ? "\n" : "");
  return { ok: true, content };
}

export function applyHunksToLines(
  baseLines: string[],
  hunks: Hunk[],
): { ok: boolean; content?: string } {
  const strict = tryApplyHunks(baseLines, hunks, false);
  if (strict.ok) return strict;
  const fuzzy = tryApplyHunks(baseLines, hunks, true);
  if (fuzzy.ok) {
    logger.info("Hunk application succeeded with fuzzy matching", {
      hunkCount: hunks.length,
    });
  }
  return fuzzy;
}

export function reconstructContentFromHunks(
  baseLines: string[],
  hunks: Hunk[],
): string {
  const lines = baseLines.slice();
  let offset = 0;

  for (const h of hunks) {
    const oldStartIdx = h.oldStart - 1 + offset;
    const oldCount = h.oldCount;

    const newLines: string[] = [];
    for (const l of h.lines) {
      if (l.startsWith("+")) newLines.push(l.slice(1));
      else if (l.startsWith(" ")) newLines.push(l.slice(1));
      else if (!l.startsWith("-")) newLines.push(l);
    }

    const safeStart = Math.max(0, Math.min(oldStartIdx, lines.length));
    const safeCount = Math.min(oldCount, lines.length - safeStart);
    lines.splice(safeStart, safeCount, ...newLines);
    offset += newLines.length - safeCount;
  }

  const content = lines.join("\n") + (lines.length ? "\n" : "");
  return content;
}

export function validateStructuredContent(filePath: string, content: string): string | null {
  const ext = path.extname(filePath).toLowerCase();
  const base = path.basename(filePath).toLowerCase();
  const isJson = ext === ".json" || ext === ".jsonc" || ext === ".json5" || base === "package.json";

  if (isJson) {
    try {
      JSON.parse(content);
      return null;
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
  }

  const isStructuredConfig = /\.(ts|mts|cts|js|mjs|cjs)$/.test(ext);
  if (isStructuredConfig) {
    const openBraces = (content.match(/\{/g) || []).length;
    const closeBraces = (content.match(/\}/g) || []).length;
    if (openBraces !== closeBraces) {
      return `Unbalanced braces: ${openBraces} open vs ${closeBraces} close`;
    }
    const openParens = (content.match(/\(/g) || []).length;
    const closeParens = (content.match(/\)/g) || []).length;
    if (openParens !== closeParens) {
      return `Unbalanced parentheses: ${openParens} open vs ${closeParens} close`;
    }
    const openBrackets = (content.match(/\[/g) || []).length;
    const closeBrackets = (content.match(/\]/g) || []).length;
    if (openBrackets !== closeBrackets) {
      return `Unbalanced brackets: ${openBrackets} open vs ${closeBrackets} close`;
    }
  }

  return null;
}

export function buildNewFileFromHunks(hunks: Hunk[]): string {
  const newLines: string[] = [];
  for (const h of hunks) {
    for (const l of h.lines) {
      if (l.startsWith("+")) newLines.push(l.slice(1));
      else if (l.startsWith(" ")) newLines.push(l.slice(1));
      else if (!l.startsWith("-")) newLines.push(l);
    }
  }
  return newLines.join("\n") + (newLines.length ? "\n" : "");
}
