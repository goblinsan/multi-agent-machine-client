# Testing Strategy: Preventing Architectural Regressions

## The Problem

The distributed git architecture requirements were **NOT caught by tests** before deployment. This is a **critical failure** that could have broken the entire system in production.

**What Happened:**
- Context persona was calling LLM without repo scan data
- Reviews were NOT committing results to git
- No .ma/ directory structure was being created
- Distributed agents would have been unable to coordinate

**Why Tests Didn't Catch It:**
1. ❌ No integration tests for workflow YAML files
2. ❌ No tests validating git commits happen
3. ❌ No tests validating .ma/ directory structure
4. ❌ No tests validating persona payload contracts
5. ❌ Unit tests focused on individual steps, not architectural requirements

## The Solution: Multi-Layer Testing Strategy

### Layer 1: Architectural Invariant Tests (NEW)

**File:** `tests/distributedGitArchitecture.test.ts`

**Purpose:** Validate CRITICAL architectural requirements that MUST NEVER break.

**Test Coverage:**
```typescript
describe('REQUIREMENT 1: Context scan MUST commit artifacts to git', () => {
  ✅ should write snapshot.json to .ma/context/
  ✅ should write summary.md to .ma/context/
  ✅ should commit context artifacts to git
  ✅ should commit snapshot.json and summary.md in same commit
  ✅ should NOT commit if context unchanged (reused_existing)
  ✅ should output repoScan data for context persona
});

describe('REQUIREMENT 2: Reviews MUST commit results to git', () => {
  ✅ should commit QA review result to .ma/tasks/{id}/reviews/qa.json
  ✅ should commit code review result to .ma/tasks/{id}/reviews/code-review.json
  ✅ should commit security review result to .ma/tasks/{id}/reviews/security.json
  ✅ should commit devops review result to .ma/tasks/{id}/reviews/devops.json
});

describe('REQUIREMENT 3: Distributed agent recovery from git', () => {
  ✅ should allow second agent to read context from git
  ✅ should allow second agent to read review results from git
});

describe('REQUIREMENT 4: Workflow definitions use correct step types', () => {
  ✅ task-flow.yaml should use ContextStep not PersonaRequestStep for scanning
  ✅ task-flow.yaml should have GitArtifactStep after each review
  ✅ in-review-task-flow.yaml should have GitArtifactStep after each review
  ✅ context persona should receive repoScan in payload
});

describe('REQUIREMENT 5: Audit trail and recovery', () => {
  ✅ should have complete git history for workflow execution
  ✅ should allow rebuilding workflow state from .ma/ directory
});
```

**Key Characteristics:**
- Uses **real git operations** (not mocked)
- Creates **actual .ma/ directory structure**
- Validates **file existence** on disk
- Checks **git commits** in log
- Tests **distributed agent scenario** (agent 1 writes, agent 2 reads)

**CI/CD Integration:**
```yaml
# .github/workflows/test.yml
- name: Run Architectural Invariant Tests
  run: npm test tests/distributedGitArchitecture.test.ts
  # If these fail, DO NOT deploy
```

### Layer 2: Workflow Schema Validation (RECOMMENDED)

**File:** `tests/workflowSchemaValidation.test.ts` (to be created)

**Purpose:** Validate workflow YAML files follow architectural patterns.

```typescript
describe('Workflow Schema Validation', () => {
  it('all review steps must be followed by GitArtifactStep', () => {
    const reviewSteps = ['qa_request', 'code_review_request', 'security_request', 'devops_request'];
    const commitSteps = ['commit_qa_result', 'commit_code_review_result', 'commit_security_result', 'commit_devops_result'];
    
    reviewSteps.forEach((reviewStep, i) => {
      const hasCommitStep = workflowSteps.some(step => 
        step.name === commitSteps[i] && 
        step.type === 'GitArtifactStep' &&
        step.depends_on.includes(reviewStep)
      );
      expect(hasCommitStep).toBe(true);
    });
  });

  it('context workflow must use ContextStep before PersonaRequestStep', () => {
    const contextScanStep = findStep('context_scan');
    const contextRequestStep = findStep('context_request');
    
    expect(contextScanStep.type).toBe('ContextStep');
    expect(contextRequestStep.type).toBe('PersonaRequestStep');
    expect(contextRequestStep.depends_on).toContain('context_scan');
  });

  it('all persona payloads must match contract', () => {
    const contextRequest = findStep('context_request');
    expect(contextRequest.config.payload).toHaveProperty('repoScan');
    expect(contextRequest.config.payload).toHaveProperty('context_metadata');
    expect(contextRequest.config.payload).toHaveProperty('reused_existing');
  });
});
```

### Layer 3: Contract Tests (RECOMMENDED)

**File:** `tests/personaContracts.test.ts` (to be created)

**Purpose:** Validate personas receive expected data in payloads.

```typescript
describe('Persona Payload Contracts', () => {
  describe('context persona', () => {
    it('must receive repoScan array', () => {
      const payload = buildContextPersonaPayload();
      expect(payload.repoScan).toBeInstanceOf(Array);
      expect(payload.repoScan[0]).toHaveProperty('path');
      expect(payload.repoScan[0]).toHaveProperty('bytes');
      expect(payload.repoScan[0]).toHaveProperty('mtime');
    });

    it('must receive context_metadata', () => {
      const payload = buildContextPersonaPayload();
      expect(payload.context_metadata).toHaveProperty('fileCount');
      expect(payload.context_metadata).toHaveProperty('totalBytes');
      expect(payload.context_metadata).toHaveProperty('scannedAt');
    });

    it('must receive reused_existing flag', () => {
      const payload = buildContextPersonaPayload();
      expect(payload).toHaveProperty('reused_existing');
      expect(typeof payload.reused_existing).toBe('boolean');
    });
  });

  describe('review personas', () => {
    it('must receive plan_artifact path', () => {
      const reviewPayloads = [
        buildQAPersonaPayload(),
        buildCodeReviewPersonaPayload(),
        buildSecurityReviewPersonaPayload()
      ];
      
      reviewPayloads.forEach(payload => {
        expect(payload.plan_artifact).toBeDefined();
        expect(payload.plan_artifact).toMatch(/^\.ma\/tasks\/\d+\/03-plan-final\.md$/);
      });
    });
  });
});
```

### Layer 4: End-to-End Workflow Tests (EXISTING - ENHANCE)

**Files:** `tests/happyPath.test.ts`, `tests/coordinator.test.ts`

**Enhancements Needed:**
```typescript
describe('Happy Path - Complete Workflow', () => {
  it('should create .ma/ directory structure', async () => {
    await runWorkflow(task);
    
    // Validate .ma/ structure
    expect(await fileExists('.ma/context/snapshot.json')).toBe(true);
    expect(await fileExists('.ma/context/summary.md')).toBe(true);
    expect(await fileExists('.ma/tasks/1/03-plan-final.md')).toBe(true);
    expect(await fileExists('.ma/tasks/1/reviews/qa.json')).toBe(true);
  });

  it('should have git commits for all artifacts', async () => {
    await runWorkflow(task);
    
    const log = await runGit(['log', '--oneline']);
    expect(log).toContain('context scan');
    expect(log).toContain('approved plan');
    expect(log).toContain('QA review');
    expect(log).toContain('code review');
  });
});
```

### Layer 5: Step-Level Unit Tests (EXISTING - ENHANCE)

**Files:** `tests/contextStep.test.ts`, `tests/gitArtifactStep.test.ts`

**Enhancements Needed:**
```typescript
describe('ContextStep', () => {
  // Existing tests for change detection...

  // NEW: Git operations tests
  it('should call runGit to commit artifacts', async () => {
    const runGitSpy = vi.spyOn(gitUtils, 'runGit');
    await contextStep.execute(context);
    
    expect(runGitSpy).toHaveBeenCalledWith(['add', '.ma/context/snapshot.json', '.ma/context/summary.md'], expect.any(Object));
    expect(runGitSpy).toHaveBeenCalledWith(['commit', '-m', expect.stringContaining('chore(ma): update context scan')], expect.any(Object));
  });

  it('should output repoScan for context persona consumption', async () => {
    const result = await contextStep.execute(context);
    
    expect(result.outputs.repoScan).toBeDefined();
    expect(context.getVariable).toHaveBeenCalledWith('repoScan');
  });
});
```

## Pre-Commit Hooks

Add to `.husky/pre-commit`:

```bash
#!/bin/sh
. "$(dirname "$0")/_/husky.sh"

# Run architectural invariant tests
echo "Running architectural invariant tests..."
npm test tests/distributedGitArchitecture.test.ts -- --run

if [ $? -ne 0 ]; then
  echo "❌ CRITICAL: Architectural invariant tests failed!"
  echo "These tests validate distributed git coordination."
  echo "If they fail, distributed agents cannot work."
  exit 1
fi
```

## CI/CD Pipeline

```yaml
# .github/workflows/ci.yml
name: CI

on: [push, pull_request]

jobs:
  architectural-tests:
    runs-on: ubuntu-latest
    name: "CRITICAL: Architectural Invariants"
    steps:
      - uses: actions/checkout@v3
      - uses: actions/setup-node@v3
      - run: npm ci
      - name: Run Architectural Invariant Tests
        run: npm test tests/distributedGitArchitecture.test.ts -- --run
      - name: Fail if architectural tests fail
        if: failure()
        run: |
          echo "::error::Architectural invariant tests failed - distributed architecture is BROKEN"
          exit 1

  workflow-validation:
    runs-on: ubuntu-latest
    name: "Workflow Schema Validation"
    steps:
      - uses: actions/checkout@v3
      - uses: actions/setup-node@v3
      - run: npm ci
      - name: Validate Workflow YAMLs
        run: npm test tests/workflowSchemaValidation.test.ts -- --run

  unit-tests:
    runs-on: ubuntu-latest
    name: "Unit Tests"
    needs: [architectural-tests] # Don't even run if architecture broken
    steps:
      - uses: actions/checkout@v3
      - uses: actions/setup-node@v3
      - run: npm ci
      - run: npm test

  integration-tests:
    runs-on: ubuntu-latest
    name: "Integration Tests"
    needs: [architectural-tests]
    steps:
      - uses: actions/checkout@v3
      - uses: actions/setup-node@v3
      - run: npm ci
      - run: npm test tests/happyPath.test.ts tests/coordinator.test.ts
```

## Test Coverage Requirements

**MUST HAVE 100% coverage for:**
- Workflow YAML files (schema validation)
- Git artifact commits (architectural tests)
- Persona payload contracts (contract tests)
- .ma/ directory structure (architectural tests)

**Current Coverage Gaps:**
```
❌ No tests for workflow YAML structure
❌ No tests validating git commits
❌ No tests validating .ma/ directory
❌ No tests for persona payload schemas
```

**After Implementation:**
```
✅ 100% coverage for workflow schemas
✅ 100% coverage for git operations
✅ 100% coverage for .ma/ directory structure
✅ 100% coverage for persona contracts
```

## Test Execution Strategy

### Development Workflow

```bash
# Before committing
npm run test:architecture  # Fast (30s)
npm run test:unit          # Fast (1min)
npm run test:integration   # Slow (5min)

# On PR
npm run test:all           # All tests
```

### CI/CD Workflow

```
1. Architectural Tests (CRITICAL) - 30s
   ↓ MUST PASS
2. Workflow Schema Validation - 10s
   ↓ MUST PASS
3. Contract Tests - 20s
   ↓ MUST PASS
4. Unit Tests - 1min
   ↓ Should Pass
5. Integration Tests - 5min
   ↓ Should Pass
6. E2E Tests - 10min
```

## Monitoring and Alerts

### Production Monitoring

```typescript
// Add monitoring for git operations
async function commitArtifact(path: string) {
  const startTime = Date.now();
  try {
    await runGit(['commit', ...]);
    metrics.recordGitCommit({ duration: Date.now() - startTime, success: true });
  } catch (err) {
    metrics.recordGitCommit({ duration: Date.now() - startTime, success: false });
    alerts.send('Git commit failed - distributed architecture broken!');
    throw err;
  }
}
```

### Health Checks

```typescript
// Validate .ma/ structure exists
async function healthCheck() {
  const checks = {
    contextSnapshot: await fileExists('.ma/context/snapshot.json'),
    contextSummary: await fileExists('.ma/context/summary.md'),
    gitCommits: await hasRecentCommits('.ma/')
  };

  if (!checks.contextSnapshot || !checks.contextSummary) {
    alerts.send('CRITICAL: Context artifacts missing - distributed architecture broken!');
  }

  return checks;
}
```

## Documentation Requirements

Every architectural requirement MUST have:
1. ✅ Test validating it works
2. ✅ Documentation explaining why it's critical
3. ✅ Monitoring to detect failures
4. ✅ Alerts when it breaks

## Summary

**The problem:** Architectural requirements weren't tested.

**The solution:** 5-layer testing strategy:
1. **Architectural Invariant Tests** - CRITICAL requirements (git commits, .ma/ structure)
2. **Workflow Schema Validation** - YAML files follow patterns
3. **Contract Tests** - Personas receive expected data
4. **E2E Workflow Tests** - Complete workflows work
5. **Step-Level Unit Tests** - Individual steps work

**How to prevent recurrence:**
- ✅ Run architectural tests in pre-commit hooks
- ✅ Fail CI/CD if architectural tests fail
- ✅ Require 100% coverage for critical paths
- ✅ Add production monitoring for git operations
- ✅ Alert when .ma/ structure missing

**The guarantee:** If architectural tests pass, distributed architecture works. Period.
