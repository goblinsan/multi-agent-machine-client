import { firstString } from "./util.js";

export function buildBranchName(
  selectedMilestone: any,
  selectedTask: any,
  projectSlug: string,
  milestoneSlug: string | null,
  taskSlug: string | null,
): string {
  const fromMilestone = firstString(
    selectedMilestone?.branch,
    selectedMilestone?.branch_name,
    selectedMilestone?.branchName,
  );
  if (fromMilestone) return String(fromMilestone);

  const fromTask = firstString(
    selectedTask?.branch,
    selectedTask?.branch_name,
    selectedTask?.branchName,
  );
  if (fromTask) return String(fromTask);

  if (taskSlug && taskSlug.trim().length) return `feat/${taskSlug}`;

  if (milestoneSlug && milestoneSlug !== "milestone")
    return `milestone/${milestoneSlug}`;

  return `milestone/${projectSlug}`;
}
