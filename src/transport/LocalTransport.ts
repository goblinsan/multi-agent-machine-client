

import { EventEmitter } from 'events';
import {
  MessageTransport,
  Message,
  ReadResult,
  ConsumerGroup,
  CreateGroupOptions,
  ReadOptions
} from './MessageTransport.js';

interface StoredMessage {
  id: string;
  fields: Record<string, string>;
  timestamp: number;
}

interface ConsumerGroupState {
  name: string;
  lastDeliveredId: string;
  consumers: Map<string, Set<string>>;
}


export class LocalTransport implements MessageTransport {
  private emitter: EventEmitter;
  private streams: Map<string, StoredMessage[]>;
  private groups: Map<string, Map<string, ConsumerGroupState>>;
  private messageIdCounter: number = 0;
  private connected: boolean = false;

  constructor() {
    this.emitter = new EventEmitter();
    this.emitter.setMaxListeners(100);
    this.streams = new Map();
    this.groups = new Map();
  }

  async connect(): Promise<void> {
    this.connected = true;
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    this.emitter.removeAllListeners();
  }

  async quit(): Promise<void> {
    await this.disconnect();
  }

  
  private generateId(): string {
    const timestamp = Date.now();
    const sequence = this.messageIdCounter++;
    return `${timestamp}-${sequence}`;
  }

  
  private compareIds(a: string, b: string): number {
    if (a === b) return 0;
    
    const [aTime, aSeq] = a.split('-').map(Number);
    const [bTime, bSeq] = b.split('-').map(Number);
    
    if (aTime !== bTime) return aTime < bTime ? -1 : 1;
    return aSeq < bSeq ? -1 : 1;
  }

  
  async xAdd(stream: string, id: string, fields: Record<string, string>): Promise<string> {
    if (!this.streams.has(stream)) {
      this.streams.set(stream, []);
    }

    const messageId = id === '*' ? this.generateId() : id;
    const message: StoredMessage = {
      id: messageId,
      fields: { ...fields },
      timestamp: Date.now()
    };

    this.streams.get(stream)!.push(message);

    
    if (process.env.DEBUG_TRANSPORT) {
      console.log(`[LocalTransport xAdd] Added message to '${stream}': ${messageId}`, {
        to_persona: fields.to_persona,
        intent: fields.intent,
        workflow_id: fields.workflow_id
      });
    }

    
    this.emitter.emit(`stream:${stream}`, message);

    return messageId;
  }

  
  async xGroupCreate(
    stream: string,
    group: string,
    startId: string,
    options?: CreateGroupOptions
  ): Promise<void> {
    
    if (options?.MKSTREAM && !this.streams.has(stream)) {
      this.streams.set(stream, []);
    }

    
    if (!this.streams.has(stream)) {
      throw new Error(`ERR no such key`);
    }

    
    if (!this.groups.has(stream)) {
      this.groups.set(stream, new Map());
    }

    const streamGroups = this.groups.get(stream)!;
    if (streamGroups.has(group)) {
      throw new Error(`BUSYGROUP Consumer Group name already exists`);
    }

    
    streamGroups.set(group, {
      name: group,
      lastDeliveredId: startId,
      consumers: new Map()
    });
  }

  
  async xReadGroup(
    group: string,
    consumer: string,
    streams: { key: string; id: string } | Array<{ key: string; id: string }>,
    options?: ReadOptions
  ): Promise<ReadResult | null> {
    const streamArray = Array.isArray(streams) ? streams : [streams];
    const count = options?.COUNT ?? 10;
    const blockMs = options?.BLOCK ?? 0;

    
    const debugLog = (msg: string, data?: any) => {
      if (process.env.DEBUG_TRANSPORT) {
        console.log(`[LocalTransport xReadGroup] ${msg}`, data || '');
      }
    };

    debugLog('Reading', { group, consumer, streams: streamArray.map(s => s.key), count, blockMs });

    const result: ReadResult = {};
    let hasMessages = false;

    for (const { key: streamKey, id: startId } of streamArray) {
      
      if (!this.streams.has(streamKey)) {
        debugLog(`Stream '${streamKey}' does not exist`);
        continue;
      }

      
      const streamGroups = this.groups.get(streamKey);
      if (!streamGroups || !streamGroups.has(group)) {
        debugLog(`Group '${group}' does not exist for stream '${streamKey}'`);
        throw new Error(`NOGROUP No such consumer group '${group}' for stream '${streamKey}'`);
      }

      const groupState = streamGroups.get(group)!;
      const streamMessages = this.streams.get(streamKey)!;

      debugLog(`Stream '${streamKey}' has ${streamMessages.length} messages, group lastDeliveredId: ${groupState.lastDeliveredId}`);

      
      if (!groupState.consumers.has(consumer)) {
        groupState.consumers.set(consumer, new Set());
      }
      const pending = groupState.consumers.get(consumer)!;

      const messages: Message[] = [];

      
      if (startId === '>') {
        debugLog(`Reading new messages after ${groupState.lastDeliveredId}`);
        for (const msg of streamMessages) {
          if (this.compareIds(msg.id, groupState.lastDeliveredId) > 0) {
            debugLog(`Found new message: ${msg.id}`);
            messages.push({
              id: msg.id,
              fields: { ...msg.fields }
            });

            
            pending.add(msg.id);
            groupState.lastDeliveredId = msg.id;

            if (messages.length >= count) break;
          }
        }
      }
      
      else if (startId === '0') {
        for (const msg of streamMessages) {
          if (pending.has(msg.id)) {
            messages.push({
              id: msg.id,
              fields: { ...msg.fields }
            });

            if (messages.length >= count) break;
          }
        }
      }
      
      else {
        for (const msg of streamMessages) {
          if (this.compareIds(msg.id, startId) > 0) {
            messages.push({
              id: msg.id,
              fields: { ...msg.fields }
            });

            if (messages.length >= count) break;
          }
        }
      }

      if (messages.length > 0) {
        result[streamKey] = { messages };
        hasMessages = true;
        debugLog(`Returning ${messages.length} messages from stream '${streamKey}'`);
      } else {
        debugLog(`No messages found for stream '${streamKey}'`);
      }
    }

    
    if (!hasMessages && blockMs > 0) {
      debugLog(`No messages, blocking for ${blockMs}ms`);
      const waitResult = await this.waitForMessages(streamArray, blockMs);
      if (waitResult) {
        debugLog('New messages arrived, retrying read');
        
        return this.xReadGroup(group, consumer, streams, { ...options, BLOCK: 0 });
      } else {
        debugLog('Blocking timeout, no new messages');
      }
    }

    debugLog(`Returning ${hasMessages ? 'messages' : 'null'}`);
    return hasMessages ? result : null;
  }

  
  async xRead(
    streams: { key: string; id: string } | Array<{ key: string; id: string }>,
    options?: ReadOptions
  ): Promise<ReadResult | null> {
    const streamArray = Array.isArray(streams) ? streams : [streams];
    const count = options?.COUNT ?? 10;
    const blockMs = options?.BLOCK ?? 0;

    const result: ReadResult = {};
    let hasMessages = false;

    for (const { key: streamKey, id: startId } of streamArray) {
      if (!this.streams.has(streamKey)) {
        continue;
      }

      const streamMessages = this.streams.get(streamKey)!;
      const messages: Message[] = [];

      
      if (startId === '$') {
        
        continue;
      }

      for (const msg of streamMessages) {
        if (this.compareIds(msg.id, startId) > 0) {
          messages.push({
            id: msg.id,
            fields: { ...msg.fields }
          });

          if (messages.length >= count) break;
        }
      }

      if (messages.length > 0) {
        result[streamKey] = { messages };
        hasMessages = true;
      }
    }

    
    if (!hasMessages && blockMs > 0) {
      const waitResult = await this.waitForMessages(streamArray, blockMs);
      if (waitResult) {
        
        return this.xRead(streams, { ...options, BLOCK: 0 });
      }
    }

    return hasMessages ? result : null;
  }

  
  private waitForMessages(
    streams: Array<{ key: string; id: string }>,
    timeoutMs: number
  ): Promise<boolean> {
    return new Promise((resolve) => {
      const handlers: Array<() => void> = [];
      let resolved = false;

      const cleanup = () => {
        if (resolved) return;
        resolved = true;
        handlers.forEach(handler => {
          for (const { key } of streams) {
            this.emitter.removeListener(`stream:${key}`, handler);
          }
        });
      };

      const onMessage = () => {
        cleanup();
        resolve(true);
      };

      
      for (const { key } of streams) {
        this.emitter.once(`stream:${key}`, onMessage);
        handlers.push(onMessage);
      }

      
      setTimeout(() => {
        cleanup();
        resolve(false);
      }, timeoutMs);
    });
  }

  
  async xAck(stream: string, group: string, id: string): Promise<number> {
    const streamGroups = this.groups.get(stream);
    if (!streamGroups || !streamGroups.has(group)) {
      return 0;
    }

    const groupState = streamGroups.get(group)!;
    let acked = 0;

    
    for (const [_, pending] of groupState.consumers) {
      if (pending.has(id)) {
        pending.delete(id);
        acked++;
      }
    }

    return acked;
  }

  
  async xLen(stream: string): Promise<number> {
    const messages = this.streams.get(stream);
    return messages ? messages.length : 0;
  }

  
  async del(stream: string): Promise<number> {
    if (this.streams.has(stream)) {
      this.streams.delete(stream);
      this.groups.delete(stream);
      return 1;
    }
    return 0;
  }

  
  async xInfoGroups(stream: string): Promise<ConsumerGroup[]> {
    const streamGroups = this.groups.get(stream);
    if (!streamGroups) {
      return [];
    }

    const result: ConsumerGroup[] = [];
    for (const [name, state] of streamGroups) {
      let totalPending = 0;
      for (const pending of state.consumers.values()) {
        totalPending += pending.size;
      }

      result.push({
        name,
        consumers: state.consumers.size,
        pending: totalPending,
        lastDeliveredId: state.lastDeliveredId
      });
    }

    return result;
  }

  
  async xGroupDestroy(stream: string, group: string): Promise<boolean> {
    const streamGroups = this.groups.get(stream);
    if (!streamGroups || !streamGroups.has(group)) {
      return false;
    }

    streamGroups.delete(group);
    return true;
  }
}
