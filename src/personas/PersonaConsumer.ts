import { MessageTransport } from "../transport/index.js";
import { cfg } from "../config.js";
import { logger } from "../logger.js";
import { ContextExtractor } from "./context/ContextExtractor.js";
import { MessageFormatter } from "./messaging/MessageFormatter.js";
import { PersonaRequestExecutor } from "./execution/PersonaRequestExecutor.js";

export type PersonaConsumerConfig = {
  personas: string[];

  consumerId?: string;

  blockMs?: number;

  batchSize?: number;

  shutdown?: boolean;
};

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
    messageFormatter?: MessageFormatter,
  ) {
    this.transport = transport;
    this.consumerId = cfg.consumerId;
    this.blockMs = 5000;
    this.batchSize = 1;

    const contextExtractor = new ContextExtractor();
    this.requestExecutor =
      requestExecutor ||
      new PersonaRequestExecutor(transport, contextExtractor);
    this.messageFormatter = messageFormatter || new MessageFormatter();
  }

  async start(config: PersonaConsumerConfig): Promise<void> {
    const { personas, consumerId, blockMs, batchSize } = config;

    if (consumerId) this.consumerId = consumerId;
    if (blockMs !== undefined) this.blockMs = blockMs;
    if (batchSize !== undefined) this.batchSize = batchSize;

    if (personas.length === 0) {
      logger.warn("PersonaConsumer: No personas configured, nothing to do");
      return;
    }

    logger.info("PersonaConsumer: Starting", {
      personas: personas.join(", "),
      consumerId: this.consumerId,
      blockMs: this.blockMs,
      transportType: cfg.transportType,
    });

    for (const persona of personas) {
      const loopPromise = this.startPersonaLoop(persona);
      this.personaLoops.set(persona, loopPromise);
    }

    logger.info(`PersonaConsumer: Started ${personas.length} persona loops`);
  }

  async stop(): Promise<void> {
    if (this.isShuttingDown) return;

    logger.info("PersonaConsumer: Shutting down...");
    this.isShuttingDown = true;

    const loops = Array.from(this.personaLoops.values());
    await Promise.allSettled(loops);

    this.personaLoops.clear();
    logger.info("PersonaConsumer: Shutdown complete");
  }

  private async startPersonaLoop(persona: string): Promise<void> {
    const group = `${cfg.groupPrefix}:${persona}`;

    logger.info(`PersonaConsumer: Starting loop for ${persona}`, {
      group,
      consumerId: this.consumerId,
      requestStream: cfg.requestStream,
    });

    try {
      await this.transport.xGroupCreate(cfg.requestStream, group, "0", {
        MKSTREAM: true,
      });
      logger.info(`PersonaConsumer: Created consumer group ${group}`);
    } catch (error: any) {
      if (error.message?.includes("BUSYGROUP")) {
        logger.info(`PersonaConsumer: Consumer group ${group} already exists`);
      } else {
        logger.error(
          `PersonaConsumer: Failed to create consumer group ${group}`,
          { error: error.message },
        );
        throw error;
      }
    }

    while (!this.isShuttingDown) {
      try {
        const result = await this.transport.xReadGroup(
          group,
          this.consumerId,
          { key: cfg.requestStream, id: ">" },
          { BLOCK: this.blockMs, COUNT: this.batchSize },
        );

        if (!result) {
          continue;
        }

        const streamData = result[cfg.requestStream];
        if (
          !streamData ||
          !streamData.messages ||
          streamData.messages.length === 0
        ) {
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
              stack: error.stack,
            });

            try {
              await this.transport.xAck(cfg.requestStream, group, msg.id);
            } catch (ackError: any) {
              logger.error(
                `PersonaConsumer: Failed to ack message after error`,
                {
                  persona,
                  messageId: msg.id,
                  error: ackError.message,
                },
              );
            }
          }
        }
      } catch (error: any) {
        if (this.isShuttingDown) break;

        logger.error(`PersonaConsumer: Error in poll loop for ${persona}`, {
          error: error.message,
          stack: error.stack,
        });

        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }

    logger.info(`PersonaConsumer: Stopped loop for ${persona}`);
  }

  private async handlePersonaRequest(
    persona: string,
    group: string,
    messageId: string,
    fields: Record<string, string>,
  ): Promise<void> {
    const workflowId = fields.workflow_id || "unknown";
    const step = fields.step || "";
    const corrId = fields.corr_id || "";
    const intent = fields.intent || "";
    const toPersona = fields.to_persona || "";

    if (toPersona && toPersona !== persona) {
      logger.debug("PersonaConsumer: Skipping message for different persona", {
        thisPersona: persona,
        targetPersona: toPersona,
        workflowId,
        messageId,
      });

      await this.transport.xAck(cfg.requestStream, group, messageId);
      return;
    }

    logger.info("PersonaConsumer: Processing request", {
      persona,
      workflowId,
      step,
      corrId,
      intent,
      messageId,
    });

    const started = Date.now();

    try {
      let payload: any = {};
      try {
        payload = fields.payload ? JSON.parse(fields.payload) : {};
      } catch (parseError) {
        logger.warn("PersonaConsumer: Failed to parse payload as JSON", {
          persona,
          workflowId,
          payload: fields.payload?.substring(0, 200),
        });
      }

      const result = await this.executePersonaRequest({
        persona,
        workflowId,
        step,
        intent,
        payload,
        repo: fields.repo,
        branch: fields.branch,
        projectId: fields.project_id,
        taskId: fields.task_id,
      });

      const durationMs = Date.now() - started;
      const message = this.messageFormatter.formatSuccessResponse({
        workflowId,
        persona,
        corrId,
        step,
        result,
        durationMs,
      });

      await this.transport.xAdd(cfg.eventStream, "*", message);

      logger.info("PersonaConsumer: Published result", {
        persona,
        workflowId,
        corrId,
        durationMs,
      });

      await this.transport.xAck(cfg.requestStream, group, messageId);
    } catch (error: any) {
      const durationMs = Date.now() - started;

      logger.error("PersonaConsumer: Execution failed", {
        persona,
        workflowId,
        corrId,
        error: error.message,
        durationMs,
      });

      const errorMessage = this.messageFormatter.formatErrorResponse({
        workflowId,
        persona,
        corrId,
        step,
        error,
        durationMs,
      });

      await this.transport.xAdd(cfg.eventStream, "*", errorMessage);

      await this.transport.xAck(cfg.requestStream, group, messageId);
    }
  }

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

  async waitForCompletion(): Promise<void> {
    const loops = Array.from(this.personaLoops.values());
    await Promise.allSettled(loops);
  }
}
