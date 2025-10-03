import { makeRedis } from "../redisClient.js";
import { cfg } from "../config.js";

function printUsage() {
  console.error("Usage: npm run coordinator [--drain|--drain-only] <project_id> [repo_url] [base_branch]");
  console.error("  --drain       Clear request/event streams before dispatching.");
  console.error("  --drain-only  Clear streams and exit without dispatching a workflow.");
}

async function drainStreams(redis: any) {
  const streams = [cfg.requestStream, cfg.eventStream];
  for (const stream of streams) {
    try {
      const removed = await redis.del(stream);
      console.log(`Drained ${stream}`, { removed });
    } catch (error) {
      console.warn(`Failed to drain ${stream}`, error);
    }
  }
}

async function main() {
  const args = process.argv.slice(2);
  let drain = false;
  let drainOnly = false;
  const positionals: string[] = [];

  for (const arg of args) {
    if (arg === "--drain-only") {
      drain = true;
      drainOnly = true;
      continue;
    }
    if (arg === "--drain") {
      drain = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      printUsage();
      return;
    }
    positionals.push(arg);
  }

  const [projectIdArg, repoArg, baseBranchArg] = positionals;

  if (!projectIdArg && !drainOnly) {
    printUsage();
    process.exit(1);
  }

  const redis = await makeRedis();

  if (drain) {
    await drainStreams(redis);
    if (drainOnly) {
      console.log("Redis streams drained; exiting (--drain-only).");
      await redis.quit();
      return;
    }
  }

  const projectId = (projectIdArg ?? "").trim();
  const repo =
    repoArg
    || process.env.COORDINATOR_REPO
    || process.env.SEED_REPO
    || process.env.REPO_URL
    || "";
  const baseBranch = baseBranchArg || process.env.COORDINATOR_BASE_BRANCH || "";

  const payload: Record<string, unknown> = { project_id: projectId };
  if (repo) payload.repo = repo;
  if (baseBranch) payload.base_branch = baseBranch;

  const corrId = `coord-${Date.now()}`;

  const msg = {
    workflow_id: `wf_coord_${Date.now()}`,
    step: "00",
    from: "user",
    to_persona: "coordination",
    intent: "orchestrate_milestone",
    corr_id: corrId,
    payload: JSON.stringify(payload),
    deadline_s: "900",
    project_id: projectId,
    ...(repo ? { repo } : {}),
    ...(baseBranch ? { branch: baseBranch } : {})
  } as Record<string, string>;

  const entryId = await redis.xAdd(cfg.requestStream, "*", msg);
  console.log("Coordinator workflow dispatched", { entryId, workflow_id: msg.workflow_id, corr_id: corrId, project_id: projectId, repo, baseBranch });
  await redis.quit();
}

main().catch(err => {
  console.error("Failed to dispatch coordinator workflow:", err);
  process.exit(1);
});
