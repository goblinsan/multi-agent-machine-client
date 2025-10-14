# Persona Timeout and Retry System

## Overview

The multi-agent system implements a sophisticated timeout and retry mechanism designed for distributed persona workers. Each persona can run on a different machine with varying workloads and LM Studio availability, requiring flexible, per-persona configuration.

## Key Features

- ✅ **Per-Persona Configuration**: Each persona has its own timeout and max retry settings
- ✅ **Progressive Backoff**: Timeouts increase progressively with each retry attempt
- ✅ **Unlimited Retries**: Support for unlimited retries when needed
- ✅ **Duplicate Detection**: Prevents duplicate processing across distributed workers
- ✅ **Workflow Abort on Final Failure**: Clear diagnostic errors when all retries are exhausted
- ✅ **No Workflow Timeouts**: Workflows stay alive indefinitely during retries

## Configuration

### Environment Variables

#### Per-Persona Timeouts

```bash
# JSON map of persona timeouts (in milliseconds or duration strings)
PERSONA_TIMEOUTS_JSON='{"context":"60s","lead-engineer":"90s","qa-engineer":"2m","planner":"30s"}'

# Default timeout for personas not specified above (default: 60000ms = 1 minute)
PERSONA_DEFAULT_TIMEOUT_MS=60000
```

#### Per-Persona Max Retries

```bash
# JSON map of persona max retries (number or "unlimited")
PERSONA_MAX_RETRIES_JSON='{"context":3,"lead-engineer":5,"qa-engineer":"unlimited"}'

# Default max retries for personas not specified above (default: 3)
PERSONA_DEFAULT_MAX_RETRIES=3
```

#### Backoff Configuration

```bash
# Progressive backoff increment added per attempt (default: 30000ms = 30 seconds)
PERSONA_RETRY_BACKOFF_INCREMENT_MS=30000
```

### Duration Format Support

Timeout values support multiple formats:
- **Milliseconds**: `60000`
- **Seconds**: `"60s"` or `"60"`
- **Minutes**: `"2m"` or `"2min"`
- **Hours**: `"1h"`

### Unlimited Retries

Set max retries to any of these values for unlimited retries:
- `"unlimited"`
- `"infinite"`
- `"inf"`
- `"none"`
- `"no-limit"`
- `"nolimit"`

## Progressive Backoff Logic

The system uses **progressive timeout backoff** instead of fixed retry delays:

```typescript
currentTimeout = baseTimeout + (attemptNumber - 1) * backoffIncrement
```

### Example: 1-minute base timeout with 30-second increment

| Attempt | Timeout | Cumulative Time |
|---------|---------|-----------------|
| 1       | 1:00    | 1:00            |
| 2       | 1:30    | 2:30            |
| 3       | 2:00    | 4:30            |
| 4       | 2:30    | 7:00            |

### Benefits of Progressive Backoff

1. **Adaptive to Load**: Allows more time for busy persona workers
2. **Reduces Noise**: Fewer retries that timeout immediately
3. **Resource Efficient**: No artificial wait delays between attempts
4. **Better for Distributed Systems**: Accounts for network and queue delays

## Duplicate Detection

### Purpose

Prevents duplicate processing when:
- Messages are re-queued due to network issues
- Multiple workers process the same stream
- Retries are triggered after a persona has already responded

### How It Works

1. Each message contains `task_id` and `corr_id` (correlation ID)
2. When a persona receives a request, it checks if `(task_id, corr_id, persona)` has been processed
3. If duplicate: sends `duplicate_response` status immediately
4. If new: marks as processed and continues

### Tracking

- **Storage**: In-memory map with 24-hour TTL
- **Cleanup**: Automatic hourly cleanup of expired records
- **Key Format**: `taskId:corrId:persona`

### Duplicate Response

When a duplicate is detected:

```json
{
  "status": "duplicate_response",
  "result": {
    "message": "This request has already been processed by this persona",
    "originalTaskId": "task-123",
    "originalCorrId": "corr-456"
  }
}
```

## Workflow Behavior

### No Workflow Timeout

- Workflows do **not** have timeouts
- They stay alive indefinitely while personas retry
- This allows for:
  - Long-running model operations
  - Distributed persona availability issues
  - Variable network conditions

### Workflow Abort on Final Failure

When all retries are exhausted:

1. **Detailed Error Logged**:
```json
{
  "msg": "Persona request failed after exhausting all retries - WORKFLOW WILL ABORT",
  "persona": "lead-engineer",
  "totalAttempts": 4,
  "baseTimeoutMin": "1.50",
  "finalTimeoutMin": "2.50",
  "diagnostics": {
    "reason": "All retry attempts exhausted without successful completion",
    "recommendation": "Check persona availability, LM Studio status, and increase timeout/retries if needed",
    "configKeys": ["PERSONA_TIMEOUTS_JSON", "PERSONA_MAX_RETRIES_JSON"]
  }
}
```

2. **Workflow Returns Failure**:
```typescript
{
  status: 'failure',
  error: Error('Persona ... timed out after N attempts. Workflow aborted.'),
  data: { workflowAborted: true, ... }
}
```

3. **Task Marked as Blocked**: The orchestrator marks the task as blocked/failed

## Configuration Examples

### Development Environment

```bash
# Fast personas with fewer retries
PERSONA_TIMEOUTS_JSON='{"planner":"30s","context":"1m","lead-engineer":"1m"}'
PERSONA_MAX_RETRIES_JSON='{"planner":2,"context":3,"lead-engineer":3}'
PERSONA_RETRY_BACKOFF_INCREMENT_MS=15000  # 15 seconds
```

### Production Environment

```bash
# Longer timeouts, more retries for reliability
PERSONA_TIMEOUTS_JSON='{"planner":"1m","context":"2m","lead-engineer":"3m","qa-engineer":"2m"}'
PERSONA_MAX_RETRIES_JSON='{"planner":5,"context":5,"lead-engineer":10,"qa-engineer":5}'
PERSONA_RETRY_BACKOFF_INCREMENT_MS=30000  # 30 seconds
```

### High-Availability Setup

```bash
# Unlimited retries for critical personas
PERSONA_TIMEOUTS_JSON='{"lead-engineer":"2m","qa-engineer":"1.5m"}'
PERSONA_MAX_RETRIES_JSON='{"lead-engineer":"unlimited","qa-engineer":"unlimited"}'
PERSONA_DEFAULT_MAX_RETRIES=unlimited
PERSONA_RETRY_BACKOFF_INCREMENT_MS=45000  # 45 seconds
```

### Per-Step Override

You can override timeout and retries in workflow definitions:

```yaml
- name: critical_review
  type: persona_request
  config:
    persona: qa-engineer
    step: "5-review"
    intent: "review"
    maxRetries: 10        # Override persona default
    timeout: 300000       # 5 minutes (overrides PERSONA_TIMEOUTS_JSON)
    payload:
      task: "${task_description}"
```

## Message Schema

### Request Message

```typescript
{
  workflow_id: string;
  task_id?: string;           // NEW: Task identifier for duplicate detection
  step?: string;
  from: string;
  to_persona: string;
  intent: string;
  payload?: string;
  corr_id?: string;          // Correlation ID for duplicate detection
  deadline_s?: number;
  repo?: string;
  branch?: string;
  project_id?: string;
}
```

### Event Message

```typescript
{
  workflow_id: string;
  task_id?: string;                    // NEW: Task identifier
  step?: string;
  from_persona: string;
  status: "done" | "progress" | "error" | "blocked" | "duplicate_response";  // NEW: duplicate_response
  result?: string;
  corr_id?: string;
  ts?: string;
  error?: string;
}
```

## Example Logs

### First Attempt

```json
{
  "msg": "Making persona request",
  "persona": "lead-engineer",
  "baseTimeoutMs": 90000,
  "baseTimeoutSec": "90.0",
  "maxRetries": 5,
  "backoffIncrementMs": 30000
}

{
  "msg": "First attempt with base timeout",
  "timeoutMs": 90000,
  "timeoutMin": "1.50"
}
```

### Retry After Timeout

```json
{
  "msg": "Persona request timed out, will retry with increased timeout",
  "attempt": 1,
  "timedOutAtMs": 90000,
  "timedOutAtMin": "1.50",
  "nextTimeoutMs": 120000,
  "nextTimeoutMin": "2.00",
  "remainingRetries": 4
}

{
  "msg": "Retrying persona request (progressive timeout)",
  "attempt": 2,
  "currentTimeoutMs": 120000,
  "currentTimeoutMin": "2.00"
}
```

### Final Failure

```json
{
  "msg": "Persona request failed after exhausting all retries - WORKFLOW WILL ABORT",
  "totalAttempts": 6,
  "baseTimeoutMs": 90000,
  "baseTimeoutMin": "1.50",
  "finalTimeoutMs": 240000,
  "finalTimeoutMin": "4.00",
  "diagnostics": {
    "reason": "All retry attempts exhausted without successful completion",
    "recommendation": "Check persona availability, LM Studio status, and increase timeout/retries if needed"
  }
}
```

### Duplicate Detection

```json
{
  "msg": "Duplicate message detected, sending duplicate_response",
  "persona": "lead-engineer",
  "taskId": "task-123",
  "corrId": "corr-456"
}
```

## Monitoring

Use the Redis stream monitor to watch timeout and retry behavior:

```bash
npm run monitor
```

Output shows progressive timeouts:
```
12:34:56.789 REQ abc12345 orchestrator → lead-engineer [implement] implement_feature corr:xyz789
12:36:26.789 EVT abc12345 lead-engineer [implement] ⋯ PROGRESS corr:xyz789
12:38:26.789 REQ abc12345 orchestrator → lead-engineer [implement] implement_feature corr:def012  # Retry
12:40:56.789 EVT abc12345 lead-engineer [implement] ✓ DONE corr:def012  # Success on retry
```

## Migration Guide

### From Old System

**Old Configuration**:
```bash
PERSONA_TIMEOUT_MAX_RETRIES=3
COORDINATOR_WAIT_TIMEOUT_MS=600000
PERSONA_CODING_TIMEOUT_MS=180000
```

**New Configuration**:
```bash
# Map-based configuration
PERSONA_DEFAULT_TIMEOUT_MS=60000
PERSONA_DEFAULT_MAX_RETRIES=3
PERSONA_RETRY_BACKOFF_INCREMENT_MS=30000

# Per-persona overrides
PERSONA_TIMEOUTS_JSON='{"lead-engineer":"3m","context":"1m"}'
PERSONA_MAX_RETRIES_JSON='{"lead-engineer":5,"context":3}'
```

### Breaking Changes

1. **Backoff Logic Changed**: Old system used fixed 30s delays between retries. New system uses progressive timeouts (no delays).

2. **Timeout Calculation**: Old system: `timeout * (maxRetries + 1) + backoffSum`. New system: Progressive per attempt.

3. **Configuration Format**: Now uses JSON maps instead of individual env vars per persona.

## Troubleshooting

### Persona Times Out Immediately

**Cause**: Timeout too short for persona workload

**Solution**:
```bash
PERSONA_TIMEOUTS_JSON='{"problem-persona":"5m"}'
```

### Too Many Retries

**Cause**: Persona unavailable or LM Studio down

**Solution**:
1. Check persona worker is running
2. Check LM Studio is accessible
3. Review logs for connection errors
4. Consider reducing max retries for faster failure:
```bash
PERSONA_MAX_RETRIES_JSON='{"problem-persona":2}'
```

### Duplicate Responses

**Cause**: Normal behavior when re-queuing occurs

**Solution**: No action needed - system handles automatically. Monitor logs to ensure not excessive.

### Workflow Never Completes

**Cause**: Unlimited retries on unavailable persona

**Solution**: Set finite max retries:
```bash
PERSONA_MAX_RETRIES_JSON='{"persona-name":10}'
```

## Best Practices

1. **Start with defaults** (1 min timeout, 3 retries) and adjust based on observed behavior
2. **Use progressive backoff** - the default 30s increment works well for most cases
3. **Monitor logs** - watch for patterns of consistent timeouts
4. **Set unlimited retries carefully** - only for critical, eventually-available personas
5. **Test timeout changes** in development before production
6. **Use per-step overrides** for known long-running operations

## API Reference

### Utility Functions

```typescript
// Get timeout for a persona
personaTimeoutMs(persona: string, cfg: Config): number

// Get max retries for a persona (null = unlimited)
personaMaxRetries(persona: string, cfg: Config): number | null

// Calculate timeout for a specific attempt
calculateProgressiveTimeout(
  baseTimeoutMs: number,
  attemptNumber: number,
  backoffIncrementMs?: number
): number

// Check for duplicate messages
isDuplicateMessage(
  taskId: string | undefined,
  corrId: string | undefined,
  persona: string
): boolean

// Mark message as processed
markMessageProcessed(
  taskId: string | undefined,
  corrId: string | undefined,
  persona: string,
  workflowId: string
): void
```
