import { WorkflowStep } from "./engine/WorkflowStep";
import { WorkflowContext, WorkflowConfig } from "./engine/WorkflowContext";
import type { MessageTransport } from "../transport/index.js";
import { PullTaskStep } from "./steps/PullTaskStep";
import { ContextStep } from "./steps/ContextStep";
import { TaskUpdateStep } from "./steps/TaskUpdateStep";
import { CodeGenStep } from "./steps/CodeGenStep";
import { PlanningStep } from "./steps/PlanningStep";
import { QAStep } from "./steps/QAStep";
import { PlanEvaluationStep } from "./steps/PlanEvaluationStep";
import { QAAnalysisStep } from "./steps/QAAnalysisStep";
import { TaskCreationStep } from "./steps/TaskCreationStep";
import { DiffApplyStep } from "./steps/DiffApplyStep";
import { PersonaRequestStep } from "./steps/PersonaRequestStep";
import { ConditionalStep } from "./steps/ConditionalStep";
import { SimpleTaskStatusStep } from "./steps/SimpleTaskStatusStep";
import { GitOperationStep } from "./steps/GitOperationStep";
import { GitArtifactStep } from "./steps/GitArtifactStep";
import { PlanningLoopStep } from "./steps/PlanningLoopStep";
import { VariableSetStep } from "./steps/VariableSetStep";
import { BlockedTaskAnalysisStep } from "./steps/BlockedTaskAnalysisStep";
import { UnblockAttemptStep } from "./steps/UnblockAttemptStep";
import { MilestoneStatusCheckStep } from "./steps/MilestoneStatusCheckStep";
import { ReviewFailureTasksStep } from "./steps/ReviewFailureTasksStep";
import { FetchProjectTasksStep } from "./steps/FetchProjectTasksStep";
import { GitDiffExportStep } from "./steps/GitDiffExportStep";
import { SubWorkflowStep } from "./steps/SubWorkflowStep";
import { BulkTaskCreationStep } from "./steps/BulkTaskCreationStep";
import { PMDecisionParserStep } from "./steps/PMDecisionParserStep";
import { VariableResolutionStep } from "./steps/VariableResolutionStep";
import { DependencyStatusStep } from "./steps/DependencyStatusStep";
import { RegisterBlockedDependenciesStep } from "./steps/RegisterBlockedDependenciesStep";
import { ReviewFollowUpFilterStep } from "./steps/ReviewFollowUpFilterStep";
import { ReviewFollowUpCoverageStep } from "./steps/ReviewFollowUpCoverageStep";
import { ReviewFollowUpAutoSynthesisStep } from "./steps/ReviewFollowUpAutoSynthesisStep";
import { ReviewFollowUpMergeStep } from "./steps/ReviewFollowUpMergeStep";
import { ReviewFailureNormalizationStep } from "./steps/ReviewFailureNormalizationStep";
import { AnalysisTaskBuilderStep } from "./steps/AnalysisTaskBuilderStep";
import { AnalysisReviewLoopStep } from "./steps/AnalysisReviewLoopStep";
import { PrioritizeExistingTasksStep } from "./steps/PrioritizeExistingTasksStep";
import { PlanKeyFileGuardStep } from "./steps/PlanKeyFileGuardStep";
import { TestCommandDiscoveryStep } from "./steps/TestCommandDiscoveryStep";
import { TestHarnessSynthesisStep } from "./steps/TestHarnessSynthesisStep";
import { DependencyTaskCollectorStep } from "./steps/DependencyTaskCollectorStep";
import { ImplementationLoopStep } from "./steps/ImplementationLoopStep";
import { QAArtifactLoadStep } from "./steps/QAArtifactLoadStep";
import { TestToolingSetupStep } from "./steps/TestToolingSetupStep";
import { WorkflowLoader } from "./engine/WorkflowLoader";
import { ConditionEvaluator } from "./engine/ConditionEvaluator";
import { StepExecutor } from "./engine/StepExecutor";
import { randomUUID } from "crypto";
import { logger } from "../logger.js";

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

export interface WorkflowStepDefinition {
  name: string;
  type: string;
  description: string;
  depends_on?: string[];
  condition?: string;
  config: Record<string, any>;
  outputs?: string[];
}

export interface WorkflowExecutionResult {
  success: boolean;
  completedSteps: string[];
  failedStep?: string;
  error?: Error;
  duration: number;
  finalContext: WorkflowContext;
}

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

  private async ensureDefaultWorkflowsLoaded(): Promise<void> {
    return this.workflowLoader.ensureDefaultWorkflowsLoaded();
  }

  private registerBuiltInSteps(): void {
    this.stepRegistry.set("PullTaskStep", PullTaskStep);
    this.stepRegistry.set("ContextStep", ContextStep);
    this.stepRegistry.set("TaskUpdateStep", TaskUpdateStep);
    this.stepRegistry.set("CodeGenStep", CodeGenStep);
    this.stepRegistry.set("PlanningStep", PlanningStep);
    this.stepRegistry.set("QAStep", QAStep);
    this.stepRegistry.set("PlanEvaluationStep", PlanEvaluationStep);
    this.stepRegistry.set("QAAnalysisStep", QAAnalysisStep);
    this.stepRegistry.set("TaskCreationStep", TaskCreationStep);
    this.stepRegistry.set("DiffApplyStep", DiffApplyStep);
    this.stepRegistry.set("PersonaRequestStep", PersonaRequestStep);
    this.stepRegistry.set("ConditionalStep", ConditionalStep);
    this.stepRegistry.set("SimpleTaskStatusStep", SimpleTaskStatusStep);
    this.stepRegistry.set("GitOperationStep", GitOperationStep);
    this.stepRegistry.set("GitArtifactStep", GitArtifactStep);
    this.stepRegistry.set("PlanningLoopStep", PlanningLoopStep);
    this.stepRegistry.set("VariableSetStep", VariableSetStep);
    this.stepRegistry.set("BlockedTaskAnalysisStep", BlockedTaskAnalysisStep);
    this.stepRegistry.set("UnblockAttemptStep", UnblockAttemptStep);
    this.stepRegistry.set("MilestoneStatusCheckStep", MilestoneStatusCheckStep);
    this.stepRegistry.set("ReviewFailureTasksStep", ReviewFailureTasksStep);
    this.stepRegistry.set("FetchProjectTasksStep", FetchProjectTasksStep);
    this.stepRegistry.set("GitDiffExportStep", GitDiffExportStep);

    this.stepRegistry.set("SubWorkflowStep", SubWorkflowStep);
    this.stepRegistry.set("BulkTaskCreationStep", BulkTaskCreationStep);
    this.stepRegistry.set("PMDecisionParserStep", PMDecisionParserStep);
    this.stepRegistry.set("VariableResolutionStep", VariableResolutionStep);
    this.stepRegistry.set("DependencyStatusStep", DependencyStatusStep);
    this.stepRegistry.set(
      "RegisterBlockedDependenciesStep",
      RegisterBlockedDependenciesStep,
    );
    this.stepRegistry.set(
      "ReviewFollowUpFilterStep",
      ReviewFollowUpFilterStep,
    );
    this.stepRegistry.set(
      "ReviewFollowUpCoverageStep",
      ReviewFollowUpCoverageStep,
    );
    this.stepRegistry.set(
      "ReviewFollowUpAutoSynthesisStep",
      ReviewFollowUpAutoSynthesisStep,
    );
    this.stepRegistry.set(
      "ReviewFollowUpMergeStep",
      ReviewFollowUpMergeStep,
    );
    this.stepRegistry.set(
      "ReviewFailureNormalizationStep",
      ReviewFailureNormalizationStep,
    );
    this.stepRegistry.set(
      "AnalysisTaskBuilderStep",
      AnalysisTaskBuilderStep,
    );
    this.stepRegistry.set(
      "AnalysisReviewLoopStep",
      AnalysisReviewLoopStep,
    );
    this.stepRegistry.set(
      "PrioritizeExistingTasksStep",
      PrioritizeExistingTasksStep,
    );
    this.stepRegistry.set(
      "PlanKeyFileGuardStep",
      PlanKeyFileGuardStep,
    );
    this.stepRegistry.set(
      "ImplementationLoopStep",
      ImplementationLoopStep,
    );
    this.stepRegistry.set(
      "TestCommandDiscoveryStep",
      TestCommandDiscoveryStep,
    );
    this.stepRegistry.set(
      "TestHarnessSynthesisStep",
      TestHarnessSynthesisStep,
    );
    this.stepRegistry.set(
      "DependencyTaskCollectorStep",
      DependencyTaskCollectorStep,
    );
    this.stepRegistry.set("QAArtifactLoadStep", QAArtifactLoadStep);
    this.stepRegistry.set("TestToolingSetupStep", TestToolingSetupStep);
  }

  public registerStep(
    type: string,
    stepClass: new (...args: any[]) => WorkflowStep,
  ): void {
    this.stepRegistry.set(type, stepClass);
  }

  public async loadWorkflowFromFile(
    filePath: string,
  ): Promise<WorkflowDefinition> {
    return this.workflowLoader.loadWorkflowFromFile(filePath);
  }

  public async loadWorkflowsFromDirectory(
    directoryPath: string,
  ): Promise<WorkflowDefinition[]> {
    return this.workflowLoader.loadWorkflowsFromDirectory(directoryPath);
  }

  public getWorkflowDefinition(name: string): WorkflowDefinition | undefined {
    return this.workflowLoader.getWorkflowDefinition(name);
  }

  public getWorkflowDefinitions(): WorkflowDefinition[] {
    return this.workflowLoader.getWorkflowDefinitions();
  }

  public findWorkflowByCondition(
    taskType: string,
    scope?: string,
  ): WorkflowDefinition | undefined {
    for (const definition of this.workflowLoader.getWorkflowDefinitions()) {
      if (
        this.conditionEvaluator.evaluateTriggerCondition(
          definition.trigger.condition,
          taskType,
          scope,
        )
      ) {
        return definition;
      }
    }
    return undefined;
  }

  public async executeWorkflow(
    workflowName: string,
    projectIdOrVars: string | Record<string, any>,
    repoRoot?: string,
    branch: string = "main",
    transport?: MessageTransport,
    initialVariables: Record<string, any> = {},
  ): Promise<WorkflowExecutionResult> {
    let definition = this.workflowLoader.getWorkflowDefinition(workflowName);
    if (!definition) {
      await this.ensureDefaultWorkflowsLoaded();
      definition = this.workflowLoader.getWorkflowDefinition(workflowName);
      if (!definition) {
        throw new Error(`Workflow '${workflowName}' not found`);
      }
    }

    if (typeof projectIdOrVars === "object" && projectIdOrVars !== null) {
      const variables = projectIdOrVars as Record<string, any>;
      const seededVars: Record<string, any> = {
        SKIP_GIT_OPERATIONS: true,
        SKIP_PERSONA_OPERATIONS: true,
        repo_remote:
          variables.repo || variables.repo_remote || "git@example.com/repo.git",
        projectId:
          variables.project_id || variables.projectId || "test-project",
        ...variables,
      };

      const taskId =
        (variables as any).task?.id ||
        (variables as any).task_id ||
        (variables as any).taskId;
      if (taskId && !seededVars.task) {
        seededVars.task = {
          id: taskId,
          title:
            (variables as any).task_name ||
            (variables as any).title ||
            "test-task",
        };
      }

      return this.executeWorkflowDefinition(
        definition,
        String(seededVars.projectId || "test-project"),
        process.cwd(),
        "main",
        undefined as any,
        seededVars,
      );
    }

    const projectId = projectIdOrVars as string;
    return this.executeWorkflowDefinition(
      definition,
      projectId,
      repoRoot!,
      branch,
      transport as MessageTransport,
      initialVariables,
    );
  }

  public async executeWorkflowDefinition(
    definition: WorkflowDefinition,
    projectId: string,
    repoRoot: string,
    branch: string = "main",
    transport: MessageTransport,
    initialVariables: Record<string, any> = {},
  ): Promise<WorkflowExecutionResult> {
    const startTime = Date.now();
    const completedSteps: string[] = [];

    const workflowConfig: WorkflowConfig = {
      name: definition.name,
      description: definition.description,
      version: definition.version,
      steps: definition.steps,
      trigger: definition.trigger,
      context: definition.context,
      failure_handling: definition.failure_handling,
    };

    const context = new WorkflowContext(
      randomUUID(),
      projectId,
      repoRoot,
      branch,
      workflowConfig,
      transport,
      initialVariables,
    );

    try {
      this.setupDefaultContext(context);

      this.validatePrerequisites(definition, context);

      const executionOrder = this.stepExecutor.buildExecutionOrder(
        definition.steps,
      );

      for (const stepName of executionOrder) {
        const stepDef = definition.steps.find((s) => s.name === stepName);
        if (!stepDef) {
          throw new Error(`Step definition not found: ${stepName}`);
        }

        if (!this.shouldExecuteStep(stepDef, context, completedSteps)) {
          continue;
        }

        const success = await this.stepExecutor.executeStep(
          stepDef,
          context,
          definition,
        );

        if (success) {
          completedSteps.push(stepName);
        } else {
          await this.handleStepFailure(stepDef, context, definition);

          return {
            success: false,
            completedSteps,
            failedStep: stepName,
            error: new Error(`Step '${stepName}' failed`),
            duration: Date.now() - startTime,
            finalContext: context,
          };
        }
      }

      return {
        success: true,
        completedSteps,
        duration: Date.now() - startTime,
        finalContext: context,
      };
    } catch (error: any) {
      await this.handleWorkflowFailure(error, context, definition);

      return {
        success: false,
        completedSteps,
        error: error as Error,
        duration: Date.now() - startTime,
        finalContext: context,
      };
    }
  }

  private shouldExecuteStep(
    stepDef: WorkflowStepDefinition,
    context: WorkflowContext,
    completedSteps: string[],
  ): boolean {
    if (stepDef.depends_on) {
      for (const dependency of stepDef.depends_on) {
        if (!completedSteps.includes(dependency)) {
          return false;
        }
      }
    }

    if (stepDef.condition) {
      const result = this.conditionEvaluator.evaluateSimpleCondition(
        stepDef.condition,
        context,
      );
      logger.debug("Step condition evaluated", {
        stepName: stepDef.name,
        condition: stepDef.condition,
        result,
        workflowId: context.workflowId,
      });
      return result;
    }

    return true;
  }

  private async handleStepFailure(
    failedStep: WorkflowStepDefinition,
    context: WorkflowContext,
    workflowDef: WorkflowDefinition,
  ): Promise<void> {
    context.setVariable("error", {
      step: failedStep.name,
      type: failedStep.type,
      message: `Step '${failedStep.name}' failed`,
    });

    if (workflowDef.failure_handling?.on_step_failure) {
      for (const handlerDef of workflowDef.failure_handling.on_step_failure) {
        try {
          await this.stepExecutor.executeStep(handlerDef, context, workflowDef);
        } catch (handlerError: any) {
          console.warn(
            `Step failure handler '${handlerDef.name}' failed: ${handlerError.message}`,
          );
        }
      }
    }
  }

  private async handleWorkflowFailure(
    error: Error,
    context: WorkflowContext,
    workflowDef: WorkflowDefinition,
  ): Promise<void> {
    context.setVariable("error", {
      message: error.message,
      type: "workflow_failure",
    });

    if (workflowDef.failure_handling?.on_workflow_failure) {
      for (const handlerDef of workflowDef.failure_handling
        .on_workflow_failure) {
        try {
          await this.stepExecutor.executeStep(handlerDef, context, workflowDef);
        } catch (handlerError: any) {
          console.warn(
            `Workflow failure handler '${handlerDef.name}' failed: ${handlerError.message}`,
          );
        }
      }
    }
  }

  private setupDefaultContext(context: WorkflowContext): void {
    context.setVariable(
      "REDIS_STREAM_NAME",
      context.getVariable("REDIS_STREAM_NAME") ||
        process.env.REDIS_STREAM_NAME ||
        "workflow-tasks",
    );
    context.setVariable(
      "CONSUMER_GROUP",
      context.getVariable("CONSUMER_GROUP") ||
        process.env.CONSUMER_GROUP ||
        "workflow-consumers",
    );
    context.setVariable(
      "CONSUMER_ID",
      context.getVariable("CONSUMER_ID") ||
        process.env.CONSUMER_ID ||
        "workflow-engine",
    );
    context.setVariable("REPO_PATH", context.repoRoot);
    context.setVariable("repoRoot", context.repoRoot);
    context.setVariable("repo_root", context.repoRoot);
  }

  private validatePrerequisites(
    definition: WorkflowDefinition,
    context: WorkflowContext,
  ): void {
    if (definition.context.repo_required && !context.repoRoot) {
      throw new Error(
        "Repository path is required but not provided in context",
      );
    }
  }
}

export const workflowEngine = new WorkflowEngine();
