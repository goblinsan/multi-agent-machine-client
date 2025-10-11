# Redis Stream Management: Drain vs Nuke

## Problem
The original `--drain-only` flag was too aggressive - it destroyed consumer groups in addition to clearing messages. This meant that after draining, workers couldn't receive new messages until they were restarted (so `ensureGroups()` could recreate the groups).

## Solution
Split the functionality into two distinct operations with clear semantics:

### `--drain-only` (Gentle)
**Use case**: Quick cleanup during development, testing workflow changes

**What it does**:
- Deletes the stream (clears all messages)
- **Preserves consumer groups**
- Stream will be auto-recreated when new messages arrive or when worker calls MKSTREAM

**After drain**:
- Workers continue functioning normally
- Consumer groups remain intact
- No restart required

**Command**:
```bash
npm run coordinator -- --drain-only
```

### `--nuke` (Nuclear)
**Use case**: Complete reset, debugging consumer group issues, starting fresh

**What it does**:
- Destroys all consumer groups (removes pending message associations)
- Deletes the streams (clears all messages)
- Removes persona-specific groups
- Removes coordinator group

**After nuke**:
- Workers need to recreate consumer groups
- Our worker code now auto-detects missing groups and recreates them (see NOGROUP error handling)
- No manual intervention required

**Command**:
```bash
npm run coordinator -- --nuke
```

## Worker Resilience

The worker now handles missing consumer groups gracefully:

```typescript
// In readOne():
const res = await r.xReadGroup(...).catch(async (e: any) => {
  // If consumer group doesn't exist (e.g., after --nuke), recreate it
  if (e?.message && e.message.includes("NOGROUP")) {
    logger.info("consumer group missing, recreating", { persona, group });
    await r.xGroupCreate(cfg.requestStream, groupForPersona(persona), "0", { MKSTREAM: true });
    // Retry the read after creating the group
    return await r.xReadGroup(...);
  }
  return null;
});
```

This means:
- If you run `--nuke`, workers will automatically recreate their consumer groups
- No need to restart workers after nuking
- Self-healing system

## Usage Examples

### Development workflow
```bash
# Clear messages, keep infrastructure
npm run coordinator -- --drain-only

# Send new test message
npm run coordinator -- PROJECT_ID
```

### Complete reset
```bash
# Destroy everything
npm run coordinator -- --nuke

# Workers automatically recreate groups on next read attempt
# No restart needed!
```

### Before dispatching a workflow
```bash
# Clear old messages, then send new one
npm run coordinator -- --drain PROJECT_ID
```

## Technical Details

### Why drain doesn't need to destroy groups

Redis consumer groups track:
1. **Pending Entry List (PEL)**: Messages delivered but not ACKed
2. **Last delivered ID**: Position in stream

When you delete a stream:
- PEL becomes irrelevant (no messages exist)
- Last delivered ID resets when stream is recreated
- Groups can continue functioning with the new stream

Consumer groups are **metadata about stream consumption**, not the messages themselves. Deleting messages doesn't require destroying the metadata.

### Why nuke destroys groups

Use `--nuke` when you want to:
- Reset consumer positions completely
- Clear any stuck pending messages
- Force a complete fresh start
- Debug consumer group state issues

## Changes Made

1. **run_coordinator.ts**:
   - Split `drainStreams()` into two functions:
     - `drainStreams()`: Just deletes streams (messages only)
     - `nukeStreams()`: Original behavior (destroy everything)
   - Added `--nuke` flag
   - Updated usage documentation

2. **worker.ts**:
   - Added NOGROUP error detection in `readOne()`
   - Auto-recreates missing consumer groups
   - Retries read operation after recreation
   - Logs group recreation for visibility

## Benefits

✅ **Faster development cycle**: Quick drain without breaking workers
✅ **Clear intent**: Drain = messages, Nuke = everything
✅ **Self-healing**: Workers automatically recover from missing groups
✅ **No downtime**: Workers don't need restart after drain or nuke
✅ **Better debugging**: Know exactly what each operation does
