import { randomUUID } from "crypto";
import { cfg } from "../config.js";
import { logger } from "../logger.js";
import { PERSONAS } from "../personaNames.js";
import { personaTimeoutMs } from "../util.js";

type PersonaEvent = { id: string; fields: Record<string, string> };

export async function waitForPersonaCompletion(
  r: any,
  persona: string,
  workflowId: string,
  corrId: string | string[],
  timeoutMs?: number,
): Promise<PersonaEvent> {
  const effectiveTimeout =
    typeof timeoutMs === "number" && Number.isFinite(timeoutMs) && timeoutMs > 0
      ? timeoutMs
      : personaTimeoutMs(persona, cfg);
  const started = Date.now();
  const transport = r;
  const corrIds = Array.isArray(corrId) ? new Set(corrId) : new Set([corrId]);

  try {
    const streamKey = cfg.eventStream;

    let lastId = "0-0";
    while (Date.now() - started < effectiveTimeout) {
      const elapsed = Date.now() - started;
      const remaining = Math.max(0, effectiveTimeout - elapsed);
      const blockMs = Math.max(
        1000,
        Math.min(remaining || effectiveTimeout, 5000),
      );
      const readResult = await transport
        .xRead([{ key: streamKey, id: lastId }], { BLOCK: blockMs, COUNT: 20 })
        .catch(() => null);
      if (!readResult) continue;

      const streams = Object.entries(readResult).map(
        ([key, streamData]: [string, any]) => ({
          key,
          messages: streamData.messages || [],
        }),
      );

      for (const stream of streams) {
        const messages = stream.messages || [];
        for (const message of messages) {
          const rawFields = message.fields;
          const fields: Record<string, string> = {};
          for (const [k, v] of Object.entries(rawFields))
            fields[k] = typeof v === "string" ? v : String(v);
          if (
            fields.workflow_id === workflowId &&
            fields.from_persona === persona &&
            fields.status === "done" &&
            (corrIds.size === 0 || corrIds.has(fields.corr_id))
          ) {
            return { id: message.id, fields };
          }
        }
        if (messages.length) lastId = messages[messages.length - 1].id;
      }
    }
  } catch (e) {
    logger.warn("Error while polling for persona completion", {
      persona,
      workflowId,
      corrId: Array.isArray(corrId) ? corrId.join(",") : corrId,
      error: String(e),
    });
  }

  const timeoutSec = Math.round(effectiveTimeout / 100) / 10;
  const corrIdStr = Array.isArray(corrId) ? corrId[corrId.length - 1] : corrId;
  throw new Error(
    `Timed out waiting for ${persona} completion (workflow ${workflowId}, corr ${corrIdStr}, timeout ${timeoutSec}s)`,
  );
}

export function parseEventResult(result: string | undefined) {
  if (!result) return null;
  try {
    return JSON.parse(result);
  } catch {
    return { raw: result };
  }
}

export async function sendPersonaRequest(
  r: any,
  opts: {
    workflowId: string;
    toPersona: string;
    step?: string;
    intent?: string;
    fromPersona?: string;
    payload?: any;
    corrId?: string;
    deadlineSeconds?: number;
    repo?: string;
    branch?: string;
    projectId?: string;
    taskId?: string;
  },
): Promise<string> {
  const corrId = opts.corrId || randomUUID();

  const entry: Record<string, string> = {
    workflow_id: opts.workflowId,
    step: opts.step || "",
    from: opts.fromPersona || PERSONAS.COORDINATION,
    to_persona: opts.toPersona,
    intent: opts.intent || "",
    payload: JSON.stringify(opts.payload ?? {}),
    corr_id: corrId,
    deadline_s: String(opts.deadlineSeconds ?? 600),
  };
  if (opts.taskId) entry.task_id = opts.taskId;
  if (opts.repo) entry.repo = opts.repo;
  if (opts.branch) entry.branch = opts.branch;
  if (opts.projectId) entry.project_id = opts.projectId;

  await r.xAdd(cfg.requestStream, "*", entry);
  logger.info("coordinator dispatched request", {
    workflowId: opts.workflowId,
    targetPersona: opts.toPersona,
    corrId,
    step: entry.step,
    branch: opts.branch,
    projectId: opts.projectId,
  });
  return corrId;
}

const PASS_STATUS_KEYWORDS = new Set([
  "pass",
  "passed",
  "success",
  "succeeded",
  "approved",
  "ok",
  "green",
  "lgtm",
  "complete",
  "completed",
]);
const FAIL_STATUS_KEYWORDS = new Set([
  "fail",
  "failed",
  "block",
  "blocked",
  "reject",
  "rejected",
  "error",
  "not pass",
  "red",
]);

function stripThinkTags(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
}

function findFirstCompleteJsonObject(text: string, startFrom = 0): string | null {
  const start = text.indexOf("{", startFrom);
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (escape) { escape = false; continue; }
    if (ch === "\\") { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

export function extractJsonPayloadFromText(
  text: string | undefined,
): any | null {
  if (!text) return null;
  const cleaned = stripThinkTags(text);
  const fenceRegex = /```(?:json)?\s*([\s\S]*?)```/gi;
  let match: RegExpExecArray | null;
  while ((match = fenceRegex.exec(cleaned))) {
    const snippet = match[1];
    try {
      return JSON.parse(snippet);
    } catch (e) {
      logger.debug("JSON parse failed for fenced code block", {
        error: String(e),
        snippet: snippet.slice(0, 100),
      });
    }
  }
  const tracked = findFirstCompleteJsonObject(cleaned);
  if (tracked) {
    try {
      return JSON.parse(tracked);
    } catch (e) {
      logger.debug("JSON parse failed for brace-tracked content", {
        error: String(e),
        candidate: tracked.slice(0, 100),
      });
      let searchFrom = cleaned.indexOf("{") + 1;
      while (searchFrom < cleaned.length) {
        const next = findFirstCompleteJsonObject(cleaned, searchFrom);
        if (!next) break;
        try {
          return JSON.parse(next);
        } catch {
          const pos = cleaned.indexOf("{", searchFrom);
          searchFrom = pos !== -1 ? pos + 1 : cleaned.length;
        }
      }
    }
  }
  const firstBrace = cleaned.indexOf("{");
  const lastBrace = cleaned.lastIndexOf("}");
  if (
    firstBrace !== -1 &&
    lastBrace !== -1 &&
    lastBrace > firstBrace &&
    cleaned.slice(firstBrace, lastBrace + 1) !== tracked
  ) {
    const candidate = cleaned.slice(firstBrace, lastBrace + 1);
    try {
      return JSON.parse(candidate);
    } catch (e) {
      logger.debug("JSON parse failed for brace-extracted content", {
        error: String(e),
        candidate: candidate.slice(0, 100),
      });
    }
  }
  return null;
}

const PROSE_STATUS_PATTERN =
  /(?:evaluation\s+)?status[*_:\s]+\s*(pass|fail|passed|failed|success|error|ok|approved|rejected)/im;

const PROSE_PASS_PHRASES = [
  /\bplan\s+is\s+(?:acceptable|well[- ]structured|concrete|actionable|appropriate|solid|sound|good)\b/i,
  /\bcan\s+proceed\b/i,
  /\bplan\s+(?:can|should)\s+proceed\b/i,
  /\bwell[- ]structured\s+and\s+(?:provides|should)\b/i,
  /\boverall[,:]?\s+the\s+plan\s+is\s+(?:acceptable|well|concrete|actionable|appropriate|solid)/i,
];

const PROSE_FAIL_PHRASES = [
  /\bplan\s+(?:is\s+)?(?:not\s+acceptable|inadequate|incomplete)\b/i,
  /\bneeds\s+revision\b/i,
  /\bmust\s+be\s+reworked\b/i,
  /\bcannot\s+proceed\b/i,
  /\bplan\s+should\s+(?:not|be\s+rejected|be\s+revised)\b/i,
];

function detectEvaluationSentiment(text: string): "pass" | "fail" | null {
  const sample = text.substring(0, 2000);
  for (const p of PROSE_FAIL_PHRASES) {
    if (p.test(sample)) return "fail";
  }
  for (const p of PROSE_PASS_PHRASES) {
    if (p.test(sample)) return "pass";
  }
  return null;
}

function normalizeStatusKeyword(keyword: string): "pass" | "fail" | null {
  const lower = keyword.toLowerCase();
  if (PASS_STATUS_KEYWORDS.has(lower)) return "pass";
  if (FAIL_STATUS_KEYWORDS.has(lower)) return "fail";
  return null;
}

function findStatusInText(text: string): "pass" | "fail" | null {
  const sample = text.substring(0, 1500);
  const patterns: RegExp[] = [
    /["']status["']\s*:\s*["'](pass|fail|success|error|failed|succeeded|approved|rejected|ok)["']/i,
    /^(?:status|result):\s*(pass|fail|passed|failed|success|error|ok|approved|rejected)/im,
    PROSE_STATUS_PATTERN,
  ];
  for (const pattern of patterns) {
    const m = sample.match(pattern);
    if (m) {
      const result = normalizeStatusKeyword(m[1]);
      if (result) return result;
    }
  }
  return null;
}

type PersonaStatusInfo = {
  status: "pass" | "fail" | "unknown";
  details: string;
  raw: string;
  payload?: any;
};

type InterpretPersonaStatusOptions = {
  persona?: string;
  statusRequired?: boolean;
};

export function interpretPersonaStatus(
  output: string | undefined,
  options: InterpretPersonaStatusOptions = {},
): PersonaStatusInfo {
  const statusRequired = options.statusRequired ?? true;
  const raw = (output || "").trim();
  if (!raw.length) {
    return { status: "unknown", details: raw, raw };
  }

  const outerJson = extractJsonPayloadFromText(raw);
  const hasOutputWrapper =
    outerJson && typeof outerJson.output === "string";

  const llmContent = hasOutputWrapper
    ? stripThinkTags(outerJson.output)
    : stripThinkTags(raw);

  const contentJson = hasOutputWrapper
    ? extractJsonPayloadFromText(llmContent)
    : outerJson;

  if (contentJson && typeof contentJson.status === "string") {
    const normalized = normalizeStatusKeyword(contentJson.status.trim());
    const details =
      typeof contentJson.details === "string"
        ? contentJson.details
        : llmContent || JSON.stringify(contentJson);
    return {
      status: normalized ?? "unknown",
      details,
      raw,
      payload: contentJson,
    };
  }

  if (
    contentJson &&
    typeof contentJson.error === "string" &&
    contentJson.error.trim().length > 0
  ) {
    return {
      status: "fail",
      details: contentJson.error,
      raw,
      payload: contentJson,
    };
  }

  if (contentJson && typeof contentJson.success === "boolean") {
    const normalized = contentJson.success ? "pass" : "fail";
    const details =
      typeof contentJson.details === "string"
        ? contentJson.details
        : llmContent;
    return { status: normalized, details, raw, payload: contentJson };
  }

  const textStatus = findStatusInText(llmContent);
  if (textStatus) {
    return {
      status: textStatus,
      details: llmContent,
      raw,
      payload: contentJson,
    };
  }

  const sentiment = detectEvaluationSentiment(llmContent);
  if (sentiment) {
    logger.info("Detected evaluation sentiment from prose", {
      persona: options.persona,
      sentiment,
      preview: llmContent.substring(0, 120),
    });
    return {
      status: sentiment,
      details: llmContent,
      raw,
      payload: contentJson,
    };
  }

  if (!statusRequired) {
    return { status: "pass", details: llmContent, raw, payload: contentJson };
  }

  logger.warn("Persona status unclear - no explicit status declaration found", {
    persona: options.persona,
    rawPreview: llmContent.substring(0, 200),
    hasJson: !!contentJson,
    recommendation: "Persona should return JSON with explicit status field",
  });

  return { status: "unknown", details: llmContent, raw, payload: contentJson };
}
