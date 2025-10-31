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

/**
 * PersonaRequestExecutor - Executes persona requests (LLM calls or coordination)
 * 
 * Responsibilities:
 * - Route coordination requests to WorkflowCoordinator
 * - Execute LLM requests for all other personas
 * - Build messages and call models
 * - Handle special persona cases
 */
export class PersonaRequestExecutor {
  constructor(
    private transport: MessageTransport,
    private contextExtractor: ContextExtractor
  ) {}

  /**
   * Execute a persona request by calling LLM or routing to coordinator
   */
  async execute(params: PersonaRequestParams): Promise<any> {
    const { persona } = params;

    // SPECIAL CASE: coordination persona routes to WorkflowCoordinator instead of LLM
    if (persona === 'coordination') {
      return await this.handleCoordinationRequest(params);
    }

    // Standard LLM request
    return await this.handleLLMRequest(params);
  }

  /**
   * Handle coordination persona - routes to WorkflowCoordinator
   */
  private async handleCoordinationRequest(params: PersonaRequestParams): Promise<any> {
    const { workflowId, payload, repo, branch } = params;

    logger.info('PersonaConsumer: Routing coordination request to WorkflowCoordinator', {
      workflowId,
      projectId: payload.project_id || params.projectId,
      intent: params.intent
    });

    const { WorkflowCoordinator } = await import('../../workflows/WorkflowCoordinator.js');
    const coordinator = new WorkflowCoordinator();

    // Call handleCoordinator with appropriate parameters
    await coordinator.handleCoordinator(
      this.transport,
      {} as any, // redis client (not used with transport abstraction)
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

  /**
   * Handle standard LLM persona request
   */
  private async handleLLMRequest(params: PersonaRequestParams): Promise<any> {
    const { persona, workflowId, intent, payload, repo, branch } = params;

    // Get persona configuration
    const model = cfg.personaModels[persona];
    if (!model) {
      throw new Error(`No model configured for persona '${persona}'`);
    }

    // Get system prompt for this persona
    const systemPrompt = SYSTEM_PROMPTS[persona] || `You are the ${persona} persona.`;

    // Extract context using ContextExtractor
    const context = await this.contextExtractor.extractContext({
      persona,
      workflowId,
      intent,
      payload,
      repo,
      branch
    });

    const { userText, scanSummary: scanSummaryForPrompt, dashboardContext } = context;

    // Build messages for LLM
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

    // Get timeout for this persona
    const timeoutMs = payload.timeout_ms || cfg.personaTimeouts[persona] || cfg.personaDefaultTimeoutMs;

    logger.debug('PersonaConsumer: Calling LLM', {
      persona,
      model,
      messageCount: messages.length,
      timeoutMs
    });

    // Call the model
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

    // Return response in expected format
    return {
      output: response.content,
      duration_ms: response.duration_ms,
      status: 'pass' // Default to pass - coordinator will interpret the response
    };
  }
}
