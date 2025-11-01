export interface Message {
  id: string;
  fields: Record<string, string>;
}

export interface StreamMessage {
  messages: Message[];
}

export interface ReadResult {
  [streamKey: string]: StreamMessage;
}

export interface ConsumerGroup {
  name: string;
  consumers: number;
  pending: number;
  lastDeliveredId: string;
}

export interface Subscription {
  unsubscribe(): void;
}

export interface CreateGroupOptions {
  MKSTREAM?: boolean;
}

export interface ReadOptions {
  COUNT?: number;
  BLOCK?: number;
}

export interface MessageTransport {
  connect(): Promise<void>;

  disconnect(): Promise<void>;

  xAdd(
    stream: string,
    id: string,
    fields: Record<string, string>,
  ): Promise<string>;

  xGroupCreate(
    stream: string,
    group: string,
    startId: string,
    options?: CreateGroupOptions,
  ): Promise<void>;

  xReadGroup(
    group: string,
    consumer: string,
    streams: { key: string; id: string } | Array<{ key: string; id: string }>,
    options?: ReadOptions,
  ): Promise<ReadResult | null>;

  xRead(
    streams: { key: string; id: string } | Array<{ key: string; id: string }>,
    options?: ReadOptions,
  ): Promise<ReadResult | null>;

  xAck(stream: string, group: string, id: string): Promise<number>;

  xLen(stream: string): Promise<number>;

  del(stream: string): Promise<number>;

  xInfoGroups(stream: string): Promise<ConsumerGroup[]>;

  xGroupDestroy(stream: string, group: string): Promise<boolean>;

  quit(): Promise<void>;
}
