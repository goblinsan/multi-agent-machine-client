import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ContextStep } from '../src/workflows/steps/ContextStep.js';
import { WorkflowContext } from '../src/workflows/engine/WorkflowContext.js';
import { logger } from '../src/logger.js';
import fs from 'fs/promises';
import _path from 'path';


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

    
    (fs.stat as any).mockResolvedValue({
      isDirectory: () => true,
      mtime: new Date(Date.now() - 60000)
    });
  });

  it('should rescan when context files do not exist', async () => {
    
    (fs.access as any).mockRejectedValue(new Error('File not found'));
    
    
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
    const lastScanTime = Date.now() - 60000;
    const newerFileTime = Date.now() - 30000;

    
    (fs.access as any).mockResolvedValue(undefined);
    
    
    (fs.stat as any)
      .mockResolvedValueOnce({
        isDirectory: () => true,
        mtime: new Date()
      })
      .mockResolvedValueOnce({
        isDirectory: () => false,
        mtime: new Date(lastScanTime)
      });

    
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
    const lastScanTime = Date.now() - 60000;
    const olderFileTime = Date.now() - 120000;

    
    (fs.access as any).mockResolvedValue(undefined);
    
    
    (fs.stat as any)
      .mockResolvedValueOnce({
        isDirectory: () => true,
        mtime: new Date()
      })
      .mockResolvedValueOnce({
        isDirectory: () => false,
        mtime: new Date(lastScanTime)
      });

    
    const { scanRepo } = await import('../src/scanRepo.js');
    (scanRepo as any).mockResolvedValue([
      { path: 'src/test.ts', bytes: 1000, lines: 50, mtime: olderFileTime }
    ]);

    
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
    
    const forceRescanStep = new ContextStep({
      name: 'test-context-force',
      type: 'ContextStep',
      config: {
        repoPath: '/test/repo',
        forceRescan: true
      }
    });

    
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
    
    (fs.stat as any).mockResolvedValueOnce({
      isDirectory: () => true,
      mtime: new Date()
    });
    
    
    (fs.access as any).mockResolvedValue(undefined);
    (fs.stat as any).mockRejectedValueOnce(new Error('Permission denied'));

    
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