
import { cfg } from "./config.js";
import { makeRedis } from "./redisClient.js";
import { RequestSchema } from "./schema.js";
import { logger } from "./logger.js";
import { handleCoordinator } from "./workflows/coordinator.js";
import { processContext, processPersona } from "./process.js";

function groupForPersona(p: string) { return `${cfg.groupPrefix}:${p}`; }
function nowIso() { return new Date().toISOString(); }

async function ensureGroups(r: any) {
  for (const p of cfg.allowedPersonas) {
    try { await r.xGroupCreate(cfg.requestStream, groupForPersona(p), "$", { MKSTREAM: true }); } catch {}
  }
  try { await r.xGroupCreate(cfg.eventStream, `${cfg.groupPrefix}:coordinator`, "$", { MKSTREAM: true }); } catch {}
}


async function readOne(r: any, persona: string) {
  const res = await r.xReadGroup(groupForPersona(persona), cfg.consumerId, { key: cfg.requestStream, id: ">" }, { COUNT: 1, BLOCK: 200 }).catch(() => null);
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
  const r = await makeRedis(); await ensureGroups(r);
  logger.info("worker ready", {
    personas: cfg.allowedPersonas,
    projectBase: cfg.projectBase,
    defaultRepo: cfg.repoRoot,
    contextScan: cfg.contextScan,
    summaryMode: cfg.summaryMode,
    logFile: cfg.log.file,
    logLevel: cfg.log.level,
    logConsole: cfg.log.console
  });
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
  
    const payloadObj = (() => { try { return msg.payload ? JSON.parse(msg.payload) : {}; } catch { return {}; } })();
    if (msg.repo && !payloadObj.repo) payloadObj.repo = msg.repo;
    if (msg.branch && !payloadObj.branch) payloadObj.branch = msg.branch;
    if (msg.project_id && !payloadObj.project_id) payloadObj.project_id = msg.project_id;
  
    logger.info("processing request", {
      persona,
      workflowId: msg.workflow_id,
      intent: msg.intent,
      repo: payloadObj.repo,
      branch: payloadObj.branch,
      projectId: payloadObj.project_id
    });
  
  if (persona === "coordination") {
    return await handleCoordinator(r, msg, payloadObj);
  }
  
    if (persona === "context") {
        return await processContext(r, persona, msg, payloadObj, entryId);
    }
  
    return await processPersona(r, persona, msg, payloadObj, entryId);
  }

main().catch(e => { logger.error("worker fatal", { error: e }); process.exit(1); });
