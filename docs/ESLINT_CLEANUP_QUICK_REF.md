# ESLint Warning Cleanup - Quick Reference

## Current Status (Oct 26, 2025)

```
Warnings: 207 → 198 (9 fixed)
Errors: 0
Tests: 347/347 passing ✅
```

## What Was Fixed

✅ Removed 9 unused logger imports from:
- src/workflows/coordinator/WorkflowSelector.ts
- src/workflows/helpers/workflowAbort.ts
- src/workflows/stages/qa.ts
- src/dashboard.ts
- src/dashboard/contextEvents.ts
- src/git/GitService.ts
- src/prompt.ts
- src/tools/run_local.ts
- src/tools/run_persona_workers.ts

## Critical Findings 🔴

**14+ Dead Variables Need Investigation**:

| Variable | File | Line | Risk | Action |
|----------|------|------|------|--------|
| `isNewFile` | DiffParser.ts | 342 | Low | Investigate - tracked but unused |
| `result` | TBD | 127 | Medium | Check - missing validation? |
| `commitAndPushPaths` | TBD | 23 | Low | Remove or implement |
| `taskAPI` | Multiple | Various | Low | Remove instantiations |
| `projectAPI` | Multiple | Various | Low | Remove instantiations |
| 9+ others | Various | Various | Low-Med | Review each |

## Remaining Work

### Quick Wins (30 min)
- [ ] Remove ~45 dead imports (cfg, randomUUID, slugify)
- [ ] Remove 7 unused API instantiations
- [ ] Replace 9 @ts-ignore with @ts-expect-error

### Critical Review (60 min)
- [ ] Investigate `isNewFile` - dead code?
- [ ] Check `result` - missing error handling?
- [ ] Audit all 14 dead variables

### Optional (20 min)
- [ ] Add _ prefix to 30-40 interface params
- [ ] Add comments to empty catch blocks

## One-Line Commands

```bash
# Status
npm run lint | grep "✖.*problems"

# Find dead variables (PRIORITY)
npm run lint 2>&1 | grep "is assigned a value but never used"

# Find dead imports  
npm run lint 2>&1 | grep "is defined but never used"

# Find @ts-ignore
npm run lint 2>&1 | grep "@ts-ignore"

# Verify
npm test
```

## Documentation

- **Full Analysis**: `docs/ESLINT_WARNING_ANALYSIS.md`
- **Session Results**: `docs/ESLINT_CLEANUP_SESSION_RESULTS.md`
- **Executive Summary**: `docs/ESLINT_CLEANUP_EXECUTIVE_SUMMARY.md`
- **This Guide**: `docs/ESLINT_CLEANUP_QUICK_REF.md`

## Key Insight

**Empty catches are safe** ✅ - All 28 verified as intentional  
**Dead variables are critical** ⚠️ - May hide bugs or incomplete features  
**Tests confirm safety** ✅ - 347/347 passing throughout

---

**Next Session Target**: Reduce 198 → 50 warnings (~2 hours)
