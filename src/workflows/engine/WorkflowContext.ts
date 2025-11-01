import { randomUUID } from 'crypto';
import { logger as baseLogger } from '../../logger.js';
import type { MessageTransport } from '../../transport/index.js';


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
  public readonly transport: MessageTransport;

  constructor(
    public readonly workflowId: string,
    public readonly projectId: string,
    public readonly repoRoot: string,
    public readonly branch: string,
    public readonly config: WorkflowConfig,
    transport: MessageTransport,
    initialVariables: Record<string, any> = {}
  ) {
    this.transport = transport;
    
    Object.entries(initialVariables).forEach(([key, value]) => {
      this.variables.set(key, value);
    });

    
    this.logger = {
      ...baseLogger,
      info: (msg: string, meta?: any) => baseLogger.info(msg, { workflowId: this.workflowId, ...meta }),
      warn: (msg: string, meta?: any) => baseLogger.warn(msg, { workflowId: this.workflowId, ...meta }),
      error: (msg: string, meta?: any) => baseLogger.error(msg, { workflowId: this.workflowId, ...meta }),
      debug: (msg: string, meta?: any) => baseLogger.debug(msg, { workflowId: this.workflowId, ...meta })
    };
  }

  
  setVariable(key: string, value: any): void {
    this.variables.set(key, value);
  }

  
  getVariable(key: string): any {
    return this.variables.get(key);
  }

  
  getAllVariables(): Record<string, any> {
    return Object.fromEntries(this.variables);
  }

  
  getCurrentBranch(): string {
    return this.getVariable('branch') || this.getVariable('currentBranch') || this.branch;
  }

  
  setStepOutput(stepName: string, output: any): void {
    this.stepOutputs.set(stepName, output);
  }

  
  getStepOutput(stepName: string): any {
    return this.stepOutputs.get(stepName);
  }

  
  hasStepOutput(stepName: string): boolean {
    return this.stepOutputs.has(stepName);
  }

  
  getAllStepOutputs(): Record<string, any> {
    return Object.fromEntries(this.stepOutputs);
  }

  
  recordStepStart(stepName: string): void {
    this.executionHistory.push({
      stepName,
      status: 'running',
      startTime: new Date()
    });
  }

  
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

  
  clone(newWorkflowId?: string): WorkflowContext {
    const cloned = new WorkflowContext(
      newWorkflowId || randomUUID(),
      this.projectId,
      this.repoRoot,
      this.branch,
      this.config,
      this.transport,
      this.getAllVariables()
    );

    
    this.stepOutputs.forEach((value, key) => {
      cloned.setStepOutput(key, value);
    });

    return cloned;
  }

  
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