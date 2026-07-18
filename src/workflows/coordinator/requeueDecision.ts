import { logger } from "../../logger.js";

export function getWorkflowStopReason(result: any): string | undefined {
  const reason =
    result?.outputs?.workflow_stop_reason ||
    result?.data?.workflow_stop_reason ||
    result?.workflow_stop_reason;
  return typeof reason === "string" ? reason : undefined;
}

export function isDeliberatelyRequeuedTask(
  result: any,
  postStatus: string,
  isActionableStatus: (status: string) => boolean,
): boolean {
  return (
    getWorkflowStopReason(result) === "convergence_retry" &&
    isActionableStatus(postStatus)
  );
}

export async function updateTaskExhaustionAfterSuccess(args: {
  result: any;
  fetchProjectTasks: () => Promise<any[]>;
  normalizeTaskStatus: (status: any) => string;
  isActionableStatus: (status: string) => boolean;
  exhaustedTaskIds: Set<string>;
  taskId: string;
  preStatus: string;
  workflowId: string;
  projectId: string;
  attempt: number;
}): Promise<void> {
  const {
    result,
    fetchProjectTasks,
    normalizeTaskStatus,
    isActionableStatus,
    exhaustedTaskIds,
    taskId,
    preStatus,
    workflowId,
    projectId,
    attempt,
  } = args;

  try {
    const refreshedTasks = await fetchProjectTasks();
    const refreshedTask = refreshedTasks.find(
      (task: any) => String(task?.id) === taskId,
    );
    const postStatus = refreshedTask
      ? normalizeTaskStatus(refreshedTask.status)
      : preStatus;

    if (postStatus === preStatus) {
      logger.warn("Task status unchanged after successful workflow", {
        workflowId,
        projectId,
        taskId,
        status: preStatus,
        attempt,
      });
    }

    if (isDeliberatelyRequeuedTask(result, postStatus, isActionableStatus)) {
      exhaustedTaskIds.delete(taskId);
      logger.info("Task requeued itself for another coordinator pass", {
        workflowId,
        projectId,
        taskId,
        status: postStatus,
        reason: getWorkflowStopReason(result),
      });
      return;
    }

    exhaustedTaskIds.add(taskId);
  } catch {
    exhaustedTaskIds.add(taskId);
    logger.warn(
      "Failed to re-fetch task after workflow, skipping status-change check",
      { taskId },
    );
  }
}
