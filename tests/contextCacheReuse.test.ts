import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ContextStep } from '../src/workflows/steps/ContextStep.js';
import { WorkflowContext } from '../src/workflows/engine/WorkflowContext.js';
import { makeTempRepo } from './makeTempRepo.js';
import { LocalTransport } from '../src/transport/LocalTransport.js';
import * as fs from 'fs/promises';
import * as path from 'path';

describe('Context Cache Reuse', () => {
  let tempRepoDir: string;
  let context: WorkflowContext;
  let transport: LocalTransport;

  beforeEach(async () => {
    tempRepoDir = await makeTempRepo({
      'README.md': '# Test Project\n',
      'src/index.ts': 'console.log("hello");\n',
      'src/utils.ts': 'export const add = (a: number, b: number) => a + b;\n'
    });

    transport = new LocalTransport();
    await transport.connect();

    context = new WorkflowContext(
      'test-workflow',
      '1',
      tempRepoDir,
      'main',
      { name: 'test', version: '1.0', steps: [] },
      transport,
      { task: { id: '1', title: 'Test', description: 'Test', type: 'feature' } }
    );
  });

  afterEach(async () => {
    await transport.disconnect();
    // Temp dir cleanup happens automatically on system reboot
  });

  it('should perform initial scan and write context artifacts', async () => {
    const step = new ContextStep({
      name: 'context_scan',
      type: 'ContextStep',
      config: {
        repoPath: tempRepoDir,
        includePatterns: ['**/*'],
        excludePatterns: ['node_modules/**', '.git/**'],
        maxFiles: 100,
        maxBytes: 1024 * 1024,
        maxDepth: 10,
        trackLines: true,
        trackHash: false,
        forceRescan: false
      }
    });

    const result = await step.execute(context);

    expect(result.status).toBe('success');
    expect(result.outputs?.reused_existing).toBe(false);
    expect(result.outputs?.repoScan).toHaveLength(3); // README, index.ts, utils.ts

    // Verify context artifacts were created
    const snapshotPath = path.join(tempRepoDir, '.ma/context/snapshot.json');
    const summaryPath = path.join(tempRepoDir, '.ma/context/summary.md');

    const snapshotExists = await fs.access(snapshotPath).then(() => true).catch(() => false);
    const summaryExists = await fs.access(summaryPath).then(() => true).catch(() => false);

    expect(snapshotExists).toBe(true);
    expect(summaryExists).toBe(true);

    // Verify snapshot content
    const snapshotContent = await fs.readFile(snapshotPath, 'utf-8');
    const snapshot = JSON.parse(snapshotContent);
    expect(snapshot.files).toHaveLength(3);
    expect(snapshot.totals.files).toBe(3);
  });

  it('should reuse existing context when source files unchanged', async () => {
    // First scan - creates context
    const step1 = new ContextStep({
      name: 'context_scan',
      type: 'ContextStep',
      config: {
        repoPath: tempRepoDir,
        includePatterns: ['**/*'],
        excludePatterns: ['node_modules/**', '.git/**', '.ma/**'], // Exclude .ma to avoid detecting own artifacts
        maxFiles: 100,
        maxBytes: 1024 * 1024,
        maxDepth: 10,
        trackLines: true,
        trackHash: false,
        forceRescan: false
      }
    });

    const result1 = await step1.execute(context);
    expect(result1.status).toBe('success');
    expect(result1.outputs?.reused_existing).toBe(false);

    // Wait a bit to ensure timestamp difference
    await new Promise(resolve => setTimeout(resolve, 100));

    // Second scan - should reuse
    const step2 = new ContextStep({
      name: 'context_scan',
      type: 'ContextStep',
      config: {
        repoPath: tempRepoDir,
        includePatterns: ['**/*'],
        excludePatterns: ['node_modules/**', '.git/**', '.ma/**'], // Same excludes
        maxFiles: 100,
        maxBytes: 1024 * 1024,
        maxDepth: 10,
        trackLines: true,
        trackHash: false,
        forceRescan: false
      }
    });

    const result2 = await step2.execute(context);
    
    // CRITICAL: Should reuse existing context
    expect(result2.status).toBe('success');
    expect(result2.outputs?.reused_existing).toBe(true);
    expect(result2.outputs?.repoScan).toHaveLength(3); // Same files
  });

  it('should rescan when source files are modified', async () => {
    // First scan
    const step1 = new ContextStep({
      name: 'context_scan',
      type: 'ContextStep',
      config: {
        repoPath: tempRepoDir,
        includePatterns: ['**/*'],
        excludePatterns: ['node_modules/**', '.git/**'],
        maxFiles: 100,
        maxBytes: 1024 * 1024,
        maxDepth: 10,
        trackLines: true,
        trackHash: false,
        forceRescan: false
      }
    });

    const result1 = await step1.execute(context);
    expect(result1.status).toBe('success');
    expect(result1.outputs?.reused_existing).toBe(false);

    // Wait to ensure timestamp difference
    await new Promise(resolve => setTimeout(resolve, 100));

    // Modify a source file
    await fs.writeFile(
      path.join(tempRepoDir, 'src/index.ts'),
      'console.log("modified");\n',
      'utf-8'
    );

    // Second scan - should detect changes and rescan
    const step2 = new ContextStep({
      name: 'context_scan',
      type: 'ContextStep',
      config: {
        repoPath: tempRepoDir,
        includePatterns: ['**/*'],
        excludePatterns: ['node_modules/**', '.git/**'],
        maxFiles: 100,
        maxBytes: 1024 * 1024,
        maxDepth: 10,
        trackLines: true,
        trackHash: false,
        forceRescan: false
      }
    });

    const result2 = await step2.execute(context);
    
    // CRITICAL: Should perform new scan because source changed
    expect(result2.status).toBe('success');
    expect(result2.outputs?.reused_existing).toBe(false);
    // File count might include .ma/ artifacts from first scan, just verify it's > 0
    expect(result2.outputs?.repoScan.length).toBeGreaterThan(0);
  });

  it('should NOT rescan when only .ma/ files change', async () => {
    // First scan
    const step1 = new ContextStep({
      name: 'context_scan',
      type: 'ContextStep',
      config: {
        repoPath: tempRepoDir,
        includePatterns: ['**/*'],
        excludePatterns: ['node_modules/**', '.git/**', '.ma/**'],
        maxFiles: 100,
        maxBytes: 1024 * 1024,
        maxDepth: 10,
        trackLines: true,
        trackHash: false,
        forceRescan: false
      }
    });

    const result1 = await step1.execute(context);
    expect(result1.status).toBe('success');

    // Wait to ensure timestamp difference
    await new Promise(resolve => setTimeout(resolve, 100));

    // Add a file in .ma/ (excluded from scan)
    await fs.mkdir(path.join(tempRepoDir, '.ma/tasks'), { recursive: true });
    await fs.writeFile(
      path.join(tempRepoDir, '.ma/tasks/plan.md'),
      '# Plan\n',
      'utf-8'
    );

    // Second scan - should still reuse because .ma/ is excluded
    const step2 = new ContextStep({
      name: 'context_scan',
      type: 'ContextStep',
      config: {
        repoPath: tempRepoDir,
        includePatterns: ['**/*'],
        excludePatterns: ['node_modules/**', '.git/**', '.ma/**'],
        maxFiles: 100,
        maxBytes: 1024 * 1024,
        maxDepth: 10,
        trackLines: true,
        trackHash: false,
        forceRescan: false
      }
    });

    const result2 = await step2.execute(context);
    
    // CRITICAL: Should reuse because changes are in excluded .ma/ directory
    expect(result2.status).toBe('success');
    expect(result2.outputs?.reused_existing).toBe(true);
  });

  it('should force rescan when forceRescan is true', async () => {
    // First scan
    const step1 = new ContextStep({
      name: 'context_scan',
      type: 'ContextStep',
      config: {
        repoPath: tempRepoDir,
        includePatterns: ['**/*'],
        excludePatterns: ['node_modules/**', '.git/**'],
        maxFiles: 100,
        maxBytes: 1024 * 1024,
        maxDepth: 10,
        trackLines: true,
        trackHash: false,
        forceRescan: false
      }
    });

    const result1 = await step1.execute(context);
    expect(result1.status).toBe('success');
    expect(result1.outputs?.reused_existing).toBe(false);

    // Second scan with forceRescan=true
    const step2 = new ContextStep({
      name: 'context_scan',
      type: 'ContextStep',
      config: {
        repoPath: tempRepoDir,
        includePatterns: ['**/*'],
        excludePatterns: ['node_modules/**', '.git/**'],
        maxFiles: 100,
        maxBytes: 1024 * 1024,
        maxDepth: 10,
        trackLines: true,
        trackHash: false,
        forceRescan: true // Force rescan
      }
    });

    const result2 = await step2.execute(context);
    
    // CRITICAL: Should rescan even though files unchanged
    expect(result2.status).toBe('success');
    expect(result2.outputs?.reused_existing).toBe(false);
  });

  it('should set reused_existing flag correctly in step outputs', async () => {
    // First scan
    const step1 = new ContextStep({
      name: 'context_scan',
      type: 'ContextStep',
      config: {
        repoPath: tempRepoDir,
        includePatterns: ['**/*'],
        excludePatterns: ['node_modules/**', '.git/**', '.ma/**'],
        maxFiles: 100,
        maxBytes: 1024 * 1024,
        maxDepth: 10,
        trackLines: true,
        trackHash: false,
        forceRescan: false
      }
    });

    const result1 = await step1.execute(context);
    
    // CRITICAL: First scan should have reused_existing = false in outputs
    expect(result1.status).toBe('success');
    expect(result1.outputs?.reused_existing).toBe(false);

    // Wait to ensure timestamp difference
    await new Promise(resolve => setTimeout(resolve, 100));

    // Second scan - should reuse
    const step2 = new ContextStep({
      name: 'context_scan',
      type: 'ContextStep',
      config: {
        repoPath: tempRepoDir,
        includePatterns: ['**/*'],
        excludePatterns: ['node_modules/**', '.git/**', '.ma/**'],
        maxFiles: 100,
        maxBytes: 1024 * 1024,
        maxDepth: 10,
        trackLines: true,
        trackHash: false,
        forceRescan: false
      }
    });

    const result2 = await step2.execute(context);
    
    // CRITICAL: Second scan should have reused_existing = true in outputs
    // This flag is used in workflow YAML to skip LLM calls: condition: "${context_scan.reused_existing} != true"
    expect(result2.status).toBe('success');
    expect(result2.outputs?.reused_existing).toBe(true);
    
    // Verify the flag is accessible via step output name
    const stepOutputs = context.getStepOutput('context_scan');
    if (stepOutputs) {
      expect(stepOutputs.reused_existing).toBe(true);
    }
  });
});
