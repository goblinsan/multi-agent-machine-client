/**
 * Redis Request Handlers
 * 
 * Centralized helpers for Redis request stream operations.
 * Consolidates duplicate xAck patterns across worker.ts and process.ts.
 */

import { cfg } from '../config.js';
import { logger } from '../logger.js';

/**
 * Get the consumer group name for a persona
 * 
 * @param persona - Persona name
 * @returns Consumer group name
 */
export function groupForPersona(persona: string): string {
  return `${cfg.groupPrefix}:${persona}`;
}

/**
 * Acknowledge a request from the Redis request stream
 * 
 * @param redisClient - Redis client instance
 * @param persona - Persona name
 * @param entryId - Redis stream entry ID to acknowledge
 * @param silent - If true, suppress errors (default: false)
 * @returns Promise that resolves when acknowledgment is complete
 */
export async function acknowledgeRequest(
  redisClient: any,
  persona: string,
  entryId: string,
  silent: boolean = false
): Promise<void> {
  const group = groupForPersona(persona);
  
  try {
    await redisClient.xAck(cfg.requestStream, group, entryId);
  } catch (err: any) {
    if (!silent) {
      throw err;
    }
    logger.debug('request ack failed (silent)', { 
      persona, 
      entryId, 
      error: err?.message || String(err) 
    });
  }
}
