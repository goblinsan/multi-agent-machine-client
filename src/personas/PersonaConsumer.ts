import { MessageTransport } from '../transport/index.js';
import { cfg } from '../config.js';
import { logger } from '../logger.js';
import { ContextExtractor } from './context/ContextExtractor.js';
import { MessageFormatter } from './messaging/MessageFormatter.js';
import { PersonaRequestExecutor } from './execution/PersonaRequestExecutor.js';

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
  private requestExecutor: PersonaRequestExecutor;
  private messageFormatter: MessageFormatter;

  constructor(
    transport: MessageTransport,
    requestExecutor?: PersonaRequestExecutor,
    messageFormatter?: MessageFormatter
  ) {
    this.transport = transport;
    this.consumerId = cfg.consumerId;
    this.blockMs = 5000; // 5 second blocking reads
    this.batchSize = 1;  // Process one message at a time for now
    
    // Initialize dependencies
    const contextExtractor = new ContextExtractor();
    this.requestExecutor = requestExecutor || new PersonaRequestExecutor(transport, contextExtractor);
    this.messageFormatter = messageFormatter || new MessageFormatter();
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
    const toPersona = fields.to_persona || '';

    // CRITICAL: Only process messages addressed to this persona
    // Skip messages meant for other personas (they have their own consumer groups)
    if (toPersona && toPersona !== persona) {
      logger.debug('PersonaConsumer: Skipping message for different persona', {
        thisPersona: persona,
        targetPersona: toPersona,
        workflowId,
        messageId
      });
      
      // Acknowledge the message so it doesn't block this consumer's queue
      // The correct persona will process it from their own consumer group
      await this.transport.xAck(cfg.requestStream, group, messageId);
      return;
    }

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
      const durationMs = Date.now() - started;
      const message = this.messageFormatter.formatSuccessResponse({
        workflowId,
        persona,
        corrId,
        step,
        result,
        durationMs
      });
      
      await this.transport.xAdd(cfg.eventStream, '*', message);

      logger.info('PersonaConsumer: Published result', {
        persona,
        workflowId,
        corrId,
        durationMs
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
      const errorMessage = this.messageFormatter.formatErrorResponse({
        workflowId,
        persona,
        corrId,
        step,
        error,
        durationMs
      });
      
      await this.transport.xAdd(cfg.eventStream, '*', errorMessage);

      // Acknowledge the message even on error to prevent infinite retries
      await this.transport.xAck(cfg.requestStream, group, messageId);
    }
  }

  /**
   * Execute a persona request - delegates to PersonaRequestExecutor
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
    return await this.requestExecutor.execute(params);
  }

  /**
   * Wait for all persona loops to complete (useful for testing)
   */
  async waitForCompletion(): Promise<void> {
    const loops = Array.from(this.personaLoops.values());
    await Promise.allSettled(loops);
  }
}
