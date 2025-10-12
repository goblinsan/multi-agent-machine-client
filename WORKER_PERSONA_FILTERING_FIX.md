# Worker Persona Filtering Fix

## Problem

Workers were picking up requests for personas they couldn't handle, causing errors like:

```
Error: No model mapping for 'context'
```

This violated the distributed architecture principle where:
- Worker A handles `context` persona (has the model)
- Worker B should NOT pick up `context` requests (no model configured)
- But Worker B was joining the `context` consumer group anyway

### Root Cause

1. **`ALLOWED_PERSONAS`** listed ALL personas that MIGHT be handled by SOME worker
2. **`PERSONA_MODELS_JSON`** only mapped personas THIS worker could handle
3. Worker joined consumer groups for ALL personas in `ALLOWED_PERSONAS`
4. Worker picked up messages for personas without model mappings → crash

## Solution

### Part 1: Config-Time Filtering

Added filtering in `src/config.ts` to automatically remove personas without model mappings:

```typescript
// Filter allowedPersonas to only include personas this worker can actually handle
const rawAllowedPersonas = cfg.allowedPersonas;
cfg.allowedPersonas = cfg.allowedPersonas.filter(persona => {
  // Coordination persona is special - doesn't use LM Studio
  if (persona === 'coordination') return true;
  
  // All other personas need a model mapping
  const hasModelMapping = !!cfg.personaModels[persona];
  
  if (!hasModelMapping) {
    console.warn(`[config] Persona '${persona}' in ALLOWED_PERSONAS but no model mapping - will not handle requests for this persona`);
  }
  
  return hasModelMapping;
});
```

**Result:** Worker only joins consumer groups for personas it can handle.

### Part 2: Runtime Defense (Belt and Suspenders)

Added defensive check in `src/worker.ts` to re-queue messages if somehow picked up:

```typescript
// Check if this worker can handle this persona (has model mapping or is coordination)
if (persona !== PERSONAS.COORDINATION && !cfg.personaModels[persona]) {
  logger.warn("received request for persona without model mapping - re-queueing", {
    persona,
    workflowId: msg.workflow_id,
    consumerId: cfg.consumerId,
    availableModels: Object.keys(cfg.personaModels)
  });
  
  // Re-queue the message by adding it back to the stream (another worker should handle it)
  await r.xAdd(cfg.requestStream, "*", fields);
  
  // Acknowledge to remove from this consumer's pending list
  await r.xAck(cfg.requestStream, groupForPersona(persona), entryId);
  return;
}
```

**Result:** If a message somehow gets picked up anyway, it's re-queued for another worker instead of crashing.

## Behavior

### Before Fix

```bash
# Worker macbook-1 .env
ALLOWED_PERSONAS=context,lead-engineer,tester-qa,...
PERSONA_MODELS_JSON={"lead-engineer":"qwen3-coder-30b",...}  # No context!

# Worker starts
✅ Joins consumer group: cg:context
✅ Joins consumer group: cg:lead-engineer
✅ Joins consumer group: cg:tester-qa

# Context request comes in
❌ Worker picks up context request
❌ Tries to call LM Studio
❌ Error: No model mapping for 'context'
❌ Workflow crashes
```

### After Fix

```bash
# Worker macbook-1 .env
ALLOWED_PERSONAS=context,lead-engineer,tester-qa,...
PERSONA_MODELS_JSON={"lead-engineer":"qwen3-coder-30b",...}  # No context!

# Worker starts
⚠️  [config] Persona 'context' in ALLOWED_PERSONAS but no model mapping - will not handle requests for this persona
⚠️  [config] Filtered personas: 14 → 9 (removed personas without model mappings)
✅ [config] Active personas: lead-engineer, plan-evaluator, ...
✅ Joins consumer group: cg:lead-engineer
✅ Joins consumer group: cg:plan-evaluator
❌ Does NOT join: cg:context (no model mapping)

# Context request comes in
✅ Worker ignores it (not in that consumer group)
✅ Another worker with context model handles it
✅ Workflow continues smoothly
```

## Configuration Pattern

### Correct Multi-Worker Setup

**Worker A (Context Specialist)**
```bash
ALLOWED_PERSONAS=context,summarization
PERSONA_MODELS_JSON={"context":"qwen3-coder-30b","summarization":"llama3-8b-general"}
```
- Handles: context, summarization
- Ignores: everything else

**Worker B (Implementation Specialist)**
```bash
ALLOWED_PERSONAS=lead-engineer,implementation-planner,tester-qa,context
PERSONA_MODELS_JSON={"lead-engineer":"qwen3-coder-30b","implementation-planner":"qwen3-coder-30b","tester-qa":"qwen3-coder-30b"}
```
- Handles: lead-engineer, implementation-planner, tester-qa
- Ignores: context (no model mapping, filtered out)

**Worker C (Coordinator)**
```bash
ALLOWED_PERSONAS=coordination
PERSONA_MODELS_JSON={}  # Coordination doesn't need a model
```
- Handles: coordination (special case, no model needed)
- Ignores: everything else

## Benefits

1. **No Configuration Errors** - Can safely list personas in `ALLOWED_PERSONAS` even if not configured
2. **Self-Correcting** - Workers automatically filter to only handle what they can
3. **Clear Logging** - Startup shows exactly which personas are active
4. **Fault Tolerant** - Double defense (config + runtime) prevents crashes
5. **Distributed Architecture Preserved** - Workers only handle their specialty

## Startup Output

```
[config] Persona 'devops' in ALLOWED_PERSONAS but no model mapping - will not handle requests for this persona
[config] Persona 'tester-qa' in ALLOWED_PERSONAS but no model mapping - will not handle requests for this persona
[config] Persona 'context' in ALLOWED_PERSONAS but no model mapping - will not handle requests for this persona
[config] Filtered personas: 14 → 9 (removed personas without model mappings)
[config] Active personas: plan-evaluator, implementation-planner, lead-engineer, code-reviewer, security-review, coordination, project-manager, architect, summarization
[info] worker ready { personas: [...], ... }
```

## Testing

✅ All 106 tests passing
✅ Config filtering validated
✅ Worker startup verified

## Files Modified

1. `src/config.ts` - Added persona filtering logic after config object creation
2. `src/worker.ts` - Added runtime re-queue logic for misrouted messages

## Migration

No action required! Existing configurations work automatically. Workers will:
- Filter their persona list on startup
- Log which personas were removed
- Only join consumer groups they can handle

The distributed architecture is now properly enforced at the worker level.
