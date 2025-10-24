import { WorkflowStep, WorkflowStepConfig } from './engine/WorkflowStep';
import { WorkflowContext, WorkflowConfig } from './engine/WorkflowContext';
import type { MessageTransport } from '../transport/index.js';
import { PullTaskStep } from './steps/PullTaskStep';
import { ContextStep } from './steps/ContextStep';
import { TaskUpdateStep } from './steps/TaskUpdateStep';
import { CodeGenStep } from './steps/CodeGenStep';
import { PlanningStep } from './steps/PlanningStep';
import { QAStep } from './steps/QAStep';
import { PlanEvaluationStep } from './steps/PlanEvaluationStep';
import { QAAnalysisStep } from './steps/QAAnalysisStep';
import { TaskCreationStep } from './steps/TaskCreationStep';
import { DiffApplyStep } from './steps/DiffApplyStep';
import { PersonaRequestStep } from './steps/PersonaRequestStep';
import { ConditionalStep } from './steps/ConditionalStep';
import { SimpleTaskStatusStep } from './steps/SimpleTaskStatusStep';
import { GitOperationStep } from './steps/GitOperationStep';
import { PlanningLoopStep } from './steps/PlanningLoopStep';
import { VariableSetStep } from './steps/VariableSetStep';
import { BlockedTaskAnalysisStep } from './steps/BlockedTaskAnalysisStep';
import { UnblockAttemptStep } from './steps/UnblockAttemptStep';
import { MilestoneStatusCheckStep } from './steps/MilestoneStatusCheckStep';
import { ReviewFailureTasksStep } from './steps/ReviewFailureTasksStep';
import { SubWorkflowStep } from './steps/SubWorkflowStep';
import { BulkTaskCreationStep } from './steps/BulkTaskCreationStep';
import { PMDecisionParserStep } from './steps/PMDecisionParserStep';
import { VariableResolutionStep } from './steps/VariableResolutionStep';
import { personaTimeoutMs } from '../util.js';
import { parse as yamlParse } from 'yaml';
import { readFile, readdir } from 'fs/promises';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { logger } from '../logger.js';
import { cfg } from '../config.js';

/**
 * YAML workflow definition structure
 */
export interface WorkflowDefinition {
  name: string;
  description: string;
  version: string;
  trigger: {
    condition: string;
  };
  context: {
    repo_required: boolean;
    branch_strategy?: string;
  };
  steps: WorkflowStepDefinition[];
  failure_handling?: {
    on_step_failure?: WorkflowStepDefinition[];
    on_workflow_failure?: WorkflowStepDefinition[];
  };
  timeouts?: {
    [key: string]: number;
  };
}

/**
 * Individual step definition in YAML
 */
export interface WorkflowStepDefinition {
  name: string;
  type: string;
  description: string;
  depends_on?: string[];
  condition?: string;
  config: Record<string, any>;
  outputs?: string[];
}

/**
 * Workflow execution result
 */
export interface WorkflowExecutionResult {
  success: boolean;
  completedSteps: string[];
  failedStep?: string;
  error?: Error;
  duration: number;
  finalContext: WorkflowContext;
}

/**
 * Engine for executing YAML-defined workflows
 */
export class WorkflowEngine {
  private stepRegistry: Map<string, new (...args: any[]) => WorkflowStep>;
  private workflowDefinitions: Map<string, WorkflowDefinition>;
  private defaultWorkflowsLoaded = false;

  constructor() {
    this.stepRegistry = new Map();
    this.workflowDefinitions = new Map();
    this.registerBuiltInSteps();
  }

  /**
   * Ensure default workflow definitions are loaded once from the repo
   * This provides out-of-the-box availability for tests and runtime that
   * expect standard workflows (e.g., task-flow) without manual loading.
   */
  private async ensureDefaultWorkflowsLoaded(): Promise<void> {
    if (this.defaultWorkflowsLoaded) return;
    // Best-effort loading from conventional locations; ignore errors silently
    const baseDir = process.cwd();
    const defsDir = join(baseDir, 'src', 'workflows', 'definitions');
    const subDir = join(baseDir, 'src', 'workflows', 'sub-workflows');
    try {
      await this.loadWorkflowsFromDirectory(defsDir);
    } catch (e) {
      // no-op
    }
    try {
      await this.loadWorkflowsFromDirectory(subDir);
    } catch (e) {
      // no-op
    }
    this.defaultWorkflowsLoaded = true;
  }

  /**
   * Register all built-in workflow step types
   */
  private registerBuiltInSteps(): void {
    this.stepRegistry.set('PullTaskStep', PullTaskStep);
    this.stepRegistry.set('ContextStep', ContextStep);
    this.stepRegistry.set('TaskUpdateStep', TaskUpdateStep);
    this.stepRegistry.set('CodeGenStep', CodeGenStep);
    this.stepRegistry.set('PlanningStep', PlanningStep);
    this.stepRegistry.set('QAStep', QAStep);
    this.stepRegistry.set('PlanEvaluationStep', PlanEvaluationStep);
    this.stepRegistry.set('QAAnalysisStep', QAAnalysisStep);
    this.stepRegistry.set('TaskCreationStep', TaskCreationStep);
    this.stepRegistry.set('DiffApplyStep', DiffApplyStep);
    this.stepRegistry.set('PersonaRequestStep', PersonaRequestStep);
    this.stepRegistry.set('ConditionalStep', ConditionalStep);
    this.stepRegistry.set('SimpleTaskStatusStep', SimpleTaskStatusStep);
    this.stepRegistry.set('GitOperationStep', GitOperationStep);
    this.stepRegistry.set('PlanningLoopStep', PlanningLoopStep);
    this.stepRegistry.set('VariableSetStep', VariableSetStep);
    this.stepRegistry.set('BlockedTaskAnalysisStep', BlockedTaskAnalysisStep);
    this.stepRegistry.set('UnblockAttemptStep', UnblockAttemptStep);
    this.stepRegistry.set('MilestoneStatusCheckStep', MilestoneStatusCheckStep);
    this.stepRegistry.set('ReviewFailureTasksStep', ReviewFailureTasksStep);
    // New sub-workflow support steps
    this.stepRegistry.set('SubWorkflowStep', SubWorkflowStep);
    this.stepRegistry.set('BulkTaskCreationStep', BulkTaskCreationStep);
    this.stepRegistry.set('PMDecisionParserStep', PMDecisionParserStep);
    this.stepRegistry.set('VariableResolutionStep', VariableResolutionStep);
  }

  /**
   * Register a custom step type
   */
  public registerStep(type: string, stepClass: new (...args: any[]) => WorkflowStep): void {
    this.stepRegistry.set(type, stepClass);
  }

  /**
   * Load workflow definition from YAML file
   */
  public async loadWorkflowFromFile(filePath: string): Promise<WorkflowDefinition> {
    try {
      const yamlContent = await readFile(filePath, 'utf-8');
      const definition = yamlParse(yamlContent) as WorkflowDefinition;
      
      this.validateWorkflowDefinition(definition);
      this.workflowDefinitions.set(definition.name, definition);
      
      return definition;
    } catch (error: any) {
      throw new Error(`Failed to load workflow from ${filePath}: ${error.message}`);
    }
  }

  /**
   * Load all workflow definitions from a directory
   */
  public async loadWorkflowsFromDirectory(directoryPath: string): Promise<WorkflowDefinition[]> {
    try {
      const files = await readdir(directoryPath);
      const yamlFiles = files
        .filter((file: string) => file.endsWith('.yaml') || file.endsWith('.yml'))
        .filter((file: string) => !/^test[-_.]/i.test(file));
      
      const definitions: WorkflowDefinition[] = [];
      
      for (const file of yamlFiles) {
        const filePath = join(directoryPath, file);
        try {
          const definition = await this.loadWorkflowFromFile(filePath);
          definitions.push(definition);
        } catch (error: any) {
          console.warn(`Failed to load workflow from ${file}: ${error.message}`);
        }
      }
      
      return definitions;
    } catch (error: any) {
      throw new Error(`Failed to load workflows from directory ${directoryPath}: ${error.message}`);
    }
  }

  /**
   * Get workflow definition by name
   */
  public getWorkflowDefinition(name: string): WorkflowDefinition | undefined {
    return this.workflowDefinitions.get(name);
  }

  /**
   * Get all loaded workflow definitions
   */
  public getWorkflowDefinitions(): WorkflowDefinition[] {
    return Array.from(this.workflowDefinitions.values());
  }

  /**
   * Find workflow by trigger condition
   */
  public findWorkflowByCondition(taskType: string, scope?: string): WorkflowDefinition | undefined {
    for (const definition of this.workflowDefinitions.values()) {
      if (this.evaluateCondition(definition.trigger.condition, taskType, scope)) {
        return definition;
      }
    }
    return undefined;
  }

  /**
   * Execute a workflow by name
   */
  public async executeWorkflow(
    workflowName: string,
    projectIdOrVars: string | Record<string, any>,
    repoRoot?: string,
    branch: string = 'main',
    transport?: MessageTransport,
    initialVariables: Record<string, any> = {}
  ): Promise<WorkflowExecutionResult> {
    let definition = this.workflowDefinitions.get(workflowName);
    if (!definition) {
      // Attempt to auto-load default workflow definitions on-demand
      await this.ensureDefaultWorkflowsLoaded();
      definition = this.workflowDefinitions.get(workflowName);
      if (!definition) {
        throw new Error(`Workflow '${workflowName}' not found`);
      }
    }

    // New-architecture alignment:
    // - If an object is passed as the second argument, treat it as initial variables
    //   and execute the workflow in normal mode, returning the modern WorkflowExecutionResult.
    if (typeof projectIdOrVars === 'object' && projectIdOrVars !== null) {
      const variables = projectIdOrVars as Record<string, any>;
      const seededVars: Record<string, any> = {
        // Keep test-friendly defaults to avoid external dependencies
        SKIP_GIT_OPERATIONS: true,
        SKIP_PERSONA_OPERATIONS: true,
        repo_remote: variables.repo || variables.repo_remote || 'git@example.com/repo.git',
        projectId: variables.project_id || variables.projectId || 'test-project',
        ...variables
      };
      // Ensure a task object exists for SimpleTaskStatusStep compatibility
      const legacyTaskId = (variables as any).task?.id || (variables as any).task_id || (variables as any).taskId;
      if (legacyTaskId && !seededVars.task) {
        seededVars.task = { id: legacyTaskId, title: (variables as any).task_name || (variables as any).title || 'test-task' };
      }

      return this.executeWorkflowDefinition(
        definition,
        String(seededVars.projectId || 'test-project'),
        process.cwd(),
        'main',
        undefined as any,
        seededVars
      );
    }

    // Normal mode with explicit projectId string
    const projectId = projectIdOrVars as string;
    return this.executeWorkflowDefinition(definition, projectId, repoRoot!, branch, transport as MessageTransport, initialVariables);
  }

  /**
   * Execute a workflow definition
   */
  public async executeWorkflowDefinition(
    definition: WorkflowDefinition,
    projectId: string,
    repoRoot: string,
    branch: string = 'main',
    transport: MessageTransport,
    initialVariables: Record<string, any> = {}
  ): Promise<WorkflowExecutionResult> {
    const startTime = Date.now();
    const completedSteps: string[] = [];
    
    // Create workflow context
    const workflowConfig: WorkflowConfig = {
      name: definition.name,
      description: definition.description,
      version: definition.version,
      steps: definition.steps,
      trigger: definition.trigger,
      context: definition.context,
      failure_handling: definition.failure_handling
    };

    const context = new WorkflowContext(
      randomUUID(),
      projectId,
      repoRoot,
      branch,
      workflowConfig,
      transport,
      initialVariables
    );
    
    try {
      // Set up default context variables
      this.setupDefaultContext(context);
      
      // Validate prerequisites
      this.validatePrerequisites(definition, context);
      
      // Build step execution order
      const executionOrder = this.buildExecutionOrder(definition.steps);
      
      // Execute steps in order
      for (const stepName of executionOrder) {
        const stepDef = definition.steps.find(s => s.name === stepName);
        if (!stepDef) {
          throw new Error(`Step definition not found: ${stepName}`);
        }

        // Check if step should be executed based on conditions and dependencies
        if (!this.shouldExecuteStep(stepDef, context, completedSteps)) {
          continue;
        }

        // Execute the step
        const success = await this.executeStep(stepDef, context, definition);

        if (success) {
          completedSteps.push(stepName);
        } else {
          // Handle step failure
          await this.handleStepFailure(stepDef, context, definition);
          
          return {
            success: false,
            completedSteps,
            failedStep: stepName,
            error: new Error(`Step '${stepName}' failed`),
            duration: Date.now() - startTime,
            finalContext: context
          };
        }
      }

      return {
        success: true,
        completedSteps,
        duration: Date.now() - startTime,
        finalContext: context
      };

    } catch (error: any) {
      // Handle workflow-level failure
      await this.handleWorkflowFailure(error, context, definition);

      return {
        success: false,
        completedSteps,
        error: error as Error,
        duration: Date.now() - startTime,
        finalContext: context
      };
    }
  }

  /**
   * Execute a single workflow step
   */
  private async executeStep(
    stepDef: WorkflowStepDefinition,
    context: WorkflowContext,
    workflowDef: WorkflowDefinition
  ): Promise<boolean> {
    try {
      // Create step instance
      const step = this.createStepInstance(stepDef, context);
      
      // Record step start
      context.recordStepStart(stepDef.name);
      
      // Set up timeout
      const timeout = this.getStepTimeout(stepDef, workflowDef);
      
      // Log timeout for persona request steps
      if (stepDef.type === 'PersonaRequestStep') {
        context.logger.info('Step timeout configured', {
          workflowId: context.workflowId,
          step: stepDef.name,
          persona: stepDef.config.persona,
          timeoutMs: timeout,
          timeoutMinutes: (timeout / 60000).toFixed(2)
        });
      }
      
      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error(`Step '${stepDef.name}' timed out after ${timeout}ms`)), timeout);
      });

      // Execute step with timeout
      const stepPromise = step.execute(context);
      const result = await Promise.race([stepPromise, timeoutPromise]);

      // Store step outputs - prioritize outputs field, fall back to data
      // Steps like PersonaRequestStep return outputs with the actual result data
      if (result.outputs) {
        context.setStepOutput(stepDef.name, result.outputs);
      } else if (result.data) {
        context.setStepOutput(stepDef.name, result.data);
      }

      // Record completion
      context.recordStepComplete(stepDef.name, result.status === 'success' ? 'success' : 'failure');

      return result.status === 'success';

    } catch (error: any) {
      context.recordStepComplete(stepDef.name, 'failure', error.message);
      throw error;
    }
  }

  /**
   * Create a step instance from definition
   */
  private createStepInstance(stepDef: WorkflowStepDefinition, context: WorkflowContext): WorkflowStep {
    const StepClass = this.stepRegistry.get(stepDef.type);
    if (!StepClass) {
      throw new Error(`Unknown step type: ${stepDef.type}`);
    }

    // Resolve configuration values from context
    const resolvedConfig = this.resolveConfiguration(stepDef.config, context);

    const stepConfig: WorkflowStepConfig = {
      name: stepDef.name,
      type: stepDef.type,
      description: stepDef.description,
      depends_on: stepDef.depends_on,
      condition: stepDef.condition,
      config: resolvedConfig,
      outputs: stepDef.outputs
    };

    return new StepClass(stepConfig);
  }

  /**
   * Resolve configuration placeholders with context values
   */
  private resolveConfiguration(config: Record<string, any>, context: WorkflowContext): Record<string, any> {
    const resolved: Record<string, any> = {};
    
    for (const [key, value] of Object.entries(config)) {
      resolved[key] = this.resolveValue(value, context);
    }
    
    return resolved;
  }

  /**
   * Resolve a single configuration value
   */
  private resolveValue(value: any, context: WorkflowContext): any {
    if (typeof value === 'string' && value.includes('${')) {
      // Replace placeholders like ${REPO_PATH} or ${task.title}
      return value.replace(/\$\{([^}]+)\}/g, (match, path) => {
        const contextValue = this.getNestedValue(context, path);
        return contextValue !== undefined ? String(contextValue) : match;
      });
    } else if (Array.isArray(value)) {
      return value.map(item => this.resolveValue(item, context));
    } else if (value && typeof value === 'object') {
      const resolved: Record<string, any> = {};
      for (const [k, v] of Object.entries(value)) {
        resolved[k] = this.resolveValue(v, context);
      }
      return resolved;
    }
    
    return value;
  }

  /**
   * Get nested value from context
   */
  private getNestedValue(context: WorkflowContext, path: string): any {
    // Handle special context variables
    // DEPRECATED: REPO_PATH should not be used - use repo_remote instead for distributed systems
    if (path === 'REPO_PATH') {
      logger.warn('REPO_PATH is deprecated. Use repo_remote for distributed agent coordination.');
      return context.repoRoot;
    }
    if (path === 'repoRoot') {
      // When repoRoot is referenced in workflow definitions, redirect to repo_remote for distributed systems
      logger.warn('repoRoot reference in workflow. Using repo_remote for distributed coordination.');
      return context.getVariable('repo_remote') || context.repoRoot;
    }
    if (path === 'REDIS_STREAM_NAME') return context.getVariable('REDIS_STREAM_NAME') || process.env.REDIS_STREAM_NAME || 'workflow-tasks';
    if (path === 'CONSUMER_GROUP') return context.getVariable('CONSUMER_GROUP') || process.env.CONSUMER_GROUP || 'workflow-consumers';
    if (path === 'CONSUMER_ID') return context.getVariable('CONSUMER_ID') || process.env.CONSUMER_ID || 'workflow-engine';
    
    // Try to get from variables first
    const variable = context.getVariable(path);
    if (variable !== undefined) {
      return variable;
    }
    
    // Try to get from step outputs
    if (path.includes('.')) {
      const [stepName, ...propertyPath] = path.split('.');
      const stepOutput = context.getStepOutput(stepName);
      if (stepOutput) {
        return propertyPath.reduce((current, key) => current?.[key], stepOutput);
      }
    }
    
    return undefined;
  }

  /**
   * Build step execution order based on dependencies
   */
  private buildExecutionOrder(steps: WorkflowStepDefinition[]): string[] {
    const order: string[] = [];
    const visited = new Set<string>();
    const visiting = new Set<string>();
    
    const visit = (stepName: string) => {
      if (visiting.has(stepName)) {
        throw new Error(`Circular dependency detected involving step: ${stepName}`);
      }
      
      if (visited.has(stepName)) {
        return;
      }
      
      visiting.add(stepName);
      
      const step = steps.find(s => s.name === stepName);
      if (!step) {
        throw new Error(`Step not found: ${stepName}`);
      }
      
      // Visit dependencies first
      if (step.depends_on) {
        for (const dependency of step.depends_on) {
          visit(dependency);
        }
      }
      
      visiting.delete(stepName);
      visited.add(stepName);
      order.push(stepName);
    };
    
    // Visit all steps
    for (const step of steps) {
      visit(step.name);
    }
    
    return order;
  }

  /**
   * Check if step should be executed based on conditions and dependencies
   */
  private shouldExecuteStep(
    stepDef: WorkflowStepDefinition,
    context: WorkflowContext,
    completedSteps: string[]
  ): boolean {
    // Check dependencies
    if (stepDef.depends_on) {
      for (const dependency of stepDef.depends_on) {
        if (!completedSteps.includes(dependency)) {
          return false;
        }
      }
    }

    // Check condition
    if (stepDef.condition) {
      const result = this.evaluateSimpleCondition(stepDef.condition, context);
      logger.debug('Step condition evaluated', {
        stepName: stepDef.name,
        condition: stepDef.condition,
        result,
        workflowId: context.workflowId
      });
      return result;
    }

    return true;
  }

  /**
   * Evaluate a simple condition string against context
   * Supports:
   * - Single equality: "${var} == 'value'"
   * - OR conditions: "${var} == 'value1' || ${var} == 'value2'"
   * - AND conditions: "${var1} == 'value1' && ${var2} == 'value2'"
   */
  private evaluateSimpleCondition(condition: string, context: WorkflowContext): boolean {
    try {
      // Handle OR conditions (||)
      if (condition.includes('||')) {
        const parts = condition.split('||').map(s => s.trim());
        return parts.some(part => this.evaluateSingleComparison(part, context));
      }
      
      // Handle AND conditions (&&)
      if (condition.includes('&&')) {
        const parts = condition.split('&&').map(s => s.trim());
        return parts.every(part => this.evaluateSingleComparison(part, context));
      }
      
      // Single comparison
      return this.evaluateSingleComparison(condition, context);
    } catch (error: any) {
      console.warn(`Failed to evaluate condition '${condition}': ${error.message}`);
      return false;
    }
  }

  /**
   * Evaluate a single comparison expression
   */
  private evaluateSingleComparison(condition: string, context: WorkflowContext): boolean {
    if (condition.includes('==')) {
      const [left, right] = condition.split('==').map(s => s.trim());
      
      // Handle ${variable} syntax in left side
      let leftVariableName = left.replace(/['"]/g, '');
      if (leftVariableName.startsWith('${') && leftVariableName.endsWith('}')) {
        leftVariableName = leftVariableName.slice(2, -1);
      }
      
      const leftValue = this.getNestedValue(context, leftVariableName);
      const rightValue = right.replace(/['"]/g, '');
      
      const result = String(leftValue) === rightValue;
      
      logger.debug('Condition comparison', {
        condition,
        variableName: leftVariableName,
        leftValue,
        rightValue,
        result,
        workflowId: context.workflowId
      });
      
      return result;
    }
    
    return true; // Default to true for unhandled conditions
  }

  /**
   * Evaluate workflow trigger condition
   */
  private evaluateCondition(condition: string, taskType: string, scope?: string): boolean {
    try {
      // Replace variables in condition
      const resolved = condition
        .replace(/task_type/g, `"${taskType}"`)
        .replace(/scope/g, `"${scope || ''}"`);
      
      // Simple condition evaluation
      if (resolved.includes('||')) {
        return resolved.split('||').some(part => this.evaluateSimpleComparison(part.trim()));
      } else if (resolved.includes('&&')) {
        return resolved.split('&&').every(part => this.evaluateSimpleComparison(part.trim()));
      } else {
        return this.evaluateSimpleComparison(resolved);
      }
    } catch (error: any) {
      console.warn(`Failed to evaluate trigger condition '${condition}': ${error.message}`);
      return false;
    }
  }

  /**
   * Evaluate simple comparison
   */
  private evaluateSimpleComparison(comparison: string): boolean {
    if (comparison.includes('==')) {
      const [left, right] = comparison.split('==').map(s => s.trim().replace(/['"]/g, ''));
      return left === right;
    }
    return false;
  }

  /**
   * Get timeout for a step
   */
  private getStepTimeout(stepDef: WorkflowStepDefinition, workflowDef: WorkflowDefinition): number {
    const timeouts = workflowDef.timeouts || {};
    
    // Check for step-specific timeout
    const stepTimeout = timeouts[`${stepDef.name}_timeout`] || timeouts[`${stepDef.type.toLowerCase()}_step`];
    if (stepTimeout) {
      return stepTimeout;
    }
    
    // For PersonaRequestStep, calculate timeout based on persona config + retries + backoff
    if (stepDef.type === 'PersonaRequestStep' && stepDef.config.persona) {
      const persona = String(stepDef.config.persona).toLowerCase();
      const maxRetries = stepDef.config.maxRetries ?? cfg.personaTimeoutMaxRetries ?? 3;
      
      // Get persona-specific timeout using centralized util function
      const personaTimeout = personaTimeoutMs(persona, cfg);
      
      // Calculate total timeout: (maxRetries + 1 initial) * personaTimeout + sum of backoff delays
      // Backoff delays: 30s, 60s, 90s, ... = 30 * (1 + 2 + 3 + ... + maxRetries)
      // Sum formula: n * (n + 1) / 2
      const totalBackoffMs = maxRetries > 0 ? (30 * 1000 * maxRetries * (maxRetries + 1)) / 2 : 0;
      const totalPersonaTimeMs = (maxRetries + 1) * personaTimeout;
      const calculatedTimeout = totalPersonaTimeMs + totalBackoffMs + 30000; // +30s buffer
      
      // Use info level so it's always visible in logs
      logger.info('Calculated PersonaRequestStep timeout to accommodate retries', {
        step: stepDef.name,
        persona,
        personaTimeoutMs: personaTimeout,
        personaTimeoutMinutes: (personaTimeout / 60000).toFixed(2),
        maxRetries,
        totalBackoffMs,
        totalBackoffMinutes: (totalBackoffMs / 60000).toFixed(2),
        totalPersonaTimeMs,
        calculatedTimeout,
        calculatedTimeoutMinutes: (calculatedTimeout / 60000).toFixed(2)
      });
      
      return calculatedTimeout;
    }
    
    // Default timeout
    return timeouts.default_step || 300000; // 5 minutes
  }

  /**
   * Handle step failure
   */
  private async handleStepFailure(
    failedStep: WorkflowStepDefinition,
    context: WorkflowContext,
    workflowDef: WorkflowDefinition
  ): Promise<void> {
    context.setVariable('error', {
      step: failedStep.name,
      type: failedStep.type,
      message: `Step '${failedStep.name}' failed`
    });

    if (workflowDef.failure_handling?.on_step_failure) {
      for (const handlerDef of workflowDef.failure_handling.on_step_failure) {
        try {
          await this.executeStep(handlerDef, context, workflowDef);
        } catch (handlerError: any) {
          console.warn(`Step failure handler '${handlerDef.name}' failed: ${handlerError.message}`);
        }
      }
    }
  }

  /**
   * Handle workflow failure
   */
  private async handleWorkflowFailure(
    error: Error,
    context: WorkflowContext,
    workflowDef: WorkflowDefinition
  ): Promise<void> {
    context.setVariable('error', {
      message: error.message,
      type: 'workflow_failure'
    });

    if (workflowDef.failure_handling?.on_workflow_failure) {
      for (const handlerDef of workflowDef.failure_handling.on_workflow_failure) {
        try {
          await this.executeStep(handlerDef, context, workflowDef);
        } catch (handlerError: any) {
          console.warn(`Workflow failure handler '${handlerDef.name}' failed: ${handlerError.message}`);
        }
      }
    }
  }

  /**
   * Set up default context variables
   */
  private setupDefaultContext(context: WorkflowContext): void {
    // Set default environment variables if not provided
    context.setVariable('REDIS_STREAM_NAME', context.getVariable('REDIS_STREAM_NAME') || process.env.REDIS_STREAM_NAME || 'workflow-tasks');
    context.setVariable('CONSUMER_GROUP', context.getVariable('CONSUMER_GROUP') || process.env.CONSUMER_GROUP || 'workflow-consumers');
    context.setVariable('CONSUMER_ID', context.getVariable('CONSUMER_ID') || process.env.CONSUMER_ID || 'workflow-engine');
    context.setVariable('REPO_PATH', context.repoRoot);
    context.setVariable('repoRoot', context.repoRoot);
  }

  /**
   * Validate workflow prerequisites
   */
  private validatePrerequisites(definition: WorkflowDefinition, context: WorkflowContext): void {
    if (definition.context.repo_required && !context.repoRoot) {
      throw new Error('Repository path is required but not provided in context');
    }
  }

  /**
   * Validate workflow definition structure
   */
  private validateWorkflowDefinition(definition: WorkflowDefinition): void {
    if (!definition.name) {
      throw new Error('Workflow definition must have a name');
    }
    
    if (!definition.steps || definition.steps.length === 0) {
      throw new Error('Workflow definition must have at least one step');
    }
    
    // Validate step types
    for (const step of definition.steps) {
      if (!this.stepRegistry.has(step.type)) {
        throw new Error(`Unknown step type '${step.type}' in step '${step.name}'`);
      }
    }
    
    // Validate dependencies
    const stepNames = new Set(definition.steps.map(s => s.name));
    for (const step of definition.steps) {
      if (step.depends_on) {
        for (const dependency of step.depends_on) {
          if (!stepNames.has(dependency)) {
            throw new Error(`Step '${step.name}' depends on unknown step '${dependency}'`);
          }
        }
      }
    }
  }
}

/**
 * Default workflow engine instance
 */
export const workflowEngine = new WorkflowEngine();