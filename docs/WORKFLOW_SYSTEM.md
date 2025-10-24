# Workflow System Documentation

Note: This document describes the modern engine/coordinator architecture. Some historical code examples that referenced legacy modules (e.g., `src/redis/eventPublisher.ts`, `src/redis/requestHandlers.ts`, `src/worker.ts`) have been removed; eventing and acknowledgments are now handled internally within steps and the transport abstraction.

## Overview

A Redis-based distributed multi-agent coordination system that orchestrates AI personas to plan, implement, test, and review code changes across multiple machines. Uses YAML-defined workflows with progressive timeout/retry mechanisms and git-based state synchronization.

---

## System Architecture

### High-Level Flow

```
Dashboard → Redis Stream → Coordinator → Workflow Engine → Personas → Git → Dashboard
     ↓                                        ↓                           ↓
 Task Created                        Context/Plan/Code/QA          Commits/Status
```

1. **Task Creation**: Dashboard creates task and publishes to Redis
2. **Coordination**: WorkflowCoordinator receives task, selects workflow
3. **Execution**: WorkflowEngine executes steps with dependency management
4. **Persona Work**: Personas (planner, engineer, QA) perform their roles
5. **Git Sync**: Changes committed and pushed for multi-machine coordination
6. **Status Updates**: Dashboard updated with progress and results

### Core Components

#### WorkflowCoordinator (`src/workflows/WorkflowCoordinator.ts`)
- **Project-Level Loop**: Iterates through ALL pending dashboard tasks
- Receives trigger from Redis request stream
- Fetches tasks from dashboard API
- For each pending task:
  - Selects appropriate workflow (project-loop, hotfix, feature)
  - Creates execution context with project/branch info
  - Delegates to WorkflowEngine
- **Continues until**: All tasks complete OR critical error occurs
- **Max iterations**: 20 (configurable safety limit)

#### WorkflowEngine (`src/workflows/WorkflowEngine.ts`)
- **Workflow-Level Execution**: Processes ONE task through its steps
- Loads YAML workflow definitions from `workflows/`
- Resolves step dependencies and execution order
- Executes steps with timeout and retry policies
- Manages workflow context and state
- Registers step implementations
- Returns success/failure to WorkflowCoordinator

#### Step Implementations (`src/workflows/steps/`)
- **PersonaRequestStep**: Dispatches requests to personas via Redis
- **GitOperationStep**: Performs git operations (checkout, commit, push)
- **ConditionalStep**: Conditional execution based on runtime state
- **PlanningLoopStep**: Iterative planning with TDD gates
 
- **DiffApplyStep**: Applies code diffs from personas
- **TaskUpdateStep**: Updates task status on dashboard

#### Persona System (`src/agents/persona.ts`)
- Individual AI agents with specific roles
- Communicate via Redis streams
- Read from request stream, write to event stream
- Wait for responses with timeout and retry
- Process context, plans, code, tests

### Two-Level Architecture: Project Loop vs Workflow Execution

**Critical Distinction**:

```
PROJECT LOOP (WorkflowCoordinator)
├── ITERATION 1:
│   ├── Fetch fresh tasks from dashboard (including new urgent tasks)
│   ├── Sort by priority (blocked > in_review > in_progress > open)
│   ├── Select highest priority pending task
│   └── WORKFLOW EXECUTION (WorkflowEngine)
│       ├── Load workflow YAML (e.g., project-loop.yml)
│       ├── Execute steps sequentially with dependencies
│       │   ├── Step 1: Planning (timeout: 1800s, retries: 2)
│       │   ├── Step 2: Evaluation (timeout: 900s)
│       │   ├── Step 3: Implementation (timeout: 3600s, retries: 1)
│       │   └── Step 4: QA (timeout: 1200s)
│       └── Return success/failure
│
├── ITERATION 2:
│   ├── Refetch tasks (picks up QA follow-ups, security issues, etc.)
│   ├── Process next highest priority task
│   └── ...
│
└── Continue until all tasks done or critical failure

Completion Conditions:
✓ SUCCESS: All dashboard tasks status = 'done'
✗ ABORT: Workflow returns critical error (e.g., git conflict, unrecoverable failure)
⚠️ SAFETY: Max 500 iterations by default (configurable via COORDINATOR_MAX_ITERATIONS)
```

**Key Points**:
- Each **workflow** processes **one task** with per-step timeouts/retries
- The **project loop** refetches tasks at **each iteration** (1 task per iteration)
- **Fresh task fetching** enables immediate response to urgent tasks (QA failures, security issues)
- Individual persona timeouts (e.g., 30 minutes for planning) don't abort the project
- Only critical workflow failures (unrecoverable errors) abort the entire project loop
- Safety limit: 500 iterations by default (configurable via `COORDINATOR_MAX_ITERATIONS`)
- Supports projects with 500+ tasks; set higher if needed
- Task priority ensures urgent issues are worked first

### Project Loop Iteration Strategy

The coordinator implements a **fetch-process-loop** pattern optimized for responsive task handling:

**Implementation** (`src/workflows/WorkflowCoordinator.ts`):
```typescript
while (iterationCount < maxIterations) {
  // 1. FETCH FRESH TASKS from dashboard
  //    Picks up new urgent tasks added during previous workflow execution
  const currentTasks = await this.fetchProjectTasks(projectId);
  const pendingTasks = currentTasks
    .filter(task => status !== 'done')
    .sort((a, b) => compareTaskPriority(a, b)); // Priority-based sorting
  
  if (pendingTasks.length === 0) {
    break; // SUCCESS: All done
  }
  
  // 2. PROCESS ONE TASK (sequential, not parallel)
  const task = pendingTasks[0]; // Highest priority
  const result = await processTask(task);
  
  if (result.critical) {
    break; // ABORT: Unrecoverable error
  }
  
  // 3. LOOP BACK to refetch (picks up QA follow-ups, security issues)
}
```

**Why This Works**:
- **Immediate Response**: QA failures, security issues picked up in next iteration (< 2 min typically)
- **Priority-Driven**: Urgent tasks (blocked status) always processed first
- **Dynamic**: Handles follow-up tasks created during processing
- **Clear**: One task per iteration; no confusing batch logic

**Example Scenario**:
```
Time 0:00 - Iteration 1: Process "Feature Implementation"
  → QA finds critical bug during testing
  → Creates "Critical Bug Fix" task with blocked status

Time 1:00 - Iteration 2: Refetch tasks
  → "Critical Bug Fix" (blocked) appears
  → Processed immediately before other open tasks
  → Bug fixed before continuing feature work
```

**Configuration**:
- Default: 500 iterations (handles 500+ tasks)
- Increase for large projects: `COORDINATOR_MAX_ITERATIONS=1000`
- Unlimited (use cautiously): `COORDINATOR_MAX_ITERATIONS=unlimited`
- Tests: 2 iterations (for speed)

---

## Personas

### Coordination Personas
- **coordination**: Workflow orchestration, task routing, coordination logic

### Planning Personas
- **implementation-planner**: Creates detailed implementation plans from tasks
- **plan-evaluator**: Evaluates plans for completeness, feasibility, TDD alignment
- **architect**: High-level system design and architecture decisions
- **project-manager**: Task prioritization and project coordination

### Implementation Personas
- **lead-engineer**: Primary code implementation following approved plans
- **devops**: Infrastructure, deployment, CI/CD configuration
- **ui-engineer**: Frontend and user interface implementation
- **ml-engineer**: Machine learning model development

### Quality Personas
- **qa-engineer** / **tester-qa**: Test execution, validation, QA reporting
- **code-reviewer**: Code quality, standards, best practices review
- **security-review**: Security vulnerability assessment and fixes

### Support Personas
- **context**: Scans repository for context (files, structure, hotspots)
- **summarization**: Generates summaries of code changes and plans

---

## Workflow Definitions

### YAML Structure

Located in `workflows/` directory, defined in YAML format:

```yaml
name: "project-loop"
version: "1.0.0"
description: "Standard development workflow"

# Important: Workflow vs Project Loop Distinction
# - A WORKFLOW processes ONE task through its steps
# - The PROJECT LOOP runs workflows for ALL pending tasks
# - WorkflowCoordinator continues until:
#   1. All dashboard tasks are complete (success)
#   2. A critical workflow error occurs (abort)

variables:
  # Timeout values for individual persona steps (in seconds)
  planning_timeout: 1800      # 30 minutes
  implementation_timeout: 3600 # 60 minutes
  qa_timeout: 1200            # 20 minutes

steps:
  - id: "planning"
    name: "Implementation Planning"
    type: "persona-request"
    persona: "implementation-planner"
    timeout: 1800              # This persona's timeout
    retries: 2                 # This persona's retry attempts
    params:
      stage: "initial"
      
  - id: "plan-evaluation"
    name: "Plan Evaluation"
    type: "persona-request"
    persona: "plan-evaluator"
    dependencies: ["planning"]
    timeout: 900               # Each step has its own timeout
    
  - id: "implementation"
    name: "Code Implementation"
    type: "persona-request"
    persona: "lead-engineer"
    dependencies: ["plan-evaluation"]
    timeout: 3600              # Independent timeout per step
    retries: 1                 # Independent retries per step
```

### Available Workflows

**project-loop.yml**: Standard development workflow
- Context scanning
- Iterative planning with TDD gates
- Code implementation
- QA iteration loop (test until pass)
- Parallel code/security/devops reviews
- Status updates throughout

**hotfix.yml**: Emergency hotfix workflow
- Minimal planning
- Direct implementation
- Fast-track QA
- Immediate deployment preparation

**feature.yml**: Feature-specific workflow
- Detailed planning
- Architecture review
- Phased implementation
- Comprehensive testing

---

## Timeout & Retry System

### Progressive Backoff Mechanism

**Design**: Two-layer system ensuring workflows stay alive during retries.

**Layer 1 - PersonaRequestStep Retry Loop**:
- Handles individual persona request attempts
- Progressive backoff: 30s → 60s → 90s between attempts
- Default: 3 retries (4 total attempts)
- Only retries on timeout errors

**Layer 2 - WorkflowEngine Wrapper Timeout**:
- Wraps entire PersonaRequestStep execution
- Calculated to accommodate all retries + backoff
- Prevents workflow abort during valid retries

### Timeout Calculation

```typescript
workflowTimeout = (maxRetries + 1) × personaTimeout + backoffSum + 30s buffer

where:
  backoffSum = 30s + 60s + 90s + ... (for maxRetries attempts)
```

**Example**: Context persona with 60s timeout, 3 retries
- Attempts: 4 × 60s = 4 minutes
- Backoff: 30s + 60s + 90s = 3 minutes
- Buffer: 30 seconds
- **Total workflow timeout: 7.5 minutes**

### Configuration

**Global Defaults** (`.env`):
```bash
PERSONA_DEFAULT_TIMEOUT_MS=60000                    # 1 minute default
PERSONA_CODING_TIMEOUT_MS=180000                    # 3 minutes for coding
PERSONA_TIMEOUT_MAX_RETRIES=3                       # 3 retries (4 total attempts)
PERSONA_RETRY_BACKOFF_INCREMENT_MS=30000            # 30s backoff increment
```

**Per-Persona Overrides**:
```bash
PERSONA_TIMEOUTS_JSON='{"context":60000,"lead-engineer":180000,"qa-engineer":120000}'
```

**Per-Step Overrides** (in YAML):
```yaml
- id: "critical-step"
  type: "persona-request"
  persona: "lead-engineer"
  timeout: 300000      # Override to 5 minutes
  maxRetries: 5        # Override to 5 retries
```

### Retry Flow

```
Attempt 1: Try persona (timeout: personaTimeout)
           ↓ [timeout]
           Wait 30s
           ↓
Attempt 2: Retry persona (timeout: personaTimeout)
           ↓ [timeout]
           Wait 60s
           ↓
Attempt 3: Retry persona (timeout: personaTimeout)
           ↓ [timeout]
           Wait 90s
           ↓
Attempt 4: Final attempt (timeout: personaTimeout)
           ↓ [timeout]
           ↓
All exhausted → Return failure → Workflow aborts → Task marked blocked
```

---

## Distributed Coordination

### Multi-Machine Synchronization

**Challenge**: Multiple machines working on same project need coordinated state.

**Solution**: Git-based synchronization with pull-before-read pattern.

### Context Synchronization

**Problem**: Stale context summaries leading to incorrect plans.

**Solution**:
1. Context persona scans repo → writes `.ma/context/summary.md` → commits → pushes
2. Planning persona → pulls → reads fresh context → plans → commits plan → pushes
3. Implementation persona → pulls → reads context + plan → codes → commits → pushes

**Priority Order**:
1. Payload context (from recent context persona run in same workflow)
2. Git-pulled disk context (from `.ma/context/summary.md` after pull)
3. Fallback to existing disk file

### Task Logging

**QA Logs** (`.ma/qa/task-{taskId}-qa.log`):
- Written after each QA run
- Contains: timestamp, status (PASS/FAIL), duration, full test results
- Automatically committed and pushed
- Visible to all machines for planning decisions

**Planning Logs** (`.ma/planning/task-{id}-plan.log`):
- Written after each planning iteration
- Contains: iteration number, plan content, evaluation results
- Git pull before read ensures latest from other machines
- Enables planning history awareness

**Cleanup**:
- Logs automatically removed when task completes successfully
- Summary preserved in `.ma/changelog.md`
- Reduces repository clutter while maintaining history

### Multi-Machine Workflow Example

```
Machine A:
  1. Runs context persona → scans repo
  2. Commits context summary → pushes
  
Machine B:
  3. Pulls latest
  4. Runs planner → reads context + previous plans
  5. Commits planning log → pushes
  
Machine C:
  6. Pulls latest
  7. Runs lead-engineer → reads context + plan
  8. Implements code → commits → pushes
  
Machine A:
  9. Pulls latest
  10. Runs QA → reads code changes
  11. Tests fail → commits QA log → pushes
  
Machine B:
  12. Pulls latest → reads QA failure
  13. Refines plan based on QA → commits → pushes
  
Machine C:
  14. Pulls latest → reads refined plan
  15. Fixes code → commits → pushes
  
Any Machine:
  16. QA passes → cleanup logs → commit summary
```

---

## Redis Communication

### Streams

**Request Stream** (`machine:requests`):
- Incoming task requests from coordinator to personas
- Consumer groups per persona for load distribution
- Messages include: workflow_id, task_id, persona, payload, deadline

**Event Stream** (`machine:events`):
- Status updates and results from personas back to coordinator
- Coordinator polls for completion events
- Messages include: workflow_id, task_id, status, result, timestamp

### Message Flow

```typescript
// Coordinator sends request
await redis.xAdd('machine:requests', '*', {
  workflow_id: 'wf-123',
  to_persona: 'lead-engineer',
  step: '3-implement',
  intent: 'implement',
  payload: JSON.stringify({task, plan, context}),
  corr_id: uuid(),
  deadline_s: '600'
});

// Persona reads request
const messages = await redis.xReadGroup(
  'machine:personas:lead-engineer',  // consumer group
  'worker-1',                         // consumer id
  {key: 'machine:requests', id: '>'},
  {COUNT: 1, BLOCK: 1000}
);

// Persona sends response
await redis.xAdd('machine:events', '*', {
  workflow_id: 'wf-123',
  from_persona: 'lead-engineer',
  status: 'done',
  result: JSON.stringify({code_changes, files_modified}),
  corr_id: correlationId
});

// Coordinator waits for response
const response = await waitForPersonaCompletion(
  redis,
  'lead-engineer',
  'wf-123',
  correlationId,
  timeout
);
```

### Redis Notes

Legacy helper modules for event publishing and request acknowledgment have been removed. Step implementations interact with the transport abstraction directly where needed.

---

## Workflow Context

### WorkflowContext Interface

Shared state passed through all workflow steps:

```typescript
interface WorkflowContext {
  // Identifiers
  workflowId: string;
  taskId: string;
  
  // Task Info
  task: TaskData;
  milestone?: MilestoneData;
  
  // Repository Info
  repoRoot: string;
  branchName: string;
  baseBranch: string;
  repoRemote: string;
  
  // State Management
  state: Map<string, any>;              // Step results, intermediate data
  dashboardState: any;                  // Dashboard project/task state
  gitState: any;                        // Git repository state
  
  // Results
  artifacts: any[];                     // Generated artifacts
  personaResults: Map<string, any>;     // Results from each persona
  
  // Methods
  getVariable(key: string): any;
  setVariable(key: string, value: any): void;
}
```

### Context Usage Example

```typescript
// In a workflow step
async execute(context: WorkflowContext): Promise<WorkflowStepResult> {
  // Read from context
  const task = context.task;
  const planResult = context.getVariable('planning_result');
  
  // Perform work
  const implementation = await implementCode(task, planResult);
  
  // Update context
  context.setVariable('implementation_result', implementation);
  context.artifacts.push({
    type: 'code',
    files: implementation.files
  });
  
  return {
    status: 'success',
    data: implementation,
    outputs: {code_complete: true}
  };
}
```

---

## Step Types

### PersonaRequestStep

Dispatches work to AI personas via Redis.

**Configuration**:
```yaml
- id: "planning"
  type: "persona-request"
  persona: "implementation-planner"
  timeout: 1800          # 30 minutes
  maxRetries: 3          # 3 retries (4 total attempts)
  params:
    stage: "initial"
    context_summary: "${context.summary}"
```

**Behavior**:
1. Publishes request to Redis request stream
2. Waits for response on event stream
3. Retries on timeout with progressive backoff
4. Updates context with persona result
5. Returns success/failure

### GitOperationStep

Performs git operations on repository.

**Operations**:
- `checkout`: Switch to or create branch
- `commit`: Commit changes with message
- `push`: Push to remote
- `pull`: Pull latest from remote
- `merge`: Merge branches

**Configuration**:
```yaml
- id: "commit-changes"
  type: "git-operation"
  operation: "commit"
  params:
    message: "Implement ${task.title}"
    files: ["src/**/*.ts"]
```

### ConditionalStep

Conditional execution based on runtime state.

**Configuration**:
```yaml
- id: "check-qa-status"
  type: "conditional"
  condition: "context.state.get('qa_status') === 'pass'"
  then:
    - id: "code-review"
      type: "persona-request"
      persona: "code-reviewer"
  else:
    - id: "mark-blocked"
      type: "task-update"
      status: "blocked"
```

### PlanningLoopStep

Iterative planning with TDD gates.

**Features**:
- PM approve/reject gates
- Automatic iteration on reject
- TDD governance checks
- Planning history awareness

**Configuration**:
```yaml
- id: "planning-loop"
  type: "planning-loop"
  maxIterations: 10
  tddRequired: true
  params:
    context_summary: "${context.summary}"
```

### QAIterationLoopStep

Test-fix-retest loop until all tests pass.

**Features**:
- Unlimited or limited iterations
- Cumulative history passed to each iteration
- Automatic task status update on success
- QA log writing and synchronization

**Configuration**:
```yaml
- id: "qa-loop"
  type: "qa-iteration-loop"
  maxIterations: unlimited  # or numeric limit
  params:
    test_command: "npm test"
```

---

## Error Handling

### Error Categories

**Timeout Errors**:
- Persona doesn't respond within timeout
- Retry with progressive backoff
- Log each retry attempt
- Mark task blocked after all retries exhausted

**Redis Errors**:
- Connection failures
- Stream read/write errors
- Fail immediately (no retry)
- Log error details

**Git Errors**:
- Merge conflicts
- Push failures
- Mark task as blocked
- Preserve changes for manual resolution

**Persona Errors**:
- Invalid response format
- Persona returned error status
- Log error details
- May retry depending on error type

### Error Recovery

**Workflow Abort**:
```typescript
try {
  await workflowEngine.execute(workflow, context);
} catch (error) {
  logger.error('Workflow failed', {workflowId, error});
  
  // Mark task as blocked
  await updateTaskStatus(task.id, 'blocked', {
    error: error.message,
    workflow_id: workflowId
  });
  
  // Send notification
  await publishEvent(redis, {
    workflowId,
    fromPersona: 'coordination',
    status: 'error',
    error: error.message
  });
}
```

**Step Retry Example**:
```typescript
let attempt = 0;
const maxRetries = config.maxRetries ?? 3;

while (attempt <= maxRetries) {
  try {
    const result = await executePersonaRequest(config);
    return result;
  } catch (error) {
    if (isTimeoutError(error) && attempt < maxRetries) {
      const backoff = (attempt + 1) * 30000; // Progressive backoff
      logger.info(`Retry attempt ${attempt + 1}/${maxRetries}, waiting ${backoff}ms`);
      await sleep(backoff);
      attempt++;
    } else {
      throw error;
    }
  }
}
```

---

## Testing

### Test Infrastructure

**Test Suite**: 139 passing, 9 skipped (148 total), ~7.4s duration

**Shared Mocks** (`tests/__mocks__/`):
- `redisClient.js`: Standard Redis client mock
- `gitUtils.js`: Git utility mocks
- `scanRepo.js`: Repository scan mock
- `process.js`: Process mock
- `dashboard.js`: Dashboard API mock (reference)
- `persona.js`: Persona mock (reference)

**Test Helpers** (`tests/helpers/`):
- `coordinatorTestHelper.ts`: Workflow test utilities
- `createFastCoordinator()`: Quick coordinator setup
- `createDynamicTaskMocking()`: Dynamic task mocking
- `makeTempRepo()`: Temporary git repositories

### Testing Patterns

**Using Shared Mocks**:
```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Automatic mock resolution via __mocks__
vi.mock('../src/redisClient.js');
vi.mock('../src/gitUtils.js');

describe('My Workflow Test', () => {
  it('should execute workflow', async () => {
    // Mocks already set up
    const result = await executeWorkflow();
    expect(result.status).toBe('success');
  });
});
```

**Using Test Helpers**:
```typescript
import { createFastCoordinator } from './helpers/coordinatorTestHelper.js';

it('should handle timeout retry', async () => {
  const coordinator = createFastCoordinator({
    // Mock configs
  });
  
  const result = await coordinator.handleTask(task);
  expect(result).toBeDefined();
});
```

### Test Best Practices

1. **Use Shared Mocks**: Leverage `__mocks__/` for infrastructure
2. **Keep Data Inline**: Test-specific data should be in test file
3. **Test Timeouts**: Verify retry logic and backoff
4. **Test Distribution**: Consider multi-machine scenarios
5. **Maintain Stability**: All tests should pass consistently

---

## Configuration

### Environment Variables

**Required**:
```bash
PROJECT_BASE=/path/to/projects
REDIS_HOST=localhost
REDIS_PORT=6379
DASHBOARD_API_BASE_URL=https://dashboard.example.com/api
LM_STUDIO_BASE_URL=http://localhost:1234
```

**Personas**:
```bash
ALLOWED_PERSONAS=coordination,implementation-planner,lead-engineer,qa-engineer
PERSONA_MODELS_JSON='{"lead-engineer":"qwen2.5-coder:32b","qa-engineer":"gpt-4"}'
```

**Timeouts & Retries**:
```bash
PERSONA_DEFAULT_TIMEOUT_MS=60000
PERSONA_CODING_TIMEOUT_MS=180000
PERSONA_TIMEOUT_MAX_RETRIES=3
PERSONA_RETRY_BACKOFF_INCREMENT_MS=30000
PERSONA_TIMEOUTS_JSON='{"context":60000,"lead-engineer":180000}'
```

**Workflow Limits**:
```bash
COORDINATOR_MAX_ITERATIONS=500               # Project loop max iterations (default 500)
COORDINATOR_MAX_REVISION_ATTEMPTS=unlimited  # QA loop iterations
BLOCKED_MAX_ATTEMPTS=10                      # Blocked task resolution attempts
```

### Config Module (`src/config.ts`)

Centralizes all configuration with environment variable parsing:

```typescript
export const cfg = {
  // Redis
  redisHost: process.env.REDIS_HOST || 'localhost',
  redisPort: parseInt(process.env.REDIS_PORT || '6379'),
  requestStream: 'machine:requests',
  eventStream: 'machine:events',
  
  // Personas
  allowedPersonas: parsePersonas(process.env.ALLOWED_PERSONAS),
  personaModels: parseJSON(process.env.PERSONA_MODELS_JSON),
  
  // Timeouts
  personaDefaultTimeoutMs: parseInt(process.env.PERSONA_DEFAULT_TIMEOUT_MS || '60000'),
  personaCodingTimeoutMs: parseInt(process.env.PERSONA_CODING_TIMEOUT_MS || '180000'),
  personaTimeoutMaxRetries: parseInt(process.env.PERSONA_TIMEOUT_MAX_RETRIES || '3'),
  personaRetryBackoffIncrementMs: parseInt(process.env.PERSONA_RETRY_BACKOFF_INCREMENT_MS || '30000'),
  personaTimeouts: parseJSON(process.env.PERSONA_TIMEOUTS_JSON),
  
  // Project
  projectBase: process.env.PROJECT_BASE || './projects',
  dashboardApiBaseUrl: process.env.DASHBOARD_API_BASE_URL,
  
  // LM Studio
  lmStudioBaseUrl: process.env.LM_STUDIO_BASE_URL || 'http://localhost:1234'
};
```

---

## Deployment

### Multi-Machine Setup

**Prerequisites**:
1. All machines have access to same Redis instance
2. All machines have access to project repositories
3. Git credentials configured on all machines
4. LM Studio or LLM API available

**Deployment Steps**:

1. **Clone Repository**:
   ```bash
   git clone https://github.com/your-org/multi-agent-machine-client.git
   cd multi-agent-machine-client
   npm install
   ```

2. **Configure Environment**:
   ```bash
   cp .env.example .env
   # Edit .env with your settings
   ```

3. **Configure Personas**:
   ```bash
   # Machine A: Planning and coordination
   ALLOWED_PERSONAS=coordination,implementation-planner,plan-evaluator
   
   # Machine B: Implementation
   ALLOWED_PERSONAS=lead-engineer,devops,ui-engineer
   
   # Machine C: Quality
   ALLOWED_PERSONAS=qa-engineer,code-reviewer,security-review
   ```

4. **Start Workers**:
   ```bash
   npm run start
   ```

5. **Verify**:
   - Check logs for persona registration
   - Verify Redis connection
   - Test with simple task

### Common Issues

**"No repository remote URL available"**:
- Cause: Project missing repository URL in dashboard
- Fix: Configure repository URL in project settings

**"Timeout waiting for persona"**:
- Cause: No machine has that persona enabled
- Fix: Enable persona on at least one machine

**"Stale context summary"**:
- Cause: Git pull failing or not happening
- Fix: Check git credentials, network access

**"Task priority wrong"**:
- Cause: Old version without priority fixes
- Fix: Pull latest changes, restart workers

---

## Monitoring

### Logs

**Engine/Coordinator Logs**:
- Persona registration
- Task receipt
- Step execution
- Timeout/retry attempts
- Errors and warnings

**Redis Logs**:
- Stream reads/writes
- Consumer group operations
- Message acknowledgments

**Git Logs**:
- Branch operations
- Commits and pushes
- Merge operations

### Metrics

**Key Metrics to Monitor**:
- Task completion rate
- Average workflow duration
- Retry frequency by persona
- Timeout frequency by persona
- Error rate by error type

**Recommended Tools**:
- Redis CLI for stream inspection
- Grafana for metrics visualization
- Custom dashboard for task tracking

---

## Troubleshooting

### Debug Workflow Execution

1. **Check Redis Streams**:
   ```bash
   redis-cli
   > XINFO STREAM machine:requests
   > XINFO STREAM machine:events
   > XREAD COUNT 10 STREAMS machine:events 0
   ```

2. **Check Engine/Coordinator Logs**:
   ```bash
   tail -f machine-client.log
   ```

3. **Check Git State**:
   ```bash
   cd PROJECT_BASE/your-project
   git log --oneline -10
   git status
   ```

4. **Check Task Logs**:
   ```bash
   cat .ma/planning/task-{id}-plan.log
   cat .ma/qa/task-{id}-qa.log
   ```

### Common Scenarios

**Workflow Stuck**:
- Check if persona is enabled on any machine
- Check Redis for pending messages
- Check timeout configuration

**Tests Keep Failing**:
- Check QA log for test output
- Verify test command in workflow YAML
- Check if tests pass locally

**Planning Loop Infinite**:
- Check PM gate configuration
- Verify plan evaluator responses
- Check max iterations setting

---

## Best Practices

### Workflow Design
- Keep workflows focused and cohesive
- Use meaningful step names
- Design for failure scenarios
- Document workflow purpose

### Persona Configuration
- Assign personas based on machine capabilities
- Balance load across machines
- Configure appropriate timeouts per persona
- Monitor persona performance

### Git Hygiene
- Always pull before read
- Commit and push after write
- Use descriptive commit messages
- Clean up logs when tasks complete

### Testing
- Test timeout and retry scenarios
- Test multi-machine coordination
- Test error handling paths
- Maintain test stability

---

## Future Enhancements

### Planned
- Visual workflow designer UI
- Real-time monitoring dashboard
- Advanced analytics and optimization
- Workflow templates library
- Multi-repository coordination

### Under Consideration
- Workflow composition and nesting
- Dynamic workflow generation
- External workflow engine integration
- Plugin architecture for extensions
- Machine learning for optimization

---

*Last Updated: October 13, 2025*
*System Version: 2.0 (Post-Refactoring)*
*Test Suite: 139 passing | 9 skipped | 7.44s duration*
