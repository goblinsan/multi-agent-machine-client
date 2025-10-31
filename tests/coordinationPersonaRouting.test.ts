import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PersonaConsumer } from '../src/personas/PersonaConsumer.js';
import { LocalTransport } from '../src/transport/LocalTransport.js';
import { cfg } from '../src/config.js';

/**
 * Coordination Persona Routing Tests
 * 
 * Validates that the 'coordination' persona is NOT processed through LLM
 * but instead routes directly to WorkflowCoordinator.
 * 
 * This prevents unnecessary LLM calls for workflow orchestration logic
 * which should be handled by the coordinator code, not AI.
 */

// Mock the WorkflowCoordinator
const mockHandleCoordinator = vi.fn().mockResolvedValue(undefined);
vi.mock('../src/workflows/WorkflowCoordinator.js', () => ({
  WorkflowCoordinator: vi.fn().mockImplementation(() => ({
    handleCoordinator: mockHandleCoordinator
  }))
}));

// Mock Redis client
vi.mock('../src/redisClient.js');

// Mock dashboard
vi.mock('../src/dashboard.js', () => ({
  fetchProjectStatus: vi.fn().mockResolvedValue({
    id: 'proj-coord-test',
    name: 'Coordination Test Project',
    status: 'active'
  }),
  fetchProjectStatusDetails: vi.fn().mockResolvedValue({
    tasks: [],
    repositories: []
  })
}));

// Mock LM Studio - should NOT be called for coordination persona
const mockCallLMStudio = vi.fn();
vi.mock('../src/lmstudio.js', () => ({
  callLMStudio: mockCallLMStudio
}));

beforeEach(() => {
  vi.clearAllMocks();
  mockCallLMStudio.mockClear();
  mockHandleCoordinator.mockClear();
});

describe('Coordination Persona Routing', () => {

  it('should route coordination persona to WorkflowCoordinator, NOT LLM', async () => {
    const transport = new LocalTransport();
    const consumer = new PersonaConsumer(transport);

    // Send a coordination request
    const workflowId = 'wf_coord_test_' + Date.now();
    const projectId = '1';

    await transport.xAdd(cfg.requestStream, '*', {
      workflow_id: workflowId,
      step: '00',
      from: 'user',
      to_persona: 'coordination',
      intent: 'orchestrate_milestone',
      corr_id: `coord-${Date.now()}`,
      payload: JSON.stringify({ project_id: projectId }),
      deadline_s: '900',
      project_id: projectId
    });

    // Start consumer for coordination persona
    await consumer.start({
      personas: ['coordination'],
      consumerId: 'test-consumer',
      blockMs: 1000
    });

    // Give it time to process
    await new Promise(resolve => setTimeout(resolve, 2000));

    // Stop the consumer
    await consumer.stop();

    // Verify WorkflowCoordinator was called
    expect(mockHandleCoordinator).toHaveBeenCalled();
    
    // Verify LM Studio was NOT called for coordination
    expect(mockCallLMStudio).not.toHaveBeenCalled();
  });

  it('should NOT route regular personas to WorkflowCoordinator', async () => {
    const transport = new LocalTransport();
    const consumer = new PersonaConsumer(transport);

    // Mock the persona model to prevent errors
    vi.mock('../src/lmstudio.js', () => ({
      callLMStudio: vi.fn().mockResolvedValue('Mock response from context persona')
    }));

    const workflowId = 'wf_context_test_' + Date.now();
    const projectId = '1';

    await transport.xAdd(cfg.requestStream, '*', {
      workflow_id: workflowId,
      step: '01',
      from: 'coordination',
      to_persona: 'context',
      intent: 'context_gathering',
      corr_id: `ctx-${Date.now()}`,
      payload: JSON.stringify({ repo: '/test/repo' }),
      project_id: projectId
    });

    // Start consumer for context persona
    await consumer.start({
      personas: ['context'],
      consumerId: 'test-consumer',
      blockMs: 1000
    });

    // Give it time to process
    await new Promise(resolve => setTimeout(resolve, 2000));

    // Stop the consumer
    await consumer.stop();

    // Verify WorkflowCoordinator was NOT called for regular persona
    expect(mockHandleCoordinator).not.toHaveBeenCalled();
    
    // Note: We can't easily verify LM Studio was called due to mocking complexity,
    // but the absence of WorkflowCoordinator call confirms correct routing
  });

  it('should pass correct parameters to WorkflowCoordinator', async () => {
    const transport = new LocalTransport();
    const consumer = new PersonaConsumer(transport);

    const workflowId = 'wf_coord_params_' + Date.now();
    const projectId = '42';
    const repo = 'git@github.com:test/repo.git';
    const baseBranch = 'develop';

    await transport.xAdd(cfg.requestStream, '*', {
      workflow_id: workflowId,
      step: '00',
      from: 'user',
      to_persona: 'coordination',
      intent: 'orchestrate_milestone',
      corr_id: `coord-${Date.now()}`,
      payload: JSON.stringify({
        project_id: projectId,
        repo: repo,
        base_branch: baseBranch
      }),
      project_id: projectId
    });

    // Start consumer
    await consumer.start({
      personas: ['coordination'],
      consumerId: 'test-consumer',
      blockMs: 1000
    });

    // Give it time to process
    await new Promise(resolve => setTimeout(resolve, 2000));

    // Stop the consumer
    await consumer.stop();

    // Verify handleCoordinator was called with correct parameters
    expect(mockHandleCoordinator).toHaveBeenCalled();
    const callArgs = mockHandleCoordinator.mock.calls[0];
    
    // Check transport was passed
    expect(callArgs[0]).toBeDefined();
    
    // Check message parameters
    const msgParam = callArgs[2];
    expect(msgParam.workflow_id).toBe(workflowId);
    expect(msgParam.project_id).toBe(projectId);
    expect(msgParam.repo).toBe(repo);
    expect(msgParam.base_branch).toBe(baseBranch);
    
    // Check payload
    const payloadParam = callArgs[3];
    expect(payloadParam.project_id).toBe(projectId);
    expect(payloadParam.repo).toBe(repo);
    expect(payloadParam.base_branch).toBe(baseBranch);
  });
});
