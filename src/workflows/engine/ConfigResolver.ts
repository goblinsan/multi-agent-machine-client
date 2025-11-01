import type { WorkflowContext } from "./WorkflowContext";
import { logger } from "../../logger.js";

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
      const exactMatch = value.match(/^\$\{([^}]+)\}$/);
      if (exactMatch) {
        const contextValue = this.getNestedValue(context, exactMatch[1]);
        return contextValue !== undefined ? contextValue : value;
      }

      return value.replace(/\$\{([^}]+)\}/g, (match, path) => {
        const contextValue = this.getNestedValue(context, path);
        return contextValue !== undefined ? String(contextValue) : match;
      });
    } else if (Array.isArray(value)) {
      return value.map((item) => this.resolveValue(item, context));
    } else if (value && typeof value === "object") {
      const resolved: Record<string, any> = {};
      for (const [k, v] of Object.entries(value)) {
        resolved[k] = this.resolveValue(v, context);
      }
      return resolved;
    }

    return value;
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

    const variable = context.getVariable(path);
    if (variable !== undefined) {
      return variable;
    }

    if (path.includes(".")) {
      const [stepName, ...propertyPath] = path.split(".");
      const stepOutput = context.getStepOutput(stepName);
      if (stepOutput) {
        return propertyPath.reduce(
          (current, key) => current?.[key],
          stepOutput,
        );
      }
    }

    return undefined;
  }
}
