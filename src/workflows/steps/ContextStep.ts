import { WorkflowStep, StepResult, ValidationResult, WorkflowStepConfig } from '../engine/WorkflowStep.js';
import { WorkflowContext } from '../engine/WorkflowContext.js';
import { logger } from '../../logger.js';
import { scanRepo, ScanSpec, FileInfo } from '../../scanRepo.js';
import { Artifacts } from '../../artifacts.js';

export interface ContextConfig {
  repoPath: string;
  includePatterns?: string[];
  excludePatterns?: string[];
  maxFiles?: number;
  maxBytes?: number;
  maxDepth?: number;
  trackLines?: boolean;
  trackHash?: boolean;
}

export interface ContextData {
  repoScan: FileInfo[];
  metadata: {
    scannedAt: number;
    repoPath: string;
    fileCount: number;
    totalBytes: number;
    maxDepth: number;
  };
}

/**
 * ContextStep - Gathers repository and artifact context
 * 
 * Configuration:
 * - repoPath: Path to the repository to scan
 * - includePatterns: File patterns to include (default: all files)
 * - excludePatterns: Patterns to exclude from scanning
 * - maxFiles: Maximum number of files to scan (default: 1000)
 * - maxBytes: Maximum total bytes to scan (default: 10MB)
 * - maxDepth: Maximum depth to scan (default: 10)
 * - trackLines: Whether to count lines (default: true)
 * - trackHash: Whether to calculate file hashes (default: false)
 * 
 * Outputs:
 * - context: Complete context data
 * - repoScan: Repository scan results
 */
export class ContextStep extends WorkflowStep {
  async execute(context: WorkflowContext): Promise<StepResult> {
    const config = this.config.config as ContextConfig;
    const { 
      repoPath, 
      includePatterns = ["**/*"],
      excludePatterns = ["node_modules/**", ".git/**", "dist/**", "build/**"],
      maxFiles = 1000,
      maxBytes = 10 * 1024 * 1024, // 10MB
      maxDepth = 10,
      trackLines = true,
      trackHash = false
    } = config;

    logger.info(`Gathering context for repository: ${repoPath}`, {
      includePatterns,
      excludePatterns,
      maxFiles,
      maxBytes,
      maxDepth
    });

    try {
      // Build scan specification
      const scanSpec: ScanSpec = {
        repo_root: repoPath,
        include: includePatterns,
        exclude: excludePatterns,
        max_files: maxFiles,
        max_bytes: maxBytes,
        max_depth: maxDepth,
        track_lines: trackLines,
        track_hash: trackHash
      };

      // Scan repository structure
      const repoScan = await scanRepo(scanSpec);
      
      const totalBytes = repoScan.reduce((sum, file) => sum + file.bytes, 0);
      
      logger.info(`Repository scan completed`, {
        fileCount: repoScan.length,
        totalBytes,
        maxDepth
      });

      // Build context data
      const contextData: ContextData = {
        repoScan,
        metadata: {
          scannedAt: Date.now(),
          repoPath,
          fileCount: repoScan.length,
          totalBytes,
          maxDepth
        }
      };

      // Set context variables
      context.setVariable('context', contextData);
      context.setVariable('repoScan', repoScan);

      logger.info('Context gathering completed successfully', {
        fileCount: contextData.metadata.fileCount,
        totalBytes: contextData.metadata.totalBytes
      });

      return {
        status: 'success',
        data: contextData,
        outputs: {
          context: contextData,
          repoScan
        }
      };

    } catch (error: any) {
      logger.error('Failed to gather context', {
        error: error.message,
        repoPath
      });
      
      return {
        status: 'failure',
        error: new Error(`Failed to gather context: ${error.message}`)
      };
    }
  }

  protected async validateConfig(context: WorkflowContext): Promise<ValidationResult> {
    const config = this.config.config as any;
    const errors: string[] = [];
    const warnings: string[] = [];

    if (!config.repoPath || typeof config.repoPath !== 'string') {
      errors.push('ContextStep: repoPath is required and must be a string');
    }

    if (config.includePatterns !== undefined) {
      if (!Array.isArray(config.includePatterns)) {
        errors.push('ContextStep: includePatterns must be an array');
      } else if (!config.includePatterns.every((pattern: any) => typeof pattern === 'string')) {
        errors.push('ContextStep: includePatterns must be an array of strings');
      }
    }

    if (config.excludePatterns !== undefined) {
      if (!Array.isArray(config.excludePatterns)) {
        errors.push('ContextStep: excludePatterns must be an array');
      } else if (!config.excludePatterns.every((pattern: any) => typeof pattern === 'string')) {
        errors.push('ContextStep: excludePatterns must be an array of strings');
      }
    }

    if (config.maxFiles !== undefined && (typeof config.maxFiles !== 'number' || config.maxFiles < 1)) {
      errors.push('ContextStep: maxFiles must be a positive number');
    }

    if (config.maxBytes !== undefined && (typeof config.maxBytes !== 'number' || config.maxBytes < 1)) {
      errors.push('ContextStep: maxBytes must be a positive number');
    }

    if (config.maxDepth !== undefined && (typeof config.maxDepth !== 'number' || config.maxDepth < 0)) {
      errors.push('ContextStep: maxDepth must be a non-negative number');
    }

    if (config.trackLines !== undefined && typeof config.trackLines !== 'boolean') {
      errors.push('ContextStep: trackLines must be a boolean');
    }

    if (config.trackHash !== undefined && typeof config.trackHash !== 'boolean') {
      errors.push('ContextStep: trackHash must be a boolean');
    }

    // Check if repository path exists (warning only)
    try {
      const fs = await import('fs');
      const stats = await fs.promises.stat(config.repoPath);
      if (!stats.isDirectory()) {
        warnings.push(`ContextStep: repoPath '${config.repoPath}' is not a directory`);
      }
    } catch (error: any) {
      warnings.push(`ContextStep: repoPath '${config.repoPath}' may not exist or be accessible`);
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings
    };
  }

  async cleanup(context: WorkflowContext): Promise<void> {
    // Clear large context data if needed to free memory
    const contextData = context.getVariable('context');
    if (contextData) {
      logger.debug('Cleaning up context data');
      // Context cleanup would happen automatically when context is destroyed
    }
  }
}