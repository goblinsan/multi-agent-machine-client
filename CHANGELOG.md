# Multi-Agent Machine Client - Changelog

## Current State (October 2025)

A Redis-based distributed multi-agent coordination system that manages tasks across multiple machines using persona-based workflows with comprehensive TDD-aware coordination.

### Test Suite Status
- **123 tests passing** | 3 skipped (126 total)
- Duration: ~2.7s
- Framework: Vitest with comprehensive mocks

---

## Recent Major Enhancements

### Task Priority & Workflow Routing (Oct 2025)

**Problem**: Tasks were processed in wrong order (in_progress first, blocked last) with no specialized workflows for blocked or in-review tasks.

**Solution**:
- ✅ Fixed priority order: `blocked (0)` > `in_review (1)` > `in_progress (2)` > `open (3)`
- ✅ Added priority sorting in WorkflowCoordinator with `compareTaskPriority()` method
- ✅ Created `blocked-task-resolution.yaml` workflow with max attempts (default: 10)
- ✅ Created `in-review-task-flow.yaml` workflow (skips implementation, goes to reviews)
- ✅ Smart workflow routing based on task status
- ✅ 17 new tests (5 for blocked tasks + 12 for priority/routing)

**Files Modified**:
- `src/tasks/taskManager.ts` - Fixed TASK_STATUS_PRIORITY map
- `src/workflows/WorkflowCoordinator.ts` - Added sorting and routing
- `src/workflows/WorkflowEngine.ts` - Registered new steps
- `src/config.ts` - Added blockedMaxAttempts config

**Files Created**:
- `src/workflows/definitions/blocked-task-resolution.yaml` (75 lines)
- `src/workflows/definitions/in-review-task-flow.yaml` (90 lines)
- `src/workflows/steps/BlockedTaskAnalysisStep.ts` (217 lines)
- `src/workflows/steps/UnblockAttemptStep.ts` (282 lines)
- `tests/blockedTaskResolution.test.ts` (289 lines, 5 tests)
- `tests/taskPriorityAndRouting.test.ts` (619 lines, 12 tests)

**Configuration**:
```bash
BLOCKED_MAX_ATTEMPTS=10  # Max unblock attempts before escalation
```

---

### QA Iteration Loop (Oct 2025)

**Problem**: QA failures were handled with single retry, despite `COORDINATOR_MAX_REVISION_ATTEMPTS=unlimited` config.

**Solution**:
- ✅ Created `QAIterationLoopStep` - complete iterative loop
- ✅ Replaced 6 individual steps with unified loop step
- ✅ Supports unlimited iterations (respects env config)
- ✅ Passes cumulative history to each iteration
- ✅ Automatically updates task status on success

**Files Modified**:
- `src/workflows/definitions/legacy-compatible-task-flow.yaml`
- `src/workflows/WorkflowEngine.ts` - Registered QAIterationLoopStep

**Files Created**:
- `src/workflows/steps/QAIterationLoopStep.ts` (400+ lines)

**Flow**: QA fail → Plan fixes → Implement → Apply → Commit → Retest → Loop until pass

---

### Task Status Updates (Oct 2025)

**Problem**: Tasks never updated status on dashboard during workflow execution.

**Solution**:
- ✅ Added status updates at key workflow stages:
  - `in_progress` - After checkout (work starts)
  - `in_review` - After QA passes (entering reviews)
  - `blocked` - On workflow failure (needs intervention)
  - `done` - After all reviews (already existed)

**Files Modified**:
- `src/workflows/definitions/legacy-compatible-task-flow.yaml` (added 3 status steps)

**Impact**: Dashboard now shows real-time task progress

---

### Distributed Coordination Fixes (Oct 2025)

**Problem**: Coordinator passed local machine paths to remote agents, causing failures.

**Solution**:
- ✅ PersonaRequestStep now exclusively uses `repo_remote` URL
- ✅ WorkflowCoordinator validates remote URL exists before execution
- ✅ Added clear error messages when remote URL unavailable
- ✅ Prevents any local paths from being sent to distributed agents

**Files Modified**:
- `src/workflows/steps/PersonaRequestStep.ts`
- `src/workflows/WorkflowCoordinator.ts`

**Impact**: Remote agents can now properly clone and work with repositories

---

### DiffApply Branch Bug Fix (Oct 2025)

**Problem**: DiffApplyStep checked out task branch BEFORE applying diffs, causing failures.

**Solution**:
- ✅ Apply diffs first (on current HEAD)
- ✅ Then check out task branch
- ✅ Merge the diff-applied changes

**Files Modified**:
- `src/workflows/steps/DiffApplyStep.ts`

**Flow**: Apply diffs on HEAD → Checkout task branch → Merge changes

---

### Test Suite Improvements (Oct 2025)

**Key Principles**:
- ✅ Use declarative workflow steps
- ✅ Test business outcomes, not implementation details
- ✅ Work with WorkflowEngine architecture
- ✅ Proper Redis + dashboard mocking

**Resolved Tests**:
- ✅ Happy Path Test - Fixed with Redis mocking
- ✅ QA Created Tasks Test - Fixed with QAFailureCoordinationStep
- ✅ QA Plan Iteration Max Test - Fixed with safe timeout protection
- ✅ QA Failure Plan Evaluation Test - Fixed with declarative approach
- ✅ 12 new priority/routing tests
- ✅ 5 new blocked task tests

---

## Architecture Overview

### Core Components

**Workflow System**:
- `src/workflows/WorkflowCoordinator.ts` - Main orchestration with priority sorting
- `src/workflows/WorkflowEngine.ts` - Step execution and registration
- `src/workflows/definitions/` - YAML workflow definitions

**Agent System**:
- `src/agents/persona.ts` - Persona implementations
- `src/personas.ts` - Persona type definitions
- Redis Streams for async persona communication

**Task Management**:
- `src/tasks/taskManager.ts` - Task selection with priority support
- `src/milestones/milestoneManager.ts` - Milestone tracking
- Dashboard API integration for status updates

**Git Operations**:
- `src/git/GitService.ts` - Git operations wrapper
- `src/branchUtils.ts` - Branch management
- `src/gitUtils.ts` - Git utilities

### Workflow Definitions

1. **legacy-compatible-task-flow.yaml** - Main workflow
   - Context scanning
   - Planning with TDD gates
   - Implementation
   - QA iteration loop
   - Code/Security/DevOps reviews
   - Status updates

2. **blocked-task-resolution.yaml** - Blocked task handling
   - Max attempts check
   - Blockage analysis (reads Redis workflow events)
   - Context request
   - Lead engineer analysis
   - Unblock attempt (5 strategies)
   - Validation
   - Status updates

3. **in-review-task-flow.yaml** - Resume in-review tasks
   - Checkout branch
   - Pull latest
   - Code/Security/DevOps reviews (parallel)
   - Mark done or blocked

### Key Configuration

```bash
# Task Priority
# blocked (0) > in_review (1) > in_progress (2) > open (3)

# Blocked Task Resolution
BLOCKED_MAX_ATTEMPTS=10

# QA Iteration Loop
COORDINATOR_MAX_REVISION_ATTEMPTS=unlimited  # or numeric limit

# Project Base
PROJECT_BASE=/path/to/repos

# Redis Connection
REDIS_HOST=localhost
REDIS_PORT=6379

# Dashboard API
DASHBOARD_API_BASE=http://localhost:3000/api
DASHBOARD_API_KEY=your-key
```

---

## Testing

```bash
# Run all tests
npm test

# Run specific test file
npm test tests/taskPriorityAndRouting.test.ts

# Run blocked task tests
npm test tests/blockedTaskResolution.test.ts
```

### Test Helpers

- `tests/setup.ts` - Shared test setup
- `tests/makeTempRepo.ts` - Creates temp git repos for testing
- `tests/helpers/` - Test utilities

### Testing Checklist

- ✅ Remote agents can access repos via remote URL
- ✅ Planning loop exits on first Pass evaluation
- ✅ Implementation diffs are applied to files
- ✅ Milestone info appears in persona payloads
- ✅ Critical errors stop workflow execution
- ✅ Task priority order (blocked first)
- ✅ Workflow routing based on status
- ✅ Blocked task resolution attempts

---

## Deployment

### Environment Variables

```bash
# Required on all machines
PROJECT_BASE=/path/to/repos

# Redis Connection
REDIS_HOST=localhost
REDIS_PORT=6379

# Dashboard API
DASHBOARD_API_BASE=http://localhost:3000/api
DASHBOARD_API_KEY=your-key

# Optional
MC_ALLOW_WORKSPACE_GIT=1  # Allow workspace repo mutations
BLOCKED_MAX_ATTEMPTS=10  # Blocked task max attempts
COORDINATOR_MAX_REVISION_ATTEMPTS=unlimited  # QA loop iterations
```

### Deployment Steps

1. Pull latest changes to all machines
2. Verify `PROJECT_BASE` is set on all machines
3. Ensure dashboard projects have repository URLs configured
4. Test with a simple task first
5. Monitor logs for any remote URL resolution issues
6. Verify task priority order in coordinator logs

### Common Issues

**"No repository remote URL available"**
- Cause: Project missing repository URL in dashboard
- Fix: Set repository URL in project settings

**"Cannot access repo path"**
- Cause: Agent trying to use coordinator's local path
- Fix: Ensure PersonaRequestStep changes are deployed

**"No diff content found"**
- Cause: Lead-engineer response format changed
- Fix: Check DiffApplyStep logs, verify getDiffContent() logic

**Tasks processed in wrong order**
- Cause: Priority sorting not working
- Fix: Check taskManager.ts TASK_STATUS_PRIORITY map

**Blocked tasks not unblocking**
- Cause: Max attempts reached or analysis failed
- Fix: Check Redis logs for workflow events, increase BLOCKED_MAX_ATTEMPTS

---

## Development Patterns

- Use existing TypeScript patterns from `src/`
- Follow test patterns in `tests/` directory
- Git operations must use temp directories in tests
- Persona system handles different agent types
- Redis streams for async communication
- WorkflowEngine for step registration and execution

---

## Future Enhancements

### Blocked Task Resolution
- Strategy effectiveness tracking
- Machine learning for strategy selection
- Automatic subtask creation
- Integration with issue tracking systems

### Task Priority
- Dynamic priority adjustment based on urgency
- Priority boosting for aging tasks
- Team capacity-based prioritization

### Workflow System
- Workflow templates for common patterns
- Visual workflow editor
- Workflow analytics and metrics
- Conditional workflow routing

---

## Documentation

- `README.md` - Project overview and setup
- `docs/WORKFLOW_SYSTEM.md` - Workflow system documentation
- `.github/copilot-instructions.md` - Development guidelines
- This file - Comprehensive changelog

---

## Contributors

Development by the Multi-Agent Coordination Team with TDD-aware coordination patterns.
