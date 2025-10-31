import { WorkflowContext } from '../../engine/WorkflowContext.js';
import { logger } from '../../../logger.js';

/**
 * Resolves variable templates in payload data
 * Handles:
 * - Simple variables: ${variableName}
 * - Nested properties: ${task.id}, ${milestone.slug}
 * - Template strings: '.ma/tasks/${task.id}/plan.md'
 * - Arrays and objects (recursive)
 */
export class VariableResolver {
  /**
   * Resolve all variables in a payload object
   */
  resolvePayload(payload: Record<string, any>, context: WorkflowContext): Record<string, any> {
    const resolved: Record<string, any> = {};

    for (const [key, value] of Object.entries(payload)) {
      resolved[key] = this.resolveValue(value, context);
    }

    return resolved;
  }

  /**
   * Recursively resolve a value, handling arrays, objects, and templates
   */
  private resolveValue(value: any, context: WorkflowContext): any {
    if (value === null || value === undefined) {
      return value;
    }

    if (Array.isArray(value)) {
      return value.map(item => this.resolveValue(item, context));
    }

    if (typeof value === 'object') {
      const resolved: Record<string, any> = {};
      for (const [k, v] of Object.entries(value)) {
        resolved[k] = this.resolveValue(v, context);
      }
      return resolved;
    }

    if (typeof value === 'string') {
      return this.resolveStringTemplate(value, context);
    }

    return value;
  }

  /**
   * Resolve a string that may contain variable templates
   * Examples:
   * - '${task}' (exact match) → returns the task object as-is
   * - '${task.id}' → '42'
   * - '.ma/tasks/${task.id}/plan.md' → '.ma/tasks/42/plan.md'
   */
  private resolveStringTemplate(template: string, context: WorkflowContext): any {
    const variablePattern = /\$\{([a-zA-Z_][a-zA-Z0-9_]*(?:\.[a-zA-Z_][a-zA-Z0-9_]*)*)\}/g;
    
    const exactMatch = template.match(/^\$\{([a-zA-Z_][a-zA-Z0-9_]*(?:\.[a-zA-Z_][a-zA-Z0-9_]*)*)\}$/);
    if (exactMatch) {
      const path = exactMatch[1];
      try {
        const parts = path.split('.');
        let value = context.getVariable(parts[0]);
        
        for (let i = 1; i < parts.length; i++) {
          if (value === null || value === undefined) {
            return template;
          }
          if (typeof value === 'object' && parts[i] in value) {
            value = value[parts[i]];
          } else {
            return template;
          }
        }
        
        return value !== undefined && value !== null ? value : template;
      } catch (error) {
        return template;
      }
    }
    
    return template.replace(variablePattern, (match, path) => {
      try {
        const parts = path.split('.');
        let value = context.getVariable(parts[0]);
        
        for (let i = 1; i < parts.length; i++) {
          if (value === null || value === undefined) {
            logger.warn(`Variable path not found, preserving template`, {
              template: match,
              path,
              stoppedAt: parts.slice(0, i).join('.')
            });
            return match;
          }
          
          if (typeof value === 'object' && parts[i] in value) {
            value = value[parts[i]];
          } else {
            logger.warn(`Variable property not found, preserving template`, {
              template: match,
              path,
              missingProperty: parts[i]
            });
            return match;
          }
        }
        
        if (value === null || value === undefined) {
          return match;
        }
        
        return String(value);
      } catch (error) {
        logger.warn(`Failed to resolve variable, preserving template`, {
          template: match,
          path,
          error: error instanceof Error ? error.message : 'Unknown error'
        });
        return match;
      }
    });
  }
}
