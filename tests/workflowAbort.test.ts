import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { WorkflowContext } from '../src/workflows/engine/WorkflowContext.js';
import { abortWorkflowDueToPushFailure } from '../src/workflows/helpers/workflowAbort.js';
import { cfg } from '../src/config.js';
import { makeRedis } from '../src/redisClient.js';

vi.mock('../src/logger.js', () => ({
  logger: {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  }
}));

const redisMock = {
  xRange: vi.fn(),
  xAck: vi.fn(),
  xDel: vi.fn(),
  quit: vi.fn()
};

vi.mock('../src/redisClient.js', () => ({
  makeRedis: vi.fn().mockImplementation(async () => redisMock)
}));

const originalAllowedPersonas = [...cfg.allowedPersonas];

beforeEach(() => {
  redisMock.xRange.mockReset();
  redisMock.xAck.mockReset();
  redisMock.xDel.mockReset();
  redisMock.quit.mockReset();
  cfg.allowedPersonas = ['lead-engineer'];
});

afterEach(() => {
  cfg.allowedPersonas = [...originalAllowedPersonas];
});

describe('abortWorkflowDueToPushFailure', () => {
  it('purges redis tasks and marks workflow aborted', async () => {
    const workflowId = 'wf-123';
    redisMock.xRange
      .mockResolvedValueOnce([
        { id: '1-0', message: { workflow_id: workflowId } },
        { id: '2-0', message: { workflow_id: 'other' } }
      ])
      .mockResolvedValueOnce([]);
    redisMock.xAck.mockResolvedValue(1);
    redisMock.xDel.mockResolvedValue(1);
    redisMock.quit.mockResolvedValue(undefined);

    const context = new WorkflowContext(
      workflowId,
      'proj-1',
      '/tmp/repo',
      'main',
      { name: 'test-workflow', version: '1.0.0', steps: [] },
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

    expect(makeRedis).toHaveBeenCalledOnce();
    expect(redisMock.xRange).toHaveBeenCalledWith(cfg.requestStream, '-', '+', { COUNT: 200 });
    expect(redisMock.xAck).toHaveBeenCalledWith(cfg.requestStream, `${cfg.groupPrefix}:lead-engineer`, '1-0');
    expect(redisMock.xAck).toHaveBeenCalledWith(cfg.requestStream, `${cfg.groupPrefix}:coordination`, '1-0');
    expect(redisMock.xDel).toHaveBeenCalledWith(cfg.requestStream, ['1-0']);
    expect(redisMock.quit).toHaveBeenCalledOnce();

    expect(context.getVariable('workflowAborted')).toBe(true);
    const failureMeta = context.getVariable('pushFailure');
    expect(failureMeta.commitResult.pushed).toBe(false);
    expect(failureMeta.cleanupResult).toMatchObject({ removed: 1 });
  });
});
