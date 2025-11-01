

import { createClient, RedisClientType } from 'redis';
import {
  MessageTransport,
  ReadResult,
  ConsumerGroup,
  CreateGroupOptions,
  ReadOptions
} from './MessageTransport.js';


export class RedisTransport implements MessageTransport {
  private client: RedisClientType | null = null;
  private url: string;
  private password?: string;

  constructor(url: string, password?: string) {
    this.url = url;
    this.password = password;
  }

  async connect(): Promise<void> {
    if (this.client) {
      return;
    }

    this.client = createClient({
      url: this.url,
      password: this.password
    }) as RedisClientType;

    await this.client.connect();
  }

  async disconnect(): Promise<void> {
    if (this.client) {
      await this.client.disconnect();
      this.client = null;
    }
  }

  async quit(): Promise<void> {
    if (this.client) {
      await this.client.quit();
      this.client = null;
    }
  }

  private ensureConnected(): RedisClientType {
    if (!this.client) {
      throw new Error('Redis transport not connected. Call connect() first.');
    }
    return this.client;
  }

  async xAdd(stream: string, id: string, fields: Record<string, string>): Promise<string> {
    const client = this.ensureConnected();
    return await client.xAdd(stream, id, fields);
  }

  async xGroupCreate(
    stream: string,
    group: string,
    startId: string,
    options?: CreateGroupOptions
  ): Promise<void> {
    const client = this.ensureConnected();
    const redisOptions: any = {};
    if (options?.MKSTREAM) {
      redisOptions.MKSTREAM = true;
    }
    await client.xGroupCreate(stream, group, startId, redisOptions);
  }

  async xReadGroup(
    group: string,
    consumer: string,
    streams: { key: string; id: string } | Array<{ key: string; id: string }>,
    options?: ReadOptions
  ): Promise<ReadResult | null> {
    const client = this.ensureConnected();
    const result = await client.xReadGroup(group, consumer, streams, options);
    return result as ReadResult | null;
  }

  async xRead(
    streams: { key: string; id: string } | Array<{ key: string; id: string }>,
    options?: ReadOptions
  ): Promise<ReadResult | null> {
    const client = this.ensureConnected();
    const result = await client.xRead(streams, options);
    return result as ReadResult | null;
  }

  async xAck(stream: string, group: string, id: string): Promise<number> {
    const client = this.ensureConnected();
    return await client.xAck(stream, group, id);
  }

  async xLen(stream: string): Promise<number> {
    const client = this.ensureConnected();
    return await client.xLen(stream);
  }

  async del(stream: string): Promise<number> {
    const client = this.ensureConnected();
    return await client.del(stream);
  }

  async xInfoGroups(stream: string): Promise<ConsumerGroup[]> {
    const client = this.ensureConnected();
    const groups = await client.xInfoGroups(stream);
    
    return groups.map((g: any) => ({
      name: g.name,
      consumers: g.consumers,
      pending: g.pending,
      lastDeliveredId: g['last-delivered-id']
    }));
  }

  async xGroupDestroy(stream: string, group: string): Promise<boolean> {
    const client = this.ensureConnected();
    const result = await client.xGroupDestroy(stream, group);
    
    return Boolean(result);
  }

  
  getClient(): RedisClientType {
    return this.ensureConnected();
  }
}
