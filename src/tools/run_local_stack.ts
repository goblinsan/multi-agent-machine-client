/**
 * Local Stack Runner
 * 
 * Orchestrates the full local development stack:
 * 1. Starts the dashboard backend
 * 2. Dispatches coordinator workflow
 * 3. Starts the worker to process the workflow
 * 
 * Usage:
 *   npm run local -- <project_id> [repo_url] [base_branch]
 * 
 * Example:
 *   npm run local -- 1
 *   npm run local -- 1 https://github.com/user/repo main
 * 
 * Requirements:
 *   - TRANSPORT_TYPE=local in .env
 *   - Dashboard backend available at src/dashboard-backend
 */

// Set dashboard URL BEFORE importing config
if (!process.env.DASHBOARD_BASE_URL) {
  process.env.DASHBOARD_BASE_URL = 'http://localhost:3000';
}

import { spawn, ChildProcess } from 'child_process';
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
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function printUsage() {
  console.error("Usage: npm run local -- <project_id> [repo_url] [base_branch]");
  console.error("");
  console.error("Starts the full local stack:");
  console.error("  1. Dashboard backend (http://localhost:3000)");
  console.error("  2. Coordinator workflow dispatch");
  console.error("  3. Worker to process messages");
  console.error("");
  console.error("Examples:");
  console.error("  npm run local -- 1");
  console.error("  npm run local -- 1 https://github.com/user/repo");
  console.error("  npm run local -- 1 https://github.com/user/repo main");
}

function nowIso() { return new Date().toISOString(); }

let dashboardProcess: ChildProcess | null = null;

// Cleanup function
function cleanup() {
  console.log("\n🛑 Shutting down local stack...");
  
  if (dashboardProcess) {
    console.log("   Stopping dashboard backend...");
    dashboardProcess.kill('SIGTERM');
    dashboardProcess = null;
  }
  
  console.log("✅ Local stack stopped");
}

// Handle process signals
process.on('SIGINT', () => {
  cleanup();
  process.exit(0);
});

process.on('SIGTERM', () => {
  cleanup();
  process.exit(0);
});

async function startDashboard(): Promise<void> {
  return new Promise((resolve, reject) => {
    const dashboardPath = path.join(__dirname, '../../src/dashboard-backend');
    
    console.log("📊 Starting dashboard backend...");
    console.log(`   Path: ${dashboardPath}`);
    
    dashboardProcess = spawn('npm', ['run', 'dev'], {
      cwd: dashboardPath,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let started = false;
    let startTimeout: NodeJS.Timeout;

    dashboardProcess.stdout?.on('data', (data) => {
      const output = data.toString();
      // Look for indication that server is ready
      if (output.includes('Server listening') || output.includes('listening on')) {
        if (!started) {
          started = true;
          clearTimeout(startTimeout);
          console.log("✅ Dashboard backend started");
          console.log("   URL: http://localhost:3000");
          resolve();
        }
      }
      // Optionally log dashboard output with prefix
      if (process.env.DEBUG_DASHBOARD) {
        process.stdout.write(`[dashboard] ${output}`);
      }
    });

    dashboardProcess.stderr?.on('data', (data) => {
      if (process.env.DEBUG_DASHBOARD) {
        process.stderr.write(`[dashboard] ${data}`);
      }
    });

    dashboardProcess.on('error', (error) => {
      console.error("❌ Failed to start dashboard:", error.message);
      reject(error);
    });

    dashboardProcess.on('exit', (code) => {
      if (code !== 0 && code !== null) {
        console.error(`❌ Dashboard exited with code ${code}`);
      }
    });

    // Timeout if dashboard doesn't start within 10 seconds
    startTimeout = setTimeout(() => {
      if (!started) {
        console.log("⚠️  Dashboard startup timeout (assuming it's ready)");
        resolve();
      }
    }, 10000);
  });
}

async function ensureGroups(transport: any) {
  for (const p of cfg.allowedPersonas) {
    try { 
      await transport.xGroupCreate(cfg.requestStream, groupForPersona(p), "0", { MKSTREAM: true });
    } catch (e: any) {
      if (e?.message && !e.message.includes("BUSYGROUP") && !e.message.includes("already exists")) {
        logger.warn("failed to create consumer group", { stream: cfg.requestStream, group: groupForPersona(p), error: e?.message });
      }
    }
  }
  try { 
    await transport.xGroupCreate(cfg.eventStream, `${cfg.groupPrefix}:coordinator`, "0", { MKSTREAM: true });
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
    { COUNT: 1, BLOCK: 100 }
  ).catch(async (e: any) => {
    if (e?.message && e.message.includes("NOGROUP")) {
      try {
        await transport.xGroupCreate(cfg.requestStream, groupForPersona(persona), "0", { MKSTREAM: true });
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

  if (isDuplicateMessage(msg.task_id, msg.corr_id, persona)) {
    await publishEvent(transport as any, {
      workflowId: msg.workflow_id,
      taskId: msg.task_id,
      step: msg.step,
      fromPersona: persona,
      status: "duplicate_response",
      corrId: msg.corr_id,
      result: { message: "This request has already been processed by this persona" }
    }).catch(()=>{});
    await acknowledgeRequest(transport as any, persona, entryId);
    return;
  }

  if (persona !== PERSONAS.COORDINATION && !cfg.personaModels[persona]) {
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
    intent: msg.intent
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

  console.log("\n🚀 Starting Local Stack");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

  if (cfg.transportType !== 'local') {
    console.log("⚠️  Warning: TRANSPORT_TYPE is set to '" + cfg.transportType + "'");
    console.log("   This script works best with TRANSPORT_TYPE=local");
    console.log("");
  }

  // Step 1: Start dashboard backend
  try {
    await startDashboard();
  } catch (error) {
    console.error("❌ Failed to start dashboard backend");
    cleanup();
    process.exit(1);
  }

  // Small delay to ensure dashboard is fully ready
  await new Promise(resolve => setTimeout(resolve, 2000));

  // Step 2: Initialize worker
  console.log("\n⚙️  Starting worker...");
  
  if (cfg.allowedPersonas.length === 0) {
    console.error("❌ ALLOWED_PERSONAS is empty");
    cleanup();
    process.exit(1);
  }

  const transport = await getTransport();
  
  logger.info("local stack initialized", { 
    type: cfg.transportType,
    personas: cfg.allowedPersonas,
    projectId: projectIdArg
  });

  startMessageTrackingCleanup();
  await ensureGroups(transport);

  console.log("✅ Worker ready");

  // Step 3: Dispatch coordinator workflow
  console.log("\n📤 Dispatching coordinator workflow...");
  
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
  
  console.log("✅ Workflow dispatched");
  console.log(`   Workflow ID: ${workflowId}`);
  console.log(`   Project ID: ${projectId}`);
  if (repo) console.log(`   Repository: ${repo}`);
  if (baseBranch) console.log(`   Branch: ${baseBranch}`);

  // Step 4: Process messages
  console.log("\n🔄 Processing workflow...");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("Press Ctrl+C to stop\n");

  let iterations = 0;
  const maxIdleIterations = 200;
  let idleCount = 0;

  while (true) {
    let hadMessage = false;
    
    for (const p of cfg.allowedPersonas) {
      await readOne(transport, p);
      
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
        console.log("\n✅ Workflow completed (no messages for extended period)");
        console.log(`   Total iterations: ${iterations}`);
        break;
      }
    }

    await new Promise(resolve => setTimeout(resolve, 10));
  }

  await transport.quit();
  cleanup();
  
  console.log("\n🎉 Local stack completed successfully");
}

main().catch(err => {
  console.error("\n❌ Local stack failed:", err);
  cleanup();
  process.exit(1);
});
