import { describe, it, expect, beforeEach, vi } from 'vitest';
import { PersonaConsumer } from '../src/personas/PersonaConsumer.js';
import { LocalTransport } from '../src/transport/LocalTransport.js';
import { cfg } from '../src/config.js';

/**
 * Tests that PersonaConsumer correctly extracts task context from payload
 * to provide meaningful prompts to LLMs instead of just generic intents.
 * 
 * CRITICAL: Without proper task context extraction, personas receive generic
 * prompts like "planning" instead of actual task requirements, causing them
 * to generate irrelevant responses.
 */
describe('PersonaConsumer task context extraction', () => {
  let transport: LocalTransport;
  let consumer: PersonaConsumer;

  beforeEach(async () => {
    transport = new LocalTransport();
    consumer = new PersonaConsumer(transport);
  });

  it('should extract task description as userText when payload contains task object', async () => {
    let capturedUserText: string | undefined;
    
    // Mock buildPersonaMessages to capture the userText
    const buildMessagesModule = await import('../src/personas/PersonaRequestHandler.js');
    const originalBuildMessages = buildMessagesModule.buildPersonaMessages;
    vi.spyOn(buildMessagesModule, 'buildPersonaMessages').mockImplementation((input: any) => {
      capturedUserText = input.userText;
      return originalBuildMessages(input);
    });

    // Mock callPersonaModel to avoid actual LLM calls
    vi.spyOn(buildMessagesModule, 'callPersonaModel').mockResolvedValue({
      content: '{"plan": [{"goal": "test"}]}',
      duration_ms: 100
    });

    // Start consumer
    await consumer.start({
      personas: ['implementation-planner'],
      blockMs: 100,
      batchSize: 1
    });

    await new Promise(resolve => setTimeout(resolve, 5));

    // Send request with task object in payload
    await transport.xAdd(cfg.requestStream, '*', {
      workflow_id: 'wf-test',
      to_persona: 'implementation-planner',
      step: '2-plan',
      intent: 'planning',
      corr_id: 'test-corr',
      payload: JSON.stringify({
        task: {
          id: 1,
          title: 'Config loader and schema validation',
          description: 'Implement hierarchical config (env, file, CLI) with JSON schema validation',
          type: 'feature',
          scope: 'medium'
        },
        context: { repo: 'test-repo' }
      })
    });

    // Wait for processing
    await new Promise(resolve => setTimeout(resolve, 1));
    await consumer.stop();

    // Verify userText was extracted from task
    expect(capturedUserText).toBeDefined();
    expect(capturedUserText).toContain('Config loader and schema validation');
    expect(capturedUserText).toContain('Implement hierarchical config');
    expect(capturedUserText).toContain('Type: feature');
    expect(capturedUserText).toContain('Scope: medium');
    
    // Should NOT just be the generic intent
    expect(capturedUserText).not.toBe('planning');
  });

  it('should use payload.user_text if provided (highest priority)', async () => {
    let capturedUserText: string | undefined;
    
    const buildMessagesModule = await import('../src/personas/PersonaRequestHandler.js');
    const originalBuildMessages = buildMessagesModule.buildPersonaMessages;
    vi.spyOn(buildMessagesModule, 'buildPersonaMessages').mockImplementation((input: any) => {
      capturedUserText = input.userText;
      return originalBuildMessages(input);
    });

    vi.spyOn(buildMessagesModule, 'callPersonaModel').mockResolvedValue({
      content: 'test response',
      duration_ms: 100
    });

    await consumer.start({
      personas: ['context'],
      blockMs: 100,
      batchSize: 1
    });

    await new Promise(resolve => setTimeout(resolve, 5));

    await transport.xAdd(cfg.requestStream, '*', {
      workflow_id: 'wf-test-2',
      to_persona: 'context',
      step: '1-context',
      intent: 'context_gathering',
      corr_id: 'test-corr-2',
      payload: JSON.stringify({
        user_text: 'Custom explicit instruction for this persona',
        task: {
          title: 'Some task',
          description: 'This should be ignored'
        }
      })
    });

    await new Promise(resolve => setTimeout(resolve, 1));
    await consumer.stop();

    // user_text should take priority over task.description
    expect(capturedUserText).toBe('Custom explicit instruction for this persona');
    expect(capturedUserText).not.toContain('This should be ignored');
  });

  it('should fall back to payload.description if no task object', async () => {
    let capturedUserText: string | undefined;
    
    const buildMessagesModule = await import('../src/personas/PersonaRequestHandler.js');
    const originalBuildMessages = buildMessagesModule.buildPersonaMessages;
    vi.spyOn(buildMessagesModule, 'buildPersonaMessages').mockImplementation((input: any) => {
      capturedUserText = input.userText;
      return originalBuildMessages(input);
    });

    vi.spyOn(buildMessagesModule, 'callPersonaModel').mockResolvedValue({
      content: 'test response',
      duration_ms: 100
    });

    await consumer.start({
      personas: ['context'],
      blockMs: 100,
      batchSize: 1
    });

    await new Promise(resolve => setTimeout(resolve, 5));

    await transport.xAdd(cfg.requestStream, '*', {
      workflow_id: 'wf-test-3',
      to_persona: 'context',
      step: '1-context',
      intent: 'context_gathering',
      corr_id: 'test-corr-3',
      payload: JSON.stringify({
        description: 'Analyze the repository structure',
        some_other_field: 'value'
      })
    });

    await new Promise(resolve => setTimeout(resolve, 1));
    await consumer.stop();

    expect(capturedUserText).toBe('Analyze the repository structure');
  });

  it('should use task.title if task.description is missing', async () => {
    let capturedUserText: string | undefined;
    
    const buildMessagesModule = await import('../src/personas/PersonaRequestHandler.js');
    const originalBuildMessages = buildMessagesModule.buildPersonaMessages;
    vi.spyOn(buildMessagesModule, 'buildPersonaMessages').mockImplementation((input: any) => {
      capturedUserText = input.userText;
      return originalBuildMessages(input);
    });

    vi.spyOn(buildMessagesModule, 'callPersonaModel').mockResolvedValue({
      content: 'test response',
      duration_ms: 100
    });

    await consumer.start({
      personas: ['implementation-planner'],
      blockMs: 100,
      batchSize: 1
    });

    await new Promise(resolve => setTimeout(resolve, 5));

    await transport.xAdd(cfg.requestStream, '*', {
      workflow_id: 'wf-test-4',
      to_persona: 'implementation-planner',
      step: '2-plan',
      intent: 'planning',
      corr_id: 'test-corr-4',
      payload: JSON.stringify({
        task: {
          id: 5,
          title: 'Implement logging system'
          // description missing
        }
      })
    });

    await new Promise(resolve => setTimeout(resolve, 1));
    await consumer.stop();

    expect(capturedUserText).toBe('Task: Implement logging system');
  });

  it('should fall back to intent if no other context available', async () => {
    let capturedUserText: string | undefined;
    
    const buildMessagesModule = await import('../src/personas/PersonaRequestHandler.js');
    const originalBuildMessages = buildMessagesModule.buildPersonaMessages;
    vi.spyOn(buildMessagesModule, 'buildPersonaMessages').mockImplementation((input: any) => {
      capturedUserText = input.userText;
      return originalBuildMessages(input);
    });

    vi.spyOn(buildMessagesModule, 'callPersonaModel').mockResolvedValue({
      content: 'test response',
      duration_ms: 100
    });

    await consumer.start({
      personas: ['context'],
      blockMs: 100,
      batchSize: 1
    });

    await new Promise(resolve => setTimeout(resolve, 5));

    // Minimal payload - only intent available
    await transport.xAdd(cfg.requestStream, '*', {
      workflow_id: 'wf-test-5',
      to_persona: 'context',
      step: '1-context',
      intent: 'context_gathering',
      corr_id: 'test-corr-5',
      payload: JSON.stringify({})
    });

    await new Promise(resolve => setTimeout(resolve, 1));
    await consumer.stop();

    // Should fall back to intent
    expect(capturedUserText).toBe('context_gathering');
  });

  it('should prevent bug where personas get generic prompts instead of task requirements', async () => {
    // This test documents the original bug scenario
    let capturedUserText: string | undefined;
    
    const buildMessagesModule = await import('../src/personas/PersonaRequestHandler.js');
    const originalBuildMessages = buildMessagesModule.buildPersonaMessages;
    vi.spyOn(buildMessagesModule, 'buildPersonaMessages').mockImplementation((input: any) => {
      capturedUserText = input.userText;
      return originalBuildMessages(input);
    });

    vi.spyOn(buildMessagesModule, 'callPersonaModel').mockResolvedValue({
      content: 'test',
      duration_ms: 1
    });

    await consumer.start({
      personas: ['implementation-planner'],
      blockMs: 100,
      batchSize: 1
    });

    await new Promise(resolve => setTimeout(resolve, 5));

    // Realistic payload from PlanningLoopStep
    await transport.xAdd(cfg.requestStream, '*', {
      workflow_id: 'wf-real-scenario',
      to_persona: 'implementation-planner',
      step: '2-plan',
      intent: 'planning', // This was being used as userText before the fix!
      corr_id: 'real-corr',
      payload: JSON.stringify({
        task: {
          id: 1,
          title: 'Log file summarization',
          description: 'Build a system to parse and summarize application log files',
          type: 'feature',
          scope: 'large'
        },
        iteration: 1,
        repo: 'https://github.com/example/log-summarizer.git',
        branch: 'main'
      })
    });

    await new Promise(resolve => setTimeout(resolve, 1));
    await consumer.stop();

    // BEFORE FIX: userText would be just "planning" (the intent)
    // AFTER FIX: userText contains actual task requirements
    expect(capturedUserText).not.toBe('planning');
    expect(capturedUserText).toContain('Log file summarization');
    expect(capturedUserText).toContain('parse and summarize application log files');
  });
});
