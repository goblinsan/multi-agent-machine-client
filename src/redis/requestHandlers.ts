/**
 * Request Handlers
 * 
 * Centralized helpers for request stream operations.
 * Consolidates duplicate xAck patterns across worker.ts and process.ts.
 * Supports both Redis and LocalTransport via MessageTransport interface.
 */

import { cfg } from '../config.js';
import { logger } from '../logger.js';
import type { MessageTransport } from '../transport/MessageTransport.js';

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
 * Acknowledge a request from the request stream
 * 
 * @param transport - Message transport instance (Redis or LocalTransport)
 * @param persona - Persona name
 * @param entryId - Stream entry ID to acknowledge
 * @param silent - If true, suppress errors (default: false)
 * @returns Promise that resolves when acknowledgment is complete
 */
export async function acknowledgeRequest(
  transport: MessageTransport,
  persona: string,
  entryId: string,
  silent: boolean = false
): Promise<void> {
  const group = groupForPersona(persona);
  
  try {
    await transport.xAck(cfg.requestStream, group, entryId);
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
