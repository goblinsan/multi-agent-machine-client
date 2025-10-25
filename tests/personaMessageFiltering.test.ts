import { describe, it, expect, beforeEach, vi } from 'vitest';
import { PersonaConsumer } from '../src/personas/PersonaConsumer.js';
import { LocalTransport } from '../src/transport/LocalTransport.js';
import { cfg } from '../src/config.js';

/**
 * Tests that PersonaConsumer correctly filters messages by to_persona field
 * to prevent race conditions where all personas process all messages.
 * 
 * CRITICAL: Without this filtering, all personas would process every request
 * from the shared request stream, causing:
 * - Wrong personas responding to requests
 * - Race conditions breaking workflow step sequencing
 * - Multiple concurrent responses to same request
 */
describe('PersonaConsumer message filtering', () => {
  let transport: LocalTransport;
  let consumer: PersonaConsumer;

  beforeEach(async () => {
    transport = new LocalTransport();
    consumer = new PersonaConsumer(transport);
  });

  it('should only process messages addressed to the correct persona', async () => {
    // Track which personas actually processed requests
    const processedRequests: Array<{ persona: string; toPersona: string; messageId: string }> = [];

    // Mock the persona execution to track processing
    const originalExecute = (consumer as any).executePersonaRequest;
    vi.spyOn(consumer as any, 'executePersonaRequest').mockImplementation(async (opts: any) => {
      processedRequests.push({
        persona: opts.persona,
        toPersona: opts.payload.to_persona || 'unknown',
        messageId: opts.workflowId
      });
      return {
        status: 'pass',
        result: 'test result'
      };
    });

    // Start consumers for multiple personas
    const startPromise = consumer.start({
      personas: ['context', 'plan-evaluator', 'implementation-planner'],
      blockMs: 100, // Short timeout for test
      batchSize: 10
    });

    // Give consumers time to set up
    await new Promise(resolve => setTimeout(resolve, 50));

    // Send messages to different personas
    await transport.xAdd(cfg.requestStream, '*', {
      workflow_id: 'wf-1',
      to_persona: 'context',
      step: '1-context',
      intent: 'context_gathering',
      corr_id: 'corr-1',
      payload: JSON.stringify({ task: 'test' })
    });

    await transport.xAdd(cfg.requestStream, '*', {
      workflow_id: 'wf-2',
      to_persona: 'plan-evaluator',
      step: '2-evaluate',
      intent: 'plan_evaluation',
      corr_id: 'corr-2',
      payload: JSON.stringify({ plan: 'test plan' })
    });

    await transport.xAdd(cfg.requestStream, '*', {
      workflow_id: 'wf-3',
      to_persona: 'implementation-planner',
      step: '2-plan',
      intent: 'planning',
      corr_id: 'corr-3',
      payload: JSON.stringify({ task: 'test' })
    });

    // Give consumers time to process messages
    await new Promise(resolve => setTimeout(resolve, 500));

    // Stop consumers
    await consumer.stop();

    // Verify each persona only processed its own message
    expect(processedRequests.length).toBe(3);

    const contextRequests = processedRequests.filter(r => r.persona === 'context');
    expect(contextRequests.length).toBe(1);
    expect(contextRequests[0].messageId).toBe('wf-1');

    const planEvalRequests = processedRequests.filter(r => r.persona === 'plan-evaluator');
    expect(planEvalRequests.length).toBe(1);
    expect(planEvalRequests[0].messageId).toBe('wf-2');

    const plannerRequests = processedRequests.filter(r => r.persona === 'implementation-planner');
    expect(plannerRequests.length).toBe(1);
    expect(plannerRequests[0].messageId).toBe('wf-3');
  });

  it('should acknowledge but not process messages for other personas', async () => {
    const ackedMessages: string[] = [];
    
    // Mock xAck to track acknowledgments
    const originalXAck = transport.xAck.bind(transport);
    vi.spyOn(transport, 'xAck').mockImplementation(async (stream, group, messageId) => {
      ackedMessages.push(messageId);
      return originalXAck(stream, group, messageId);
    });

    // Track execution
    const executedPersonas: string[] = [];
    vi.spyOn(consumer as any, 'executePersonaRequest').mockImplementation(async (opts: any) => {
      executedPersonas.push(opts.persona);
      return { status: 'pass', result: 'test' };
    });

    // Start only context consumer
    await consumer.start({
      personas: ['context'],
      blockMs: 100,
      batchSize: 10
    });

    await new Promise(resolve => setTimeout(resolve, 50));

    // Send message for context (should process)
    const contextMsgId = await transport.xAdd(cfg.requestStream, '*', {
      workflow_id: 'wf-context',
      to_persona: 'context',
      step: '1-context',
      intent: 'context_gathering',
      corr_id: 'corr-ctx',
      payload: JSON.stringify({})
    });

    // Send message for different persona (should ack but not process)
    const plannerMsgId = await transport.xAdd(cfg.requestStream, '*', {
      workflow_id: 'wf-planner',
      to_persona: 'implementation-planner',
      step: '2-plan',
      intent: 'planning',
      corr_id: 'corr-plan',
      payload: JSON.stringify({})
    });

    await new Promise(resolve => setTimeout(resolve, 500));
    await consumer.stop();

    // Context message should be acked and executed
    expect(ackedMessages).toContain(contextMsgId);
    expect(executedPersonas).toContain('context');

    // Planner message should be acked but NOT executed by context consumer
    expect(ackedMessages).toContain(plannerMsgId);
    expect(executedPersonas).not.toContain('implementation-planner');
    expect(executedPersonas.length).toBe(1); // Only context executed
  });

  it('should prevent race condition where all personas process coordinator messages', async () => {
    const processLog: Array<{ persona: string; workflowId: string; toPersona: string }> = [];

    vi.spyOn(consumer as any, 'executePersonaRequest').mockImplementation(async (opts: any) => {
      processLog.push({
        persona: opts.persona,
        workflowId: opts.workflowId,
        toPersona: opts.payload.to_persona || 'unknown'
      });
      return { status: 'pass', result: 'test' };
    });

    // Start all 11 personas (like run_local does)
    await consumer.start({
      personas: [
        'context',
        'plan-evaluator', 
        'implementation-planner',
        'lead-engineer',
        'code-reviewer',
        'security-review',
        'tester-qa',
        'coordination',
        'project-manager',
        'architect',
        'summarization'
      ],
      blockMs: 100,
      batchSize: 10
    });

    await new Promise(resolve => setTimeout(resolve, 50));

    // Simulate coordinator sending request to context persona
    // (This is what caused the race condition bug)
    await transport.xAdd(cfg.requestStream, '*', {
      workflow_id: 'wf_coord_test',
      to_persona: 'context',
      step: '1-context',
      intent: 'context_gathering',
      corr_id: 'coord-corr-1',
      from: 'coordination',
      payload: JSON.stringify({ task: 'milestone setup' })
    });

    await new Promise(resolve => setTimeout(resolve, 500));
    await consumer.stop();

    // CRITICAL: Only context persona should have processed this
    // Bug was: all 11 personas processed it
    const contextProcessed = processLog.filter(p => p.persona === 'context');
    expect(contextProcessed.length).toBe(1);
    expect(contextProcessed[0].workflowId).toBe('wf_coord_test');

    // No other personas should have executed this request
    const otherPersonas = processLog.filter(p => p.persona !== 'context');
    expect(otherPersonas.length).toBe(0);

    // Total should be exactly 1 execution
    expect(processLog.length).toBe(1);
  });

  it('should handle messages with missing to_persona field gracefully', async () => {
    const executedWorkflows: string[] = [];

    vi.spyOn(consumer as any, 'executePersonaRequest').mockImplementation(async (opts: any) => {
      executedWorkflows.push(opts.workflowId);
      return { status: 'pass', result: 'test' };
    });

    await consumer.start({
      personas: ['context'],
      blockMs: 100,
      batchSize: 10
    });

    await new Promise(resolve => setTimeout(resolve, 50));

    // Send message without to_persona field (edge case)
    await transport.xAdd(cfg.requestStream, '*', {
      workflow_id: 'wf-no-target',
      step: '1-context',
      intent: 'context_gathering',
      corr_id: 'corr-no-target',
      payload: JSON.stringify({})
      // to_persona field missing
    });

    await new Promise(resolve => setTimeout(resolve, 500));
    await consumer.stop();

    // Without to_persona, message should still be processed
    // (backwards compatibility / fail-open behavior)
    expect(executedWorkflows).toContain('wf-no-target');
  });
});
