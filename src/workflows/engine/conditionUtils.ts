import type { WorkflowContext } from './WorkflowContext';

/**
 * SINGLE SOURCE OF TRUTH for condition evaluation logic.
 * 
 * This module contains the unified condition evaluation logic used by:
 * - WorkflowStep.shouldExecute() for step conditions
 * - ConditionEvaluator.evaluateTriggerCondition() for workflow triggers
 * 
 * Centralizing this logic here prevents duplication and ensures all condition
 * evaluation behaves identically throughout the system.
 */

/**
 * Evaluate a condition string against a workflow context.
 * 
 * Supported syntax:
 * - Equality with booleans: "${var} == true" or "var == false"
 * - Inequality with booleans: "${var} != true" or "var != false"
 * - Equality with strings: "${var} == 'value'" or "var == 'value'"
 * - Inequality with strings: "${var} != 'value'" or "var != 'value'"
 * - Dot notation: "step_name.output_field == 'value'"
 * - Template syntax is optional: "${var}" and "var" both work
 * - OR conditions: "var1 == 'a' || var2 == 'b'"
 * - AND conditions: "var1 == 'a' && var2 == 'b'"
 * 
 * @param condition The condition string to evaluate
 * @param context The workflow context containing variables and step outputs
 * @returns true if condition is met, false otherwise
 */
export function evaluateCondition(condition: string, context: WorkflowContext): boolean {
  // Handle OR conditions (||)
  if (condition.includes('||')) {
    const parts = condition.split('||').map(s => s.trim());
    return parts.some(part => evaluateSingleCondition(part, context));
  }
  
  // Handle AND conditions (&&)
  if (condition.includes('&&')) {
    const parts = condition.split('&&').map(s => s.trim());
    return parts.every(part => evaluateSingleCondition(part, context));
  }
  
  // Single condition
  return evaluateSingleCondition(condition, context);
}

/**
 * Evaluate a single condition (no OR/AND operators)
 */
function evaluateSingleCondition(condition: string, context: WorkflowContext): boolean {
  // Remove template syntax if present: ${var} -> var
  let cleanCondition = condition.replace(/\$\{([^}]+)\}/g, '$1').trim();
  
  // Support inequality with boolean: "context_scan.reused_existing != true"
  const neqBoolMatch = cleanCondition.match(/^([\w.]+)\s*!=\s*(true|false)$/);
  if (neqBoolMatch) {
    const [, varPath, boolStr] = neqBoolMatch;
    const expectedValue = boolStr === 'true';
    const actualValue = resolveVariablePath(varPath, context);
    return actualValue !== expectedValue;
  }
  
  // Support equality with boolean: "context_scan.reused_existing == true"
  const eqBoolMatch = cleanCondition.match(/^([\w.]+)\s*==\s*(true|false)$/);
  if (eqBoolMatch) {
    const [, varPath, boolStr] = eqBoolMatch;
    const expectedValue = boolStr === 'true';
    const actualValue = resolveVariablePath(varPath, context);
    return actualValue === expectedValue;
  }
  
  // Support simple equality checks with strings: "plan_status == 'pass'"
  const eqMatch = cleanCondition.match(/^([\w.]+)\s*==\s*'([^']*)'$/);
  if (eqMatch) {
    const [, varPath, value] = eqMatch;
    const contextValue = resolveVariablePath(varPath, context);
    return contextValue === value;
  }
  
  // Support inequality checks with strings: "plan_status != 'fail'"
  const neqMatch = cleanCondition.match(/^([\w.]+)\s*!=\s*'([^']*)'$/);
  if (neqMatch) {
    const [, varPath, value] = neqMatch;
    const contextValue = resolveVariablePath(varPath, context);
    return contextValue !== value;
  }

  // Unsupported format - log warning and return false
  // This handles cases like:
  // - Comparison operators: "length > 0", "count < 5"
  // - Property access: "array.length", "obj.property.nested"
  // - Function calls: "isEmpty(var)", "contains(list, item)"
  // - Parentheses: "(a && b) || c"
  context.logger.warn('Unsupported condition pattern, defaulting to false', {
    condition: cleanCondition
  });
  return false;
}

/**
 * Resolve a variable path like "context_scan.reused_existing" from context.
 * 
 * Supports:
 * - Simple variables: "task_type"
 * - Step outputs: "step_name.output_field"
 * - Nested variables: "var.nested.deep"
 * 
 * @param varPath The variable path to resolve
 * @param context The workflow context
 * @returns The resolved value or undefined
 */
export function resolveVariablePath(varPath: string, context: WorkflowContext): any {
  const parts = varPath.split('.');
  
  if (parts.length === 1) {
    // Simple variable: just get from context
    const value = context.getVariable(parts[0]);
    context.logger.debug('Resolved simple variable', { varPath, value });
    return value;
  }
  
  if (parts.length === 2) {
    // Could be step_name.output_field
    const [stepName, outputField] = parts;
    const stepOutput = context.getStepOutput(stepName);
    
    context.logger.debug('Resolving step output path', {
      varPath,
      stepName,
      outputField,
      stepOutput: stepOutput ? JSON.stringify(stepOutput).substring(0, 200) : 'null',
      hasField: stepOutput && outputField in stepOutput
    });
    
    if (stepOutput && outputField in stepOutput) {
      return stepOutput[outputField];
    }
    
    // Or could be a nested variable
    const value = context.getVariable(parts[0]);
    if (value && typeof value === 'object' && outputField in value) {
      return value[outputField];
    }
  }
  
  // For deeper paths, try step output first, then nested variable
  if (parts.length > 2) {
    const stepName = parts[0];
    const stepOutput = context.getStepOutput(stepName);
    
    if (stepOutput) {
      // Navigate the path through the step output
      let current = stepOutput;
      for (let i = 1; i < parts.length; i++) {
        if (current && typeof current === 'object' && parts[i] in current) {
          current = current[parts[i]];
        } else {
          current = undefined;
          break;
        }
      }
      if (current !== undefined) {
        return current;
      }
    }
    
    // Try as nested variable
    const baseValue = context.getVariable(parts[0]);
    if (baseValue && typeof baseValue === 'object') {
      let current = baseValue;
      for (let i = 1; i < parts.length; i++) {
        if (current && typeof current === 'object' && parts[i] in current) {
          current = current[parts[i]];
        } else {
          return undefined;
        }
      }
      return current;
    }
  }
  
  return undefined;
}
