import { makeRedis } from "../redisClient.js";
import { cfg } from "../config.js";

const persona = process.argv[2] || "context";
const repoUrl = process.env.SEED_REPO || process.env.REPO_URL || "https://github.com/you/agent-dashboard.git";
const repoBranch = process.env.SEED_BRANCH || undefined;
const projectSlug = process.env.SEED_PROJECT || "agent-dashboard";

const payload = persona === "context"
  ? {
      repo: repoUrl,
      branch: repoBranch,
      project_slug: projectSlug,
      components: [
        { base: "api", include: ["**/*.py"], exclude: ["**/__pycache__/**","**/.venv/**"] },
        { base: "web", include: ["src/**"], exclude: ["**/node_modules/**","**/dist/**"] },
        { base: "alembic", include: ["**/*.py"], exclude: ["**/__pycache__/**"] }
      ],
      max_files: cfg.scanMaxFiles, max_bytes: cfg.scanMaxBytes, max_depth: cfg.scanMaxDepth,
      track_lines: cfg.scanTrackLines, track_hash: cfg.scanTrackHash
    }
  : { repo: repoUrl, branch: repoBranch, project_slug: projectSlug };

const msg = {
  workflow_id: "wf_demo_001",
  step: "01",
  from: "user",
  to_persona: persona,
  intent: persona === "context" ? "hydrate_project_context" : "demo_intent",
  corr_id: "c_demo_01",
  payload: JSON.stringify(payload),
  deadline_s: "180"
};

const r = await makeRedis();
const id = await r.xAdd(cfg.requestStream, "*", msg);
console.log("Seeded", id, "->", msg);
process.exit(0);
