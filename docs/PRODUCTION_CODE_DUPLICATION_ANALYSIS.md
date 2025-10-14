# Production Code Duplication Analysis
*Generated: October 13, 2025*
*Completed: October 13, 2025*

## ✅ STATUS: REFACTORING COMPLETE

**All identified duplication has been successfully consolidated in Phase 3.**

See [PHASE_3_REFACTOR_COMPLETE.md](./PHASE_3_REFACTOR_COMPLETE.md) for full implementation details.

---

## Executive Summary

Analysis of `src/` production code revealed **moderate duplication** in Redis operations and timeout calculations, but **minimal git duplication** due to existing centralization in `gitUtils.ts`.

### Key Findings (Original Analysis)
- **Redis Operations**: ~8-10 patterns duplicated across 4-5 files → ✅ FIXED
- **Timeout/Retry Logic**: 2 duplicate implementations of personaTimeoutMs → ✅ FIXED
- **Git Operations**: Well-centralized, minimal duplication → ✅ NO ACTION NEEDED

### Implementation Results (Phase 3)
- **Option B Selected**: Full Phase 3 implementation
- **Lines Eliminated**: ~80 lines (exceeded 75-line target)
- **Files Modified**: 6 production files
- **New Infrastructure**: 2 Redis helper modules created
- **Test Stability**: ✅ 139/139 passing
- **Status**: COMPLETE ✅

---

## 1. Redis Operation Duplication

### Pattern 1: Event Stream Publishing (xAdd to eventStream)
**Duplication Count**: 4 locations  
**Lines**: ~10 lines per instance = 40 total lines duplicated

**Locations:**
1. `src/worker.ts:65` - Error event emission
2. `src/worker.ts:139` - Duplicate response event
3. `src/process.ts:880` - Persona completion event (processPersonaRequest)
4. `src/process.ts:1075` - Persona completion event (processPersona)

**Pattern:**
```typescript
await r.xAdd(cfg.eventStream, "*", {
  workflow_id: msg.workflow_id,
  task_id: msg.task_id || "",
  step: msg.step || "",
  from_persona: persona,
  status: "done",  // or "error", "duplicate_response"
  result: JSON.stringify(result),
  corr_id: msg.corr_id || "",
  ts: new Date().toISOString()
});
```

**Refactoring Opportunity**: Extract to `src/redis/eventPublisher.ts`

### Pattern 2: Request Acknowledgment (xAck)
**Duplication Count**: 6 locations  
**Lines**: ~1-2 lines per instance = 10 total lines duplicated

**Locations:**
1. `src/worker.ts:70` - Error handling ack
2. `src/worker.ts:125` - Invalid parse ack
3. `src/worker.ts:127` - Wrong persona ack
4. `src/worker.ts:156` - Normal processing ack
5. `src/worker.ts:175` - Re-queue ack
6. `src/process.ts:891` - processPersonaRequest ack
7. `src/process.ts:1086` - processPersona ack

**Pattern:**
```typescript
await r.xAck(cfg.requestStream, groupForPersona(persona), entryId);
// OR
try { await r.xAck(cfg.requestStream, `${cfg.groupPrefix}:${persona}`, entryId); } catch {}
```

**Refactoring Opportunity**: Extract to `src/redis/requestHandlers.ts`

### Pattern 3: Stream Reading (xReadGroup)
**Duplication Count**: 3 locations  
**Lines**: ~5-10 lines per instance = 25 total lines duplicated

**Locations:**
1. `src/worker.ts:43` - Main readOne with retry logic
2. `src/worker.ts:51` - Retry after group creation
3. `src/workflows/steps/PullTaskStep.ts:62` - Workflow task pulling

**Pattern:**
```typescript
await r.xReadGroup(
  groupForPersona(persona), 
  cfg.consumerId, 
  { key: cfg.requestStream, id: ">" }, 
  { COUNT: 1, BLOCK: 1000 }
)
```

**Refactoring Opportunity**: Extract to `src/redis/streamReader.ts`

### Pattern 4: Event Stream Monitoring (xRead for responses)
**Duplication Count**: 2 locations (but different use cases)  
**Lines**: ~20 lines per instance = 40 total lines (partial duplication)

**Locations:**
1. `src/agents/persona.ts:77` - waitForPersonaCompletion polling
2. (Possibly in workflow engine - not detected in grep)

**Pattern:**
```typescript
const streams = await eventRedis.xRead(
  [{ key: streamKey, id: lastId }], 
  { BLOCK: blockMs, COUNT: 20 }
)
```

**Note**: This is more specialized - less clear refactoring path

---

## 2. Timeout/Retry Duplication

### Pattern 1: personaTimeoutMs Function
**Duplication Count**: 2 implementations  
**Lines**: ~5 lines per implementation = 10 total lines duplicated

**Locations:**
1. `src/util.ts:84-88` - Main implementation (exported)
   ```typescript
   export function personaTimeoutMs(persona: string, cfg: any) {
     const key = (persona || "").toLowerCase();
     if (key && cfg.personaTimeouts[key] !== undefined) return cfg.personaTimeouts[key];
     if (CODING_PERSONA_SET.has(key) && cfg.personaCodingTimeoutMs) return cfg.personaCodingTimeoutMs;
     return cfg.personaDefaultTimeoutMs;
   }
   ```

2. `src/agents/persona.ts:19-24` - Local implementation (NOT exported)
   ```typescript
   function personaTimeoutMs(persona: string) {
     const key = (persona || "").toLowerCase();
     if (cfg.personaTimeouts[key] !== undefined) return cfg.personaTimeouts[key];
     if (CODING_PERSONA_SET.has(key) && cfg.personaCodingTimeoutMs) return cfg.personaCodingTimeoutMs;
     return cfg.personaDefaultTimeoutMs;
   }
   ```

**Issue**: `persona.ts` has a duplicate local implementation instead of importing from util

**Refactoring**: Remove local implementation, import from util.ts

### Pattern 2: Timeout Calculation Logic
**Duplication Count**: 2 locations reimplement similar logic  
**Lines**: ~10-15 lines each

**Locations:**
1. `src/workflows/WorkflowEngine.ts:618-637` - Manual timeout calculation
   ```typescript
   let personaTimeoutMs = cfg.personaTimeouts[persona];
   if (!personaTimeoutMs) {
     const personaKey = (persona || "").toLowerCase();
     const isCodingPersona = CODING_PERSONA_SET.has(personaKey);
     personaTimeoutMs = isCodingPersona ? cfg.personaCodingTimeoutMs : cfg.personaDefaultTimeoutMs;
   }
   const totalPersonaTimeMs = (maxRetries + 1) * personaTimeoutMs;
   ```

2. `src/workflows/steps/PersonaRequestStep.ts:29` - Uses util function (GOOD)
   ```typescript
   const baseTimeoutMs = config.timeout ?? personaTimeoutMs(persona, cfg);
   ```

**Issue**: WorkflowEngine reimplements what util.personaTimeoutMs already does

**Refactoring**: Import and use util.personaTimeoutMs in WorkflowEngine.ts

---

## 3. Git Operation Analysis

### ✅ Well-Centralized Patterns

Git operations are **well-centralized** in `src/gitUtils.ts` with minimal duplication:

**Centralized Functions:**
- `resolveRepoFromPayload()` - Used consistently across codebase (5+ locations)
- `getRepoMetadata()`
- `commitAndPushPaths()`
- `checkoutBranchFromBase()`
- `ensureBranchPublished()`
- `runGit()`

**Usage Pattern (Good Example):**
```typescript
// src/process.ts:225
import { resolveRepoFromPayload, ... } from "./gitUtils.js";
repoInfo = await resolveRepoFromPayload(payloadObj);

// src/workflows/WorkflowCoordinator.ts:90
import { resolveRepoFromPayload } from "../gitUtils.js";
const repoResolution = await resolveRepoFromPayload({ ... });
```

**Finding**: Git operations are already well-refactored. No significant duplication detected.

---

## 4. Refactoring Recommendations

### High Priority (High Value, Low Risk)

#### 1. Consolidate personaTimeoutMs Implementations
**Impact**: 10 lines eliminated, 1 import inconsistency fixed  
**Risk**: Low - straightforward import change  
**Effort**: 5 minutes

**Action:**
```typescript
// In src/agents/persona.ts
- function personaTimeoutMs(persona: string) { ... }  // DELETE
+ import { personaTimeoutMs } from '../util.js';     // ADD
```

#### 2. Fix WorkflowEngine Timeout Calculation
**Impact**: 15 lines eliminated, improved consistency  
**Risk**: Low - util function already tested  
**Effort**: 10 minutes

**Action:**
```typescript
// In src/workflows/WorkflowEngine.ts
- let personaTimeoutMs = cfg.personaTimeouts[persona];
- if (!personaTimeoutMs) {
-   const personaKey = (persona || "").toLowerCase();
-   const isCodingPersona = CODING_PERSONA_SET.has(personaKey);
-   personaTimeoutMs = isCodingPersona ? ...
- }
+ import { personaTimeoutMs as getPersonaTimeout } from '../util.js';
+ const personaTimeoutMs = getPersonaTimeout(persona, cfg);
```

### Medium Priority (Moderate Value, Moderate Risk)

#### 3. Extract Redis Event Publisher
**Impact**: ~40 lines eliminated, improved testability  
**Risk**: Medium - requires careful parameter extraction  
**Effort**: 30-45 minutes

**Proposed API:**
```typescript
// src/redis/eventPublisher.ts
export async function publishEvent(r: any, event: {
  workflowId: string;
  taskId?: string;
  step?: string;
  fromPersona: string;
  status: 'done' | 'error' | 'duplicate_response' | string;
  result?: any;
  corrId?: string;
  error?: string;
}) {
  await r.xAdd(cfg.eventStream, "*", {
    workflow_id: event.workflowId,
    task_id: event.taskId || "",
    step: event.step || "",
    from_persona: event.fromPersona,
    status: event.status,
    result: event.result ? JSON.stringify(event.result) : undefined,
    corr_id: event.corrId || "",
    error: event.error,
    ts: new Date().toISOString()
  });
}
```

**Usage:**
```typescript
// Before
await r.xAdd(cfg.eventStream, "*", {
  workflow_id: msg.workflow_id,
  step: msg.step || "",
  from_persona: persona,
  status: "done",
  result: JSON.stringify(result),
  corr_id: msg.corr_id || "",
  ts: new Date().toISOString()
});

// After
await publishEvent(r, {
  workflowId: msg.workflow_id,
  step: msg.step,
  fromPersona: persona,
  status: 'done',
  result,
  corrId: msg.corr_id
});
```

#### 4. Extract Request Acknowledgment Helper
**Impact**: ~10 lines eliminated, better error handling  
**Risk**: Low-Medium - straightforward wrapper  
**Effort**: 15 minutes

**Proposed API:**
```typescript
// src/redis/requestHandlers.ts
export async function acknowledgeRequest(
  r: any, 
  persona: string, 
  entryId: string,
  silent: boolean = false
) {
  const group = `${cfg.groupPrefix}:${persona}`;
  try {
    await r.xAck(cfg.requestStream, group, entryId);
  } catch (err) {
    if (!silent) throw err;
    logger.debug('request ack failed (silent)', { persona, entryId, error: err });
  }
}
```

### Lower Priority (Lower Value or Higher Risk)

#### 5. Extract Stream Reader Patterns
**Impact**: ~25 lines eliminated, centralized retry logic  
**Risk**: Medium-High - different contexts (worker vs workflow)  
**Effort**: 1-2 hours

**Complexity**: Different use cases make this harder:
- Worker polling loop (readOne in worker.ts)
- Workflow task pulling (PullTaskStep.ts)
- Event monitoring (persona.ts)

**Recommendation**: Wait until more duplication emerges or specific pain point arises

---

## 5. Summary Metrics

### Current Duplication
| Category | Duplicated Lines | Number of Locations | Refactoring Priority |
|----------|-----------------|---------------------|---------------------|
| Redis Event Publishing | ~40 | 4 | Medium |
| Redis Request Ack | ~10 | 7 | Medium |
| Redis Stream Reading | ~25 | 3 | Low |
| personaTimeoutMs | 10 | 2 | **High** |
| Timeout Calculation | 15 | 2 | **High** |
| Git Operations | 0 | N/A | None (well-centralized) |
| **TOTAL** | **~100 lines** | **18 locations** | |

### Recommended Phase 3 Scope
If proceeding with production code refactoring:

**Quick Wins (High Priority Items Only):**
- Fix personaTimeoutMs duplication (src/agents/persona.ts)
- Fix WorkflowEngine timeout calculation
- **Estimated Impact**: 25 lines eliminated
- **Estimated Effort**: 15 minutes
- **Risk**: Very Low

**Full Phase 3 (Include Medium Priority):**
- All High Priority items (25 lines)
- Redis event publisher extraction (40 lines)
- Request acknowledgment helper (10 lines)
- **Estimated Impact**: 75 lines eliminated
- **Estimated Effort**: 1-1.5 hours
- **Risk**: Low-Medium

---

## 6. Testing Strategy

For any production code refactoring:

1. **Existing Test Coverage**: All changes covered by existing 139 passing tests
2. **No New Tests Needed**: Functions are just consolidations, not new behavior
3. **Test Verification**: Run full suite after each change
4. **Rollback Safety**: Git branch for easy revert if issues arise

---

## 7. Decision Point

**Question**: Should we proceed with production code refactoring?

**Option A: Quick Wins Only** (Recommended)
- Fix 2 timeout duplications
- 15 minutes effort
- 25 lines saved
- Very low risk

**Option B: Full Phase 3**
- All timeout + Redis event publishing
- 1-1.5 hours effort
- 75 lines saved
- Low-medium risk

**Option C: Skip for Now**
- Current duplication is manageable
- Focus on new feature development
- Revisit if patterns cause actual problems

**Recommendation**: Proceed with **Option A (Quick Wins)** - high value, minimal risk, and continues the momentum from Phases 1 & 2.
