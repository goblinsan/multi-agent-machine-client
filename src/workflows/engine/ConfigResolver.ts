import type { WorkflowContext } from "./WorkflowContext";
import { logger } from "../../logger.js";

type TransformName = "toUpperCase" | "toLowerCase";

export class ConfigResolver {
  resolveConfiguration(
    config: Record<string, any>,
    context: WorkflowContext,
  ): Record<string, any> {
    const resolved: Record<string, any> = {};

    for (const [key, value] of Object.entries(config)) {
      resolved[key] = this.resolveValue(value, context);
    }

    return resolved;
  }

  private resolveValue(value: any, context: WorkflowContext): any {
    if (typeof value === "string" && value.includes("${")) {
      return this.resolveStringTemplate(value, context);
    }

    if (Array.isArray(value)) {
      return value.map((item) => this.resolveValue(item, context));
    }

    if (value && typeof value === "object") {
      const resolved: Record<string, any> = {};
      for (const [k, v] of Object.entries(value)) {
        resolved[k] = this.resolveValue(v, context);
      }
      return resolved;
    }

    return value;
  }

  private resolveStringTemplate(
    template: string,
    context: WorkflowContext,
  ): any {
    const exactMatch = template.match(/^\$\{([^}]+)\}$/);
    if (exactMatch) {
      const resolved = this.evaluateExpression(exactMatch[1].trim(), context);
      return resolved !== undefined ? resolved : template;
    }

    return template.replace(/\$\{([^}]+)\}/g, (match, expression) => {
      const resolved = this.evaluateExpression(expression.trim(), context);
      return resolved !== undefined ? String(resolved) : match;
    });
  }

  private evaluateExpression(
    expression: string,
    context: WorkflowContext,
  ): any | undefined {
    const trimmed = expression.trim();
    if (!trimmed) {
      return undefined;
    }

    if (trimmed.includes("||")) {
      const parts = trimmed.split("||").map((part) => part.trim());
      for (const part of parts) {
        const value = this.evaluateExpressionPart(part, context);
        if (this.isUsableValue(value)) {
          return value;
        }
      }
      return undefined;
    }

    return this.evaluateExpressionPart(trimmed, context);
  }

  private evaluateExpressionPart(
    expression: string,
    context: WorkflowContext,
  ): any | undefined {
    if (!expression) {
      return undefined;
    }

    if (
      (expression.startsWith("'") && expression.endsWith("'")) ||
      (expression.startsWith('"') && expression.endsWith('"'))
    ) {
      return expression.slice(1, -1);
    }

    if (expression === "[]") {
      return [];
    }

    if (expression === "{}") {
      return {};
    }

    if (expression === "true") {
      return true;
    }

    if (expression === "false") {
      return false;
    }

    if (expression === "null") {
      return null;
    }

    if (/^-?\d+(?:\.\d+)?$/.test(expression)) {
      return Number(expression);
    }

    const transformMatch = expression.match(
      /^([a-zA-Z_][a-zA-Z0-9_]*(?:\.[a-zA-Z_][a-zA-Z0-9_]*)*)(?:\.(toUpperCase|toLowerCase)\(\))?$/,
    );

    if (transformMatch) {
      const [, path, transform] = transformMatch;
      const value = this.getNestedValue(context, path);
      if (value === undefined) {
        return undefined;
      }
      if (!transform) {
        return value;
      }
      return this.applyStringTransform(
        value,
        transform as TransformName,
      );
    }

    const directMatch = expression.match(
      /^([a-zA-Z_][a-zA-Z0-9_]*(?:\.[a-zA-Z_][a-zA-Z0-9_]*)*)$/,
    );
    if (directMatch) {
      return this.getNestedValue(context, directMatch[1]);
    }

    return undefined;
  }

  private applyStringTransform(value: any, transform: TransformName): string {
    const asString = typeof value === "string" ? value : String(value);
    return transform === "toUpperCase"
      ? asString.toUpperCase()
      : asString.toLowerCase();
  }

  private isUsableValue(value: any): boolean {
    return value !== undefined && value !== null;
  }

  private getNestedValue(context: WorkflowContext, path: string): any {
    if (path === "REPO_PATH") {
      logger.warn(
        "REPO_PATH is deprecated. Use repo_remote for distributed agent coordination.",
      );
      return context.repoRoot;
    }
    if (path === "repoRoot") {
      logger.warn(
        "repoRoot reference in workflow. Using repo_remote for distributed coordination.",
      );
      return context.getVariable("repo_remote") || context.repoRoot;
    }
    if (path === "REDIS_STREAM_NAME")
      return (
        context.getVariable("REDIS_STREAM_NAME") ||
        process.env.REDIS_STREAM_NAME ||
        "workflow-tasks"
      );
    if (path === "CONSUMER_GROUP")
      return (
        context.getVariable("CONSUMER_GROUP") ||
        process.env.CONSUMER_GROUP ||
        "workflow-consumers"
      );
    if (path === "CONSUMER_ID")
      return (
        context.getVariable("CONSUMER_ID") ||
        process.env.CONSUMER_ID ||
        "workflow-engine"
      );

    const parts = path.split(".");
    const rootKey = parts[0];
    const remaining = parts.slice(1);

    const rootVariable = context.getVariable(rootKey);
    if (remaining.length === 0) {
      if (rootVariable !== undefined) {
        return rootVariable;
      }

      const stepOutput = context.getStepOutput(rootKey);
      if (stepOutput !== undefined) {
        return stepOutput;
      }
      return undefined;
    }

    if (rootVariable !== undefined) {
      return remaining.reduce((current: any, key) => {
        if (current === undefined || current === null) {
          return undefined;
        }
        return (current as any)[key];
      }, rootVariable);
    }

    const stepOutput = context.getStepOutput(rootKey);
    if (stepOutput !== undefined) {
      return remaining.reduce((current: any, key) => {
        if (current === undefined || current === null) {
          return undefined;
        }
        return (current as any)[key];
      }, stepOutput);
    }

    return undefined;
  }
}
