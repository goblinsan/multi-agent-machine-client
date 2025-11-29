import "dotenv/config";
import fs from "node:fs";
import path from "path";

function expandHome(p: string | undefined): string | undefined {
  if (!p) return p;
  return p.replace(
    /^~(?=$|\/|\\)/,
    process.env.HOME || process.env.USERPROFILE || "~",
  );
}

function bool(v: string | undefined, def = false) {
  if (v === undefined) return def;
  return ["1", "true", "yes", "on"].includes(v.toLowerCase());
}

function splitCsv(value: string | undefined, fallback: string[]): string[] {
  if (!value) return fallback;
  return value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function jsonOr<T>(value: string | undefined, fallback: T): T {
  if (!value) return fallback;

  let v = value.trim();
  if (
    (v.startsWith("'") && v.endsWith("'")) ||
    (v.startsWith('"') && v.endsWith('"'))
  ) {
    v = v.slice(1, -1);
  }
  try {
    return JSON.parse(v) as T;
  } catch {
    return fallback;
  }
}

function parseDurationMs(value: string | undefined, fallbackMs: number) {
  if (!value) return fallbackMs;
  let s = value.toString().trim();
  if (!s.length) return fallbackMs;

  if (
    (s.startsWith("'") && s.endsWith("'")) ||
    (s.startsWith('"') && s.endsWith('"'))
  )
    s = s.slice(1, -1).trim();

  const m = s.match(/^([0-9]+(?:\.[0-9]+)?)\s*(ms|s|m|min|h)?$/i);
  if (m) {
    const num = Number(m[1]);
    if (!Number.isFinite(num) || num <= 0) return fallbackMs;
    const unit = (m[2] || "").toLowerCase();
    if (unit === "ms") return Math.floor(num);
    if (unit === "s") return Math.floor(num * 1000);
    if (unit === "m" || unit === "min") return Math.floor(num * 60 * 1000);
    if (unit === "h") return Math.floor(num * 60 * 60 * 1000);

    if (num > 1000) return Math.floor(num);
    return Math.floor(num * 1000);
  }

  const num = Number(s);
  if (!Number.isFinite(num) || num <= 0) return fallbackMs;
  if (num > 1000) return Math.floor(num);
  return Math.floor(num * 1000);
}

function readHostPatternFile(filePath: string | undefined): string[] {
  if (!filePath || !filePath.trim()) return [];
  const expanded = expandHome(filePath.trim());
  if (!expanded) return [];
  const resolved = path.resolve(expanded);
  try {
    if (!fs.existsSync(resolved)) {
      console.warn(
        `[config] INFO_REQUEST_DENY_HOSTS_FILE not found at ${resolved}`,
      );
      return [];
    }
    const contents = fs.readFileSync(resolved, "utf8");
    return contents
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(
        (line) =>
          line.length > 0 &&
          !line.startsWith("#") &&
          !line.startsWith("//"),
      );
  } catch (error) {
    console.warn(
      `[config] Failed reading INFO_REQUEST_DENY_HOSTS_FILE (${resolved}): ${error instanceof Error ? error.message : String(error)}`,
    );
    return [];
  }
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
      const parsed = parseDurationMs(value, -1);
      if (parsed > 0) ms = parsed;
    }
    if (ms === undefined || !Number.isFinite(ms) || ms <= 0) continue;
    out[normalizedKey] = Math.floor(ms);
  }
  return out;
}

function parsePersonaMaxRetries(raw: Record<string, unknown>) {
  const out: Record<string, number | null> = {};
  for (const [key, value] of Object.entries(raw || {})) {
    if (!key || typeof key !== "string") continue;
    const normalizedKey = key.trim().toLowerCase();
    if (!normalizedKey.length) continue;

    if (typeof value === "string") {
      const normalized = value.trim().toLowerCase();
      if (
        [
          "unlimited",
          "infinite",
          "inf",
          "none",
          "no-limit",
          "nolimit",
        ].includes(normalized)
      ) {
        out[normalizedKey] = null;
        continue;
      }

      const num = Number(normalized);
      if (Number.isFinite(num) && num >= 0) {
        out[normalizedKey] = Math.floor(num);
        continue;
      }
    }

    if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
      out[normalizedKey] = Math.floor(value as number);
      continue;
    }
  }
  return out;
}

const projectBaseRaw = process.env.PROJECT_BASE || "./repo";
const projectBase = path.resolve(expandHome(projectBaseRaw)!);
const defaultRepoName = "active";
const repoRoot = projectBase;

const maxFileBytes = Number(process.env.MAX_FILE_BYTES || 524288);

const blockedExts = splitCsv(process.env.BLOCKED_EXTS, [])
  .map((s) => s.toLowerCase())
  .filter(Boolean);

const promptFileAllowedExts = splitCsv(
  process.env.PROMPT_FILE_ALLOWED_EXTS ||
    ".ts,.tsx,.js,.jsx,.json,.css,.md,.html,.yml,.yaml",
  [],
)
  .map((s) => s.toLowerCase())
  .map((s) => (s.startsWith(".") ? s : "." + s))
  .filter(Boolean);
const promptFileMaxChars = Number(process.env.PROMPT_FILE_MAX_CHARS || 48000);
const promptFileMaxPerFileChars = Number(
  process.env.PROMPT_FILE_MAX_PER_FILE_CHARS || 12000,
);
const promptFileMaxFiles = Number(process.env.PROMPT_FILE_MAX_FILES || 8);

function parseRevisionLimit(
  value: string | undefined,
  fallback: number,
): number | null {
  if (!value || !value.trim().length) return fallback;
  const normalized = value.trim().toLowerCase();
  if (
    ["unlimited", "infinite", "inf", "none", "no-limit", "nolimit"].includes(
      normalized,
    )
  ) {
    return null;
  }
  const num = Number(normalized);
  if (!Number.isFinite(num) || num <= 0) return fallback;
  return Math.floor(num);
}

const coordinatorMaxRevisionAttempts = parseRevisionLimit(
  process.env.COORDINATOR_MAX_REVISION_ATTEMPTS,
  5,
);
const coordinatorMaxApprovalRetries = parseRevisionLimit(
  process.env.COORDINATOR_MAX_APPROVAL_RETRIES,
  3,
);
const coordinatorMaxIterations = parseRevisionLimit(
  process.env.COORDINATOR_MAX_ITERATIONS,
  500,
);
const planMaxIterationsPerStage = parseRevisionLimit(
  process.env.PLAN_MAX_ITERATIONS_PER_STAGE,
  5,
);
const blockedMaxAttempts = parseRevisionLimit(
  process.env.BLOCKED_MAX_ATTEMPTS,
  10,
);
const personaTimeoutMaxRetries = parseRevisionLimit(
  process.env.PERSONA_TIMEOUT_MAX_RETRIES,
  3,
);

const personaRetryBackoffIncrementMs = parseDurationMs(
  process.env.PERSONA_RETRY_BACKOFF_INCREMENT_MS,
  30000,
);

const infoRequestMaxIterations = Number(
  process.env.INFO_REQUEST_MAX_ITERATIONS || 10,
);
const infoRequestMaxRequestsPerIteration = Number(
  process.env.INFO_REQUEST_MAX_REQUESTS_PER_ITERATION || 3,
);
const infoRequestDenyHostsFile =
  process.env.INFO_REQUEST_DENY_HOSTS_FILE || undefined;
const infoRequestDenyHosts = readHostPatternFile(infoRequestDenyHostsFile);
const infoRequestMaxHttpBytes = Number(
  process.env.INFO_REQUEST_MAX_HTTP_BYTES || 200000,
);
const infoRequestMaxFileBytes = Number(
  process.env.INFO_REQUEST_MAX_FILE_BYTES || 200000,
);
const infoRequestMaxSnippetChars = Number(
  process.env.INFO_REQUEST_MAX_SNIPPET_CHARS || 8000,
);
const infoRequestHttpTimeoutMs = parseDurationMs(
  process.env.INFO_REQUEST_HTTP_TIMEOUT_MS,
  20000,
);
const infoRequestArtifactSubdir =
  (process.env.INFO_REQUEST_ARTIFACT_SUBDIR || ".ma/tasks")?.trim() ||
  ".ma/tasks";

function parseJsonArray(
  value: string | undefined,
  fallback: string[],
): string[] {
  if (!value) return fallback;
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) return parsed.map(String);
  } catch (_e) {
    void 0;
  }

  return splitCsv(value, fallback);
}
const planRequireCitations = bool(process.env.PLAN_REQUIRE_CITATIONS, true);
const planCitationFields = parseJsonArray(
  process.env.PLAN_CITATION_FIELDS_JSON || process.env.PLAN_CITATION_FIELDS,
  ["failing_test", "error_message", "acceptance_criterion_id"],
);
const planUncitedBudget = Number(process.env.PLAN_UNCITED_BUDGET ?? 0);
const planTreatUncitedAsInvalid = bool(
  process.env.PLAN_TREAT_UNCITED_AS_INVALID,
  true,
);

const gitToken = process.env.GIT_AUTH_TOKEN || "";
const gitPassword = process.env.GIT_AUTH_PASSWORD || "";
const gitCredentialsPath = (() => {
  const manual = process.env.GIT_CREDENTIALS_PATH;
  if (manual) return path.resolve(expandHome(manual)!);
  if (gitToken || gitPassword)
    return path.join(projectBase, ".git-credentials");
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
const gitUserEmail = (
  process.env.GIT_USER_EMAIL || "machine-client@example.com"
).trim();

const personaTimeouts = parsePersonaTimeouts(
  jsonOr(process.env.PERSONA_TIMEOUTS_JSON, {} as Record<string, unknown>),
);
const personaMaxRetries = parsePersonaMaxRetries(
  jsonOr(process.env.PERSONA_MAX_RETRIES_JSON, {} as Record<string, unknown>),
);

const personaDefaultTimeoutMs = parseDurationMs(
  process.env.PERSONA_DEFAULT_TIMEOUT_MS,
  60000,
);

const personaDefaultMaxRetries = parseRevisionLimit(
  process.env.PERSONA_DEFAULT_MAX_RETRIES,
  3,
);

export const cfg = {
  transportType: (process.env.TRANSPORT_TYPE || "redis") as "redis" | "local",

  redisUrl: process.env.REDIS_URL || "redis://localhost:6379",
  redisPassword: process.env.REDIS_PASSWORD || undefined,
  requestStream: process.env.REQUEST_STREAM || "agent.requests",
  eventStream: process.env.EVENT_STREAM || "agent.events",
  groupPrefix: process.env.GROUP_PREFIX || "cg",
  consumerId: process.env.CONSUMER_ID || "worker-1",
  allowedPersonas: splitCsv(process.env.ALLOWED_PERSONAS, []),
  lmsBaseUrl: process.env.LMS_BASE_URL || "http://127.0.0.1:1234",
  personaModels: jsonOr(
    process.env.PERSONA_MODELS_JSON,
    {} as Record<string, string>,
  ),
  dashboardBaseUrl: process.env.DASHBOARD_BASE_URL || "http://localhost:8787",
  dashboardApiKey: process.env.DASHBOARD_API_KEY || "dev",
  dashboardContextEndpoint,

  dashboardCreateMilestoneIfMissing: bool(
    process.env.DASHBOARD_CREATE_MILESTONE_IF_MISSING,
    false,
  ),

  applyEdits: bool(process.env.APPLY_EDITS, false),
  allowedEditPersonas: splitCsv(
    process.env.ALLOWED_EDIT_PERSONAS ||
      "lead-engineer,devops,ui-engineer,context",
    [],
  ),
  projectBase,
  defaultRepoName,
  repoRoot,
  maxFileBytes,
  blockedExts,
  promptFileAllowedExts,
  promptFileMaxChars,
  promptFileMaxPerFileChars,
  promptFileMaxFiles,
  coordinatorMaxRevisionAttempts,
  coordinatorMaxApprovalRetries,
  coordinatorMaxIterations,
  planMaxIterationsPerStage,
  blockedMaxAttempts,
  personaTimeoutMaxRetries,
  personaRetryBackoffIncrementMs,

  informationRequests: {
    maxIterations: infoRequestMaxIterations,
    maxRequestsPerIteration: infoRequestMaxRequestsPerIteration,
    denyHosts: infoRequestDenyHosts,
    maxHttpBytes: infoRequestMaxHttpBytes,
    maxFileBytes: infoRequestMaxFileBytes,
    maxSnippetChars: infoRequestMaxSnippetChars,
    httpTimeoutMs: infoRequestHttpTimeoutMs,
    artifactSubdir: infoRequestArtifactSubdir,
    denyHostsFile: infoRequestDenyHostsFile
      ? path.resolve(expandHome(infoRequestDenyHostsFile)!)
      : undefined,
  },

  planRequireCitations,
  planCitationFields,
  planUncitedBudget,
  planTreatUncitedAsInvalid,

  writeDiagnostics: bool(process.env.WRITE_DIAGNOSTICS, false),

  contextScan: bool(process.env.CONTEXT_SCAN, false),
  scanInclude: splitCsv(process.env.SCAN_INCLUDE || "**/*", []),
  scanExclude: splitCsv(
    process.env.SCAN_EXCLUDE ||
      "**/node_modules/**,**/.git/**,**/dist/**,**/build/**,**/coverage/**,**/target/**,**/.next/**,**/.nuxt/**,**/vendor/**,**/__pycache__/**,**/.pytest_cache/**,**/.venv/**,**/venv/**,**/.cargo/**,**/Cargo.lock",
    [],
  ),
  scanMaxFiles: Number(process.env.SCAN_MAX_FILES || 5000),
  scanMaxBytes: Number(process.env.SCAN_MAX_BYTES || 100000000),
  scanMaxDepth: Number(process.env.SCAN_MAX_DEPTH || 12),
  scanTrackLines: bool(process.env.SCAN_TRACK_LINES, true),
  scanTrackHash: bool(process.env.SCAN_TRACK_HASH, true),

  scanComponents: jsonOr(process.env.SCAN_COMPONENTS, null as null | any),

  summaryMode: (process.env.SUMMARY_MODE || "both").toLowerCase(),

  personaTimeouts,
  personaMaxRetries,
  personaDefaultTimeoutMs,
  personaDefaultMaxRetries,

  git: {
    defaultBranch: (process.env.GIT_DEFAULT_BRANCH || "main").trim() || "main",
    sshKeyPath: process.env.GIT_SSH_KEY_PATH
      ? path.resolve(expandHome(process.env.GIT_SSH_KEY_PATH)!)
      : "",
    username: process.env.GIT_AUTH_USERNAME || "",
    password: gitPassword,
    token: gitToken,
    credentialsPath: gitCredentialsPath,
    userName: gitUserName,
    userEmail: gitUserEmail,
  },

  allowWorkspaceGit: ["1", "true", "yes", "on"].includes(
    (process.env.MC_ALLOW_WORKSPACE_GIT || "").toLowerCase(),
  ),

  log: {
    level: logLevelRaw,
    file: logFile,
    console: logConsole,
  },
  dashboardMaxAttachmentBytes: Number(
    process.env.DASHBOARD_MAX_ATTACHMENT_BYTES || 200000,
  ),
  injectDashboardContext: bool(process.env.INJECT_DASHBOARD_CONTEXT, true),

  dashboardAutoCreateFutureEnhancementsOnly: bool(
    process.env.DASHBOARD_AUTO_CREATE_FUTURE_ENHANCEMENTS_ONLY,
    true,
  ),
};

const quietConfigLogs =
  process.env.NODE_ENV === "test" ||
  ["1", "true", "yes", "on"].includes(
    (process.env.QUIET_CONFIG_LOGS || "").toLowerCase(),
  );

const rawAllowedPersonas = cfg.allowedPersonas;
cfg.allowedPersonas = cfg.allowedPersonas.filter((persona) => {
  if (persona === "coordination") return true;

  const hasModelMapping = !!cfg.personaModels[persona];

  if (!hasModelMapping) {
    const warnFn = quietConfigLogs ? console.debug : console.warn;
    warnFn(
      `[config] Persona '${persona}' in ALLOWED_PERSONAS but no model mapping - will not handle requests for this persona`,
    );
  }

  return hasModelMapping;
});

if (rawAllowedPersonas.length > cfg.allowedPersonas.length) {
  const infoFn = quietConfigLogs ? console.debug : console.log;
  infoFn(
    `[config] Filtered personas: ${rawAllowedPersonas.length} → ${cfg.allowedPersonas.length} (removed personas without model mappings)`,
  );
  infoFn(`[config] Active personas: ${cfg.allowedPersonas.join(", ")}`);
}
