import "dotenv/config";
import path from "path";

function bool(v: string | undefined, def=false) {
  if (v === undefined) return def;
  return ["1","true","yes","on"].includes(v.toLowerCase());
}

function splitCsv(value: string | undefined, fallback: string[]): string[] {
  if (!value) return fallback;
  return value.split(",").map(s => s.trim()).filter(Boolean);
}

function jsonOr<T>(value: string | undefined, fallback: T): T {
  if (!value) return fallback;
  try { return JSON.parse(value) as T; } catch { return fallback; }
}

const projectBaseRaw = process.env.PROJECT_BASE || process.env.REPO_ROOT || "./repo";
const projectBase = path.resolve(projectBaseRaw);
const defaultRepoName = (process.env.DEFAULT_REPO_NAME || "active").trim() || "active";
const repoRoot = process.env.REPO_ROOT ? path.resolve(process.env.REPO_ROOT) : path.join(projectBase, defaultRepoName);

const maxFileBytes = Number(process.env.MAX_FILE_BYTES || 524288);
const allowedExts = splitCsv(process.env.ALLOWED_EXTS || ".ts,.tsx,.js,.jsx,.py,.md,.json,.yml,.yaml,.css,.html,.sh,.bat", [])
  .map(s => s.toLowerCase())
  .map(s => s.startsWith(".") ? s : "." + s)
  .filter(Boolean);

const gitToken = process.env.GIT_AUTH_TOKEN || "";
const gitPassword = process.env.GIT_AUTH_PASSWORD || "";
const gitCredentialsPath = (() => {
  const manual = process.env.GIT_CREDENTIALS_PATH;
  if (manual) return path.resolve(manual);
  if (gitToken || gitPassword) return path.join(projectBase, ".git-credentials");
  return "";
})();

const logLevelRaw = (process.env.LOG_LEVEL || "info").toLowerCase();
const logConsole = bool(process.env.LOG_CONSOLE, true);
const logFile = (() => {
  const custom = process.env.LOG_FILE;
  if (custom && custom.trim().length) return path.resolve(custom);
  return path.resolve(projectBase, "machine-client.log");
})();

const dashboardContextEndpoint = (() => {
  const raw = process.env.DASHBOARD_CONTEXT_ENDPOINT;
  if (raw && raw.trim().length) return raw.trim();
  return "/v1/context/upsert";
})();

const gitUserName = (process.env.GIT_USER_NAME || "machine-client").trim();
const gitUserEmail = (process.env.GIT_USER_EMAIL || "machine-client@example.com").trim();


export const cfg = {
  redisUrl: process.env.REDIS_URL || "redis://localhost:6379",
  redisPassword: process.env.REDIS_PASSWORD || undefined,
  requestStream: process.env.REQUEST_STREAM || "agent.requests",
  eventStream: process.env.EVENT_STREAM || "agent.events",
  groupPrefix: process.env.GROUP_PREFIX || "cg",
  consumerId: process.env.CONSUMER_ID || "worker-1",
  allowedPersonas: splitCsv(process.env.ALLOWED_PERSONAS, []),
  lmsBaseUrl: process.env.LMS_BASE_URL || "http://127.0.0.1:1234",
  personaModels: jsonOr(process.env.PERSONA_MODELS_JSON, {} as Record<string,string>),
  dashboardBaseUrl: process.env.DASHBOARD_BASE_URL || "http://localhost:8787",
  dashboardApiKey: process.env.DASHBOARD_API_KEY || "dev",
  dashboardContextEndpoint,

  applyEdits: bool(process.env.APPLY_EDITS, false),
  allowedEditPersonas: splitCsv(process.env.ALLOWED_EDIT_PERSONAS || "lead-engineer,devops,ui-engineer,context", []),
  projectBase,
  defaultRepoName,
  repoRoot,
  maxFileBytes,
  allowedExts,

  // Context scanner feature flags & defaults
  contextScan: bool(process.env.CONTEXT_SCAN, false),
  scanInclude: splitCsv(process.env.SCAN_INCLUDE || "src/**,app/**,tests/**", []),
  scanExclude: splitCsv(process.env.SCAN_EXCLUDE || "**/node_modules/**,**/.git/**,**/dist/**", []),
  scanMaxFiles: Number(process.env.SCAN_MAX_FILES || 5000),
  scanMaxBytes: Number(process.env.SCAN_MAX_BYTES || 100000000),
  scanMaxDepth: Number(process.env.SCAN_MAX_DEPTH || 12),
  scanTrackLines: bool(process.env.SCAN_TRACK_LINES, true),
  scanTrackHash: bool(process.env.SCAN_TRACK_HASH, true),

  // Multi-component scanning
  scanComponents: jsonOr(process.env.SCAN_COMPONENTS, null as null | any),

  // Summary writing mode after model call
  summaryMode: (process.env.SUMMARY_MODE || "both").toLowerCase(),

  git: {
    defaultBranch: (process.env.GIT_DEFAULT_BRANCH || "main").trim() || "main",
    sshKeyPath: process.env.GIT_SSH_KEY_PATH ? path.resolve(process.env.GIT_SSH_KEY_PATH) : "",
    username: process.env.GIT_AUTH_USERNAME || "",
    password: gitPassword,
    token: gitToken,
    credentialsPath: gitCredentialsPath,
    userName: gitUserName,
    userEmail: gitUserEmail
  },

  log: {
    level: logLevelRaw,
    file: logFile,
    console: logConsole
  }
};
