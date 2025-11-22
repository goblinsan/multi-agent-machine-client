import {
  WorkflowStep,
  StepResult,
  ValidationResult,
} from "../engine/WorkflowStep.js";
import { WorkflowContext } from "../engine/WorkflowContext.js";
import { logger } from "../../logger.js";

interface VariableConfig {
  variables: Record<string, any>;
}

export class VariableResolutionStep extends WorkflowStep {
  async execute(context: WorkflowContext): Promise<StepResult> {
    const config = this.config.config as VariableConfig;
    const { variables } = config;

    if (!variables || Object.keys(variables).length === 0) {
      return {
        status: "success",
        data: {
          variablesSet: 0,
          message: "No variables to resolve",
        },
      };
    }

    logger.info(`Resolving variables`, {
      workflowId: context.workflowId,
      stepName: this.config.name,
      variableCount: Object.keys(variables).length,
      variables: Object.keys(variables),
    });

    try {
      const resolvedVariables: Record<string, any> = {};
      const errors: Record<string, string> = {};

      for (const [key, expression] of Object.entries(variables)) {
        try {
          const resolvedValue =
            typeof expression === "string" && expression.includes("${")
              ? this.resolveVariableExpression(expression, context)
              : expression;

          context.setVariable(key, resolvedValue);
          resolvedVariables[key] = resolvedValue;

          logger.debug(`Variable resolved`, {
            workflowId: context.workflowId,
            stepName: this.config.name,
            key,
            expression,
            resolvedValue:
              typeof resolvedValue === "object"
                ? JSON.stringify(resolvedValue).substring(0, 100)
                : resolvedValue,
          });
        } catch (error: any) {
          errors[key] = error.message;
          logger.warn(`Failed to resolve variable`, {
            workflowId: context.workflowId,
            stepName: this.config.name,
            key,
            expression,
            error: error.message,
          });
        }
      }

      const outputs = Object.entries(resolvedVariables).map(([key, value]) => ({
        name: key,
        value,
      }));

      const hasErrors = Object.keys(errors).length > 0;

      return {
        status: hasErrors ? "failure" : "success",
        data: {
          variablesSet: Object.keys(resolvedVariables).length,
          variables: resolvedVariables,
          errors: hasErrors ? errors : undefined,
          outputs,
        },
      };
    } catch (error: any) {
      logger.error(`Variable resolution step failed`, {
        workflowId: context.workflowId,
        stepName: this.config.name,
        error: error.message,
      });

      return {
        status: "failure",
        error: new Error(`Failed to resolve variables: ${error.message}`),
        data: {
          variablesSet: 0,
        },
      };
    }
  }

  async validate(_context: WorkflowContext): Promise<ValidationResult> {
    const config = this.config.config as VariableConfig;

    if (!config.variables) {
      return {
        valid: false,
        errors: ['VariableResolutionStep requires "variables" configuration'],
        warnings: [],
      };
    }

    if (
      typeof config.variables !== "object" ||
      Array.isArray(config.variables)
    ) {
      return {
        valid: false,
        errors: ['VariableResolutionStep "variables" must be an object'],
        warnings: [],
      };
    }

    if (Object.keys(config.variables).length === 0) {
      return {
        valid: false,
        errors: ['VariableResolutionStep "variables" cannot be empty'],
        warnings: ["No variables defined - step will do nothing"],
      };
    }

    return {
      valid: true,
      errors: [],
      warnings: [],
    };
  }

  private resolveVariableExpression(
    expression: string,
    context: WorkflowContext,
  ): any {
    const variablePattern = /\$\{([^}]+)\}/g;
    let result: string = expression;
    let match: RegExpExecArray | null;

    while ((match = variablePattern.exec(expression)) !== null) {
      const fullMatch = match[0];
      const variablePath = match[1];

      const resolvedValue = this.evaluateExpression(variablePath, context);

      if (expression === fullMatch) {
        return resolvedValue;
      }

      result = result.replace(fullMatch, String(resolvedValue ?? ""));
    }

    return result;
  }

  private evaluateExpression(
    expression: string,
    context: WorkflowContext,
  ): any {
    const trimmed = expression.trim();
    if (!trimmed.length) {
      return "";
    }

    if (this.isWrappedInParens(trimmed)) {
      return this.evaluateExpression(trimmed.slice(1, -1), context);
    }

    const orParts = this.splitExpression(trimmed, "||");
    if (orParts.length > 1) {
      for (const part of orParts) {
        const value = this.evaluateExpression(part, context);
        if (value !== null && value !== undefined && value !== "") {
          return value;
        }
      }
      return null;
    }

    const andParts = this.splitExpression(trimmed, "&&");
    if (andParts.length > 1) {
      for (const part of andParts) {
        const value = this.evaluateExpression(part, context);
        if (!value) {
          return false;
        }
      }
      return true;
    }

    if (trimmed.includes("===")) {
      const parts = this.splitExpression(trimmed, "===");
      if (parts.length === 2) {
        const left = this.evaluateExpression(parts[0], context);
        const right = this.evaluateExpression(parts[1], context);
        return left === right;
      }
    }

    if (trimmed.includes("!==")) {
      const parts = this.splitExpression(trimmed, "!==");
      if (parts.length === 2) {
        const left = this.evaluateExpression(parts[0], context);
        const right = this.evaluateExpression(parts[1], context);
        return left !== right;
      }
    }

    if (!trimmed.includes("===")) {
      const eqParts = this.splitExpression(trimmed, "==");
      if (eqParts.length === 2) {
        const left = this.evaluateExpression(eqParts[0], context);
        const right = this.evaluateExpression(eqParts[1], context);
        return left == right;
      }
    }

    if (!trimmed.includes("!==")) {
      const neParts = this.splitExpression(trimmed, "!=");
      if (neParts.length === 2) {
        const left = this.evaluateExpression(neParts[0], context);
        const right = this.evaluateExpression(neParts[1], context);
        return left != right;
      }
    }

    const sumParts = this.splitExpression(trimmed, "+");
    if (sumParts.length > 1) {
      return sumParts.reduce((acc, part) => {
        const value = this.evaluateExpression(part, context);
        const numeric =
          typeof value === "number"
            ? value
            : Number(value ?? 0);
        return acc + (Number.isFinite(numeric) ? numeric : 0);
      }, 0);
    }

    return this.evaluateSingleExpression(trimmed, context);
  }

  private evaluateSingleExpression(
    expr: string,
    context: WorkflowContext,
  ): any {
    expr = expr.trim();

    if (!expr.length) {
      return "";
    }

    if (this.isWrappedInParens(expr)) {
      return this.evaluateExpression(expr.slice(1, -1), context);
    }

    if (expr === "Date.now()" || expr === "Date.now") {
      return Date.now();
    }

    if (
      (expr.startsWith("'") && expr.endsWith("'")) ||
      (expr.startsWith('"') && expr.endsWith('"'))
    ) {
      return expr.slice(1, -1);
    }

    if (!isNaN(Number(expr))) {
      return Number(expr);
    }

    if (expr === "true") return true;
    if (expr === "false") return false;
    if (expr === "null") return null;
    if (expr === "undefined") return undefined;

    return this.getVariableByPath(expr, context);
  }

  private getVariableByPath(path: string, context: WorkflowContext): any {
    const parts = path.split(".");
    let value: any = context.getVariable(parts[0]);

    for (let i = 1; i < parts.length; i++) {
      if (value === null || value === undefined) {
        return undefined;
      }
      value = value[parts[i]];
    }

    return value;
  }

  private splitExpression(expression: string, operator: string): string[] {
    const result: string[] = [];
    let depth = 0;
    let lastIndex = 0;

    for (let i = 0; i < expression.length; i += 1) {
      const char = expression[i];
      if (char === "(") {
        depth += 1;
        continue;
      }
      if (char === ")") {
        depth = Math.max(0, depth - 1);
        continue;
      }

      if (
        depth === 0 &&
        expression.slice(i, i + operator.length) === operator
      ) {
        const segment = expression.slice(lastIndex, i).trim();
        if (segment.length) {
          result.push(segment);
        }
        lastIndex = i + operator.length;
        i += operator.length - 1;
      }
    }

    if (result.length === 0) {
      return [expression.trim()];
    }

    const tail = expression.slice(lastIndex).trim();
    if (tail.length) {
      result.push(tail);
    }

    return result;
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
        if (depth < 0) {
          return false;
        }
      }
    }

    return depth === 0;
  }
}
