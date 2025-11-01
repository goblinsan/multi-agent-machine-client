

import { logger } from "./logger.js";

interface ProcessedMessage {
  taskId: string;
  corrId: string;
  persona: string;
  timestamp: number;
  workflowId: string;
}



const processedMessages = new Map<string, ProcessedMessage>();


const MESSAGE_TTL_MS = 24 * 60 * 60 * 1000;


const CLEANUP_INTERVAL_MS = 60 * 60 * 1000;


function generateMessageKey(taskId: string, corrId: string, persona: string): string {
  return `${taskId}:${corrId}:${persona.toLowerCase()}`;
}


export function isDuplicateMessage(
  taskId: string | undefined,
  corrId: string | undefined,
  persona: string
): boolean {
  
  if (!taskId || !corrId) {
    return false;
  }

  const key = generateMessageKey(taskId, corrId, persona);
  const existing = processedMessages.get(key);

  if (existing) {
    logger.warn("Duplicate message detected", {
      taskId,
      corrId,
      persona,
      originalTimestamp: new Date(existing.timestamp).toISOString(),
      originalWorkflowId: existing.workflowId
    });
    return true;
  }

  return false;
}


export function markMessageProcessed(
  taskId: string | undefined,
  corrId: string | undefined,
  persona: string,
  workflowId: string
): void {
  
  if (!taskId || !corrId) {
    return;
  }

  const key = generateMessageKey(taskId, corrId, persona);
  processedMessages.set(key, {
    taskId,
    corrId,
    persona,
    timestamp: Date.now(),
    workflowId
  });

  logger.debug("Message marked as processed", {
    taskId,
    corrId,
    persona,
    workflowId,
    totalTracked: processedMessages.size
  });
}


function cleanupExpiredMessages(): void {
  const now = Date.now();
  let removedCount = 0;

  for (const [key, message] of processedMessages.entries()) {
    if (now - message.timestamp > MESSAGE_TTL_MS) {
      processedMessages.delete(key);
      removedCount++;
    }
  }

  if (removedCount > 0) {
    logger.info("Cleaned up expired message tracking records", {
      removedCount,
      remainingCount: processedMessages.size
    });
  }
}


let cleanupIntervalHandle: ReturnType<typeof setInterval> | null = null;

export function startMessageTrackingCleanup(): void {
  if (cleanupIntervalHandle) {
    return;
  }

  cleanupIntervalHandle = setInterval(cleanupExpiredMessages, CLEANUP_INTERVAL_MS);
  logger.info("Message tracking cleanup started", {
    cleanupIntervalMs: CLEANUP_INTERVAL_MS,
    ttlMs: MESSAGE_TTL_MS
  });
}


export function stopMessageTrackingCleanup(): void {
  if (cleanupIntervalHandle) {
    clearInterval(cleanupIntervalHandle);
    cleanupIntervalHandle = null;
    logger.info("Message tracking cleanup stopped");
  }
}


export function clearMessageTracking(): void {
  processedMessages.clear();
  logger.debug("Message tracking cleared");
}


export function getMessageTrackingStats(): {
  totalTracked: number;
  oldestTimestamp: number | null;
  newestTimestamp: number | null;
} {
  if (processedMessages.size === 0) {
    return { totalTracked: 0, oldestTimestamp: null, newestTimestamp: null };
  }

  let oldest = Number.MAX_SAFE_INTEGER;
  let newest = 0;

  for (const message of processedMessages.values()) {
    if (message.timestamp < oldest) oldest = message.timestamp;
    if (message.timestamp > newest) newest = message.timestamp;
  }

  return {
    totalTracked: processedMessages.size,
    oldestTimestamp: oldest,
    newestTimestamp: newest
  };
}
