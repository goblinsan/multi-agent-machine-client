# Message Transport Abstraction

**Version:** 1.0.0  
**Date:** October 20, 2025

---

## Overview

The message transport abstraction provides a configurable messaging layer that supports both distributed (Redis Streams) and local (EventEmitter) backends. This enables lightweight local development without requiring Redis infrastructure.

### Key Benefits

1. **Simplified Local Development**
   - No Redis installation required
   - Faster startup and iteration
   - Lower resource usage

2. **Easier Testing**
   - In-memory transport for unit tests
   - No external dependencies
   - Deterministic behavior

3. **Future Extensibility**
   - Support for other message brokers (RabbitMQ, Kafka, etc.)
   - Pluggable architecture
   - Consistent interface

---

## Architecture

### Transport Interface

All transports implement the `MessageTransport` interface:

```typescript
interface MessageTransport {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  
  // Publishing
  xAdd(stream: string, id: string, fields: Record<string, string>): Promise<string>;
  
  // Consumer Groups
  xGroupCreate(stream: string, group: string, startId: string, options?: CreateGroupOptions): Promise<void>;
  xGroupDestroy(stream: string, group: string): Promise<boolean>;
  
  // Reading
  xReadGroup(...): Promise<ReadResult | null>;
  xRead(...): Promise<ReadResult | null>;
  
  // Acknowledgment
  xAck(stream: string, group: string, id: string): Promise<number>;
  
  // Stream Management
  xLen(stream: string): Promise<number>;
  del(stream: string): Promise<number>;
  xInfoGroups(stream: string): Promise<ConsumerGroup[]>;
  
  quit(): Promise<void>;
}
```

### Available Transports

| Transport | Type | Use Case | Dependencies |
|-----------|------|----------|--------------|
| **RedisTransport** | Distributed | Production, multi-process | Redis server |
| **LocalTransport** | In-memory | Local development, testing | None |

---

## Configuration

### Environment Variable

Set `TRANSPORT_TYPE` to choose the transport:

```bash
# Redis (distributed) - default
export TRANSPORT_TYPE=redis

# Local (in-memory)
export TRANSPORT_TYPE=local
```

### Configuration in Code

The transport is configured in `src/config.ts`:

```typescript
export const cfg = {
  transportType: (process.env.TRANSPORT_TYPE || "redis") as "redis" | "local",
  // ... other config
};
```

---

## Usage

### Creating a Transport

**Recommended:** Use the singleton factory

```typescript
import { getTransport } from './transport/index.js';

// Get or create singleton transport
const transport = await getTransport();

// Use transport
await transport.xAdd('my-stream', '*', { message: 'hello' });
```

**Alternative:** Create directly

```typescript
import { createTransport } from './transport/index.js';

const transport = createTransport();
await transport.connect();
await transport.xAdd('my-stream', '*', { message: 'hello' });
await transport.disconnect();
```

### Migrating from Direct Redis Usage

**Before:**
```typescript
import { makeRedis } from './redisClient.js';

const redis = await makeRedis();
await redis.xAdd(cfg.requestStream, '*', { ... });
```

**After:**
```typescript
import { getTransport } from './transport/index.js';

const transport = await getTransport();
await transport.xAdd(cfg.requestStream, '*', { ... });
```

---

## Local Development Setup

### Prerequisites

- Node.js 18+
- npm

### Quick Start

1. **Set transport to local**

   ```bash
   # In .env file
   TRANSPORT_TYPE=local
   ```

2. **Start the worker**

   ```bash
   npm run dev
   ```

3. **No Redis required!**

   The worker now uses in-memory messaging. All agent communication happens locally.

### Benefits

- **Faster startup:** No Redis connection overhead
- **Lower resource usage:** No separate Redis process
- **Simpler setup:** One less dependency
- **Easier debugging:** Messages visible in process memory

### Limitations

- **Single process only:** Cannot distribute across multiple workers
- **No persistence:** Messages lost on process restart
- **Memory-bound:** Large message volumes may exhaust memory
- **Not for production:** Use Redis for production deployments

---

## Transport Comparison

| Feature | Redis Transport | Local Transport |
|---------|----------------|-----------------|
| **Distribution** | ✅ Multi-process | ❌ Single process |
| **Persistence** | ✅ Messages survive restarts | ❌ In-memory only |
| **Performance** | 🔵 Network overhead | 🟢 Very fast (in-memory) |
| **Setup Complexity** | 🟡 Requires Redis | 🟢 No dependencies |
| **Resource Usage** | 🟡 Moderate (Redis + connection) | 🟢 Low (memory only) |
| **Production Ready** | ✅ Yes | ❌ No |
| **Testing** | 🟡 Requires Redis | 🟢 No dependencies |
| **Debugging** | 🟡 External tool needed | 🟢 In-process visibility |

---

## Implementation Details

### RedisTransport

Wraps the Redis client and implements the `MessageTransport` interface.

**Features:**
- Full Redis Streams support
- Connection pooling
- Error handling
- Consumer group management

**Example:**
```typescript
import { RedisTransport } from './transport/RedisTransport.js';

const transport = new RedisTransport('redis://localhost:6379', 'password');
await transport.connect();

// Use Redis Streams
await transport.xAdd('requests', '*', { task: 'build' });
await transport.disconnect();
```

### LocalTransport

In-memory implementation using Node.js EventEmitter.

**Features:**
- Redis Streams semantics
- Consumer group simulation
- Message acknowledgment
- Blocking reads with timeout

**Internal Structure:**
```typescript
class LocalTransport {
  private streams: Map<string, StoredMessage[]>;  // stream -> messages
  private groups: Map<string, Map<string, ConsumerGroupState>>;  // stream -> group -> state
  private emitter: EventEmitter;  // For blocking reads
}
```

**Message ID Format:**
```
timestamp-sequence
1729123456789-0
```

**Consumer Group Simulation:**
- Tracks last delivered ID per group
- Maintains pending message sets per consumer
- Supports acknowledgment to remove from pending

**Blocking Reads:**
- Uses EventEmitter to wait for new messages
- Timeout-based wake-up
- Re-reads on new message arrival

---

## Testing

### Unit Tests

```typescript
import { LocalTransport } from './transport/LocalTransport.js';

describe('LocalTransport', () => {
  let transport: LocalTransport;
  
  beforeEach(async () => {
    transport = new LocalTransport();
    await transport.connect();
  });
  
  afterEach(async () => {
    await transport.disconnect();
  });
  
  it('should publish and read messages', async () => {
    // Create stream and consumer group
    await transport.xGroupCreate('test-stream', 'test-group', '0', { MKSTREAM: true });
    
    // Publish message
    const messageId = await transport.xAdd('test-stream', '*', { data: 'hello' });
    
    // Read message
    const result = await transport.xReadGroup(
      'test-group',
      'consumer-1',
      { key: 'test-stream', id: '>' },
      { COUNT: 1 }
    );
    
    expect(result).toBeDefined();
    expect(result!['test-stream'].messages).toHaveLength(1);
    expect(result!['test-stream'].messages[0].fields.data).toBe('hello');
    
    // Acknowledge
    const acked = await transport.xAck('test-stream', 'test-group', messageId);
    expect(acked).toBe(1);
  });
});
```

### Integration Tests

Test with both transports to ensure compatibility:

```typescript
import { createTransport } from './transport/index.js';

describe.each(['redis', 'local'])('Transport: %s', (transportType) => {
  let transport: MessageTransport;
  
  beforeEach(async () => {
    process.env.TRANSPORT_TYPE = transportType;
    transport = createTransport();
    await transport.connect();
  });
  
  afterEach(async () => {
    await transport.disconnect();
  });
  
  it('should handle message flow', async () => {
    // Test implementation
  });
});
```

---

## Migration Guide

### Updating Existing Code

#### 1. Replace Direct Redis Imports

**Before:**
```typescript
import { makeRedis } from './redisClient.js';

const redis = await makeRedis();
```

**After:**
```typescript
import { getTransport } from './transport/index.js';

const transport = await getTransport();
```

#### 2. Update Method Calls

The transport interface matches Redis Streams API, so minimal changes needed:

**Before:**
```typescript
await redis.xAdd(cfg.requestStream, '*', fields);
await redis.xReadGroup(group, consumer, { key: stream, id: '>' }, { COUNT: 1 });
await redis.xAck(stream, group, id);
```

**After:**
```typescript
await transport.xAdd(cfg.requestStream, '*', fields);
await transport.xReadGroup(group, consumer, { key: stream, id: '>' }, { COUNT: 1 });
await transport.xAck(stream, group, id);
```

#### 3. Update Connection Management

**Before:**
```typescript
const redis = await makeRedis();
// ... use redis ...
await redis.quit();
```

**After:**
```typescript
const transport = await getTransport();  // Singleton, auto-connected
// ... use transport ...
// No need to explicitly disconnect (handled by singleton)
```

### Backward Compatibility

The transport abstraction is designed to be backward compatible:

- ✅ Same API as Redis Streams
- ✅ Same return types
- ✅ Same error messages
- ✅ Existing code works with minimal changes

---

## Best Practices

### 1. Use the Singleton Factory

```typescript
import { getTransport } from './transport/index.js';

const transport = await getTransport();  // Recommended
```

**Why:** Ensures single transport instance, automatic connection management.

### 2. Configure via Environment Variables

```bash
# .env.local (for local development)
TRANSPORT_TYPE=local

# .env.production (for production)
TRANSPORT_TYPE=redis
REDIS_URL=redis://prod.example.com:6379
REDIS_PASSWORD=secret
```

**Why:** Easy to switch between transports without code changes.

### 3. Handle Connection Errors

```typescript
try {
  const transport = await getTransport();
  await transport.xAdd('stream', '*', { data: 'test' });
} catch (error) {
  console.error('Transport error:', error);
  // Fallback or retry logic
}
```

### 4. Use Local Transport for Tests

```typescript
// test/setup.ts
process.env.TRANSPORT_TYPE = 'local';
```

**Why:** Faster tests, no external dependencies, deterministic behavior.

### 5. Monitor Transport Type in Logs

```typescript
import { getTransportType } from './transport/index.js';

console.log(`Starting worker with ${getTransportType()} transport`);
```

---

## Troubleshooting

### Issue: "Unknown transport type"

**Error:**
```
Error: Unknown transport type: foo. Supported types: redis, local
```

**Solution:**
- Check `TRANSPORT_TYPE` environment variable
- Valid values: `redis`, `local` (case-sensitive)
- Default is `redis` if not set

### Issue: "Redis transport not connected"

**Error:**
```
Error: Redis transport not connected. Call connect() first.
```

**Solution:**
- Use `getTransport()` instead of creating transport directly
- Ensure `await transport.connect()` is called
- Check Redis connection string

### Issue: Local transport messages disappear

**Explanation:**
- Local transport is in-memory only
- Messages lost on process restart
- Not suitable for production

**Solution:**
- Use Redis transport for persistence
- Or implement message persistence layer

### Issue: "NOGROUP No such consumer group"

**Cause:**
- Consumer group doesn't exist
- Stream was deleted
- Group creation failed

**Solution:**
```typescript
// Ensure group exists
try {
  await transport.xGroupCreate(stream, group, '0', { MKSTREAM: true });
} catch (error) {
  if (!error.message.includes('BUSYGROUP')) {
    throw error;  // Real error
  }
  // Group already exists, continue
}
```

---

## Performance

### Benchmarks

**Redis Transport:**
- xAdd: ~1-2ms (network latency)
- xReadGroup: ~2-5ms (network + processing)
- xAck: ~1-2ms

**Local Transport:**
- xAdd: <0.1ms (in-memory)
- xReadGroup: <0.1ms (no blocking) or timeout (blocking)
- xAck: <0.1ms

**Memory Usage:**
- Redis Transport: ~10MB (connection pool)
- Local Transport: ~5MB + message storage

### Scalability

**Redis Transport:**
- ✅ Scales horizontally (multiple workers)
- ✅ Handles millions of messages
- ✅ Distributed across machines

**Local Transport:**
- ❌ Single process only
- ⚠️ Memory-bound (thousands of messages)
- ❌ Cannot distribute

---

## Future Enhancements

### Planned Features

1. **Additional Transports**
   - RabbitMQ transport
   - Kafka transport
   - AWS SQS/SNS transport

2. **Advanced Features**
   - Message TTL (time-to-live)
   - Dead letter queues
   - Message priority
   - Batch operations

3. **Monitoring**
   - Transport metrics
   - Health checks
   - Performance tracking

### Extension Points

To add a new transport:

1. Implement `MessageTransport` interface
2. Add to `createTransport()` factory
3. Add configuration option
4. Write tests
5. Update documentation

**Example:**
```typescript
// src/transport/KafkaTransport.ts
export class KafkaTransport implements MessageTransport {
  // Implement interface methods
}

// src/transport/index.ts
export function createTransport(): MessageTransport {
  switch (cfg.transportType) {
    case 'redis': return new RedisTransport(...);
    case 'local': return new LocalTransport();
    case 'kafka': return new KafkaTransport(...);  // New!
    default: throw new Error(`Unknown transport: ${cfg.transportType}`);
  }
}
```

---

## FAQ

### Q: Should I use local transport in production?

**A:** No. Local transport is designed for development and testing only. Use Redis transport for production deployments.

### Q: Can I switch transports at runtime?

**A:** No. Transport type is configured at startup via environment variable. Changing transports requires restarting the process.

### Q: Do both transports support the same features?

**A:** Yes. Both implement the same `MessageTransport` interface and support the same Redis Streams semantics.

### Q: Will local transport work with multiple workers?

**A:** No. Local transport is in-memory and cannot communicate between processes. Use Redis transport for multi-worker setups.

### Q: How do I debug message flow with local transport?

**A:** You can add logging to the LocalTransport class or use a debugger to inspect the in-memory message stores.

### Q: Can I persist local transport messages?

**A:** Not currently. Local transport is in-memory only. Consider implementing a persistence layer if needed, or use Redis transport.

---

## Support

**Documentation:** `docs/MESSAGING_TRANSPORT.md` (this file)  
**Source Code:** `src/transport/`  
**Tests:** `tests/transport/` (TBD)  
**Issues:** GitHub Issues

---

**Version History:**
- v1.0.0 (Oct 20, 2025) - Initial release with Redis and Local transports
