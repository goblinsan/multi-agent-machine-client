import { makeRedis } from "../redisClient.js";
import { cfg } from "../config.js";

async function main() {
  const [projectIdArg, repoArg, baseBranchArg] = process.argv.slice(2);
  if (!projectIdArg) {
    console.error("Usage: npm run coordinator <project_id> [repo_url] [base_branch]");
    process.exit(1);
  }

  const projectId = projectIdArg.trim();
  const repo = repoArg || process.env.COORDINATOR_REPO || process.env.SEED_REPO || process.env.REPO_URL || "";
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

  const redis = await makeRedis();
  const entryId = await redis.xAdd(cfg.requestStream, "*", msg);
  console.log("Coordinator workflow dispatched", { entryId, workflow_id: msg.workflow_id, corr_id: corrId, project_id: projectId, repo, baseBranch });
  await redis.quit();
}

main().catch(err => {
  console.error("Failed to dispatch coordinator workflow:", err);
  process.exit(1);
});
