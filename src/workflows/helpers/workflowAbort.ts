import { cfg } from "../../config.js";
import { logger } from "../../logger.js";
import { PERSONAS } from "../../personaNames.js";
import type { WorkflowContext } from "../engine/WorkflowContext.js";

const STREAM_NAME = cfg.requestStream;

// purgeWorkflowRedisQueues commented out - uses xRange which is not in MessageTransport interface
// This was optional cleanup to remove pending requests when a workflow aborts
// Could be re-implemented if xRange is added to MessageTransport in the future
async function purgeWorkflowRedisQueues(workflowId: string): Promise<{ removed: number; acked: number }> {
  logger.warn("workflow redis cleanup skipped: xRange not in MessageTransport interface", { workflowId });
  return { removed: 0, acked: 0 };
}

export async function abortWorkflowWithReason(
  context: WorkflowContext,
  reason: string,
  details: Record<string, any> = {}
): Promise<{ cleanupResult: { removed: number; acked: number } | null }> {
  if (context.getVariable("workflowAborted")) {
    context.logger.debug("workflow abort already recorded", { reason, details });
    const abortMeta = context.getVariable("workflowAbort");
    return { cleanupResult: abortMeta?.cleanupResult ?? null };
  }

  const workflowId = context.workflowId;
  let cleanupResult: { removed: number; acked: number } | null = null;

  try {
    const snapshot = context.createDiagnosticSnapshot();
    context.logger.error("workflow diagnostic snapshot", { reason, snapshot });
  } catch (err) {
    context.logger.warn("failed to create diagnostic snapshot", {
      workflowId,
      reason,
      error: err instanceof Error ? err.message : String(err)
    });
  }

  try {
    cleanupResult = await purgeWorkflowRedisQueues(workflowId);
    context.logger.warn("cleared pending persona requests after workflow abort", {
      workflowId,
      reason,
      removed: cleanupResult.removed,
      acked: cleanupResult.acked
    });
  } catch (err) {
    context.logger.error("failed to purge redis queues during workflow abort", {
      workflowId,
      reason,
      error: err instanceof Error ? err.message : String(err)
    });
  }

  context.setVariable("workflowAborted", true);
  context.setVariable("workflowAbort", {
    reason,
    details,
    cleanupResult,
    timestamp: new Date().toISOString()
  });

  return { cleanupResult };
}

export async function abortWorkflowDueToPushFailure(
  context: WorkflowContext,
  commitResult: Record<string, any>,
  meta: { message: string; paths: string[] }
): Promise<void> {
  const branch = commitResult.branch || context.getVariable("branch") || context.branch;
  const reason = commitResult.reason || "push_failed";

  context.logger.error("git push failed during commitAndPushPaths", {
    branch,
    reason,
    commitResult,
    commitMessage: meta.message,
    changedPaths: meta.paths
  });

  const { cleanupResult } = await abortWorkflowWithReason(context, reason, {
    commitResult,
    meta
  });
  context.setVariable("pushFailure", {
    commitResult,
    cleanupResult
  });
}
