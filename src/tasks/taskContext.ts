import { firstString, slugify } from "../util.js";
import { normalizeTaskStatus } from "./taskSelection.js";

export function deriveTaskContext(task: any) {
  if (!task || typeof task !== "object") {
    return {
      name: null as string | null,
      slug: null as string | null,
      descriptor: null as any,
    };
  }

  const name =
    firstString(
      task?.name,
      task?.title,
      task?.summary,
      task?.label,
      task?.key,
      task?.id,
    ) || null;

  const taskSlugRaw = firstString(
    task?.slug,
    task?.key,
    name,
    task?.id,
    "task",
  );
  const slug = taskSlugRaw ? slugify(taskSlugRaw) : null;

  const dueText = firstString(
    task?.due,
    task?.due_at,
    task?.dueAt,
    task?.due_date,
    task?.target_date,
    task?.targetDate,
    task?.deadline,
    task?.eta,
  );

  const descriptor = {
    id: firstString(task?.id, task?.key, slug, name) || null,
    name,
    slug,
    status: task?.status ?? task?.state ?? task?.progress ?? null,
    normalized_status: normalizeTaskStatus(
      task?.status ??
        task?.state ??
        task?.phase ??
        task?.stage ??
        task?.progress,
    ),
    due: dueText || null,
    assignee:
      firstString(
        task?.assignee,
        task?.assignee_name,
        task?.assigneeName,
        task?.owner,
        task?.owner_name,
        task?.assigned_to,
        task?.assignedTo,
      ) || null,
    branch:
      firstString(task?.branch, task?.branch_name, task?.branchName) || null,
    summary: firstString(task?.summary, task?.description) || null,
  };

  return { name, slug, descriptor };
}

export function suggestionToTask(suggestion: any) {
  if (!suggestion || typeof suggestion !== "object") return null;

  const title = firstString(suggestion?.title);
  const description =
    firstString(suggestion?.description) ||
    firstString(suggestion?.details) ||
    firstString(suggestion?.body) ||
    "";
  const labels: string[] = Array.isArray(suggestion?.labels)
    ? suggestion.labels.filter((l: any) => typeof l === "string")
    : [];

  return {
    title,
    description,
    labels,
    source: "suggestion",
    originalSuggestion: suggestion,
  };
}
