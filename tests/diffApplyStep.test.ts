import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DiffApplyStep } from '../src/workflows/steps/DiffApplyStep.js';
import { WorkflowContext } from '../src/workflows/engine/WorkflowContext.js';
import { logger } from '../src/logger.js';

// Mock external dependencies
vi.mock('../src/fileops.js', () => ({
  applyEditOps: vi.fn()
}));

vi.mock('../src/agents/parsers/DiffParser.js', () => ({
  DiffParser: {
    parsePersonaResponse: vi.fn()
  }
}));

vi.mock('../src/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  }
}));

describe('DiffApplyStep Critical Error Handling', () => {
  let diffApplyStep: DiffApplyStep;
  let mockContext: WorkflowContext;

  beforeEach(() => {
    vi.clearAllMocks();
    
    diffApplyStep = new DiffApplyStep({
      name: 'test-diff-apply',
      type: 'DiffApplyStep',
      config: {
        source_output: 'test_output'
      }
    });

    mockContext = {
      getStepOutput: vi.fn(),
      getVariable: vi.fn(),
      setVariable: vi.fn(),
      branch: 'test-branch',
      repoRoot: '/test/repo',
      logger: logger
    } as any;
  });

  it('should return failure when no diff operations found', async () => {
    // Mock empty diff content
    (mockContext.getStepOutput as any).mockReturnValue('some diff content');
    
    // Mock parser to return no operations
    const { DiffParser } = await import('../src/agents/parsers/DiffParser.js');
    (DiffParser.parsePersonaResponse as any).mockReturnValue({
      success: true,
      editSpec: { ops: [] },
      diffBlocks: [],
      errors: [],
      warnings: []
    });

    // Should return failure with critical error
    const result = await diffApplyStep.execute(mockContext);
    
    expect(result.status).toBe('failure');
    expect(result.error?.message).toBe(
      'Coordinator-critical: Implementation returned no diff operations to apply. Aborting.'
    );

    expect(logger.error).toHaveBeenCalledWith(
      'Critical failure: No edit operations found in diff',
      expect.objectContaining({
        stepName: 'test-diff-apply'
      })
    );
  });

  it('should return failure when no file changes after applying diffs', async () => {
    // Mock diff content with operations
    (mockContext.getStepOutput as any).mockReturnValue('some diff content');
    
    // Mock parser to return operations
    const { DiffParser } = await import('../src/agents/parsers/DiffParser.js');
    (DiffParser.parsePersonaResponse as any).mockReturnValue({
      success: true,
      editSpec: { ops: [{ path: 'test.ts', operation: 'edit' }] },
      diffBlocks: [],
      errors: [],
      warnings: []
    });

    // Mock applyEditOps to return no changes
    const { applyEditOps } = await import('../src/fileops.js');
    (applyEditOps as any).mockResolvedValue({
      changed: [], // No files changed
      branch: 'test-branch',
      sha: 'test-sha'
    });

    // Should return failure with critical error
    const result = await diffApplyStep.execute(mockContext);
    
    expect(result.status).toBe('failure');
    expect(result.error?.message).toBe(
      'Coordinator-critical: Implementation edits produced no file changes. Aborting.'
    );

    expect(logger.error).toHaveBeenCalledWith(
      'Critical failure: No file changes after applying diffs',
      expect.objectContaining({
        stepName: 'test-diff-apply'
      })
    );
  });

  it('should return failure when no commit SHA is returned', async () => {
    // Mock diff content with operations
    (mockContext.getStepOutput as any).mockReturnValue('some diff content');
    
    // Mock parser to return operations
    const { DiffParser } = await import('../src/agents/parsers/DiffParser.js');
    (DiffParser.parsePersonaResponse as any).mockReturnValue({
      success: true,
      editSpec: { ops: [{ path: 'test.ts', operation: 'edit' }] },
      diffBlocks: [],
      errors: [],
      warnings: []
    });

    // Mock applyEditOps to return changes but no commit SHA
    const { applyEditOps } = await import('../src/fileops.js');
    (applyEditOps as any).mockResolvedValue({
      changed: ['test.ts'], // Files changed
      branch: 'test-branch',
      sha: '' // No commit SHA
    });

    // Should return failure with critical error
    const result = await diffApplyStep.execute(mockContext);
    
    expect(result.status).toBe('failure');
    expect(result.error?.message).toBe(
      'Coordinator-critical: Implementation changes were not committed to repository. Aborting.'
    );

    expect(logger.error).toHaveBeenCalledWith(
      'Critical failure: No commit SHA after applying changes',
      expect.objectContaining({
        stepName: 'test-diff-apply'
      })
    );
  });

  it('should succeed when valid diff operations are applied and committed', async () => {
    // Mock diff content with operations
    (mockContext.getStepOutput as any).mockReturnValue('some diff content');
    
    // Mock parser to return operations
    const { DiffParser } = await import('../src/agents/parsers/DiffParser.js');
    (DiffParser.parsePersonaResponse as any).mockReturnValue({
      success: true,
      editSpec: { ops: [{ path: 'test.ts', operation: 'edit' }] },
      diffBlocks: [],
      errors: [],
      warnings: []
    });

    // Mock applyEditOps to return successful result
    const { applyEditOps } = await import('../src/fileops.js');
    (applyEditOps as any).mockResolvedValue({
      changed: ['test.ts'], // Files changed
      branch: 'test-branch',
      sha: 'commit-sha-123' // Valid commit SHA
    });

    const result = await diffApplyStep.execute(mockContext);

    expect(result.status).toBe('success');
    expect(result.outputs).toEqual({
      applied_files: ['test.ts'],
      commit_sha: 'commit-sha-123',
      operations_count: 1,
      branch: 'test-branch'
    });

    expect(logger.info).toHaveBeenCalledWith(
      'Diff application completed',
      expect.objectContaining({
        stepName: 'test-diff-apply',
        filesChanged: 1,
        commitSha: 'commit-sha-123'
      })
    );
  });
});