import { MessageTransport } from '../transport/MessageTransport.js';
import { cfg } from '../config.js';
import { logger } from '../logger.js';
import { buildPersonaMessages, callPersonaModel } from './PersonaRequestHandler.js';
import { SYSTEM_PROMPTS } from '../personas.js';

export type PersonaConsumerConfig = {
  /** List of personas this consumer should handle */
  personas: string[];
  /** Consumer ID (defaults to cfg.consumerId) */
  consumerId?: string;
  /** How long to block waiting for messages (ms) */
  blockMs?: number;
  /** How many messages to process per read */
  batchSize?: number;
  /** Whether to run in shutdown mode */
  shutdown?: boolean;
};

/**
 * PersonaConsumer - Consumes persona requests from request stream
 * 
 * Works with both LocalTransport (in-process) and RedisTransport (distributed).
 * Each persona gets its own consumer group, allowing multiple machines to handle
 * the same persona concurrently.
 * 
 * Usage:
 *   const consumer = new PersonaConsumer(transport);
 *   await consumer.start({ personas: ['context', 'lead-engineer'] });
 */
export class PersonaConsumer {
  private transport: MessageTransport;
  private consumerId: string;
  private blockMs: number;
  private batchSize: number;
  private isShuttingDown: boolean = false;
  private personaLoops: Map<string, Promise<void>> = new Map();

  constructor(transport: MessageTransport) {
    this.transport = transport;
    this.consumerId = cfg.consumerId;
    this.blockMs = 5000; // 5 second blocking reads
    this.batchSize = 1;  // Process one message at a time for now
  }

  /**
   * Start consuming persona requests
   * Launches concurrent loops for each persona
   */
  async start(config: PersonaConsumerConfig): Promise<void> {
    const { personas, consumerId, blockMs, batchSize } = config;
    
    if (consumerId) this.consumerId = consumerId;
    if (blockMs !== undefined) this.blockMs = blockMs;
    if (batchSize !== undefined) this.batchSize = batchSize;

    if (personas.length === 0) {
      logger.warn('PersonaConsumer: No personas configured, nothing to do');
      return;
    }

    logger.info('PersonaConsumer: Starting', {
      personas: personas.join(', '),
      consumerId: this.consumerId,
      blockMs: this.blockMs,
      transportType: cfg.transportType
    });

    // Start a consumer loop for each persona concurrently
    for (const persona of personas) {
      const loopPromise = this.startPersonaLoop(persona);
      this.personaLoops.set(persona, loopPromise);
    }

    logger.info(`PersonaConsumer: Started ${personas.length} persona loops`);
  }

  /**
   * Stop all persona consumer loops gracefully
   */
  async stop(): Promise<void> {
    if (this.isShuttingDown) return;
    
    logger.info('PersonaConsumer: Shutting down...');
    this.isShuttingDown = true;

    // Wait for all persona loops to complete
    const loops = Array.from(this.personaLoops.values());
    await Promise.allSettled(loops);
    
    this.personaLoops.clear();
    logger.info('PersonaConsumer: Shutdown complete');
  }

  /**
   * Start consumer loop for a single persona
   * Runs until shutdown is triggered
   */
  private async startPersonaLoop(persona: string): Promise<void> {
    const group = `${cfg.groupPrefix}:${persona}`;
    
    logger.info(`PersonaConsumer: Starting loop for ${persona}`, {
      group,
      consumerId: this.consumerId,
      requestStream: cfg.requestStream
    });

    // Create consumer group for this persona
    try {
      await this.transport.xGroupCreate(cfg.requestStream, group, '0', { MKSTREAM: true });
      logger.info(`PersonaConsumer: Created consumer group ${group}`);
    } catch (error: any) {
      if (error.message?.includes('BUSYGROUP')) {
        logger.info(`PersonaConsumer: Consumer group ${group} already exists`);
      } else {
        logger.error(`PersonaConsumer: Failed to create consumer group ${group}`, { error: error.message });
        throw error;
      }
    }

    // Poll loop
    while (!this.isShuttingDown) {
      try {
        const result = await this.transport.xReadGroup(
          group,
          this.consumerId,
          { key: cfg.requestStream, id: '>' },
          { BLOCK: this.blockMs, COUNT: this.batchSize }
        );

        if (!result) {
          // Timeout or no messages - this is normal
          continue;
        }

        // Process messages for this persona
        const streamData = result[cfg.requestStream];
        if (!streamData || !streamData.messages || streamData.messages.length === 0) {
          continue;
        }

        for (const msg of streamData.messages) {
          if (this.isShuttingDown) break;
          
          try {
            await this.handlePersonaRequest(persona, group, msg.id, msg.fields);
          } catch (error: any) {
            logger.error(`PersonaConsumer: Error handling message ${msg.id}`, {
              persona,
              error: error.message,
              stack: error.stack
            });
            
            // Even if processing fails, acknowledge the message to prevent infinite retries
            // The error will be logged and can be investigated
            try {
              await this.transport.xAck(cfg.requestStream, group, msg.id);
            } catch (ackError: any) {
              logger.error(`PersonaConsumer: Failed to ack message after error`, {
                persona,
                messageId: msg.id,
                error: ackError.message
              });
            }
          }
        }
      } catch (error: any) {
        if (this.isShuttingDown) break;
        
        logger.error(`PersonaConsumer: Error in poll loop for ${persona}`, {
          error: error.message,
          stack: error.stack
        });
        
        // Brief delay before retrying to avoid tight error loops
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }

    logger.info(`PersonaConsumer: Stopped loop for ${persona}`);
  }

  /**
   * Handle a single persona request message
   * Executes the persona's LLM call and publishes result to event stream
   */
  private async handlePersonaRequest(
    persona: string,
    group: string,
    messageId: string,
    fields: Record<string, string>
  ): Promise<void> {
    const workflowId = fields.workflow_id || 'unknown';
    const step = fields.step || '';
    const corrId = fields.corr_id || '';
    const intent = fields.intent || '';

    logger.info('PersonaConsumer: Processing request', {
      persona,
      workflowId,
      step,
      corrId,
      intent,
      messageId
    });

    const started = Date.now();

    try {
      // Parse request payload
      let payload: any = {};
      try {
        payload = fields.payload ? JSON.parse(fields.payload) : {};
      } catch (parseError) {
        logger.warn('PersonaConsumer: Failed to parse payload as JSON', {
          persona,
          workflowId,
          payload: fields.payload?.substring(0, 200)
        });
      }

      // Execute the persona request
      const result = await this.executePersonaRequest({
        persona,
        workflowId,
        step,
        intent,
        payload,
        repo: fields.repo,
        branch: fields.branch,
        projectId: fields.project_id,
        taskId: fields.task_id
      });

      // Publish result to event stream
      await this.transport.xAdd(cfg.eventStream, '*', {
        workflow_id: workflowId,
        from_persona: persona,
        status: 'done',
        corr_id: corrId,
        step: step,
        result: JSON.stringify(result),
        duration_ms: String(Date.now() - started)
      });

      logger.info('PersonaConsumer: Published result', {
        persona,
        workflowId,
        corrId,
        durationMs: Date.now() - started
      });

      // Acknowledge the message
      await this.transport.xAck(cfg.requestStream, group, messageId);

    } catch (error: any) {
      const durationMs = Date.now() - started;
      
      logger.error('PersonaConsumer: Execution failed', {
        persona,
        workflowId,
        corrId,
        error: error.message,
        durationMs
      });

      // Publish error result to event stream
      await this.transport.xAdd(cfg.eventStream, '*', {
        workflow_id: workflowId,
        from_persona: persona,
        status: 'done',
        corr_id: corrId,
        step: step,
        result: JSON.stringify({
          status: 'fail',
          error: error.message,
          details: 'Persona execution failed - check logs for details'
        }),
        duration_ms: String(durationMs)
      });

      // Acknowledge the message even on error to prevent infinite retries
      await this.transport.xAck(cfg.requestStream, group, messageId);
    }
  }

  /**
   * Execute a persona request by calling LM Studio
   * This is where the actual AI work happens
   */
  private async executePersonaRequest(params: {
    persona: string;
    workflowId: string;
    step: string;
    intent: string;
    payload: any;
    repo?: string;
    branch?: string;
    projectId?: string;
    taskId?: string;
  }): Promise<any> {
    const { persona, workflowId, step, intent, payload, repo, branch, projectId, taskId } = params;

    // Get persona configuration
    const model = cfg.personaModels[persona];
    if (!model) {
      throw new Error(`No model configured for persona '${persona}'`);
    }

    // Get system prompt for this persona
    const systemPrompt = SYSTEM_PROMPTS[persona] || `You are the ${persona} persona.`;

    // Build user text from intent and payload
    let userText = intent || 'Process this request';
    if (payload.user_text) {
      userText = payload.user_text;
    } else if (payload.description) {
      userText = payload.description;
    }

    // Get scan summary if repo is provided
    let scanSummaryForPrompt: string | null = null;
    if (repo && cfg.injectDashboardContext) {
      try {
        // For now, we don't have the local repo path in the persona worker
        // This would need to be enhanced to clone/fetch repos in distributed mode
        // For local development, the repo is already cloned by the coordinator
        logger.debug('PersonaConsumer: Repo context requested but not yet implemented', {
          persona,
          repo,
          branch
        });
      } catch (error: any) {
        logger.warn('PersonaConsumer: Failed to get scan summary', {
          persona,
          repo,
          error: error.message
        });
      }
    }

    // Get dashboard context if project/task provided
    // TODO: Implement dashboard context fetching when needed
    let dashboardContext: string | null = null;

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

  /**
   * Wait for all persona loops to complete (useful for testing)
   */
  async waitForCompletion(): Promise<void> {
    const loops = Array.from(this.personaLoops.values());
    await Promise.allSettled(loops);
  }
}
