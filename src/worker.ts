import { randomUUID } from "crypto";
import { cfg } from "./config.js";
import path from "path";
import { makeRedis } from "./redisClient.js";
import { RequestSchema } from "./schema.js";
import { SYSTEM_PROMPTS } from "./personas.js";
import { callLMStudio } from "./lmstudio.js";
import { fetchContext, recordEvent, uploadContextSnapshot, fetchProjectStatus, fetchProjectStatusDetails, fetchProjectNextAction, createDashboardTask } from "./dashboard.js";
import { resolveRepoFromPayload, getRepoMetadata, commitAndPushPaths, checkoutBranchFromBase, ensureBranchPublished, runGit } from "./gitUtils.js";
import { logger } from "./logger.js";
import fs from "fs/promises";

function groupForPersona(p: string) { return `${cfg.groupPrefix}:${p}`; }
function nowIso() { return new Date().toISOString(); }

function firstString(...values: any[]): string | null {
  for (const value of values) {
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (trimmed.length) return trimmed;
    }
  }
  return null;
}

function shouldUploadDashboardFlag(value: any): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    return !["0", "false", "no", "off"].includes(normalized);
  }
  return Boolean(value);
}

const PERSONA_WAIT_TIMEOUT_MS = cfg.personaDefaultTimeoutMs;

function slugify(value: string) {
  return (value || "").toString().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").replace(/-{2,}/g, "-") || "milestone";
}


const PERSONA_TIMEOUT_OVERRIDES = cfg.personaTimeouts || {};
const CODING_TIMEOUT_MS = cfg.personaCodingTimeoutMs || 180000;
const DEFAULT_PERSONA_TIMEOUT_MS = cfg.personaDefaultTimeoutMs || PERSONA_WAIT_TIMEOUT_MS;
const CODING_PERSONA_SET = new Set((cfg.personaCodingPersonas && cfg.personaCodingPersonas.length
  ? cfg.personaCodingPersonas
  : ["lead-engineer", "devops", "ui-engineer", "qa-engineer", "ml-engineer"]
).map(p => p.trim().toLowerCase()).filter(Boolean));

const PROMPT_FILE_MAX_TOTAL_CHARS = Math.max(2000, Math.floor(cfg.promptFileMaxChars || 48000));
const PROMPT_FILE_MAX_PER_FILE_CHARS = Math.max(500, Math.floor(cfg.promptFileMaxPerFileChars || 12000));
const PROMPT_FILE_MAX_FILES = Math.max(1, Math.floor(cfg.promptFileMaxFiles || 8));
const PROMPT_FILE_ALLOWED_EXTS = new Set(
  (cfg.promptFileAllowedExts && cfg.promptFileAllowedExts.length ? cfg.promptFileAllowedExts : [
    ".ts", ".tsx", ".js", ".jsx", ".json", ".css", ".md", ".html", ".yml", ".yaml"
  ]).map(ext => ext.toLowerCase())
);
const PROMPT_FILE_ALWAYS_INCLUDE = new Set([
  "package.json",
  "tsconfig.json",
  "vite.config.ts",
  "project.json",
  "README.md"
].map(path => path.toLowerCase()));

const MAX_REVISION_ATTEMPTS = cfg.coordinatorMaxRevisionAttempts === null
  ? Number.POSITIVE_INFINITY
  : Math.max(1, Math.floor(cfg.coordinatorMaxRevisionAttempts));
const MAX_APPROVAL_RETRIES = cfg.coordinatorMaxApprovalRetries === null
  ? Number.POSITIVE_INFINITY
  : Math.max(1, Math.floor(cfg.coordinatorMaxApprovalRetries));

const ENGINEER_PERSONAS_REQUIRING_PLAN = new Set(["lead-engineer", "ui-engineer"]);
const IMPLEMENTATION_PLANNER_MAP = new Map<string, string>([
  ["lead-engineer", "implementation-planner"],
  ["ui-engineer", "implementation-planner"]
]);

function personaTimeoutMs(persona: string) {
  const key = (persona || "").toLowerCase();
  if (key && PERSONA_TIMEOUT_OVERRIDES[key] !== undefined) return PERSONA_TIMEOUT_OVERRIDES[key];
  if (CODING_PERSONA_SET.has(key)) return CODING_TIMEOUT_MS;
  return DEFAULT_PERSONA_TIMEOUT_MS;
}


const MILESTONE_STATUS_PRIORITY: Record<string, number> = {
  unstarted: 0,
  not_started: 0,
  notstarted: 0,
  todo: 0,
  backlog: 0,
  planned: 0,
  pending: 1,
  ready: 1,
  in_progress: 1,
  active: 1,
  started: 1,
  blocked: 2,
  review: 2,
  qa: 2,
  testing: 2,
  done: 5,
  completed: 5,
  complete: 5,
  shipped: 5,
  delivered: 5,
  closed: 6,
  cancelled: 6,
  canceled: 6,
  archived: 7
};

function normalizeMilestoneStatus(value: any) {
  if (typeof value !== "string") return "";
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_");
}

function parseMilestoneDate(value: any): number {
  if (!value) return Number.POSITIVE_INFINITY;
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return Number.POSITIVE_INFINITY;
}

function numericHint(value: any): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const num = Number(value);
    if (!Number.isNaN(num)) return num;
  }
  return Number.POSITIVE_INFINITY;
}

function milestonePriority(m: any): number {
  const status = normalizeMilestoneStatus(m?.status ?? m?.state ?? m?.phase ?? m?.stage ?? m?.progress);
  if (status in MILESTONE_STATUS_PRIORITY) return MILESTONE_STATUS_PRIORITY[status];
  if (!status) return 2;
  if (status.includes("complete") || status.includes("done") || status.includes("finished")) return 5;
  return 3;
}

function milestoneDue(m: any): number {
  return Math.min(
    parseMilestoneDate(m?.due),
    parseMilestoneDate(m?.due_at),
    parseMilestoneDate(m?.dueAt),
    parseMilestoneDate(m?.due_date),
    parseMilestoneDate(m?.target_date),
    parseMilestoneDate(m?.targetDate),
    parseMilestoneDate(m?.deadline),
    parseMilestoneDate(m?.eta)
  );
}

function milestoneOrder(m: any): number {
  return Math.min(
    numericHint(m?.order),
    numericHint(m?.position),
    numericHint(m?.sequence),
    numericHint(m?.rank),
    numericHint(m?.priority),
    numericHint(m?.sort),
    numericHint(m?.sort_order),
    numericHint(m?.sortOrder),
    numericHint(m?.index)
  );
}

function toArray(value: any): any[] {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  if (typeof value === "object") {
    const edges = (value as any).edges;
    if (Array.isArray(edges)) {
      return edges.map((edge: any) => edge?.node ?? edge).filter(Boolean);
    }
    const candidates = ["items", "data", "nodes", "list", "values", "results"];
    for (const key of candidates) {
      const nested = (value as any)[key];
      if (Array.isArray(nested)) return nested;
    }
    return [value];
  }
  return [];
}

function milestoneCandidates(status: any): any[] {
  if (!status || typeof status !== "object") return [];
  const seen = new Set<string>();
  const results: any[] = [];
  const pushAll = (value: any) => {
    for (const item of toArray(value)) {
      if (!item || typeof item !== "object") continue;
      const keyParts = [
        typeof item.id === "string" ? item.id : undefined,
        typeof item.slug === "string" ? item.slug : undefined,
        typeof item.name === "string" ? item.name : undefined,
        typeof item.title === "string" ? item.title : undefined
      ].filter(Boolean) as string[];
      const key = keyParts.join("|") || `obj-${results.length}`;
      if (seen.has(key)) continue;
      seen.add(key);
      results.push(item);
    }
  };

  pushAll((status as any).next_milestone);
  pushAll((status as any).nextMilestone);
  pushAll((status as any).current_milestone);
  pushAll((status as any).currentMilestone);
  pushAll((status as any).upcoming_milestones);
  pushAll((status as any).upcomingMilestones);
  pushAll((status as any).milestones);
  pushAll((status as any).project?.milestones);
  pushAll((status as any).milestone_list);
  pushAll((status as any).milestoneList);

  return results;
}

function selectNextMilestone(status: any): any | null {
  if (!status || typeof status !== "object") return null;
  const explicit = (status as any).next_milestone ?? (status as any).nextMilestone;
  const explicitName = explicit && typeof explicit === "object"
    ? firstString(explicit.name, explicit.title, explicit.goal)
    : null;
  if (explicit && explicitName) return explicit;

  const candidates = milestoneCandidates(status);
  if (!candidates.length) return null;

  const scored = candidates.map((item, index) => ({
    item,
    priority: milestonePriority(item),
    due: milestoneDue(item),
    order: milestoneOrder(item),
    index
  }));

  scored.sort((a, b) => {
    if (a.priority !== b.priority) return a.priority - b.priority;
    if (a.due !== b.due) return a.due - b.due;
    if (a.order !== b.order) return a.order - b.order;
    return a.index - b.index;
  });

  return scored[0]?.item ?? null;
}


const TASK_STATUS_PRIORITY: Record<string, number> = {
  in_progress: 0,
  active: 0,
  doing: 0,
  working: 0,
  review: 1,
  ready: 1,
  planned: 2,
  backlog: 2,
  todo: 2,
  not_started: 2,
  blocked: 3,
  waiting: 3,
  pending: 3,
  qa: 3,
  testing: 3,
  done: 5,
  completed: 5,
  complete: 5,
  shipped: 5,
  delivered: 5,
  closed: 6,
  cancelled: 6,
  canceled: 6,
  archived: 7
};

function normalizeTaskStatus(value: any) {
  if (typeof value !== "string") return "";
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_");
}

function taskStatusPriority(status: string) {
  if (!status) return 2;
  if (status in TASK_STATUS_PRIORITY) return TASK_STATUS_PRIORITY[status];
  if (status.includes("progress") || status.includes("doing") || status.includes("work")) return 0;
  if (status.includes("block")) return 3;
  if (status.includes("review") || status.includes("qa")) return 1;
  if (status.includes("done") || status.includes("complete") || status.includes("closed")) return 5;
  if (status.includes("cancel")) return 6;
  return 2;
}

function taskDue(value: any): number {
  return Math.min(
    parseMilestoneDate(value?.due),
    parseMilestoneDate(value?.due_at),
    parseMilestoneDate(value?.dueAt),
    parseMilestoneDate(value?.due_date),
    parseMilestoneDate(value?.target_date),
    parseMilestoneDate(value?.targetDate),
    parseMilestoneDate(value?.deadline),
    parseMilestoneDate(value?.eta)
  );
}

function taskOrder(value: any): number {
  return Math.min(
    numericHint(value?.order),
    numericHint(value?.position),
    numericHint(value?.sequence),
    numericHint(value?.rank),
    numericHint(value?.priority),
    numericHint(value?.sort),
    numericHint(value?.sort_order),
    numericHint(value?.sortOrder),
    numericHint(value?.index)
  );
}

function taskCandidates(source: any): any[] {
  if (!source || typeof source !== "object") return [];
  const seen = new Set<string>();
  const results: any[] = [];
  const pushAll = (value: any) => {
    for (const item of toArray(value)) {
      if (!item || typeof item !== "object") continue;
      const keyParts = [
        typeof item.id === "string" ? item.id : undefined,
        typeof item.key === "string" ? item.key : undefined,
        typeof item.slug === "string" ? item.slug : undefined,
        typeof item.name === "string" ? item.name : undefined,
        typeof item.title === "string" ? item.title : undefined
      ].filter(Boolean) as string[];
      const key = keyParts.join("|") || `task-${results.length}`;
      if (seen.has(key)) continue;
      seen.add(key);
      results.push(item);
    }
  };

  const container = source as any;
  pushAll(container?.next_task);
  pushAll(container?.nextTask);
  pushAll(container?.active_task);
  pushAll(container?.activeTask);
  pushAll(container?.current_task);
  pushAll(container?.currentTask);
  pushAll(container?.tasks);
  pushAll(container?.items);
  pushAll(container?.issues);
  pushAll(container?.tickets);
  pushAll(container?.stories);
  pushAll(container?.work_items);
  pushAll(container?.workItems);
  pushAll(container?.backlog);
  pushAll(container?.in_progress);
  pushAll(container?.inProgress);

  return results;
}

function selectNextTask(...sources: any[]): any | null {
  const candidates: { task: any; priority: number; due: number; order: number; index: number }[] = [];
  let index = 0;
  for (const source of sources) {
    for (const task of taskCandidates(source)) {
      const status = normalizeTaskStatus(task?.status ?? task?.state ?? task?.phase ?? task?.stage ?? task?.progress);
      const priority = taskStatusPriority(status);
      if (priority >= 5) continue; // skip completed/cancelled tasks
      candidates.push({
        task,
        priority,
        due: taskDue(task),
        order: taskOrder(task),
        index: index++
      });
    }
  }

  if (!candidates.length) return null;

  candidates.sort((a, b) => {
    if (a.priority !== b.priority) return a.priority - b.priority;
    if (a.due !== b.due) return a.due - b.due;
    if (a.order !== b.order) return a.order - b.order;
    return a.index - b.index;
  });

  return candidates[0]?.task ?? null;
}

function deriveTaskContext(task: any) {
  if (!task || typeof task !== "object") {
    return { name: null as string | null, slug: null as string | null, descriptor: null as any };
  }
  const name = firstString(
    task?.name,
    task?.title,
    task?.summary,
    task?.label,
    task?.key,
    task?.id
  ) || null;

  const taskSlugRaw = firstString(task?.slug, task?.key, name, task?.id, "task");
  const slug = taskSlugRaw ? slugify(taskSlugRaw) : null;

  const dueText = firstString(
    task?.due,
    task?.due_at,
    task?.dueAt,
    task?.due_date,
    task?.target_date,
    task?.targetDate,
    task?.deadline,
    task?.eta
  );

  const descriptor = {
    id: firstString(task?.id, task?.key, slug, name) || null,
    name,
    slug,
    status: task?.status ?? task?.state ?? task?.progress ?? null,
    normalized_status: normalizeTaskStatus(task?.status ?? task?.state ?? task?.phase ?? task?.stage ?? task?.progress),
    due: dueText || null,
    assignee: firstString(
      task?.assignee,
      task?.assignee_name,
      task?.assigneeName,
      task?.owner,
      task?.owner_name,
      task?.assigned_to,
      task?.assignedTo
    ) || null,
    branch: firstString(task?.branch, task?.branch_name, task?.branchName) || null,
    summary: firstString(task?.summary, task?.description) || null
  };

  return { name, slug, descriptor };
}

function deriveMilestoneContext(milestone: any, nameFallback: string, branchFallback: string, taskDescriptor: any) {
  const milestoneName = firstString(
    milestone?.name,
    milestone?.title,
    milestone?.goal,
    nameFallback,
    "next milestone"
  ) || nameFallback || "next milestone";

  const milestoneSlugRaw = firstString(milestone?.slug, milestoneName, "milestone");
  const milestoneSlug = slugify(milestoneSlugRaw || milestoneName);

  const milestoneDue = firstString(
    milestone?.due,
    milestone?.due_at,
    milestone?.dueAt,
    milestone?.due_date,
    milestone?.target_date,
    milestone?.targetDate,
    milestone?.deadline,
    milestone?.eta
  );

  const milestoneBranch = firstString(
    milestone?.branch,
    milestone?.branch_name,
    milestone?.branchName
  ) || branchFallback;

  const descriptor = milestone
    ? {
        id: milestone.id ?? milestoneSlug,
        name: milestoneName,
        slug: milestoneSlug,
        status: milestone.status,
        goal: milestone.goal,
        due: milestoneDue || null,
        branch: milestoneBranch,
        task: taskDescriptor
      }
    : (taskDescriptor ? { task: taskDescriptor } : null);

  return { name: milestoneName, slug: milestoneSlug, branch: milestoneBranch, descriptor };
}

function suggestionToTask(suggestion: any) {
  if (!suggestion || typeof suggestion !== "object") return null;
  const title = firstString(suggestion.title, suggestion.name, suggestion.summary, suggestion.id) || "suggested task";
  return {
    id: suggestion.task_id || suggestion.id || title,
    name: title,
    title,
    summary: suggestion.reason || suggestion.summary || null,
    status: suggestion.status || "not_started",
    priority: suggestion.priority_score,
    persona: suggestion.persona_required || null
  };
}

function pickSuggestion(suggestions: any[] | undefined | null) {
  if (!Array.isArray(suggestions) || suggestions.length === 0) return null;
  const preferred = suggestions.find(s => !s?.persona_required || s.persona_required === "lead-engineer");
  return suggestionToTask(preferred || suggestions[0]);
}

type PersonaEvent = { id: string; fields: Record<string, string> };

async function waitForPersonaCompletion(
  r: any,
  persona: string,
  workflowId: string,
  corrId: string,
  timeoutMs?: number
): Promise<PersonaEvent> {
  const effectiveTimeout = typeof timeoutMs === "number" && Number.isFinite(timeoutMs) && timeoutMs > 0
    ? timeoutMs
    : personaTimeoutMs(persona);
  const started = Date.now();
  const eventRedis = await makeRedis();

  try {
    const streamKey = cfg.eventStream;

    const recentMatch = await (async () => {
      try {
        const entries = await eventRedis.xRevRange(streamKey, "+", "-", { COUNT: 200 });
        if (!entries) return null;
        for (const entry of entries) {
          const id = Array.isArray(entry) ? String(entry[0]) : "";
          const rawCandidate = Array.isArray(entry) ? entry[1] : entry;
          if (!id || !rawCandidate || typeof rawCandidate !== "object") continue;
          const raw = rawCandidate as Record<string, any>;
          const fields: Record<string, string> = {};
          for (const [k, v] of Object.entries(raw)) fields[k] = typeof v === "string" ? v : String(v);
          if (
            fields.workflow_id === workflowId &&
            fields.from_persona === persona &&
            fields.status === "done" &&
            (!corrId || fields.corr_id === corrId)
          ) {
            return { id, fields };
          }
        }
      } catch (error) {
        logger.debug("waitForPersonaCompletion scan failed", { persona, workflowId, corrId, error });
      }
      return null;
    })();

    if (recentMatch) return recentMatch;

    let lastId = "$";
    while (Date.now() - started < effectiveTimeout) {
      const elapsed = Date.now() - started;
      const remaining = Math.max(0, effectiveTimeout - elapsed);
      const blockMs = Math.max(1000, Math.min(remaining || effectiveTimeout, 5000));
      const streams = await eventRedis.xRead([{ key: streamKey, id: lastId }], { BLOCK: blockMs, COUNT: 20 }).catch(() => null);
      if (!streams) continue;

      for (const stream of streams) {
        const messages = stream.messages || [];
        for (const message of messages) {
          const rawFields = message.message as Record<string, string>;
          const fields: Record<string, string> = {};
          for (const [k, v] of Object.entries(rawFields)) fields[k] = typeof v === "string" ? v : String(v);
          if (
            fields.workflow_id === workflowId &&
            fields.from_persona === persona &&
            fields.status === "done" &&
            (!corrId || fields.corr_id === corrId)
          ) {
            return { id: message.id, fields };
          }
        }
        if (messages.length) lastId = messages[messages.length - 1].id;
      }
    }
  } finally {
    try { await eventRedis.quit(); } catch {}
  }

  const timeoutSec = Math.round(effectiveTimeout / 100) / 10;
  throw new Error(`Timed out waiting for ${persona} completion (workflow ${workflowId}, corr ${corrId}, timeout ${timeoutSec}s)`);
}

function parseEventResult(result: string | undefined) {
  if (!result) return null;
  try {
    return JSON.parse(result);
  } catch {
    return { raw: result };
  }
}

async function sendPersonaRequest(r: any, opts: {
  workflowId: string;
  toPersona: string;
  step?: string;
  intent?: string;
  fromPersona?: string;
  payload?: any;
  corrId?: string;
  deadlineSeconds?: number;
  repo?: string;
  branch?: string;
  projectId?: string;
}): Promise<string> {
  const corrId = opts.corrId || randomUUID();
  const entry: Record<string, string> = {
    workflow_id: opts.workflowId,
    step: opts.step || "",
    from: opts.fromPersona || "coordination",
    to_persona: opts.toPersona,
    intent: opts.intent || "",
    payload: JSON.stringify(opts.payload ?? {}),
    corr_id: corrId,
    deadline_s: String(opts.deadlineSeconds ?? 600)
  };
  if (opts.repo) entry.repo = opts.repo;
  if (opts.branch) entry.branch = opts.branch;
  if (opts.projectId) entry.project_id = opts.projectId;

  await r.xAdd(cfg.requestStream, "*", entry);
  logger.info("coordinator dispatched request", {
    workflowId: opts.workflowId,
    targetPersona: opts.toPersona,
    corrId,
    step: entry.step,
    branch: opts.branch,
    projectId: opts.projectId
  });
  return corrId;
}

function clipText(text: string, max = 6000) {
  if (!text) return text;
  if (text.length <= max) return text;
  return text.slice(0, max) + `\n... (truncated ${text.length - max} chars)`;
}

function normalizeRepoPath(p: string | undefined, fallback: string) {
  if (!p || typeof p !== "string") return fallback;
  const unescaped = p.replace(/\\\\/g, "\\"); // collapse escaped backslashes
  const m = /^([A-Za-z]):\\(.*)$/.exec(unescaped);
  if (m) {
    const drive = m[1].toLowerCase();
    const rest = m[2].replace(/\\/g, "/");
    return `/mnt/${drive}/${rest}`;
  }
  const m2 = /^([A-Za-z]):\/(.*)$/.exec(p);
  if (m2) {
    return `/mnt/${m2[1].toLowerCase()}/${m2[2]}`;
  }
  return p.replace(/\\/g, "/");
}


function extractDiffBlocks(text: string): string[] {
  if (!text) return [];

  const results: string[] = [];

  const looksLikeDiffBlock = (block: string) => {
    if (!block) return false;
    if (/(^|\n)diff --git\s/.test(block)) return true;
    if (/(^|\n)Index:/i.test(block) && /(^|\n)(---|\+\+\+)/.test(block)) return true;
    if (/(^|\n)(---|\+\+\+|@@|\*\*\*)\s/.test(block)) return true;
    return false;
  };

  const pushBlock = (raw: string) => {
    const trimmed = (raw || "").trim();
    if (!trimmed.length) return;
    if (!looksLikeDiffBlock(trimmed)) return;
    const duplicate = results.some(existing =>
      existing === trimmed
        || existing.includes(trimmed)
        || trimmed.includes(existing)
    );
    if (!duplicate) results.push(trimmed);
  };

  const fenceRegex = /```(\w+)?\s*\n([\s\S]*?)```/gi;
  let match: RegExpExecArray | null;

  while ((match = fenceRegex.exec(text))) {
    const lang = (match[1] || "").toLowerCase();
    const body = match[2] || "";
    const trimmed = body.trim();
    if (!trimmed.length) continue;
    if (lang && !["diff", "patch"].includes(lang) && !looksLikeDiffBlock(trimmed)) continue;
    if (!lang && !looksLikeDiffBlock(trimmed)) continue;
    pushBlock(trimmed);
  }

  const gitRegex = /(^diff --git[^\n]*\n[\s\S]*?)(?=^\s*(?:diff --git|Index:)|\n```|$)/gim;
  while ((match = gitRegex.exec(text))) {
    pushBlock(match[1] || "");
  }

  const unifiedRegex = /(^---\s.+?\r?\n\+\+\+\s.+?\r?\n@@[\s\S]*?)(?=^\s*(?:---\s|\+\+\+\s|diff --git|Index:)|\n```|$)/gm;
  while ((match = unifiedRegex.exec(text))) {
    pushBlock(match[1] || "");
  }

  return results;
}

function normalizeRepoRelativePath(value: string): string {
  return value
    .replace(/^\.\/+/, "")
    .replace(/^\/+/, "")
    .replace(/\\/g, "/")
    .replace(/\.\/+/g, "")
    .trim();
}

function extractMentionedPaths(text: string | null | undefined): string[] {
  if (!text) return [];
  const found = new Set<string>();
  const quotedRegex = /[`'\"]([^`'"\n]+\.(?:ts|tsx|js|jsx|json|css|md|html|yml|yaml))[`'\"]/gi;
  let match: RegExpExecArray | null;
  while ((match = quotedRegex.exec(text))) {
    const raw = match[1]?.trim();
    if (!raw) continue;
    const normalized = normalizeRepoRelativePath(raw);
    if (!normalized.length || normalized.includes("..") || normalized.startsWith(".ma/")) continue;
    found.add(normalized);
  }
  const slashRegex = /(^|[^A-Za-z0-9._/-])((?:src|app|lib|components|tests|public)\/[A-Za-z0-9._/-]+\.(?:ts|tsx|js|jsx|json|css|md|html|yml|yaml))/gi;
  while ((match = slashRegex.exec(text))) {
    const raw = match[2]?.trim();
    if (!raw) continue;
    const normalized = normalizeRepoRelativePath(raw);
    if (!normalized.length || normalized.includes("..") || normalized.startsWith(".ma/")) continue;
    found.add(normalized);
  }
  return Array.from(found).slice(0, 50);
}

type PromptFileSnippet = {
  path: string;
  content: string;
  truncated: boolean;
};

async function gatherPromptFileSnippets(repoRoot: string, preferredPaths: string[]): Promise<PromptFileSnippet[]> {
  const fs = await import("fs/promises");
  const pathMod = await import("path");
  const ndjsonPath = pathMod.resolve(repoRoot, ".ma/context/files.ndjson");
  let lines: string[] = [];
  try {
    const raw = await fs.readFile(ndjsonPath, "utf8");
    lines = raw.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  } catch {
    return [];
  }

  type Entry = { path: string; bytes: number };
  const entryMap = new Map<string, Entry>();
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line);
      const value = typeof parsed.path === "string" ? parsed.path : "";
      const normalized = normalizeRepoRelativePath(value);
      if (!normalized || normalized.includes("..")) continue;
      if (normalized.startsWith(".ma/") || normalized.startsWith("node_modules/") || normalized.startsWith("dist/")) continue;
      entryMap.set(normalized, {
        path: normalized,
        bytes: Number(parsed.bytes) || 0
      });
    } catch {
      continue;
    }
  }

  if (!entryMap.size) return [];

  const preferredSet = new Set(preferredPaths.map(normalizeRepoRelativePath));
  const seen = new Set<string>();
  const ordered: Entry[] = [];

  function scoreFor(pathValue: string): number {
    const lower = pathValue.toLowerCase();
    let score = 0;
    if (preferredSet.has(pathValue)) score += 1000;
    if (PROMPT_FILE_ALWAYS_INCLUDE.has(lower)) score += 600;
    if (pathValue.startsWith("src/")) score += 400;
    if (/\.(tsx?|jsx?)$/i.test(pathValue)) score += 200;
    if (/\.(css|json)$/i.test(pathValue)) score += 120;
    if (/\.(md|html|yml|yaml)$/i.test(pathValue)) score += 80;
    return score;
  }

  function take(pathValue: string) {
    const normalized = normalizeRepoRelativePath(pathValue);
    const entry = entryMap.get(normalized);
    if (!entry) return;
    if (seen.has(entry.path)) return;
    seen.add(entry.path);
    ordered.push(entry);
  }

  for (const p of preferredSet) take(p);

  const remaining = Array.from(entryMap.values()).filter(entry => !seen.has(entry.path));
  remaining.sort((a, b) => {
    const scoreDiff = scoreFor(b.path) - scoreFor(a.path);
    if (scoreDiff !== 0) return scoreDiff;
    return (a.bytes || 0) - (b.bytes || 0);
  });
  for (const entry of remaining) take(entry.path);

  const snippets: PromptFileSnippet[] = [];
  let totalChars = 0;

  for (const entry of ordered) {
    if (snippets.length >= PROMPT_FILE_MAX_FILES) break;
    const normalizedPath = entry.path;
    const lower = normalizedPath.toLowerCase();
    const ext = pathMod.extname(lower);
    const include = PROMPT_FILE_ALLOWED_EXTS.has(ext) || PROMPT_FILE_ALWAYS_INCLUDE.has(lower);
    if (!include) continue;

    const absolute = pathMod.resolve(repoRoot, normalizedPath);
    try {
      const stat = await fs.stat(absolute);
      if (!stat.isFile()) continue;
      let content = await fs.readFile(absolute, "utf8");
      let truncated = false;
      if (content.length > PROMPT_FILE_MAX_PER_FILE_CHARS) {
        content = content.slice(0, PROMPT_FILE_MAX_PER_FILE_CHARS) + "\n... (truncated for prompt)\n";
        truncated = true;
      }
      if (totalChars + content.length > PROMPT_FILE_MAX_TOTAL_CHARS) {
        if (totalChars === 0) {
          content = content.slice(0, PROMPT_FILE_MAX_TOTAL_CHARS) + "\n... (truncated for prompt)\n";
          truncated = true;
          snippets.push({ path: normalizedPath, content, truncated });
        }
        break;
      }
      snippets.push({ path: normalizedPath, content, truncated });
      totalChars += content.length;
    } catch {
      continue;
    }
  }

  return snippets;
}

function normalizeDiffHunkCounts(diff: string): string {
  if (!diff.includes("@@")) return diff;
  const lines = diff.split(/\r?\n/);
  let changed = false;

  const hunkRegex = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const match = hunkRegex.exec(line);
    if (!match) continue;

    const oldStart = match[1];
    const newStart = match[3];

    let oldCount = 0;
    let newCount = 0;
    for (let j = i + 1; j < lines.length; j += 1) {
      const hunkLine = lines[j];
      if (hunkLine.startsWith("@@ ")) break;
      if (hunkLine.startsWith("diff --git ")) break;
      if (hunkLine.startsWith("--- ") || hunkLine.startsWith("+++ ")) break;
      if (hunkLine.startsWith("\\ No newline")) continue;
      if (hunkLine.length === 0) {
        oldCount += 1;
        newCount += 1;
        continue;
      }
      const first = hunkLine[0];
      if (first === '+') {
        newCount += 1;
      } else if (first === '-') {
        oldCount += 1;
      } else {
        oldCount += 1;
        newCount += 1;
      }
    }

    const oldCountProvided = match[2] ? Number(match[2]) : null;
    const newCountProvided = match[4] ? Number(match[4]) : null;

    if (oldCountProvided !== oldCount || newCountProvided !== newCount) {
      lines[i] = `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`;
      changed = true;
    }
  }

  return changed ? lines.join("\n") : diff;
}

type ParsedUnifiedDiff = {
  path: string;
  hunks: Array<{
    oldStart: number;
    newStart: number;
    lines: string[];
  }>;
};

function parseUnifiedDiff(diff: string): ParsedUnifiedDiff | null {
  const lines = diff.split(/\r?\n/);
  let filePath: string | null = null;
  const hunks: ParsedUnifiedDiff["hunks"] = [];

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.startsWith("+++ ")) {
      const plusPath = line.slice(4).trim();
      if (plusPath && !plusPath.startsWith("/dev/null")) {
        filePath = plusPath.startsWith("b/") ? plusPath.slice(2) : plusPath;
      }
      continue;
    }
    if (!filePath) continue;
    if (line.startsWith("@@ ")) {
      const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (!match) continue;
      const oldStart = Number(match[1]) || 1;
      const newStart = Number(match[3]) || 1;
      const hunk = { oldStart, newStart, lines: [] as string[] };
      hunks.push(hunk);
      for (let j = i + 1; j < lines.length; j += 1) {
        const nextLine = lines[j];
        if (nextLine.startsWith("@@ ") || nextLine.startsWith("diff --git ") || nextLine.startsWith("+++ ") || nextLine.startsWith("--- ")) {
          i = j - 1;
          break;
        }
        hunk.lines.push(nextLine);
        if (j === lines.length - 1) {
          i = j;
        }
      }
    }
  }

  if (!filePath || hunks.length === 0) return null;
  return { path: filePath, hunks };
}

async function applyDiffTextually(options: {
  diff: string;
  repoRoot: string;
  fs: FsPromisesModule;
  pathMod: PathModule;
}): Promise<string[] | null> {
  const { diff, repoRoot, fs, pathMod } = options;
  const isNewFile = /^---\s+\/dev\/null/m.test(diff);
  const parsed = parseUnifiedDiff(diff);
  if (!parsed) {
    logger.info("textual diff fallback skipped", { repoRoot, reason: "parse_failed" });
    return null;
  }
  const targetPath = pathMod.resolve(repoRoot, parsed.path);
  let content = "";
  let hasTrailingNewline = true;
  let eol = "\n";
  let lines: string[] = [];

  if (!isNewFile) {
    try {
      content = await fs.readFile(targetPath, "utf8");
    } catch {
      logger.info("textual diff fallback skipped", { repoRoot, path: parsed.path, reason: "file_missing" });
      return null;
    }
    hasTrailingNewline = content.endsWith("\n");
    eol = content.includes("\r\n") ? "\r\n" : "\n";
    lines = content.split(/\r?\n/);
  } else {
    hasTrailingNewline = true;
    eol = "\n";
    lines = [];
  }

  const isFullRewrite = parsed.hunks.length === 1
    && parsed.hunks[0].newStart === 1
    && (parsed.hunks[0].oldStart === 1 || isNewFile);

  if (isFullRewrite) {
    const hunk = parsed.hunks[0];
    const newLines: string[] = [];
    let sawNonContext = false;
    for (const line of hunk.lines) {
      if (line.startsWith("+")) {
        newLines.push(line.slice(1));
        sawNonContext = true;
      } else if (line.startsWith(" ")) {
        newLines.push(line.slice(1));
      } else if (line.startsWith("-")) {
        sawNonContext = true;
      }
    }
    if (sawNonContext || isNewFile) {
      let newContent = newLines.join(eol);
      if (hasTrailingNewline && !newContent.endsWith(eol)) newContent += eol;
      if (!hasTrailingNewline && newContent.endsWith(eol)) newContent = newContent.slice(0, -eol.length);
      await fs.mkdir(pathMod.dirname(targetPath), { recursive: true });
      await fs.writeFile(targetPath, newContent, "utf8");
      return [parsed.path];
    }
  }

  const normalizeLine = (value: string) => value.replace(/[\t ]+$/g, "");
  const linesEqual = (a: string, b: string) => a === b || normalizeLine(a) === normalizeLine(b);

  const findSequence = (sequence: string[], guess: number) => {
    if (sequence.length === 0) return Math.max(0, Math.min(guess, lines.length));
    const maxOffset = Math.max(20, sequence.length * 2);
    const start = Math.max(0, guess - maxOffset);
    const end = Math.max(0, Math.min(lines.length - sequence.length, guess + maxOffset));
    const candidateRanges = [] as number[];
    for (let idx = start; idx <= end; idx += 1) candidateRanges.push(idx);
    if (!candidateRanges.length) {
      for (let idx = 0; idx <= lines.length - sequence.length; idx += 1) candidateRanges.push(idx);
    }
    for (const idx of candidateRanges) {
      let matched = true;
      for (let j = 0; j < sequence.length; j += 1) {
        if (!linesEqual(lines[idx + j], sequence[j])) {
          matched = false;
          break;
        }
      }
      if (matched) return idx;
    }
    return -1;
  };

  let offset = 0;
  for (const hunk of parsed.hunks) {
    const oldLines: string[] = [];
    const newLines: string[] = [];
    for (const line of hunk.lines) {
      if (line.startsWith("-")) {
        oldLines.push(line.slice(1));
      } else if (line.startsWith("+")) {
        newLines.push(line.slice(1));
      } else if (line.startsWith(" ")) {
        const value = line.slice(1);
        oldLines.push(value);
        newLines.push(value);
      } else if (line.startsWith("\\ No newline")) {
        // ignore directive, no change needed
        continue;
      } else {
        oldLines.push(line);
        newLines.push(line);
      }
    }

    const guess = Math.max(0, Math.min(lines.length, (hunk.oldStart - 1) + offset));
    let index = findSequence(oldLines, guess);
    if (index === -1) index = findSequence(oldLines, 0);

    let usedApproximateIndex = false;

    if (index === -1) {
      index = Math.max(0, Math.min(lines.length, (hunk.oldStart - 1) + offset));
      usedApproximateIndex = true;
    }

    if (index < 0 || index > lines.length) {
      logger.info("textual diff fallback skipped", { repoRoot, path: parsed.path, reason: "context_not_found", guess });
      return null;
    }

    if (usedApproximateIndex) {
      logger.warn("textual diff fallback approximate placement", {
        repoRoot,
        path: parsed.path,
        guess,
        resolvedIndex: index
      });
    }

    lines.splice(index, oldLines.length, ...newLines);
    offset = offset + (newLines.length - oldLines.length);
  }

  let newContent = lines.join(eol);
  if (hasTrailingNewline && !newContent.endsWith(eol)) newContent += eol;
  if (!hasTrailingNewline && newContent.endsWith(eol)) {
    newContent = newContent.slice(0, -eol.length);
  }

  await fs.writeFile(targetPath, newContent, "utf8");
  return [parsed.path];
}

async function isDiffAlreadyApplied(options: {
  diff: string;
  repoRoot: string;
  fs: FsPromisesModule;
  pathMod: PathModule;
}): Promise<boolean> {
  const { diff, repoRoot, fs, pathMod } = options;
  const parsed = parseUnifiedDiff(diff);
  if (!parsed) return false;

  const targetPath = pathMod.resolve(repoRoot, parsed.path);
  let content: string;
  try {
    content = await fs.readFile(targetPath, "utf8");
  } catch {
    return false;
  }

  const normalizedContent = content.replace(/\r\n/g, "\n");
  const contentLines = normalizedContent.split("\n");
  const normalizeLine = (value: string) => value.replace(/[\t ]+$/g, "");
  const linesEqual = (a: string, b: string) => a === b || normalizeLine(a) === normalizeLine(b);

  const findSequenceIndex = (sequence: string[]): number => {
    if (!sequence.length) return -1;
    for (let idx = 0; idx <= contentLines.length - sequence.length; idx += 1) {
      let matched = true;
      for (let j = 0; j < sequence.length; j += 1) {
        if (!linesEqual(contentLines[idx + j], sequence[j])) {
          matched = false;
          break;
        }
      }
      if (matched) return idx;
    }
    return -1;
  };

  for (const hunk of parsed.hunks) {
    const oldLines: string[] = [];
    const newLines: string[] = [];
    const addedSegments: string[][] = [];
    const removedSegments: string[][] = [];
    let currentAdded: string[] = [];
    let currentRemoved: string[] = [];

    for (const line of hunk.lines) {
      if (line.startsWith(" ")) {
        const value = line.slice(1);
        oldLines.push(value);
        newLines.push(value);
        if (currentAdded.length) {
          addedSegments.push(currentAdded);
          currentAdded = [];
        }
        if (currentRemoved.length) {
          removedSegments.push(currentRemoved);
          currentRemoved = [];
        }
      } else if (line.startsWith("-")) {
        const value = line.slice(1);
        oldLines.push(value);
        currentRemoved.push(value);
        if (currentAdded.length) {
          addedSegments.push(currentAdded);
          currentAdded = [];
        }
      } else if (line.startsWith("+")) {
        const value = line.slice(1);
        newLines.push(value);
        currentAdded.push(value);
        if (currentRemoved.length) {
          removedSegments.push(currentRemoved);
          currentRemoved = [];
        }
      }
    }

    if (currentAdded.length) addedSegments.push(currentAdded);
    if (currentRemoved.length) removedSegments.push(currentRemoved);

    const oldText = oldLines.join("\n");
    const newText = newLines.join("\n");

    if (oldText === newText) continue;

    for (const segment of addedSegments) {
      if (segment.length && findSequenceIndex(segment) === -1) {
        return false;
      }
    }

    for (const segment of removedSegments) {
      if (segment.length && findSequenceIndex(segment) !== -1) {
        return false;
      }
    }
  }

  return true;
}

async function applyDiffUsingPatchTool(patchPath: string, repoRoot: string): Promise<boolean> {
  try {
    const childProcess = await import("child_process");
    const util = await import("util");
    const execFileAsync = util.promisify(childProcess.execFile);
    const baseArgs = ["-p1", "--forward", "--silent", "--input", patchPath];
    await execFileAsync("patch", ["--batch", "--dry-run", ...baseArgs], { cwd: repoRoot });
    await execFileAsync("patch", ["--batch", ...baseArgs], { cwd: repoRoot });
    return true;
  } catch (error: any) {
    if (error?.code === "ENOENT") {
      logger.debug("patch cli unavailable", { repoRoot });
      return false;
    }
    if (error?.stdout || error?.stderr) {
      logger.debug("patch cli attempt failed", {
        repoRoot,
        stdout: error.stdout,
        stderr: error.stderr
      });
    }
    throw error;
  }
}

type CommandRunResult = {
  command: string;
  stdout: string;
  stderr: string;
  exitCode: number;
  signal: NodeJS.Signals | null;
  durationMs: number;
  error?: string;
};

async function runShellCommand(command: string, cwd: string, timeoutMs = 300000): Promise<CommandRunResult> {
  const childProcess = await import("child_process");
  const started = Date.now();
  return await new Promise((resolve) => {
    let resolved = false;
    try {
      const child = childProcess.exec(command, { cwd, timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024 }, (error: any, stdout: string, stderr: string) => {
        if (resolved) return;
        resolved = true;
        const durationMs = Date.now() - started;
        if (error) {
          resolve({
            command,
            stdout: stdout ?? "",
            stderr: stderr ?? "",
            exitCode: typeof error.code === "number" ? error.code : 1,
            signal: error.signal ?? null,
            durationMs,
            error: typeof error.message === "string" ? error.message : undefined
          });
        } else {
          resolve({ command, stdout: stdout ?? "", stderr: stderr ?? "", exitCode: 0, signal: null, durationMs });
        }
      });
      child.on("error", (error: any) => {
        if (resolved) return;
        resolved = true;
        const durationMs = Date.now() - started;
        resolve({
          command,
          stdout: "",
          stderr: "",
          exitCode: typeof error?.code === "number" ? error.code : 1,
          signal: null,
          durationMs,
          error: String(error?.message || error)
        });
      });
    } catch (error: any) {
      if (resolved) return;
      resolved = true;
      const durationMs = Date.now() - started;
      resolve({
        command,
        stdout: "",
        stderr: "",
        exitCode: typeof error?.code === "number" ? error.code : 1,
        signal: null,
        durationMs,
        error: String(error?.message || error)
      });
    }
  });
}

type QaDiagnostics = {
  text: string;
  entries: Array<{
    command: string;
    exitCode: number;
    signal: NodeJS.Signals | null;
    durationMs: number;
    stdout: string;
    stderr: string;
    error?: string;
    logs?: Array<{ path: string; content: string }>;
  }>;
};

async function gatherQaDiagnostics(commandsInput: any, repoRoot: string): Promise<QaDiagnostics | null> {
  const commands = Array.isArray(commandsInput)
    ? (commandsInput as any[]).map((cmd: any) => (typeof cmd === "string" ? cmd.trim() : "")).filter((value: string): value is string => value.length > 0)
    : [];

  if (!commands.length) return null;

  const entries: QaDiagnostics["entries"] = [];

  for (const command of commands) {
    const result = await runShellCommand(command, repoRoot).catch((error: any) => {
      return {
        command,
        stdout: "",
        stderr: "",
        exitCode: 1,
        signal: null,
        durationMs: 0,
        error: String(error?.message || error)
      } as CommandRunResult;
    });

    const entry = {
      command: result.command,
      exitCode: result.exitCode,
      signal: result.signal,
      durationMs: result.durationMs,
      stdout: clipText((result.stdout || "").trim(), 2000) || "(no stdout)",
      stderr: clipText((result.stderr || "").trim(), 2000) || "(no stderr)",
      error: result.error,
      logs: [] as Array<{ path: string; content: string }>
    };

    entries.push(entry);

    if (result.exitCode !== 0) {
      // On failure, look for common log files produced by test/lint tools and attach their contents.
      try {
        const candidates = [
          "npm-debug.log",
          "npm-debug.log.*",
          "test-results.log",
          "test-output.log",
          "jest-results.json",
          "lint-report.txt",
          "eslint-report.txt",
          "coverage/lcov.info",
          "coverage/coverage-final.json",
          "reports/test-results.xml"
        ];
        for (const pattern of candidates) {
          const globPath = path.join(repoRoot, pattern);
          try {
            // simple existence check for exact files, and for patterns try a wildcard glob via readdir when necessary
            if (!pattern.includes("*")) {
              const stat = await fs.stat(globPath).catch(() => null);
              if (stat) {
                const raw = await fs.readFile(globPath, "utf8").catch(() => "");
                if (raw && raw.trim().length) {
                  entry.logs!.push({ path: path.relative(repoRoot, globPath), content: clipText(raw, 10000) });
                }
              }
            } else {
              // pattern contains wildcard - list directory and match
              const dir = path.dirname(globPath);
              const basePattern = path.basename(pattern).replace(/\*/g, "");
              const files = await fs.readdir(dir).catch(() => [] as string[]);
              for (const f of files) {
                if (basePattern && !f.includes(basePattern)) continue;
                const full = path.join(dir, f);
                const stat = await fs.stat(full).catch(() => null);
                if (!stat || !stat.isFile()) continue;
                const raw = await fs.readFile(full, "utf8").catch(() => "");
                if (raw && raw.trim().length) entry.logs!.push({ path: path.relative(repoRoot, full), content: clipText(raw, 10000) });
              }
            }
          } catch (err) {
            // ignore individual file read errors
          }
        }
        // Also look for absolute paths mentioned in stdout/stderr (e.g. npm debug log path) and attach them
        try {
          const combined = `${result.stdout || ""}\n${result.stderr || ""}`;
          const npmMatch = /A complete log of this run can be found in:\s*(\S+)/i.exec(combined);
          const pathsFound = new Set<string>();
          if (npmMatch && npmMatch[1]) pathsFound.add(npmMatch[1]);
          // generic absolute path matches (Unix)
          const absPathRegex = /(?<!\S)(\/[^\s:]+)/g;
          let m: RegExpExecArray | null;
          while ((m = absPathRegex.exec(combined))) {
            const candidate = m[1];
            if (candidate.includes("/.npm/_logs/") || candidate.startsWith(repoRoot) || candidate.startsWith(process.env.HOME || "")) {
              pathsFound.add(candidate);
            }
          }
          for (const p of Array.from(pathsFound)) {
            try {
              const raw = await fs.readFile(p, "utf8").catch(() => "");
              if (raw && raw.trim().length) entry.logs!.push({ path: path.relative(repoRoot, p), content: clipText(raw, 10000) });
            } catch (err) {
              // ignore
            }
          }
        } catch (err) {
          // ignore
        }
      } catch (err) {
        // ignore overall diagnostics attach failures
      }
      break;
    }
  }

  if (!entries.length) return null;

  const textParts = entries.map(entry => {
    const lines: string[] = [];
    lines.push(`Command: ${entry.command}`);
    lines.push(`Exit code: ${entry.exitCode}` + (entry.signal ? ` (signal: ${entry.signal})` : ""));
    if (entry.error) lines.push(`Error: ${entry.error}`);
    if (entry.stdout && entry.stdout !== "(no stdout)") {
      lines.push(`STDOUT:\n${entry.stdout}`);
    }
    if (entry.stderr && entry.stderr !== "(no stderr)") {
      lines.push(`STDERR:\n${entry.stderr}`);
    }
    if (entry.logs && entry.logs.length) {
      for (const l of entry.logs) {
        lines.push(`LOG ${l.path}:\n${l.content}`);
      }
    }
    return lines.join("\n");
  });

  return { text: textParts.join("\n\n"), entries };
}

function extractPathsFromDiff(diff: string): string[] {
  const paths = new Set<string>();
  const diffGitRegex = /^diff --git a\/([^\s]+) b\/([^\s]+)/gm;
  let match: RegExpExecArray | null;
  while ((match = diffGitRegex.exec(diff))) {
    const left = match[1]?.trim();
    const right = match[2]?.trim();
    if (left && left !== 'dev/null') paths.add(left);
    if (right && right !== 'dev/null') paths.add(right);
  }
  const fileRegex = /^(?:---|\+\+\+)\s+(?:a\/|b\/)([^\r\n]+)/gm;
  while ((match = fileRegex.exec(diff))) {
    const p = match[1]?.trim();
    if (p && p !== 'dev/null') paths.add(p);
  }
  return Array.from(paths);
}

type FsPromisesModule = typeof import("fs/promises");
type PathModule = typeof import("path");

type ParsedNewFileDiff = {
  path: string;
  content: string;
};

function parseNewFileDiff(diff: string): ParsedNewFileDiff | null {
  if (!diff) return null;
  if (!/---\s+\/dev\/null/.test(diff)) return null;

  const plusMatch = /(?:^|\n)\+\+\+\s+b\/([^\n]+)/.exec(diff);
  if (!plusMatch) return null;

  const rawPath = plusMatch[1]?.trim();
  if (!rawPath || rawPath.toLowerCase() === 'dev/null') return null;

  const normalizedPath = rawPath.replace(/^b\//, "").replace(/^\.\//, "");
  if (!normalizedPath || normalizedPath === '.' || normalizedPath === '..') return null;

  const lines = diff.split(/\r?\n/);
  const contentLines: string[] = [];
  let inHunk = false;
  let keepTrailingNewline = true;

  for (const line of lines) {
    if (line.startsWith("diff --git ") && inHunk) break;
    if (line.startsWith("@@")) {
      inHunk = true;
      continue;
    }
    if (!inHunk) continue;

    if (line.startsWith("\\ No newline at end of file")) {
      keepTrailingNewline = false;
      continue;
    }

    if (line.startsWith("+")) {
      contentLines.push(line.slice(1));
    }
  }

  if (!inHunk) return null;

  let content = contentLines.join("\n");
  if (keepTrailingNewline && contentLines.length > 0) {
    content += "\n";
  }

  return {
    path: normalizedPath,
    content
  };
}

async function overwriteExistingFileFromNewDiff(options: {
  diff: string;
  repoRoot: string;
  fs: FsPromisesModule;
  pathMod: PathModule;
}): Promise<string | null> {
  const { diff, repoRoot, fs, pathMod } = options;
  const parsed = parseNewFileDiff(diff);
  if (!parsed) return null;

  const sanitized = parsed.path.replace(/\\/g, "/");
  if (!sanitized) {
    return null;
  }

  const normalized = pathMod.normalize(sanitized);
  const targetPath = pathMod.resolve(repoRoot, normalized);
  const repoResolved = pathMod.resolve(repoRoot);

  if (!targetPath.startsWith(repoResolved)) {
    return null;
  }

  try {
    await fs.mkdir(pathMod.dirname(targetPath), { recursive: true });
    await fs.writeFile(targetPath, parsed.content, "utf8");
    return pathMod.relative(repoRoot, targetPath) || normalized;
  } catch {
    return null;
  }
}

function extractListedPaths(text: string): string[] {
  if (!text) return [];
  const found = new Set<string>();
  const sectionRegex = /(Changed Files?|Files Affected|Touched Files):([\s\S]*?)(?:\n\s*\n|\n[A-Z][^:\n]*:|$)/gi;
  let section: RegExpExecArray | null;
  while ((section = sectionRegex.exec(text))) {
    const body = section[2];
    if (!body) continue;
    for (const line of body.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const normalized = trimmed.replace(/^[*\-]\s*/, '').trim();
      if (!normalized) continue;
      const candidate = normalized.split(/[\s`]/)[0];
      if (candidate && candidate !== '/') found.add(candidate);
    }
  }
  return Array.from(found);
}

function extractCommitMessage(text: string): string | null {
  if (!text) return null;
  const patterns = [
    /Commit Message:\s*["']?([^"'\n]+)/i,
    /Proposed Commit Message:\s*["']?([^"'\n]+)/i,
    /Commit:\s*["']?([^"'\n]+)/i,
    /Message:\s*["']?([^"'\n]+)/i
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (match && match[1]) return match[1].trim();
  }
  return null;
}

const PASS_STATUS_KEYWORDS = new Set(["pass", "passed", "success", "succeeded", "approved", "ok", "green", "lgtm"]);
const FAIL_STATUS_KEYWORDS = new Set(["fail", "failed", "block", "blocked", "reject", "rejected", "error", "not pass", "red"]);

function extractJsonPayloadFromText(text: string | undefined): any | null {
  if (!text) return null;
  const fenceRegex = /```(?:json)?\s*([\s\S]*?)```/gi;
  let match: RegExpExecArray | null;
  while ((match = fenceRegex.exec(text))) {
    const snippet = match[1];
    try { return JSON.parse(snippet); } catch {}
  }
  const firstBrace = text.indexOf("{");
  const lastBrace = text.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    const candidate = text.slice(firstBrace, lastBrace + 1);
    try { return JSON.parse(candidate); } catch {}
  }
  return null;
}

type PersonaStatusInfo = {
  status: "pass" | "fail" | "unknown";
  details: string;
  raw: string;
  payload?: any;
};

function interpretPersonaStatus(output: string | undefined): PersonaStatusInfo {
  const raw = (output || "").trim();
  const json = extractJsonPayloadFromText(raw);
  if (json && typeof json.status === "string") {
    const statusLower = json.status.trim().toLowerCase();
    let normalized: "pass" | "fail" | "unknown" = "unknown";
    if (PASS_STATUS_KEYWORDS.has(statusLower)) normalized = "pass";
    else if (FAIL_STATUS_KEYWORDS.has(statusLower)) normalized = "fail";
    const details = typeof json.details === "string" ? json.details : raw || JSON.stringify(json);
    return { status: normalized, details, raw, payload: json };
  }
  if (!raw.length) return { status: "unknown", details: raw, raw };
  const lower = raw.toLowerCase();
  for (const key of FAIL_STATUS_KEYWORDS) {
    if (lower.includes(key)) return { status: "fail", details: raw, raw };
  }
  for (const key of PASS_STATUS_KEYWORDS) {
    if (lower.includes(key)) return { status: "pass", details: raw, raw };
  }
  return { status: "unknown", details: raw, raw, payload: json };
}

async function ensureGroups(r: any) {
  for (const p of cfg.allowedPersonas) {
    try { await r.xGroupCreate(cfg.requestStream, groupForPersona(p), "$", { MKSTREAM: true }); } catch {}
  }
  try { await r.xGroupCreate(cfg.eventStream, `${cfg.groupPrefix}:coordinator`, "$", { MKSTREAM: true }); } catch {}
}

async function handleCoordinator(r: any, msg: any, payloadObj: any) {
  const workflowId = msg.workflow_id;
  const projectId = firstString(payloadObj.project_id, payloadObj.projectId, msg.project_id);
  if (!projectId) throw new Error("Coordinator requires project_id in payload or message");

  let projectInfo: any = await fetchProjectStatus(projectId);
  let projectStatus: any = await fetchProjectStatusDetails(projectId);
  let nextActionData: any = await fetchProjectNextAction(projectId);
  const projectSlug = firstString(payloadObj.project_slug, payloadObj.projectSlug, projectInfo?.slug, projectInfo?.id);
  const projectRepo = firstString(
    payloadObj.repo,
    payloadObj.repository,
    typeof projectInfo?.repository === "string" ? projectInfo.repository : null,
    projectInfo?.repository?.url,
    projectInfo?.repository?.remote,
    projectInfo?.repo?.url,
    projectInfo?.repo_url,
    projectInfo?.git_url,
    Array.isArray(projectInfo?.repositories) ? projectInfo.repositories[0]?.url : null
  );

  if (!projectRepo) {
    logger.error("coordinator abort: project repository missing", { workflowId, projectId });
    throw new Error(`Project ${projectId} has no repository associated`);
  }

  if (!payloadObj.repo) payloadObj.repo = projectRepo;
  if (!payloadObj.project_slug && projectSlug) payloadObj.project_slug = projectSlug;
  if (!payloadObj.project_name && projectInfo?.name) payloadObj.project_name = projectInfo.name;

  const repoResolution = await resolveRepoFromPayload(payloadObj);
  const repoRoot = normalizeRepoPath(repoResolution.repoRoot, cfg.repoRoot);
  const repoMeta = await getRepoMetadata(repoRoot);

  const baseBranch = firstString(
    payloadObj.base_branch,
    payloadObj.branch,
    repoResolution.branch,
    repoMeta.currentBranch,
    cfg.git.defaultBranch
  ) || cfg.git.defaultBranch;



  const milestoneSource = projectStatus ?? projectInfo;
  let selectedMilestone = (payloadObj.milestone && typeof payloadObj.milestone === "object")
    ? payloadObj.milestone
    : selectNextMilestone(milestoneSource);

  if (!selectedMilestone && projectInfo && projectInfo !== milestoneSource) {
    selectedMilestone = selectNextMilestone(projectInfo) || selectedMilestone;
  }

  if (!selectedMilestone && milestoneSource && typeof milestoneSource === "object") {
    const explicit = (milestoneSource as any).next_milestone ?? (milestoneSource as any).nextMilestone;
    if (explicit && typeof explicit === "object") selectedMilestone = explicit;
  }

  if (!selectedMilestone) {
    logger.warn("coordinator milestone fallback", { workflowId, projectId });
  }

  const milestoneName = firstString(
    payloadObj.milestone_name,
    selectedMilestone?.name,
    selectedMilestone?.title,
    selectedMilestone?.goal,
    (milestoneSource as any)?.next_milestone?.name,
    (milestoneSource as any)?.nextMilestone?.name,
    projectInfo?.next_milestone?.name,
    "next milestone"
  )!;

  const milestoneSlug = slugify(
    firstString(
      payloadObj.milestone_slug,
      selectedMilestone?.slug,
      milestoneName,
      "milestone"
    )!
  );

  let selectedTask = selectNextTask(selectedMilestone, milestoneSource, projectStatus, projectInfo, payloadObj);
  if (!selectedTask) {
    const suggested = pickSuggestion(nextActionData?.suggestions);
    if (suggested) {
      selectedTask = suggested;
      logger.info("coordinator selected suggestion task", { workflowId, task: suggested.name, reason: suggested.summary });
    }
  }

  const taskName = firstString(
    payloadObj.task_name,
    selectedTask?.name,
    selectedTask?.title,
    selectedTask?.summary,
    selectedTask?.label,
    selectedTask?.key,
    selectedTask?.id
  ) || null;

  if (taskName && !payloadObj.task_name) payloadObj.task_name = taskName;

  const rawTaskSlug = firstString(
    payloadObj.task_slug,
    selectedTask?.slug,
    selectedTask?.key,
    taskName,
    selectedTask?.id,
    "task"
  );
  const taskSlug = rawTaskSlug ? slugify(rawTaskSlug) : null;

  const taskDueText = firstString(
    selectedTask?.due,
    selectedTask?.due_at,
    selectedTask?.dueAt,
    selectedTask?.due_date,
    selectedTask?.target_date,
    selectedTask?.targetDate,
    selectedTask?.deadline,
    selectedTask?.eta
  );

  const selectedTaskStatus = normalizeTaskStatus(
    selectedTask?.status ??
    selectedTask?.state ??
    selectedTask?.phase ??
    selectedTask?.stage ??
    selectedTask?.progress
  );

  const taskDescriptor = selectedTask
    ? {
        id: firstString(selectedTask.id, selectedTask.key, taskSlug, taskName) || null,
        name: taskName,
        slug: taskSlug,
        status: selectedTask?.status ?? selectedTask?.state ?? selectedTask?.progress ?? null,
        normalized_status: selectedTaskStatus || null,
        due: taskDueText || null,
        assignee: firstString(
          selectedTask?.assignee,
          selectedTask?.assignee_name,
          selectedTask?.assigneeName,
          selectedTask?.owner,
          selectedTask?.owner_name,
          selectedTask?.assigned_to,
          selectedTask?.assignedTo
        ) || null,
        branch: firstString(selectedTask?.branch, selectedTask?.branch_name, selectedTask?.branchName) || null,
        summary: firstString(selectedTask?.summary, selectedTask?.description) || null
      }
    : null;

  let branchName = payloadObj.branch_name
    || firstString(
      selectedMilestone?.branch,
      selectedMilestone?.branch_name,
      selectedMilestone?.branchName
    )
    || `milestone/${milestoneSlug}`;

  await checkoutBranchFromBase(repoRoot, baseBranch, branchName);
  logger.info("coordinator prepared branch", { workflowId, repoRoot, baseBranch, branchName });

  await ensureBranchPublished(repoRoot, branchName);

  const repoSlug = repoMeta.remoteSlug;
  const repoRemote = repoSlug ? `https://${repoSlug}.git` : (payloadObj.repo || projectRepo || repoMeta.remoteUrl || repoResolution.remote || "");
  if (!repoRemote) throw new Error("Coordinator could not determine repo remote");

  const milestoneDue = firstString(
    selectedMilestone?.due,
    selectedMilestone?.due_at,
    selectedMilestone?.dueAt,
    selectedMilestone?.due_date,
    selectedMilestone?.target_date,
    selectedMilestone?.targetDate,
    selectedMilestone?.deadline,
    selectedMilestone?.eta
  );

  const milestoneDescriptor = selectedMilestone
    ? {
        id: selectedMilestone.id ?? milestoneSlug,
        name: milestoneName,
        slug: milestoneSlug,
        status: selectedMilestone.status,
        goal: selectedMilestone.goal,
        due: milestoneDue || null,
        branch: firstString(selectedMilestone.branch, selectedMilestone.branch_name, selectedMilestone.branchName) || branchName,
        task: taskDescriptor
      }
    : (taskDescriptor ? { task: taskDescriptor } : null);
  const contextCorrId = randomUUID();
  await sendPersonaRequest(r, {
    workflowId,
    toPersona: "context",
    step: "1-context",
    intent: "hydrate_project_context",
    payload: {
      repo: repoRemote,
      branch: branchName,
      project_id: projectId,
      project_slug: projectSlug || undefined,
      project_name: payloadObj.project_name || projectInfo?.name || "",
      milestone: milestoneDescriptor,
      milestone_name: milestoneName,
      task: taskDescriptor,
      task_name: taskName || (taskDescriptor?.name ?? ""),
      upload_dashboard: true
    },
    corrId: contextCorrId,
    repo: repoRemote,
    branch: branchName,
    projectId
  });

  const contextEvent = await waitForPersonaCompletion(r, "context", workflowId, contextCorrId);
  const contextResult = parseEventResult(contextEvent.fields.result);
  logger.info("coordinator received context completion", { workflowId, corrId: contextCorrId, eventId: contextEvent.id });

  type PersonaStageResponse = {
    event: PersonaEvent;
    result: any;
    status: PersonaStatusInfo;
  };

  type StageOutcome = {
    pass: boolean;
    details: string;
    payload?: any;
    rawOutput: string;
  };

  type LeadCycleOutcome = {
    success: boolean;
    details: string;
    output: string;
    commit: any | null;
    paths: string[];
    appliedEdits?: any;
    result?: any;
    noChanges?: boolean;
    plan?: PlanApprovalOutcome | null;
  };

  async function runPersonaWithStatus(toPersona: string, step: string, intent: string, payload: any, options?: { timeoutMs?: number }): Promise<PersonaStageResponse> {
    const corrId = await sendPersonaRequest(r, {
      workflowId,
      toPersona,
      step,
      intent,
      payload,
      repo: repoRemote,
      branch: branchName,
      projectId: projectId!,
      deadlineSeconds: options?.timeoutMs ? Math.ceil(options.timeoutMs / 1000) : undefined
    });
    const event = await waitForPersonaCompletion(r, toPersona, workflowId, corrId, options?.timeoutMs);
    const resultObj = parseEventResult(event.fields.result);
    const statusInfo = interpretPersonaStatus(resultObj?.output);
    return { event, result: resultObj, status: statusInfo };
  }

  type PlanHistoryEntry = {
    attempt: number;
    content: string;
    payload: any;
  };

  type PlanApprovalOutcome = {
    planText: string;
    planPayload: any;
    planSteps: any[];
    history: PlanHistoryEntry[];
  };

  function extractPlanSteps(planPayload: any): any[] {
    if (!planPayload || typeof planPayload !== "object") return [];
    if (Array.isArray(planPayload.plan)) return planPayload.plan;
    if (Array.isArray(planPayload.steps)) return planPayload.steps;
    if (Array.isArray(planPayload.items)) return planPayload.items;
    return [];
  }

  async function runEngineerPlanApproval(implementationPersona: string, plannerPersona: string, basePayload: Record<string, any>, attempt: number, feedback: string | null): Promise<PlanApprovalOutcome | null> {
    if (!ENGINEER_PERSONAS_REQUIRING_PLAN.has(implementationPersona.toLowerCase())) return null;

    const planner = plannerPersona || implementationPersona;
    const plannerLower = planner.toLowerCase();
    if (!cfg.allowedPersonas.includes(planner)) {
      logger.warn("plan approval persona not allowed", { planner });
    }

    const effectiveMax = Number.isFinite(MAX_APPROVAL_RETRIES) ? MAX_APPROVAL_RETRIES : 10;
    const baseFeedbackText = feedback && feedback.trim().length ? feedback.trim() : "";
    let planFeedbackNotes: string[] = [];
    const planHistory: PlanHistoryEntry[] = [];

    for (let planAttempt = 0; planAttempt < effectiveMax; planAttempt += 1) {
      const feedbackTextParts = [] as string[];
      if (baseFeedbackText.length) feedbackTextParts.push(baseFeedbackText);
      if (planFeedbackNotes.length) feedbackTextParts.push(...planFeedbackNotes);
      const planFeedbackText = feedbackTextParts.length ? feedbackTextParts.join("\n\n") : undefined;

      const planPayload = {
        ...basePayload,
        feedback: baseFeedbackText || undefined,
        plan_feedback: planFeedbackText,
        plan_request: {
          attempt: planAttempt + 1,
          requires_approval: true,
          revision: attempt
        },
        plan_history: planHistory.length ? planHistory.slice() : undefined
      };

      const planCorrId = randomUUID();
      logger.info("coordinator dispatch plan", {
        workflowId,
        targetPersona: planner,
        attempt,
        planAttempt: planAttempt + 1
      });

      await sendPersonaRequest(r, {
        workflowId,
        toPersona: planner,
        step: "2-plan",
        intent: "plan_execution",
        payload: planPayload,
        corrId: planCorrId,
        repo: repoRemote,
        branch: branchName,
        projectId: projectId!
      });

      const planEvent = await waitForPersonaCompletion(r, planner, workflowId, planCorrId);
      const planResultObj = parseEventResult(planEvent.fields.result);
      const planOutput = planResultObj?.output || "";
      const planJson = extractJsonPayloadFromText(planOutput) || planResultObj?.payload || null;
      const planSteps = extractPlanSteps(planJson);

      planHistory.push({ attempt: planAttempt + 1, content: planOutput, payload: planJson });

      if (planSteps.length) {
        logger.info("plan approved", {
          workflowId,
          planner,
          attempt,
          planAttempt: planAttempt + 1,
          steps: planSteps.length
        });
        return { planText: planOutput, planPayload: planJson, planSteps, history: planHistory.slice() };
      }

      const issue = planJson && typeof planJson === "object"
        ? "Plan response did not include a non-empty 'plan' array."
        : "Plan response must include JSON with a 'plan' array describing the execution steps.";

      planFeedbackNotes = [
        `${issue} Please respond with JSON containing a 'plan' array (each item should summarize a step and include owners or dependencies) and confirm readiness for approval.`
      ];
      logger.warn("plan approval feedback", {
        workflowId,
        planner,
        attempt,
        planAttempt: planAttempt + 1,
        issue
      });
    }

    throw new Error(`Exceeded plan approval attempts for ${planner} on revision ${attempt}`);
  }

  type StageTaskDefinition = {
    id: string;
    title: string;
    description: string;
    defaultPriority?: number;
    assigneePersona?: string;
    schedule?: string;
  };

  function diagnosticsToMarkdown(diagnostics: any): string {
    if (!diagnostics) return "";
    if (typeof diagnostics === "string") return diagnostics;
    if (Array.isArray(diagnostics)) {
      return diagnostics.map((entry: any) => {
        if (!entry || typeof entry !== "object") return "";
        const command = typeof entry.command === "string" ? entry.command : "(unknown command)";
        const exitCode = typeof entry.exitCode === "number" ? entry.exitCode : "unknown";
        const stderr = typeof entry.stderr === "string" ? entry.stderr : "";
        const stdout = typeof entry.stdout === "string" ? entry.stdout : "";
        const parts = [`Command: ${command}`, `Exit code: ${exitCode}`];
        if (stdout.trim().length) parts.push(`STDOUT:\n${stdout.trim()}`);
        if (stderr.trim().length) parts.push(`STDERR:\n${stderr.trim()}`);
        return parts.join("\n");
      }).filter(Boolean).join("\n\n");
    }
    if (typeof diagnostics === "object") {
      const entries = Array.isArray((diagnostics as any).entries) ? (diagnostics as any).entries : [diagnostics];
      return diagnosticsToMarkdown(entries);
    }
    return String(diagnostics);
  }

  function extractStageTasks(stage: "qa" | "devops" | "code-review" | "security", details: string, payload: any): StageTaskDefinition[] {
    const tasks: StageTaskDefinition[] = [];
    const baseDescription = details || "Follow-up required";
    const diagnostics = diagnosticsToMarkdown(payload?.diagnostics ?? payload?.logs ?? payload?.evidence);

    const pushTask = (title: string, description: string, priority = 5, assignee?: string) => {
      const merged = diagnostics.trim().length ? `${description}\n\nDiagnostics:\n${diagnostics}` : description;
      tasks.push({
        id: `${stage}-${tasks.length + 1}`,
        title,
        description: merged,
        defaultPriority: priority,
        assigneePersona: assignee
      });
    };

    const issues = Array.isArray(payload?.issues) ? payload.issues : [];
    if (issues.length) {
      for (const [idx, issue] of issues.entries()) {
        if (!issue || typeof issue !== "object") continue;
        const title = typeof issue.title === "string" && issue.title.trim().length
          ? issue.title.trim()
          : `${stage.toUpperCase()} follow-up ${idx + 1}`;
        const note = typeof issue.note === "string" && issue.note.trim().length ? issue.note.trim() : baseDescription;
        const fileInfo = typeof issue.file === "string" && issue.file.trim().length ? `File: ${issue.file.trim()}` : "";
        const descriptionParts = [note];
        if (fileInfo) descriptionParts.push(fileInfo);
        if (issue.remediation) descriptionParts.push(String(issue.remediation));
        pushTask(title, descriptionParts.join("\n"), issue.priority_score ?? 5, issue.assignee_persona);
      }
    } else if (typeof payload === "object" && Array.isArray(payload?.actions)) {
      for (const [idx, action] of payload.actions.entries()) {
        if (!action || typeof action !== "object") continue;
        const title = typeof action.title === "string" && action.title.trim().length
          ? action.title.trim()
          : `${stage.toUpperCase()} action ${idx + 1}`;
        const description = typeof action.description === "string" && action.description.trim().length
          ? action.description.trim()
          : baseDescription;
        pushTask(title, description, action.priority_score ?? 5, action.assignee_persona);
      }
    } else {
      const titleMap: Record<typeof stage, string> = {
        qa: "QA follow-up",
        devops: "DevOps follow-up",
        "code-review": "Code review follow-up",
        security: "Security follow-up"
      };
      pushTask(titleMap[stage], baseDescription, 5, stage === "devops" ? "devops" : "lead-engineer");
    }

    return tasks;
  }

  async function createDashboardTaskEntries(tasks: StageTaskDefinition[], options: {
    stage: "qa" | "devops" | "code-review" | "security";
    milestoneDescriptor: any;
    parentTaskDescriptor: any;
    projectId: string | null;
    projectName: string | null;
    scheduleHint?: string;
  }): Promise<string[]> {
    if (!tasks.length) return [];
    const rawMilestone = options.milestoneDescriptor?.id ?? options.milestoneDescriptor?.slug ?? null;
    let milestoneId: string | null = null;
    let milestoneSlug: string | null = null;
    if (typeof rawMilestone === "string") {
      const uuidRegex = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
      if (uuidRegex.test(rawMilestone)) milestoneId = rawMilestone;
      else milestoneSlug = String(rawMilestone);
    }
    const parentTaskId = options.parentTaskDescriptor?.id || null;
    const summaries: string[] = [];

    for (const task of tasks) {
      const title = task.title || `${options.stage.toUpperCase()} follow-up`;
      const schedule = (task.schedule || options.scheduleHint || "").toLowerCase();
      let scheduleNote = "";
      let targetParentTaskId = undefined as string | undefined;
      if (schedule === "urgent") {
        targetParentTaskId = parentTaskId || undefined;
        scheduleNote = "Scheduled as urgent child task for current work item.";
      } else if (schedule === "high") {
        scheduleNote = "Complete within the current milestone.";
      } else if (schedule === "medium") {
        scheduleNote = "Plan for an upcoming milestone.";
      } else if (schedule === "low") {
        scheduleNote = "Track under Future Enhancements.";
      }
      const descriptionBase = task.description || `Follow-up required for ${options.stage}`;
      const description = scheduleNote ? `${descriptionBase}\n\nSchedule: ${scheduleNote}` : descriptionBase;
      // If we have a milestone slug but not an ID, attempt to resolve it via the dashboard project status
      let resolvedMilestoneId = milestoneId;
      let resolvedMilestoneSlug = milestoneSlug;
      if (!resolvedMilestoneId && resolvedMilestoneSlug && options.projectId) {
        try {
          const proj = await fetchProjectStatus(options.projectId);
          const p = proj as any;
          const candidates = p?.milestones || p?.milestones_list || (p?.milestones?.items) || [];
          if (Array.isArray(candidates)) {
            const match = candidates.find((m: any) => {
              if (!m) return false;
              const s = (m.slug || m.name || m.title || "").toString().toLowerCase();
              return s === String(resolvedMilestoneSlug).toLowerCase();
            });
            if (match && match.id) {
              resolvedMilestoneId = match.id;
              resolvedMilestoneSlug = null;
            }
          }
        } catch (err) {
          // ignore resolution errors
        }
      }

      const body = await createDashboardTask({
        projectId: options.projectId || undefined,
        milestoneId: resolvedMilestoneId || undefined,
        milestoneSlug: resolvedMilestoneSlug || undefined,
        parentTaskId: targetParentTaskId,
        title,
        description,
        effortEstimate: 3,
        priorityScore: task.defaultPriority ?? 5,
        assigneePersona: task.assigneePersona
      });

      if (body?.ok) {
        const summaryParts = [title];
        if (schedule) summaryParts.push(`schedule: ${schedule}`);
        summaryParts.push(`priority ${task.defaultPriority ?? 5}`);
        summaries.push(summaryParts.join(" | "));
      } else {
        logger.warn("dashboard task creation failed", {
          stage: options.stage,
          title,
          milestoneId,
          parentTaskId,
          projectId: options.projectId,
          error: body?.error || body?.body || "unknown"
        });
      }
    }

    return summaries;
  }

  async function routeTasksThroughProjectManager(tasks: StageTaskDefinition[], stage: "code-review" | "security"): Promise<StageTaskDefinition[]> {
    if (!tasks.length) return tasks;

    const payload = {
      stage,
      tasks: tasks.map(task => ({
        id: task.id,
        title: task.title,
        description: task.description,
        default_priority: task.defaultPriority ?? 5
      }))
    };

    try {
      const response = await runPersonaWithStatus(
        "project-manager",
        "pm-task-routing",
        "schedule_followup_tasks",
        payload
      );

      const pmPayload = response.status.payload || extractJsonPayloadFromText(response.result?.output) || null;
      if (!pmPayload || typeof pmPayload !== "object" || !Array.isArray(pmPayload.tasks)) return tasks;

      const scheduleMap = new Map<string, any>();
      for (const entry of pmPayload.tasks) {
        if (!entry || typeof entry !== "object") continue;
        const id = typeof entry.id === "string" ? entry.id : null;
        if (!id) continue;
        scheduleMap.set(id, entry);
      }

      return tasks.map(task => {
        const mapped = scheduleMap.get(task.id);
        if (!mapped) return task;
        const schedule = typeof mapped.schedule === "string" ? mapped.schedule.toLowerCase() : undefined;
        const assignee = typeof mapped.assignee === "string" ? mapped.assignee : task.assigneePersona;
        const priority = typeof mapped.priority_score === "number" ? mapped.priority_score : task.defaultPriority;
        return { ...task, schedule, assigneePersona: assignee, defaultPriority: priority };
      });
    } catch (error) {
      logger.warn("project-manager scheduling failed", { stage, error });
      return tasks;
    }
  }

  async function runLeadCycle(feedbackNotes: string[], attempt: number, currentMilestoneDescriptorValue: any, currentTaskDescriptorValue: any, currentTaskNameValue: string | null): Promise<LeadCycleOutcome> {
    const feedback = feedbackNotes.filter(Boolean).join("\n\n");
    const milestoneNameForPayload = currentMilestoneDescriptorValue?.name || milestoneName;
      const engineerBasePayload = {
      repo: repoRemote,
      branch: branchName,
      project_id: projectId,
      project_slug: projectSlug || undefined,
      project_name: payloadObj.project_name || projectInfo?.name || "",
      milestone: currentMilestoneDescriptorValue,
      milestone_name: milestoneNameForPayload,
      milestone_slug: currentMilestoneDescriptorValue?.slug || milestoneSlug,
      task: currentTaskDescriptorValue,
      task_name: currentTaskNameValue || (currentTaskDescriptorValue?.name ?? ""),
      // If there is coordinator feedback (e.g., QA failure details), use that as the immediate goal so the implementation planner focuses on fixing it
      goal: feedback || projectInfo?.goal || projectInfo?.direction || currentMilestoneDescriptorValue?.goal,
      base_branch: baseBranch,
      feedback: feedback || undefined,
      revision: attempt
    };

    const plannerPersona = IMPLEMENTATION_PLANNER_MAP.get("lead-engineer") || "lead-engineer";
    const planOutcome = await runEngineerPlanApproval("lead-engineer", plannerPersona, engineerBasePayload, attempt, feedback || null);

    const leadCorrId = randomUUID();
    logger.info("coordinator dispatch lead", {
      workflowId,
      attempt,
      taskName: currentTaskNameValue,
      milestoneName: milestoneNameForPayload
    });
    const implementationPayload = {
      ...engineerBasePayload,
      approved_plan: planOutcome?.planPayload ?? null,
      approved_plan_steps: planOutcome?.planSteps ?? null,
      plan_text: planOutcome?.planText ?? null,
      plan_history: planOutcome?.history ?? null
    };

    await sendPersonaRequest(r, {
      workflowId,
      toPersona: "lead-engineer",
      step: "2-implementation",
      intent: "implement_milestone",
      payload: implementationPayload,
      corrId: leadCorrId,
      repo: repoRemote,
      branch: branchName,
      projectId: projectId!
    });

    const leadEvent = await waitForPersonaCompletion(r, "lead-engineer", workflowId, leadCorrId);
    const leadResultObj = parseEventResult(leadEvent.fields.result);
    logger.info("coordinator received lead engineer completion", { workflowId, corrId: leadCorrId, eventId: leadEvent.id });

    const appliedEdits = leadResultObj?.applied_edits;
    if (!appliedEdits || appliedEdits.attempted === false) {
      return { success: false, details: "Lead engineer did not apply edits.", output: leadResultObj?.output || "", commit: null, paths: [], appliedEdits: appliedEdits, result: leadResultObj, plan: planOutcome || undefined };
    }

    const noChanges = !appliedEdits.applied && appliedEdits.reason === "no_changes";
    if (!appliedEdits.applied && !noChanges) {
      const reason = appliedEdits.reason || appliedEdits.error || "unknown";
      return { success: false, details: `Lead edits were not applied (${reason}).`, output: leadResultObj?.output || "", commit: appliedEdits.commit || null, paths: appliedEdits.paths || [], appliedEdits, result: leadResultObj, plan: planOutcome || undefined };
    }

    const commitInfo = appliedEdits.commit || null;
    if (commitInfo && commitInfo.committed === false) {
      const reason = commitInfo.reason || "commit_failed";
      return { success: false, details: `Commit failed (${reason}).`, output: leadResultObj?.output || "", commit: commitInfo, paths: appliedEdits.paths || [], appliedEdits, result: leadResultObj, plan: planOutcome || undefined };
    }
    if (commitInfo && commitInfo.pushed === false && commitInfo.reason) {
      return { success: false, details: `Push failed (${commitInfo.reason}).`, output: leadResultObj?.output || "", commit: commitInfo, paths: appliedEdits.paths || [], appliedEdits, result: leadResultObj, plan: planOutcome || undefined };
    }

    return {
      success: true,
      details: leadResultObj?.output || "",
      output: leadResultObj?.output || "",
      commit: commitInfo,
      paths: appliedEdits.paths || [],
      appliedEdits,
      result: leadResultObj,
      noChanges,
      plan: planOutcome || undefined
    };
  }

  async function runQaStage(leadOutcome: LeadCycleOutcome, attempt: number, currentMilestoneDescriptorValue: any, currentTaskDescriptorValue: any, currentTaskNameValue: string | null): Promise<StageOutcome> {
    const milestoneNameForPayload = currentMilestoneDescriptorValue?.name || milestoneName;
    const qaResponse = await runPersonaWithStatus(
      "tester-qa",
      "4-qa-verification",
      "verify_build_and_tests",
      {
        repo: repoRemote,
        branch: branchName,
        project_id: projectId,
        project_slug: projectSlug || undefined,
        project_name: payloadObj.project_name || projectInfo?.name || "",
        milestone: currentMilestoneDescriptorValue,
        milestone_name: milestoneNameForPayload,
        task: currentTaskDescriptorValue,
        task_name: currentTaskNameValue || (currentTaskDescriptorValue?.name ?? ""),
        commit: leadOutcome.commit,
        changed_files: leadOutcome.paths,
        lead_output: leadOutcome.output,
        revision: attempt
      }
    );
    const qaStatus = qaResponse.status;
    let qaDetails = qaStatus.details;
    let qaPayload = qaStatus.payload;

    if (!qaDetails && qaResponse.result?.output) qaDetails = qaResponse.result.output;

    if (qaStatus.status === "fail") {
      const payloadObj = (qaPayload && typeof qaPayload === "object") ? { ...qaPayload } : {};
      let commands: string[] = [];
      if (Array.isArray((payloadObj as any).commands)) {
        const commandValues = (payloadObj as any).commands as unknown as any[];
        commands = commandValues
          .map((cmd: any) => (typeof cmd === "string" ? cmd.trim() : ""))
          .filter((value: string): value is string => value.length > 0);
      }
      if (!commands.length && typeof qaDetails === "string") {
        const lowerDetails = qaDetails.toLowerCase();
        if (lowerDetails.includes("lint")) commands.push("npm run lint");
        if (lowerDetails.includes("test")) commands.push("npm test");
      }

      commands = Array.from(new Set(commands));

      if (commands.length) {
        try {
          const diagnostics = await gatherQaDiagnostics(commands, repoRoot);
          if (diagnostics) {
            const diagnosticsSection = `Diagnostics:\n${diagnostics.text}`;
            qaDetails = qaDetails ? `${qaDetails}\n\n${diagnosticsSection}` : diagnosticsSection;
            payloadObj.diagnostics = diagnostics.entries;
            if (!payloadObj.commands) payloadObj.commands = commands;
            qaPayload = payloadObj;
            logger.info("qa diagnostics executed", {
              workflowId,
              commands: diagnostics.entries.map(entry => ({
                command: entry.command,
                exitCode: entry.exitCode,
                durationMs: entry.durationMs
              }))
            });
          }
        } catch (error: any) {
          logger.warn("qa diagnostics execution failed", { workflowId, error });
        }
      }

      const qaTasks = extractStageTasks("qa", qaDetails, qaPayload).map(task => ({
        ...task,
        schedule: task.schedule || "urgent",
        assigneePersona: task.assigneePersona || "lead-engineer"
      }));
      const createdTasks = await createDashboardTaskEntries(qaTasks, {
        stage: "qa",
        milestoneDescriptor: currentMilestoneDescriptorValue,
        parentTaskDescriptor: currentTaskDescriptorValue,
        projectId,
        projectName: projectInfo?.name || null
      });
      if (createdTasks.length) {
        const summary = createdTasks.map(item => `- ${item}`).join("\n");
        qaDetails = `${qaDetails}\n\nDashboard Tasks Created:\n${summary}`;
      }
    }

    return {
      pass: qaStatus.status === "pass",
      details: qaDetails,
      payload: qaPayload,
      rawOutput: qaResponse.result?.output || ""
    };
  }

  async function runCodeReviewStage(leadOutcome: LeadCycleOutcome, qaOutcome: StageOutcome, attempt: number, currentMilestoneDescriptorValue: any, currentTaskDescriptorValue: any, currentTaskNameValue: string | null): Promise<StageOutcome> {
    const milestoneNameForPayload = currentMilestoneDescriptorValue?.name || milestoneName;
    const reviewResponse = await runPersonaWithStatus(
      "code-reviewer",
      "5-code-review",
      "review_changes",
      {
        repo: repoRemote,
        branch: branchName,
        project_id: projectId,
        project_slug: projectSlug || undefined,
        project_name: payloadObj.project_name || projectInfo?.name || "",
        milestone: currentMilestoneDescriptorValue,
        milestone_name: milestoneNameForPayload,
        task: currentTaskDescriptorValue,
        task_name: currentTaskNameValue || (currentTaskDescriptorValue?.name ?? ""),
        commit: leadOutcome.commit,
        qa_report: qaOutcome.details,
        qa_payload: qaOutcome.payload,
        lead_output: leadOutcome.output,
        revision: attempt
      }
    );
    let reviewDetails = reviewResponse.status.details;
    let reviewPayload = reviewResponse.status.payload;

    if (reviewResponse.status.status !== "pass") {
      let tasks = extractStageTasks("code-review", reviewDetails, reviewPayload);
      tasks = await routeTasksThroughProjectManager(tasks, "code-review");
      const created = await createDashboardTaskEntries(tasks, {
        stage: "code-review",
        milestoneDescriptor: currentMilestoneDescriptorValue,
        parentTaskDescriptor: currentTaskDescriptorValue,
        projectId,
        projectName: projectInfo?.name || null,
        scheduleHint: "urgent"
      });
      if (created.length) {
        const summary = created.map(item => `- ${item}`).join("\n");
        reviewDetails = `${reviewDetails}\n\nDashboard Tasks Created:\n${summary}`;
      }
    }

    return {
      pass: reviewResponse.status.status === "pass",
      details: reviewDetails,
      payload: reviewPayload,
      rawOutput: reviewResponse.result?.output || ""
    };
  }

  async function runSecurityReviewStage(leadOutcome: LeadCycleOutcome, qaOutcome: StageOutcome, codeOutcome: StageOutcome, attempt: number, currentMilestoneDescriptorValue: any, currentTaskDescriptorValue: any, currentTaskNameValue: string | null): Promise<StageOutcome> {
    const milestoneNameForPayload = currentMilestoneDescriptorValue?.name || milestoneName;
    const securityResponse = await runPersonaWithStatus(
      "security-review",
      "6-security-review",
      "assess_security",
      {
        repo: repoRemote,
        branch: branchName,
        project_id: projectId,
        project_slug: projectSlug || undefined,
        project_name: payloadObj.project_name || projectInfo?.name || "",
        milestone: currentMilestoneDescriptorValue,
        milestone_name: milestoneNameForPayload,
        task: currentTaskDescriptorValue,
        task_name: currentTaskNameValue || (currentTaskDescriptorValue?.name ?? ""),
        commit: leadOutcome.commit,
        qa_report: qaOutcome.details,
        code_review_report: codeOutcome.details,
        revision: attempt
      }
    );
    let securityDetails = securityResponse.status.details;
    let securityPayload = securityResponse.status.payload;

    if (securityResponse.status.status !== "pass") {
      let tasks = extractStageTasks("security", securityDetails, securityPayload);
      tasks = await routeTasksThroughProjectManager(tasks, "security");
      const created = await createDashboardTaskEntries(tasks, {
        stage: "security",
        milestoneDescriptor: currentMilestoneDescriptorValue,
        parentTaskDescriptor: currentTaskDescriptorValue,
        projectId,
        projectName: projectInfo?.name || null,
        scheduleHint: "urgent"
      });
      if (created.length) {
        const summary = created.map(item => `- ${item}`).join("\n");
        securityDetails = `${securityDetails}\n\nDashboard Tasks Created:\n${summary}`;
      }
    }

    return {
      pass: securityResponse.status.status === "pass",
      details: securityDetails,
      payload: securityPayload,
      rawOutput: securityResponse.result?.output || ""
    };
  }

  async function runDevOpsStage(leadOutcome: LeadCycleOutcome, qaOutcome: StageOutcome, codeOutcome: StageOutcome, securityOutcome: StageOutcome, attempt: number, currentMilestoneDescriptorValue: any, currentTaskDescriptorValue: any, currentTaskNameValue: string | null): Promise<StageOutcome> {
    const milestoneNameForPayload = currentMilestoneDescriptorValue?.name || milestoneName;
    const devopsResponse = await runPersonaWithStatus(
      "devops",
      "7-devops-ci",
      "run_ci_pipeline",
      {
        repo: repoRemote,
        branch: branchName,
        project_id: projectId,
        project_slug: projectSlug || undefined,
        project_name: payloadObj.project_name || projectInfo?.name || "",
        milestone: currentMilestoneDescriptorValue,
        milestone_name: milestoneNameForPayload,
        task: currentTaskDescriptorValue,
        task_name: currentTaskNameValue || (currentTaskDescriptorValue?.name ?? ""),
        commit: leadOutcome.commit,
        qa_report: qaOutcome.details,
        code_review_report: codeOutcome.details,
        security_report: securityOutcome.details,
        revision: attempt
      }
    );
    let devopsDetails = devopsResponse.status.details;
    let devopsPayload = devopsResponse.status.payload;

    if (devopsResponse.status.status === "fail") {
      const tasks = extractStageTasks("devops", devopsDetails, devopsPayload).map(task => ({
        ...task,
        schedule: task.schedule || "urgent",
        assigneePersona: task.assigneePersona || "devops"
      }));
      const created = await createDashboardTaskEntries(tasks, {
        stage: "devops",
        milestoneDescriptor: currentMilestoneDescriptorValue,
        parentTaskDescriptor: currentTaskDescriptorValue,
        projectId,
        projectName: projectInfo?.name || null
      });
      if (created.length) {
        const summary = created.map(item => `- ${item}`).join("\n");
        devopsDetails = `${devopsDetails}\n\nDashboard Tasks Created:\n${summary}`;
      }
    }

    return {
      pass: devopsResponse.status.status === "pass",
      details: devopsDetails,
      payload: devopsPayload,
      rawOutput: devopsResponse.result?.output || ""
    };
  }

  async function runProjectManagerStage(leadOutcome: LeadCycleOutcome, qaOutcome: StageOutcome, codeOutcome: StageOutcome, securityOutcome: StageOutcome, devopsOutcome: StageOutcome, attempt: number, currentMilestoneDescriptorValue: any, currentTaskDescriptorValue: any, currentTaskNameValue: string | null): Promise<StageOutcome> {
    const milestoneNameForPayload = currentMilestoneDescriptorValue?.name || milestoneName;
    const pmResponse = await runPersonaWithStatus(
      "project-manager",
      "8-project-update",
      "update_project_dashboard",
      {
        repo: repoRemote,
        branch: branchName,
        project_id: projectId,
        project_slug: projectSlug || undefined,
        project_name: payloadObj.project_name || projectInfo?.name || "",
        milestone: currentMilestoneDescriptorValue,
        milestone_name: milestoneNameForPayload,
        task: currentTaskDescriptorValue,
        task_name: currentTaskNameValue || (currentTaskDescriptorValue?.name ?? ""),
        commit: leadOutcome.commit,
        qa_report: qaOutcome.details,
        code_review_report: codeOutcome.details,
        security_report: securityOutcome.details,
        devops_report: devopsOutcome.details,
        revision: attempt
      }
    );
    const pass = pmResponse.status.status !== "fail";
    if (!pass) {
      throw new Error(`Project manager reported failure: ${pmResponse.status.details}`);
    }
    return {
      pass: true,
      details: pmResponse.status.details,
      payload: pmResponse.status.payload,
      rawOutput: pmResponse.result?.output || ""
    };
  }

  async function executeTaskLifecycle(currentTaskNameValue: string | null, currentTaskDescriptorValue: any, currentMilestoneDescriptorValue: any): Promise<string> {
    let feedbackNotes: string[] = [];
    let attempt = 0;
    while (attempt < MAX_REVISION_ATTEMPTS) {
      attempt += 1;
      const leadOutcome = await runLeadCycle(feedbackNotes, attempt, currentMilestoneDescriptorValue, currentTaskDescriptorValue, currentTaskNameValue);
      if (!leadOutcome.success) {
        const notes: string[] = [`Lead engineer attempt ${attempt} failed: ${leadOutcome.details}`];
        if (leadOutcome.plan?.history?.length) {
          const historyText = leadOutcome.plan.history.map(entry => `Attempt ${entry.attempt} plan:\n${entry.content.trim()}`).join("\n\n");
          notes.push(`Plan history:\n${historyText}`);
        }
        feedbackNotes = notes;
        continue;
      }
      feedbackNotes = [];

      const qaOutcome = await runQaStage(leadOutcome, attempt, currentMilestoneDescriptorValue, currentTaskDescriptorValue, currentTaskNameValue);
      if (!qaOutcome.pass) {
        feedbackNotes = [`QA feedback: ${qaOutcome.details}`];
        continue;
      }

      const codeOutcome = await runCodeReviewStage(leadOutcome, qaOutcome, attempt, currentMilestoneDescriptorValue, currentTaskDescriptorValue, currentTaskNameValue);
      if (!codeOutcome.pass) {
        feedbackNotes = [`Code review feedback: ${codeOutcome.details}`];
        continue;
      }

      const securityOutcome = await runSecurityReviewStage(leadOutcome, qaOutcome, codeOutcome, attempt, currentMilestoneDescriptorValue, currentTaskDescriptorValue, currentTaskNameValue);
      if (!securityOutcome.pass) {
        feedbackNotes = [`Security review feedback: ${securityOutcome.details}`];
        continue;
      }

      const devopsOutcome = await runDevOpsStage(leadOutcome, qaOutcome, codeOutcome, securityOutcome, attempt, currentMilestoneDescriptorValue, currentTaskDescriptorValue, currentTaskNameValue);
      if (!devopsOutcome.pass) {
        feedbackNotes = [`DevOps feedback: ${devopsOutcome.details}`];
        continue;
      }

      await runProjectManagerStage(leadOutcome, qaOutcome, codeOutcome, securityOutcome, devopsOutcome, attempt, currentMilestoneDescriptorValue, currentTaskDescriptorValue, currentTaskNameValue);

      const commitSummary = leadOutcome.commit?.message
        ? `Commit: ${leadOutcome.commit.message}`
        : (leadOutcome.noChanges ? "No new commits were necessary." : "Commit information unavailable.");
      const summaryParts = [
        currentTaskNameValue ? `Task ${currentTaskNameValue} completed.` : "Task cycle completed.",
        commitSummary,
        `QA: ${qaOutcome.details || qaOutcome.rawOutput || 'n/a'}`,
        `Code Review: ${codeOutcome.details || codeOutcome.rawOutput || 'n/a'}`,
        `Security: ${securityOutcome.details || securityOutcome.rawOutput || 'n/a'}`,
        `DevOps: ${devopsOutcome.details || devopsOutcome.rawOutput || 'n/a'}`
      ];
      return summaryParts.join(' ');
    }

    throw new Error(`Exceeded ${MAX_REVISION_ATTEMPTS} revision attempts for task ${currentTaskNameValue || '(unnamed)'}`);
  }

  const completedTaskSummaries: string[] = [];
  let currentTaskObject = selectedTask;
  let currentTaskDescriptorValue = taskDescriptor;
  let currentTaskNameValue = taskName;
  if (!currentTaskObject && nextActionData?.suggestions?.length) {
    const suggested = pickSuggestion(nextActionData.suggestions);
    if (suggested) {
      currentTaskObject = suggested;
      const taskCtx = deriveTaskContext(currentTaskObject);
      currentTaskDescriptorValue = taskCtx.descriptor;
      currentTaskNameValue = taskCtx.name;
      payloadObj.task = currentTaskDescriptorValue;
      payloadObj.task_name = currentTaskNameValue || "";
    }
  }
  let currentMilestoneObject = selectedMilestone;
  let currentMilestoneDescriptorValue = milestoneDescriptor;
  let currentMilestoneNameValue = milestoneName;
  let currentMilestoneSlugValue = milestoneSlug;
  let iterationCount = 0;

  if (currentTaskDescriptorValue) payloadObj.task = currentTaskDescriptorValue;
  if (currentTaskNameValue) payloadObj.task_name = currentTaskNameValue;
  if (currentMilestoneDescriptorValue) payloadObj.milestone = currentMilestoneDescriptorValue;
  payloadObj.milestone_name = currentMilestoneNameValue;

  while ((currentTaskDescriptorValue || iterationCount === 0) && iterationCount < 20) {
    iterationCount += 1;
    logger.info("coordinator task cycle begin", {
      workflowId,
      iteration: iterationCount,
      taskName: currentTaskNameValue,
      milestoneName: currentMilestoneNameValue
    });
    const summary = await executeTaskLifecycle(currentTaskNameValue, currentTaskDescriptorValue, currentMilestoneDescriptorValue);
    completedTaskSummaries.push(summary);
    logger.info("coordinator task cycle complete", {
      workflowId,
      iteration: iterationCount,
      summary
    });

    projectInfo = await fetchProjectStatus(projectId);
    projectStatus = await fetchProjectStatusDetails(projectId);
    nextActionData = await fetchProjectNextAction(projectId);

    const milestoneSourceNext = projectStatus ?? projectInfo;
    let nextSelectedMilestone = (payloadObj.milestone && typeof payloadObj.milestone === "object") ? payloadObj.milestone : selectNextMilestone(milestoneSourceNext);
    if (!nextSelectedMilestone && projectInfo && projectInfo !== milestoneSourceNext) {
      nextSelectedMilestone = selectNextMilestone(projectInfo) || nextSelectedMilestone;
    }
    if (!nextSelectedMilestone && milestoneSourceNext && typeof milestoneSourceNext === "object") {
      const explicit = (milestoneSourceNext as any).next_milestone ?? (milestoneSourceNext as any).nextMilestone;
      if (explicit && typeof explicit === "object") nextSelectedMilestone = explicit;
    }
    if (nextSelectedMilestone) {
      currentMilestoneObject = nextSelectedMilestone;
      const milestoneCtx = deriveMilestoneContext(currentMilestoneObject, currentMilestoneNameValue, branchName, currentTaskDescriptorValue);
      currentMilestoneDescriptorValue = milestoneCtx.descriptor;
      currentMilestoneNameValue = milestoneCtx.name;
      currentMilestoneSlugValue = milestoneCtx.slug || currentMilestoneSlugValue;
      if (milestoneCtx.branch) branchName = milestoneCtx.branch;
      payloadObj.milestone = currentMilestoneDescriptorValue;
      payloadObj.milestone_name = currentMilestoneNameValue;
    }

    let nextTask = selectNextTask(currentMilestoneObject, milestoneSourceNext, projectStatus, projectInfo, payloadObj);
    if (!nextTask && nextActionData?.suggestions?.length) {
      const suggested = pickSuggestion(nextActionData.suggestions);
      if (suggested) {
        nextTask = suggested;
        logger.info("coordinator selected suggestion task", { workflowId, task: suggested.name, reason: suggested.summary });
      }
    }
    if (!nextTask) break;

    currentTaskObject = nextTask;
    const taskCtx = deriveTaskContext(currentTaskObject);
    currentTaskDescriptorValue = taskCtx.descriptor;
    currentTaskNameValue = taskCtx.name;
    if (currentTaskDescriptorValue) payloadObj.task = currentTaskDescriptorValue;
    payloadObj.task_name = currentTaskNameValue || "";
    if (currentMilestoneDescriptorValue && currentMilestoneDescriptorValue.task !== currentTaskDescriptorValue) {
      currentMilestoneDescriptorValue.task = currentTaskDescriptorValue;
      payloadObj.milestone = currentMilestoneDescriptorValue;
    }
  }

  if (iterationCount >= 20) {
    throw new Error(`Coordinator exceeded task iteration limit for project ${projectId}`);
  }

  const summaryLines = [
    `Workflow orchestrated for project ${projectId}.`,
    `Milestone: ${currentMilestoneNameValue} (branch ${branchName}).`
  ];
  if (completedTaskSummaries.length) {
    completedTaskSummaries.forEach((line, index) => summaryLines.push(`Cycle ${index + 1}: ${line}`));
  } else {
    summaryLines.push("No active tasks to process.");
  }

  return summaryLines.join("\n");
}

async function readOne(r: any, persona: string) {
  const res = await r.xReadGroup(groupForPersona(persona), cfg.consumerId, { key: cfg.requestStream, id: ">" }, { COUNT: 1, BLOCK: 200 }).catch(() => null);
  if (!res) return;
  for (const stream of res) {
    for (const msg of stream.messages) {
      const id = msg.id;
      const fields = msg.message as Record<string, string>;
      processOne(r, persona, id, fields).catch(async (e: any) => {
        logger.error(`worker error`, { persona, error: e, entryId: id });
        await r.xAdd(cfg.eventStream, "*", {
          workflow_id: fields?.workflow_id ?? "", step: fields?.step ?? "",
          from_persona: persona, status: "error", corr_id: fields?.corr_id ?? "",
          error: String(e?.message || e), ts: nowIso()
        }).catch(()=>{});
        await r.xAck(cfg.requestStream, groupForPersona(persona), id).catch(()=>{});
      });
    }
  }
}

async function main() {
  if (cfg.allowedPersonas.length === 0) { logger.error("ALLOWED_PERSONAS is empty; nothing to do."); process.exit(1); }
  const r = await makeRedis(); await ensureGroups(r);
  logger.info("worker ready", {
    personas: cfg.allowedPersonas,
    projectBase: cfg.projectBase,
    defaultRepo: cfg.repoRoot,
    contextScan: cfg.contextScan,
    summaryMode: cfg.summaryMode,
    logFile: cfg.log.file,
    logLevel: cfg.log.level,
    logConsole: cfg.log.console
  });
  while (true) { for (const p of cfg.allowedPersonas) { await readOne(r, p); } }
}

type ApplyEditsOutcome = {
  attempted: boolean;
  applied: boolean;
  paths?: string[];
  commit?: Awaited<ReturnType<typeof commitAndPushPaths>>;
  reason?: string;
  error?: string;
};

async function applyModelGeneratedChanges(options: {
  persona: string;
  workflowId: string;
  repoRoot: string;
  branchHint?: string | null;
  responseText: string;
}): Promise<ApplyEditsOutcome> {
  const { persona, workflowId, repoRoot, branchHint, responseText } = options;
  const outcome: ApplyEditsOutcome = { attempted: true, applied: false };
  const diffs = extractDiffBlocks(responseText);

  if (!diffs.length) {
    outcome.reason = "no_diff_blocks";
    logger.info("persona apply: no diff blocks detected", {
      persona,
      workflowId,
      preview: responseText ? responseText.slice(0, 500) : undefined
    });
    return outcome;
  }

  const fs = await import("fs/promises");
  const os = await import("os");
  const pathMod = await import("path");
  const tmpDir = await fs.mkdtemp(pathMod.join(os.tmpdir(), "ma-patch-"));
  const appliedPaths = new Set<string>();

  try {
    for (let i = 0; i < diffs.length; i += 1) {
      const originalDiff = diffs[i];
      const patchPath = pathMod.join(tmpDir, `patch-${i}.diff`);
      const normalizedDiff = normalizeDiffHunkCounts(originalDiff);
      const diffAttempts = normalizedDiff !== originalDiff
        ? [originalDiff, normalizedDiff]
        : [originalDiff];

      let applied = false;
      let diffUsed = originalDiff;
      let lastError: any = null;

      const newFileDiff = /^---\s+\/dev\/null/m.test(originalDiff);
      if (newFileDiff) {
        const parsed = parseUnifiedDiff(originalDiff);
        if (parsed) {
          const targetPath = pathMod.resolve(repoRoot, parsed.path);
          try {
            await fs.access(targetPath);
            logger.warn("persona apply diff duplicate new-file", { persona, workflowId, patchIndex: i, path: parsed.path });
            for (const p of extractPathsFromDiff(originalDiff)) appliedPaths.add(p);
            continue;
          } catch {}
        }
      }

      try {
        for (let attemptIndex = 0; attemptIndex < diffAttempts.length; attemptIndex += 1) {
          const attempt = diffAttempts[attemptIndex];
          diffUsed = attempt;
          const patchContent = attempt.endsWith("\n") ? attempt : `${attempt}\n`;
          await fs.writeFile(patchPath, patchContent, "utf8");
          try {
            await runGit(["apply", "--whitespace=nowarn", patchPath], { cwd: repoRoot });
            for (const p of extractPathsFromDiff(attempt)) appliedPaths.add(p);
            applied = true;
            break;
          } catch (error: any) {
            lastError = error;
            if (attemptIndex === diffAttempts.length - 1) break;
          }
        }

        if (!applied) {
          try {
            await runGit(["apply", "--whitespace=nowarn", "--3way", patchPath], { cwd: repoRoot });
            for (const p of extractPathsFromDiff(diffUsed)) appliedPaths.add(p);
            applied = true;
          } catch (error: any) {
            lastError = error;
          }
        }

        if (!applied) {
          try {
            await runGit(["apply", "--whitespace=nowarn", "--ignore-space-change", patchPath], { cwd: repoRoot });
            for (const p of extractPathsFromDiff(diffUsed)) appliedPaths.add(p);
            applied = true;
          } catch (error: any) {
            lastError = error;
          }
        }

        if (!applied) {
          try {
            await runGit(["apply", "--whitespace=nowarn", "--ignore-whitespace", patchPath], { cwd: repoRoot });
            for (const p of extractPathsFromDiff(diffUsed)) appliedPaths.add(p);
            applied = true;
          } catch (error: any) {
            lastError = error;
          }
        }

        if (!applied) {
          try {
            const patched = await applyDiffUsingPatchTool(patchPath, repoRoot);
            if (patched) {
              logger.warn("persona apply diff fallback patch", {
                persona,
                workflowId,
                patchIndex: i
              });
              for (const p of extractPathsFromDiff(diffUsed)) appliedPaths.add(p);
              applied = true;
            }
          } catch (error: any) {
            if (!lastError) lastError = error;
          }
        }

        if (!applied) {
          try {
            await runGit(["apply", "--reverse", "--check", patchPath], { cwd: repoRoot });
            logger.warn("persona apply diff already present", {
              persona,
              workflowId,
              patchIndex: i
            });
            for (const p of extractPathsFromDiff(diffUsed)) appliedPaths.add(p);
            applied = true;
          } catch {}
        }

        if (applied) continue;

        const errorText = [lastError?.stderr, lastError?.stdout, lastError?.message]
          .filter(Boolean)
          .map((val: any) => String(val).toLowerCase())
          .join(" ");

        const textPaths = await applyDiffTextually({
          diff: diffUsed,
          repoRoot,
          fs,
          pathMod
        }).catch(() => null);
        if (textPaths && textPaths.length) {
          logger.warn("persona apply diff fallback text", {
            persona,
            workflowId,
            patchIndex: i,
            paths: textPaths
          });
          for (const p of textPaths) appliedPaths.add(p);
          for (const p of extractPathsFromDiff(originalDiff)) appliedPaths.add(p);
          continue;
        }

        const shouldAttemptFallback = /already exists/.test(errorText)
          || /dev\/null/.test(errorText)
          || /new file mode/.test(originalDiff);

        if (shouldAttemptFallback) {
          const overwritten = await overwriteExistingFileFromNewDiff({
            diff: originalDiff,
            repoRoot,
            fs,
            pathMod
          });

          if (overwritten) {
            logger.warn("persona apply diff fallback overwrite", {
              persona,
              workflowId,
              patchIndex: i,
              path: overwritten,
              error: lastError
            });
            appliedPaths.add(overwritten);
            for (const p of extractPathsFromDiff(originalDiff)) appliedPaths.add(p);
            continue;
          }
        }

        const alreadyApplied = await isDiffAlreadyApplied({
          diff: diffUsed,
          repoRoot,
          fs,
          pathMod
        }).catch(() => false);

        if (alreadyApplied) {
          logger.warn("persona apply diff already realized", {
            persona,
            workflowId,
            patchIndex: i
          });
          for (const p of extractPathsFromDiff(originalDiff)) appliedPaths.add(p);
          continue;
        }

        const finalError = lastError || new Error("git apply failed");
        let failureDumpPath: string | null = null;
        try {
          const failureDir = pathMod.resolve(repoRoot, ".ma/failed-patches");
          await fs.mkdir(failureDir, { recursive: true });
          const normalizedPersona = persona.replace(/[^A-Za-z0-9_-]+/g, "_").slice(0, 40) || "persona";
          const normalizedWorkflow = workflowId.replace(/[^A-Za-z0-9_-]+/g, "_").slice(0, 40) || "workflow";
          const failureName = `${Date.now()}-${normalizedPersona}-${normalizedWorkflow}-patch-${i}.diff`;
          failureDumpPath = pathMod.join(failureDir, failureName);
          const dumpContent = diffUsed.endsWith("\n") ? diffUsed : `${diffUsed}\n`;
          await fs.writeFile(failureDumpPath, dumpContent, "utf8");
        } catch (dumpErr) {
          logger.warn("persona apply diff dump failed", { persona, workflowId, patchIndex: i, error: dumpErr });
        }
        outcome.reason = "apply_failed";
        outcome.error = finalError?.message || String(finalError);
        logger.error("persona apply diff failed", {
          persona,
          workflowId,
          patchIndex: i,
          error: finalError,
          diffPreview: originalDiff.slice(0, 800),
          failureDumpPath
        });
        throw finalError;
      } finally {
        await fs.unlink(patchPath).catch(() => {});
      }
    }
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }

  let paths = Array.from(appliedPaths);
  if (!paths.length) paths = extractListedPaths(responseText);

  if (!paths.length) {
    try {
      const status = await runGit(["status", "--porcelain"], { cwd: repoRoot });
      const lines = status.stdout.toString().split(/\r?\n/).map(line => line.trim()).filter(Boolean);
      for (const line of lines) {
        const file = line.slice(3).trim();
        if (file) paths.push(file);
      }
      paths = Array.from(new Set(paths));
    } catch (error) {
      logger.warn("persona apply: unable to gather git status for paths", { persona, workflowId, error });
    }
  }

  if (paths.length) {
    const verified: string[] = [];
    const missing: string[] = [];
    for (const rel of paths) {
      const absolute = pathMod.resolve(repoRoot, rel);
      try {
        const stat = await fs.stat(absolute);
        if (stat.isFile()) {
          verified.push(rel);
        } else {
          missing.push(rel);
        }
      } catch {
        missing.push(rel);
      }
    }
    if (missing.length) {
      logger.warn("persona apply: filtered missing paths before commit", {
        persona,
        workflowId,
        missing
      });
    }
    paths = verified;
  }

  if (!paths.length) {
    outcome.reason = "no_paths";
    logger.warn("persona apply: no paths determined after applying diffs", { persona, workflowId });
    return outcome;
  }

  const commitMessage = extractCommitMessage(responseText)
    || `${persona}: updates${branchHint ? " on " + branchHint : ""}`;

  try {
    const commitRes = await commitAndPushPaths({
      repoRoot,
      branch: branchHint || null,
      message: commitMessage,
      paths
    });
    outcome.commit = commitRes;
    outcome.paths = paths;
    outcome.applied = Boolean(commitRes?.committed);
    if (!outcome.applied) {
      outcome.reason = commitRes?.reason || "no_changes";
    }
  } catch (error: any) {
    outcome.reason = "commit_failed";
    outcome.error = error?.message || String(error);
    logger.error("persona apply: commit failed", { persona, workflowId, error });
  }

  return outcome;
}
async function processOne(r: any, persona: string, entryId: string, fields: Record<string,string>) {
  const parsed = RequestSchema.safeParse(fields);
  if (!parsed.success) { await r.xAck(cfg.requestStream, groupForPersona(persona), entryId); return; }
  const msg = parsed.data;
  if (msg.to_persona !== persona) { await r.xAck(cfg.requestStream, groupForPersona(persona), entryId); return; }

  const model = cfg.personaModels[persona]; if (!model) throw new Error(`No model mapping for '${persona}'`);
  const ctx: any = await fetchContext(msg.workflow_id);
  const systemPrompt = SYSTEM_PROMPTS[persona] || `You are the ${persona} agent.`;
  const payloadObj = (() => { try { return msg.payload ? JSON.parse(msg.payload) : {}; } catch { return {}; } })();
  if (msg.repo && !payloadObj.repo) payloadObj.repo = msg.repo;
  if (msg.branch && !payloadObj.branch) payloadObj.branch = msg.branch;
  if (msg.project_id && !payloadObj.project_id) payloadObj.project_id = msg.project_id;

  logger.info("processing request", {
    persona,
    workflowId: msg.workflow_id,
    intent: msg.intent,
    repo: payloadObj.repo,
    branch: payloadObj.branch,
    projectId: payloadObj.project_id
  });

  if (persona === "coordination") {
    const started = Date.now();
    try {
      const output = await handleCoordinator(r, msg, payloadObj);
      const duration = Date.now() - started;
      const result = { output, model: "orchestrator", duration_ms: duration };
      await r.xAdd(cfg.eventStream, "*", {
        workflow_id: msg.workflow_id,
        step: msg.step || "",
        from_persona: persona,
        status: "done",
        result: JSON.stringify(result),
        corr_id: msg.corr_id || "",
        ts: new Date().toISOString()
      });
      await recordEvent({
        workflow_id: msg.workflow_id,
        step: msg.step,
        persona,
        model: "orchestrator",
        duration_ms: duration,
        corr_id: msg.corr_id,
        content: output
      }).catch(() => {});
    } catch (e: any) {
      const duration = Date.now() - started;
      const errorMsg = String(e?.message || e);
      logger.error("coordinator failed", { workflowId: msg.workflow_id, error: errorMsg });
      await r.xAdd(cfg.eventStream, "*", {
        workflow_id: msg.workflow_id,
        step: msg.step || "",
        from_persona: persona,
        status: "error",
        error: errorMsg,
        corr_id: msg.corr_id || "",
        ts: new Date().toISOString()
      });
      await recordEvent({
        workflow_id: msg.workflow_id,
        step: msg.step,
        persona,
        model: "orchestrator",
        duration_ms: duration,
        corr_id: msg.corr_id,
        error: errorMsg
      }).catch(() => {});
    }
    await r.xAck(cfg.requestStream, groupForPersona(persona), entryId);
    return;
  }

  // --- Context scan (pre-model), supports multi-components & Alembic ---
  let scanSummaryText = "";
  let scanArtifacts: null | {
    repoRoot: string;
    ndjson: string;
    snapshot: any;
    summaryMd: string;
    branch: string | null;
    repoSlug: string | null;
    remoteUrl: string | null;
    snapshotPath: string;
    summaryPath: string;
    filesNdjsonPath: string;
    snapshotRel: string;
    summaryRel: string;
    filesNdjsonRel: string;
    totals: { files: number; bytes: number; lines: number };
    components: any;
    hotspots: any;
    paths: string[];
  } = null;
  let repoInfo: Awaited<ReturnType<typeof resolveRepoFromPayload>> | null = null;
  if (persona !== "coordination") {
    try {
      repoInfo = await resolveRepoFromPayload(payloadObj);
    } catch (e:any) {
      logger.warn("resolve repo from payload failed", { persona, workflowId: msg.workflow_id, error: e?.message || String(e) });
    }
  }
  let repoRootNormalized = repoInfo ? normalizeRepoPath(repoInfo.repoRoot, cfg.repoRoot) : null;
  let dashboardUploadEnabled = false;
  const dashboardProject: { id?: string; name?: string; slug?: string } = {};
  if (persona === "context" && cfg.contextScan && repoInfo && repoRootNormalized) {
    try {
      const repoRoot = repoRootNormalized;
      const components = Array.isArray(payloadObj.components) ? payloadObj.components
                        : (Array.isArray(cfg.scanComponents) ? cfg.scanComponents : null);

      logger.info("context scan starting", {
        repoRoot,
        branch: repoInfo.branch ?? null,
        components: components?.map((c:any) => ({ base: c.base || "", include: c.include, exclude: c.exclude })),
        include: cfg.scanInclude,
        exclude: cfg.scanExclude,
        maxFiles: cfg.scanMaxFiles,
        maxBytes: cfg.scanMaxBytes,
        maxDepth: cfg.scanMaxDepth
      });

      const { scanRepo, summarize } = await import("./scanRepo.js");
      type Comp = { base: string; include: string[]; exclude: string[] };
      const comps: Comp[] = components && components.length
        ? components.map((c:any)=>({ base: String(c.base||"").replace(/\\/g,"/"), include: (c.include||cfg.scanInclude), exclude: (c.exclude||cfg.scanExclude) }))
        : [{ base: "", include: cfg.scanInclude, exclude: cfg.scanExclude }];

      let allFiles: any[] = [];
      const perComp: any[] = [];
      const localSummaries: { component: string; totals: any; largest: any[]; longest: any[] }[] = [];

      for (const c of comps) {
        const basePath = (c.base && c.base.length) ? (repoRoot.replace(/\/$/,'') + "/" + c.base.replace(/^\//,'')) : repoRoot;
        const files = await scanRepo({
          repo_root: basePath,
          include: c.include,
          exclude: c.exclude,
          max_files: cfg.scanMaxFiles,
          max_bytes: cfg.scanMaxBytes,
          max_depth: cfg.scanMaxDepth,
          track_lines: cfg.scanTrackLines,
          track_hash: cfg.scanTrackHash
        });
        const prefixed = files.map(f => ({ ...f, path: (c.base ? (c.base.replace(/^\/+|\/+$/g,'') + '/' + f.path) : f.path) }));
        allFiles.push(...prefixed);
        const sum = summarize(prefixed);
        const compName = c.base || ".";
        perComp.push({ component: compName, totals: sum.totals, largest: sum.largest.slice(0,10), longest: sum.longest.slice(0,10) });
        localSummaries.push({ component: compName, totals: sum.totals, largest: sum.largest.slice(0,5), longest: sum.longest.slice(0,5) });
      }

      const ndjson = allFiles.map(f => JSON.stringify(f)).join("\n") + "\n";
      const { summarize: summarize2 } = await import("./scanRepo.js");
      const global = summarize2(allFiles);

      // Build scanMd with Alembic awareness
      const scanMd = (() => {
        const lines: string[] = [];
        lines.push("# Context Snapshot (Scan)", "", `Repo: ${repoRoot}`, `Generated: ${new Date().toISOString()}`, "", "## Totals");
        lines.push(`- Files: ${global.totals.files}`, `- Bytes: ${global.totals.bytes}`, `- Lines: ${global.totals.lines}`, "", "## Components");
        for (const pc of perComp) {
          lines.push(`### ${pc.component}`, `- Files: ${pc.totals.files}`, `- Bytes: ${pc.totals.bytes}`, `- Lines: ${pc.totals.lines}`);
          lines.push(`- Largest (top 10):`);
          for (const f of pc.largest) lines.push(`  - ${f.path} (${f.bytes} bytes)`);
          lines.push(`- Longest (top 10):`);
          for (const f of pc.longest) lines.push(`  - ${f.path} (${f.lines || 0} lines)`);
          lines.push("");
        }
        // Alembic detection
        const alembicFiles = allFiles.filter(f => /(^|\/)alembic(\/|$)/i.test(f.path));
        if (alembicFiles.length) {
          const versions = alembicFiles.filter(f => /(^|\/)alembic(\/|$).*\bversions\b(\/|$).+\.py$/i.test(f.path));
          const latest = [...versions].sort((a,b)=> (b.mtime||0) - (a.mtime||0)).slice(0, 10);
          lines.push("## Alembic Migrations");
          lines.push(`- Alembic tree detected (files: ${alembicFiles.length}, versions: ${versions.length})`);
          lines.push(versions.length ? "- Latest versions (by modified time):" : "- No versioned migrations found under alembic/versions");
          for (const f of latest) {
            lines.push(`  - ${f.path}  (mtime=${new Date(f.mtime).toISOString()}, bytes=${f.bytes}${typeof f.lines==='number'?`, lines=${f.lines}`:''})`);
          }
          lines.push("");
        }
        return lines.join("\n");
      })();

      const repoMeta = await getRepoMetadata(repoRoot);
      const branchUsed = repoInfo.branch ?? repoMeta.currentBranch ?? null;
      repoInfo.branch = branchUsed;
      repoInfo.remote = repoInfo.remote || repoMeta.remoteUrl || undefined;
      const repoSlug = repoMeta.remoteSlug || null;

      const snapshot = {
        repo: repoRoot,
        generated_at: new Date().toISOString(),
        totals: global.totals,
        components: perComp,
        hotspots: { largest_files: global.largest, longest_files: global.longest }
      };

      const { writeArtifacts } = await import("./artifacts.js");
      const writeRes = await writeArtifacts({
        repoRoot,
        artifacts: { snapshot, filesNdjson: ndjson, summaryMd: scanMd },
        apply: cfg.applyEdits && cfg.allowedEditPersonas.includes("context"),
        branchName: `feat/context-${msg.workflow_id}-${(msg.corr_id||"c").slice(0,8)}`,
        commitMessage: `context: snapshot for ${msg.workflow_id}`
      });

      const pathMod = await import("path");
      const contextFolder = ".ma/context";
      const snapshotRel = `${contextFolder}/snapshot.json`;
      const summaryRel = `${contextFolder}/summary.md`;
      const filesNdjsonRel = `${contextFolder}/files.ndjson`;

      scanArtifacts = {
        repoRoot,
        ndjson,
        snapshot,
        summaryMd: scanMd,
        branch: branchUsed,
        repoSlug,
        remoteUrl: repoInfo.remote || null,
        snapshotPath: pathMod.resolve(repoRoot, snapshotRel),
        summaryPath: pathMod.resolve(repoRoot, summaryRel),
        filesNdjsonPath: pathMod.resolve(repoRoot, filesNdjsonRel),
        snapshotRel,
        summaryRel,
        filesNdjsonRel,
        totals: global.totals,
        components: perComp,
        hotspots: snapshot.hotspots,
        paths: writeRes.paths
      };
      const branchNote = branchUsed ? `, branch=${branchUsed}` : "";
      scanSummaryText = `Context scan: files=${global.totals.files}, bytes=${global.totals.bytes}, lines=${global.totals.lines}, components=${perComp.length}${branchNote}.`;

      logger.info("context scan completed", {
        repoRoot,
        branch: branchUsed,
        remote: repoInfo.remote || null,
        repoSlug,
        totals: global.totals,
        components: localSummaries
      });

      const shouldUpload = shouldUploadDashboardFlag(payloadObj.upload_dashboard);
      if (shouldUpload) {
        dashboardUploadEnabled = true;
        const projectId = firstString(payloadObj.project_id, payloadObj.projectId, msg.project_id);
        const projectName = firstString(payloadObj.project_name, payloadObj.projectName, payloadObj.project);
        const projectSlug = firstString(payloadObj.project_slug, payloadObj.projectSlug);
        if (projectId) dashboardProject.id = projectId;
        if (projectName) dashboardProject.name = projectName;
        if (projectSlug) dashboardProject.slug = projectSlug;
      }
    } catch (e:any) {
      scanSummaryText = `Context scan failed: ${String(e?.message || e)}`;
      logger.error("context scan failed", { error: e, repo: payloadObj.repo, branch: payloadObj.branch });
    }
  }

  if (persona === "context" && cfg.contextScan && !repoInfo) {
    scanSummaryText = scanSummaryText || "Context scan unavailable: repository could not be resolved.";
    logger.warn("context scan skipped: repo unresolved", { workflowId: msg.workflow_id, repo: payloadObj.repo, branch: payloadObj.branch });
  }

  const userPayload = msg.payload ? msg.payload : "{}";
  let externalSummary: string | null = null;
  let preferredPaths: string[] = [];
  if (persona !== "context" && repoInfo && repoRootNormalized) {
    try {
      const fs = await import("fs/promises");
      const pathMod = await import("path");
      const repoRoot = repoRootNormalized;
      const summaryPath = pathMod.resolve(repoRoot, ".ma/context/summary.md");
      const content = await fs.readFile(summaryPath, "utf8");
      externalSummary = content;
      if (!scanSummaryText) scanSummaryText = `Context summary loaded from ${pathMod.relative(repoRoot, summaryPath)}`;
      preferredPaths = extractMentionedPaths(content);
    } catch (e:any) {
      logger.debug("persona prompt: context summary unavailable", { persona, workflowId: msg.workflow_id, error: e?.message || String(e) });
    }
  }

  if (!scanSummaryText && persona !== "context" && persona !== "coordination") {
    scanSummaryText = "Context summary not available.";
  }

  const scanSummaryForPrompt = scanArtifacts
    ? clipText(scanArtifacts.summaryMd, persona === "context" ? 8000 : 4000)
    : (externalSummary ? clipText(externalSummary, 4000) : scanSummaryText);

  let promptFileSnippets: PromptFileSnippet[] = [];
  if (persona !== "context" && repoRootNormalized) {
    promptFileSnippets = await gatherPromptFileSnippets(repoRootNormalized, preferredPaths);
  }

  const userLines = [
    `Intent: ${msg.intent}`,
    `Payload: ${userPayload}`,
    `Constraints/Limits: ${ctx?.limits || ""}`,
    `Persona hints: ${ctx?.personaHints || ""}`
  ];

  if (persona === "context") {
    if (scanArtifacts) {
      userLines.push("Instruction: Use only the files, directories, and facts present in the scan summary above. If something is missing, explicitly state it was not observed.");
    } else {
      userLines.push(`Scan note: ${scanSummaryText}`);
    }
  } else {
    userLines.push(`Scan note: ${scanSummaryText}`);
  }

  const userText = userLines.join("\n");

  const messages: any[] = [
    { role: "system", content: systemPrompt }
  ];

  if (scanSummaryForPrompt && scanSummaryForPrompt.length) {
    const label = persona === "context" ? "Authoritative file scan summary" : "File scan summary";
    messages.push({ role: "system", content: `${label}:\n${scanSummaryForPrompt}` });
  }

  if ((persona !== "context" || !scanArtifacts) && (ctx?.projectTree || ctx?.fileHotspots)) {
    messages.push({ role: "system", content: `Dashboard context (may be stale):\nTree: ${ctx?.projectTree || ""}\nHotspots: ${ctx?.fileHotspots || ""}` });
  }

  if (promptFileSnippets.length) {
    const snippetParts: string[] = ["Existing project files for reference (read-only):"];
    for (const snippet of promptFileSnippets) {
      snippetParts.push(`File: ${snippet.path}`);
      snippetParts.push("```");
      snippetParts.push(snippet.content);
      snippetParts.push("```");
    }
    messages.push({ role: "system", content: snippetParts.join("\n") });
  }


  const personaLower = persona.toLowerCase();
  const stepLower = (msg.step || "").toLowerCase();
  const repoHint = firstString(
    payloadObj.repo,
    payloadObj.repository,
    payloadObj.remote,
    payloadObj.repo_url,
    payloadObj.repository_url,
    msg.repo
  ) || "the existing repository";

  if (ENGINEER_PERSONAS_REQUIRING_PLAN.has(personaLower) && stepLower === "2-plan") {
    messages.push({
      role: "system",
      content: `You are preparing an execution plan for work in ${repoHint}. This is a planning step only. Do not provide code snippets, diffs, or file changes. Respond with JSON containing a 'plan' array where each item describes a concrete numbered step (include goals, files to touch, owners if relevant, and dependencies). Add optional context such as 'risks' or 'open_questions'. Await coordinator approval before attempting any implementation.`
    });
  } else if (CODING_PERSONA_SET.has(personaLower)) {
    messages.push({
      role: "system",
      content: `You are working inside ${repoHint}. The repository already exists; modify only the necessary files. Do not generate a brand-new project scaffold. Provide concrete code edits as unified diffs that apply cleanly with \`git apply\`. Wrap each patch in \`\`\`diff\`\`\` fences. If you add or delete files, include the appropriate diff headers. Always reference existing files by their actual paths.`
    });
  }
  messages.push({ role: "user", content: userText });

  const started = Date.now();
  const resp = await callLMStudio(model, messages, 0.2);
  const duration = Date.now() - started;
  const responsePreview = resp.content && resp.content.length > 4000
    ? resp.content.slice(0, 4000) + "... (truncated)"
    : resp.content;
  logger.info("persona response", { persona, workflowId: msg.workflow_id, corrId: msg.corr_id || "", preview: responsePreview });

  // After model call: write/replace summary.md per SUMMARY_MODE
  if (persona === "context" && scanArtifacts) {
    try {
      const fs = await import("fs/promises");
      const pathMod = await import("path");
      const summaryPath = scanArtifacts.summaryPath || pathMod.resolve(scanArtifacts.repoRoot, ".ma/context/summary.md");
      let contentToWrite = resp.content;
      if (cfg.summaryMode === "scan") contentToWrite = scanArtifacts.summaryMd;
      if (cfg.summaryMode === "both") {
        contentToWrite = `# Model Summary\n\n${resp.content}\n\n---\n\n` + scanArtifacts.summaryMd;
      }
      await fs.mkdir(pathMod.dirname(summaryPath), { recursive: true });
      await fs.writeFile(summaryPath, contentToWrite, "utf8");

      // ensure the stored summaryPath reflects latest location
      scanArtifacts.summaryPath = summaryPath;

      const commitPaths = Array.from(new Set([
        scanArtifacts.snapshotRel,
        scanArtifacts.summaryRel,
        scanArtifacts.filesNdjsonRel
      ].filter(Boolean)));

      try {
        const commitRes = await commitAndPushPaths({
          repoRoot: scanArtifacts.repoRoot,
          branch: scanArtifacts.branch,
          message: `context: snapshot for ${msg.workflow_id}`,
          paths: commitPaths
        });
        logger.info("context artifacts push result", { workflowId: msg.workflow_id, result: commitRes });
      } catch (commitErr: any) {
        logger.error("context artifacts push failed", { error: commitErr, workflowId: msg.workflow_id });
      }

      if (dashboardUploadEnabled) {
        const repoId = scanArtifacts.repoSlug
          || dashboardProject.id
          || dashboardProject.slug
          || payloadObj.repo
          || scanArtifacts.repoRoot;

        logger.info("uploading context snapshot", {
          workflowId: msg.workflow_id,
          project: dashboardProject,
          repo: scanArtifacts.repoRoot,
          repoId,
          branch: scanArtifacts.branch,
          summaryPath: scanArtifacts.summaryRel,
          snapshotPath: scanArtifacts.snapshotRel,
          filesNdjsonPath: scanArtifacts.filesNdjsonRel
        });
        const uploadRes = await uploadContextSnapshot({
          workflowId: msg.workflow_id,
          repoId,
          projectId: dashboardProject.id,
          projectName: dashboardProject.name,
          projectSlug: dashboardProject.slug,
          repoRoot: scanArtifacts.repoRoot,
          branch: scanArtifacts.branch,
          snapshotPath: scanArtifacts.snapshotRel,
          summaryPath: scanArtifacts.summaryRel,
          filesNdjsonPath: scanArtifacts.filesNdjsonRel,
          totals: scanArtifacts.totals,
          components: scanArtifacts.components,
          hotspots: scanArtifacts.hotspots
        });
        if (!uploadRes.ok) {
          logger.warn("dashboard upload reported failure", { status: uploadRes.status, workflowId: msg.workflow_id });
        }
      }
    } catch (e:any) {
      logger.warn("context summary write failed", { error: e });
    }
  }

  let editOutcome: ApplyEditsOutcome | null = null;
  if (cfg.applyEdits && cfg.allowedEditPersonas.includes(persona)) {
    try {
      if (!repoInfo) {
        repoInfo = await resolveRepoFromPayload(payloadObj);
        repoRootNormalized = repoInfo ? normalizeRepoPath(repoInfo.repoRoot, cfg.repoRoot) : repoRootNormalized;
      }
      if (repoInfo) {
        const repoRootForEdits = repoRootNormalized || normalizeRepoPath(repoInfo.repoRoot, cfg.repoRoot);
        const branchHint = firstString(
          payloadObj.branch,
          payloadObj.branch_name,
          payloadObj.base_branch,
          payloadObj.default_branch,
          repoInfo.branch
        );
        editOutcome = await applyModelGeneratedChanges({
          persona,
          workflowId: msg.workflow_id,
          repoRoot: repoRootForEdits,
          branchHint,
          responseText: resp.content
        });
        if (branchHint && repoInfo) repoInfo.branch = branchHint;
      } else {
        editOutcome = { attempted: false, applied: false, reason: "repo_unresolved" };
      }
    } catch (error: any) {
      logger.error("persona apply edits failed", { persona, workflowId: msg.workflow_id, error });
      editOutcome = { attempted: true, applied: false, reason: "apply_failed", error: error?.message || String(error) };
    }
  }

  const result: any = { output: resp.content, model, duration_ms: duration };
  if (editOutcome) result.applied_edits = editOutcome;
  logger.info("persona completed", { persona, workflowId: msg.workflow_id, duration_ms: duration });
  await r.xAdd(cfg.eventStream, "*", {
    workflow_id: msg.workflow_id, step: msg.step || "", from_persona: persona,
    status: "done", result: JSON.stringify(result), corr_id: msg.corr_id || "", ts: new Date().toISOString()
  });
  await recordEvent({ workflow_id: msg.workflow_id, step: msg.step, persona, model, duration_ms: duration, corr_id: msg.corr_id, content: resp.content }).catch(()=>{});
  await r.xAck(cfg.requestStream, groupForPersona(persona), entryId);
}

main().catch(e => { logger.error("worker fatal", { error: e }); process.exit(1); });
