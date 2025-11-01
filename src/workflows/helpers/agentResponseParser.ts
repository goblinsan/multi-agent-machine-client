import { extractJsonPayloadFromText } from "../../agents/persona.js";

export type DiffExtractionOptions = {
  maxCandidates?: number;
  extraKeys?: string[];
};

export type EditSpecCandidate = {
  ops: any[];
  container: any;
  path: string[];
  source: "object" | "array" | "json_string";
};

export type ParseAgentEditsOptions = {
  parseDiff: (diff: string) => Promise<any> | any;
  maxDiffCandidates?: number;
  diffHintKeys?: string[];
  logger?: {
    debug?: (msg: string, meta?: Record<string, unknown>) => void;
    warn?: (msg: string, meta?: Record<string, unknown>) => void;
  };
};

export type ParseAgentEditsResult = {
  editSpec: any | null;
  source: "structured" | "diff" | null;
  structuredCandidate: EditSpecCandidate | null;
  diffCandidates: string[];
  errors: Array<{ type: string; message: string; snippet?: string }>;
};

const DEFAULT_PRIORITY_KEYS = [
  "preview",
  "output",
  "diff",
  "diffs",
  "changes",
  "message",
  "text",
  "body",
  "raw",
  "result",
  "response",
  "content",
];

const DIFF_LANG_HINTS = new Set(["diff", "patch", "git", "udiff"]);
const MAX_TRAVERSAL_DEPTH = 6;
const MAX_TRAVERSAL_NODES = 600;

function isEditOp(value: any): boolean {
  return value && typeof value === "object" && typeof value.action === "string";
}

function isOpArray(value: any): value is any[] {
  if (!Array.isArray(value) || value.length === 0) return false;
  let opLike = 0;
  for (const item of value) {
    if (isEditOp(item)) opLike += 1;
    if (opLike >= Math.min(value.length, 2)) return true;
  }
  return opLike > 0;
}

function safeJsonParse(value: string): any | null {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function pickDiffFromFences(text: string): string | null {
  const regex = /```([^`\n]*)\n([\s\S]*?)```/g;
  let fallback: string | null = null;
  for (const match of text.matchAll(regex)) {
    const lang = (match[1] || "").trim().toLowerCase();
    const body = (match[2] || "").trim();
    if (!body) continue;
    if (!containsDiffMarkers(body)) continue;
    if (lang && DIFF_LANG_HINTS.has(lang)) return body;
    if (lang.includes("diff") || lang.includes("patch")) return body;
    if (!fallback) fallback = body;
  }
  return fallback;
}

function extractFromHtml(text: string): string | null {
  const pre = /<pre[^>]*>([\s\S]*?)<\/pre>/i.exec(text);
  if (pre && pre[1]) {
    const decoded = pre[1].replace(/&lt;/g, "<").replace(/&gt;/g, ">");
    if (containsDiffMarkers(decoded)) return decoded.trim();
  }
  const code = /<code[^>]*>([\s\S]*?)<\/code>/i.exec(text);
  if (code && code[1]) {
    const decoded = code[1].replace(/&lt;/g, "<").replace(/&gt;/g, ">");
    if (containsDiffMarkers(decoded)) return decoded.trim();
  }
  return null;
}

function findFirstDiffIndex(text: string): number {
  const patterns = [
    /(^|\n)diff --git /,
    /(^|\n)@@ /,
    /(^|\n)\+\+\+\s+[ab]\//,
    /(^|\n)---\s+[ab]\//,
  ];
  let idx = -1;
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (!match) continue;
    const offset = match.index + (match[1] ? match[1].length : 0);
    if (idx === -1 || offset < idx) idx = offset;
  }
  return idx;
}

function containsDiffMarkers(text: string): boolean {
  if (!text) return false;
  if (/^diff --git\s+/m.test(text)) return true;
  if (/^index\s+[0-9a-f]+\.{2}[0-9a-f]+\s+\d+/m.test(text)) return true;
  if (/^\+\+\+\s+[ab]\//m.test(text) && /^---\s+[ab]\//m.test(text))
    return true;
  if (/^@@\s+-?\d+/m.test(text)) return true;
  return false;
}

function normalizeDiffSnippet(raw: string): string | null {
  if (!raw || typeof raw !== "string") return null;
  let text = raw.replace(/\r\n/g, "\n");
  const fromFence = pickDiffFromFences(text);
  if (fromFence) text = fromFence;
  else {
    const fromHtml = extractFromHtml(text);
    if (fromHtml) text = fromHtml;
  }
  const idx = findFirstDiffIndex(text);
  if (idx >= 0) text = text.slice(idx);
  const trimmed = text.trim();
  if (!containsDiffMarkers(trimmed)) return null;
  return trimmed;
}

function collectStrings(
  input: unknown,
  options: DiffExtractionOptions | undefined,
): string[] {
  const strings: string[] = [];
  const seen = new Set<any>();
  let nodes = 0;
  const extraKeys = options?.extraKeys || [];
  const prioritySet = new Set([...DEFAULT_PRIORITY_KEYS, ...extraKeys]);

  function walk(value: unknown, depth: number) {
    if (value === null || value === undefined) return;
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (trimmed.length) strings.push(value);
      return;
    }
    if (typeof value !== "object") return;
    if (depth > MAX_TRAVERSAL_DEPTH) return;
    if (seen.has(value)) return;
    seen.add(value);
    nodes += 1;
    if (nodes > MAX_TRAVERSAL_NODES) return;

    if (Array.isArray(value)) {
      for (const item of value) walk(item, depth + 1);
      return;
    }
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj);
    const prioritized: string[] = [];
    const rest: string[] = [];
    for (const key of keys) {
      if (prioritySet.has(key)) prioritized.push(key);
      else rest.push(key);
    }
    for (const key of [...prioritized, ...rest]) {
      const val = obj[key];
      if (typeof val === "string") {
        const trimmed = val.trim();
        if (trimmed.length) strings.push(val);
        continue;
      }
      if (key === "ops") continue;
      walk(val, depth + 1);
    }
  }

  walk(input, 0);
  return strings;
}

export function extractDiffCandidates(
  input: unknown,
  options?: DiffExtractionOptions,
): string[] {
  const strings = collectStrings(input, options);
  const uniq = new Set<string>();
  const diffs: string[] = [];
  const max =
    options?.maxCandidates && options.maxCandidates > 0
      ? options.maxCandidates
      : Infinity;

  for (const str of strings) {
    const normalized = normalizeDiffSnippet(str);
    if (!normalized) continue;
    const key = normalized.slice(0, 2000);
    if (uniq.has(key)) continue;
    uniq.add(key);
    diffs.push(normalized);
    if (diffs.length >= max) break;
  }
  return diffs;
}

export function findEditSpecCandidate(
  value: unknown,
): EditSpecCandidate | null {
  const queue: Array<{ value: unknown; path: string[] }> = [
    { value, path: [] },
  ];
  const visited = new Set<any>();
  const seenStrings = new Set<string>();

  const normalizeContainer = (
    container: any,
    path: string[],
    source: EditSpecCandidate["source"],
    ops: any[],
  ): EditSpecCandidate => {
    const spec =
      container && typeof container === "object" ? container : { ops };
    return { ops, container: spec, path, source };
  };

  while (queue.length) {
    const entry = queue.shift()!;
    const current = entry.value;

    if (current === null || current === undefined) continue;

    if (Array.isArray(current)) {
      if (isOpArray(current))
        return normalizeContainer(
          { ops: current },
          entry.path,
          "array",
          current,
        );
      let idx = 0;
      const arr = current as unknown[];
      for (const item of arr) {
        queue.push({ value: item, path: [...entry.path, `[${idx}]`] });
        idx += 1;
      }
      continue;
    }

    if (typeof current === "object") {
      if (visited.has(current)) continue;
      visited.add(current);
      const obj = current as Record<string, unknown>;

      if (isOpArray((obj as any).ops)) {
        return normalizeContainer(
          current,
          [...entry.path, "ops"],
          "object",
          (obj as any).ops,
        );
      }

      const candidateKeys = [
        "payload",
        "result",
        "data",
        "details",
        "edit_spec",
        "editSpec",
        "edits",
        "changes",
        "response",
        "output",
        "body",
        "diff",
      ];

      for (const key of candidateKeys) {
        if (obj[key] === undefined) continue;
        const val = obj[key];
        if (isOpArray((val as any)?.ops)) {
          return normalizeContainer(
            val,
            [...entry.path, key, "ops"],
            "object",
            (val as any).ops,
          );
        }
        if (isOpArray(val)) {
          return normalizeContainer(
            { ops: val },
            [...entry.path, key],
            "array",
            val as any,
          );
        }
        queue.push({ value: val, path: [...entry.path, key] });
      }

      for (const [key, val] of Object.entries(obj)) {
        if (candidateKeys.includes(key) || key === "ops") continue;
        queue.push({ value: val, path: [...entry.path, key] });
      }
      continue;
    }

    if (typeof current === "string") {
      const trimmed = current.trim();
      if (!trimmed.length) continue;
      if (seenStrings.has(trimmed)) continue;
      seenStrings.add(trimmed);
      const parsed =
        safeJsonParse(trimmed) || extractJsonPayloadFromText(trimmed);
      if (parsed)
        queue.push({ value: parsed, path: [...entry.path, "<parsed>"] });
    }
  }

  return null;
}

export async function parseAgentEditsFromResponse(
  input: unknown,
  options: ParseAgentEditsOptions,
): Promise<ParseAgentEditsResult> {
  if (!options || typeof options.parseDiff !== "function") {
    throw new Error(
      "parseAgentEditsFromResponse requires a parseDiff function",
    );
  }

  const structured = findEditSpecCandidate(input);
  const result: ParseAgentEditsResult = {
    editSpec: structured ? structured.container : null,
    source: structured ? "structured" : null,
    structuredCandidate: structured,
    diffCandidates: [],
    errors: [],
  };

  if (
    structured &&
    Array.isArray(structured.ops) &&
    structured.ops.length > 0
  ) {
    return result;
  }

  const diffCandidates = extractDiffCandidates(input, {
    maxCandidates: options.maxDiffCandidates,
    extraKeys: options.diffHintKeys,
  });
  result.diffCandidates = diffCandidates;

  if (!diffCandidates.length) {
    if (options.logger?.debug)
      options.logger.debug("agent-parser: no diff candidates", {});
    return result;
  }

  for (const candidate of diffCandidates) {
    try {
      const parsed = await options.parseDiff(candidate);
      if (parsed && Array.isArray(parsed.ops) && parsed.ops.length > 0) {
        if (options.logger?.debug)
          options.logger.debug("agent-parser: parsed diff candidate", {
            ops: parsed.ops.length,
          });
        return {
          editSpec: parsed,
          source: "diff",
          structuredCandidate: structured,
          diffCandidates,
          errors: result.errors,
        };
      }
      result.errors.push({
        type: "diff_parse_empty",
        message: "Parsed diff produced no operations",
        snippet: candidate.slice(0, 200),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      result.errors.push({
        type: "diff_parse_error",
        message,
        snippet: candidate.slice(0, 200),
      });
      if (options.logger?.warn)
        options.logger.warn("agent-parser: diff parse failure", {
          error: message,
        });
    }
  }

  return result;
}
