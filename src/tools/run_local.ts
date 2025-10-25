#!/usr/bin/env node
/**
 * Local Development Orchestrator
 * 
 * Runs the full stack in a single process for local development:
 * 1. Starts the dashboard backend (port 3000)
 * 2. Dispatches coordinator trigger message
 * 3. Processes workflows using transport abstraction
 * 
 * Usage:
 *   npm run local -- <project_id> [repo_url] [base_branch]
 * 
 * Example:
 *   npm run local -- 1
 *   npm run local -- 1 git@github.com:user/repo.git main
 * 
 * Requirements:
 *   - TRANSPORT_TYPE=local (recommended for single-process dev)
 *   - Dashboard backend at src/dashboard-backend
 */

import { spawn, ChildProcess } from 'child_process';
import { getTransport } from "../transport/index.js";
import { cfg } from "../config.js";
import { PERSONAS } from "../personaNames.js";
import { logger } from "../logger.js";
import { handleCoordinator } from "../workflows/WorkflowCoordinator.js";
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let dashboardProcess: ChildProcess | null = null;
let isShuttingDown = false;

function printUsage() {
  console.error("Usage: npm run local -- <project_id> [repo_url] [base_branch]");
  console.error("");
  console.error("Examples:");
  console.error("  npm run local -- 1");
  console.error("  npm run local -- 1 git@github.com:user/repo.git");
  console.error("  npm run local -- 1 git@github.com:user/repo.git develop");
  console.error("");
  console.error("Environment:");
  console.error("  TRANSPORT_TYPE=local    (recommended for single-process)");
  console.error("  PROJECT_BASE=<path>     (where to clone/find projects)");
}

/**
 * Start the dashboard backend process
 */
async function startDashboard(): Promise<void> {
  return new Promise((resolve, reject) => {
    const dashboardPath = path.join(__dirname, '..', 'dashboard-backend');
    
    console.log('Starting dashboard backend...');
    
    dashboardProcess = spawn('npm', ['run', 'dev'], {
      cwd: dashboardPath,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: true
    });

    let startupComplete = false;

    dashboardProcess.stdout?.on('data', (data) => {
      const output = data.toString();
      console.log(`[dashboard] ${output.trim()}`);
      
      // Look for server startup message
      if (!startupComplete && (output.includes('listening') || output.includes('started'))) {
        startupComplete = true;
        console.log('Dashboard backend ready');
        resolve();
      }
    });

    dashboardProcess.stderr?.on('data', (data) => {
      console.error(`[dashboard] ${data.toString().trim()}`);
    });

    dashboardProcess.on('error', (error) => {
      console.error('Failed to start dashboard:', error);
      reject(error);
    });

    dashboardProcess.on('exit', (code) => {
      if (!isShuttingDown) {
        console.log(`Dashboard process exited with code ${code}`);
      }
    });

    // Give it a few seconds to start up
    setTimeout(() => {
      if (!startupComplete) {
        console.log('Dashboard startup timeout - proceeding anyway');
        resolve();
      }
    }, 3000);
  });
}

/**
 * Process coordinator messages in a loop
 */
async function processCoordinatorLoop(transport: any, initialMessage: any): Promise<void> {
  console.log('Starting coordinator message processing...');
  
  // First, handle the initial coordinator message we dispatched
  const initialPayload = JSON.parse(initialMessage.payload || '{}');
  
  try {
    await handleCoordinator(transport, transport, initialMessage, initialPayload);
    console.log('Initial coordinator workflow completed');
  } catch (error: any) {
    console.error('Error processing initial coordinator message:', error.message);
  }

  // For now, exit after processing the initial message
  // In the future, this could be extended to stay running and process additional messages
  console.log('Coordinator processing complete');
}

/**
 * Cleanup and shutdown
 */
async function shutdown(transport: any) {
  if (isShuttingDown) return;
  isShuttingDown = true;

  console.log('\nShutting down...');

  // Stop dashboard
  if (dashboardProcess) {
    console.log('Stopping dashboard backend...');
    dashboardProcess.kill('SIGTERM');
    dashboardProcess = null;
  }

  // Disconnect transport
  try {
    await transport.quit();
    console.log('Transport disconnected');
  } catch (error) {
    console.error('Error disconnecting transport:', error);
  }

  console.log('Shutdown complete');
  process.exit(0);
}

async function main() {
  const args = process.argv.slice(2);
  
  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    printUsage();
    process.exit(1);
  }

  const [projectIdArg, repoArg, baseBranchArg] = args;

  if (!projectIdArg) {
    console.error('Error: project_id is required');
    printUsage();
    process.exit(1);
  }

  // Validate TRANSPORT_TYPE
  if (cfg.transportType !== 'local') {
    console.warn(`Warning: TRANSPORT_TYPE is '${cfg.transportType}', but 'local' is recommended for single-process development`);
  }

  const projectId = projectIdArg.trim();
  const repo = repoArg || process.env.COORDINATOR_REPO || process.env.SEED_REPO || process.env.REPO_URL || "";
  const baseBranch = baseBranchArg || process.env.COORDINATOR_BASE_BRANCH || "";

  console.log('=== Local Development Stack ===');
  console.log(`Transport: ${cfg.transportType}`);
  console.log(`Project ID: ${projectId}`);
  if (repo) console.log(`Repository: ${repo}`);
  if (baseBranch) console.log(`Base Branch: ${baseBranch}`);
  console.log('');

  // Step 1: Start dashboard backend
  try {
    await startDashboard();
  } catch (error) {
    console.error('Failed to start dashboard backend:', error);
    process.exit(1);
  }

  // Step 2: Get transport connection
  const transport = await getTransport();
  console.log(`Transport connected: ${cfg.transportType}`);

  // Setup graceful shutdown
  process.on('SIGINT', () => shutdown(transport));
  process.on('SIGTERM', () => shutdown(transport));

  // Step 3: Dispatch coordinator message
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

  console.log('Dispatching coordinator workflow...', {
    workflowId,
    projectId,
    corrId
  });

  const entryId = await transport.xAdd(cfg.requestStream, "*", msg);
  console.log(`Coordinator message dispatched: ${entryId}`);

  // Step 4: Process the coordinator workflow
  try {
    await processCoordinatorLoop(transport, msg);
  } catch (error: any) {
    console.error('Error in coordinator loop:', error.message);
  }

  // Cleanup
  await shutdown(transport);
}

main().catch(err => {
  console.error("Fatal error:", err);
  process.exit(1);
});
