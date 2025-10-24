import type { WorkflowContext } from './WorkflowContext';
import { logger } from '../../logger.js';

/**
 * Handles resolution of configuration placeholders with context values
 */
export class ConfigResolver {
  /**
   * Resolve configuration placeholders with context values
   */
  resolveConfiguration(config: Record<string, any>, context: WorkflowContext): Record<string, any> {
    const resolved: Record<string, any> = {};
    
    for (const [key, value] of Object.entries(config)) {
      resolved[key] = this.resolveValue(value, context);
    }
    
    return resolved;
  }

  /**
   * Resolve a single configuration value
   */
  private resolveValue(value: any, context: WorkflowContext): any {
    if (typeof value === 'string' && value.includes('${')) {
      // Replace placeholders like ${REPO_PATH} or ${task.title}
      return value.replace(/\$\{([^}]+)\}/g, (match, path) => {
        const contextValue = this.getNestedValue(context, path);
        return contextValue !== undefined ? String(contextValue) : match;
      });
    } else if (Array.isArray(value)) {
      return value.map(item => this.resolveValue(item, context));
    } else if (value && typeof value === 'object') {
      const resolved: Record<string, any> = {};
      for (const [k, v] of Object.entries(value)) {
        resolved[k] = this.resolveValue(v, context);
      }
      return resolved;
    }
    
    return value;
  }

  /**
   * Get nested value from context
   */
  private getNestedValue(context: WorkflowContext, path: string): any {
    // Handle special context variables
    if (path === 'REPO_PATH') {
      logger.warn('REPO_PATH is deprecated. Use repo_remote for distributed agent coordination.');
      return context.repoRoot;
    }
    if (path === 'repoRoot') {
      logger.warn('repoRoot reference in workflow. Using repo_remote for distributed coordination.');
      return context.getVariable('repo_remote') || context.repoRoot;
    }
    if (path === 'REDIS_STREAM_NAME') return context.getVariable('REDIS_STREAM_NAME') || process.env.REDIS_STREAM_NAME || 'workflow-tasks';
    if (path === 'CONSUMER_GROUP') return context.getVariable('CONSUMER_GROUP') || process.env.CONSUMER_GROUP || 'workflow-consumers';
    if (path === 'CONSUMER_ID') return context.getVariable('CONSUMER_ID') || process.env.CONSUMER_ID || 'workflow-engine';
    
    // Try to get from variables first
    const variable = context.getVariable(path);
    if (variable !== undefined) {
      return variable;
    }
    
    // Try to get from step outputs
    if (path.includes('.')) {
      const [stepName, ...propertyPath] = path.split('.');
      const stepOutput = context.getStepOutput(stepName);
      if (stepOutput) {
        return propertyPath.reduce((current, key) => current?.[key], stepOutput);
      }
    }
    
    return undefined;
  }
}
