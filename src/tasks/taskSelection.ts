import { firstString, numericHint, toArray } from "../util.js";
import { parseMilestoneDate } from "../milestones/milestoneManager.js";

const TASK_STATUS_PRIORITY: Record<string, number> = {
  blocked: 0,
  stuck: 0,
  review: 1,
  in_review: 1,
  in_code_review: 1,
  in_security_review: 1,
  ready: 1,
  in_progress: 2,
  active: 2,
  doing: 2,
  working: 2,
  planned: 3,
  backlog: 3,
  todo: 3,
  not_started: 3,
  open: 3,
  waiting: 4,
  pending: 4,
  qa: 4,
  testing: 4,
  done: 5,
  completed: 5,
  complete: 5,
  shipped: 5,
  delivered: 5,
  closed: 6,
  cancelled: 6,
  canceled: 6,
  archived: 7,
};

export function normalizeTaskStatus(value: any) {
  if (typeof value !== "string") return "";
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_");
}

export function taskStatusPriority(status: string) {
  if (!status) return 3;
  const normalized = normalizeTaskStatus(status);
  if (normalized in TASK_STATUS_PRIORITY)
    return TASK_STATUS_PRIORITY[normalized];

  if (status.includes("block") || status.includes("stuck")) return 0;
  if (status.includes("review")) return 1;
  if (
    status.includes("progress") ||
    status.includes("doing") ||
    status.includes("work") ||
    status.includes("active")
  )
    return 2;
  if (
    status.includes("done") ||
    status.includes("complete") ||
    status.includes("closed")
  )
    return 5;
  if (status.includes("cancel")) return 6;
  return 3;
}

export function taskDue(value: any): number {
  return Math.min(
    parseMilestoneDate(value?.due),
    parseMilestoneDate(value?.due_at),
    parseMilestoneDate(value?.dueAt),
    parseMilestoneDate(value?.due_date),
    parseMilestoneDate(value?.target_date),
    parseMilestoneDate(value?.targetDate),
    parseMilestoneDate(value?.deadline),
    parseMilestoneDate(value?.eta),
  );
}

export function taskOrder(value: any): number {
  return Math.min(
    numericHint(value?.order),
    numericHint(value?.position),
    numericHint(value?.sequence),
    numericHint(value?.rank),
    numericHint(value?.priority),
    numericHint(value?.sort),
    numericHint(value?.sort_order),
    numericHint(value?.sortOrder),
    numericHint(value?.index),
  );
}

export function taskCandidates(source: any): any[] {
  if (!source) return [];
  if (Array.isArray(source)) return source;

  let arr = toArray(source?.tasks);
  if (arr.length) return arr;

  arr = toArray(source?.task);
  if (arr.length) return arr;

  arr = toArray(source?.items);
  if (arr.length) return arr;

  arr = toArray(source?.results);
  if (arr.length) return arr;

  arr = toArray(source?.data);
  if (arr.length) return arr;

  return [];
}

export function selectNextTask(...sources: any[]): any | null {
  const candidates: any[] = [];
  for (const src of sources) {
    candidates.push(...taskCandidates(src));
  }

  if (!candidates.length) return null;

  const pendingStatusPriorities = [0, 1, 2, 3, 4];

  const pending = candidates.filter((task) => {
    const statusStr = task.status
      ? String(task.status).toLowerCase()
      : "unknown";
    const prio = taskStatusPriority(statusStr);
    return pendingStatusPriorities.includes(prio);
  });

  if (!pending.length) return null;

  const withScores = pending.map((task) => {
    const statusPrio = taskStatusPriority(task.status);
    const dueVal = taskDue(task);
    const orderVal = taskOrder(task);

    return { task, statusPrio, dueVal, orderVal };
  });

  withScores.sort((a, b) => {
    if (a.statusPrio !== b.statusPrio) return a.statusPrio - b.statusPrio;
    if (a.dueVal !== b.dueVal) return a.dueVal - b.dueVal;
    if (a.orderVal !== b.orderVal) return a.orderVal - b.orderVal;
    return 0;
  });

  return withScores[0].task;
}

export function pickSuggestion(suggestions: any[] | undefined | null) {
  if (!Array.isArray(suggestions) || !suggestions.length) {
    return null;
  }

  for (const s of suggestions) {
    const title = firstString(s?.title);
    if (title) {
      return s;
    }
  }

  return suggestions[0];
}
