# Redis Message Reliability Fix

## Problem Summary

The distributed multi-agent system was experiencing message delivery reliability issues:
1. **Missed messages**: Coordinator had to send initial messages twice before workers picked them up
2. **Race condition**: Messages sent immediately after worker startup were being lost
3. **High polling overhead**: Worker was aggressively polling Redis every 200ms

## Root Causes

### 1. Consumer Group Position Race Condition
**File**: `src/worker.ts` - `ensureGroups()` function

**Issue**: Consumer groups were created with position `$` (dollar sign), which means "only read messages added AFTER the group is created". This created a timing window where:
- Worker starts and creates consumer group at position `$`
- Coordinator sends message
- If the message arrives during group creation, it's positioned BEFORE `$` and never read
- Worker only sees messages that arrive AFTER it finishes initialization

**Fix**: Changed consumer group creation to start from position `0`:
```typescript
await r.xGroupCreate(cfg.requestStream, groupForPersona(p), "0", { MKSTREAM: true });
```

This ensures the group reads all messages in the stream, including those added before the worker started.

### 2. Aggressive Polling
**File**: `src/worker.ts` - `readOne()` function

**Issue**: The worker was using `BLOCK: 200` (200 milliseconds), causing it to:
- Poll Redis 5 times per second per persona
- Return quickly even when no messages exist
- Create unnecessary network traffic and CPU usage

**Fix**: Increased BLOCK timeout to 5000ms (5 seconds):
```typescript
const res = await r.xReadGroup(..., { COUNT: 1, BLOCK: 5000 })
```

**Note**: Redis returns immediately when messages are available, so this doesn't add latency - it only reduces polling frequency when the queue is empty.

### 3. Missing Connection Validation
**File**: `src/worker.ts` - `main()` function

**Issue**: Worker started processing without verifying Redis connection was fully established.

**Fix**: Added explicit connection check:
```typescript
await r.ping();
logger.info("redis connection established", { url: cfg.redisUrl.replace(/:[^:@]+@/, ':***@') });
```

This ensures the worker only starts after Redis is ready.

## Changes Made

### 1. `src/worker.ts`
- **ensureGroups()**: Changed consumer group start position from `$` to `0`
- **ensureGroups()**: Added debug logging and better error handling
- **readOne()**: Increased BLOCK timeout from 200ms to 5000ms
- **main()**: Added Redis connection validation with ping before starting worker loop

### 2. `src/tools/run_coordinator.ts`
- **drainStreams()**: Added comment explaining drain behavior with new consumer group position

## Drain Functionality Preserved

The `--drain-only` flag continues to work correctly:

1. `drainStreams()` destroys all consumer groups
2. `drainStreams()` deletes the entire stream (removes all messages)
3. When workers restart, they call `ensureGroups()`
4. New groups are created from position `0`
5. Since stream is empty after drain, position `0` is effectively empty
6. This achieves clean slate behavior as intended

## Testing

All existing tests pass (106 tests passed):
```bash
npm test
# Test Files  28 passed | 1 skipped (29)
# Tests  106 passed | 3 skipped (109)
```

## Benefits

1. **Reliable message delivery**: Messages are no longer missed during worker initialization
2. **Reduced polling overhead**: 5-second BLOCK reduces Redis calls by 96% when idle
3. **Better error visibility**: Connection failures are logged clearly
4. **No breaking changes**: All existing tests pass
5. **Drain functionality preserved**: `--drain-only` continues to work as expected

## Migration Notes

**No action required** - changes are backward compatible:
- Existing consumer groups will continue to work
- If you want fresh groups with the new behavior, use `--drain-only`:
  ```bash
  npm run coordinator -- --drain-only
  ```

## Monitoring

Watch for these log entries to confirm proper operation:

**Worker startup**:
```
[info] redis connection established { url: 'redis://...' }
[debug] created consumer group { stream: '...', group: '...', startFrom: '0' }
[info] worker ready { personas: [...] }
```

**Message processing** (verbose, only when messages arrive):
```
[info] processing request { persona: 'coordination', workflowId: '...' }
```

## Technical Details

### Redis Streams & Consumer Groups

Redis Streams provide a log-like data structure where:
- Messages have unique IDs (timestamp-based)
- Consumer groups track which messages each consumer has processed
- The `>` symbol means "give me new messages I haven't seen"
- Creating a group at position `0` means "start from the beginning of the stream"
- Creating a group at position `$` means "start from the end (only new messages)"

### Why This Fix Works

The issue was essentially a race condition:

**Before (position `$`)**:
```
Time 0: Stream is empty
Time 1: Worker creates group at position $ (end of stream)
Time 2: Coordinator adds message at position 123-0
Time 3: Worker reads with >, but $ was set at Time 1, so 123-0 is before $
Time 4: Message is never delivered
```

**After (position `0`)**:
```
Time 0: Stream is empty  
Time 1: Worker creates group at position 0 (beginning)
Time 2: Coordinator adds message at position 123-0
Time 3: Worker reads with >, position 0 < 123-0, so message is delivered
Time 4: Success!
```

## Future Enhancements

Consider these potential improvements:
1. Add Redis connection retry logic with exponential backoff
2. Implement consumer heartbeat monitoring
3. Add metrics for message processing latency
4. Consider dead-letter queue for failed messages
