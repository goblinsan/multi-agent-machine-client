import { WorkflowStep, StepResult, ValidationResult, WorkflowStepConfig } from '../engine/WorkflowStep.js';
import { WorkflowContext } from '../engine/WorkflowContext.js';
import { logger } from '../../logger.js';
import { makeRedis } from '../../redisClient.js';

export interface PullTaskConfig {
  streamName: string;
  consumerGroup: string;
  consumerId: string;
  blockTime?: number;
  maxMessages?: number;
}

export interface TaskData {
  id: string;
  type: string;
  persona: string;
  data: any;
  timestamp: number;
}

/**
 * PullTaskStep - Retrieves tasks from Redis stream
 * 
 * Configuration:
 * - streamName: Redis stream to pull from
 * - consumerGroup: Consumer group name
 * - consumerId: Unique consumer identifier
 * - blockTime: Max time to block waiting for messages (default: 1000ms)
 * - maxMessages: Maximum messages to pull at once (default: 1)
 * 
 * Outputs:
 * - task: The pulled task data
 * - taskId: The Redis message ID
 */
export class PullTaskStep extends WorkflowStep {
  async execute(context: WorkflowContext): Promise<StepResult> {
    const config = this.config.config as PullTaskConfig;
    const { streamName, consumerGroup, consumerId, blockTime = 1000, maxMessages = 1 } = config;

    logger.info(`Pulling task from stream: ${streamName}`, {
      consumerGroup,
      consumerId,
      blockTime,
      maxMessages
    });

    let localClientCreated = false;
    let transport: any;
    try {
      transport = (context as any).transport;
      if (!transport || typeof transport.xGroupCreate !== 'function') {
        // Fall back to creating a local Redis client when no transport is provided (test/mocked environments)
        transport = await makeRedis();
        localClientCreated = true;
      }
      
      // Ensure consumer group exists
      try {
        await transport.xGroupCreate(streamName, consumerGroup, '0', { MKSTREAM: true });
      } catch (error: any) {
        // Ignore if group already exists
        if (!error.message?.includes('BUSYGROUP')) {
          throw error;
        }
      }

      // Pull messages from stream
      const messages = await transport.xReadGroup(
        consumerGroup, 
        consumerId,
        { key: streamName, id: '>' },
        { COUNT: maxMessages, BLOCK: blockTime }
      );

      if (!messages || messages.length === 0) {
        logger.info('No messages available in stream');
        context.setVariable('task', null);
        context.setVariable('taskId', null);
        // Disconnect local client if we created one
        if (localClientCreated && transport?.disconnect) {
          await transport.disconnect();
        }
        return {
          status: 'success',
          data: { task: null, taskId: null },
          outputs: { task: null, taskId: null }
        };
      }

      const streamData = messages[0];
      const messageList = streamData.messages;

      if (!messageList || messageList.length === 0) {
        logger.info('No messages in stream data');
        context.setVariable('task', null);
        context.setVariable('taskId', null);
        // Disconnect local client if we created one
        if (localClientCreated && transport?.disconnect) {
          await transport.disconnect();
        }
        return {
          status: 'success',
          data: { task: null, taskId: null },
          outputs: { task: null, taskId: null }
        };
      }

      // Parse the first message
      const firstMessage = messageList[0];
      const messageId = firstMessage.id;
      const fields = firstMessage.message;
      
      const taskData: TaskData = {
        id: messageId,
        type: fields.type || 'unknown',
        persona: fields.persona || 'default',
        data: JSON.parse(fields.data || '{}'),
        timestamp: Date.now()
      };

      logger.info(`Successfully pulled task: ${messageId}`, {
        type: taskData.type,
        persona: taskData.persona
      });

      // Set context variables
      context.setVariable('task', taskData);
      context.setVariable('taskId', messageId);

      // Acknowledge the message
      await transport.xAck(streamName, consumerGroup, messageId);
      // Disconnect local client if we created one
      if (localClientCreated && transport?.disconnect) {
        await transport.disconnect();
      }

      return {
        status: 'success',
        data: { task: taskData, taskId: messageId },
        outputs: { task: taskData, taskId: messageId }
      };

    } catch (error: any) {
      logger.error('Failed to pull task from stream', {
        error: error.message,
        streamName,
        consumerGroup,
        consumerId
      });
      // Ensure local client is closed on error
      try {
        if (localClientCreated && transport?.disconnect) {
          await transport.disconnect();
        }
      } catch {}
      return {
        status: 'failure',
        error: new Error(`Failed to pull task: ${error.message}`)
      };
    }
  }

  protected async validateConfig(context: WorkflowContext): Promise<ValidationResult> {
    const config = this.config.config as any;
    const errors: string[] = [];

    if (!config.streamName || typeof config.streamName !== 'string') {
      errors.push('PullTaskStep: streamName is required and must be a string');
    }
    if (!config.consumerGroup || typeof config.consumerGroup !== 'string') {
      errors.push('PullTaskStep: consumerGroup is required and must be a string');
    }
    if (!config.consumerId || typeof config.consumerId !== 'string') {
      errors.push('PullTaskStep: consumerId is required and must be a string');
    }
    if (config.blockTime !== undefined && (typeof config.blockTime !== 'number' || config.blockTime < 0)) {
      errors.push('PullTaskStep: blockTime must be a non-negative number');
    }
    if (config.maxMessages !== undefined && (typeof config.maxMessages !== 'number' || config.maxMessages < 1)) {
      errors.push('PullTaskStep: maxMessages must be a positive number');
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings: []
    };
  }

  async cleanup(context: WorkflowContext): Promise<void> {
    // Clean up any pending messages if needed
    const taskId = context.getVariable('taskId');
    if (taskId) {
      logger.debug(`Cleaning up task: ${taskId}`);
    }
  }
}