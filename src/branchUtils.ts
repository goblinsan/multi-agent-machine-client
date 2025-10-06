import { firstString } from "./util.js";

/**
 * Determine a sensible branch name for a milestone/task.
 * Priority:
 * 1) Explicit milestone.branch
 * 2) Explicit task.branch
 * 3) feat/{taskSlug}
 * 4) milestone/{milestoneSlug} if milestoneSlug is not the generic 'milestone'
 * 5) milestone/{projectSlug}
 */
export function buildBranchName(
  selectedMilestone: any,
  selectedTask: any,
  projectSlug: string,
  milestoneSlug: string | null,
  taskSlug: string | null
): string {
  const fromMilestone = firstString(
    selectedMilestone?.branch,
    selectedMilestone?.branch_name,
    selectedMilestone?.branchName
  );
  if (fromMilestone) return String(fromMilestone);

  const fromTask = firstString(
    selectedTask?.branch,
    selectedTask?.branch_name,
    selectedTask?.branchName
  );
  if (fromTask) return String(fromTask);

  if (taskSlug && taskSlug.trim().length) return `feat/${taskSlug}`;

  if (milestoneSlug && milestoneSlug !== "milestone") return `milestone/${milestoneSlug}`;

  return `milestone/${projectSlug}`;
}
