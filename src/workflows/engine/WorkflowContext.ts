import { randomUUID } from 'crypto';
import { logger as baseLogger } from '../../logger.js';

/**
 * Workflow execution configuration
 */
export interface WorkflowConfig {
  name: string;
  description?: string;
  version: string;
  trigger?: {
    condition: string;
  };
  context?: {
    repo_required?: boolean;
    branch_strategy?: string;
  };
  steps: any[];
  failure_handling?: Record<string, any>;
}

/**
 * Shared context and state for workflow execution
 */
export class WorkflowContext {
  private variables = new Map<string, any>();
  private stepOutputs = new Map<string, any>();
  private executionHistory: Array<{
    stepName: string;
    status: string;
    startTime: Date;
    endTime?: Date;
    error?: string;
  }> = [];

  public readonly logger: typeof baseLogger;

  constructor(
    public readonly workflowId: string,
    public readonly projectId: string,
    public readonly repoRoot: string,
    public readonly branch: string,
    public readonly config: WorkflowConfig,
    initialVariables: Record<string, any> = {}
  ) {
    // Initialize variables
    Object.entries(initialVariables).forEach(([key, value]) => {
      this.variables.set(key, value);
    });

    // Create logger with workflow context
    this.logger = {
      ...baseLogger,
      info: (msg: string, meta?: any) => baseLogger.info(msg, { workflowId: this.workflowId, ...meta }),
      warn: (msg: string, meta?: any) => baseLogger.warn(msg, { workflowId: this.workflowId, ...meta }),
      error: (msg: string, meta?: any) => baseLogger.error(msg, { workflowId: this.workflowId, ...meta }),
      debug: (msg: string, meta?: any) => baseLogger.debug(msg, { workflowId: this.workflowId, ...meta })
    };
  }

  /**
   * Set a variable value
   */
  setVariable(key: string, value: any): void {
    this.variables.set(key, value);
  }

  /**
   * Get a variable value
   */
  getVariable(key: string): any {
    return this.variables.get(key);
  }

  /**
   * Get all variables
   */
  getAllVariables(): Record<string, any> {
    return Object.fromEntries(this.variables);
  }

  /**
   * Set step output
   */
  setStepOutput(stepName: string, output: any): void {
    this.stepOutputs.set(stepName, output);
  }

  /**
   * Get step output
   */
  getStepOutput(stepName: string): any {
    return this.stepOutputs.get(stepName);
  }

  /**
   * Check if step has output
   */
  hasStepOutput(stepName: string): boolean {
    return this.stepOutputs.has(stepName);
  }

  /**
   * Get all step outputs
   */
  getAllStepOutputs(): Record<string, any> {
    return Object.fromEntries(this.stepOutputs);
  }

  /**
   * Record step execution start
   */
  recordStepStart(stepName: string): void {
    this.executionHistory.push({
      stepName,
      status: 'running',
      startTime: new Date()
    });
  }

  /**
   * Record step execution completion
   */
  recordStepComplete(stepName: string, status: 'success' | 'failure' | 'skipped', error?: string): void {
    const entry = this.executionHistory.find(h => h.stepName === stepName && !h.endTime);
    if (entry) {
      entry.status = status;
      entry.endTime = new Date();
      if (error) {
        entry.error = error;
      }
    }
  }

  /**
   * Get execution history
   */
  getExecutionHistory(): Array<{
    stepName: string;
    status: string;
    startTime: Date;
    endTime?: Date;
    duration_ms?: number;
    error?: string;
  }> {
    return this.executionHistory.map(entry => ({
      ...entry,
      duration_ms: entry.endTime ? entry.endTime.getTime() - entry.startTime.getTime() : undefined
    }));
  }

  /**
   * Get execution summary
   */
  getExecutionSummary(): {
    totalSteps: number;
    completedSteps: number;
    failedSteps: number;
    skippedSteps: number;
    totalDuration_ms: number;
  } {
    const history = this.getExecutionHistory();
    const completedSteps = history.filter(h => h.status === 'success').length;
    const failedSteps = history.filter(h => h.status === 'failure').length;
    const skippedSteps = history.filter(h => h.status === 'skipped').length;
    const totalDuration_ms = history
      .filter(h => h.duration_ms !== undefined)
      .reduce((sum, h) => sum + (h.duration_ms || 0), 0);

    return {
      totalSteps: history.length,
      completedSteps,
      failedSteps,
      skippedSteps,
      totalDuration_ms
    };
  }

  /**
   * Clone context for sub-workflow or parallel execution
   */
  clone(newWorkflowId?: string): WorkflowContext {
    const cloned = new WorkflowContext(
      newWorkflowId || randomUUID(),
      this.projectId,
      this.repoRoot,
      this.branch,
      this.config,
      this.getAllVariables()
    );

    // Copy step outputs
    this.stepOutputs.forEach((value, key) => {
      cloned.setStepOutput(key, value);
    });

    return cloned;
  }

  /**
   * Create a diagnostic snapshot for debugging
   */
  createDiagnosticSnapshot(): Record<string, any> {
    return {
      workflowId: this.workflowId,
      projectId: this.projectId,
      repoRoot: this.repoRoot,
      branch: this.branch,
      config: this.config,
      variables: this.getAllVariables(),
      stepOutputs: this.getAllStepOutputs(),
      executionHistory: this.getExecutionHistory(),
      executionSummary: this.getExecutionSummary(),
      timestamp: new Date().toISOString()
    };
  }
}