/**
 * Local Workflow Runner
 * 
 * Runs the worker and coordinator in the same process for local development.
 * This is necessary when using TRANSPORT_TYPE=local because LocalTransport
 * is in-memory and cannot communicate across processes.
 * 
 * Usage:
 *   npx tsx src/tools/run_local_workflow.ts <project_id> [repo_url] [base_branch]
 * 
 * Example:
 *   npx tsx src/tools/run_local_workflow.ts 1
 */

import { getTransport } from "../transport/index.js";
import { cfg } from "../config.js";
import { PERSONAS } from "../personaNames.js";
import { logger } from "../logger.js";
import { RequestSchema } from "../schema.js";
import { handleCoordinator } from "../workflows/WorkflowCoordinator.js";
import { processContext, processPersona } from "../process.js";
import { isDuplicateMessage, markMessageProcessed, startMessageTrackingCleanup } from "../messageTracking.js";
import { publishEvent } from "../redis/eventPublisher.js";
import { acknowledgeRequest, groupForPersona } from "../redis/requestHandlers.js";

function printUsage() {
  console.error("Usage: npx tsx src/tools/run_local_workflow.ts <project_id> [repo_url] [base_branch]");
  console.error("");
  console.error("This script runs the worker and coordinator in the same process for local development.");
  console.error("It's designed for use with TRANSPORT_TYPE=local.");
  console.error("");
  console.error("Examples:");
  console.error("  npx tsx src/tools/run_local_workflow.ts 1");
  console.error("  npx tsx src/tools/run_local_workflow.ts 1 https://github.com/user/repo");
}

function nowIso() { return new Date().toISOString(); }

async function ensureGroups(transport: any) {
  for (const p of cfg.allowedPersonas) {
    try { 
      await transport.xGroupCreate(cfg.requestStream, groupForPersona(p), "0", { MKSTREAM: true });
      logger.debug("created consumer group", { stream: cfg.requestStream, group: groupForPersona(p), startFrom: "0" });
    } catch (e: any) {
      if (e?.message && !e.message.includes("BUSYGROUP") && !e.message.includes("already exists")) {
        logger.warn("failed to create consumer group", { stream: cfg.requestStream, group: groupForPersona(p), error: e?.message });
      }
    }
  }
  try { 
    await transport.xGroupCreate(cfg.eventStream, `${cfg.groupPrefix}:coordinator`, "0", { MKSTREAM: true });
    logger.debug("created coordinator group", { stream: cfg.eventStream, group: `${cfg.groupPrefix}:coordinator`, startFrom: "0" });
  } catch (e: any) {
    if (e?.message && !e.message.includes("BUSYGROUP") && !e.message.includes("already exists")) {
      logger.warn("failed to create coordinator group", { stream: cfg.eventStream, group: `${cfg.groupPrefix}:coordinator`, error: e?.message });
    }
  }
}

async function readOne(transport: any, persona: string) {
  const res = await transport.xReadGroup(
    groupForPersona(persona),
    cfg.consumerId,
    { key: cfg.requestStream, id: ">" },
    { COUNT: 1, BLOCK: 100 }  // Shorter timeout for local processing
  ).catch(async (e: any) => {
    if (e?.message && e.message.includes("NOGROUP")) {
      logger.info("consumer group missing, recreating", { persona, group: groupForPersona(persona) });
      try {
        await transport.xGroupCreate(cfg.requestStream, groupForPersona(persona), "0", { MKSTREAM: true });
        logger.info("consumer group recreated", { persona, group: groupForPersona(persona) });
        return await transport.xReadGroup(
          groupForPersona(persona),
          cfg.consumerId,
          { key: cfg.requestStream, id: ">" },
          { COUNT: 1, BLOCK: 100 }
        ).catch(() => null);
      } catch (createErr: any) {
        logger.error("failed to recreate consumer group", { persona, error: createErr?.message });
      }
    }
    return null;
  });
  
  if (!res) return;
  
  for (const stream of Object.values(res) as any[]) {
    for (const msg of stream.messages) {
      const id = msg.id;
      const fields = msg.fields;
      await processOne(transport, persona, id, fields).catch(async (e: any) => {
        logger.error(`worker error`, { persona, error: e, entryId: id });
        await publishEvent(transport as any, {
          workflowId: fields?.workflow_id ?? "",
          step: fields?.step,
          fromPersona: persona,
          status: "error",
          corrId: fields?.corr_id,
          error: String(e?.message || e)
        }).catch(()=>{});
        await acknowledgeRequest(transport as any, persona, id, true);
      });
    }
  }
}

async function processOne(transport: any, persona: string, entryId: string, fields: Record<string,string>) {
  const parsed = RequestSchema.safeParse(fields);
  if (!parsed.success) { await acknowledgeRequest(transport as any, persona, entryId); return; }
  const msg = parsed.data;
  if (msg.to_persona !== persona) { await acknowledgeRequest(transport as any, persona, entryId); return; }

  // Check for duplicate messages
  if (isDuplicateMessage(msg.task_id, msg.corr_id, persona)) {
    logger.info("Duplicate message detected, sending duplicate_response", {
      persona,
      workflowId: msg.workflow_id,
      taskId: msg.task_id,
      corrId: msg.corr_id
    });
    
    await publishEvent(transport as any, {
      workflowId: msg.workflow_id,
      taskId: msg.task_id,
      step: msg.step,
      fromPersona: persona,
      status: "duplicate_response",
      corrId: msg.corr_id,
      result: {
        message: "This request has already been processed by this persona",
        originalTaskId: msg.task_id,
        originalCorrId: msg.corr_id
      }
    }).catch((e: any) => {
      logger.error("failed to send duplicate_response event", { error: e?.message });
    });
    
    await acknowledgeRequest(transport as any, persona, entryId);
    return;
  }

  // Check if this worker can handle this persona
  if (persona !== PERSONAS.COORDINATION && !cfg.personaModels[persona]) {
    logger.warn("received request for persona without model mapping - re-queueing", {
      persona,
      workflowId: msg.workflow_id,
      consumerId: cfg.consumerId,
      availableModels: Object.keys(cfg.personaModels)
    });
    
    await transport.xAdd(cfg.requestStream, "*", fields).catch((e: any) => {
      logger.error("failed to re-queue message", { persona, error: e?.message });
    });
    
    await acknowledgeRequest(transport as any, persona, entryId);
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

  markMessageProcessed(msg.task_id, msg.corr_id, persona, msg.workflow_id);

  if (persona === PERSONAS.COORDINATION) {
    return await handleCoordinator(transport as any, {}, msg, payloadObj);
  }

  if (persona === PERSONAS.CONTEXT) {
    return await processContext(transport as any, persona, msg, payloadObj, entryId);
  }

  return await processPersona(transport as any, persona, msg, payloadObj, entryId);
}

async function main() {
  const args = process.argv.slice(2);
  
  if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
    printUsage();
    process.exit(args.length === 0 ? 1 : 0);
  }

  const [projectIdArg, repoArg, baseBranchArg] = args;

  if (cfg.transportType !== 'local') {
    console.error("⚠️  Warning: This script is designed for TRANSPORT_TYPE=local");
    console.error("   Your current setting is: " + cfg.transportType);
    console.error("   For distributed workflows, use: npm run dev + npm run coordinator");
    console.error("");
  }

  if (cfg.allowedPersonas.length === 0) {
    logger.error("ALLOWED_PERSONAS is empty; nothing to do.");
    process.exit(1);
  }

  // Get shared transport instance
  const transport = await getTransport();
  
  logger.info("local workflow runner started", { 
    type: cfg.transportType,
    personas: cfg.allowedPersonas
  });

  // Start message tracking cleanup
  startMessageTrackingCleanup();

  // Create consumer groups
  await ensureGroups(transport);

  logger.info("worker ready", {
    personas: cfg.allowedPersonas,
    projectBase: cfg.projectBase
  });

  // Dispatch coordinator workflow
  const projectId = projectIdArg.trim();
  const repo = repoArg || process.env.COORDINATOR_REPO || process.env.SEED_REPO || process.env.REPO_URL || "";
  const baseBranch = baseBranchArg || process.env.COORDINATOR_BASE_BRANCH || "";

  const payload: Record<string, unknown> = { project_id: projectId };
  if (repo) payload.repo = repo;
  if (baseBranch) payload.base_branch = baseBranch;

  const corrId = `coord-${Date.now()}`;
  const workflowId = `wf_coord_${Date.now()}`;

  const msg = {
    workflow_id: workflowId,
    step: "00",
    from: "user",
    to_persona: PERSONAS.COORDINATION,
    intent: "orchestrate_milestone",
    corr_id: corrId,
    payload: JSON.stringify(payload),
    deadline_s: "900",
    project_id: projectId,
    ...(repo ? { repo } : {}),
    ...(baseBranch ? { branch: baseBranch } : {})
  } as Record<string, string>;

  const entryId = await transport.xAdd(cfg.requestStream, "*", msg);
  logger.info("coordinator workflow dispatched", { 
    entryId, 
    workflow_id: workflowId, 
    corr_id: corrId, 
    project_id: projectId, 
    repo, 
    baseBranch 
  });

  // Process messages in a loop
  logger.info("starting message processing loop");
  let iterations = 0;
  const maxIdleIterations = 100; // Exit after 100 iterations with no messages
  let idleCount = 0;

  while (true) {
    let hadMessage = false;
    
    for (const p of cfg.allowedPersonas) {
      await readOne(transport, p);
      
      // Check if we processed anything (simplified check)
      const currentLen = await transport.xLen(cfg.requestStream).catch(() => 0);
      if (currentLen > 0) {
        hadMessage = true;
        idleCount = 0;
      }
    }
    
    iterations++;
    
    if (!hadMessage) {
      idleCount++;
      if (idleCount >= maxIdleIterations) {
        logger.info("no messages for extended period, shutting down", { 
          iterations, 
          idleCount 
        });
        break;
      }
    }

    // Small delay to prevent tight loop
    await new Promise(resolve => setTimeout(resolve, 10));
  }

  await transport.quit();
  logger.info("local workflow runner completed");
}

main().catch(err => {
  console.error("Local workflow runner failed:", err);
  process.exit(1);
});
