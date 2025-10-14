
import { cfg } from "./config.js";
import { makeRedis } from "./redisClient.js";
import { RequestSchema } from "./schema.js";
import { logger } from "./logger.js";
import { PERSONAS } from "./personaNames.js";
import { handleCoordinator } from "./workflows/WorkflowCoordinator.js";
import { processContext, processPersona } from "./process.js";
import { isDuplicateMessage, markMessageProcessed, startMessageTrackingCleanup } from "./messageTracking.js";

function groupForPersona(p: string) { return `${cfg.groupPrefix}:${p}`; }
function nowIso() { return new Date().toISOString(); }

async function ensureGroups(r: any) {
  // Create consumer groups starting from '0' to read all messages in the stream,
  // not just new ones. This prevents race conditions where messages sent before
  // the consumer starts reading are missed.
  for (const p of cfg.allowedPersonas) {
    try { 
      await r.xGroupCreate(cfg.requestStream, groupForPersona(p), "0", { MKSTREAM: true }); 
      logger.debug("created consumer group", { stream: cfg.requestStream, group: groupForPersona(p), startFrom: "0" });
    } catch (e: any) {
      // Group might already exist, which is fine
      if (e?.message && !e.message.includes("BUSYGROUP")) {
        logger.warn("failed to create consumer group", { stream: cfg.requestStream, group: groupForPersona(p), error: e?.message });
      }
    }
  }
  try { 
    await r.xGroupCreate(cfg.eventStream, `${cfg.groupPrefix}:coordinator`, "0", { MKSTREAM: true }); 
    logger.debug("created coordinator group", { stream: cfg.eventStream, group: `${cfg.groupPrefix}:coordinator`, startFrom: "0" });
  } catch (e: any) {
    if (e?.message && !e.message.includes("BUSYGROUP")) {
      logger.warn("failed to create coordinator group", { stream: cfg.eventStream, group: `${cfg.groupPrefix}:coordinator`, error: e?.message });
    }
  }
}


async function readOne(r: any, persona: string) {
  // BLOCK timeout set to 1000ms (1 second) for responsive message pickup.
  // Redis will return immediately if messages are available.
  const res = await r.xReadGroup(groupForPersona(persona), cfg.consumerId, { key: cfg.requestStream, id: ">" }, { COUNT: 1, BLOCK: 1000 }).catch(async (e: any) => {
    // If consumer group doesn't exist (e.g., after --drain-only), recreate it
    if (e?.message && e.message.includes("NOGROUP")) {
      logger.info("consumer group missing, recreating", { persona, group: groupForPersona(persona) });
      try {
        await r.xGroupCreate(cfg.requestStream, groupForPersona(persona), "0", { MKSTREAM: true });
        logger.info("consumer group recreated", { persona, group: groupForPersona(persona) });
        // Retry the read after creating the group
        return await r.xReadGroup(groupForPersona(persona), cfg.consumerId, { key: cfg.requestStream, id: ">" }, { COUNT: 1, BLOCK: 1000 }).catch(() => null);
      } catch (createErr: any) {
        logger.error("failed to recreate consumer group", { persona, error: createErr?.message });
      }
    }
    return null;
  });
  if (!res) return;
  for (const stream of res) {
    for (const msg of stream.messages) {
      const id = msg.id;
      const fields = msg.message as Record<string, string>;
      processOne(r, persona, id, fields).catch(async (e: any) => {
        logger.error(`worker error`, { persona, error: e, entryId: id });
        await r.xAdd(cfg.eventStream, "*", {
          workflow_id: fields?.workflow_id ?? "", step: fields?.step ?? "",
          from_persona: persona, status: "error", corr_id: fields?.corr_id ?? "",
          error: String(e?.message || e), ts: nowIso()
        }).catch(()=>{});
        await r.xAck(cfg.requestStream, groupForPersona(persona), id).catch(()=>{});
      });
    }
  }
}

async function main() {
  if (cfg.allowedPersonas.length === 0) { logger.error("ALLOWED_PERSONAS is empty; nothing to do."); process.exit(1); }
  
  // Establish Redis connection and ensure it's ready
  const r = await makeRedis();
  
  // Verify connection with a simple ping
  try {
    await r.ping();
    logger.info("redis connection established", { url: cfg.redisUrl.replace(/:[^:@]+@/, ':***@') });
  } catch (e: any) {
    logger.error("redis connection failed", { error: e?.message, url: cfg.redisUrl.replace(/:[^:@]+@/, ':***@') });
    throw new Error("Failed to establish Redis connection");
  }
  
  // Start message tracking cleanup
  startMessageTrackingCleanup();
  
  // Create consumer groups
  await ensureGroups(r);
  
  logger.info("worker ready", {
    personas: cfg.allowedPersonas,
    projectBase: cfg.projectBase,
    defaultRepoParent: cfg.projectBase,
    contextScan: cfg.contextScan,
    summaryMode: cfg.summaryMode,
    logFile: cfg.log.file,
    logLevel: cfg.log.level,
    logConsole: cfg.log.console
  });
  try {
    // small diagnostic to confirm file logging was initialized
    const { getLogFilePath, isFileLoggingActive } = await import("./logger.js");
    logger.info("file logging status", { logFile: getLogFilePath(), active: isFileLoggingActive() });
  } catch (e) { /* ignore */ }
  // Also surface persona timeout configuration to make it visible on startup
  try {
    logger.info("persona timeouts", {
      personaTimeoutOverrides: cfg.personaTimeouts || {},
      personaDefaultTimeoutMs: cfg.personaDefaultTimeoutMs,
      personaCodingTimeoutMs: cfg.personaCodingTimeoutMs
    });
  } catch (e) { /* ignore logging errors */ }
  while (true) { for (const p of cfg.allowedPersonas) { await readOne(r, p); } }
}

async function processOne(r: any, persona: string, entryId: string, fields: Record<string,string>) {
    const parsed = RequestSchema.safeParse(fields);
    if (!parsed.success) { await r.xAck(cfg.requestStream, groupForPersona(persona), entryId); return; }
    const msg = parsed.data;
    if (msg.to_persona !== persona) { await r.xAck(cfg.requestStream, groupForPersona(persona), entryId); return; }
  
    // Check for duplicate messages
    if (isDuplicateMessage(msg.task_id, msg.corr_id, persona)) {
      logger.info("Duplicate message detected, sending duplicate_response", {
        persona,
        workflowId: msg.workflow_id,
        taskId: msg.task_id,
        corrId: msg.corr_id
      });
      
      // Send duplicate_response event
      await r.xAdd(cfg.eventStream, "*", {
        workflow_id: msg.workflow_id,
        task_id: msg.task_id || "",
        step: msg.step || "",
        from_persona: persona,
        status: "duplicate_response",
        corr_id: msg.corr_id || "",
        result: JSON.stringify({
          message: "This request has already been processed by this persona",
          originalTaskId: msg.task_id,
          originalCorrId: msg.corr_id
        }),
        ts: nowIso()
      }).catch((e: any) => {
        logger.error("failed to send duplicate_response event", { error: e?.message });
      });
      
      await r.xAck(cfg.requestStream, groupForPersona(persona), entryId);
      return;
    }
  
    // Check if this worker can handle this persona (has model mapping or is coordination)
    if (persona !== PERSONAS.COORDINATION && !cfg.personaModels[persona]) {
      logger.warn("received request for persona without model mapping - re-queueing", {
        persona,
        workflowId: msg.workflow_id,
        consumerId: cfg.consumerId,
        availableModels: Object.keys(cfg.personaModels)
      });
      
      // Re-queue the message by adding it back to the stream (another worker should handle it)
      await r.xAdd(cfg.requestStream, "*", fields).catch((e: any) => {
        logger.error("failed to re-queue message", { persona, error: e?.message });
      });
      
      // Acknowledge to remove from this consumer's pending list
      await r.xAck(cfg.requestStream, groupForPersona(persona), entryId);
      return;
    }
  
    const payloadObj = (() => { try { return msg.payload ? JSON.parse(msg.payload) : {}; } catch { return {}; } })();
    if (msg.repo && !payloadObj.repo) payloadObj.repo = msg.repo;
    if (msg.branch && !payloadObj.branch) payloadObj.branch = msg.branch;
    if (msg.project_id && !payloadObj.project_id) payloadObj.project_id = msg.project_id;
  
    logger.info("processing request", {
      persona,
      workflowId: msg.workflow_id,
      taskId: msg.task_id,
      intent: msg.intent,
      repo: payloadObj.repo,
      branch: payloadObj.branch,
      projectId: payloadObj.project_id
    });
  
    // Mark message as being processed (before actual processing)
    markMessageProcessed(msg.task_id, msg.corr_id, persona, msg.workflow_id);
  
  if (persona === PERSONAS.COORDINATION) {
    return await handleCoordinator(r, msg, payloadObj);
  }
  
  if (persona === PERSONAS.CONTEXT) {
        return await processContext(r, persona, msg, payloadObj, entryId);
    }
  
    return await processPersona(r, persona, msg, payloadObj, entryId);
  }

main().catch(e => { logger.error("worker fatal", { error: e }); process.exit(1); });
