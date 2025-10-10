# Multi-Agent Machine Client - Refactor Plan

## Executive Summary

The current implementation has several critical issues that prevent proper code diff application and workflow coordination. This refactor plan outlines a complete restructuring to create a modular, composable workflow system with YAML configuration support.

## Current Issues Identified

### 1. **Diff Application Failures**
- **Root Cause**: Persona responses generate diffs but the parsing and application chain fails
- **Evidence**: Logs show "persona apply: no diff blocks detected" despite diffs being present
- **Impact**: Code changes never get committed to repositories

### 2. **Monolithic Coordinator**
- **Problem**: `coordinator.ts` is 933 lines of tightly coupled workflow logic
- **Issues**: 
  - Hard to test individual workflow steps
  - Difficult to modify workflow sequences
  - No reusable components for different workflow patterns
  - Mixed concerns (git ops, persona management, task routing)

### 3. **Persona Response Processing**
- **Problem**: Unreliable parsing of agent responses containing diffs
- **Evidence**: `parseAgentEditsFromResponse` and related helpers fail to extract valid edit specs
- **Impact**: Valid code changes are lost in the processing pipeline

### 4. **Git Operations Integration**
- **Problem**: Git operations are scattered and not properly integrated with workflow state
- **Evidence**: Fast-forward merge failures, branch alignment issues
- **Impact**: Inconsistent repository state across workflow steps

### 5. **No Workflow Configuration**
- **Problem**: Workflows are hardcoded in coordinator logic
- **Impact**: Cannot adapt workflows for different project types or requirements

## Proposed Architecture

### 1. **Workflow Engine Core**
```
src/workflows/
├── engine/
│   ├── WorkflowEngine.ts          # Main orchestration engine
│   ├── WorkflowContext.ts         # Shared state and utilities
│   ├── WorkflowStep.ts            # Base step interface
│   └── WorkflowValidator.ts       # YAML schema validation
├── steps/                         # Individual workflow steps
│   ├── PullTaskStep.ts           # Dashboard task retrieval
│   ├── ContextStep.ts            # Context scanning and summarization
│   ├── PlanningStep.ts           # Implementation planning
│   ├── CodeGenStep.ts            # Code generation
│   ├── DiffApplyStep.ts          # Diff parsing and application
│   ├── CommitStep.ts             # Git commit and push
│   ├── QAStep.ts                 # Quality assurance testing
│   └── TaskUpdateStep.ts         # Dashboard status updates
├── workflows/                     # Workflow definitions
│   ├── project-loop.yaml         # Main project workflow
│   ├── hotfix.yaml               # Hotfix workflow
│   ├── feature.yaml              # Feature development workflow
│   └── qa-followup.yaml          # QA failure handling workflow
└── coordinator.ts                 # Simplified coordinator (entry point)
```

### 2. **Persona Management Refactor**
```
src/agents/
├── PersonaManager.ts             # Centralized persona orchestration
├── PersonaResponse.ts            # Standardized response handling
├── PersonaTimeout.ts             # Timeout and error handling
└── parsers/                      # Response parsing modules
    ├── DiffParser.ts             # Extract and validate diffs
    ├── JsonParser.ts             # Extract JSON responses
    └── StatusParser.ts           # Extract status information
```

### 3. **Git Operations Service**
```
src/git/
├── GitService.ts                 # High-level git operations
├── BranchManager.ts              # Branch creation and management
├── CommitManager.ts              # Commit and push operations
├── ConflictResolver.ts           # Merge conflict handling
└── StateValidator.ts             # Repository state validation
```

### 4. **YAML Workflow Configuration**

#### Example: `workflows/project-loop.yaml`
```yaml
name: "project-loop"
description: "Main project development workflow"
version: "1.0"

trigger:
  condition: "project_has_open_tasks"
  
context:
  repo_required: true
  branch_strategy: "milestone_based"
  
steps:
  - name: "initialize"
    type: "PullTaskStep"
    description: "Pull task from project dashboard"
    persona: "coordinator"
    config:
      task_selection: "next_pending"
      milestone_aware: true
    outputs:
      - "selected_task"
      - "selected_milestone"
      
  - name: "context_scan"
    type: "ContextStep"
    description: "Scan and summarize project context"
    persona: "context-agent"
    depends_on: ["initialize"]
    config:
      rescan_threshold: "code_changes_detected"
      include_artifacts: true
    outputs:
      - "context_summary"
      - "code_artifacts"
      
  - name: "planning"
    type: "PlanningStep"
    description: "Create implementation plan"
    persona: "implementation-planner"
    depends_on: ["context_scan"]
    config:
      plan_depth: "detailed"
      include_risks: true
    outputs:
      - "implementation_plan"
      
  - name: "plan_evaluation"
    type: "PlanEvaluationStep"
    description: "Evaluate plan quality and relevance"
    persona: "plan-evaluator"
    depends_on: ["planning"]
    config:
      approval_threshold: "pass"
    outputs:
      - "plan_status"
      
  - name: "implementation"
    type: "CodeGenStep"
    description: "Generate code changes"
    persona: "lead-engineer"
    depends_on: ["plan_evaluation"]
    condition: "plan_status == 'pass'"
    config:
      diff_format: "unified"
      include_context: true
    outputs:
      - "code_diffs"
      - "changed_files"
      
  - name: "apply_changes"
    type: "DiffApplyStep"
    description: "Apply code diffs to repository"
    depends_on: ["implementation"]
    config:
      validation: "syntax_check"
      backup: true
    outputs:
      - "applied_files"
      - "commit_sha"
      
  - name: "commit_push"
    type: "CommitStep"
    description: "Commit and push changes"
    depends_on: ["apply_changes"]
    config:
      message_template: "feat: {task_name} - {milestone_name}"
      push_to_origin: true
    outputs:
      - "commit_sha"
      - "push_status"
      
  - name: "qa_testing"
    type: "QAStep"
    description: "Run quality assurance tests"
    persona: "tester-qa"
    depends_on: ["commit_push"]
    config:
      test_commands: ["npm test", "npm run lint"]
      timeout: "5m"
    outputs:
      - "qa_status"
      - "test_results"
      
  - name: "status_update"
    type: "TaskUpdateStep"
    description: "Update task status on dashboard"
    depends_on: ["qa_testing"]
    config:
      success_status: "completed"
      failure_status: "needs_review"

failure_handling:
  qa_failure:
    workflow: "qa-followup.yaml"
    max_iterations: 3
    
  git_conflict:
    step: "ConflictResolutionStep"
    auto_resolve: true
    
  persona_timeout:
    retry_count: 2
    escalation: "project-manager"
```

#### Example: `workflows/qa-followup.yaml`
```yaml
name: "qa-followup"
description: "Handle QA failures with iterative fixes"
version: "1.0"

trigger:
  condition: "qa_status == 'fail'"
  
context:
  inherit_from_parent: true
  
steps:
  - name: "analyze_failure"
    type: "QAAnalysisStep"
    description: "Analyze QA failure details"
    persona: "tester-qa"
    config:
      include_logs: true
      suggest_fixes: true
    outputs:
      - "failure_analysis"
      - "fix_suggestions"
      
  - name: "create_followup_tasks"
    type: "TaskCreationStep"
    description: "Create dashboard tasks for issues"
    persona: "project-manager"
    depends_on: ["analyze_failure"]
    config:
      task_template: "qa_issue"
      assign_to_milestone: true
    outputs:
      - "created_tasks"
      
  - name: "plan_fixes"
    type: "PlanningStep"
    description: "Plan fixes for QA issues"
    persona: "implementation-planner"
    depends_on: ["create_followup_tasks"]
    config:
      focus: "qa_issues"
      incremental: true
    outputs:
      - "fix_plan"
      
  - name: "implement_fixes"
    type: "CodeGenStep"
    description: "Implement QA fixes"
    persona: "lead-engineer"
    depends_on: ["plan_fixes"]
    config:
      incremental_mode: true
      preserve_existing: true
    outputs:
      - "fix_diffs"
      
  - name: "apply_fixes"
    type: "DiffApplyStep"
    depends_on: ["implement_fixes"]
    
  - name: "retest"
    type: "QAStep"
    description: "Re-run QA tests"
    persona: "tester-qa"
    depends_on: ["apply_fixes"]
    config:
      focus_on_failures: true
```

## Implementation Phases

### Phase 1: Foundation (Week 1)
**Goal**: Create the core workflow engine and basic step infrastructure

**Tasks**:
1. **Create Workflow Engine Core**
   - Implement `WorkflowEngine.ts` with YAML loading
   - Create `WorkflowContext.ts` for shared state
   - Define `WorkflowStep.ts` interface and base class
   - Add YAML schema validation

2. **Refactor Diff Processing**
   - Extract diff parsing from coordinator into `DiffParser.ts`
   - Fix `parseAgentEditsFromResponse` reliability issues
   - Create robust `DiffApplyStep.ts` implementation
   - Add comprehensive diff validation and error handling

3. **Git Service Layer**
   - Create `GitService.ts` with high-level operations
   - Implement `BranchManager.ts` for branch lifecycle
   - Add `CommitManager.ts` for atomic commit operations
   - Include proper error handling and state validation

**Deliverables**:
- Working workflow engine that can load and execute simple YAML workflows
- Reliable diff parsing and application
- Refactored git operations with proper error handling
- Comprehensive unit tests for core components

### Phase 2: Step Implementation (Week 2)
**Goal**: Implement all workflow steps as modular components

**Tasks**:
1. **Basic Workflow Steps**
   - `PullTaskStep.ts` - Dashboard task retrieval
   - `ContextStep.ts` - Context scanning integration
   - `TaskUpdateStep.ts` - Dashboard status updates

2. **Planning and Implementation Steps**
   - `PlanningStep.ts` - Implementation planning
   - `PlanEvaluationStep.ts` - Plan validation
   - `CodeGenStep.ts` - Code generation orchestration

3. **Quality Assurance Steps**
   - `QAStep.ts` - Test execution and validation
   - `QAAnalysisStep.ts` - Failure analysis
   - `TaskCreationStep.ts` - Followup task creation

**Deliverables**:
- Complete set of workflow steps
- Integration with existing persona system
- Step-level testing and validation
- Documentation for each step type

### Phase 3: Workflow Definitions (Week 3)
**Goal**: Create YAML workflow definitions for all current use cases

**Tasks**:
1. **Core Workflows**
   - `project-loop.yaml` - Main development cycle
   - `qa-followup.yaml` - QA failure handling
   - `hotfix.yaml` - Critical bug fixes

2. **Specialized Workflows**
   - `feature.yaml` - Feature development
   - `milestone.yaml` - Milestone completion
   - `context-only.yaml` - Context scanning only

3. **Workflow Validation**
   - Schema validation for all YAML files
   - Integration testing with real projects
   - Performance optimization

**Deliverables**:
- Complete YAML workflow library
- Workflow validation and testing tools
- Migration guide from old coordinator
- Performance benchmarks

### Phase 4: Integration and Migration (Week 4)
**Goal**: Replace the monolithic coordinator with the new workflow engine

**Tasks**:
1. **Coordinator Refactoring**
   - Simplify `coordinator.ts` to workflow engine entry point
   - Remove hardcoded workflow logic
   - Add workflow selection based on triggers

2. **Persona Integration**
   - Update persona system to work with new step architecture
   - Improve response parsing reliability
   - Add better timeout and error handling

3. **Testing and Validation**
   - End-to-end testing with real projects
   - Performance testing and optimization
   - Backward compatibility verification

**Deliverables**:
- Fully migrated system using workflow engine
- Comprehensive test suite
- Performance improvements
- Documentation and migration guide

## Key Benefits

### 1. **Modularity and Reusability**
- Workflow steps can be composed into different sequences
- Easy to test individual components
- Reusable patterns across different project types

### 2. **Configuration-Driven Workflows**
- YAML configuration allows customization without code changes
- Different workflows for different project phases
- Easy to add new workflow patterns

### 3. **Improved Reliability**
- Better error handling and recovery
- Atomic operations with proper rollback
- State validation at each step

### 4. **Enhanced Debugging**
- Clear step-by-step execution tracking
- Detailed logging and diagnostics
- Easy to isolate and fix issues

### 5. **Extensibility**
- Easy to add new step types
- Plugin architecture for custom workflows
- Integration points for external tools

## Technical Implementation Details

### Workflow Engine Architecture
```typescript
interface WorkflowStep {
  name: string;
  type: string;
  execute(context: WorkflowContext): Promise<StepResult>;
  validate(context: WorkflowContext): Promise<ValidationResult>;
  rollback?(context: WorkflowContext): Promise<void>;
}

interface WorkflowContext {
  workflowId: string;
  projectId: string;
  repoRoot: string;
  branch: string;
  variables: Map<string, any>;
  stepOutputs: Map<string, any>;
  config: WorkflowConfig;
}

class WorkflowEngine {
  async executeWorkflow(
    workflowPath: string, 
    context: WorkflowContext
  ): Promise<WorkflowResult>;
  
  async executeStep(
    step: WorkflowStepConfig, 
    context: WorkflowContext
  ): Promise<StepResult>;
}
```

### Diff Processing Pipeline
```typescript
class DiffParser {
  static parsePersonaResponse(response: string): EditSpec;
  static validateEditSpec(spec: EditSpec): ValidationResult;
  static extractDiffBlocks(text: string): DiffBlock[];
}

class DiffApplyStep extends WorkflowStep {
  async execute(context: WorkflowContext): Promise<StepResult> {
    const diffs = context.getOutput('code_diffs');
    const editSpec = DiffParser.parsePersonaResponse(diffs);
    const validation = DiffParser.validateEditSpec(editSpec);
    
    if (!validation.valid) {
      throw new ValidationError(validation.errors);
    }
    
    const result = await this.gitService.applyEdits(editSpec);
    return new StepResult('success', { appliedFiles: result.changed });
  }
}
```

### Git Service Integration
```typescript
class GitService {
  async applyEdits(editSpec: EditSpec): Promise<GitApplyResult>;
  async createBranch(baseBranch: string, newBranch: string): Promise<void>;
  async commitChanges(message: string, files: string[]): Promise<string>;
  async pushBranch(branch: string): Promise<void>;
  async validateState(): Promise<GitStateValidation>;
}
```

## Migration Strategy

### 1. **Gradual Migration**
- Implement new system alongside existing coordinator
- Feature flag to switch between old and new systems
- Migrate workflows one at a time

### 2. **Compatibility Layer**
- Maintain existing API contracts during transition
- Gradually deprecate old coordinator methods
- Provide migration tools for custom configurations

### 3. **Testing Strategy**
- Shadow mode testing with real workflows
- A/B testing between old and new systems
- Comprehensive regression testing

## Risk Mitigation

### 1. **Performance Risks**
- **Risk**: YAML parsing and workflow overhead
- **Mitigation**: Caching, lazy loading, performance monitoring

### 2. **Complexity Risks**
- **Risk**: Over-engineering the workflow system
- **Mitigation**: Start simple, iterate based on real needs

### 3. **Migration Risks**
- **Risk**: Breaking existing workflows during migration
- **Mitigation**: Feature flags, gradual rollout, comprehensive testing

### 4. **Reliability Risks**
- **Risk**: New bugs in refactored code
- **Mitigation**: Extensive testing, monitoring, rollback capabilities

## Success Metrics

### 1. **Reliability Metrics**
- Diff application success rate: >95%
- Workflow completion rate: >90%
- Git operation failure rate: <5%

### 2. **Performance Metrics**
- Workflow execution time: <20% increase from current
- Memory usage: No significant increase
- CPU usage: No significant increase

### 3. **Maintainability Metrics**
- Code complexity reduction: >50%
- Test coverage: >90%
- Time to add new workflow: <2 hours

### 4. **Usability Metrics**
- Configuration errors: <10% of deployments
- Workflow customization time: <1 hour
- Time to debug issues: <50% of current

This refactor plan addresses all the current issues while providing a foundation for future enhancements and better maintainability.