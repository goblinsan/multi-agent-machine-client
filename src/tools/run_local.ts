import { spawn, ChildProcess } from "child_process";
import { getTransport } from "../transport/index.js";
import { cfg } from "../config.js";
import { PERSONAS } from "../personaNames.js";
import { PersonaConsumer } from "../personas/PersonaConsumer.js";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const dashboardPort = process.env.DASHBOARD_PORT || "3000";

if (!process.env.DASHBOARD_API_URL) {
  process.env.DASHBOARD_API_URL = `http://localhost:${dashboardPort}`;
}

if (!process.env.DASHBOARD_BASE_URL) {
  process.env.DASHBOARD_BASE_URL = `http://localhost:${dashboardPort}`;
}

let dashboardProcess: ChildProcess | null = null;
let personaConsumer: PersonaConsumer | null = null;
let isShuttingDown = false;

function printUsage() {
  console.error(
    "Usage: npm run local -- <project_id> [repo_url] [base_branch] [flags]",
  );
  console.error("");
  console.error("Examples:");
  console.error("  npm run local -- 1");
  console.error("  npm run local -- 1 git@github.com:user/repo.git");
  console.error("  npm run local -- 1 git@github.com:user/repo.git develop");
  console.error("  npm run local -- 1 . . --force-rescan");
  console.error("");
  console.error("Flags:");
  console.error("  --force-rescan          Force context rescan (ignore cache)");
  console.error("");
  console.error("Environment:");
  console.error("  TRANSPORT_TYPE=local    (recommended for single-process)");
  console.error("  PROJECT_BASE=<path>     (where to clone/find projects)");
}

async function startPersonaConsumers(transport: any): Promise<void> {
  if (cfg.transportType !== "local") {
    console.log("Skipping persona consumers (not using local transport)");
    return;
  }

  if (cfg.allowedPersonas.length === 0) {
    console.log("No personas configured in ALLOWED_PERSONAS");
    return;
  }

  console.log("Starting persona consumers for local transport...");
  console.log(`Allowed personas: ${cfg.allowedPersonas.join(", ")}`);

  personaConsumer = new PersonaConsumer(transport);

  await personaConsumer.start({
    personas: cfg.allowedPersonas,
  });

  console.log("Persona consumers started");
}

async function startDashboard(): Promise<void> {
  const dashboardPath = path.join(__dirname, "..", "dashboard-backend");
  const dashboardUrl = process.env.DASHBOARD_API_URL || `http://localhost:${dashboardPort}`;

  try {
    const response = await fetch(`${dashboardUrl}/health`, {
      method: "GET",
      signal: AbortSignal.timeout(1000),
    });

    if (response.ok) {
      console.log(`Dashboard backend already running at ${dashboardUrl}`);
      return;
    }
  } catch (error) {
    const reason =
      error instanceof Error ? error.message : String(error ?? "unknown");
    console.log(
      `Dashboard health check unavailable, starting local backend (${reason})`,
    );
  }

  if (!fs.existsSync(path.join(dashboardPath, "node_modules"))) {
    console.log("Installing dashboard backend dependencies...");
    await new Promise<void>((resolve, reject) => {
      const installProcess = spawn("npm", ["install"], {
        cwd: dashboardPath,
        stdio: ["ignore", "pipe", "pipe"],
        shell: true,
      });

      installProcess.stdout?.on("data", (data) => {
        console.log(`[dashboard-install] ${data.toString().trim()}`);
      });

      installProcess.stderr?.on("data", (data) => {
        console.error(`[dashboard-install] ${data.toString().trim()}`);
      });

      installProcess.on("error", (error) => reject(error));

      installProcess.on("exit", (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`npm install exited with code ${code}`));
        }
      });
    });
  }

  return new Promise((resolve, reject) => {
    console.log("Starting dashboard backend...");

    dashboardProcess = spawn("npm", ["run", "dev"], {
      cwd: dashboardPath,
      stdio: ["ignore", "pipe", "pipe"],
      shell: true,
      env: {
        ...process.env,
        PORT: dashboardPort,
      },
    });

    let startupComplete = false;
    let settled = false;

    const timeoutMs = 10000;
    const timeoutId = setTimeout(() => {
      if (!startupComplete) {
        const err = new Error(
          `Dashboard failed to start within ${timeoutMs / 1000}s window`,
        );
        console.error(err.message);
        if (!settled) {
          settled = true;
          reject(err);
        }
      }
    }, timeoutMs);

    dashboardProcess.stdout?.on("data", (data) => {
      const output = data.toString();
      console.log(`[dashboard] ${output.trim()}`);

      if (
        !startupComplete &&
        (output.includes("listening") || output.includes("started"))
      ) {
        startupComplete = true;
        console.log("Dashboard backend ready");
        settled = true;
        clearTimeout(timeoutId);
        resolve();
      }
    });

    dashboardProcess.stderr?.on("data", (data) => {
      console.error(`[dashboard] ${data.toString().trim()}`);
    });

    dashboardProcess.on("error", (error) => {
      console.error("Failed to start dashboard:", error);
      if (!settled) {
        settled = true;
        reject(error);
      }
    });

    dashboardProcess.on("exit", (code) => {
      if (!settled && !isShuttingDown) {
        clearTimeout(timeoutId);
        settled = true;
        reject(new Error(`Dashboard process exited with code ${code}`));
        return;
      }

      if (!isShuttingDown) {
        console.log(`Dashboard process exited with code ${code}`);
      }
    });
  });
}

async function shutdown(transport: any) {
  if (isShuttingDown) return;
  isShuttingDown = true;

  console.log("\nShutting down...");

  if (personaConsumer) {
    console.log("Stopping persona consumers...");
    await personaConsumer.stop();
    personaConsumer = null;
  }

  if (dashboardProcess) {
    console.log("Stopping dashboard backend...");
    dashboardProcess.kill("SIGTERM");
    dashboardProcess = null;
  }

  try {
    await transport.quit();
    console.log("Transport disconnected");
  } catch (error) {
    console.error("Error disconnecting transport:", error);
  }

  console.log("Shutdown complete");
  process.exit(0);
}

async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    printUsage();
    process.exit(1);
  }

  const flags = args.filter((arg) => arg.startsWith("--"));
  const positionalArgs = args.filter((arg) => !arg.startsWith("--"));

  const forceRescan = flags.includes("--force-rescan");

  const [projectIdArg, repoArg, baseBranchArg] = positionalArgs;

  if (!projectIdArg) {
    console.error("Error: project_id is required");
    printUsage();
    process.exit(1);
  }

  if (cfg.transportType !== "local") {
    console.warn(
      `Warning: TRANSPORT_TYPE is '${cfg.transportType}', but 'local' is recommended for single-process development`,
    );
  }

  const projectId = projectIdArg.trim();
  const repo =
    repoArg && repoArg !== "."
      ? repoArg
      : process.env.COORDINATOR_REPO ||
        process.env.SEED_REPO ||
        process.env.REPO_URL ||
        "";
  const baseBranch =
    baseBranchArg && baseBranchArg !== "."
      ? baseBranchArg
      : process.env.COORDINATOR_BASE_BRANCH || "";

  console.log("=== Local Development Stack ===");
  console.log(`Transport: ${cfg.transportType}`);
  console.log(`Project ID: ${projectId}`);
  if (repo) console.log(`Repository: ${repo}`);
  if (baseBranch) console.log(`Base Branch: ${baseBranch}`);
  if (forceRescan) console.log(`Force Rescan: enabled`);
  console.log("");

  try {
    await startDashboard();
  } catch (error) {
    console.error("Failed to start dashboard backend:", error);
    process.exit(1);
  }

  const transport = await getTransport();
  console.log(`Transport connected: ${cfg.transportType}`);

  process.on("SIGINT", () => shutdown(transport));
  process.on("SIGTERM", () => shutdown(transport));

  try {
    await startPersonaConsumers(transport);
  } catch (error) {
    console.error("Failed to start persona consumers:", error);
    process.exit(1);
  }

  const payload: Record<string, unknown> = { project_id: projectId };
  if (repo) payload.repo = repo;
  if (baseBranch) payload.base_branch = baseBranch;
  if (forceRescan) payload.force_rescan = true;

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
    ...(baseBranch ? { branch: baseBranch } : {}),
  } as Record<string, string>;

  console.log("Dispatching coordinator workflow...", {
    workflowId,
    projectId,
    corrId,
  });

  const entryId = await transport.xAdd(cfg.requestStream, "*", msg);
  console.log(`Coordinator message dispatched: ${entryId}`);
  console.log(
    "Local stack running. PersonaConsumer will handle coordination requests.",
  );
  console.log("Press Ctrl+C to shutdown.\n");

  await new Promise(() => {});
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
