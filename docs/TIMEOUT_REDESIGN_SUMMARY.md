# Timeout and Retry System Redesign - Summary

## Overview

Redesigned the timeout and retry-backoff logic to support distributed persona workers with flexible, per-persona configuration, progressive backoff, duplicate detection, and comprehensive workflow abortion diagnostics.

## Changes Implemented

### 1. Schema Updates (`src/schema.ts`)

#### Added Fields
- **`task_id`**: Optional field in both RequestSchema and EventSchema for duplicate tracking
- **`duplicate_response`**: New status enum value for EventSchema

#### Purpose
- Enable duplicate message detection across distributed workers
- Track which task a message belongs to for proper correlation

### 2. Configuration System (`src/config.ts`)

#### New Functions
- `parsePersonaMaxRetries()`: Parse per-persona max retry configuration from JSON
  - Supports numeric values and "unlimited" keyword
  - Returns `null` for unlimited retries

#### New Configuration Variables
- `personaMaxRetries`: Map of persona → max retries (or null for unlimited)
- `personaDefaultMaxRetries`: Default max retries (3)
- `personaRetryBackoffIncrementMs`: Progressive backoff increment (30s default)
- `personaDefaultTimeoutMs`: Changed default from 10min to 1min

#### Environment Variables
```bash
PERSONA_TIMEOUTS_JSON='{"persona":"duration",...}'
PERSONA_MAX_RETRIES_JSON='{"persona":number|"unlimited",...}'
PERSONA_DEFAULT_TIMEOUT_MS=60000
PERSONA_DEFAULT_MAX_RETRIES=3
PERSONA_RETRY_BACKOFF_INCREMENT_MS=30000
```

#### Legacy Support
Maintained backward compatibility with:
- `PERSONA_TIMEOUT_MAX_RETRIES`
- `PERSONA_CODING_TIMEOUT_MS`
- `COORDINATOR_WAIT_TIMEOUT_MS`

### 3. Utility Functions (`src/util.ts`)

#### New Functions

**`personaMaxRetries(persona, cfg)`**
- Returns max retries for a persona (null if unlimited)
- Checks per-persona config, then falls back to default
- Used by PersonaRequestStep to determine retry behavior

**`calculateProgressiveTimeout(baseTimeoutMs, attemptNumber, backoffIncrementMs)`**
- Calculates timeout for specific retry attempt
- Formula: `baseTimeout + (attemptNumber - 1) * backoffIncrement`
- Example: 60s base → 60s, 90s, 120s, 150s...
- No artificial delays between attempts

### 4. Duplicate Detection System (`src/messageTracking.ts`) - NEW FILE

#### Core Functions
- `isDuplicateMessage(taskId, corrId, persona)`: Check if message already processed
- `markMessageProcessed(taskId, corrId, persona, workflowId)`: Mark message as handled
- `startMessageTrackingCleanup()`: Auto-cleanup every hour
- `clearMessageTracking()`: Clear all records (for testing)

#### Features
- In-memory storage with 24-hour TTL
- Automatic hourly cleanup of expired records
- Key format: `taskId:corrId:persona`
- Handles missing taskId/corrId gracefully

### 5. Worker Updates (`src/worker.ts`)

#### Duplicate Detection Integration
- Check for duplicates before processing
- Send `duplicate_response` event if duplicate detected
- Mark messages as processed after validation
- Start message tracking cleanup on startup

#### Task ID Propagation
- Extract `task_id` from request messages
- Include in all logging
- Pass through to persona processing

### 6. Persona Agent Updates (`src/agents/persona.ts`)

#### sendPersonaRequest Updates
- Added `taskId` parameter
- Include `task_id` in request message
- Properly structured for distributed coordination

### 7. PersonaRequestStep Redesign (`src/workflows/steps/PersonaRequestStep.ts`)

#### Progressive Timeout Implementation
- Calculate timeout per attempt using `calculateProgressiveTimeout()`
- No fixed backoff delays - timeout increases progressively
- Log current and next timeout values for transparency

#### Retry Logic Changes
- Support unlimited retries when `maxRetries === null`
- Use `personaMaxRetries()` and `personaTimeoutMs()` for config
- Extract `task_id` from payload or context
- Pass `task_id` to `sendPersonaRequest()`

#### Enhanced Logging
- Log base timeout, max retries, and backoff increment on start
- Log progressive timeout values during retries
- Show "unlimited" when retries are unlimited

#### Diagnostic Error Messages
When all retries exhausted:
```json
{
  "msg": "Persona request failed after exhausting all retries - WORKFLOW WILL ABORT",
  "totalAttempts": 4,
  "baseTimeoutMs": 60000,
  "finalTimeoutMs": 150000,
  "diagnostics": {
    "reason": "All retry attempts exhausted without successful completion",
    "recommendation": "Check persona availability, LM Studio status, and increase timeout/retries if needed",
    "configKeys": ["PERSONA_TIMEOUTS_JSON", "PERSONA_MAX_RETRIES_JSON", ...]
  }
}
```

Error message includes:
- Base and final timeout in minutes
- Total attempts
- `workflowAborted: true` flag in data
- Helpful troubleshooting information

### 8. Process Updates (`src/process.ts`)

#### Event Message Updates
- Include `task_id` in all event messages
- Extract from request message
- Pass through in completion events

### 9. Documentation

#### New Files
- `docs/PERSONA_TIMEOUT_RETRY_SYSTEM.md`: Comprehensive guide (700+ lines)
- `.env.example.timeout-retry`: Configuration examples

#### Content Includes
- Configuration reference
- Progressive backoff explanation
- Duplicate detection details
- Migration guide
- Troubleshooting section
- API reference
- Example logs
- Best practices

## Key Behavior Changes

### 1. Progressive Backoff (No Delays)

**Old System**:
```
Attempt 1: 60s timeout
Wait 30s
Attempt 2: 60s timeout
Wait 60s
Attempt 3: 60s timeout
Wait 90s
Attempt 4: 60s timeout
```

**New System**:
```
Attempt 1: 60s timeout
Attempt 2: 90s timeout (immediate retry)
Attempt 3: 120s timeout (immediate retry)
Attempt 4: 150s timeout (immediate retry)
```

**Benefits**:
- Faster overall completion when persona eventually responds
- Better for distributed systems with variable load
- No artificial waiting - timeout adapts to system conditions

### 2. Per-Persona Configuration

**Old**: Global timeouts with some persona-specific overrides
**New**: Full per-persona control via JSON maps

### 3. Unlimited Retries Support

**Old**: Fixed maximum retry count
**New**: Can configure unlimited retries per persona

### 4. Duplicate Detection

**Old**: No duplicate detection - duplicates processed multiple times
**New**: Automatic duplicate detection with `duplicate_response` status

### 5. Workflow Behavior

**Old**: Workflows could timeout at engine level
**New**: Workflows never timeout - only abort when persona retries exhausted

## Configuration Migration

### Old Configuration
```bash
PERSONA_TIMEOUT_MAX_RETRIES=3
COORDINATOR_WAIT_TIMEOUT_MS=600000
PERSONA_CODING_TIMEOUT_MS=180000
```

### New Configuration
```bash
# Defaults
PERSONA_DEFAULT_TIMEOUT_MS=60000
PERSONA_DEFAULT_MAX_RETRIES=3
PERSONA_RETRY_BACKOFF_INCREMENT_MS=30000

# Per-persona overrides
PERSONA_TIMEOUTS_JSON='{"lead-engineer":"3m","context":"1m","qa-engineer":"2m"}'
PERSONA_MAX_RETRIES_JSON='{"lead-engineer":5,"context":3,"qa-engineer":"unlimited"}'
```

## Testing Recommendations

### Unit Tests Needed
1. `calculateProgressiveTimeout()` with various inputs
2. `personaMaxRetries()` with map lookup and defaults
3. Duplicate detection with `isDuplicateMessage()` and `markMessageProcessed()`
4. Message tracking cleanup
5. Progressive timeout in PersonaRequestStep
6. Unlimited retries handling
7. Task ID propagation through request/event flow

### Integration Tests Needed
1. Full retry cycle with progressive timeouts
2. Duplicate message detection across workers
3. Workflow abortion after final timeout
4. Per-persona configuration application
5. Unlimited retries behavior

## Monitoring

### Redis Stream Monitor
Use `npm run monitor` to watch:
- Progressive timeout values in retry messages
- Duplicate detection events
- Final failure diagnostics

### Log Patterns to Watch
- Consistent immediate timeouts (timeout too short)
- Excessive duplicates (message re-queuing issues)
- Unlimited retry loops (persona unavailable)
- Final workflow aborts (capacity/availability issues)

## Rollout Recommendations

1. **Phase 1**: Deploy with defaults (1 min timeout, 3 retries)
2. **Phase 2**: Monitor logs for timeout patterns
3. **Phase 3**: Adjust per-persona timeouts based on observations
4. **Phase 4**: Enable unlimited retries for critical personas if needed

## Breaking Changes

1. **Timeout Calculation**: Changed from fixed delays to progressive timeouts
2. **Default Timeout**: Changed from 10 minutes to 1 minute (more conservative)
3. **Configuration Format**: Prefer JSON maps over individual env vars
4. **Backoff Behavior**: No delays between retries (timeout increases instead)

## Backward Compatibility

- Legacy configuration variables still work
- Old `PERSONA_TIMEOUTS_JSON` format unchanged
- Old global `PERSONA_TIMEOUT_MAX_RETRIES` still respected as default
- Existing workflows continue to function

## Files Modified

### Core System
- `src/schema.ts` - Added task_id and duplicate_response status
- `src/config.ts` - New per-persona retry configuration
- `src/util.ts` - Progressive timeout calculation utilities
- `src/worker.ts` - Duplicate detection integration
- `src/agents/persona.ts` - Task ID support in requests
- `src/process.ts` - Task ID in event messages

### Workflow System
- `src/workflows/steps/PersonaRequestStep.ts` - Progressive backoff implementation

### New Files
- `src/messageTracking.ts` - Duplicate detection system
- `docs/PERSONA_TIMEOUT_RETRY_SYSTEM.md` - Comprehensive documentation
- `.env.example.timeout-retry` - Configuration examples

## Performance Considerations

### Memory
- Message tracking uses in-memory map
- 24-hour TTL with hourly cleanup
- ~1KB per tracked message
- Expected: < 100MB for typical workloads

### Network
- No additional Redis calls for duplicate detection
- Duplicate responses reuse existing event stream
- Task ID adds ~10 bytes per message

### CPU
- Duplicate check: O(1) hash map lookup
- Cleanup: O(n) every hour (negligible)
- Progressive timeout calculation: O(1)

## Next Steps

1. Run test suite to validate changes
2. Update existing tests for new behavior
3. Add tests for new features (duplicate detection, progressive backoff)
4. Test with real distributed persona workers
5. Monitor production deployment carefully
6. Adjust default timeouts based on real-world data
