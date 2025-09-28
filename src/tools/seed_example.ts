import { makeRedis } from "../redisClient.js";
import { cfg } from "../config.js";

const persona = process.argv[2] || "context";
const msg = {
  workflow_id: "wf_demo_001",
  step: "01",
  from: "user",
  to_persona: persona,
  intent: persona === "context" ? "hydrate_project_context" : "demo_intent",
  corr_id: "c_demo_01",
  payload: JSON.stringify({ repo: "git@github.com:you/markmugs.git" }),
  deadline_s: "120"
};

const r = await makeRedis();
const id = await r.xAdd(cfg.requestStream, "*", msg);
console.log("Seeded", id, "->", msg);
process.exit(0);
