import { cfg } from "../../config.js";
import { logger } from "../../logger.js";
import { PERSONAS as _PERSONAS } from "../../personaNames.js";
import type { WorkflowContext } from "../engine/WorkflowContext.js";

const STREAM_NAME = cfg.requestStream;







async function purgeWorkflowRedisQueues(
  transport: any,
  workflowId: string
): Promise<{ removed: number; acked: number }> {
  try {
    if (!transport || typeof transport.xRange !== 'function') {
      return { removed: 0, acked: 0 };
    }

    const entries = await transport.xRange(STREAM_NAME, '-', '+', { COUNT: 200 });
    const toRemove: string[] = [];
    let acked = 0;

    for (const entry of entries || []) {
      const id = (entry as any).id;
      const message = (entry as any).message || (entry as any).fields || {};
      if (message.workflow_id === workflowId) {
        toRemove.push(id);
        
        try {
          acked += await transport.xAck(STREAM_NAME, `${cfg.groupPrefix}:lead-engineer`, id);
        } catch (e) {
          logger.debug('Failed to ack message in lead-engineer group', { id, error: String(e) });
        }
        try {
          acked += await transport.xAck(STREAM_NAME, `${cfg.groupPrefix}:coordination`, id);
        } catch (e) {
          logger.debug('Failed to ack message in coordination group', { id, error: String(e) });
        }
      }
    }

    let removed = 0;
    if (toRemove.length) {
      removed = await transport.xDel(STREAM_NAME, toRemove);
    }
    return { removed, acked };
  } catch (err) {
    
    return { removed: 0, acked: 0 };
  }
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
    cleanupResult = await purgeWorkflowRedisQueues(context.transport, workflowId);
    context.logger.warn("cleared pending persona requests after workflow abort", {
      workflowId,
      reason,
      removed: cleanupResult.removed,
      acked: cleanupResult.acked
    });
  } catch (err) {
    
    const level = process.env.NODE_ENV === 'test' ? 'debug' : 'warn';
    (context.logger as any)[level]("failed to purge redis queues during workflow abort", {
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
