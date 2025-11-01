import { logger } from '../../logger.js';
import { cfg } from '../../config.js';
import { SYSTEM_PROMPTS } from '../../personas.js';
import { buildPersonaMessages, callPersonaModel } from '../PersonaRequestHandler.js';
import { ContextExtractor } from '../context/ContextExtractor.js';
import { MessageTransport } from '../../transport/index.js';

export interface PersonaRequestParams {
  persona: string;
  workflowId: string;
  step: string;
  intent: string;
  payload: any;
  repo?: string;
  branch?: string;
  projectId?: string;
  taskId?: string;
}


export class PersonaRequestExecutor {
  constructor(
    private transport: MessageTransport,
    private contextExtractor: ContextExtractor
  ) {}

  
  async execute(params: PersonaRequestParams): Promise<any> {
    const { persona } = params;

    
    if (persona === 'coordination') {
      return await this.handleCoordinationRequest(params);
    }

    
    return await this.handleLLMRequest(params);
  }

  
  private async handleCoordinationRequest(params: PersonaRequestParams): Promise<any> {
    const { workflowId, payload, repo, branch } = params;

    logger.info('PersonaConsumer: Routing coordination request to WorkflowCoordinator', {
      workflowId,
      projectId: payload.project_id || params.projectId,
      intent: params.intent
    });

    const { WorkflowCoordinator } = await import('../../workflows/WorkflowCoordinator.js');
    const coordinator = new WorkflowCoordinator();

    
    await coordinator.handleCoordinator(
      this.transport,
      {} as any,
      {
        workflow_id: workflowId,
        project_id: payload.project_id || params.projectId,
        repo: payload.repo || repo,
        base_branch: payload.base_branch || branch
      },
      payload
    );

    return {
      status: 'success',
      message: 'WorkflowCoordinator execution completed'
    };
  }

  
  private async handleLLMRequest(params: PersonaRequestParams): Promise<any> {
    const { persona, workflowId, intent, payload, repo, branch } = params;

    
    const model = cfg.personaModels[persona];
    if (!model) {
      throw new Error(`No model configured for persona '${persona}'`);
    }

    
    const systemPrompt = SYSTEM_PROMPTS[persona] || `You are the ${persona} persona.`;

    
    const context = await this.contextExtractor.extractContext({
      persona,
      workflowId,
      intent,
      payload,
      repo,
      branch
    });

    const { userText, scanSummary: scanSummaryForPrompt, dashboardContext } = context;

    
    const messages = buildPersonaMessages({
      persona,
      systemPrompt,
      userText,
      scanSummaryForPrompt,
      dashboardContext,
      qaHistory: payload.qa_history,
      planningHistory: payload.planning_history,
      promptFileSnippets: payload.snippets,
      extraSystemMessages: payload.extra_system_messages
    });

    
    const timeoutMs = payload.timeout_ms || cfg.personaTimeouts[persona] || cfg.personaDefaultTimeoutMs;

    logger.debug('PersonaConsumer: Calling LLM', {
      persona,
      model,
      messageCount: messages.length,
      timeoutMs
    });

    
    const response = await callPersonaModel({
      persona,
      model,
      messages,
      timeoutMs
    });

    logger.info('PersonaConsumer: LLM call completed', {
      persona,
      workflowId,
      durationMs: response.duration_ms,
      contentLength: response.content.length
    });

    
    
    
    return {
      output: response.content,
      duration_ms: response.duration_ms
    };
  }
}
