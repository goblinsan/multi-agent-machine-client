/**
 * Redis Event Stream Publisher
 * 
 * Centralized helper for publishing events to the Redis event stream.
 * Consolidates duplicate xAdd patterns across worker.ts and process.ts.
 */

import { cfg } from '../config.js';

export interface EventData {
  workflowId: string;
  taskId?: string;
  step?: string;
  fromPersona: string;
  status: 'done' | 'error' | 'duplicate_response' | string;
  result?: any;
  corrId?: string;
  error?: string;
}

/**
 * Publish an event to the Redis event stream
 * 
 * @param redisClient - Redis client instance
 * @param event - Event data to publish
 * @returns Promise that resolves when event is published
 */
export async function publishEvent(redisClient: any, event: EventData): Promise<void> {
  const fields: Record<string, string> = {
    workflow_id: event.workflowId,
    task_id: event.taskId || "",
    step: event.step || "",
    from_persona: event.fromPersona,
    status: event.status,
    corr_id: event.corrId || "",
    ts: new Date().toISOString()
  };

  // Add result if provided
  if (event.result !== undefined) {
    fields.result = typeof event.result === 'string' 
      ? event.result 
      : JSON.stringify(event.result);
  }

  // Add error if provided
  if (event.error !== undefined) {
    fields.error = event.error;
  }

  await redisClient.xAdd(cfg.eventStream, "*", fields);
}
