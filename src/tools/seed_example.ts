import { makeRedis } from "../redisClient.js";
import { cfg } from "../config.js";

const persona = process.argv[2] || "context";
const payload = persona === "context"
  ? {
      repo_root: process.env.REPO_ROOT || "./repo",
      components: [
        { base: "api", include: ["**/*.py"], exclude: ["**/__pycache__/**","**/.venv/**"] },
        { base: "web", include: ["src/**"], exclude: ["**/node_modules/**","**/dist/**"] }
      ],
      max_files: cfg.scanMaxFiles, max_bytes: cfg.scanMaxBytes, max_depth: cfg.scanMaxDepth,
      track_lines: cfg.scanTrackLines, track_hash: cfg.scanTrackHash
    }
  : { repo: "git@github.com:you/agent-dashboard.git" };

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
