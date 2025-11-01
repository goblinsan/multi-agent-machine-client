import { TaskAPI } from "../dashboard/TaskAPI.js";
import { ProjectAPI } from "../dashboard/ProjectAPI.js";
import { cfg } from "../config.js";
import { logger } from "../logger.js";
import { summarizeTask } from "../agents/summarizer.js";
import { PERSONAS } from "../personaNames.js";

export {
  normalizeTaskStatus,
  selectNextTask,
  pickSuggestion,
} from "./taskSelection.js";
export { deriveTaskContext } from "./taskContext.js";

const taskAPI = new TaskAPI();
const projectAPI = new ProjectAPI();

export async function createDashboardTaskEntries(
  tasks: any[],
  options: {
    stage: "qa" | "devops" | "code-review" | "security";
    milestoneDescriptor: any;
    parentTaskDescriptor: any;
    projectId: string | null;
    projectName: string | null;
    scheduleHint?: string;
  },
): Promise<any[]> {
  if (!tasks.length) return [];
  const rawMilestone =
    options.milestoneDescriptor?.id ??
    options.milestoneDescriptor?.slug ??
    null;
  let milestoneId: string | null = null;
  let milestoneSlug: string | null = null;
  if (typeof rawMilestone === "string") {
    const uuidRegex =
      /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
    if (uuidRegex.test(rawMilestone)) milestoneId = rawMilestone;
    else milestoneSlug = String(rawMilestone);
  }

  if (!milestoneId && !milestoneSlug) {
    milestoneSlug = "future-enhancements";
  }
  const parentTaskIdRaw = options.parentTaskDescriptor?.id || null;

  const isUuid = (s: string) =>
    /^(?:[0-9a-fA-F]{8})-(?:[0-9a-fA-F]{4})-(?:[0-9a-fA-F]{4})-(?:[0-9a-fA-F]{4})-(?:[0-9a-fA-F]{12})$/.test(
      s,
    );
  const parentTaskId =
    typeof parentTaskIdRaw === "string" && isUuid(parentTaskIdRaw)
      ? parentTaskIdRaw
      : parentTaskIdRaw || null;
  const summaries: any[] = [];

  for (const task of tasks) {
    const title = task.title || `${options.stage.toUpperCase()} follow-up`;
    const schedule = (
      task.schedule ||
      options.scheduleHint ||
      ""
    ).toLowerCase();
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
    const descriptionBase =
      task.description || `Follow-up required for ${options.stage}`;
    const description = scheduleNote
      ? `${descriptionBase}\n\nSchedule: ${scheduleNote}`
      : descriptionBase;

    let resolvedMilestoneId = milestoneId;
    let resolvedMilestoneSlug = milestoneSlug;
    if (!resolvedMilestoneId && resolvedMilestoneSlug && options.projectId) {
      try {
        const proj = await projectAPI.fetchProjectStatus(options.projectId);
        const p = proj as any;
        const candidates =
          p?.milestones || p?.milestones_list || p?.milestones?.items || [];
        if (Array.isArray(candidates)) {
          const match = candidates.find((m: any) => {
            if (!m) return false;
            const s = (m.slug || m.name || m.title || "")
              .toString()
              .toLowerCase();
            return s === String(resolvedMilestoneSlug).toLowerCase();
          });
          if (match && match.id) {
            resolvedMilestoneId = match.id;
            resolvedMilestoneSlug = null;
          }
        }
      } catch (err) {
        logger.warn("Failed to resolve milestone from dashboard", {
          taskId: task.id,
          error: String(err),
        });
      }
    }

    const derivedProjectSlug = options.projectName || undefined;

    const externalId =
      options.stage === "qa"
        ? computeQaFollowupExternalId(
            options.projectId,
            options.parentTaskDescriptor,
          )
        : `auto-${options.stage}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

    let attachments: { name: string; content_base64: string }[] | undefined =
      undefined;
    try {
      const diag: any = task.diagnostics || null;
      if (diag && typeof diag === "object") {
        const text =
          typeof diag.text === "string"
            ? diag.text
            : typeof diag === "string"
              ? diag
              : JSON.stringify(diag);
        if (text && text.length) {
          const maxBytes = cfg.dashboardMaxAttachmentBytes || 200000;

          let clipped = text;
          if (Buffer.byteLength(clipped, "utf8") > maxBytes) {
            clipped = clipped.slice(0, Math.floor(maxBytes * 0.9));
          }
          const b64 = Buffer.from(clipped, "utf8").toString("base64");
          attachments = [
            { name: `qa-diagnostics-${Date.now()}.txt`, content_base64: b64 },
          ];
        }
      }
    } catch (err) {
      attachments = undefined;
    }

    const createOptions: Record<string, any> = {
      create_milestone_if_missing: cfg.dashboardCreateMilestoneIfMissing,
    };
    if (options.stage === "qa") createOptions.initial_status = "in_progress";

    if (!resolvedMilestoneId && resolvedMilestoneSlug) {
      createOptions.create_milestone_if_missing = true;
      logger.debug("Milestone not resolved to ID, enabling auto-create", {
        stage: options.stage,
        milestoneSlug: resolvedMilestoneSlug,
        projectId: options.projectId,
      });
    }

    const body = await taskAPI.createDashboardTask({
      projectId: options.projectId || undefined,
      projectSlug: derivedProjectSlug || undefined,
      milestoneId: resolvedMilestoneId || undefined,
      milestoneSlug: resolvedMilestoneSlug || undefined,
      parentTaskId: targetParentTaskId,
      title,
      description,
      effortEstimate: 3,
      priorityScore: task.priority_score ?? task.defaultPriority ?? 5,
      assigneePersona: task.assigneePersona,
      externalId,
      attachments,
      options: createOptions,
    });

    if (body?.ok) {
      const createdId =
        body?.body &&
        (body.body.id ||
          body.body.task_id ||
          (body.body.task && body.body.task.id));
      const summaryParts = [title];
      if (schedule) summaryParts.push(`schedule: ${schedule}`);
      summaryParts.push(`priority ${task.defaultPriority ?? 5}`);

      summaries.push({
        summary: summaryParts.join(" | "),
        title,
        externalId,
        createdId: createdId ? String(createdId) : undefined,
        description,
      });
    } else {
      logger.warn("dashboard task creation failed", {
        stage: options.stage,
        title,
        milestoneId,
        milestoneSlug,
        parentTaskId,
        projectId: options.projectId,
        error: body?.error || body?.body || "unknown",
      });
    }
  }

  return summaries;
}

export function computeQaFollowupExternalId(
  projectId: string | null,
  parentTaskDescriptor: any,
): string {
  const proj = String(projectId || "proj")
    .replace(/[^a-zA-Z0-9_-]+/g, "-")
    .slice(0, 50);
  const parentRaw =
    parentTaskDescriptor?.id ||
    parentTaskDescriptor?.external_id ||
    parentTaskDescriptor?.slug ||
    parentTaskDescriptor?.name ||
    "no-parent";
  const parent = String(parentRaw)
    .replace(/[^a-zA-Z0-9_-]+/g, "-")
    .slice(0, 80);
  return `qa-failure:${proj}:${parent}`;
}

export async function createDashboardTaskEntriesWithSummarizer(
  r: any,
  workflowId: string,
  tasks: any[],
  options: {
    stage: "qa" | "devops" | "code-review" | "security";
    milestoneDescriptor: any;
    parentTaskDescriptor: any;
    projectId: string | null;
    projectName: string | null;
    scheduleHint?: string;
  },
): Promise<any[]> {
  if (!tasks.length) return [];
  const results: any[] = [];

  for (const task of tasks) {
    try {
      const title = task.title || `${options.stage.toUpperCase()} follow-up`;
      const desc =
        task.description ||
        task.summary ||
        `Follow-up required for ${options.stage}`;
      const condensed = await summarizeTask(
        r,
        workflowId,
        {
          title,
          description: desc,
          stage: options.stage,
          project_id: options.projectId,
        },
        { concise: true, persona: PERSONAS.SUMMARIZATION },
      );
      if (condensed && String(condensed).trim().length)
        task.description = `${String(condensed).trim()}\n\n(Original)\n${desc}`;
    } catch (err) {
      logger.debug(
        "summarizer helper failed for task, falling back to original description",
        { task: task.title, error: err },
      );
    }

    const created = await createDashboardTaskEntries([task], options);
    if (created && created.length) results.push(...created);
  }

  return results;
}

export async function findTaskIdByExternalId(
  externalId: string,
  projectId: string | null,
): Promise<string | null> {
  if (!externalId) return null;
  if (!projectId) return null;
  try {
    const proj = await projectAPI.fetchProjectStatus(projectId as string);
    if (!proj) return null;
    const p: any = proj as any;
    const candidates = Array.isArray(p?.tasks)
      ? p.tasks
      : Array.isArray(p?.task_list)
        ? p.task_list
        : Array.isArray(p?.tasks_list)
          ? p.tasks_list
          : [];
    if (!Array.isArray(candidates) || !candidates.length) return null;
    for (const t of candidates) {
      if (!t) continue;
      const ext =
        (t.external_id ?? t.externalId ?? t.external) || t.externalid || null;
      if (ext && String(ext) === String(externalId))
        return String(t.id || t.task_id || t.id);
    }

    for (const t of candidates) {
      if (!t) continue;
      const nested = Array.isArray(t.items)
        ? t.items
        : Array.isArray(t.tasks)
          ? t.tasks
          : null;
      if (!nested) continue;
      for (const n of nested) {
        const ext =
          (n.external_id ?? n.externalId ?? n.external) || n.externalid || null;
        if (ext && String(ext) === String(externalId))
          return String(n.id || n.task_id || n.id);
      }
    }
    return null;
  } catch (err) {
    logger.debug("findTaskIdByExternalId failed", {
      projectId,
      externalId,
      error: err,
    });
    return null;
  }
}
