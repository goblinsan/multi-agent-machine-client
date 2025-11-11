import {
  WorkflowStep,
  StepResult,
  ValidationResult,
  WorkflowStepConfig,
} from "../engine/WorkflowStep.js";
import { WorkflowContext } from "../engine/WorkflowContext.js";
import { logger } from "../../logger.js";
import { PersonaRequestStep } from "./PersonaRequestStep.js";
import { TaskCreationStep } from "./TaskCreationStep.js";
import { TaskUpdateStep } from "./TaskUpdateStep.js";
import { resolveVariablePath } from "../engine/conditionUtils.js";

interface ConditionalConfig {
  condition: string;
  thenSteps?: WorkflowStepConfig[];
  elseSteps?: WorkflowStepConfig[];
}

export class ConditionalStep extends WorkflowStep {
  async execute(context: WorkflowContext): Promise<StepResult> {
    const config = this.config.config as ConditionalConfig;
    const { condition, thenSteps = [], elseSteps = [] } = config;

    logger.info(`Evaluating conditional step`, {
      workflowId: context.workflowId,
      condition,
      thenStepsCount: thenSteps.length,
      elseStepsCount: elseSteps.length,
    });

    try {
      const conditionResult = this.evaluateConditionExpression(
        condition,
        context,
      );

      logger.info(`Condition evaluated`, {
        workflowId: context.workflowId,
        condition,
        result: conditionResult,
      });

      const stepsToExecute = conditionResult ? thenSteps : elseSteps;

      if (stepsToExecute.length === 0) {
        return {
          status: "success",
          data: {
            condition,
            conditionResult,
            stepsExecuted: 0,
          },
        };
      }

      const stepResults: Array<{
        name: string;
        type: string;
        result: StepResult;
      }> = [];
      let allSuccessful = true;

      for (const stepConfig of stepsToExecute) {
        try {
          const step = this.createStepInstance(stepConfig);
          const result = await step.execute(context);

          stepResults.push({
            name: stepConfig.name,
            type: stepConfig.type,
            result,
          });

          if (result.status === "failure") {
            allSuccessful = false;
            logger.warn(`Conditional step failed`, {
              workflowId: context.workflowId,
              stepName: stepConfig.name,
              error: result.error?.message,
            });
          }
        } catch (error: any) {
          allSuccessful = false;
          const failureResult: StepResult = {
            status: "failure",
            error: error instanceof Error ? error : new Error(String(error)),
          };

          stepResults.push({
            name: stepConfig.name,
            type: stepConfig.type,
            result: failureResult,
          });

          logger.error(`Conditional step execution failed`, {
            workflowId: context.workflowId,
            stepName: stepConfig.name,
            error: failureResult.error?.message,
          });
        }
      }

      return {
        status: allSuccessful ? "success" : "failure",
        data: {
          condition,
          conditionResult,
          stepsExecuted: stepResults.length,
          stepResults,
        },
        outputs: {
          conditionResult,
          stepsExecuted: stepResults.length,
        },
      };
    } catch (error: any) {
      logger.error(`Conditional step failed`, {
        workflowId: context.workflowId,
        condition,
        error: error instanceof Error ? error.message : String(error),
      });

      return {
        status: "failure",
        error: error instanceof Error ? error : new Error(String(error)),
        data: { condition },
      };
    }
  }

  private evaluateConditionExpression(
    condition: string,
    context: WorkflowContext,
  ): boolean {
    try {
      const cleanCondition = condition.replace(/\$\{([^}]+)\}/g, "$1").trim();
      return this.evaluateLogicalExpression(cleanCondition, context);
    } catch (error: any) {
      logger.error(`Condition evaluation failed, defaulting to false`, {
        condition,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  private evaluateLogicalExpression(
    expression: string,
    context: WorkflowContext,
  ): boolean {
    const expr = expression.trim();
    if (!expr.length) return false;

    if (this.isWrappedInParens(expr)) {
      return this.evaluateLogicalExpression(expr.slice(1, -1), context);
    }

    const orParts = this.splitTopLevel(expr, "||");
    if (orParts.length > 1) {
      return orParts.some((part: string) =>
        this.evaluateLogicalExpression(part, context),
      );
    }

    const andParts = this.splitTopLevel(expr, "&&");
    if (andParts.length > 1) {
      return andParts.every((part: string) =>
        this.evaluateLogicalExpression(part, context),
      );
    }

    if (expr === "true") return true;
    if (expr === "false") return false;

    return this.evaluateSimpleCondition(expr, context);
  }

  private evaluateSimpleCondition(
    expression: string,
    context: WorkflowContext,
  ): boolean {
    const clean = expression.trim();
    if (!clean.length) return false;

    if (clean.startsWith("!")) {
      return !this.evaluateLogicalExpression(clean.slice(1), context);
    }

    const lengthMatch = clean.match(
      /^([\w.]+)\.length\s*(==|!=|>=|<=|>|<)\s*(-?\d+)$/,
    );
    if (lengthMatch) {
      const [, rawPath, operator, numericLiteral] = lengthMatch;
      const varPath = this.normalizePath(rawPath);
      const targetValue = resolveVariablePath(varPath, context);
      const length = this.getComparableLength(targetValue);
      const compareValue = Number(numericLiteral);

      switch (operator) {
        case ">":
          return length > compareValue;
        case ">=":
          return length >= compareValue;
        case "<":
          return length < compareValue;
        case "<=":
          return length <= compareValue;
        case "==":
          return length === compareValue;
        case "!=":
          return length !== compareValue;
      }
    }

    const boolMatch = clean.match(
      /^([\w.]+)\s*(==|!=|===|!==)?\s*(true|false)$/,
    );
    if (boolMatch) {
      const [, rawPath, operator = "==", boolLiteral] = boolMatch;
      const varPath = this.normalizePath(rawPath);
      const actualValue = resolveVariablePath(varPath, context);
      const expectedValue = boolLiteral === "true";

      switch (operator) {
        case "==":
        case "===":
          return actualValue === expectedValue;
        case "!=":
        case "!==":
          return actualValue !== expectedValue;
      }
    }

    const equalityMatch = clean.match(
      /^([\w.]+)\s*(==|!=|===|!==|equals)\s*['"]([^'"]*)['"]$/,
    );
    if (equalityMatch) {
      const [, rawPath, operator, stringLiteral] = equalityMatch;
      const varPath = this.normalizePath(rawPath);
      const actualValue = resolveVariablePath(varPath, context);

      switch (operator) {
        case "==":
        case "===":
        case "equals":
          return actualValue === stringLiteral;
        case "!=":
        case "!==":
          return actualValue !== stringLiteral;
      }
    }

    const pathMatch = clean.match(/^([\w.]+)$/);
    if (pathMatch) {
      const [, rawPath] = pathMatch;
      const varPath = this.normalizePath(rawPath);
      const value = resolveVariablePath(varPath, context);
      return Boolean(value);
    }

    logger.warn(`Unsupported condition pattern, defaulting to false`, {
      condition: clean,
    });
    return false;
  }

  private splitTopLevel(expression: string, operator: "||" | "&&"): string[] {
    const parts: string[] = [];
    let depth = 0;
    let lastIndex = 0;
    let found = false;

    for (let i = 0; i < expression.length; i += 1) {
      const char = expression[i];
      if (char === "(") {
        depth += 1;
      } else if (char === ")") {
        depth = Math.max(0, depth - 1);
      }

      if (
        depth === 0 &&
        expression.slice(i, i + operator.length) === operator
      ) {
        parts.push(expression.slice(lastIndex, i).trim());
        lastIndex = i + operator.length;
        i += operator.length - 1;
        found = true;
      }
    }

    if (!found) {
      return [expression.trim()];
    }

    const tail = expression.slice(lastIndex).trim();
    if (tail.length) {
      parts.push(tail);
    }

    return parts.filter((part) => part.length > 0);
  }

  private isWrappedInParens(expression: string): boolean {
    if (!expression.startsWith("(") || !expression.endsWith(")")) {
      return false;
    }

    let depth = 0;
    for (let i = 0; i < expression.length; i += 1) {
      const char = expression[i];
      if (char === "(") {
        depth += 1;
      } else if (char === ")") {
        depth -= 1;
        if (depth === 0 && i < expression.length - 1) {
          return false;
        }
      }

      if (depth < 0) {
        return false;
      }
    }

    return depth === 0;
  }

  private getComparableLength(value: unknown): number {
    if (Array.isArray(value) || typeof value === "string") {
      return value.length;
    }

    if (value && typeof value === "object") {
      return Object.keys(value as Record<string, unknown>).length;
    }

    if (typeof value === "number") {
      return value;
    }

    return 0;
  }

  private normalizePath(path: string): string {
    return path.startsWith("stepOutput.") ? path.slice("stepOutput.".length) : path;
  }

  private createStepInstance(stepConfig: WorkflowStepConfig): WorkflowStep {
    switch (stepConfig.type) {
      case "PersonaRequestStep":
        return new PersonaRequestStep(stepConfig);
      case "TaskCreationStep":
        return new TaskCreationStep(stepConfig);
      case "TaskUpdateStep":
        return new TaskUpdateStep(stepConfig);
      default:
        throw new Error(`Unsupported step type: ${stepConfig.type}`);
    }
  }

  protected async validateConfig(
    _context: WorkflowContext,
  ): Promise<ValidationResult> {
    const errors: string[] = [];
    const warnings: string[] = [];
    const config = this.config.config as ConditionalConfig;

    if (!config.condition || typeof config.condition !== "string") {
      errors.push(
        "ConditionalStep: condition is required and must be a string",
      );
    }

    if (config.thenSteps !== undefined && !Array.isArray(config.thenSteps)) {
      errors.push("ConditionalStep: thenSteps must be an array if provided");
    }

    if (config.elseSteps !== undefined && !Array.isArray(config.elseSteps)) {
      errors.push("ConditionalStep: elseSteps must be an array if provided");
    }

    const allSteps = [...(config.thenSteps || []), ...(config.elseSteps || [])];
    for (const stepConfig of allSteps) {
      if (!stepConfig.name || typeof stepConfig.name !== "string") {
        errors.push(`ConditionalStep: nested step missing or invalid name`);
      }
      if (!stepConfig.type || typeof stepConfig.type !== "string") {
        errors.push(`ConditionalStep: nested step missing or invalid type`);
      }
    }

    if (!config.thenSteps?.length && !config.elseSteps?.length) {
      warnings.push(
        "ConditionalStep: no steps defined for either condition branch",
      );
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings,
    };
  }
}
