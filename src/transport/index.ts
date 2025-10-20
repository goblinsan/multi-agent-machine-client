/**
 * Message Transport Factory
 * 
 * Creates the appropriate message transport based on configuration.
 * Supports Redis (distributed) and Local (in-memory) transports.
 */

import { MessageTransport } from './MessageTransport.js';
import { RedisTransport } from './RedisTransport.js';
import { LocalTransport } from './LocalTransport.js';
import { cfg } from '../config.js';

// Re-export types for convenience
export type { MessageTransport } from './MessageTransport.js';

let transportInstance: MessageTransport | null = null;

/**
 * Transport types
 */
export type TransportType = 'redis' | 'local';

/**
 * Get the configured transport type
 */
export function getTransportType(): TransportType {
  return cfg.transportType;
}

/**
 * Create a new message transport instance
 * 
 * @returns MessageTransport instance
 */
export function createTransport(): MessageTransport {
  const type = cfg.transportType;

  switch (type) {
    case 'redis':
      return new RedisTransport(cfg.redisUrl, cfg.redisPassword);
    
    case 'local':
      return new LocalTransport();
    
    default:
      throw new Error(`Unknown transport type: ${type}. Supported types: redis, local`);
  }
}

/**
 * Get or create the singleton transport instance
 * 
 * Use this for most cases to ensure a single transport instance
 * is shared across the application.
 * 
 * @returns MessageTransport instance
 */
export async function getTransport(): Promise<MessageTransport> {
  if (!transportInstance) {
    transportInstance = createTransport();
    await transportInstance.connect();
  }
  return transportInstance;
}

/**
 * Close the transport instance
 */
export async function closeTransport(): Promise<void> {
  if (transportInstance) {
    await transportInstance.disconnect();
    transportInstance = null;
  }
}

/**
 * Reset the transport instance (for testing)
 */
export function resetTransport(): void {
  transportInstance = null;
}
