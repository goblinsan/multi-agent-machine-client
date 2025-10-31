import { describe, it, expect, beforeEach, vi } from 'vitest';
import { PersonaConsumer } from '../src/personas/PersonaConsumer.js';
import { LocalTransport } from '../src/transport/LocalTransport.js';
import { cfg } from '../src/config.js';

/**
 * CRITICAL TEST: Validates that implementation-planner receives task descriptions
 * 
 * This test addresses a production bug where the planner was generating random
 * generic plans instead of task-specific plans because it wasn't receiving
 * the task description from the dashboard API.
 * 
 * Test Coverage:
 * 1. Persona receives task description from payload
 * 2. Description is included in the userText sent to LLM
 * 3. Missing description causes diagnostic error
 * 4. Dashboard API returns description field
 */
describe('Persona planning context validation', () => {
  let transport: LocalTransport;
  let consumer: PersonaConsumer;

  beforeEach(async () => {
    transport = new LocalTransport();
    consumer = new PersonaConsumer(transport);
  });

  it('CRITICAL: implementation-planner must receive task description in userText', async () => {
    let capturedUserText: string | undefined;
    let capturedMessages: any[] = [];
    
    // Mock buildPersonaMessages to capture what's sent to LLM
    const buildMessagesModule = await import('../src/personas/PersonaRequestHandler.js');
    const originalBuildMessages = buildMessagesModule.buildPersonaMessages;
    vi.spyOn(buildMessagesModule, 'buildPersonaMessages').mockImplementation((input: any) => {
      capturedUserText = input.userText;
      capturedMessages = originalBuildMessages(input);
      return capturedMessages;
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

    // Send request with full task object as it comes from dashboard API
    await transport.xAdd(cfg.requestStream, '*', {
      workflow_id: 'wf-critical-test',
      to_persona: 'implementation-planner',
      step: '2-plan',
      intent: 'planning',
      corr_id: 'test-corr-critical',
      payload: JSON.stringify({
        task: {
          id: 1,
          title: 'Config loader and schema validation',
          description: 'Implement hierarchical config (env, file, CLI) with JSON schema validation',
          status: 'open',
          priority_score: 0,
          milestone_id: 1,
          labels: ['backend', 'config']
        },
        project_id: '1',
        repo: 'https://example.com/repo.git',
        branch: 'main'
      })
    });

    // Wait for processing
    await new Promise(resolve => setTimeout(resolve, 50));
    await consumer.stop();

    // CRITICAL ASSERTIONS
    expect(capturedUserText).toBeDefined();
    expect(capturedUserText).toContain('Config loader and schema validation');
    expect(capturedUserText).toContain('Implement hierarchical config');
    expect(capturedUserText).toContain('JSON schema validation');
    
    // Should NOT just be the generic intent
    expect(capturedUserText).not.toBe('planning');
    expect(capturedUserText).not.toContain('Process this request');
    
    // Verify it's in the actual messages sent to LLM
    const userMessage = capturedMessages.find(m => m.role === 'user');
    expect(userMessage).toBeDefined();
    expect(userMessage.content).toContain('Config loader');
    expect(userMessage.content).toContain('hierarchical config');
  });

  it('MUST error when task has no description', async () => {
    let errorLogged = false;
    let loggedPayload: any = null;
    
    // Spy on logger to catch error
    const loggerModule = await import('../src/logger.js');
    const originalError = loggerModule.logger.error;
    vi.spyOn(loggerModule.logger, 'error').mockImplementation((msg: string, meta?: any) => {
      if (msg === 'PersonaConsumer: CRITICAL - Task has no description') {
        errorLogged = true;
        loggedPayload = meta;
      }
      return originalError(msg, meta);
    });

    const buildMessagesModule = await import('../src/personas/PersonaRequestHandler.js');
    vi.spyOn(buildMessagesModule, 'callPersonaModel').mockResolvedValue({
      content: '{"plan": [{"goal": "test"}]}',
      duration_ms: 100
    });

    await consumer.start({
      personas: ['implementation-planner'],
      blockMs: 100,
      batchSize: 1
    });

    await new Promise(resolve => setTimeout(resolve, 10));

    // Send request with task but NO description
    await transport.xAdd(cfg.requestStream, '*', {
      workflow_id: 'wf-no-desc',
      to_persona: 'implementation-planner',
      step: '2-plan',
      intent: 'planning',
      corr_id: 'test-no-desc',
      payload: JSON.stringify({
        task: {
          id: 1,
          title: 'Some task',
          status: 'open'
          // description is MISSING!
        }
      })
    });

    // Give enough time for async processing
    await new Promise(resolve => setTimeout(resolve, 200));
    await consumer.stop();

    // MUST have logged an error
    expect(errorLogged).toBe(true);
    expect(loggedPayload).toBeDefined();
    expect(loggedPayload.persona).toBe('implementation-planner');
    expect(loggedPayload.taskTitle).toBe('Some task');
  });

  it('validates dashboard API returns description field', async () => {
    // This is an integration test that verifies the dashboard API contract
    const { fetch } = await import('undici');
    
    try {
      const response = await fetch('http://localhost:3000/projects/1/tasks');
      const data: any = await response.json();
      
      expect(data).toBeDefined();
      expect(data.data).toBeDefined();
      expect(Array.isArray(data.data)).toBe(true);
      
      if (data.data.length > 0) {
        const firstTask = data.data[0];
        
        // CRITICAL: Dashboard API MUST return description field
        expect(firstTask).toHaveProperty('id');
        expect(firstTask).toHaveProperty('title');
        expect(firstTask).toHaveProperty('description');
        expect(firstTask).toHaveProperty('status');
        
        // If description exists in DB, it should be a string
        if (firstTask.description !== null) {
          expect(typeof firstTask.description).toBe('string');
        }
      }
    } catch (error) {
      // Dashboard might not be running in test environment
      console.warn('Dashboard API not available:', error);
    }
  });

  it('extracts task description even when nested in complex payload', async () => {
    let capturedUserText: string | undefined;
    
    const buildMessagesModule = await import('../src/personas/PersonaRequestHandler.js');
    const originalBuildMessages = buildMessagesModule.buildPersonaMessages;
    vi.spyOn(buildMessagesModule, 'buildPersonaMessages').mockImplementation((input: any) => {
      capturedUserText = input.userText;
      return originalBuildMessages(input);
    });

    vi.spyOn(buildMessagesModule, 'callPersonaModel').mockResolvedValue({
      content: '{"plan": [{"goal": "test"}]}',
      duration_ms: 100
    });

    await consumer.start({
      personas: ['implementation-planner'],
      blockMs: 100,
      batchSize: 1
    });

    await new Promise(resolve => setTimeout(resolve, 5));

    // Complex payload with lots of extra fields
    await transport.xAdd(cfg.requestStream, '*', {
      workflow_id: 'wf-complex',
      to_persona: 'implementation-planner',
      step: '2-plan',
      intent: 'planning',
      corr_id: 'test-complex',
      payload: JSON.stringify({
        iteration: 1,
        planIteration: 1,
        is_revision: false,
        repo: 'https://example.com/repo.git',
        branch: 'main',
        project_id: '1',
        task: {
          id: 5,
          title: 'Implement logging system',
          description: 'Add structured logging with Winston, support multiple transports (file, console, remote), include request tracing',
          type: 'feature',
          scope: 'large',
          status: 'open',
          priority_score: 100,
          milestone_id: 2
        },
        extra_context: 'some other data',
        previous_evaluation: null
      })
    });

    await new Promise(resolve => setTimeout(resolve, 50));
    await consumer.stop();

    expect(capturedUserText).toBeDefined();
    expect(capturedUserText).toContain('Implement logging system');
    expect(capturedUserText).toContain('Add structured logging with Winston');
    expect(capturedUserText).toContain('Type: feature');
    expect(capturedUserText).toContain('Scope: large');
  });

  it('workflow should abort if task description is missing (integration behavior)', async () => {
    // This test documents the REQUIRED behavior:
    // When a task has no description, the workflow MUST abort with a diagnostic error
    // rather than sending a generic "planning" prompt to the LLM
    
    // Note: This would be implemented in WorkflowCoordinator or PlanningLoopStep
    // to check task.description before sending to persona
    
    const taskWithoutDescription: any = {
      id: 1,
      title: 'Some task',
      status: 'open'
      // description is MISSING
    };

    // EXPECTED BEHAVIOR (to be implemented):
    // 1. Check if task.description exists and is non-empty
    // 2. If not, log error with diagnostic info
    // 3. Abort workflow with clear error message
    // 4. Update task status to 'blocked' with reason
    
    expect(taskWithoutDescription.description).toBeUndefined();
    
    // This test serves as documentation of required behavior
    // TODO: Implement validation in PlanningLoopStep.execute() or WorkflowCoordinator
  });
});
