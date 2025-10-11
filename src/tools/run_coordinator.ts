import { makeRedis } from "../redisClient.js";
import { cfg } from "../config.js";
import { PERSONAS } from "../personaNames.js";

function printUsage() {
  console.error("Usage: npm run coordinator [--drain|--drain-only] <project_id> [repo_url] [base_branch]");
  console.error("  --drain       Clear request/event streams before dispatching.");
  console.error("  --drain-only  Clear streams and exit without dispatching a workflow.");
}

async function drainStreams(redis: any) {
  const streams = [cfg.requestStream, cfg.eventStream];
  
  for (const stream of streams) {
    try {
      console.log(`Draining stream: ${stream}`);
      
      // 1. Get all consumer groups for this stream
      let groups: any[] = [];
      try {
        groups = await redis.xInfoGroups(stream);
        console.log(`Found ${groups.length} consumer groups for ${stream}`);
      } catch (error) {
        // Stream might not exist or have no groups
        console.log(`No consumer groups found for ${stream}:`, (error as Error).message);
      }
      
      // 2. For each group, destroy it (this removes all pending messages)
      for (const group of groups) {
        try {
          await redis.xGroupDestroy(stream, group.name);
          console.log(`Destroyed consumer group: ${group.name}`);
        } catch (error) {
          console.warn(`Failed to destroy group ${group.name}:`, (error as Error).message);
        }
      }
      
      // 3. Delete the entire stream (removes all messages)
      // Note: When workers restart, they'll recreate groups from position "0",
      // which will be empty after this drain, ensuring a clean state.
      const removed = await redis.del(stream);
      console.log(`Deleted stream ${stream}`, { removed });
      
    } catch (error) {
      console.warn(`Failed to drain ${stream}`, error);
    }
  }
  
  // 4. Also clean up any persona-specific groups that might exist
  console.log("Cleaning up persona-specific consumer groups...");
  const personas = cfg.allowedPersonas || [];
  for (const persona of personas) {
    const groupName = `${cfg.groupPrefix}:${persona}`;
    try {
      // Try to destroy persona groups on request stream
      await redis.xGroupDestroy(cfg.requestStream, groupName);
      console.log(`Destroyed persona group: ${groupName}`);
    } catch (error) {
      // Group might not exist, which is fine
      console.log(`Persona group ${groupName} not found (this is normal)`);
    }
  }
  
  // 5. Clean up coordination group on event stream
  try {
    const coordGroupName = `${cfg.groupPrefix}:coordinator`;
    await redis.xGroupDestroy(cfg.eventStream, coordGroupName);
    console.log(`Destroyed coordinator group: ${coordGroupName}`);
  } catch (error) {
    console.log(`Coordinator group not found (this is normal)`);
  }
  
  console.log("Stream drain complete - all streams, groups, and pending messages cleared");
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
  to_persona: PERSONAS.COORDINATION,
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
