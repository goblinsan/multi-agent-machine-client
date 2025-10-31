/**
 * Duplicate Message Detection System
 * 
 * Tracks processed task_id + corr_id pairs to prevent duplicate processing
 * of the same request across distributed persona workers.
 */

import { logger } from "./logger.js";

interface ProcessedMessage {
  taskId: string;
  corrId: string;
  persona: string;
  timestamp: number;
  workflowId: string;
}

// In-memory storage for processed messages
// Key format: "taskId:corrId:persona"
const processedMessages = new Map<string, ProcessedMessage>();

// TTL for processed messages: 24 hours (in milliseconds)
const MESSAGE_TTL_MS = 24 * 60 * 60 * 1000;

// Cleanup interval: run every hour
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000;

/**
 * Generate a unique key for a message
 */
function generateMessageKey(taskId: string, corrId: string, persona: string): string {
  return `${taskId}:${corrId}:${persona.toLowerCase()}`;
}

/**
 * Check if a message has already been processed
 */
export function isDuplicateMessage(
  taskId: string | undefined,
  corrId: string | undefined,
  persona: string
): boolean {
  // If either ID is missing, we can't track duplicates
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

/**
 * Mark a message as processed
 */
export function markMessageProcessed(
  taskId: string | undefined,
  corrId: string | undefined,
  persona: string,
  workflowId: string
): void {
  // Only track if we have both IDs
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

/**
 * Clean up expired message records
 */
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

/**
 * Start automatic cleanup of expired messages
 */
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

/**
 * Stop automatic cleanup (for testing or shutdown)
 */
export function stopMessageTrackingCleanup(): void {
  if (cleanupIntervalHandle) {
    clearInterval(cleanupIntervalHandle);
    cleanupIntervalHandle = null;
    logger.info("Message tracking cleanup stopped");
  }
}

/**
 * Clear all tracked messages (for testing)
 */
export function clearMessageTracking(): void {
  processedMessages.clear();
  logger.debug("Message tracking cleared");
}

/**
 * Get statistics about tracked messages
 */
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
