import { randomUUID } from "crypto";
import { cfg } from "./config.js";
import { makeRedis } from "./redisClient.js";
import { RequestSchema } from "./schema.js";
import { SYSTEM_PROMPTS } from "./personas.js";
import { callLMStudio } from "./lmstudio.js";
import { fetchContext, recordEvent, uploadContextSnapshot, fetchProjectStatus, fetchProjectStatusDetails } from "./dashboard.js";
import { resolveRepoFromPayload, getRepoMetadata, commitAndPushPaths, checkoutBranchFromBase, ensureBranchPublished, runGit } from "./gitUtils.js";
import { logger } from "./logger.js";

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
  let lastId = "$";
  const eventRedis = await makeRedis();

  try {
    while (Date.now() - started < effectiveTimeout) {
      const elapsed = Date.now() - started;
      const remaining = Math.max(0, effectiveTimeout - elapsed);
      const blockMs = Math.max(1000, Math.min(remaining || effectiveTimeout, 5000));
      const streams = await eventRedis.xRead([{ key: cfg.eventStream, id: lastId }], { BLOCK: blockMs, COUNT: 20 }).catch(() => null);
      if (!streams) continue;

      for (const stream of streams) {
        for (const message of stream.messages) {
          lastId = message.id;
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
        const messages = stream.messages;
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
  const seen = new Set<string>();
  const fenceRegex = /```(\w+)?\s*\n([\s\S]*?)```/gi;
  let match: RegExpExecArray | null;

  while ((match = fenceRegex.exec(text))) {
    const lang = (match[1] || "").toLowerCase();
    const body = match[2] || "";
    const trimmed = body.trim();
    if (!trimmed.length) continue;
    const looksLikeDiff = trimmed.startsWith("diff --git")
      || trimmed.startsWith("Index:")
      || trimmed.startsWith("--- ")
      || trimmed.includes("\n@@");
    if (lang && !["diff", "patch"].includes(lang) && !looksLikeDiff) continue;
    if (!lang && !looksLikeDiff) continue;
    seen.add(trimmed);
  }

  const gitRegex = /(^diff --git[\s\S]*?)(?=\r?\n(?:diff --git|Index:|---\s|\+\+\+\s|```|$))/gmi;
  while ((match = gitRegex.exec(text))) {
    const trimmed = (match[1] || "").trim();
    if (trimmed.length) seen.add(trimmed);
  }

  const unifiedRegex = /(^---\s.+?\r?\n\+\+\+\s.+?\r?\n@@[\s\S]*?)(?=\r?\n(?:---\s|\+\+\+\s|diff --git|Index:|```|$))/gm;
  while ((match = unifiedRegex.exec(text))) {
    const trimmed = (match[1] || "").trim();
    if (trimmed.length) seen.add(trimmed);
  }

  return Array.from(seen);
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

  const projectInfo: any = await fetchProjectStatus(projectId);
  const projectStatus: any = await fetchProjectStatusDetails(projectId);
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

  const selectedTask = selectNextTask(selectedMilestone, milestoneSource, projectStatus, projectInfo, payloadObj);

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

  const branchName = payloadObj.branch_name
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
      project_slug: projectSlug,
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

  const leadCorrId = randomUUID();
  await sendPersonaRequest(r, {
    workflowId,
    toPersona: "lead-engineer",
    step: "2-implementation",
    intent: "implement_milestone",
    payload: {
      repo: repoRemote,
      branch: branchName,
      project_id: projectId,
      project_slug: projectSlug,
      project_name: payloadObj.project_name || projectInfo?.name || "",
      milestone: milestoneDescriptor,
      milestone_name: milestoneName,
      task: taskDescriptor,
      task_name: taskName || (taskDescriptor?.name ?? ""),
      goal: projectInfo?.goal || projectInfo?.direction || milestoneDescriptor?.goal,
      base_branch: baseBranch
    },
    corrId: leadCorrId,
    repo: repoRemote,
    branch: branchName,
    projectId
  });

  const leadEvent = await waitForPersonaCompletion(r, "lead-engineer", workflowId, leadCorrId);
  const leadResult = parseEventResult(leadEvent.fields.result);
  logger.info("coordinator received lead engineer completion", { workflowId, corrId: leadCorrId, eventId: leadEvent.id });

  const summaryCorrId = randomUUID();
  await sendPersonaRequest(r, {
    workflowId,
    toPersona: "summarization",
    step: "3-summary",
    intent: "summarize_milestone",
    payload: {
      repo: repoRemote,
      branch: branchName,
      project_id: projectId,
      project_slug: projectSlug,
      project_name: payloadObj.project_name || projectInfo?.name || "",
      milestone: milestoneDescriptor,
      task: taskDescriptor,
      task_name: taskName || (taskDescriptor?.name ?? ""),
      lead_engineer_result: leadResult
    },
    corrId: summaryCorrId,
    repo: repoRemote,
    branch: branchName,
    projectId,
    deadlineSeconds: 300
  });

  const summaryEvent = await waitForPersonaCompletion(r, "summarization", workflowId, summaryCorrId);
  const summaryResult = parseEventResult(summaryEvent.fields.result);
  logger.info("coordinator received summarization completion", { workflowId, corrId: summaryCorrId, eventId: summaryEvent.id });

  const lines = [
    `Workflow orchestrated for project ${projectId}.`,
    `Milestone: ${milestoneName} (branch ${branchName}).`,
    `Context completed (corr ${contextCorrId}).`,
    `Lead engineer completed (corr ${leadCorrId}).`,
    `Summarization completed (corr ${summaryCorrId}).`
  ];

  if (taskName) {
    const statusText = taskDescriptor?.status ? ` [${taskDescriptor.status}]` : "";
    lines.splice(2, 0, `Task: ${taskName}${statusText}.`);
  }

  if (summaryResult?.output) {
    lines.push("Summary:", summaryResult.output);
  }

  return lines.join("\n");
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
      const diff = diffs[i];
      const patchPath = pathMod.join(tmpDir, `patch-${i}.diff`);
      await fs.writeFile(patchPath, diff, "utf8");
      try {
        await runGit(["apply", "--whitespace=nowarn", patchPath], { cwd: repoRoot });
        for (const p of extractPathsFromDiff(diff)) appliedPaths.add(p);
      } catch (error: any) {
        outcome.reason = "apply_failed";
        outcome.error = error?.message || String(error);
        logger.error("persona apply diff failed", { persona, workflowId, patchIndex: i, error });
        throw error;
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
  let dashboardUploadEnabled = false;
  const dashboardProject: { id?: string; name?: string; slug?: string } = {};
  if (persona === "context" && cfg.contextScan) {
    try {
      repoInfo = await resolveRepoFromPayload(payloadObj);
      const repoRoot = normalizeRepoPath(repoInfo.repoRoot, cfg.repoRoot);
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

  const userPayload = msg.payload ? msg.payload : "{}";
  const scanSummaryForPrompt = scanArtifacts
    ? clipText(scanArtifacts.summaryMd, persona === "context" ? 8000 : 4000)
    : scanSummaryText;

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



  if (CODING_PERSONA_SET.has(persona.toLowerCase())) {
    const repoHint = firstString(
      payloadObj.repo,
      payloadObj.repository,
      payloadObj.remote,
      payloadObj.repo_url,
      payloadObj.repository_url,
      msg.repo
    ) || "the existing repository";
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
      }
      if (repoInfo) {
        const repoRootForEdits = normalizeRepoPath(repoInfo.repoRoot, cfg.repoRoot);
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


