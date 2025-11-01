import {
  WorkflowStep,
  StepResult,
  ValidationResult,
  WorkflowStepConfig,
} from "../engine/WorkflowStep.js";
import { WorkflowContext } from "../engine/WorkflowContext.js";
import { WorkflowEngine, WorkflowDefinition } from "../WorkflowEngine.js";
import { join } from "path";
import { logger } from "../../logger.js";

interface SubWorkflowConfig {
  workflow: string;
  inputs?: Record<string, any>;
  outputs?: Record<string, string>;
}

export class SubWorkflowStep extends WorkflowStep {
  private workflowEngine: WorkflowEngine;

  constructor(config: WorkflowStepConfig) {
    super(config);
    this.workflowEngine = new WorkflowEngine();
  }

  protected async validateConfig(
    _context: WorkflowContext,
  ): Promise<ValidationResult> {
    const errors: string[] = [];
    const warnings: string[] = [];
    const stepConfig = this.config.config as SubWorkflowConfig;

    if (!stepConfig.workflow) {
      errors.push("Sub-workflow name is required (config.workflow)");
    }

    if (stepConfig.workflow && typeof stepConfig.workflow !== "string") {
      errors.push("Sub-workflow name must be a string");
    }

    if (stepConfig.inputs && typeof stepConfig.inputs !== "object") {
      errors.push("Sub-workflow inputs must be an object");
    }

    if (stepConfig.outputs && typeof stepConfig.outputs !== "object") {
      errors.push("Sub-workflow output mapping must be an object");
    }

    return { valid: errors.length === 0, errors, warnings };
  }

  async execute(context: WorkflowContext): Promise<StepResult> {
    const stepConfig = this.config.config as SubWorkflowConfig;
    const startTime = Date.now();

    try {
      context.logger.info("Starting sub-workflow execution", {
        stepName: this.config.name,
        subWorkflow: stepConfig.workflow,
        workflowId: context.workflowId,
      });

      const subWorkflowPath = join(
        process.cwd(),
        "src/workflows/sub-workflows",
        `${stepConfig.workflow}.yaml`,
      );

      let subWorkflowDef: WorkflowDefinition;
      try {
        subWorkflowDef =
          await this.workflowEngine.loadWorkflowFromFile(subWorkflowPath);
      } catch (error: any) {
        throw new Error(
          `Failed to load sub-workflow '${stepConfig.workflow}': ${error.message}`,
        );
      }

      const subWorkflowInputs = this.resolveInputs(
        stepConfig.inputs || {},
        context,
      );

      const inheritedFlags: Record<string, any> = {
        SKIP_GIT_OPERATIONS: context.getVariable("SKIP_GIT_OPERATIONS") ?? true,
        SKIP_PERSONA_OPERATIONS:
          context.getVariable("SKIP_PERSONA_OPERATIONS") ?? true,

        repo_remote:
          context.getVariable("repo_remote") || subWorkflowInputs.repo,

        projectId: context.projectId,
        project_id: context.projectId,
      };
      const effectiveInputs = { ...inheritedFlags, ...subWorkflowInputs };

      context.logger.info("Sub-workflow inputs prepared", {
        stepName: this.config.name,
        subWorkflow: stepConfig.workflow,
        inputKeys: Object.keys(subWorkflowInputs),
      });

      const result = await this.workflowEngine.executeWorkflowDefinition(
        subWorkflowDef,
        context.projectId,
        context.repoRoot,
        context.branch,
        context.transport,
        effectiveInputs,
      );

      if (!result.success) {
        const error =
          result.error ||
          new Error(
            `Sub-workflow '${stepConfig.workflow}' failed at step '${result.failedStep}'`,
          );
        context.logger.error("Sub-workflow execution failed", {
          stepName: this.config.name,
          subWorkflow: stepConfig.workflow,
          failedStep: result.failedStep,
          error: error.message,
        });

        return {
          status: "failure",
          error,
          metrics: {
            duration_ms: Date.now() - startTime,
          },
        };
      }

      const outputs = this.mapOutputs(
        stepConfig.outputs || {},
        result.finalContext,
      );

      context.logger.info("Sub-workflow completed successfully", {
        stepName: this.config.name,
        subWorkflow: stepConfig.workflow,
        duration_ms: result.duration,
        outputKeys: Object.keys(outputs),
      });

      return {
        status: "success",
        data: {
          subWorkflow: stepConfig.workflow,
          completedSteps: result.completedSteps,
          duration: result.duration,
        },
        outputs,
        metrics: {
          duration_ms: Date.now() - startTime,
        },
      };
    } catch (error: any) {
      context.logger.error("Sub-workflow step failed", {
        stepName: this.config.name,
        subWorkflow: stepConfig.workflow,
        error: error.message,
        stack: error.stack,
      });

      return {
        status: "failure",
        error: error instanceof Error ? error : new Error(String(error)),
        metrics: {
          duration_ms: Date.now() - startTime,
        },
      };
    }
  }

  private resolveInputs(
    inputs: Record<string, any>,
    context: WorkflowContext,
  ): Record<string, any> {
    const resolved: Record<string, any> = {};

    for (const [key, value] of Object.entries(inputs)) {
      resolved[key] = this.resolveValue(value, context);
    }

    return resolved;
  }

  private resolveValue(value: any, context: WorkflowContext): any {
    if (value === null || value === undefined) {
      return value;
    }

    if (typeof value === "string") {
      return this.evaluateTemplate(value, context);
    }

    if (Array.isArray(value)) {
      return value.map((item) => this.resolveValue(item, context));
    }

    if (typeof value === "object") {
      const resolved: Record<string, any> = {};
      for (const [k, v] of Object.entries(value)) {
        resolved[k] = this.resolveValue(v, context);
      }
      return resolved;
    }

    return value;
  }

  private mapOutputs(
    outputMapping: Record<string, string>,
    subContext: WorkflowContext,
  ): Record<string, any> {
    const outputs: Record<string, any> = {};

    for (const [parentVar, subVarExpr] of Object.entries(outputMapping)) {
      const value = this.evaluateTemplate(subVarExpr, subContext);
      if (value !== undefined) {
        outputs[parentVar] = value;
      } else {
        logger.warn("Sub-workflow output variable not found", {
          stepName: this.config.name,
          parentVar,
          subVar: subVarExpr,
        });
      }
    }

    return outputs;
  }

  private evaluateTemplate(expr: string, context: WorkflowContext): any {
    if (typeof expr !== "string") return expr;

    const match = expr.match(/^\$\{([\s\S]+)\}$/);
    if (!match) {
      return expr;
    }

    const inner = match[1].trim();

    const parts = inner.split("||").map((p) => p.trim());
    const primaryExpr = parts[0];
    const fallbackExpr = parts[1];

    const primaryVal = this.getVarOrStepOutput(context, primaryExpr);
    if (primaryVal !== undefined && primaryVal !== null) {
      return primaryVal;
    }

    if (fallbackExpr === undefined) return undefined;

    if (fallbackExpr === "[]") return [];
    if (fallbackExpr === "false") return false;
    if (fallbackExpr === "true") return true;
    if (/^\d+(?:\.\d+)?$/.test(fallbackExpr)) return Number(fallbackExpr);

    const strMatch = fallbackExpr.match(/^['"]([\s\S]*)['"]$/);
    return strMatch
      ? strMatch[1]
      : this.getVarOrStepOutput(context, fallbackExpr);
  }

  private getVarOrStepOutput(context: WorkflowContext, path: string): any {
    if (!path) return undefined;

    const direct = context.getVariable(path);
    if (direct !== undefined) return direct;

    if (path.includes(".")) {
      const [stepName, ...rest] = path.split(".");
      const output = context.getStepOutput(stepName);
      if (!output) return undefined;
      return rest.reduce(
        (acc: any, key: string) => (acc != null ? acc[key] : undefined),
        output,
      );
    }

    return undefined;
  }
}
