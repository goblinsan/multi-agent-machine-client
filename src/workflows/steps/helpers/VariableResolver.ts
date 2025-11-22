import { WorkflowContext } from "../../engine/WorkflowContext.js";
import { logger } from "../../../logger.js";

type TransformName = "toUpperCase" | "toLowerCase";

export class VariableResolver {
  resolvePayload(
    payload: Record<string, any>,
    context: WorkflowContext,
  ): Record<string, any> {
    const resolved: Record<string, any> = {};

    for (const [key, value] of Object.entries(payload)) {
      resolved[key] = this.resolveValue(value, context);
    }

    return resolved;
  }

  private resolveValue(value: any, context: WorkflowContext): any {
    if (value === null || value === undefined) {
      return value;
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

    if (typeof value === "string") {
      return this.resolveStringTemplate(value, context);
    }

    return value;
  }

  private resolveStringTemplate(
    template: string,
    context: WorkflowContext,
  ): any {
    const variablePattern =
      /\$\{([a-zA-Z_][a-zA-Z0-9_]*(?:\.[a-zA-Z_][a-zA-Z0-9_]*)*)\}/g;
    const transformPattern =
      /\$\{([a-zA-Z_][a-zA-Z0-9_]*(?:\.[a-zA-Z_][a-zA-Z0-9_]*)*)\.(toUpperCase|toLowerCase)\(\)\}/g;

    const transformExactMatch = template.match(
      /^\$\{([a-zA-Z_][a-zA-Z0-9_]*(?:\.[a-zA-Z_][a-zA-Z0-9_]*)*)\.(toUpperCase|toLowerCase)\(\)\}$/,
    );
    if (transformExactMatch) {
      const [, path, transform] = transformExactMatch;
      const value = this.resolvePath(path, context);
      if (value === undefined || value === null) {
        return template;
      }
      return this.applyTransform(value, transform as TransformName);
    }

    const exactMatch = template.match(
      /^\$\{([a-zA-Z_][a-zA-Z0-9_]*(?:\.[a-zA-Z_][a-zA-Z0-9_]*)*)\}$/,
    );
    if (exactMatch) {
      const value = this.resolvePath(exactMatch[1], context);
      return value !== undefined && value !== null ? value : template;
    }

    let workingTemplate = template.replace(
      transformPattern,
      (match, path, transform) => {
        const value = this.resolvePath(path, context);
        if (value === undefined || value === null) {
          return match;
        }
        return this.applyTransform(value, transform as TransformName);
      },
    );

    return workingTemplate.replace(variablePattern, (match, path) => {
      try {
        const value = this.resolvePath(path, context, match);
        if (value === null || value === undefined) {
          return match;
        }
        return String(value);
      } catch (error) {
        logger.warn(`Failed to resolve variable, preserving template`, {
          template: match,
          path,
          error: error instanceof Error ? error.message : "Unknown error",
        });
        return match;
      }
    });
  }

  private applyTransform(value: any, transform: TransformName): string {
    const asString = typeof value === "string" ? value : String(value);
    return transform === "toUpperCase"
      ? asString.toUpperCase()
      : asString.toLowerCase();
  }

  private resolvePath(
    path: string,
    context: WorkflowContext,
    templateForWarnings?: string,
  ): any {
    const parts = path.split(".");
    let value = context.getVariable(parts[0]);

    for (let i = 1; i < parts.length; i++) {
      if (value === null || value === undefined) {
        if (templateForWarnings) {
          logger.warn(`Variable path not found, preserving template`, {
            template: templateForWarnings,
            path,
            stoppedAt: parts.slice(0, i).join("."),
          });
        }
        return undefined;
      }

      if (typeof value === "object" && parts[i] in value) {
        value = (value as any)[parts[i]];
      } else {
        if (templateForWarnings) {
          logger.warn(`Variable property not found, preserving template`, {
            template: templateForWarnings,
            path,
            missingProperty: parts[i],
          });
        }
        return undefined;
      }
    }

    return value;
  }
}
