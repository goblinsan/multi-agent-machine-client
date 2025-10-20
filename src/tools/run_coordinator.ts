import { getTransport } from "../transport/index.js";
import { cfg } from "../config.js";
import { PERSONAS } from "../personaNames.js";

function printUsage() {
  console.error("Usage: npm run coordinator [--drain|--drain-only|--nuke] <project_id> [repo_url] [base_branch]");
  console.error("  --drain       Clear messages from streams before dispatching (preserves consumer groups).");
  console.error("  --drain-only  Clear messages and exit without dispatching (preserves consumer groups).");
  console.error("  --nuke        Nuclear option: destroy streams AND consumer groups, then exit.");
  console.error("");
  console.error("Examples:");
  console.error("  npm run coordinator -- --drain-only              # Clear messages, keep groups");
  console.error("  npm run coordinator -- --nuke                    # Destroy everything");
  console.error("  npm run coordinator -- PROJECT_ID                # Send coordinator message");
}

// Clear messages from streams while preserving consumer groups
async function drainStreams(redis: any) {
  const streams = [cfg.requestStream, cfg.eventStream];
  
  for (const stream of streams) {
    try {
      console.log(`Draining messages from stream: ${stream}`);
      
      // Check if stream exists
      const len = await redis.xLen(stream).catch(() => 0);
      if (len === 0) {
        console.log(`Stream ${stream} is empty or doesn't exist`);
        continue;
      }
      
      // Delete the stream (removes all messages but not consumer groups)
      // Consumer groups will remain and can continue working when stream is recreated
      const removed = await redis.del(stream);
      console.log(`Deleted stream ${stream} - removed ${len} messages`, { removed });
      
    } catch (error) {
      console.warn(`Failed to drain ${stream}`, error);
    }
  }
  
  console.log("Stream drain complete - all messages cleared, consumer groups preserved");
}

// Nuclear option: destroy everything including consumer groups
async function nukeStreams(redis: any) {
  const streams = [cfg.requestStream, cfg.eventStream];
  
  for (const stream of streams) {
    try {
      console.log(`Nuking stream: ${stream}`);
      
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
      
      // 3. Delete the entire stream
      const removed = await redis.del(stream);
      console.log(`Deleted stream ${stream}`, { removed });
      
    } catch (error) {
      console.warn(`Failed to nuke ${stream}`, error);
    }
  }
  
  // 4. Also clean up any persona-specific groups that might exist
  console.log("Cleaning up persona-specific consumer groups...");
  const personas = cfg.allowedPersonas || [];
  for (const persona of personas) {
    const groupName = `${cfg.groupPrefix}:${persona}`;
    try {
      await redis.xGroupDestroy(cfg.requestStream, groupName);
      console.log(`Destroyed persona group: ${groupName}`);
    } catch (error) {
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
  
  console.log("Nuke complete - all streams, groups, and pending messages destroyed");
}

async function main() {
  const args = process.argv.slice(2);
  let drain = false;
  let drainOnly = false;
  let nuke = false;
  let nukeOnly = false;
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
    if (arg === "--nuke") {
      nuke = true;
      nukeOnly = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      printUsage();
      return;
    }
    positionals.push(arg);
  }

  const [projectIdArg, repoArg, baseBranchArg] = positionals;

  if (!projectIdArg && !drainOnly && !nukeOnly) {
    printUsage();
    process.exit(1);
  }

  const transport = await getTransport();
  console.log(`Using transport: ${cfg.transportType}`);

  if (nuke) {
    await nukeStreams(transport);
    if (nukeOnly) {
      console.log("Streams nuked; exiting (--nuke).");
      await transport.quit();
      return;
    }
  }

  if (drain) {
    await drainStreams(transport);
    if (drainOnly) {
      console.log("Streams drained; exiting (--drain-only).");
      await transport.quit();
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

  const entryId = await transport.xAdd(cfg.requestStream, "*", msg);
  console.log("Coordinator workflow dispatched", { entryId, workflow_id: msg.workflow_id, corr_id: corrId, project_id: projectId, repo, baseBranch });
  await transport.quit();
}

main().catch(err => {
  console.error("Failed to dispatch coordinator workflow:", err);
  process.exit(1);
});
