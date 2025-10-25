import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { WorkflowContext } from '../src/workflows/engine/WorkflowContext.js';
import { abortWorkflowDueToPushFailure } from '../src/workflows/helpers/workflowAbort.js';
import { cfg } from '../src/config.js';

vi.mock('../src/logger.js', () => ({
  logger: {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  }
}));

const originalAllowedPersonas = [...cfg.allowedPersonas];

const mockTransport = {
  connect: vi.fn().mockResolvedValue(null),
  disconnect: vi.fn().mockResolvedValue(null),
  xAdd: vi.fn().mockResolvedValue('1-0'),
  xGroupCreate: vi.fn().mockResolvedValue(null),
  xReadGroup: vi.fn().mockResolvedValue([]),
  xRead: vi.fn().mockResolvedValue([]),
  xRange: vi.fn(),
  xAck: vi.fn(),
  xDel: vi.fn(),
  del: vi.fn().mockResolvedValue(0),
  xLen: vi.fn().mockResolvedValue(0),
  xPending: vi.fn().mockResolvedValue([]),
  xClaim: vi.fn().mockResolvedValue([]),
  xInfoGroups: vi.fn().mockResolvedValue([]),
  xGroupDestroy: vi.fn().mockResolvedValue(null),
  quit: vi.fn().mockResolvedValue(null)
};

beforeEach(() => {
  mockTransport.xRange.mockReset();
  mockTransport.xAck.mockReset();
  mockTransport.xDel.mockReset();
  mockTransport.xAdd.mockReset();
  mockTransport.xReadGroup.mockReset();
  cfg.allowedPersonas = ['lead-engineer'];
});

afterEach(() => {
  cfg.allowedPersonas = [...originalAllowedPersonas];
});

describe('abortWorkflowDueToPushFailure', () => {
  it('purges redis tasks and marks workflow aborted', async () => {
    const workflowId = 'wf-123';
    mockTransport.xRange
      .mockResolvedValueOnce([
        { id: '1-0', message: { workflow_id: workflowId } },
        { id: '2-0', message: { workflow_id: 'other' } }
      ])
      .mockResolvedValueOnce([]);
    mockTransport.xAck.mockResolvedValue(1);
    mockTransport.xDel.mockResolvedValue(1);

    const context = new WorkflowContext(
      workflowId,
      'proj-1',
      '/tmp/repo',
      'main',
      { name: 'test-workflow', version: '1.0.0', steps: [] },
      mockTransport,
      {}
    );

    await abortWorkflowDueToPushFailure(context, {
      committed: true,
      pushed: false,
      branch: 'feat/task',
      reason: 'push_failed'
    }, {
      message: 'feat: update',
      paths: ['src/index.ts']
    });

    expect(mockTransport.xRange).toHaveBeenCalledWith(cfg.requestStream, '-', '+', { COUNT: 200 });
    expect(mockTransport.xAck).toHaveBeenCalledWith(cfg.requestStream, `${cfg.groupPrefix}:lead-engineer`, '1-0');
    expect(mockTransport.xAck).toHaveBeenCalledWith(cfg.requestStream, `${cfg.groupPrefix}:coordination`, '1-0');
    expect(mockTransport.xDel).toHaveBeenCalledWith(cfg.requestStream, ['1-0']);

    expect(context.getVariable('workflowAborted')).toBe(true);
    const failureMeta = context.getVariable('pushFailure');
    expect(failureMeta.commitResult.pushed).toBe(false);
    expect(failureMeta.cleanupResult).toMatchObject({ removed: 1 });
  });
});
