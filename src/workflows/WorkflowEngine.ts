import { WorkflowStep } from './engine/WorkflowStep';
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
import { GitArtifactStep } from './steps/GitArtifactStep';
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
import { WorkflowLoader } from './engine/WorkflowLoader';
import { ConditionEvaluator } from './engine/ConditionEvaluator';
import { StepExecutor } from './engine/StepExecutor';
import { randomUUID } from 'crypto';
import { logger } from '../logger.js';

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
  private workflowLoader: WorkflowLoader;
  private conditionEvaluator: ConditionEvaluator;
  private stepExecutor: StepExecutor;

  constructor() {
    this.stepRegistry = new Map();
    this.registerBuiltInSteps();
    this.workflowLoader = new WorkflowLoader(this.stepRegistry);
    this.conditionEvaluator = new ConditionEvaluator();
    this.stepExecutor = new StepExecutor(this.stepRegistry);
  }

  /**
   * Ensure default workflow definitions are loaded once from the repo
   */
  private async ensureDefaultWorkflowsLoaded(): Promise<void> {
    return this.workflowLoader.ensureDefaultWorkflowsLoaded();
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
    this.stepRegistry.set('GitArtifactStep', GitArtifactStep);
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
    return this.workflowLoader.loadWorkflowFromFile(filePath);
  }

  /**
   * Load all workflow definitions from a directory
   */
  public async loadWorkflowsFromDirectory(directoryPath: string): Promise<WorkflowDefinition[]> {
    return this.workflowLoader.loadWorkflowsFromDirectory(directoryPath);
  }

  /**
   * Get workflow definition by name
   */
  public getWorkflowDefinition(name: string): WorkflowDefinition | undefined {
    return this.workflowLoader.getWorkflowDefinition(name);
  }

  /**
   * Get all loaded workflow definitions
   */
  public getWorkflowDefinitions(): WorkflowDefinition[] {
    return this.workflowLoader.getWorkflowDefinitions();
  }

  /**
   * Find workflow by trigger condition
   */
  public findWorkflowByCondition(taskType: string, scope?: string): WorkflowDefinition | undefined {
    for (const definition of this.workflowLoader.getWorkflowDefinitions()) {
      if (this.conditionEvaluator.evaluateTriggerCondition(definition.trigger.condition, taskType, scope)) {
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
    let definition = this.workflowLoader.getWorkflowDefinition(workflowName);
    if (!definition) {
      // Attempt to auto-load default workflow definitions on-demand
      await this.ensureDefaultWorkflowsLoaded();
      definition = this.workflowLoader.getWorkflowDefinition(workflowName);
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
      // Ensure a task object exists for SimpleTaskStatusStep
      const taskId = (variables as any).task?.id || (variables as any).task_id || (variables as any).taskId;
      if (taskId && !seededVars.task) {
        seededVars.task = { id: taskId, title: (variables as any).task_name || (variables as any).title || 'test-task' };
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
      const executionOrder = this.stepExecutor.buildExecutionOrder(definition.steps);
      
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
        const success = await this.stepExecutor.executeStep(stepDef, context, definition);

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
      const result = this.conditionEvaluator.evaluateSimpleCondition(stepDef.condition, context);
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
          await this.stepExecutor.executeStep(handlerDef, context, workflowDef);
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
          await this.stepExecutor.executeStep(handlerDef, context, workflowDef);
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
}

/**
 * Default workflow engine instance
 */
export const workflowEngine = new WorkflowEngine();