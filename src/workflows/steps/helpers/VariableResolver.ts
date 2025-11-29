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
    const expressionPattern = /\$\{([^}]+)\}/g;

    const exactMatch = template.match(/^\$\{([^}]+)\}$/);
    if (exactMatch) {
      const { value, resolved, hadFallback } = this.evaluateExpression(
        exactMatch[1].trim(),
        context,
      );
      if (resolved) {
        return value;
      }
      return hadFallback ? "" : template;
    }

    return template.replace(expressionPattern, (match, expression) => {
      const { value, resolved, hadFallback } = this.evaluateExpression(
        expression.trim(),
        context,
        match,
      );
      if (resolved) {
        return typeof value === "string" ? value : String(value);
      }
      return hadFallback ? "" : match;
    });
  }

  private evaluateExpression(
    expression: string,
    context: WorkflowContext,
    templateForWarnings?: string,
  ): { value: any; resolved: boolean; hadFallback: boolean } {
    const segments = expression
      .split("||")
      .map((segment) => segment.trim())
      .filter((segment) => segment.length > 0);
    const hadFallback = segments.length > 1;

    for (const segment of segments) {
      const value = this.evaluateSingleSegment(
        segment,
        context,
        templateForWarnings,
      );
      if (value !== undefined && value !== null) {
        return { value, resolved: true, hadFallback };
      }
    }

    return { value: undefined, resolved: false, hadFallback };
  }

  private evaluateSingleSegment(
    segment: string,
    context: WorkflowContext,
    templateForWarnings?: string,
  ): any {
    if (!segment.length) {
      return undefined;
    }

    const transformMatch = segment.match(
      /^([a-zA-Z_][a-zA-Z0-9_]*(?:\.[a-zA-Z_][a-zA-Z0-9_]*)*)\.(toUpperCase|toLowerCase)\(\)$/,
    );
    if (transformMatch) {
      const [, path, transform] = transformMatch;
      const value = this.resolvePath(path, context, templateForWarnings);
      return value === undefined || value === null
        ? undefined
        : this.applyTransform(value, transform as TransformName);
    }

    if ((segment.startsWith("\"") && segment.endsWith("\"")) || (segment.startsWith("'") && segment.endsWith("'"))) {
      return segment.slice(1, -1);
    }

    if (segment === "[]") {
      return [];
    }

    if (segment === "{}") {
      return {};
    }

    if (/^[-+]?\d+(?:\.\d+)?$/.test(segment)) {
      return Number(segment);
    }

    if (segment === "true") {
      return true;
    }

    if (segment === "false") {
      return false;
    }

    return this.resolvePath(segment, context, templateForWarnings);
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
