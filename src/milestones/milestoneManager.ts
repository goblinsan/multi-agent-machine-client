
import { firstString, numericHint, slugify, toArray } from "../util.js";

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

export function parseMilestoneDate(value: any): number {
  if (!value) return Number.POSITIVE_INFINITY;
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) return parsed;
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

export function selectNextMilestone(status: any): any | null {
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

export function deriveMilestoneContext(milestone: any, nameFallback: string, branchFallback: string, taskDescriptor: any) {
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
