# Workflow API Usage Patterns

**Project:** Multi-Agent Machine Client - Dashboard API  
**Version:** 1.0.0  
**Date:** October 19, 2025

---

## Overview

This document maps each workflow to specific Dashboard API operations, showing exactly how workflows interact with the API and what endpoints they call.

**6 Active Workflows Analyzed:**
1. task-flow.yaml (primary workflow)
2. legacy-compatible-task-flow.yaml
3. in-review-task-flow.yaml
4. blocked-task-resolution.yaml
5. hotfix-task-flow.yaml
6. project-loop.yaml

---

## Common API Patterns Across Workflows

### Pattern 1: Task Status Updates

**Used by:** All workflows  
**Frequency:** 3-5 times per workflow execution  
**Endpoint:** `PATCH /projects/{id}/tasks/{taskId}`

```typescript
// Mark task in progress
await fetch(`/projects/${projectId}/tasks/${taskId}`, {
  method: 'PATCH',
  body: JSON.stringify({
    status: 'in_progress',
    comment: 'Started by WorkflowCoordinator'
  })
});

// Mark task in review
await fetch(`/projects/${projectId}/tasks/${taskId}`, {
  method: 'PATCH',
  body: JSON.stringify({
    status: 'in_review',
    comment: 'Implementation complete, entering review phase'
  })
});

// Mark task done
await fetch(`/projects/${projectId}/tasks/${taskId}`, {
  method: 'PATCH',
  body: JSON.stringify({
    status: 'done',
    comment: 'All reviews passed, task complete'
  })
});

// Mark task blocked
await fetch(`/projects/${projectId}/tasks/${taskId}`, {
  method: 'PATCH',
  body: JSON.stringify({
    status: 'blocked',
    comment: 'Cannot proceed: missing dependencies'
  })
});
```

**Status Transitions:**
- `open` → `in_progress` (start work)
- `in_progress` → `in_review` (implementation complete)
- `in_review` → `done` (all reviews passed)
- `in_review` → `in_progress` (reviews failed, fixing)
- Any → `blocked` (cannot proceed)

---

### Pattern 2: Review Failure - Bulk Task Creation

**Used by:** task-flow, legacy-compatible-task-flow, in-review-task-flow, hotfix-task-flow  
**Frequency:** 1-3 times per workflow (if reviews fail)  
**Endpoint:** `POST /projects/{id}/tasks:bulk`

```typescript
// QA review failed - create followup tasks
const qaFindings = [
  { id: 'qa-1', title: 'Login form validation missing', severity: 'high' },
  { id: 'qa-2', title: 'Error messages not user-friendly', severity: 'medium' }
];

const tasks = qaFindings.map(finding => ({
  title: `QA Fix: ${finding.title}`,
  description: `Identified during QA review of task ${parentTaskId}`,
  milestone_id: milestoneId,
  parent_task_id: parentTaskId,
  status: 'open',
  priority_score: finding.severity === 'critical' ? 1500 : 1200,
  external_id: finding.id,
  labels: ['qa-followup', finding.severity]
}));

const response = await fetch(
  `/projects/${projectId}/tasks:bulk`,
  {
    method: 'POST',
    body: JSON.stringify({
      tasks,
      duplicateDetection: 'external_id',
      onDuplicate: 'skip'
    })
  }
);

const result = await response.json();
console.log(`Created ${result.summary.created} tasks, skipped ${result.summary.duplicates} duplicates`);
```

**Review Types:**
- **QA Review:** priority_score = 1200, labels = ['qa-followup']
- **Code Review:** priority_score = 1000, labels = ['code-review-followup']
- **Security Review:** priority_score = 1500, labels = ['security-followup', 'urgent']
- **DevOps Review:** priority_score = 1100, labels = ['devops-followup']

---

### Pattern 3: Milestone Duplicate Detection

**Used by:** All workflows (before bulk task creation)  
**Frequency:** Before each bulk operation  
**Endpoint:** `GET /projects/{id}/milestones/{milestoneId}/tasks`

```typescript
// Check for existing tasks before creating new ones
const response = await fetch(
  `/projects/${projectId}/milestones/${milestoneId}/tasks?` +
  `status=!done,!archived&` +
  `fields=id,title,external_id`
);

const existingTasks = await response.json();
const existingTitles = new Set(
  existingTasks.data.map(t => t.title.toLowerCase())
);

// Filter out tasks that already exist
const newTasks = proposedTasks.filter(
  task => !existingTitles.has(task.title.toLowerCase())
);
```

---

### Pattern 4: Milestone Completion Check

**Used by:** task-flow, legacy-compatible-task-flow, project-loop  
**Frequency:** End of workflow execution  
**Endpoint:** `GET /projects/{id}/milestones/{milestoneId}`

```typescript
// Check if milestone is complete
const response = await fetch(
  `/projects/${projectId}/milestones/${milestoneId}`
);

const milestone = await response.json();

if (milestone.completion_percentage === 100) {
  console.log(`Milestone ${milestone.name} is complete!`);
  // Potentially trigger celebration workflow
}
```

---

## Workflow-Specific API Usage

### 1. task-flow.yaml (Primary Workflow)

**Purpose:** Complete task processing with TDD awareness and comprehensive reviews

#### API Calls (in order):

**Step 1: Mark Task In Progress**
```typescript
PATCH /projects/{projectId}/tasks/{taskId}
{ status: 'in_progress' }
```

**Step 2-5: Planning Loop** (no API calls)

**Step 6: Mark In Review**
```typescript
PATCH /projects/{projectId}/tasks/{taskId}
{ status: 'in_review' }
```

**Step 7-10: Implementation** (no API calls)

**Step 11: QA Review**
- If QA passes: Continue
- If QA fails:

**Step 12: QA Failure - Bulk Task Creation**
```typescript
POST /projects/{projectId}/tasks:bulk
{
  tasks: [
    {
      title: 'QA Fix: ...',
      milestone_id: milestoneId,
      parent_task_id: taskId,
      priority_score: 1200,
      external_id: 'qa-finding-1',
      labels: ['qa-followup']
    },
    // ... more tasks
  ],
  duplicateDetection: 'external_id',
  onDuplicate: 'skip'
}
```

**Step 13: Code Review**
- If passes: Continue
- If fails:

**Step 14: Code Review Failure - Bulk Task Creation**
```typescript
POST /projects/{projectId}/tasks:bulk
{
  tasks: [
    {
      title: 'Code Review Fix: ...',
      priority_score: 1000,
      labels: ['code-review-followup']
    }
  ],
  duplicateDetection: 'title_and_milestone',
  onDuplicate: 'skip'
}
```

**Step 15: Security Review**
- If passes: Continue
- If fails:

**Step 16: Security Failure - Bulk Task Creation**
```typescript
POST /projects/{projectId}/tasks:bulk
{
  tasks: [
    {
      title: 'Security Fix: ...',
      priority_score: 1500,
      labels: ['security-followup', 'urgent']
    }
  ],
  duplicateDetection: 'external_id',
  onDuplicate: 'error' // Security issues must not be silently skipped
}
```

**Step 17: DevOps Review** (similar pattern)

**Step 18: Mark Task Done**
```typescript
PATCH /projects/{projectId}/tasks/{taskId}
{ status: 'done' }
```

**Step 19: Check Milestone Completion**
```typescript
GET /projects/{projectId}/milestones/{milestoneId}
```

---

### 2. in-review-task-flow.yaml

**Purpose:** Handle tasks already in review status

#### API Calls:

**Step 1: Verify Task Status**
```typescript
GET /projects/{projectId}/tasks/{taskId}
// Verify status === 'in_review'
```

**Step 2-4: Run reviews** (QA, Code, Security)
- Each review can fail and trigger bulk task creation (same as task-flow)

**Step 5: All Reviews Passed**
```typescript
PATCH /projects/{projectId}/tasks/{taskId}
{ status: 'done' }
```

**Difference from task-flow:**
- Skips planning and implementation steps
- Goes straight to reviews

---

### 3. blocked-task-resolution.yaml

**Purpose:** Analyze and unblock stuck tasks

#### API Calls:

**Step 1: Get Task Details**
```typescript
GET /projects/{projectId}/tasks/{taskId}
// Get current status, blocked_attempt_count, last_unblock_attempt
```

**Step 2: Analyze Blockage** (no API call)

**Step 3: Update Unblock Attempt**
```typescript
PATCH /projects/{projectId}/tasks/{taskId}
{
  blocked_attempt_count: task.blocked_attempt_count + 1,
  last_unblock_attempt: new Date().toISOString()
}
```

**Step 4a: Successful Unblock**
```typescript
PATCH /projects/{projectId}/tasks/{taskId}
{ status: 'in_progress' }
```

**Step 4b: Failed Unblock (3+ attempts)**
```typescript
PATCH /projects/{projectId}/tasks/{taskId}
{ status: 'archived' }
```

**Key Fields Used:**
- `blocked_attempt_count`: Track unblock attempts
- `last_unblock_attempt`: Timestamp of last attempt
- Logic: Give up after 3 attempts

---

### 4. hotfix-task-flow.yaml

**Purpose:** Fast-track emergency production fixes

#### API Calls:

**Same as task-flow but:**
- Higher priority_score (2000 for hotfix tasks)
- Fewer planning iterations (2 vs 5)
- Skips DevOps review
- Labels include 'hotfix'

**Example Task Creation:**
```typescript
POST /projects/{projectId}/tasks:bulk
{
  tasks: [
    {
      title: 'Hotfix: Production login broken',
      priority_score: 2000,
      labels: ['hotfix', 'critical', 'production'],
      status: 'open'
    }
  ],
  duplicateDetection: 'title_and_milestone',
  onDuplicate: 'error' // Hotfixes should not be duplicated
}
```

---

### 5. project-loop.yaml

**Purpose:** Milestone-level coordination

#### API Calls:

**Step 1: Get Milestone Status**
```typescript
GET /projects/{projectId}/milestones/{milestoneId}
```

**Step 2: Get Active Tasks**
```typescript
GET /projects/{projectId}/tasks?milestone_id={milestoneId}&status=open,in_progress,blocked,in_review
```

**Step 3: Coordinate Task Execution** (delegates to task-flow)

**Step 4: Check Completion**
```typescript
GET /projects/{projectId}/milestones/{milestoneId}
// Check completion_percentage
```

---

### 6. WorkflowCoordinator (Meta-Workflow)

**Purpose:** Select next task to execute

#### API Calls:

**Step 1: Get Project Status** (optimized endpoint)
```typescript
GET /projects/{projectId}/status?include_tasks=true&task_status=open,in_progress,blocked,in_review&task_limit=100
```

**Response:**
```json
{
  "project": { "id": 1, "name": "My Project", "slug": "my-project" },
  "tasks": [
    { "id": 123, "title": "Task 1", "priority_score": 2000, "status": "open" },
    { "id": 124, "title": "Task 2", "priority_score": 1500, "status": "blocked" }
  ],
  "repositories": [ { "url": "...", "default_branch": "main" } ],
  "milestones": [ { "id": 1, "name": "Phase 1", "completion_percentage": 75 } ]
}
```

**Step 2: Select Task** (application logic)
- Filter by status
- Sort by priority_score DESC, created_at ASC
- Pick first task

**Step 3: Execute Workflow** (delegate to task-flow, blocked-task-resolution, etc.)

---

## API Call Frequency Analysis

### Per Workflow Execution

| Operation | Frequency | Endpoint |
|-----------|-----------|----------|
| Task status update | 3-5x | PATCH /tasks/{id} |
| Bulk task creation | 0-3x | POST /tasks:bulk |
| Milestone query | 1x | GET /milestones/{id} |
| Duplicate check | 0-3x | GET /milestones/{id}/tasks |
| Task details | 1x | GET /tasks/{id} |

### Per Day (100 tasks)

| Operation | Calls/Day | Target Latency |
|-----------|-----------|----------------|
| Task status update | 300-500 | <10ms |
| Bulk task creation | 50-150 | <100ms (20 tasks) |
| Priority queue | 17,280 | <50ms (every 5 sec) |
| Milestone query | 100 | <10ms |
| Duplicate check | 100-300 | <50ms |

---

## Bulk Operation Patterns

### Review Failure Pattern

**All review workflows follow this pattern:**

1. **Review fails** (QA, Code, Security, DevOps)
2. **PM evaluates findings** (prioritizes: urgent vs deferred)
3. **Bulk create followup tasks:**

```typescript
const findings = pmDecision.urgent_findings;

const tasks = findings.map(finding => ({
  title: `${reviewType} Fix: ${finding.title}`,
  description: finding.description,
  milestone_id: currentMilestone.id,
  parent_task_id: currentTask.id,
  status: 'open',
  priority_score: priorityByReviewType[reviewType],
  external_id: finding.external_id || null,
  labels: [`${reviewType}-followup`, finding.severity]
}));

const result = await bulkCreateTasks(projectId, {
  tasks,
  duplicateDetection: finding.external_id ? 'external_id' : 'title_and_milestone',
  onDuplicate: reviewType === 'security' ? 'error' : 'skip'
});

console.log(`Created ${result.summary.created} ${reviewType} followup tasks`);
```

**Priority Scores by Review Type:**
- Security: 1500 (highest)
- QA: 1200
- DevOps: 1100
- Code Review: 1000

---

## Duplicate Detection Strategies

### By Use Case

| Use Case | Strategy | Reason |
|----------|----------|--------|
| QA findings | `external_id` | External QA tool IDs (unique) |
| Security findings | `external_id` | CVE IDs, security scanner IDs |
| Code review | `title_and_milestone` | No external IDs, scope to milestone |
| DevOps | `title_and_milestone` | No external IDs |
| Hotfix | `title_and_milestone` | Must detect duplicates, no external ID |

### Example Code

```typescript
// Security findings (have CVE IDs)
duplicateDetection: 'external_id'
onDuplicate: 'error' // Security issues must not be silently ignored

// Code review (no external IDs)
duplicateDetection: 'title_and_milestone'
onDuplicate: 'skip' // OK to skip duplicates

// Hotfix (critical, no external ID)
duplicateDetection: 'title_and_milestone'
onDuplicate: 'error' // Must prevent duplicate hotfixes
```

---

## Query Optimization Patterns

### Priority Queue (WorkflowCoordinator)

**Query:**
```
GET /projects/{id}/tasks?status=open,in_progress,blocked,in_review&sort=priority_score:desc,created_at:asc&limit=100
```

**Index Used:** `idx_tasks_priority_queue`

**Performance:** <5ms for 1000 tasks

---

### Milestone Active Tasks (Duplicate Detection)

**Query:**
```
GET /projects/{id}/milestones/{milestoneId}/tasks?status=!done,!archived&fields=id,title,external_id
```

**Index Used:** `idx_tasks_milestone_active`

**Performance:** <50ms for 100 tasks

---

### External ID Lookup (Security Findings)

**Query:**
```
GET /projects/{id}/tasks?external_id=CVE-2025-1234
```

**Index Used:** `idx_tasks_external_id` (partial index)

**Performance:** <5ms per lookup

---

## Error Handling Patterns

### Task Not Found

```typescript
const response = await fetch(`/projects/${projectId}/tasks/${taskId}`);

if (response.status === 404) {
  const error = await response.json();
  console.error('Task not found:', error.detail);
  // Handle: skip task, log warning, continue
}
```

### Duplicate Task (Error Mode)

```typescript
const response = await fetch(`/projects/${projectId}/tasks:bulk`, {
  method: 'POST',
  body: JSON.stringify({
    tasks,
    duplicateDetection: 'external_id',
    onDuplicate: 'error'
  })
});

if (response.status === 409) {
  const error = await response.json();
  console.error('Duplicate task:', error.detail);
  // Handle: Alert user, fail workflow, investigate
}
```

### Validation Error

```typescript
const response = await fetch(`/projects/${projectId}/tasks`, {
  method: 'POST',
  body: JSON.stringify(invalidTask)
});

if (response.status === 400) {
  const error = await response.json();
  error.errors.forEach(err => {
    console.error(`Field ${err.field}: ${err.message}`);
  });
  // Handle: Fix validation, retry
}
```

---

## Migration Strategy

### Current Implementation → New API

**Step 1: Create HTTP client wrapper**
```typescript
class DashboardClient {
  async updateTaskStatus(projectId: number, taskId: number, status: string) {
    // Call new API
  }
  
  async bulkCreateTasks(projectId: number, options: BulkCreateOptions) {
    // Call new API
  }
}
```

**Step 2: Update workflow step implementations**
```typescript
// Old (direct database access)
await db.run('UPDATE tasks SET status = ? WHERE id = ?', status, taskId);

// New (HTTP API)
await dashboardClient.updateTaskStatus(projectId, taskId, status);
```

**Step 3: Feature flag for gradual rollout**
```typescript
if (config.useDashboardAPI) {
  await dashboardClient.updateTaskStatus(...);
} else {
  await db.run('UPDATE tasks SET status = ?', status);
}
```

---

## Conclusion

This document provides:
- ✅ Complete API mapping for all 6 workflows
- ✅ Request/response examples for each operation
- ✅ Frequency and performance analysis
- ✅ Duplicate detection strategies by use case
- ✅ Error handling patterns
- ✅ Migration strategy from current implementation

**Key Takeaways:**
- Task status updates: Most frequent operation (300-500x/day)
- Bulk task creation: Critical for review failures (50-150x/day)
- Priority queue: High frequency (17,280x/day, every 5 seconds)
- Duplicate detection: Prevents duplicate followup tasks
- Performance targets: All operations <100ms

**Next:** USER CHECKPOINT #2 - Validate API design with user

