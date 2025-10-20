/**
 * Local Message Transport
 * 
 * In-memory message transport using Node.js EventEmitter.
 * Simulates Redis Streams behavior for local development and testing.
 * 
 * Features:
 * - In-memory message queuing
 * - Consumer group simulation
 * - Message acknowledgment tracking
 * - No external dependencies (Redis not required)
 * 
 * Limitations:
 * - Not distributed (single process only)
 * - Messages lost on process restart
 * - Not suitable for production
 */

import { EventEmitter } from 'events';
import { randomUUID } from 'crypto';
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
  consumers: Map<string, Set<string>>;  // consumer -> pending message IDs
}

/**
 * Local in-memory transport using EventEmitter
 */
export class LocalTransport implements MessageTransport {
  private emitter: EventEmitter;
  private streams: Map<string, StoredMessage[]>;  // stream -> messages
  private groups: Map<string, Map<string, ConsumerGroupState>>;  // stream -> group -> state
  private messageIdCounter: number = 0;
  private connected: boolean = false;

  constructor() {
    this.emitter = new EventEmitter();
    this.emitter.setMaxListeners(100);  // Support many listeners
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

  /**
   * Generate a Redis-like stream ID
   * Format: timestamp-sequence (e.g., "1729123456789-0")
   */
  private generateId(): string {
    const timestamp = Date.now();
    const sequence = this.messageIdCounter++;
    return `${timestamp}-${sequence}`;
  }

  /**
   * Compare two stream IDs
   * Returns: -1 if a < b, 0 if equal, 1 if a > b
   */
  private compareIds(a: string, b: string): number {
    if (a === b) return 0;
    
    const [aTime, aSeq] = a.split('-').map(Number);
    const [bTime, bSeq] = b.split('-').map(Number);
    
    if (aTime !== bTime) return aTime < bTime ? -1 : 1;
    return aSeq < bSeq ? -1 : 1;
  }

  /**
   * Add a message to a stream
   */
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

    // Emit event for new message (for xRead listeners)
    this.emitter.emit(`stream:${stream}`, message);

    return messageId;
  }

  /**
   * Create a consumer group
   */
  async xGroupCreate(
    stream: string,
    group: string,
    startId: string,
    options?: CreateGroupOptions
  ): Promise<void> {
    // Create stream if requested and doesn't exist
    if (options?.MKSTREAM && !this.streams.has(stream)) {
      this.streams.set(stream, []);
    }

    // Check if stream exists
    if (!this.streams.has(stream)) {
      throw new Error(`ERR no such key`);
    }

    // Check if group already exists
    if (!this.groups.has(stream)) {
      this.groups.set(stream, new Map());
    }

    const streamGroups = this.groups.get(stream)!;
    if (streamGroups.has(group)) {
      throw new Error(`BUSYGROUP Consumer Group name already exists`);
    }

    // Create the group
    streamGroups.set(group, {
      name: group,
      lastDeliveredId: startId,
      consumers: new Map()
    });
  }

  /**
   * Read messages from a stream using consumer group
   */
  async xReadGroup(
    group: string,
    consumer: string,
    streams: { key: string; id: string } | Array<{ key: string; id: string }>,
    options?: ReadOptions
  ): Promise<ReadResult | null> {
    const streamArray = Array.isArray(streams) ? streams : [streams];
    const count = options?.COUNT ?? 10;
    const blockMs = options?.BLOCK ?? 0;

    const result: ReadResult = {};
    let hasMessages = false;

    for (const { key: streamKey, id: startId } of streamArray) {
      // Check if stream exists
      if (!this.streams.has(streamKey)) {
        continue;
      }

      // Check if group exists
      const streamGroups = this.groups.get(streamKey);
      if (!streamGroups || !streamGroups.has(group)) {
        throw new Error(`NOGROUP No such consumer group '${group}' for stream '${streamKey}'`);
      }

      const groupState = streamGroups.get(group)!;
      const streamMessages = this.streams.get(streamKey)!;

      // Get consumer's pending messages set
      if (!groupState.consumers.has(consumer)) {
        groupState.consumers.set(consumer, new Set());
      }
      const pending = groupState.consumers.get(consumer)!;

      const messages: Message[] = [];

      // Read new messages (id = ">")
      if (startId === '>') {
        for (const msg of streamMessages) {
          if (this.compareIds(msg.id, groupState.lastDeliveredId) > 0) {
            messages.push({
              id: msg.id,
              fields: { ...msg.fields }
            });

            // Mark as pending for this consumer
            pending.add(msg.id);
            groupState.lastDeliveredId = msg.id;

            if (messages.length >= count) break;
          }
        }
      }
      // Read pending messages for this consumer (id = "0")
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
      // Read from specific ID
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
      }
    }

    // If blocking and no messages, wait for new messages
    if (!hasMessages && blockMs > 0) {
      const waitResult = await this.waitForMessages(streamArray, blockMs);
      if (waitResult) {
        // Retry the read after new messages arrived
        return this.xReadGroup(group, consumer, streams, { ...options, BLOCK: 0 });
      }
    }

    return hasMessages ? result : null;
  }

  /**
   * Read messages from a stream (without consumer group)
   */
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

      // Special ID "$" means only new messages from now
      if (startId === '$') {
        // Don't return existing messages, only wait for new ones
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

    // If blocking and no messages, wait for new messages
    if (!hasMessages && blockMs > 0) {
      const waitResult = await this.waitForMessages(streamArray, blockMs);
      if (waitResult) {
        // Retry the read after new messages arrived
        return this.xRead(streams, { ...options, BLOCK: 0 });
      }
    }

    return hasMessages ? result : null;
  }

  /**
   * Wait for new messages on any of the specified streams
   */
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

      // Listen for messages on all streams
      for (const { key } of streams) {
        this.emitter.once(`stream:${key}`, onMessage);
        handlers.push(onMessage);
      }

      // Timeout
      setTimeout(() => {
        cleanup();
        resolve(false);
      }, timeoutMs);
    });
  }

  /**
   * Acknowledge message processing
   */
  async xAck(stream: string, group: string, id: string): Promise<number> {
    const streamGroups = this.groups.get(stream);
    if (!streamGroups || !streamGroups.has(group)) {
      return 0;
    }

    const groupState = streamGroups.get(group)!;
    let acked = 0;

    // Remove from all consumers' pending sets
    for (const [_, pending] of groupState.consumers) {
      if (pending.has(id)) {
        pending.delete(id);
        acked++;
      }
    }

    return acked;
  }

  /**
   * Get stream length
   */
  async xLen(stream: string): Promise<number> {
    const messages = this.streams.get(stream);
    return messages ? messages.length : 0;
  }

  /**
   * Delete a stream
   */
  async del(stream: string): Promise<number> {
    if (this.streams.has(stream)) {
      this.streams.delete(stream);
      this.groups.delete(stream);
      return 1;
    }
    return 0;
  }

  /**
   * Get information about consumer groups
   */
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

  /**
   * Destroy a consumer group
   */
  async xGroupDestroy(stream: string, group: string): Promise<boolean> {
    const streamGroups = this.groups.get(stream);
    if (!streamGroups || !streamGroups.has(group)) {
      return false;
    }

    streamGroups.delete(group);
    return true;
  }
}
