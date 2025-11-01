import { logger } from '../../../logger.js';

export interface PMDecision {
  decision: 'immediate_fix' | 'defer';
  reasoning: string;
  detected_stage?: 'early' | 'beta' | 'production';
  immediate_issues: string[];
  deferred_issues: string[];
  follow_up_tasks: Array<{
    title: string;
    description: string;
    priority: 'critical' | 'high' | 'medium' | 'low';
  }>;
  backlog?: Array<{
    title: string;
    description: string;
    priority: 'critical' | 'high' | 'medium' | 'low';
  }>;
}


export class DecisionParser {
  
  parseFromString(input: string, reviewType?: string, warnings?: string[]): PMDecision {
    
    try {
      const parsed = JSON.parse(input);
      if (typeof parsed === 'object' && parsed !== null) {
        return this.parseFromObject(parsed, reviewType, warnings);
      }
    } catch (e) {
      logger.debug('Failed to parse PM decision as JSON', { error: String(e) });
    }

    
    try {
      const codeBlockMatch = input.match(/```json([\s\S]*?)```/i);
      if (codeBlockMatch) {
        const jsonText = codeBlockMatch[1].trim();
        const parsed = JSON.parse(jsonText);
        if (typeof parsed === 'object' && parsed !== null) {
          return this.parseFromObject(parsed, reviewType, warnings);
        }
      }
    } catch (e) {
      logger.debug('Failed to extract and parse JSON from text', { error: String(e) });
    }

    
    const decision: PMDecision = {
      decision: input.toLowerCase().includes('defer') ? 'defer' : 'immediate_fix',
      reasoning: '',
      immediate_issues: [],
      deferred_issues: [],
      follow_up_tasks: []
    };

    
    const reasoningMatch = input.match(/reasoning[:\s]+([^\n]+)/i);
    if (reasoningMatch) {
      decision.reasoning = reasoningMatch[1].trim();
    }

    
    const immediateMatch = input.match(/immediate[_\s]issues?[:\s]+\[(.*?)\]/is);
    if (immediateMatch) {
      decision.immediate_issues = this.parseArrayString(immediateMatch[1]);
    }

    
    const deferredMatch = input.match(/deferred[_\s]issues?[:\s]+\[(.*?)\]/is);
    if (deferredMatch) {
      decision.deferred_issues = this.parseArrayString(deferredMatch[1]);
    }

    
    const tasksMatch = input.match(/follow[_\s]up[_\s]tasks?[:\s]+\[(.*?)\]/is);
    if (tasksMatch) {
      decision.follow_up_tasks = this.parseTasksArray(tasksMatch[1]);
    }

    return decision;
  }

  
  parseFromObject(input: any, reviewType?: string, warnings?: string[]): PMDecision {
    
    let decisionObj = input;
    if (input.pm_decision) {
      decisionObj = input.pm_decision;
    } else if (input.decision_object) {
      decisionObj = input.decision_object;
    } else if (input.output && typeof input.output === 'object') {
      decisionObj = input.output;
    } else if (input.json && typeof input.json === 'object') {
      decisionObj = input.json;
    }

    
    let followUpTasks = [];
    if (Array.isArray(decisionObj.follow_up_tasks)) {
      followUpTasks = decisionObj.follow_up_tasks;
    }
    
    
    if (Array.isArray(decisionObj.backlog)) {
      const msg = 'PM returned deprecated "backlog" field - merging into follow_up_tasks';
      logger.warn(msg, {
        backlogCount: decisionObj.backlog.length,
        followUpTasksCount: followUpTasks.length,
        reviewType
      });
      if (warnings) warnings.push('PM used deprecated "backlog" field');
      
      
      followUpTasks = [...followUpTasks, ...decisionObj.backlog];

      
      if (Array.isArray(decisionObj.follow_up_tasks) && warnings) {
        warnings.push('PM returned both "backlog" and "follow_up_tasks"');
      }
    }

    const decision: PMDecision = {
      decision: (decisionObj.status && /immediate_fix/i.test(String(decisionObj.status)))
        ? 'immediate_fix'
        : (decisionObj.immediate_fix === true
          ? 'immediate_fix'
          : (decisionObj.immediate_fix === false
            ? 'defer'
            : (decisionObj.decision === 'defer' ? 'defer' : 'immediate_fix'))),
      reasoning: decisionObj.reasoning || decisionObj.explanation || '',
      immediate_issues: Array.isArray(decisionObj.immediate_issues) 
        ? decisionObj.immediate_issues 
        : [],
      deferred_issues: Array.isArray(decisionObj.deferred_issues)
        ? decisionObj.deferred_issues
        : [],
      follow_up_tasks: followUpTasks.map((task: any) => ({
        title: task.title || '',
        description: task.description || '',
        priority: this.normalizePriority(task.priority)
      }))
    };

    
    if (decisionObj.detected_stage) {
      decision.detected_stage = decisionObj.detected_stage;
    }

    return decision;
  }

  
  private parseArrayString(str: string): string[] {
    const items: string[] = [];
    const matches = str.matchAll(/"([^"]*)"/g);
    for (const match of matches) {
      items.push(match[1]);
    }
    return items;
  }

  
  private parseTasksArray(str: string): Array<{ title: string; description: string; priority: 'critical' | 'high' | 'medium' | 'low' }> {
    const tasks: Array<{ title: string; description: string; priority: 'critical' | 'high' | 'medium' | 'low' }> = [];
    
    try {
      const parsed = JSON.parse(`[${str}]`);
      if (Array.isArray(parsed)) {
        return parsed.map((task: any) => ({
          title: task.title || '',
          description: task.description || '',
          priority: this.normalizePriority(task.priority)
        }));
      }
    } catch (e) {
      logger.debug('Failed to parse tasks array from JSON', { error: String(e) });
    }

    const taskMatches = str.matchAll(/\{[^}]+\}/g);
    for (const match of taskMatches) {
      try {
        const task = JSON.parse(match[0]);
        tasks.push({
          title: task.title || '',
          description: task.description || '',
          priority: this.normalizePriority(task.priority)
        });
      } catch (e) {
        logger.debug('Failed to parse individual task JSON', { match: match[0], error: String(e) });
      }
    }

    return tasks;
  }

  
  private normalizePriority(priority: any): 'critical' | 'high' | 'medium' | 'low' {
    const p = String(priority).toLowerCase();
    if (p.includes('critical') || p.includes('severe')) return 'critical';
    if (p.includes('high') || p.includes('urgent')) return 'high';
    if (p.includes('low') || p.includes('minor')) return 'low';
    return 'medium';
  }
}
