import type { WorkflowContext } from './WorkflowContext';




export function evaluateCondition(condition: string, context: WorkflowContext): boolean {
  
  if (condition.includes('||')) {
    const parts = condition.split('||').map(s => s.trim());
    return parts.some(part => evaluateSingleCondition(part, context));
  }
  
  
  if (condition.includes('&&')) {
    const parts = condition.split('&&').map(s => s.trim());
    return parts.every(part => evaluateSingleCondition(part, context));
  }
  
  
  return evaluateSingleCondition(condition, context);
}


function evaluateSingleCondition(condition: string, context: WorkflowContext): boolean {
  
  let cleanCondition = condition.replace(/\$\{([^}]+)\}/g, '$1').trim();
  
  
  const neqBoolMatch = cleanCondition.match(/^([\w.]+)\s*!=\s*(true|false)$/);
  if (neqBoolMatch) {
    const [, varPath, boolStr] = neqBoolMatch;
    const expectedValue = boolStr === 'true';
    const actualValue = resolveVariablePath(varPath, context);
    return actualValue !== expectedValue;
  }
  
  
  const eqBoolMatch = cleanCondition.match(/^([\w.]+)\s*==\s*(true|false)$/);
  if (eqBoolMatch) {
    const [, varPath, boolStr] = eqBoolMatch;
    const expectedValue = boolStr === 'true';
    const actualValue = resolveVariablePath(varPath, context);
    return actualValue === expectedValue;
  }
  
  
  const eqMatch = cleanCondition.match(/^([\w.]+)\s*==\s*'([^']*)'$/);
  if (eqMatch) {
    const [, varPath, value] = eqMatch;
    const contextValue = resolveVariablePath(varPath, context);
    return contextValue === value;
  }
  
  const neqMatch = cleanCondition.match(/^([\w.]+)\s*!=\s*'([^']*)'$/);
  if (neqMatch) {
    const [, varPath, value] = neqMatch;
    const contextValue = resolveVariablePath(varPath, context);
    return contextValue !== value;
  }

  
  
  
  
  
  
  context.logger.warn('Unsupported condition pattern, defaulting to false', {
    condition: cleanCondition
  });
  return false;
}


export function resolveVariablePath(varPath: string, context: WorkflowContext): any {
  const parts = varPath.split('.');
  
  if (parts.length === 1) {
    
    const value = context.getVariable(parts[0]);
    context.logger.debug('Resolved simple variable', { varPath, value });
    return value;
  }
  
  if (parts.length === 2) {
    
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
    
    
    const value = context.getVariable(parts[0]);
    if (value && typeof value === 'object' && outputField in value) {
      return value[outputField];
    }
  }
  
  
  if (parts.length > 2) {
    const stepName = parts[0];
    const stepOutput = context.getStepOutput(stepName);
    
    if (stepOutput) {
      
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
