import "dotenv/config";

function bool(v: string | undefined, def=false) {
  if (v === undefined) return def;
  return ["1","true","yes","on"].includes(v.toLowerCase());
}

export const cfg = {
  redisUrl: process.env.REDIS_URL || "redis://localhost:6379",
  redisPassword: process.env.REDIS_PASSWORD || undefined,
  requestStream: process.env.REQUEST_STREAM || "agent.requests",
  eventStream: process.env.EVENT_STREAM || "agent.events",
  groupPrefix: process.env.GROUP_PREFIX || "cg",
  consumerId: process.env.CONSUMER_ID || "worker-1",
  allowedPersonas: (process.env.ALLOWED_PERSONAS || "").split(",").map(s => s.trim()).filter(Boolean),
  lmsBaseUrl: process.env.LMS_BASE_URL || "http://127.0.0.1:1234",
  personaModels: JSON.parse(process.env.PERSONA_MODELS_JSON || "{}"),
  dashboardBaseUrl: process.env.DASHBOARD_BASE_URL || "http://localhost:8787",
  dashboardApiKey: process.env.DASHBOARD_API_KEY || "dev",

  applyEdits: bool(process.env.APPLY_EDITS, false),
  allowedEditPersonas: (process.env.ALLOWED_EDIT_PERSONAS || "lead-engineer,devops,ui-engineer,context").split(",").map(s=>s.trim()).filter(Boolean),
  repoRoot: process.env.REPO_ROOT || "./repo",
  maxFileBytes: Number(process.env.MAX_FILE_BYTES || 524288),
  allowedExts: (process.env.ALLOWED_EXTS || ".ts,.tsx,.js,.jsx,.py,.md,.json,.yml,.yaml,.css,.html,.sh,.bat").split(",").map(s=>s.trim()).filter(Boolean),

  // Context scanner feature flags & defaults
  contextScan: ["1","true","yes","on"].includes((process.env.CONTEXT_SCAN||"").toLowerCase()),
  scanInclude: (process.env.SCAN_INCLUDE || "src/**,app/**,tests/**").split(",").map(s=>s.trim()).filter(Boolean),
  scanExclude: (process.env.SCAN_EXCLUDE || "**/node_modules/**,**/.git/**,**/dist/**").split(",").map(s=>s.trim()).filter(Boolean),
  scanMaxFiles: Number(process.env.SCAN_MAX_FILES || 5000),
  scanMaxBytes: Number(process.env.SCAN_MAX_BYTES || 100000000),
  scanMaxDepth: Number(process.env.SCAN_MAX_DEPTH || 12),
  scanTrackLines: ["1","true","yes","on"].includes((process.env.SCAN_TRACK_LINES||"true").toLowerCase()),
  scanTrackHash: ["1","true","yes","on"].includes((process.env.SCAN_TRACK_HASH||"true").toLowerCase())
};
