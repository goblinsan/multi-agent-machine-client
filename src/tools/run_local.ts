import { getTransport } from "../transport/index.js";
import { cfg } from "../config.js";
import { PERSONAS } from "../personaNames.js";
import { PersonaConsumer } from "../personas/PersonaConsumer.js";
import { acquireSingleInstanceLock } from "../util/singleInstanceLock.js";

const dashboardPort = process.env.DASHBOARD_PORT || "3000";

if (!process.env.DASHBOARD_API_URL) {
  process.env.DASHBOARD_API_URL = `http://localhost:${dashboardPort}`;
}

if (!process.env.DASHBOARD_BASE_URL) {
  process.env.DASHBOARD_BASE_URL = `http://localhost:${dashboardPort}`;
}

let personaConsumer: PersonaConsumer | null = null;
let isShuttingDown = false;

async function verifyDashboardArtifactApi(dashboardUrl: string): Promise<void> {
  const url = `${dashboardUrl.replace(/\/$/, "")}/projects/0/artifacts?latest=1&meta_only=1`;

  let response: Response;
  try {
    response = await fetch(url, {
      method: "GET",
      signal: AbortSignal.timeout(1000),
    });
  } catch (error) {
    const reason =
      error instanceof Error ? error.message : String(error ?? "unknown");
    throw new Error(`dashboard artifact API check failed: ${reason}`);
  }

  if (response.ok) return;

  let body = "";
  try {
    body = await response.text();
  } catch {
    body = "";
  }

  throw new Error(
    `dashboard artifact API check failed: GET /projects/0/artifacts returned ${response.status}${body ? ` ${body}` : ""}`,
  );
}

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

async function verifyDashboard(): Promise<void> {
  const dashboardUrl = (
    process.env.DASHBOARD_API_URL || `http://localhost:${dashboardPort}`
  ).replace(/\/$/, "");

  let response: Response;
  try {
    response = await fetch(`${dashboardUrl}/health`, {
      method: "GET",
      signal: AbortSignal.timeout(2000),
    });
  } catch (error) {
    const reason =
      error instanceof Error ? error.message : String(error ?? "unknown");
    throw new Error(
      `Dashboard not reachable at ${dashboardUrl} (${reason}). Set DASHBOARD_API_URL and DASHBOARD_BASE_URL to the deployed project-dashboard service.`,
    );
  }

  if (!response.ok) {
    throw new Error(
      `Dashboard health check at ${dashboardUrl} returned ${response.status}. Ensure the project-dashboard service is running.`,
    );
  }

  await verifyDashboardArtifactApi(dashboardUrl);
  console.log(
    `Dashboard reachable at ${dashboardUrl} with artifact API available`,
  );
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

  console.log("Waiting for in-flight workflow steps to settle...");
  await new Promise((resolve) => setTimeout(resolve, 3000));

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

  const lock = acquireSingleInstanceLock(cfg.projectBase);
  if (!lock.acquired) {
    console.error(
      `Another machine-client instance is already running (pid ${lock.holderPid}, lock ${lock.lockPath}).`,
    );
    console.error(
      "Concurrent instances share the same repos, dashboard, and log file and will corrupt each other's runs.",
    );
    console.error(
      `Stop it first (kill ${lock.holderPid}) or wait for it to finish.`,
    );
    process.exit(1);
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
    await verifyDashboard();
  } catch (error) {
    console.error("Dashboard verification failed:", error);
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
