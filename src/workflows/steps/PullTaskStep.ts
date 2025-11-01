import { WorkflowStep, StepResult, ValidationResult } from '../engine/WorkflowStep.js';
import { WorkflowContext } from '../engine/WorkflowContext.js';
import { logger } from '../../logger.js';

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

    try {
      const transport = context.transport;
      if (!transport) {
        throw new Error('Transport not available in context');
      }
      
      
      try {
        await transport.xGroupCreate(streamName, consumerGroup, '0', { MKSTREAM: true });
      } catch (error: any) {
        
        if (!error.message?.includes('BUSYGROUP')) {
          throw error;
        }
      }

      
      const result = await transport.xReadGroup(
        consumerGroup, 
        consumerId,
        { key: streamName, id: '>' },
        { COUNT: maxMessages, BLOCK: blockTime }
      );

      if (!result) {
        logger.info('No messages available in stream');
        context.setVariable('task', null);
        context.setVariable('taskId', null);
        return {
          status: 'success',
          data: { task: null, taskId: null },
          outputs: { task: null, taskId: null }
        };
      }

      const streamData = result[streamName];
      const messageList = streamData?.messages;

      if (!messageList || messageList.length === 0) {
        logger.info('No messages in stream data');
        context.setVariable('task', null);
        context.setVariable('taskId', null);
        return {
          status: 'success',
          data: { task: null, taskId: null },
          outputs: { task: null, taskId: null }
        };
      }

      
      const firstMessage = messageList[0];
      const messageId = firstMessage.id;
      const fields = firstMessage.fields;
      
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

      
      context.setVariable('task', taskData);
      context.setVariable('taskId', messageId);

      
      await transport.xAck(streamName, consumerGroup, messageId);

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
      return {
        status: 'failure',
        error: new Error(`Failed to pull task: ${error.message}`)
      };
    }
  }

  protected async validateConfig(_context: WorkflowContext): Promise<ValidationResult> {
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
    
    const taskId = context.getVariable('taskId');
    if (taskId) {
      logger.debug(`Cleaning up task: ${taskId}`);
    }
  }
}