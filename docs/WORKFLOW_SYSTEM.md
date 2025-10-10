# Workflow System Architecture

## Overview

The workflow system provides a YAML-based configuration approach for defining multi-agent coordination workflows. It replaces the monolithic coordinator logic with a modular, step-based execution engine that maintains backward compatibility while offering enhanced flexibility and maintainability.

## Architecture Components

### Core Interfaces

#### WorkflowStep
Individual workflow execution units with dependency management:

```typescript
interface WorkflowStep {
  id: string;
  name: string;
  type: string;
  persona?: string;
  dependencies?: string[];
  timeout?: number;
  retries?: number;
  condition?: string;
  params?: Record<string, any>;
  execute(context: WorkflowContext): Promise<WorkflowStepResult>;
}
```

#### WorkflowContext
Shared execution context across workflow steps:

```typescript
interface WorkflowContext {
  workflowId: string;
  task: any;
  milestone?: any;
  repoRoot: string;
  branchName: string;
  baseBranch: string;
  state: Map<string, any>;
  dashboardState: any;
  gitState: any;
  artifacts: any[];
  personaResults: Map<string, any>;
}
```

### WorkflowEngine

The core execution engine that:
- Loads and validates YAML workflow definitions
- Manages step registry and dependency resolution
- Executes workflows with error handling and retry logic
- Maintains execution context and state management

Key features:
- **YAML Configuration**: Define workflows declaratively
- **Dependency Management**: Automatic step ordering based on dependencies
- **Error Handling**: Configurable retry policies and error recovery
- **State Management**: Persistent context across step executions
- **Conditional Execution**: Step execution based on runtime conditions

### WorkflowCoordinator

Integration layer that provides backward compatibility:
- Wraps WorkflowEngine with existing coordinator API
- Handles task type detection and workflow selection
- Preserves all existing functionality while using new engine internally
- Seamless integration with existing dashboard and git utilities

## YAML Workflow Definitions

### Basic Structure

```yaml
name: "project-loop"
version: "1.0.0"
description: "Standard project workflow with planning, implementation, and QA"

variables:
  max_retries: 3
  timeout_minutes: 30

steps:
  - id: "planning"
    name: "Implementation Planning"
    type: "persona-request"
    persona: "implementation-planner"
    timeout: 1800
    retries: 2
    params:
      stage: "initial"
      
  - id: "plan-evaluation"
    name: "Plan Evaluation"
    type: "persona-request"
    persona: "plan-evaluator"
    dependencies: ["planning"]
    condition: "context.state.get('planning_result')"
    
  - id: "implementation"
    name: "Lead Engineer Implementation"
    type: "persona-request"
    persona: "lead-engineer"
    dependencies: ["plan-evaluation"]
    timeout: 3600
    
  - id: "qa"
    name: "Quality Assurance"
    type: "persona-request"
    persona: "qa-engineer"
    dependencies: ["implementation"]
    
  - id: "code-review"
    name: "Code Review"
    type: "persona-request"
    persona: "code-reviewer"
    dependencies: ["qa"]
    condition: "context.state.get('qa_status') === 'pass'"
    
  - id: "security-review"
    name: "Security Review"
    type: "persona-request"
    persona: "security-review"
    dependencies: ["qa"]
    condition: "context.state.get('qa_status') === 'pass'"
```

### Step Types

#### persona-request
Dispatches requests to specific personas:
- `persona`: Target persona name
- `timeout`: Request timeout in seconds
- `retries`: Number of retry attempts
- `params`: Additional parameters for the persona

#### git-operation
Performs git operations:
- `operation`: Git command type (commit, push, merge, etc.)
- `branch`: Target branch
- `message`: Commit message template

#### conditional
Conditional execution wrapper:
- `condition`: JavaScript expression to evaluate
- `then_steps`: Steps to execute if condition is true
- `else_steps`: Steps to execute if condition is false

#### parallel
Parallel execution of multiple steps:
- `steps`: Array of steps to execute concurrently
- `wait_for`: "all" or "any" completion strategy

### Variables and Templating

Workflows support variable substitution and templating:

```yaml
variables:
  project_name: "{{task.project}}"
  branch_prefix: "feat/"
  timeout_base: 1800

steps:
  - id: "setup"
    name: "Setup {{variables.project_name}}"
    timeout: "{{variables.timeout_base}}"
    params:
      branch: "{{variables.branch_prefix}}{{task.slug}}"
```

### Conditional Logic

Steps can include conditions for dynamic execution:

```yaml
steps:
  - id: "hotfix-path"
    name: "Hotfix Implementation"
    condition: "task.type === 'hotfix'"
    type: "persona-request"
    persona: "hotfix-specialist"
    
  - id: "standard-path"
    name: "Standard Implementation"
    condition: "task.type !== 'hotfix'"
    type: "persona-request"
    persona: "lead-engineer"
```

## Step Registry

The system includes built-in step implementations:

### PersonaRequestStep
Handles persona communication and coordination:
- Dispatches requests to Redis streams
- Manages persona timeouts and retries
- Processes persona responses and artifacts
- Updates workflow context with results

### GitOperationStep
Manages git repository operations:
- Branch creation and switching
- Commit and push operations
- Merge and rebase handling
- Remote synchronization

### ConditionalStep
Provides conditional execution logic:
- Evaluates JavaScript expressions in context
- Supports complex conditional workflows
- Enables dynamic step routing

### ParallelStep
Enables concurrent step execution:
- Manages parallel persona requests
- Handles different completion strategies
- Provides result aggregation

## Integration with Existing System

### Backward Compatibility

The WorkflowCoordinator maintains full backward compatibility:
- All existing API endpoints continue to work
- No changes required to calling code
- Seamless migration from monolithic coordinator
- Preserves all error handling and logging

### Task Processing Flow

1. **Task Receipt**: WorkflowCoordinator receives task from existing system
2. **Type Detection**: Analyzes task properties to determine workflow type
3. **Workflow Selection**: Loads appropriate YAML workflow definition
4. **Context Creation**: Builds WorkflowContext with task and environment data
5. **Engine Execution**: WorkflowEngine executes workflow steps
6. **Result Processing**: Results processed and returned via existing API

### Configuration

Workflows are stored in the `workflows/` directory:
- `workflows/project-loop.yml`: Standard development workflow
- `workflows/hotfix.yml`: Emergency hotfix workflow  
- `workflows/feature.yml`: Feature-specific workflow

## Error Handling and Recovery

### Step-Level Error Handling
- Configurable retry policies per step
- Timeout management with graceful degradation
- Error context preservation and logging
- Automatic rollback capabilities

### Workflow-Level Recovery
- Checkpoint-based state persistence
- Resume from failure points
- Circuit breaker patterns for unstable services
- Escalation to human operators when needed

### Monitoring and Observability
- Comprehensive logging at each step
- Metrics collection for performance monitoring
- Distributed tracing across persona interactions
- Dashboard integration for real-time status

## Migration Guide

### Phase 1: Parallel Operation
1. Deploy WorkflowCoordinator alongside existing coordinator
2. Route specific task types to new system for testing
3. Monitor performance and compatibility
4. Gradually increase coverage

### Phase 2: Full Migration
1. Convert all task processing to workflow engine
2. Retire monolithic coordinator logic
3. Update documentation and training materials
4. Optimize workflows based on operational experience

### Phase 3: Enhancement
1. Add new workflow types for specialized use cases
2. Implement advanced features (parallel processing, dynamic routing)
3. Integrate with external systems and tools
4. Optimize performance and resource utilization

## Best Practices

### Workflow Design
- Keep workflows focused and cohesive
- Use meaningful step names and descriptions
- Design for failure scenarios and recovery
- Document workflow purpose and usage

### Step Implementation
- Make steps idempotent where possible
- Use appropriate timeouts and retry policies
- Implement proper error handling and logging
- Test step implementations thoroughly

### Configuration Management
- Version control workflow definitions
- Use environment-specific variables
- Validate workflows before deployment
- Monitor workflow performance metrics

### Testing Strategy
- Unit test individual step implementations
- Integration test complete workflows
- Performance test under realistic load
- Validate error handling and recovery paths

## Troubleshooting

### Common Issues
- **Step Dependencies**: Ensure dependency graph is acyclic
- **Timeout Configuration**: Balance responsiveness with completion time
- **Resource Limits**: Monitor memory and CPU usage during execution
- **Persona Availability**: Handle persona service unavailability gracefully

### Debugging Tools
- Workflow execution logs with step-by-step details
- Context state inspection at each step
- Performance profiling and bottleneck identification
- Integration with existing debugging infrastructure

## Future Enhancements

### Planned Features
- Visual workflow editor and designer
- Real-time workflow monitoring dashboard
- Advanced analytics and optimization recommendations
- Integration with external workflow engines

### Extensibility Points
- Custom step type implementations
- Plugin architecture for third-party integrations
- Workflow composition and nesting
- Dynamic workflow generation based on task analysis

This workflow system provides a robust foundation for multi-agent coordination while maintaining the flexibility to evolve with changing requirements and use cases.