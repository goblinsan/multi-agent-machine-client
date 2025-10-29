import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ContextStep } from '../src/workflows/steps/ContextStep.js';
import { WorkflowContext } from '../src/workflows/engine/WorkflowContext.js';
import { logger } from '../src/logger.js';
import fs from 'fs/promises';
import _path from 'path';

// Mock external dependencies
vi.mock('fs/promises');
vi.mock('../src/scanRepo.js', () => ({
  scanRepo: vi.fn()
}));

vi.mock('../src/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  }
}));

describe('ContextStep Change Detection', () => {
  let contextStep: ContextStep;
  let mockContext: WorkflowContext;

  beforeEach(() => {
    vi.clearAllMocks();
    
    contextStep = new ContextStep({
      name: 'test-context',
      type: 'ContextStep',
      config: {
        repoPath: '/test/repo',
        includePatterns: ['**/*.ts'],
        excludePatterns: ['node_modules/**']
      }
    });

    mockContext = {
      setVariable: vi.fn(),
      logger: logger
    } as any;

    // Mock fs.stat to validate repoPath exists and is a directory
    (fs.stat as any).mockResolvedValue({
      isDirectory: () => true,
      mtime: new Date(Date.now() - 60000)
    });
  });

  it('should rescan when context files do not exist', async () => {
    // Mock file access to simulate missing context files
    (fs.access as any).mockRejectedValue(new Error('File not found'));
    
    // Mock scanRepo for the full scan
    const { scanRepo } = await import('../src/scanRepo.js');
    (scanRepo as any).mockResolvedValue([
      { path: 'src/test.ts', bytes: 1000, lines: 50, mtime: Date.now() }
    ]);

    const result = await contextStep.execute(mockContext);

    expect(result.status).toBe('success');
    expect(result.outputs?.reused_existing).toBe(false);
    expect(logger.info).toHaveBeenCalledWith(
      'Context files not found, rescan needed',
      expect.objectContaining({
        snapshotExists: false,
        summaryExists: false
      })
    );
  });

  it('should rescan when source files have been modified since last scan', async () => {
    const lastScanTime = Date.now() - 60000; // 1 minute ago
    const newerFileTime = Date.now() - 30000; // 30 seconds ago

    // Mock context files exist
    (fs.access as any).mockResolvedValue(undefined);
    
    // Mock snapshot file stat - need different mock for context file vs repo stat
    (fs.stat as any)
      .mockResolvedValueOnce({
        isDirectory: () => true,
        mtime: new Date()
      })
      .mockResolvedValueOnce({
        isDirectory: () => false,
        mtime: new Date(lastScanTime)
      });

    // Mock quick scan to find newer files
    const { scanRepo } = await import('../src/scanRepo.js');
    (scanRepo as any)
      .mockResolvedValueOnce([
        { path: 'src/test.ts', bytes: 1000, lines: 50, mtime: newerFileTime }
      ])
      .mockResolvedValueOnce([
        { path: 'src/test.ts', bytes: 1000, lines: 50, mtime: newerFileTime }
      ]);

    const result = await contextStep.execute(mockContext);

    expect(result.status).toBe('success');
    expect(result.outputs?.reused_existing).toBe(false);
    expect(logger.info).toHaveBeenCalledWith(
      'Source files modified since last scan, rescan needed',
      expect.objectContaining({
        newerFilesFound: 1
      })
    );
  });

  it('should reuse existing context when source files unchanged', async () => {
    const lastScanTime = Date.now() - 60000; // 1 minute ago
    const olderFileTime = Date.now() - 120000; // 2 minutes ago

    // Mock context files exist
    (fs.access as any).mockResolvedValue(undefined);
    
    // Mock stats: first for repoPath validation, then for snapshot file
    (fs.stat as any)
      .mockResolvedValueOnce({
        isDirectory: () => true,
        mtime: new Date()
      })
      .mockResolvedValueOnce({
        isDirectory: () => false,
        mtime: new Date(lastScanTime)
      });

    // Mock quick scan to find no newer files
    const { scanRepo } = await import('../src/scanRepo.js');
    (scanRepo as any).mockResolvedValue([
      { path: 'src/test.ts', bytes: 1000, lines: 50, mtime: olderFileTime }
    ]);

    // Mock existing context data
    (fs.readFile as any).mockResolvedValue(JSON.stringify({
      files: [
        { path: 'src/test.ts', bytes: 1000, lines: 50, mtime: olderFileTime }
      ],
      totals: { files: 1, bytes: 1000, lines: 50 },
      timestamp: lastScanTime
    }));

    const result = await contextStep.execute(mockContext);

    expect(result.status).toBe('success');
    expect(result.outputs?.reused_existing).toBe(true);
    expect(logger.info).toHaveBeenCalledWith(
      'Source files unchanged since last scan, reusing context',
      expect.objectContaining({
        filesChecked: 1
      })
    );
    expect(logger.info).toHaveBeenCalledWith(
      'Context gathering completed using existing data',
      expect.objectContaining({
        fileCount: 1,
        totalBytes: 1000
      })
    );
  });

  it('should force rescan when forceRescan is true', async () => {
    // Create context step with force rescan
    const forceRescanStep = new ContextStep({
      name: 'test-context-force',
      type: 'ContextStep',
      config: {
        repoPath: '/test/repo',
        forceRescan: true
      }
    });

    // Mock scanRepo for the full scan
    const { scanRepo } = await import('../src/scanRepo.js');
    (scanRepo as any).mockResolvedValue([
      { path: 'src/test.ts', bytes: 1000, lines: 50, mtime: Date.now() }
    ]);

    const result = await forceRescanStep.execute(mockContext);

    expect(result.status).toBe('success');
    expect(result.outputs?.reused_existing).toBe(false);
    expect(logger.info).toHaveBeenCalledWith(
      'Performing new repository scan',
      expect.objectContaining({
        reason: 'forced rescan'
      })
    );
  });

  it('should handle errors gracefully and fall back to rescan', async () => {
    // Mock repoPath validation to succeed
    (fs.stat as any).mockResolvedValueOnce({
      isDirectory: () => true,
      mtime: new Date()
    });
    
    // Mock context files exist but reading snapshot stats fails
    (fs.access as any).mockResolvedValue(undefined);
    (fs.stat as any).mockRejectedValueOnce(new Error('Permission denied'));

    // Mock scanRepo for the full scan
    const { scanRepo } = await import('../src/scanRepo.js');
    (scanRepo as any).mockResolvedValue([
      { path: 'src/test.ts', bytes: 1000, lines: 50, mtime: Date.now() }
    ]);

    const result = await contextStep.execute(mockContext);

    expect(result.status).toBe('success');
    expect(result.outputs?.reused_existing).toBe(false);
    expect(logger.warn).toHaveBeenCalledWith(
      'Error checking context freshness, will rescan',
      expect.objectContaining({
        error: 'Error: Permission denied'
      })
    );
  });
});