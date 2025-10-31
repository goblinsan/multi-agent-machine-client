import { describe, it, expect, beforeEach } from 'vitest';
import { MessageFormatter } from '../../src/personas/messaging/MessageFormatter.js';

describe('MessageFormatter', () => {
  let formatter: MessageFormatter;

  beforeEach(() => {
    formatter = new MessageFormatter();
  });

  describe('formatSuccessResponse', () => {
    it('should format successful response with all fields', () => {
      const message = formatter.formatSuccessResponse({
        workflowId: 'wf-123',
        persona: 'implementation-planner',
        corrId: 'corr-456',
        step: '2-plan',
        result: { plan: ['step1', 'step2'] },
        durationMs: 1500
      });

      expect(message).toEqual({
        workflow_id: 'wf-123',
        from_persona: 'implementation-planner',
        status: 'done',
        corr_id: 'corr-456',
        step: '2-plan',
        result: JSON.stringify({ plan: ['step1', 'step2'] }),
        duration_ms: '1500'
      });
    });

    it('should handle complex result objects', () => {
      const complexResult = {
        output: 'Some output',
        artifacts: ['file1.ts', 'file2.ts'],
        metadata: { version: '1.0' }
      };

      const message = formatter.formatSuccessResponse({
        workflowId: 'wf-999',
        persona: 'lead-engineer',
        corrId: 'corr-999',
        step: '3-implement',
        result: complexResult,
        durationMs: 3000
      });

      expect(message.result).toBe(JSON.stringify(complexResult));
      expect(message.duration_ms).toBe('3000');
    });
  });

  describe('formatErrorResponse', () => {
    it('should format error response with Error object', () => {
      const error = new Error('Model timeout');

      const message = formatter.formatErrorResponse({
        workflowId: 'wf-error',
        persona: 'context',
        corrId: 'corr-error',
        step: '1-context',
        error,
        durationMs: 5000
      });

      expect(message).toEqual({
        workflow_id: 'wf-error',
        from_persona: 'context',
        status: 'done',
        corr_id: 'corr-error',
        step: '1-context',
        result: JSON.stringify({
          status: 'fail',
          error: 'Model timeout',
          details: 'Persona execution failed - check logs for details'
        }),
        duration_ms: '5000'
      });
    });

    it('should format error response with string error', () => {
      const message = formatter.formatErrorResponse({
        workflowId: 'wf-str-err',
        persona: 'tester-qa',
        corrId: 'corr-str',
        step: '5-qa',
        error: 'String error message',
        durationMs: 2000
      });

      const parsedResult = JSON.parse(message.result);
      expect(parsedResult.status).toBe('fail');
      expect(parsedResult.error).toBe('String error message');
      expect(parsedResult.details).toBe('Persona execution failed - check logs for details');
    });

    it('should handle non-Error object errors', () => {
      const message = formatter.formatErrorResponse({
        workflowId: 'wf-obj-err',
        persona: 'code-reviewer',
        corrId: 'corr-obj',
        step: '4-review',
        error: { message: 'Custom error' } as any,
        durationMs: 1000
      });

      const parsedResult = JSON.parse(message.result);
      expect(parsedResult.error).toBe('[object Object]');
    });
  });

  describe('message structure', () => {
    it('should always include required fields in success response', () => {
      const message = formatter.formatSuccessResponse({
        workflowId: 'wf-1',
        persona: 'test',
        corrId: 'corr-1',
        step: 'test-step',
        result: {},
        durationMs: 100
      });

      expect(message).toHaveProperty('workflow_id');
      expect(message).toHaveProperty('from_persona');
      expect(message).toHaveProperty('status');
      expect(message).toHaveProperty('corr_id');
      expect(message).toHaveProperty('step');
      expect(message).toHaveProperty('result');
      expect(message).toHaveProperty('duration_ms');
    });

    it('should always include required fields in error response', () => {
      const message = formatter.formatErrorResponse({
        workflowId: 'wf-1',
        persona: 'test',
        corrId: 'corr-1',
        step: 'test-step',
        error: 'Test error',
        durationMs: 100
      });

      expect(message).toHaveProperty('workflow_id');
      expect(message).toHaveProperty('from_persona');
      expect(message).toHaveProperty('status');
      expect(message).toHaveProperty('corr_id');
      expect(message).toHaveProperty('step');
      expect(message).toHaveProperty('result');
      expect(message).toHaveProperty('duration_ms');
    });

    it('should always set status to "done" for both success and error', () => {
      const successMsg = formatter.formatSuccessResponse({
        workflowId: 'wf-1',
        persona: 'test',
        corrId: 'corr-1',
        step: 'step',
        result: {},
        durationMs: 100
      });

      const errorMsg = formatter.formatErrorResponse({
        workflowId: 'wf-1',
        persona: 'test',
        corrId: 'corr-1',
        step: 'step',
        error: 'error',
        durationMs: 100
      });

      expect(successMsg.status).toBe('done');
      expect(errorMsg.status).toBe('done');
    });
  });
});
