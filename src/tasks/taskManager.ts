
import { firstString, numericHint, slugify, toArray } from "../util.js";
import { createDashboardTask, fetchProjectStatus } from "../dashboard.js";
import { cfg } from "../config.js";
import { parseMilestoneDate } from "../milestones/milestoneManager.js";
import { logger } from "../logger.js";

//TODO: this should be handled in a better way
const externalToTaskId = new Map<string,string>();

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
  
  export function selectNextTask(...sources: any[]): any | null {
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
  
  export function deriveTaskContext(task: any) {
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
  
  export function pickSuggestion(suggestions: any[] | undefined | null) {
    if (!Array.isArray(suggestions) || suggestions.length === 0) return null;
    const preferred = suggestions.find(s => !s?.persona_required || s.persona_required === "lead-engineer");
    return suggestionToTask(preferred || suggestions[0]);
  }

  export async function createDashboardTaskEntries(tasks: any[], options: {
    stage: "qa" | "devops" | "code-review" | "security";
    milestoneDescriptor: any;
    parentTaskDescriptor: any;
    projectId: string | null;
    projectName: string | null;
    scheduleHint?: string;
  }): Promise<any[]> {
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
  const summaries: any[] = [];

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

      // derive project_slug if available (use provided projectName or fallback to known project slug)
      const derivedProjectSlug = options.projectName || undefined; // prefer projectName for slug
      const externalId = `auto-${options.stage}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2,8)}`;

      // if QA diagnostics exist on the task, prepare attachments (base64) clipped to configured max size
      let attachments: { name: string; content_base64: string }[] | undefined = undefined;
      try {
  const diag: any = (task.diagnostics || null);
        if (diag && typeof diag === "object") {
          const text = typeof diag.text === "string" ? diag.text : (typeof diag === "string" ? diag : JSON.stringify(diag));
          if (text && text.length) {
            const maxBytes = cfg.dashboardMaxAttachmentBytes || 200000;
            // clip to maxBytes when UTF-8 encoded conservatively: assume 1 char = 1 byte for ASCII; further clipping is acceptable
            let clipped = text;
            if (Buffer.byteLength(clipped, "utf8") > maxBytes) {
              clipped = clipped.slice(0, Math.floor(maxBytes * 0.9));
            }
            const b64 = Buffer.from(clipped, "utf8").toString("base64");
            attachments = [{ name: `qa-diagnostics-${Date.now()}.txt`, content_base64: b64 }];
          }
        }
      } catch (err) {
        // ignore attachment build errors
        attachments = undefined;
      }

      // If creating QA follow-ups, request initial_status=in_progress so they're visible immediately
      const createOptions: Record<string, any> = { create_milestone_if_missing: cfg.dashboardCreateMilestoneIfMissing };
      if (options.stage === 'qa') createOptions.initial_status = 'in_progress';

      const body = await createDashboardTask({
        projectId: options.projectId || undefined,
        projectSlug: derivedProjectSlug || undefined,
        milestoneId: resolvedMilestoneId || undefined,
        milestoneSlug: resolvedMilestoneSlug || undefined,
        parentTaskId: targetParentTaskId,
        title,
        description,
        effortEstimate: 3,
        priorityScore: task.defaultPriority ?? 5,
        assigneePersona: task.assigneePersona,
        externalId,
        attachments,
        options: createOptions
      });

      if (body?.ok) {
        // store external -> task id mapping if server returned an id
        try {
          const createdId = body?.body && (body.body.id || body.body.task_id || (body.body.task && body.body.task.id));
          if (createdId && externalId) externalToTaskId.set(String(externalId), String(createdId));
          const summaryParts = [title];
          if (schedule) summaryParts.push(`schedule: ${schedule}`);
          summaryParts.push(`priority ${task.defaultPriority ?? 5}`);
          summaries.push({ summary: summaryParts.join(" | "), title, externalId, createdId: String(createdId) });
          continue;
        } catch {}
        const summaryParts = [title];
        if (schedule) summaryParts.push(`schedule: ${schedule}`);
        summaryParts.push(`priority ${task.defaultPriority ?? 5}`);
        summaries.push({ summary: summaryParts.join(" | "), title, externalId });
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
