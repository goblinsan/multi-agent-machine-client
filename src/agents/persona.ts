
import { randomUUID } from "crypto";
import { cfg } from "../config.js";
import { makeRedis } from "../redisClient.js";
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
  const eventRedis = await makeRedis();

  try {
    const streamKey = cfg.eventStream;

    const recentMatch = await (async () => {
      try {
        const entries = await eventRedis.xRevRange(streamKey, "+", "-", { COUNT: 200 });
        if (!entries) return null;
        for (const entry of entries) {
          const id = Array.isArray(entry) ? String(entry[0]) : "";
          const rawCandidate = Array.isArray(entry) ? entry[1] : entry;
          if (!id || !rawCandidate || typeof rawCandidate !== "object") continue;
          const raw = rawCandidate as Record<string, any>;
          const fields: Record<string, string> = {};
          for (const [k, v] of Object.entries(raw)) fields[k] = typeof v === "string" ? v : String(v);
          if (
            fields.workflow_id === workflowId &&
            fields.from_persona === persona &&
            fields.status === "done" &&
            (!corrId || fields.corr_id === corrId)
          ) {
            return { id, fields };
          }
        }
      } catch (error) {
        logger.debug("waitForPersonaCompletion scan failed", { persona, workflowId, corrId, error });
      }
      return null;
    })();

    if (recentMatch) return recentMatch;

    let lastId = "$";
    while (Date.now() - started < effectiveTimeout) {
      const elapsed = Date.now() - started;
      const remaining = Math.max(0, effectiveTimeout - elapsed);
      const blockMs = Math.max(1000, Math.min(remaining || effectiveTimeout, 5000));
      const streams = await eventRedis.xRead([{ key: streamKey, id: lastId }], { BLOCK: blockMs, COUNT: 20 }).catch(() => null);
      if (!streams) continue;

      for (const stream of streams) {
        const messages = stream.messages || [];
        for (const message of messages) {
          const rawFields = message.message as Record<string, string>;
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
    try { await eventRedis.quit(); } catch {}
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
    try { return JSON.parse(snippet); } catch {}
  }
  const firstBrace = text.indexOf("{");
  const lastBrace = text.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    const candidate = text.slice(firstBrace, lastBrace + 1);
    try { return JSON.parse(candidate); } catch {}
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
  const json = extractJsonPayloadFromText(raw);
  if (json && typeof json.status === "string") {
    const statusLower = json.status.trim().toLowerCase();
    let normalized: "pass" | "fail" | "unknown" = "unknown";
    if (PASS_STATUS_KEYWORDS.has(statusLower)) normalized = "pass";
    else if (FAIL_STATUS_KEYWORDS.has(statusLower)) normalized = "fail";
    const details = typeof json.details === "string" ? json.details : raw || JSON.stringify(json);
    return { status: normalized, details, raw, payload: json };
  }
  if (!raw.length) return { status: "unknown", details: raw, raw };
  const lower = raw.toLowerCase();
  for (const key of FAIL_STATUS_KEYWORDS) {
    if (lower.includes(key)) return { status: "fail", details: raw, raw };
  }
  for (const key of PASS_STATUS_KEYWORDS) {
    if (lower.includes(key)) return { status: "pass", details: raw, raw };
  }
  return { status: "unknown", details: raw, raw, payload: json };
}
