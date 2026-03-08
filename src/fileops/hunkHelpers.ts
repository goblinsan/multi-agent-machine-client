import path from "path";

import type { Hunk } from "../fileops.js";

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
