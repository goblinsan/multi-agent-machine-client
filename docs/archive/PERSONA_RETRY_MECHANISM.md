# Persona Request Retry Mechanism

## Overview

The workflow system implements a robust retry mechanism for persona requests that ensures workflows stay alive during retries but abort after all retries are exhausted.

## How It Works

### Two-Layer Timeout System

1. **PersonaRequestStep Internal Retry Loop**
   - Handles individual persona request attempts
   - Implements exponential backoff between retries
   - Default: 3 retries (4 total attempts)

2. **WorkflowEngine Step Timeout**
   - Wraps the entire PersonaRequestStep execution
   - Calculated to accommodate all retries + backoff delays
   - Ensures workflow stays alive during the retry process

### Timeout Calculation

For `PersonaRequestStep`, the engine calculates total timeout as:

```typescript
calculatedTimeout = (maxRetries + 1) × personaTimeout + totalBackoff + 30s buffer

where:
  totalBackoff = 30s + 60s + 90s + ... (sum of backoff delays)
  maxRetries = 3 (default, configurable per step)
```

**Example for context persona** (1-minute timeout, 3 retries):
- 4 attempts × 1 min = 4 minutes
- Backoff: 30s + 60s + 90s = 3 minutes
- Buffer: 30 seconds
- **Total: 7.5 minutes**

### Retry Flow

```
Attempt 1: Try persona request (timeout: personaTimeout)
           ↓ [timeout after personaTimeout]
           Wait 30 seconds (backoff)
           ↓
Attempt 2: Retry persona request (timeout: personaTimeout)
           ↓ [timeout after personaTimeout]
           Wait 60 seconds (backoff)
           ↓
Attempt 3: Retry persona request (timeout: personaTimeout)
           ↓ [timeout after personaTimeout]
           Wait 90 seconds (backoff)
           ↓
Attempt 4: Final retry (timeout: personaTimeout)
           ↓ [timeout after personaTimeout]
           ↓
All retries exhausted → Return failure
                        ↓
WorkflowEngine aborts workflow
                        ↓
Task marked as blocked
```

## Configuration

### Per-Persona Timeouts

Set in `.env` or `config.ts`:

```typescript
// .env
PERSONA_TIMEOUTS_JSON='{"context":60000,"lead-engineer":90000,"tester-qa":60000}'

// config.ts defaults
personaTimeouts['context'] = 60000; // 1 minute
```

### Per-Step Retry Configuration

Override in workflow definition:

```typescript
{
  name: "context_request",
  type: "PersonaRequestStep",
  config: {
    persona: "context",
    maxRetries: 5,  // Override default of 3
    timeout: 120000 // Override persona default
  }
}
```

### Global Defaults

```typescript
cfg.personaTimeoutMaxRetries = 3;           // Max retries
cfg.personaDefaultTimeoutMs = 600000;       // 10 minutes (fallback)
cfg.personaCodingTimeoutMs = 180000;        // 3 minutes (coding personas)
```

## Benefits

### Fast Feedback
- Context persona: 7.5 min max (vs previous 10 min)
- Planner: 5.5 min max (30s timeout × 4 + backoff)
- Lead engineer: 9.5 min max (90s timeout × 4 + backoff)

### Resilience
- Automatically retries transient failures
- Exponential backoff prevents overwhelming slow services
- Workflow stays alive during retries (no premature abort)

### Visibility
- Logs show each retry attempt with correlation IDs
- Timeout calculations logged at info level
- Clear indication when all retries exhausted

## Example Logs

```json
{
  "msg": "Calculated PersonaRequestStep timeout to accommodate retries",
  "step": "context_request",
  "persona": "context",
  "personaTimeoutMs": 60000,
  "personaTimeoutMinutes": "1.00",
  "maxRetries": 3,
  "totalBackoffMs": 180000,
  "totalBackoffMinutes": "3.00",
  "calculatedTimeout": 450000,
  "calculatedTimeoutMinutes": "7.50"
}

{
  "msg": "Step timeout configured",
  "step": "context_request",
  "persona": "context",
  "timeoutMs": 450000,
  "timeoutMinutes": "7.50"
}

{
  "msg": "Persona request timed out, will retry",
  "step": "1-context",
  "persona": "context",
  "attempt": 1,
  "remainingRetries": 3
}

{
  "msg": "Retrying persona request after timeout with backoff delay",
  "step": "1-context",
  "persona": "context",
  "attempt": 2,
  "backoffSeconds": 30
}
```

## Design Principles

1. **Workflow Stays Alive During Retries**
   - Engine timeout > total retry time
   - No premature workflow abortion

2. **Abort After All Retries Exhausted**
   - PersonaRequestStep returns failure after max retries
   - Engine propagates failure to workflow
   - Task marked as blocked

3. **Persona-Specific Timeouts**
   - Fast personas (planner): 30s
   - Medium personas (context, QA): 60s
   - Slow personas (lead-engineer): 90s

4. **Distributed System Friendly**
   - Retries account for network delays
   - Backoff prevents thundering herd
   - Remote persona context can complete on retry

## Troubleshooting

### Workflow aborted too quickly
- Check persona timeout in `.env` or config defaults
- Verify step timeout calculation in logs
- Ensure maxRetries is set appropriately

### Workflow taking too long
- Reduce persona timeout for faster feedback
- Reduce maxRetries (but keep at least 1 retry)
- Check if persona is actually hung (not just slow)

### Retries not happening
- Check logs for "will retry" messages
- Verify error is timeout (not other failure)
- Ensure maxRetries > 0 in config
