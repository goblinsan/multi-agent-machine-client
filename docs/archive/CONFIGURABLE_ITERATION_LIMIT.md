# Configurable Iteration Limit for Large Projects

**Date**: October 13, 2025  
**Issue**: Fixed hardcoded iteration limit that was too low for large projects

## Problem

The previous hardcoded limit of 100 iterations was insufficient for projects with >100 tasks:

```typescript
// OLD - Too low for large projects
const maxIterations = this.isTestEnv() ? 2 : 100;
```

Since each iteration processes 1 task:
- **100 iterations** = max 100 tasks
- A project with 150 tasks would hit the limit prematurely
- No way to adjust without code changes

## Solution

Made the iteration limit configurable via environment variable with a much higher default:

```typescript
// NEW - Configurable with sensible default
const maxIterations = this.isTestEnv() ? 2 : (cfg.coordinatorMaxIterations ?? 500);
```

### Configuration Added

**Environment Variable**: `COORDINATOR_MAX_ITERATIONS`

**Default**: 500 iterations (supports projects with 500+ tasks)

**Config Module** (`src/config.ts`):
```typescript
const coordinatorMaxIterations = parseRevisionLimit(
  process.env.COORDINATOR_MAX_ITERATIONS, 
  500 // Default: 5x higher than before
);
```

### Usage Examples

**Default (500 tasks)**:
```bash
# No configuration needed - handles 500 tasks by default
npm start
```

**Large Project (1000 tasks)**:
```bash
COORDINATOR_MAX_ITERATIONS=1000 npm start
```

**Very Large Project (unlimited)**:
```bash
COORDINATOR_MAX_ITERATIONS=unlimited npm start
```

**Custom Limit**:
```bash
COORDINATOR_MAX_ITERATIONS=250 npm start
```

## Benefits

1. **Large Project Support**: Default 500 iterations handles most projects
2. **Configurable**: Can be adjusted without code changes
3. **Safety Preserved**: Still prevents infinite loops, just with higher ceiling
4. **Unlimited Option**: Can disable limit entirely with `unlimited` keyword
5. **Test Speed**: Tests still use 2 iterations for fast execution

## Use Cases

### Small Projects (< 100 tasks)
- Use default (500)
- No configuration needed

### Medium Projects (100-500 tasks)
- Use default (500)
- No configuration needed

### Large Projects (500-1000 tasks)
```bash
COORDINATOR_MAX_ITERATIONS=1000
```

### Very Large Projects (1000+ tasks)
```bash
COORDINATOR_MAX_ITERATIONS=2000
# Or
COORDINATOR_MAX_ITERATIONS=unlimited  # Use with caution
```

### Development/Testing
```bash
# Tests automatically use 2 iterations
npm test

# For manual testing with small iteration limit
COORDINATOR_MAX_ITERATIONS=5 npm start
```

## Safety Considerations

**When to Use `unlimited`**:
- ✅ Trusted dashboard with finite task lists
- ✅ Well-tested workflows that mark tasks as done
- ✅ Projects with proper task completion logic

**When NOT to Use `unlimited`**:
- ❌ Workflows that might create infinite follow-up tasks
- ❌ Untested task status update logic
- ❌ Development/debugging scenarios

**Recommended Approach**:
1. Start with default (500)
2. If you hit the limit, check logs for warning
3. Increase to specific value (1000, 2000) based on project size
4. Only use `unlimited` if absolutely necessary

## Monitoring

The coordinator logs a warning when hitting the iteration limit:

```typescript
if (iterationCount >= maxIterations) {
  logger.warn("Hit maximum iteration limit", {
    maxIterations,
    remainingTasks: await getRemainingTaskCount(projectId)
  });
}
```

**Example Log**:
```
WARN: Hit maximum iteration limit
  maxIterations: 500
  remainingTasks: 23
```

This indicates you should increase `COORDINATOR_MAX_ITERATIONS`.

## Documentation Updates

**Updated Files**:
1. `src/config.ts` - Added `coordinatorMaxIterations` configuration
2. `src/workflows/WorkflowCoordinator.ts` - Uses config instead of hardcoded 100
3. `docs/WORKFLOW_SYSTEM.md` - Added to configuration section
4. `docs/ARCHITECTURE_CLARIFICATION.md` - Updated iteration limit references
5. `docs/PROJECT_LOOP_ITERATION_STRATEGY.md` - Updated configuration section

**Configuration Reference** (docs/WORKFLOW_SYSTEM.md):
```bash
# Workflow Limits
COORDINATOR_MAX_ITERATIONS=500               # Project loop max iterations (default 500)
COORDINATOR_MAX_REVISION_ATTEMPTS=unlimited  # QA loop iterations
BLOCKED_MAX_ATTEMPTS=10                      # Blocked task resolution attempts
```

## Testing

All 139 tests passing with new configuration system:
- Tests automatically use 2 iterations (not affected by config)
- Production default raised from 100 to 500
- Environment variable properly parsed and used

## Migration

**No Breaking Changes**:
- Default increased from 100 → 500 (better for everyone)
- Existing deployments work without changes
- Only need to set env var if project has >500 tasks

**For Projects with >100 tasks** (previously hitting limit):
```bash
# Add to deployment configuration
COORDINATOR_MAX_ITERATIONS=1000
```

## Related Configuration

Other coordinator limits (unchanged):
```bash
COORDINATOR_MAX_REVISION_ATTEMPTS=5  # Individual workflow revision attempts
COORDINATOR_MAX_APPROVAL_RETRIES=3   # Plan approval retries
```

These are **per-workflow** limits, not project-level iteration limits.
