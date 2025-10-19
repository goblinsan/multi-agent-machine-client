# Dashboard + Review Consolidation Refactor Plan
**Date:** October 19, 2025  
**Status:** Proposal  
**Priority:** High - Blocking production reliability

---

## Executive Summary

**Problem Statement:**
1. Dashboard integration is fragile with silent failures (422 errors, milestone issues)
2. Review failure handling has 3+ duplicate code paths causing bugs
3. Test suite is tightly coupled to implementation details, obscuring business intent

**Strategic Approach:**
1. **Rationalize workflows FIRST** - identify usage, extract patterns, enforce sub-workflow reuse
2. **Design new dashboard API** optimized for rationalized YAML workflows (ignore legacy API)
3. **Rationalize tests** with user validation of business intent at each step
4. **Refactor with new API** once test intentions are validated and consolidated

**Timeline:** 10 weeks (1 week workflow rationalization + original 9 weeks)  
**Risk:** Low (clean slate design, test-validated behavior, user checkpoints)  
**ROI:** High (eliminates entire class of production bugs, clear business logic)

---

## Part 1: New Dashboard Backend

### Why Replace Current Dashboard?

**Current Issues:**
- Unknown schema/API causing 422 "Unknown milestone_slug" errors
- No bulk operations (N+1 problem when creating multiple tasks)
- Unclear milestone creation logic
- 3 different code paths to same API with different bugs
- Impossible to debug (external service, no logs)

**Design Philosophy:**
- ✅ **Ignore legacy API** - fresh start, no backward compatibility
- ✅ **YAML workflow first** - API designed for how workflows actually work
- ✅ **Self-contained project** - can run standalone, extract to separate repo easily
- ✅ **Simplicity over flexibility** - support what we need, nothing more
- ✅ **Fast by default** - bulk operations, minimal round-trips
- ✅ **Debuggable** - SQL queries, full logs, local control

### Architecture

#### Technology Choices

```yaml
Runtime: Node.js + TypeScript (same stack)
Storage: SQLite with better-sqlite3
  Why: Embedded, 100K+ ops/sec, ACID, easy backup, no server
  Migration: Can move to PostgreSQL later if needed
  
API: Fastify
  Why: 2-3x faster than Express, TypeScript-native, better validation
  
Port: 8080 (configurable)
Auth: None initially (local network only)
```

#### Data Model (3 Levels)

```typescript
Project {
  id: UUID
  slug: string (unique, URL-safe)
  name: string
  repository_url?: string
  metadata?: JSON  // flexible extension
  timestamps
}

Milestone {
  id: UUID
  project_id: FK → Project
  slug: string (unique per project)
  name: string
  status: active | completed | archived
  metadata?: JSON
  timestamps
}

Task {
  id: UUID
  project_id: FK → Project
  milestone_id?: FK → Milestone (nullable)
  parent_task_id?: FK → Task (subtasks)
  external_id?: string (for deduplication)
  
  title: string
  description?: string
  status: backlog | in_progress | review | completed | blocked
  
  assignee_persona?: string
  priority_score?: number
  effort_estimate?: number
  
  metadata?: JSON
  timestamps
}
```

**Key Indexes:**
```sql
UNIQUE(slug) ON projects
UNIQUE(project_id, slug) ON milestones
UNIQUE(project_id, external_id) ON tasks WHERE external_id IS NOT NULL

INDEX(project_id) ON milestones, tasks
INDEX(milestone_id) ON tasks
INDEX(status) ON tasks
```

#### API Design

**Core Operations:**
```http
# Projects
POST   /api/v1/projects
GET    /api/v1/projects/:id
GET    /api/v1/projects/:id/status      # full tree
PATCH  /api/v1/projects/:id

# Milestones
POST   /api/v1/projects/:id/milestones
GET    /api/v1/projects/:id/milestones/:milestoneId
PATCH  /api/v1/projects/:id/milestones/:milestoneId

# Tasks
POST   /api/v1/projects/:id/tasks        # single task upsert
POST   /api/v1/projects/:id/tasks:bulk   # bulk upsert (NEW!)
GET    /api/v1/projects/:id/tasks/:taskId
PATCH  /api/v1/projects/:id/tasks/:taskId
```

**Bulk Sync (Critical for Performance):**
```http
POST /api/v1/projects/:id:sync
```
```json
{
  "milestones": [
    {
      "slug": "milestone-1",
      "name": "Phase 1",
      "status": "active"
    }
  ],
  "tasks": [
    {
      "external_id": "qa-failure-abc123",
      "title": "Fix QA failure",
      "milestone_slug": "future-enhancements",
      "status": "in_progress"
    }
  ]
}
```

**Upsert Semantics (All Operations):**
- Match by: (project_id, slug) for milestones, (project_id, external_id) for tasks
- If exists: UPDATE (merge metadata)
- If not exists: CREATE
- Always: update `updated_at`
- Return: full object with server-generated fields

**Error Responses:**
```json
{
  "error": {
    "code": "MILESTONE_NOT_FOUND",
    "message": "Milestone 'xyz' not found in project 'abc'",
    "field": "milestone_id",
    "value": "xyz"
  }
}
```

#### Project Structure

```
src/dashboard-backend/              # Self-contained project root
├── package.json                    # Independent dependencies
├── tsconfig.json                   # Own TypeScript config
├── README.md                       # Setup and usage docs
├── .env.example                    # Configuration template
│
├── index.ts                        # Server entry, process lifecycle
├── app.ts                          # Fastify app configuration
├── config.ts                       # Environment variables
│
├── db/
│   ├── schema.ts                   # TypeScript interfaces
│   ├── migrations.ts               # Schema versioning
│   └── client.ts                   # SQLite connection, queries
│
├── routes/
│   ├── projects.ts                 # GET/POST/PATCH /projects
│   ├── milestones.ts               # Milestone CRUD
│   ├── tasks.ts                    # Task CRUD + bulk
│   └── sync.ts                     # POST /:id:sync endpoint
│
├── services/
│   ├── ProjectService.ts           # Business logic
│   ├── MilestoneService.ts
│   └── TaskService.ts
│
├── validators/
│   └── schemas.ts                  # Fastify JSON schemas for validation
│
└── __tests__/
    ├── api.test.ts                 # Integration tests (hit real DB)
    ├── services.test.ts            # Unit tests (mocked DB)
    └── load.test.ts                # Performance tests
```

**Critical: Self-Contained Architecture**

The dashboard backend MUST be completely independent:

1. **No imports from parent project:**
   ```typescript
   // ❌ NEVER do this in dashboard backend
   import { logger } from '../../logger.js';
   import { makeRedis } from '../../redisClient.js';
   
   // ✅ Dashboard backend has own implementations
   import { logger } from './utils/logger.js';
   // Dashboard backend doesn't use Redis
   ```

2. **Independent package.json:**
   ```json
   {
     "name": "@multi-agent/dashboard-backend",
     "version": "1.0.0",
     "type": "module",
     "scripts": {
       "dev": "tsx watch index.ts",
       "build": "tsc",
       "test": "vitest",
       "start": "node dist/index.js"
     },
     "dependencies": {
       "fastify": "^4.0.0",
       "better-sqlite3": "^9.0.0"
     }
   }
   ```

3. **Can run standalone:**
   ```bash
   cd src/dashboard-backend
   npm install
   npm run dev
   # Server starts on port 8080, no dependency on parent project
   ```

4. **Clean HTTP boundary:**
   ```typescript
   // Main project talks to dashboard backend via HTTP only
   // src/adapters/dashboardClient.ts (in MAIN project)
   export async function createTask(task: TaskInput) {
     const response = await fetch('http://localhost:8080/api/v1/tasks', {
       method: 'POST',
       headers: { 'Content-Type': 'application/json' },
       body: JSON.stringify(task)
     });
     return response.json();
   }
   ```

5. **Extraction ready:**
   ```bash
   # To extract to separate repo:
   cp -r src/dashboard-backend ../dashboard-server
   cd ../dashboard-server
   npm install
   npm run dev
   # Works immediately, zero changes needed
   ```

**Benefits:**
- ✅ Clear separation of concerns
- ✅ Can be developed/tested independently
- ✅ Different teams can work on each project
- ✅ Can deploy as microservice later
- ✅ Easier to reason about (bounded context)
- ✅ No risk of circular dependencies
- ✅ Can have different release cadence

### Implementation Plan

**Phase 1: API Design (Week 1)**
```
Day 1: Requirements Gathering
  - Review all YAML workflows
  - Document every dashboard interaction pattern
  - Identify common operations (create task, bulk sync, query status)
  - Define success criteria

Day 2-3: API Design Workshop
  - Design endpoints from workflow perspective
  - Define request/response formats
  - Design error handling strategy
  - NO references to old API

Day 4: Schema Design
  - SQLite schema optimized for workflow queries
  - Indexes for common access patterns
  - Migration strategy

Day 5: Documentation + Review
  - Write OpenAPI spec
  - Document design decisions
  - Create examples for each endpoint
  - USER CHECKPOINT: Review API design
```

**Phase 2: Minimal Implementation (Week 3)**
```
Day 1: Project Setup (Self-Contained)
  - Create dashboard-backend/ as independent project
  - Setup package.json, tsconfig.json, README.md
  - Verify can build/run standalone
  - NO imports from parent project

Day 2: Core Backend
  - Setup SQLite + Fastify
  - Implement 3-4 critical endpoints
  - Basic validation, error handling

Day 3: Integration Layer
  - Create HTTP client adapter in main project
  - Clean HTTP boundary (no direct imports)
  - Test communication between projects

Day 4: Integration Proof
  - Create simple test workflow
  - Verify API works for real workflow case
  - Measure performance (bulk operations)

Day 5: Refinement & Verification
  - Verify project can be copied and run independently
  - Address any design issues discovered
  - USER CHECKPOINT: Validate API behavior + architecture
```

**Phase 3: Held until tests rationalized**
```
- Full backend implementation
- Refactor workflow steps to use new API
- Production deployment
(See Part 2 for detailed timeline)
```

---

## Part 2: Consolidate Review Failure Handling

### Current State (The Problem)

**Three Different Code Paths:**

1. **QAFailureCoordinationStep** (681 lines)
   ```
   QA Failure → createDashboardTaskEntriesWithSummarizer()
              → createDashboardTaskEntries()
              → createDashboardTask() [with milestone fix]
   
   Features:
   - TDD awareness (skip tasks during failing test stage)
   - Plan revision loop
   - Task creation strategy (always/never/auto)
   - Uses taskManager.ts functions
   ```

2. **ReviewFailureTasksStep** (540 lines)
   ```
   Code/Security Review → createDashboardTask() [direct]
   
   Features:
   - PM decision parsing (multiple formats)
   - Urgent vs deferred tasks
   - Milestone resolution
   - Uses dashboard.ts functions
   - DIFFERENT from QA path!
   ```

3. **ReviewCoordinationStep** (unknown)
   ```
   Status: Need to analyze
   Likely: Another variant with more duplication
   ```

**Why This Is Bad:**
- Bug fixes only apply to some paths (milestone issue)
- Different parsing logic for PM responses
- Different error handling
- Different milestone resolution
- Impossible to maintain consistency
- Tests coupled to implementation details

### Target Architecture (The Solution)

**Single Service Pattern:**

```
Any Review Type (QA, Code, Security)
  ↓
ReviewFailureService
  ↓
  ├─→ parseReviewResult()      # unified parsing
  ├─→ parsePMDecision()         # handles all formats
  └─→ createTasks()             # single task creation path
        ↓
        createDashboardTaskEntriesWithSummarizer()
          ↓
          New Dashboard Backend
```

**Key Principles:**
1. **One service** handles all review types
2. **YAML workflow** drives when/how service is called
3. **Tests** capture business logic, not implementation
4. **No special cases** - QA, Code Review, Security all use same path

### Implementation

#### Step 1: Test Analysis & Rationalization (CRITICAL FIRST STEP!)

**Goal:** Extract and validate business intent from tests BEFORE any refactoring.

**Process:** For each test group, identify intended behavior → validate with user → consolidate.

---

**Test Group 1: Review Trigger Logic**

**Current Tests:**
```
tests/qaFailureCoordination.test.ts          # QA trigger conditions
tests/reviewFlowValidation.test.ts           # Review flow triggers
tests/tddGovernanceGate.test.ts              # TDD awareness
```

**Extracted Business Intent:**
```typescript
// DRAFT - Review Trigger Requirements
// USER CHECKPOINT #1: Validate these assumptions

describe('Review Trigger Logic - Business Requirements', () => {
  test('QA review triggers when task status = implementing');
  test('Code review triggers when task status = code_complete');
  test('Security review triggers when task involves auth/data');
  test('PM evaluation triggers on FAIL status');
  test('PM evaluation triggers on UNKNOWN status');
  test('PM evaluation skips on PASS status');
  test('TDD failing test stage skips ALL task creation');
  test('TDD passing test stage allows task creation');
});
```

**Questions for User:**
1. Should PM evaluation trigger on UNKNOWN status? (Current: yes)
2. What defines "security-sensitive" tasks? (auth/data access/crypto?)
3. Should TDD stage block task creation for all review types?
4. Are there other trigger conditions we're missing?

**After validation:** Create `tests/behavior/reviewTriggers.test.ts`

---

**Test Group 2: PM Decision Parsing**

**Current Tests:**
```
tests/productionCodeReviewFailure.test.ts    # PM response formats
tests/initialPlanningAckAndEval.test.ts      # PM decision handling
tests/qaPmGating.test.ts                     # PM gating logic
```

**Extracted Business Intent:**
```typescript
// DRAFT - PM Decision Parsing Requirements
// USER CHECKPOINT #2: Validate these assumptions

describe('PM Decision Parsing - Business Requirements', () => {
  test('handles {decision: "defer", follow_up_tasks: [...]}');
  test('handles {status: "pass", backlog: [...]}');
  test('handles {decision: "immediate_fix", immediate_issues: [...]}');
  test('normalizes backlog → follow_up_tasks');
  test('normalizes status → decision');
  test('defaults to defer on unknown status');
  test('handles empty arrays gracefully');
  test('handles missing fields with defaults');
  test('handles stringified JSON responses');
  test('handles markdown code fences in response');
});
```

**Questions for User:**
1. What are ALL valid PM response formats? (need exhaustive list)
2. Should unknown status default to "defer" or "immediate_fix"?
3. Are there any PM responses that should BLOCK task creation?
4. Should PM provide reasoning/context with decisions?

**After validation:** Create `tests/behavior/pmDecisionParsing.test.ts`

---

**Test Group 3: Task Creation Logic**

**Current Tests:**
```
tests/qaFailureTaskCreation.integration.test.ts         # 520 lines
tests/codeReviewFailureTaskCreation.integration.test.ts # 520 lines
tests/taskPriorityAndRouting.test.ts                    # priority logic
```

**Extracted Business Intent:**
```typescript
// DRAFT - Task Creation Requirements
// USER CHECKPOINT #3: Validate these assumptions

describe('Task Creation - Business Requirements', () => {
  test('creates one task per follow_up_task in PM decision');
  test('urgent tasks (priority: critical|high) go to current milestone');
  test('deferred tasks (priority: medium|low) go to future-enhancements');
  test('creates milestone if missing (no error on first use)');
  test('deduplicates by external_id (same task not created twice)');
  test('applies priority_score: 1200 for urgent, 50 for deferred');
  test('includes parent_task_id for urgent tasks only');
  test('sets assignee_persona to implementation-planner');
  test('prefixes title with stage (QA:, CODE_REVIEW:, SECURITY:)');
  test('includes full description from PM decision');
});
```

**Questions for User:**
1. Priority scores (1200 urgent, 50 deferred) - are these correct?
2. Should urgent tasks ALWAYS link to parent, or only if parent exists?
3. Should assignee_persona vary by review type or always implementation-planner?
4. How should we handle subtasks vs top-level tasks?
5. Should title prefix be configurable per workflow?

**After validation:** Create `tests/behavior/taskCreation.test.ts`

---

**Test Group 4: Error Handling & Edge Cases**

**Current Tests:**
```
tests/qaFailure.test.ts                      # QA error handling
tests/blockedTaskResolution.test.ts          # blocked state handling
tests/repoResolutionFallback.test.ts         # fallback logic
```

**Extracted Business Intent:**
```typescript
// DRAFT - Error Handling Requirements
// USER CHECKPOINT #4: Validate these assumptions

describe('Error Handling - Business Requirements', () => {
  test('logs error and continues if task creation fails');
  test('returns partial success (N created, M failed)');
  test('handles dashboard API timeout (5s) gracefully');
  test('handles invalid PM response (returns 0 tasks created)');
  test('handles missing project_id (fails with clear error)');
  test('handles missing milestone gracefully (creates it)');
  test('retries transient errors (network, 5xx) up to 3 times');
  test('does NOT retry client errors (4xx except 422)');
});
```

**Questions for User:**
1. Should we retry on failure, or fail fast?
2. What's the timeout for dashboard API calls?
3. Should partial failure (some tasks created) be treated as success?
4. How should we handle duplicate task creation attempts?

**After validation:** Create `tests/behavior/errorHandling.test.ts`

---

**Test Group 5: Cross-Review Consistency**

**Current Tests:**
```
tests/severityReviewSystem.test.ts           # severity handling
tests/qaPlanIterationMax.test.ts             # iteration limits
tests/personaTimeoutRetry.test.ts            # timeout handling
```

**Extracted Business Intent:**
```typescript
// DRAFT - Cross-Review Consistency Requirements
// USER CHECKPOINT #5: Validate these assumptions

describe('Cross-Review Consistency - Business Requirements', () => {
  test('QA failure creates same task structure as Code Review');
  test('Security review uses same priority logic as Code Review');
  test('All review types respect TDD awareness setting');
  test('All review types use same PM decision parsing');
  test('All review types use same milestone resolution logic');
  test('All review types apply same retry/timeout policies');
  test('Task metadata includes review_type (qa|code_review|security)');
  test('All review types support same urgency levels');
});
```

**Questions for User:**
1. Should QA, Code Review, Security all behave IDENTICALLY?
2. Are there any legitimate differences between review types?
3. Should severity (critical/high/medium/low) map differently per review type?
4. Should iteration limits vary by review type?

**After validation:** Create `tests/behavior/crossReviewConsistency.test.ts`

---

**Rationalization Strategy:**

```
PHASE 1: Extract Intent (Week 1)
  Day 1: Analyze Test Group 1 → Create draft assumptions
  Day 2: USER CHECKPOINT #1 - Validate trigger logic assumptions
  Day 3: Analyze Test Group 2 → Create draft assumptions
  Day 4: USER CHECKPOINT #2 - Validate PM parsing assumptions
  Day 5: Analyze Test Group 3 → Create draft assumptions

PHASE 2: Validate Intent (Week 2)
  Day 1: USER CHECKPOINT #3 - Validate task creation assumptions
  Day 2: Analyze Test Group 4 → Create draft assumptions
  Day 3: USER CHECKPOINT #4 - Validate error handling assumptions
  Day 4: Analyze Test Group 5 → Create draft assumptions
  Day 5: USER CHECKPOINT #5 - Validate consistency assumptions

PHASE 3: Create Behavior Tests (Week 3)
  Day 1-2: Write reviewTriggers.test.ts + pmDecisionParsing.test.ts
  Day 3-4: Write taskCreation.test.ts + errorHandling.test.ts
  Day 5: Write crossReviewConsistency.test.ts

PHASE 4: Verify Coverage (Week 3 end)
  - Run new behavior tests (should fail - no implementation yet)
  - Run old integration tests (should pass - current implementation)
  - Verify all scenarios captured
  - USER CHECKPOINT: Final validation before refactor
```

**Critical Rules:**
1. ✅ **Extract → Validate → Consolidate** (never assume)
2. ✅ **User validation required** for EVERY test group
3. ✅ **Document questions** for each assumption
4. ✅ **No refactoring** until all checkpoints complete
5. ✅ **Behavior tests fail initially** (expected - no new implementation yet)

#### Step 2: Create Unified Service

**File:** `src/workflows/services/ReviewFailureService.ts`

```typescript
import { WorkflowContext } from '../engine/WorkflowContext.js';
import { createDashboardTaskEntriesWithSummarizer } from '../../tasks/taskManager.js';
import { interpretPersonaStatus } from '../../agents/persona.js';
import { logger } from '../../logger.js';

export interface ReviewStatus {
  status: 'pass' | 'fail' | 'unknown';
  details?: string;
  findings?: Array<{
    severity: 'severe' | 'high' | 'medium' | 'low';
    file?: string;
    line?: number;
    issue: string;
    recommendation: string;
  }>;
  tasks?: any[];
}

export interface PMDecision {
  decision: 'immediate_fix' | 'defer';
  reasoning?: string;
  immediate_issues?: string[];
  deferred_issues?: string[];
  follow_up_tasks: Array<{
    title: string;
    description: string;
    priority: 'critical' | 'high' | 'medium' | 'low';
  }>;
}

export interface TaskCreationOptions {
  stage: 'qa' | 'code_review' | 'security_review';
  urgentPriorityScore: number;
  deferredPriorityScore: number;
  projectId: string;
  milestoneId?: string;
  parentTaskId?: string;
}

export interface TaskCreationResult {
  tasksCreated: number;
  urgentTasksCreated: number;
  deferredTasksCreated: number;
  skippedDuplicates: number;
  taskIds: string[];
}

export class ReviewFailureService {
  
  /**
   * Parse review result from any review type (QA, code, security)
   * Uses interpretPersonaStatus for consistent parsing
   */
  parseReviewResult(reviewResult: any): ReviewStatus {
    const rawOutput = reviewResult?.output 
      || (typeof reviewResult === 'string' ? reviewResult : JSON.stringify(reviewResult));
    
    const statusInfo = interpretPersonaStatus(rawOutput);
    
    return {
      status: statusInfo.status as 'pass' | 'fail' | 'unknown',
      details: statusInfo.details,
      findings: statusInfo.payload?.findings || [],
      tasks: statusInfo.payload?.tasks || statusInfo.payload?.suggested_tasks || []
    };
  }
  
  /**
   * Parse PM decision from any format
   * Handles all known PM response variations
   */
  parsePMDecision(pmResult: any): PMDecision | null {
    try {
      let parsed: any = null;
      
      // Handle different input types
      if (typeof pmResult === 'object' && pmResult !== null) {
        if (pmResult.raw && typeof pmResult.raw === 'string') {
          parsed = JSON.parse(pmResult.raw);
        } else {
          parsed = pmResult;
        }
      } else if (typeof pmResult === 'string') {
        // Remove markdown code fences
        let jsonStr = pmResult.trim()
          .replace(/^```(?:json)?\s*/gm, '')
          .replace(/```\s*$/gm, '');
        parsed = JSON.parse(jsonStr);
      }
      
      if (!parsed) return null;
      
      logger.debug('PM decision before normalization', {
        hasFollowUpTasks: !!parsed.follow_up_tasks,
        followUpTasksLength: parsed.follow_up_tasks?.length || 0,
        hasBacklog: !!parsed.backlog,
        backlogLength: parsed.backlog?.length || 0,
        hasDecision: !!parsed.decision,
        hasStatus: !!parsed.status
      });
      
      // NORMALIZATION STAGE 1: Map backlog → follow_up_tasks
      if ((!parsed.follow_up_tasks || parsed.follow_up_tasks.length === 0) && 
          parsed.backlog && 
          Array.isArray(parsed.backlog) && 
          parsed.backlog.length > 0) {
        parsed.follow_up_tasks = parsed.backlog;
        logger.debug('Normalized: mapped backlog to follow_up_tasks', {
          tasksCount: parsed.backlog.length
        });
      }
      
      // NORMALIZATION STAGE 2: Map status → decision
      if (!parsed.decision && parsed.status) {
        const status = String(parsed.status).toLowerCase();
        if (['pass', 'approved', 'defer'].includes(status)) {
          parsed.decision = 'defer';
        } else if (['fail', 'failed', 'reject', 'immediate_fix'].includes(status)) {
          parsed.decision = 'immediate_fix';
        } else {
          parsed.decision = 'defer';
        }
        logger.debug('Normalized: mapped status to decision', {
          originalStatus: parsed.status,
          mappedDecision: parsed.decision
        });
      }
      
      // NORMALIZATION STAGE 3: Default decision
      if (!parsed.decision) {
        parsed.decision = 'defer';
        logger.debug('Normalized: defaulted to defer');
      }
      
      // Ensure follow_up_tasks is an array
      if (!parsed.follow_up_tasks || !Array.isArray(parsed.follow_up_tasks)) {
        parsed.follow_up_tasks = [];
      }
      
      logger.debug('PM decision after normalization', {
        decision: parsed.decision,
        followUpTasksLength: parsed.follow_up_tasks.length
      });
      
      return {
        decision: parsed.decision,
        reasoning: parsed.reasoning || parsed.details,
        immediate_issues: parsed.immediate_issues || [],
        deferred_issues: parsed.deferred_issues || [],
        follow_up_tasks: parsed.follow_up_tasks
      };
      
    } catch (error) {
      logger.warn('Failed to parse PM decision', {
        error: error instanceof Error ? error.message : String(error),
        rawType: typeof pmResult
      });
      return null;
    }
  }
  
  /**
   * Create tasks from PM decision
   * Single path for all review types
   */
  async createTasksFromPMDecision(
    context: WorkflowContext,
    pmDecision: PMDecision,
    options: TaskCreationOptions
  ): Promise<TaskCreationResult> {
    
    const tasks = pmDecision.follow_up_tasks.map(task => {
      const isUrgent = ['critical', 'high'].includes(task.priority?.toLowerCase() || '');
      const priorityScore = isUrgent ? options.urgentPriorityScore : options.deferredPriorityScore;
      
      return {
        title: `${options.stage.toUpperCase()}: ${task.title}`,
        description: task.description,
        priority: task.priority,
        priority_score: priorityScore,
        schedule: isUrgent ? 'urgent' : 'medium',
        assigneePersona: 'implementation-planner',
        stage: options.stage,
        parent_task_id: isUrgent ? options.parentTaskId : undefined
      };
    });
    
    if (tasks.length === 0) {
      logger.info('No tasks to create from PM decision', {
        stage: options.stage
      });
      return {
        tasksCreated: 0,
        urgentTasksCreated: 0,
        deferredTasksCreated: 0,
        skippedDuplicates: 0,
        taskIds: []
      };
    }
    
    // Get redis connection
    const redis = await makeRedis();
    
    try {
      // Create tasks via unified path (includes milestone fix)
      const created = await createDashboardTaskEntriesWithSummarizer(
        redis,
        context.workflowId,
        tasks,
        {
          stage: options.stage,
          milestoneDescriptor: options.milestoneId || null,
          parentTaskDescriptor: options.parentTaskId ? { id: options.parentTaskId } : null,
          projectId: options.projectId,
          projectName: context.getVariable('projectName'),
          scheduleHint: 'urgent'
        }
      );
      
      const urgentCount = created.filter(t => 
        ['critical', 'high'].includes(t.priority?.toLowerCase() || '')
      ).length;
      
      logger.info('Created tasks from PM decision', {
        stage: options.stage,
        totalCreated: created.length,
        urgentCreated: urgentCount,
        deferredCreated: created.length - urgentCount
      });
      
      return {
        tasksCreated: created.length,
        urgentTasksCreated: urgentCount,
        deferredTasksCreated: created.length - urgentCount,
        skippedDuplicates: tasks.length - created.length,
        taskIds: created.map(t => t.id).filter(Boolean)
      };
      
    } finally {
      await redis.disconnect();
    }
  }
  
  /**
   * Determine if task creation should happen
   * Considers TDD stage, task history, creation strategy
   */
  shouldCreateTasks(
    context: WorkflowContext,
    reviewStatus: ReviewStatus,
    strategy: 'always' | 'never' | 'auto',
    tddAware: boolean = true
  ): boolean {
    
    if (strategy === 'never') return false;
    if (strategy === 'always') return true;
    
    // TDD awareness: skip task creation during failing test stage
    if (tddAware) {
      const tddStage = context.getVariable('tdd_stage');
      const task = context.getVariable('task');
      const taskTddStage = task?.tdd_stage;
      
      if (tddStage === 'write_failing_test' || 
          tddStage === 'failing_test' ||
          taskTddStage === 'write_failing_test' ||
          taskTddStage === 'failing_test') {
        logger.info('Skipping task creation: TDD failing test stage', {
          tddStage: tddStage || taskTddStage
        });
        return false;
      }
    }
    
    // Auto strategy: create if review failed or unknown
    return reviewStatus.status === 'fail' || reviewStatus.status === 'unknown';
  }
}
```

#### Step 3: Refactor Workflow Steps

**QAFailureCoordinationStep** (simplified):

```typescript
export class QAFailureCoordinationStep extends WorkflowStep {
  private service = new ReviewFailureService();

  async execute(context: WorkflowContext): Promise<StepResult> {
    const config = this.config.config as QAFailureCoordinationConfig;
    const qaResult = context.getVariable('qa_result');
    
    // 1. Parse QA result
    const reviewStatus = this.service.parseReviewResult(qaResult);
    
    if (reviewStatus.status === 'pass') {
      return { status: 'success', data: { action: 'no_failure' } };
    }
    
    // 2. Check if we should create tasks
    const shouldCreate = this.service.shouldCreateTasks(
      context,
      reviewStatus,
      config.taskCreationStrategy || 'auto',
      config.tddAware !== false
    );
    
    if (!shouldCreate) {
      return { status: 'success', data: { action: 'tdd_expected_failure' } };
    }
    
    // 3. Execute PM evaluation (via workflow, not in this step)
    //    This step assumes PM has already run if needed
    
    const pmResult = context.getVariable('qa_pm_decision');
    if (!pmResult) {
      logger.warn('No PM decision found for QA failure');
      return { status: 'success', data: { action: 'no_pm_decision', tasksCreated: 0 } };
    }
    
    // 4. Parse PM decision
    const pmDecision = this.service.parsePMDecision(pmResult);
    if (!pmDecision) {
      logger.warn('Failed to parse PM decision for QA failure');
      return { status: 'success', data: { action: 'parse_failed', tasksCreated: 0 } };
    }
    
    // 5. Create tasks
    const result = await this.service.createTasksFromPMDecision(
      context,
      pmDecision,
      {
        stage: 'qa',
        urgentPriorityScore: config.urgentPriorityScore || 1200,
        deferredPriorityScore: config.deferredPriorityScore || 50,
        projectId: context.getVariable('projectId'),
        milestoneId: context.getVariable('milestoneId'),
        parentTaskId: context.getVariable('task')?.id
      }
    );
    
    return {
      status: 'success',
      data: {
        action: 'created_tasks',
        ...result
      }
    };
  }
}
```

**ReviewFailureTasksStep** (simplified):

```typescript
export class ReviewFailureTasksStep extends WorkflowStep {
  private service = new ReviewFailureService();

  async execute(context: WorkflowContext): Promise<StepResult> {
    const config = this.config.config as ReviewFailureTasksConfig;
    
    // 1. Get PM decision from context
    const pmResult = context.getVariable(config.pmDecisionVariable);
    if (!pmResult) {
      return {
        status: 'success',
        outputs: { tasks_created: 0, urgent_tasks_created: 0, deferred_tasks_created: 0 }
      };
    }
    
    // 2. Parse PM decision (unified logic)
    const pmDecision = this.service.parsePMDecision(pmResult);
    if (!pmDecision) {
      return {
        status: 'success',
        outputs: { tasks_created: 0, urgent_tasks_created: 0, deferred_tasks_created: 0 }
      };
    }
    
    // 3. Create tasks (same path as QA)
    const result = await this.service.createTasksFromPMDecision(
      context,
      pmDecision,
      {
        stage: config.reviewType,
        urgentPriorityScore: config.urgentPriorityScore || 1000,
        deferredPriorityScore: config.deferredPriorityScore || 50,
        projectId: context.getVariable('projectId'),
        milestoneId: context.getVariable('milestoneId'),
        parentTaskId: context.getVariable('task')?.id
      }
    );
    
    return {
      status: 'success',
      outputs: {
        tasks_created: result.tasksCreated,
        urgent_tasks_created: result.urgentTasksCreated,
        deferred_tasks_created: result.deferredTasksCreated
      }
    };
  }
}
```

**Lines of Code Reduction:**
- Before: 681 + 540 = 1221 lines
- After: ~150 + ~100 + 300 (service) = 550 lines
- **Reduction: 55% fewer lines!**

#### Step 4: Simplify YAML Workflow

**Before** (complex, confusing):
```yaml
# Multiple custom step types, unclear coordination
- name: qa_failure_coordination
  type: qa_failure_coordination  # custom!
  
- name: create_code_review_followup_tasks
  type: review_failure_tasks  # different custom type!
```

**After** (consistent pattern):
```yaml
# QA workflow
- name: qa_review
  type: persona_request
  persona: tester-qa
  outputs: [qa_result]

- name: qa_pm_evaluation
  type: persona_request
  persona: project-manager
  intent: prioritize_qa_failures
  condition: "${qa_review_status} == 'fail' || ${qa_review_status} == 'unknown'"
  inputs:
    qa_result: ${qa_result}
  outputs: [qa_pm_decision]

- name: qa_create_tasks
  type: qa_failure_coordination  # uses ReviewFailureService internally
  condition: "${qa_pm_evaluation_status} == 'success'"
  config:
    pmDecisionVariable: qa_pm_decision
    urgentPriorityScore: 1200

# Code Review workflow (SAME PATTERN)
- name: code_review
  type: persona_request
  persona: code-reviewer
  outputs: [code_review_result]

- name: code_review_pm_evaluation
  type: persona_request
  persona: project-manager
  intent: prioritize_code_review_failures
  condition: "${code_review_status} == 'fail' || ${code_review_status} == 'unknown'"
  inputs:
    review_result: ${code_review_result}
  outputs: [code_review_pm_decision]

- name: code_review_create_tasks
  type: review_failure_tasks  # uses ReviewFailureService internally
  condition: "${code_review_pm_evaluation_status} == 'success'"
  config:
    pmDecisionVariable: code_review_pm_decision
    reviewType: code_review
```

**Key Improvements:**
- Same pattern for all review types
- Clear dependencies via conditions
- Explicit inputs/outputs
- No embedded coordination logic
- Easy to understand and test

#### Step 5: Remove Legacy Code

**Files to Delete:**
```bash
src/workflows/steps/ReviewCoordinationSteps.ts  # old, likely unused
src/workflows/helpers/stageHelpers.ts            # if only used by old paths

# After consolidation complete:
src/workflows/steps/QAFailureCoordinationStep.ts  # replace with simpler version
# Keep ReviewFailureTasksStep but simplified
```

**Functions to Remove:**
```typescript
// dashboard.ts - after all uses migrated to taskManager.ts
// Keep createDashboardTask for now (backward compat)
// But all new code should use taskManager.ts
```

**Search for Legacy References:**
```bash
grep -r "legacy" src/workflows/
grep -r "coordinator" src/workflows/
grep -r "stage.*helper" src/workflows/
# Remove all found references
```

### Migration Timeline (REVISED)

**Weeks 1-3: Test Rationalization** (MUST COMPLETE FIRST)
- Week 1: Extract business intent from Test Groups 1-3
  - USER CHECKPOINTS #1, #2, #3
- Week 2: Extract business intent from Test Groups 4-5
  - USER CHECKPOINTS #4, #5
- Week 3: Write consolidated behavior tests
  - Final USER CHECKPOINT before refactor

**Week 4: Service Implementation** (After tests validated)
- Day 1-2: Implement ReviewFailureService with all methods
- Day 3: Unit test service in isolation
- Day 4-5: Integration with new dashboard API

**Week 5: Step Refactoring**
- Day 1-2: Refactor QAFailureCoordinationStep to use service + new API
- Day 3-4: Refactor ReviewFailureTasksStep to use service + new API
- Day 5: Update all tests to pass

**Week 6: Cleanup & Validation**
- Day 1-2: Simplify YAML workflows
- Day 3: Remove old code paths + old integration tests
- Day 4: Update documentation
- Day 5: Production deployment + monitoring

---

## Success Criteria

### Dashboard Backend
- [ ] All 264 existing tests pass with new backend
- [ ] Load test: 1000 tasks created in <1 second
- [ ] Zero 422 "Unknown milestone" errors in production
- [ ] Bulk sync endpoint reduces API calls by 90%+
- [ ] Dashboard backend can be extracted to separate repo

### Review Consolidation
- [ ] Single ReviewFailureService used by all review types
- [ ] QA, Code Review, Security Review use identical code paths
- [ ] Test suite reduced by 30%+ lines via consolidation
- [ ] YAML workflow under 300 lines (from 600+)
- [ ] Zero references to "legacy" in workflow code
- [ ] All review types handle PM responses consistently

---

## Risk Mitigation

**Dashboard Backend:**
- **Risk:** SQLite performance issues at scale
  - **Mitigation:** Load test early, can migrate to PostgreSQL
  - **Fallback:** Keep old dashboard integration temporarily

- **Risk:** Breaking workflows during migration
  - **Mitigation:** Adapter layer, feature flag, gradual rollout
  - **Fallback:** Git rollback, old code preserved

**Consolidation:**
- **Risk:** Losing functionality during refactor
  - **Mitigation:** Test-first approach, behavior tests capture all scenarios
  - **Fallback:** Git history preserves old implementations

- **Risk:** YAML changes break production
  - **Mitigation:** Deploy with feature flag, gradual workflow migration
  - **Fallback:** Keep old YAML files until validated

---

## Recommended Execution Order (REVISED)

**Phase 0: Workflow Rationalization** (Week 1, ~20 hours) **← NEW PREREQUISITE**
- Inventory all workflows, identify which are used
- Extract common patterns (review failures, task creation, etc.)
- Design sub-workflow components for reuse
- Propose rationalization strategy
- USER CHECKPOINT #0: Validate workflow assumptions

**Phase 1: Dashboard API Design** (Week 2-3, ~10 hours)
- Design API from rationalized workflow perspective (ignore legacy)
- Create OpenAPI spec + examples
- Minimal implementation proof (3-4 endpoints)
- USER CHECKPOINT #1: Validate API design

**Phase 2: Test Rationalization** (Week 4-6, ~60 hours)
- Extract business intent from existing tests
- USER CHECKPOINTS #3-7 (one per test group)
- Write consolidated behavior tests
- USER CHECKPOINT #8 before refactor

**Phase 3: Refactor with New API** (Week 7-8, ~40 hours)
- Implement ReviewFailureService
- Refactor workflow steps to use service + new API
- Update behavior tests to pass
- Delete old integration tests

**Phase 4: Complete Dashboard Backend & Workflow Migration** (Week 9-10, ~40 hours)
- Finish remaining dashboard endpoints
- Migrate to rationalized sub-workflow structure
- Production deployment
- Monitoring + validation

**Total Timeline:** 10 weeks (conservative, with user validation gates)

**Why This Order:**
1. ✅ **Workflow rationalization first** - establishes what we're actually building for
2. ✅ **API design based on real patterns** - not guessing at requirements
3. ✅ **Tests validate assumptions** - no surprises during refactor
4. ✅ **User checkpoints** - ensure we're solving right problems
5. ✅ **Clean implementation** - tests guide refactor, not vice versa
6. ✅ **Low risk** - validated behavior before any changes

---

## Next Steps (Ready to Execute)

### Immediate Actions

1. **USER APPROVAL:** Review and approve this plan
2. **Start Phase 1:** Dashboard API Design (Week 1-2)
   ```bash
   # Create design branch
   git checkout -b feature/dashboard-api-design
   
   # Start design document
   mkdir -p docs/dashboard-api
   # Begin API requirements gathering
   ```

### First Checkpoint: API Design Review

**Deliverables for USER CHECKPOINT:**
1. OpenAPI specification (dashboard-api/spec.yml)
2. Example request/response for each endpoint
3. Design decisions document (why this approach)
4. Simple proof-of-concept (3-4 endpoints working)

**Review Questions:**
- Does API match how YAML workflows actually work?
- Are there any missing operations?
- Is error handling clear and actionable?
- Are request/response formats intuitive?

### Second Checkpoint: Test Group 1 Analysis

**Deliverables for USER CHECKPOINT #1:**
1. Extracted business intent from trigger logic tests
2. Draft test scenarios (see Step 1 above)
3. Specific questions about assumptions

**No coding until approved!**

---

## Questions for User (Before Starting)

1. **Timeline:** Is 9 weeks acceptable? (Conservative estimate)
2. **Availability:** Can you review checkpoints within 24-48 hours?
3. **Priority:** Any specific pain points to address first?
4. **Scope:** Should we include other review types (security, architecture)?
5. **Dashboard Location:** Same repo or separate from start?

---

## Critical Success Factors

1. ✅ **User validation at EVERY checkpoint** (no assumptions)
2. ✅ **No refactoring until tests validated** (behavior locked in)
3. ✅ **API designed for workflows, not legacy** (clean slate)
4. ✅ **Documentation as we go** (not at end)
5. ✅ **Incremental delivery** (show progress each week)
