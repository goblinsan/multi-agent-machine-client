# VI.MOCK Hoisting Problem & Solutions

**Date:** October 13, 2025  
**Context:** Phase 1 refactoring (REFACTOR_PLAN.md) - Redis mock consolidation

## The Problem: vi.mock() Hoisting

### Technical Issue

Vitest (and Jest) **hoist** all `vi.mock()` calls to execute **before any imports**. This prevents calling helper functions in mock factories.

**What we tried (doesn't work):**
```typescript
import { createRedisMock } from './helpers/mockHelpers.js';
vi.mock('../src/redisClient.js', () => createRedisMock());
// ❌ Error: Cannot access 'createRedisMock' before initialization
```

**Why it fails:**
```typescript
// Actual execution order after hoisting:
// 1. FIRST: vi.mock() runs
vi.mock('../src/redisClient.js', () => createRedisMock()); // ❌ createRedisMock undefined!

// 2. THEN: Imports execute
import { createRedisMock } from './helpers/mockHelpers.js';
```

### Impact on Refactoring

- **Goal:** Eliminate ~260 lines of duplicate Redis mock code (13 lines × 20 files)
- **Blocker:** Can't call `createRedisMock()` helper function in hoisted `vi.mock()`
- **Current state:** Each test file has verbose inline 13-line Redis mock

## Solution: __mocks__ Directory Pattern ✅

### Implementation

**Step 1:** Create mock file at `tests/__mocks__/redisClient.js`
```typescript
import { vi } from 'vitest';

export const makeRedis = vi.fn().mockResolvedValue({
  xGroupCreate: vi.fn().mockResolvedValue(null),
  xReadGroup: vi.fn().mockResolvedValue([]),
  xAck: vi.fn().mockResolvedValue(null),
  disconnect: vi.fn().mockResolvedValue(null),
  quit: vi.fn().mockResolvedValue(null),
  xRevRange: vi.fn().mockResolvedValue([]),
  xAdd: vi.fn().mockResolvedValue('test-id'),
  exists: vi.fn().mockResolvedValue(1)
});
```

**Step 2:** In test files, replace verbose mock with one-liner
```typescript
// ❌ BEFORE (13 lines):
vi.mock('../src/redisClient.js', () => ({
  makeRedis: vi.fn().mockResolvedValue({
    xGroupCreate: vi.fn().mockResolvedValue(null),
    xReadGroup: vi.fn().mockResolvedValue([]),
    xAck: vi.fn().mockResolvedValue(null),
    disconnect: vi.fn().mockResolvedValue(null),
    quit: vi.fn().mockResolvedValue(null),
    xRevRange: vi.fn().mockResolvedValue([]),
    xAdd: vi.fn().mockResolvedValue('test-id'),
    exists: vi.fn().mockResolvedValue(1)
  })
}));

// ✅ AFTER (1 line):
vi.mock('../src/redisClient.js');  // Automatically uses __mocks__/redisClient.js
```

### How It Works

1. Vitest sees `vi.mock('../src/redisClient.js')` with **no factory function**
2. Looks for mock file at `tests/__mocks__/redisClient.js` (relative to test file)
3. Uses that mock implementation automatically
4. Single source of truth for Redis mock across all tests

### Verification

**Test run:** ✅ All 139 tests passing (7.22s)  
**File tested:** `tests/processedOnce.test.ts`  
**Result:** Mock file pattern works correctly

## Dashboard Mocks: Why __mocks__ Pattern Doesn't Apply

Unlike Redis mocks (which are generic connection mocks), **dashboard mocks contain test-specific data**:
- Custom project IDs (`proj-once`, `proj-blocked`, `proj-priority`)
- Test-specific task lists with different statuses and attributes
- Varying milestone structures
- Different repositories

**Analysis:** 13 test files have dashboard mocks, averaging 14-18 lines each (~200 lines total)

**Decision:** Keep inline dashboard mocks because:
1. ✅ Each test needs different mock data (project IDs, task lists)
2. ✅ Using __mocks__ would require overriding in every test anyway
3. ✅ Test-specific data makes tests more readable and self-contained
4. ❌ Consolidation would not reduce code or improve maintainability

**Lesson:** __mocks__ pattern works best for **infrastructure mocks** (Redis, DB connections) with generic behavior, not for **data mocks** with test-specific payloads.

## Alternative Solutions (Not Recommended)

### Option 1: Accept Duplication
- Keep verbose inline mocks in all 20+ files
- **Pro:** Simple, no risk
- **Con:** 260+ lines of duplicate code, hard to maintain

### Option 2: vi.doMock() with Dynamic Imports
```typescript
import { createRedisMock } from './helpers/mockHelpers.js';
vi.doMock('../src/redisClient.js', () => createRedisMock());

// Requires dynamic imports:
const { WorkflowCoordinator } = await import('../src/workflows/WorkflowCoordinator.js');
```
- **Pro:** Can call helpers, no hoisting
- **Con:** Complex, requires async test setup, hard to maintain

## Recommendation

✅ **Use __mocks__ directory pattern** (Option from original analysis)

**Benefits:**
- 🎯 **Single source of truth** for Redis mock
- 📉 **Eliminates ~240 lines** of duplicate code (12 lines saved × 20 files)
- 🧹 **Cleaner test files** (13 lines → 1 line per file)
- 📚 **Standard pattern** (Jest/Vitest convention)
- 🛠️ **Easy maintenance** (update one file affects all tests)

**Next Steps:**
1. Apply pattern to remaining 19 test files with Redis mocks
2. Consider creating `__mocks__/dashboard.js` for dashboard mocks
3. Consider creating `__mocks__/gitUtils.js` for git mocks
4. Update REFACTOR_PLAN.md with this approach

## Files to Update (20 total)

Redis mock candidates (have `xGroupCreate: vi.fn`):
- [x] tests/processedOnce.test.ts ✅ DONE (verified working)
- [ ] tests/happyPath.test.ts
- [ ] tests/handleCoordinator.overrides.test.ts
- [ ] tests/qaFollowupExecutes.test.ts
- [ ] tests/qaPmGating.test.ts
- [ ] tests/qaFailure.test.ts
- [ ] tests/qaPlanIterationMax.test.ts
- [ ] tests/branchSelection.test.ts
- [ ] tests/taskPriorityAndRouting.test.ts
- [ ] tests/tddGovernanceGate.test.ts
- [ ] tests/blockedTaskResolution.test.ts
- [ ] tests/workflowCoordinator.test.ts
- [ ] tests/initialPlanningAckAndEval.test.ts
- [ ] tests/coordinator.test.ts
- [ ] tests/commitAndPush.test.ts
- [ ] tests/workflowSteps.test.ts
- [ ] tests/dashboardInteractions.test.ts (has 2 mocks)

## References

- **Vitest Mocking Docs:** https://vitest.dev/api/vi.html#vi-mock
- **Mock Files Pattern:** https://vitest.dev/guide/mocking.html#mock-modules
- **Related Issue:** REFACTOR_PLAN.md Phase 1 Step 2
