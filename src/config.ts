import "dotenv/config";
import path from "path";

// Expands a leading '~' in a path to the user's home directory
function expandHome(p: string | undefined): string | undefined {
  if (!p) return p;
  return p.replace(/^~(?=$|\/|\\)/, process.env.HOME || process.env.USERPROFILE || "~");
}

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
  // Trim and strip surrounding single or double quotes to be tolerant of .env quoting
  let v = value.trim();
  if ((v.startsWith("'") && v.endsWith("'")) || (v.startsWith('"') && v.endsWith('"'))) {
    v = v.slice(1, -1);
  }
  try { return JSON.parse(v) as T; } catch { return fallback; }
}

function parseDurationMs(value: string | undefined, fallbackMs: number) {
  if (!value) return fallbackMs;
  let s = value.toString().trim();
  if (!s.length) return fallbackMs;
  // strip surrounding quotes if present
  if ((s.startsWith("'") && s.endsWith("'")) || (s.startsWith('"') && s.endsWith('"'))) s = s.slice(1, -1).trim();

  // Accept human-friendly units: ms, s, m, h (e.g. "120s", "2m", "1500ms")
  const m = s.match(/^([0-9]+(?:\.[0-9]+)?)\s*(ms|s|m|min|h)?$/i);
  if (m) {
    const num = Number(m[1]);
    if (!Number.isFinite(num) || num <= 0) return fallbackMs;
    const unit = (m[2] || "").toLowerCase();
    if (unit === "ms") return Math.floor(num);
    if (unit === "s") return Math.floor(num * 1000);
    if (unit === "m" || unit === "min") return Math.floor(num * 60 * 1000);
    if (unit === "h") return Math.floor(num * 60 * 60 * 1000);
    // no unit -> interpret number > 1000 as milliseconds, otherwise seconds
    if (num > 1000) return Math.floor(num);
    return Math.floor(num * 1000);
  }

  // fallback: try numeric parsing
  const num = Number(s);
  if (!Number.isFinite(num) || num <= 0) return fallbackMs;
  if (num > 1000) return Math.floor(num);
  return Math.floor(num * 1000);
}

function parsePersonaTimeouts(raw: Record<string, unknown>) {
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(raw || {})) {
    if (!key || typeof key !== "string") continue;
    const normalizedKey = key.trim().toLowerCase();
    if (!normalizedKey.length) continue;
    let ms: number | undefined;
    if (typeof value === "number") ms = value;
    else if (typeof value === "string") {
      // allow values like "120s", "2m", "120000" or quoted strings
      const parsed = parseDurationMs(value, -1);
      if (parsed > 0) ms = parsed;
    }
    if (ms === undefined || !Number.isFinite(ms) || ms <= 0) continue;
    out[normalizedKey] = Math.floor(ms);
  }
  return out;
}

const projectBaseRaw = process.env.PROJECT_BASE || process.env.REPO_ROOT || "./repo";
const projectBase = path.resolve(expandHome(projectBaseRaw)!);
const defaultRepoName = (process.env.DEFAULT_REPO_NAME || "active").trim() || "active";
const repoRootRaw = process.env.REPO_ROOT ? process.env.REPO_ROOT : path.join(projectBase, defaultRepoName);
const repoRoot = path.resolve(expandHome(repoRootRaw)!);

const maxFileBytes = Number(process.env.MAX_FILE_BYTES || 524288);
const allowedExts = splitCsv(process.env.ALLOWED_EXTS || ".ts,.tsx,.js,.jsx,.py,.md,.json,.yml,.yaml,.css,.html,.sh,.bat", [])
  .map(s => s.toLowerCase())
  .map(s => s.startsWith(".") ? s : "." + s)
  .filter(Boolean);

const promptFileAllowedExts = splitCsv(process.env.PROMPT_FILE_ALLOWED_EXTS || ".ts,.tsx,.js,.jsx,.json,.css,.md,.html,.yml,.yaml", [])
  .map(s => s.toLowerCase())
  .map(s => s.startsWith(".") ? s : "." + s)
  .filter(Boolean);
const promptFileMaxChars = Number(process.env.PROMPT_FILE_MAX_CHARS || 48000);
const promptFileMaxPerFileChars = Number(process.env.PROMPT_FILE_MAX_PER_FILE_CHARS || 12000);
const promptFileMaxFiles = Number(process.env.PROMPT_FILE_MAX_FILES || 8);

function parseRevisionLimit(value: string | undefined, fallback: number): number | null {
  if (!value || !value.trim().length) return fallback;
  const normalized = value.trim().toLowerCase();
  if (["unlimited", "infinite", "inf", "none", "no-limit", "nolimit"].includes(normalized)) {
    return null;
  }
  const num = Number(normalized);
  if (!Number.isFinite(num) || num <= 0) return fallback;
  return Math.floor(num);
}

const coordinatorMaxRevisionAttempts = parseRevisionLimit(process.env.COORDINATOR_MAX_REVISION_ATTEMPTS, 5);
const coordinatorMaxApprovalRetries = parseRevisionLimit(process.env.COORDINATOR_MAX_APPROVAL_RETRIES, 3);

const gitToken = process.env.GIT_AUTH_TOKEN || "";
const gitPassword = process.env.GIT_AUTH_PASSWORD || "";
const gitCredentialsPath = (() => {
  const manual = process.env.GIT_CREDENTIALS_PATH;
  if (manual) return path.resolve(expandHome(manual)!);
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
  return "/context/upsert";
})();

const gitUserName = (process.env.GIT_USER_NAME || "machine-client").trim();
const gitUserEmail = (process.env.GIT_USER_EMAIL || "machine-client@example.com").trim();

const personaTimeouts = parsePersonaTimeouts(jsonOr(process.env.PERSONA_TIMEOUTS_JSON, {} as Record<string, unknown>));
const personaDefaultTimeoutMs = parseDurationMs(process.env.PERSONA_DEFAULT_TIMEOUT_MS || process.env.COORDINATOR_WAIT_TIMEOUT_MS, 600000);
const personaCodingTimeoutMs = parseDurationMs(process.env.PERSONA_CODING_TIMEOUT_MS, 180000);
const personaCodingPersonas = splitCsv(process.env.PERSONA_CODING_PERSONAS || "lead-engineer,devops,ui-engineer,qa-engineer,ml-engineer", []);



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
  // Be conservative: do not auto-create milestones by default to avoid accidental duplicates.
  dashboardCreateMilestoneIfMissing: bool(process.env.DASHBOARD_CREATE_MILESTONE_IF_MISSING, false),

  applyEdits: bool(process.env.APPLY_EDITS, false),
  allowedEditPersonas: splitCsv(process.env.ALLOWED_EDIT_PERSONAS || "lead-engineer,devops,ui-engineer,context", []),
  projectBase,
  defaultRepoName,
  repoRoot,
  maxFileBytes,
  allowedExts,
  promptFileAllowedExts,
  promptFileMaxChars,
  promptFileMaxPerFileChars,
  promptFileMaxFiles,
  coordinatorMaxRevisionAttempts,
  coordinatorMaxApprovalRetries,

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

  personaTimeouts,
  personaDefaultTimeoutMs,
  personaCodingTimeoutMs,
  personaCodingPersonas,

  git: {
    defaultBranch: (process.env.GIT_DEFAULT_BRANCH || "main").trim() || "main",
    sshKeyPath: process.env.GIT_SSH_KEY_PATH ? path.resolve(expandHome(process.env.GIT_SSH_KEY_PATH)!) : "",
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
  ,
  // Max bytes for attachments the worker will send to the dashboard (base64-encoded size before transport)
  dashboardMaxAttachmentBytes: Number(process.env.DASHBOARD_MAX_ATTACHMENT_BYTES || 200000)
  ,
  // Whether the worker should inject dashboard context (project tree, hotspots) into model prompts
  // Set to false to ensure each LM call is self-contained and no external dashboard context is added.
  injectDashboardContext: bool(process.env.INJECT_DASHBOARD_CONTEXT, true),
  // When true, auto-creating milestones is only permitted for the 'Future Enhancements' milestone
  dashboardAutoCreateFutureEnhancementsOnly: bool(process.env.DASHBOARD_AUTO_CREATE_FUTURE_ENHANCEMENTS_ONLY, true),
};
