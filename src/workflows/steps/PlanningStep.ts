import { WorkflowStep, StepResult, ValidationResult, WorkflowStepConfig } from '../engine/WorkflowStep.js';
import { WorkflowContext } from '../engine/WorkflowContext.js';
import { logger } from '../../logger.js';
import { callLMStudio, ChatMessage } from '../../lmstudio.js';
import { TaskData } from './PullTaskStep.js';

export interface PlanningConfig {
  persona: string;
  model?: string;
  temperature?: number;
  planningPromptTemplate?: string;
  maxPlanningTokens?: number;
  requireApproval?: boolean;
  planValidationRules?: string[];
}

export interface PlanningResult {
  plan: string;
  breakdown: Array<{
    step: number;
    title: string;
    description: string;
    dependencies: number[];
    estimatedDuration: string;
    complexity: 'low' | 'medium' | 'high';
  }>;
  risks: Array<{
    description: string;
    severity: 'low' | 'medium' | 'high';
    mitigation: string;
  }>;
  metadata: {
    plannedAt: number;
    persona: string;
    model: string;
    approved: boolean;
    planVersion: string;
  };
}

/**
 * PlanningStep - Creates implementation plans for tasks
 * 
 * Configuration:
 * - persona: Persona to use for planning
 * - model: LLM model to use (optional)
 * - temperature: Sampling temperature (default: 0.3)
 * - planningPromptTemplate: Custom planning prompt (optional)
 * - maxPlanningTokens: Max tokens for planning (default: 2000)
 * - requireApproval: Whether plan needs approval (default: false)
 * - planValidationRules: Rules to validate the plan
 * 
 * Outputs:
 * - planningResult: Complete planning result
 * - plan: The text plan
 * - breakdown: Structured plan breakdown
 * - risks: Identified risks and mitigations
 */
export class PlanningStep extends WorkflowStep {
  async execute(context: WorkflowContext): Promise<StepResult> {
    const config = this.config.config as PlanningConfig;
    const {
      persona,
      model,
      temperature = 0.3,
      planningPromptTemplate,
      maxPlanningTokens = 2000,
      requireApproval = false,
      planValidationRules = []
    } = config;

    logger.info(`Creating implementation plan with persona: ${persona}`, {
      model,
      temperature,
      maxPlanningTokens,
      requireApproval
    });

    try {
      // Get task data from context
      const task = context.getVariable('task') as TaskData;
      if (!task) {
        throw new Error('No task data found in context');
      }

      // Get repository context
      const contextData = context.getVariable('context');

      // Build planning prompt
      const prompt = planningPromptTemplate || this.buildPlanningPrompt(task, contextData);

      logger.debug('Generated planning prompt', {
        promptLength: prompt.length,
        persona,
        taskType: task.type
      });

      // Call LLM for planning
      const messages: ChatMessage[] = [
        {
          role: 'system',
          content: `You are a ${persona} responsible for creating detailed implementation plans. 
          Provide structured, actionable plans with clear steps, dependencies, and risk assessment.
          Format your response as JSON with the following structure:
          {
            "plan": "High-level plan description",
            "breakdown": [
              {
                "step": 1,
                "title": "Step title",
                "description": "Detailed description",
                "dependencies": [],
                "estimatedDuration": "time estimate",
                "complexity": "low|medium|high"
              }
            ],
            "risks": [
              {
                "description": "Risk description",
                "severity": "low|medium|high",
                "mitigation": "How to mitigate this risk"
              }
            ]
          }`
        },
        {
          role: 'user',
          content: prompt
        }
      ];

      const startTime = Date.now();
      const llmResponse = await callLMStudio(
        model || 'default',
        messages,
        temperature,
        { timeoutMs: 60000 }
      );

      const duration_ms = Date.now() - startTime;

      // Parse the planning response
      let parsedPlan: any;
      try {
        parsedPlan = JSON.parse(llmResponse.content);
      } catch (error) {
        // Fallback: try to extract structured data from text
        parsedPlan = this.parseUnstructuredPlan(llmResponse.content);
      }

      // Validate the plan
      const validationErrors = this.validatePlan(parsedPlan, planValidationRules);
      if (validationErrors.length > 0) {
        logger.warn('Plan validation failed', { errors: validationErrors });
        // Continue with warnings rather than failing
      }

      // Build planning result
      const planningResult: PlanningResult = {
        plan: parsedPlan.plan || llmResponse.content,
        breakdown: parsedPlan.breakdown || [],
        risks: parsedPlan.risks || [],
        metadata: {
          plannedAt: Date.now(),
          persona,
          model: model || 'default',
          approved: !requireApproval, // Auto-approve if approval not required
          planVersion: `v1.0-${Date.now()}`
        }
      };

      // Set context variables
      context.setVariable('planningResult', planningResult);
      context.setVariable('plan', planningResult.plan);
      context.setVariable('breakdown', planningResult.breakdown);
      context.setVariable('risks', planningResult.risks);

      logger.info('Planning completed successfully', {
        persona,
        planLength: planningResult.plan.length,
        stepCount: planningResult.breakdown.length,
        riskCount: planningResult.risks.length,
        duration_ms,
        approved: planningResult.metadata.approved
      });

      return {
        status: 'success',
        data: planningResult,
        outputs: {
          planningResult,
          plan: planningResult.plan,
          breakdown: planningResult.breakdown,
          risks: planningResult.risks
        },
        metrics: {
          duration_ms,
          operations_count: planningResult.breakdown.length
        }
      };

    } catch (error: any) {
      logger.error('Planning failed', {
        error: error.message,
        persona,
        step: this.config.name
      });
      
      return {
        status: 'failure',
        error: new Error(`Planning failed: ${error.message}`)
      };
    }
  }

  private buildPlanningPrompt(task: TaskData, contextData: any): string {
    let prompt = `Task Planning Request:\n\n`;
    prompt += `Task Type: ${task.type}\n`;
    prompt += `Task ID: ${task.id}\n`;
    
    if (task.data.description) {
      prompt += `Description: ${task.data.description}\n`;
    }
    
    if (task.data.requirements) {
      prompt += `Requirements:\n${JSON.stringify(task.data.requirements, null, 2)}\n`;
    }

    if (contextData && contextData.repoScan) {
      const fileCount = contextData.repoScan.length;
      const totalBytes = contextData.metadata.totalBytes;
      prompt += `\nRepository Context:\n`;
      prompt += `- ${fileCount} files scanned\n`;
      prompt += `- ${(totalBytes / 1024).toFixed(1)} KB total size\n`;
      
      // Include key files
      const keyFiles = contextData.repoScan
        .filter((file: any) => 
          file.path.endsWith('.ts') || 
          file.path.endsWith('.js') || 
          file.path.includes('package.json') ||
          file.path.includes('README')
        )
        .slice(0, 10)
        .map((file: any) => `- ${file.path}`)
        .join('\n');
      
      if (keyFiles) {
        prompt += `\nKey Files:\n${keyFiles}\n`;
      }
    }

    prompt += `\nPlease create a detailed implementation plan for this task. Include:
1. A high-level overview of the approach
2. Step-by-step breakdown with dependencies
3. Risk assessment and mitigation strategies
4. Estimated timeline for each step
5. Complexity assessment

Focus on practical, actionable steps that can be executed by the development team.`;

    return prompt;
  }

  private parseUnstructuredPlan(text: string): any {
    // Simple fallback parser for unstructured planning text
    const lines = text.split('\n').filter(line => line.trim());
    
    let plan = '';
    const breakdown: any[] = [];
    const risks: any[] = [];
    
    let currentSection = 'plan';
    let stepNumber = 1;
    
    for (const line of lines) {
      const trimmed = line.trim();
      
      if (trimmed.toLowerCase().includes('step') || trimmed.match(/^\d+\./)) {
        // Extract step information
        const stepMatch = trimmed.match(/(?:step\s*)?(\d+)\.?\s*(.+)/i);
        if (stepMatch) {
          breakdown.push({
            step: stepNumber++,
            title: stepMatch[2],
            description: stepMatch[2],
            dependencies: [],
            estimatedDuration: 'TBD',
            complexity: 'medium'
          });
        }
        currentSection = 'steps';
      } else if (trimmed.toLowerCase().includes('risk')) {
        currentSection = 'risks';
      } else if (currentSection === 'plan' && trimmed.length > 10) {
        plan += trimmed + ' ';
      } else if (currentSection === 'risks' && trimmed.length > 10) {
        risks.push({
          description: trimmed,
          severity: 'medium',
          mitigation: 'To be determined'
        });
      }
    }
    
    return {
      plan: plan.trim() || text,
      breakdown,
      risks
    };
  }

  private validatePlan(plan: any, rules: string[]): string[] {
    const errors: string[] = [];
    
    if (!plan.plan || typeof plan.plan !== 'string' || plan.plan.length < 50) {
      errors.push('Plan description is too short or missing');
    }
    
    if (!Array.isArray(plan.breakdown) || plan.breakdown.length === 0) {
      errors.push('Plan breakdown is missing or empty');
    }
    
    if (plan.breakdown) {
      for (const step of plan.breakdown) {
        if (!step.title || !step.description) {
          errors.push(`Step ${step.step} is missing title or description`);
        }
      }
    }
    
    // Apply custom validation rules
    for (const rule of rules) {
      // Simple rule validation - can be enhanced
      if (rule === 'require_risks' && (!plan.risks || plan.risks.length === 0)) {
        errors.push('Plan must include risk assessment');
      }
    }
    
    return errors;
  }

  protected async validateConfig(context: WorkflowContext): Promise<ValidationResult> {
    const config = this.config.config as any;
    const errors: string[] = [];
    const warnings: string[] = [];

    if (!config.persona || typeof config.persona !== 'string') {
      errors.push('PlanningStep: persona is required and must be a string');
    }

    if (config.model !== undefined && typeof config.model !== 'string') {
      errors.push('PlanningStep: model must be a string');
    }

    if (config.temperature !== undefined && (typeof config.temperature !== 'number' || config.temperature < 0 || config.temperature > 2)) {
      errors.push('PlanningStep: temperature must be a number between 0 and 2');
    }

    if (config.planningPromptTemplate !== undefined && typeof config.planningPromptTemplate !== 'string') {
      errors.push('PlanningStep: planningPromptTemplate must be a string');
    }

    if (config.maxPlanningTokens !== undefined && (typeof config.maxPlanningTokens !== 'number' || config.maxPlanningTokens < 100)) {
      errors.push('PlanningStep: maxPlanningTokens must be a number >= 100');
    }

    if (config.requireApproval !== undefined && typeof config.requireApproval !== 'boolean') {
      errors.push('PlanningStep: requireApproval must be a boolean');
    }

    if (config.planValidationRules !== undefined) {
      if (!Array.isArray(config.planValidationRules)) {
        errors.push('PlanningStep: planValidationRules must be an array');
      } else if (!config.planValidationRules.every((rule: any) => typeof rule === 'string')) {
        errors.push('PlanningStep: planValidationRules must be an array of strings');
      }
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings
    };
  }

  async cleanup(context: WorkflowContext): Promise<void> {
    // Clean up any planning artifacts
    const planningResult = context.getVariable('planningResult');
    if (planningResult) {
      logger.debug('Cleaning up planning result');
    }
  }
}