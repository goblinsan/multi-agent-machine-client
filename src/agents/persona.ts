
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
  corrId: string,
  timeoutMs?: number
): Promise<PersonaEvent> {
  const effectiveTimeout = typeof timeoutMs === "number" && Number.isFinite(timeoutMs) && timeoutMs > 0
    ? timeoutMs
    : personaTimeoutMs(persona, cfg);
  const started = Date.now();
  const transport = r;

  try {
    const streamKey = cfg.eventStream;

    // xRevRange optimization commented out - not in MessageTransport interface
    // This optimization scanned recent events before blocking, but isn't critical
    // The blocking xRead below will still catch completions

    // Start with "0-0" to check all existing messages first, then use lastId for subsequent reads
    // This ensures we don't miss events that were published before we started listening
    let lastId = "0-0";
    while (Date.now() - started < effectiveTimeout) {
      const elapsed = Date.now() - started;
      const remaining = Math.max(0, effectiveTimeout - elapsed);
      const blockMs = Math.max(1000, Math.min(remaining || effectiveTimeout, 5000));
      const readResult = await transport.xRead([{ key: streamKey, id: lastId }], { BLOCK: blockMs, COUNT: 20 }).catch(() => null);
      if (!readResult) continue;

      // xRead returns { [streamKey]: { messages: [...] } }, convert to array of streams
      const streams = Object.entries(readResult).map(([key, streamData]: [string, any]) => ({
        key,
        messages: streamData.messages || []
      }));

      for (const stream of streams) {
        const messages = stream.messages || [];
        for (const message of messages) {
          // Message interface has fields directly, not message.message
          const rawFields = message.fields;
          const fields: Record<string, string> = {};
          for (const [k, v] of Object.entries(rawFields)) fields[k] = typeof v === "string" ? v : String(v);
          if (
            fields.workflow_id === workflowId &&
            fields.from_persona === persona &&
            fields.status === "done" &&
            (!corrId || fields.corr_id === corrId)
          ) {
            return { id: message.id, fields };
          }
        }
        if (messages.length) lastId = messages[messages.length - 1].id;
      }
    }
  } finally {
    // No quit needed - transport lifecycle managed by caller
  }

  const timeoutSec = Math.round(effectiveTimeout / 100) / 10;
  throw new Error(`Timed out waiting for ${persona} completion (workflow ${workflowId}, corr ${corrId}, timeout ${timeoutSec}s)`);
}

export function parseEventResult(result: string | undefined) {
  if (!result) return null;
  try {
    return JSON.parse(result);
  } catch {
    return { raw: result };
  }
}

export async function sendPersonaRequest(r: any, opts: {
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
}): Promise<string> {
  const corrId = opts.corrId || randomUUID();
  const entry: Record<string, string> = {
    workflow_id: opts.workflowId,
    step: opts.step || "",
    from: opts.fromPersona || PERSONAS.COORDINATION,
    to_persona: opts.toPersona,
    intent: opts.intent || "",
    payload: JSON.stringify(opts.payload ?? {}),
    corr_id: corrId,
    deadline_s: String(opts.deadlineSeconds ?? 600)
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
    projectId: opts.projectId
  });
  return corrId;
}

const PASS_STATUS_KEYWORDS = new Set(["pass", "passed", "success", "succeeded", "approved", "ok", "green", "lgtm"]);
const FAIL_STATUS_KEYWORDS = new Set(["fail", "failed", "block", "blocked", "reject", "rejected", "error", "not pass", "red"]);

export function extractJsonPayloadFromText(text: string | undefined): any | null {
  if (!text) return null;
  const fenceRegex = /```(?:json)?\s*([\s\S]*?)```/gi;
  let match: RegExpExecArray | null;
  while ((match = fenceRegex.exec(text))) {
    const snippet = match[1];
    try { return JSON.parse(snippet); } catch { /* ignore invalid JSON in fence */ }
  }
  const firstBrace = text.indexOf("{");
  const lastBrace = text.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    const candidate = text.slice(firstBrace, lastBrace + 1);
    try { return JSON.parse(candidate); } catch { /* ignore invalid JSON extraction */ }
  }
  return null;
}

type PersonaStatusInfo = {
  status: "pass" | "fail" | "unknown";
  details: string;
  raw: string;
  payload?: any;
};

export function interpretPersonaStatus(output: string | undefined): PersonaStatusInfo {
  const raw = (output || "").trim();
  let json = extractJsonPayloadFromText(raw);
  
  // PRIORITY 1: Explicit JSON status field (REQUIRED for reliable parsing)
  if (json && typeof json.status === "string") {
    const statusLower = json.status.trim().toLowerCase();
    let normalized: "pass" | "fail" | "unknown" = "unknown";
    if (PASS_STATUS_KEYWORDS.has(statusLower)) normalized = "pass";
    else if (FAIL_STATUS_KEYWORDS.has(statusLower)) normalized = "fail";
    const details = typeof json.details === "string" ? json.details : raw || JSON.stringify(json);
    return { status: normalized, details, raw, payload: json };
  }
  
  // PRIORITY 2: Check nested output field (LM Studio wrapper pattern)
  if (json && typeof json.output === "string") {
    const innerJson = extractJsonPayloadFromText(json.output);
    if (innerJson && typeof innerJson.status === "string") {
      const statusLower = innerJson.status.trim().toLowerCase();
      let normalized: "pass" | "fail" | "unknown" = "unknown";
      if (PASS_STATUS_KEYWORDS.has(statusLower)) normalized = "pass";
      else if (FAIL_STATUS_KEYWORDS.has(statusLower)) normalized = "fail";
      const details = typeof innerJson.details === "string" ? innerJson.details : json.output;
      return { status: normalized, details, raw, payload: innerJson };
    }
  }
  
  // PRIORITY 3: Look for explicit status declarations at START of response
  // Only check first 500 characters to avoid false positives from narrative text
  // Pattern: "Status: pass" or "Result: fail" at beginning of line
  if (!raw.length) return { status: "unknown", details: raw, raw };
  const firstPart = raw.substring(0, 500);
  const statusLineMatch = firstPart.match(/^(?:status|result):\s*(pass|fail|passed|failed|success|error|ok|approved|rejected)/im);
  if (statusLineMatch) {
    const declaredStatus = statusLineMatch[1].toLowerCase();
    const normalized = PASS_STATUS_KEYWORDS.has(declaredStatus) ? "pass" : 
                       FAIL_STATUS_KEYWORDS.has(declaredStatus) ? "fail" : "unknown";
    return { status: normalized, details: raw, raw, payload: json };
  }
  
  // PRIORITY 4: Check for explicit JSON-like status declarations in first 500 chars
  // Pattern: {"status": "pass"} or 'status': 'fail' 
  const jsonStatusMatch = firstPart.toLowerCase().match(/["']status["']\s*:\s*["'](pass|fail|success|error|failed|succeeded|approved|rejected|ok)["']/);
  if (jsonStatusMatch) {
    const declaredStatus = jsonStatusMatch[1];
    const normalized = PASS_STATUS_KEYWORDS.has(declaredStatus) ? "pass" : 
                       FAIL_STATUS_KEYWORDS.has(declaredStatus) ? "fail" : "unknown";
    return { status: normalized, details: raw, raw, payload: json };
  }
  
  // DEFAULT: No clear status found - return UNKNOWN (fail-safe)
  // DO NOT scan entire text for keywords - prevents false positives from narrative
  logger.warn('Persona status unclear - no explicit status declaration found', {
    rawPreview: raw.substring(0, 200),
    hasJson: !!json,
    recommendation: 'Persona should return JSON with explicit status field'
  });
  
  return { status: "unknown", details: raw, raw, payload: json };
}
