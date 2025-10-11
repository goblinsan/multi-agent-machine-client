import { cfg } from "../../config.js";
import { logger } from "../../logger.js";
import { makeRedis } from "../../redisClient.js";
import { PERSONAS } from "../../personaNames.js";
import type { WorkflowContext } from "../engine/WorkflowContext.js";

const XRANGE_BATCH_SIZE = 200;
const STREAM_NAME = cfg.requestStream;

async function purgeWorkflowRedisQueues(workflowId: string): Promise<{ removed: number; acked: number }> {
  let client: Awaited<ReturnType<typeof makeRedis>> | null = null;
  try {
    client = await makeRedis();
  } catch (err) {
    logger.error("workflow redis cleanup failed to connect", {
      workflowId,
      error: err instanceof Error ? err.message : String(err)
    });
    return { removed: 0, acked: 0 };
  }

  const ackGroups = new Set<string>();
  (cfg.allowedPersonas || []).forEach(persona => {
    if (persona) ackGroups.add(`${cfg.groupPrefix}:${persona}`);
  });
  ackGroups.add(`${cfg.groupPrefix}:${PERSONAS.COORDINATION}`);

  let cursor = "-";
  let removed = 0;
  let acked = 0;

  if (typeof (client as any).xRange !== "function") {
    logger.warn("workflow redis cleanup skipped: xRange not supported", { workflowId });
    return { removed, acked };
  }

  try {
    while (true) {
      const entries = await client.xRange(STREAM_NAME, cursor, "+", { COUNT: XRANGE_BATCH_SIZE }).catch(err => {
        logger.warn("workflow redis cleanup xRange failed", {
          workflowId,
          error: err instanceof Error ? err.message : String(err)
        });
        return null;
      });

      if (!entries || entries.length === 0) {
        break;
      }

      const matchingIds: string[] = [];

      for (const entry of entries) {
        const id = (entry as any).id ?? (Array.isArray(entry) ? entry[0] : undefined);
        const message = (entry as any).message ?? (Array.isArray(entry) ? entry[1] : undefined);
        if (!id || !message) continue;
        const workflowField = (message as Record<string, string>).workflow_id || (message as Record<string, string>).workflowId;
        if (workflowField === workflowId) {
          matchingIds.push(id);
        }
      }

      if (matchingIds.length) {
        const chunkSize = 50;
        for (let start = 0; start < matchingIds.length; start += chunkSize) {
          const chunk = matchingIds.slice(start, start + chunkSize);
          for (const group of ackGroups) {
            for (const id of chunk) {
              if (typeof (client as any).xAck === "function") {
                try {
                  const ackCount = await client.xAck(STREAM_NAME, group, id);
                  if (typeof ackCount === "number") {
                    acked += ackCount;
                  }
                } catch (err) {
                  logger.debug("workflow redis cleanup xAck failed", {
                    workflowId,
                    group,
                    id,
                    error: err instanceof Error ? err.message : String(err)
                  });
                }
              }
            }
          }

          if (typeof (client as any).xDel === "function") {
            try {
              const deleteCount = await client.xDel(STREAM_NAME, chunk);
              if (typeof deleteCount === "number") {
                removed += deleteCount;
              } else {
                removed += chunk.length;
              }
            } catch (err) {
              logger.warn("workflow redis cleanup xDel failed", {
                workflowId,
                count: chunk.length,
                error: err instanceof Error ? err.message : String(err)
              });
            }
          }
        }
      }

      const lastEntry = entries[entries.length - 1] as any;
      const lastId = lastEntry?.id ?? (Array.isArray(lastEntry) ? lastEntry[0] : undefined);
      if (!lastId) break;
      cursor = `(${lastId}`;
    }
  } finally {
    try {
      await client.quit();
    } catch {}
  }

  return { removed, acked };
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
