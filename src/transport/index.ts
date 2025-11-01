

import { MessageTransport } from './MessageTransport.js';
import { RedisTransport } from './RedisTransport.js';
import { LocalTransport } from './LocalTransport.js';
import { cfg } from '../config.js';


export type { MessageTransport } from './MessageTransport.js';

let transportInstance: MessageTransport | null = null;


export type TransportType = 'redis' | 'local';


export function getTransportType(): TransportType {
  return cfg.transportType;
}


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


export async function getTransport(): Promise<MessageTransport> {
  if (!transportInstance) {
    transportInstance = createTransport();
    await transportInstance.connect();
  }
  return transportInstance;
}


export async function closeTransport(): Promise<void> {
  if (transportInstance) {
    await transportInstance.disconnect();
    transportInstance = null;
  }
}


export function resetTransport(): void {
  transportInstance = null;
}
