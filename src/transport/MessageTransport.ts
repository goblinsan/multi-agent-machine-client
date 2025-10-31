/**
 * Message Transport Abstraction
 * 
 * Provides a common interface for message passing between agents,
 * supporting both Redis Streams (distributed) and EventEmitter (local).
 * 
 * This enables:
 * - Lightweight local development without Redis
 * - Easier testing with in-memory transport
 * - Future support for other message brokers
 */

/**
 * Message data structure
 */
export interface Message {
  id: string;
  fields: Record<string, string>;
}

/**
 * Stream message with metadata
 */
export interface StreamMessage {
  messages: Message[];
}

/**
 * Result of reading from a stream
 */
export interface ReadResult {
  [streamKey: string]: StreamMessage;
}

/**
 * Consumer group information
 */
export interface ConsumerGroup {
  name: string;
  consumers: number;
  pending: number;
  lastDeliveredId: string;
}

/**
 * Subscription handle for unsubscribing
 */
export interface Subscription {
  unsubscribe(): void;
}

/**
 * Options for creating a consumer group
 */
export interface CreateGroupOptions {
  MKSTREAM?: boolean;
}

/**
 * Options for reading from a stream
 */
export interface ReadOptions {
  COUNT?: number;
  BLOCK?: number;
}

/**
 * Message Transport Interface
 * 
 * Abstraction over messaging systems (Redis Streams, EventEmitter, etc.)
 * Provides common patterns for publish/subscribe and consumer groups.
 */
export interface MessageTransport {
  /**
   * Connect to the transport
   */
  connect(): Promise<void>;

  /**
   * Disconnect from the transport
   */
  disconnect(): Promise<void>;

  /**
   * Publish a message to a stream
   * 
   * @param stream - Stream name
   * @param id - Message ID (use "*" for auto-generated)
   * @param fields - Message payload
   * @returns Message ID
   */
  xAdd(stream: string, id: string, fields: Record<string, string>): Promise<string>;

  /**
   * Create a consumer group for a stream
   * 
   * @param stream - Stream name
   * @param group - Consumer group name
   * @param startId - Starting message ID (e.g., "0", "$")
   * @param options - Creation options
   */
  xGroupCreate(stream: string, group: string, startId: string, options?: CreateGroupOptions): Promise<void>;

  /**
   * Read messages from a stream using consumer group
   * 
   * @param group - Consumer group name
   * @param consumer - Consumer ID within the group
   * @param streams - Stream(s) to read from with starting ID
   * @param options - Read options
   * @returns Messages or null if none available
   */
  xReadGroup(
    group: string,
    consumer: string,
    streams: { key: string; id: string } | Array<{ key: string; id: string }>,
    options?: ReadOptions
  ): Promise<ReadResult | null>;

  /**
   * Read messages from a stream (without consumer group)
   * 
   * @param streams - Stream(s) to read from with starting ID
   * @param options - Read options
   * @returns Messages or null if none available
   */
  xRead(
    streams: { key: string; id: string } | Array<{ key: string; id: string }>,
    options?: ReadOptions
  ): Promise<ReadResult | null>;

  /**
   * Acknowledge message processing
   * 
   * @param stream - Stream name
   * @param group - Consumer group name
   * @param id - Message ID to acknowledge
   * @returns Number of messages acknowledged
   */
  xAck(stream: string, group: string, id: string): Promise<number>;

  /**
   * Get stream length
   * 
   * @param stream - Stream name
   * @returns Number of messages in stream
   */
  xLen(stream: string): Promise<number>;

  /**
   * Delete a stream
   * 
   * @param stream - Stream name
   * @returns Number of keys removed (1 if stream existed, 0 otherwise)
   */
  del(stream: string): Promise<number>;

  /**
   * Get information about consumer groups
   * 
   * @param stream - Stream name
   * @returns Array of consumer group information
   */
  xInfoGroups(stream: string): Promise<ConsumerGroup[]>;

  /**
   * Destroy a consumer group
   * 
   * @param stream - Stream name
   * @param group - Consumer group name
   * @returns True if group was destroyed
   */
  xGroupDestroy(stream: string, group: string): Promise<boolean>;

  /**
   * Quit/close the transport connection
   */
  quit(): Promise<void>;
}
