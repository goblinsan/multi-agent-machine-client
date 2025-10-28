import { WorkflowStep, StepResult, ValidationResult } from '../engine/WorkflowStep.js';
import { WorkflowContext } from '../engine/WorkflowContext.js';
import { logger } from '../../logger.js';
import { scanRepo, ScanSpec, FileInfo } from '../../scanRepo.js';
import { Artifacts as _Artifacts } from '../../artifacts.js';
import fs from 'fs/promises';
import path from 'path';

export interface ContextConfig {
  repoPath: string;
  includePatterns?: string[];
  excludePatterns?: string[];
  maxFiles?: number;
  maxBytes?: number;
  maxDepth?: number;
  trackLines?: boolean;
  trackHash?: boolean;
  forceRescan?: boolean;
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
 * ContextStep - Gathers repository and artifact context with change detection
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
 * - forceRescan: Force a new scan even if context files exist (default: false)
 * 
 * Outputs:
 * - context: Complete context data
 * - repoScan: Repository scan results
 */
export class ContextStep extends WorkflowStep {
  
  /**
   * Check if existing context files are still valid by comparing source file modification times
   */
  private async isRescanNeeded(repoPath: string, includePatterns: string[], excludePatterns: string[]): Promise<boolean> {
    try {
      const contextDir = path.join(repoPath, '.ma', 'context');
      const snapshotPath = path.join(contextDir, 'snapshot.json');
      const summaryPath = path.join(contextDir, 'summary.md');

      // Check if context files exist
      const snapshotExists = await fs.access(snapshotPath).then(() => true).catch(() => false);
      const summaryExists = await fs.access(summaryPath).then(() => true).catch(() => false);

      if (!snapshotExists || !summaryExists) {
        logger.info('Context files not found, rescan needed', {
          snapshotExists,
          summaryExists,
          contextDir
        });
        return true;
      }

      // Get the timestamp of the last context scan
      const snapshotStat = await fs.stat(snapshotPath);
      const lastScanTime = snapshotStat.mtime.getTime();

      // Quick scan to check if any source files have been modified since last scan
      const quickScanSpec: ScanSpec = {
        repo_root: repoPath,
        include: includePatterns,
        exclude: excludePatterns,
        max_files: 50, // Small sample for modification time check
        max_bytes: 1024 * 1024, // 1MB limit for quick check
        max_depth: 5,
        track_lines: false,
        track_hash: false
      };

      const quickScan = await scanRepo(quickScanSpec);
      
      // Check if any files have been modified since the last scan
      const hasNewerFiles = quickScan.some(file => file.mtime > lastScanTime);

      if (hasNewerFiles) {
        logger.info('Source files modified since last scan, rescan needed', {
          lastScanTime: new Date(lastScanTime).toISOString(),
          newerFilesFound: quickScan.filter(f => f.mtime > lastScanTime).length
        });
        return true;
      }

      logger.info('Source files unchanged since last scan, reusing context', {
        lastScanTime: new Date(lastScanTime).toISOString(),
        filesChecked: quickScan.length
      });
      return false;

    } catch (error) {
      logger.warn('Error checking context freshness, will rescan', {
        error: String(error),
        repoPath
      });
      return true;
    }
  }

  /**
   * Load existing context data from files
   */
  private async loadExistingContext(repoPath: string): Promise<ContextData | null> {
    try {
      const contextDir = path.join(repoPath, '.ma', 'context');
      const snapshotPath = path.join(contextDir, 'snapshot.json');

      const snapshotContent = await fs.readFile(snapshotPath, 'utf8');
      const snapshot = JSON.parse(snapshotContent);

      // Convert snapshot back to ContextData format
      const contextData: ContextData = {
        repoScan: snapshot.files || [],
        metadata: {
          scannedAt: snapshot.timestamp || Date.now(),
          repoPath,
          fileCount: snapshot.totals?.files || 0,
          totalBytes: snapshot.totals?.bytes || 0,
          maxDepth: 10 // Default fallback
        }
      };

      logger.info('Loaded existing context data', {
        fileCount: contextData.metadata.fileCount,
        totalBytes: contextData.metadata.totalBytes,
        scannedAt: new Date(contextData.metadata.scannedAt).toISOString()
      });

      return contextData;

    } catch (error) {
      logger.warn('Failed to load existing context', {
        error: String(error),
        repoPath
      });
      return null;
    }
  }

  /**
   * Write context artifacts (snapshot.json and summary.md) to .ma/context/ directory
   * This enables distributed agents to access context without re-scanning
   */
  private async writeContextArtifacts(repoPath: string, contextData: ContextData): Promise<void> {
    try {
      const contextDir = path.join(repoPath, '.ma', 'context');
      await fs.mkdir(contextDir, { recursive: true });

      // Create snapshot.json
      const snapshot = {
        timestamp: contextData.metadata.scannedAt,
        files: contextData.repoScan,
        totals: {
          files: contextData.metadata.fileCount,
          bytes: contextData.metadata.totalBytes,
          depth: contextData.metadata.maxDepth
        }
      };

      const snapshotPath = path.join(contextDir, 'snapshot.json');
      await fs.writeFile(snapshotPath, JSON.stringify(snapshot, null, 2), 'utf-8');

      // Create summary.md with file tree and analysis
      const summary = this.generateContextSummary(contextData);
      const summaryPath = path.join(contextDir, 'summary.md');
      await fs.writeFile(summaryPath, summary, 'utf-8');

      logger.info('Context artifacts written', {
        snapshotPath,
        summaryPath,
        fileCount: contextData.metadata.fileCount
      });

      // Commit and push to git for distributed access
      const { runGit } = await import('../../gitUtils.js');
      
      try {
        // Add both files
        await runGit(['add', '.ma/context/snapshot.json', '.ma/context/summary.md'], { cwd: repoPath });
        
        // Commit with --no-verify to skip pre-commit hooks (automated workflow commit)
        const commitMsg = `chore(ma): update context scan (${contextData.metadata.fileCount} files)`;
        await runGit(['commit', '--no-verify', '-m', commitMsg], { cwd: repoPath });
        
        // Get current branch
        const branchResult = await runGit(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: repoPath });
        const branch = branchResult.stdout.trim();
        
        // Push to remote (best effort - don't fail if push fails)
        try {
          const remotes = await runGit(['remote'], { cwd: repoPath });
          if (remotes.stdout.trim().length > 0) {
            await runGit(['push', 'origin', branch], { cwd: repoPath });
            logger.info('Context artifacts pushed to remote', { branch });
          }
        } catch (pushErr) {
          logger.warn('Failed to push context artifacts (will retry later)', {
            error: pushErr instanceof Error ? pushErr.message : String(pushErr)
          });
        }
      } catch (gitErr) {
        // Git operations are best-effort for context
        logger.warn('Failed to commit context artifacts', {
          error: gitErr instanceof Error ? gitErr.message : String(gitErr)
        });
      }

    } catch (error) {
      // Don't fail the workflow if artifact writing fails
      logger.warn('Failed to write context artifacts', {
        error: String(error),
        repoPath
      });
    }
  }

  /**
   * Generate markdown summary of context scan
   */
  private generateContextSummary(contextData: ContextData): string {
    const { repoScan, metadata } = contextData;
    
    // Group files by directory
    const dirTree: Record<string, FileInfo[]> = {};
    repoScan.forEach(file => {
      const dir = path.dirname(file.path);
      if (!dirTree[dir]) dirTree[dir] = [];
      dirTree[dir].push(file);
    });

    // Build summary
    let summary = `# Repository Context Summary\n\n`;
    summary += `Generated: ${new Date(metadata.scannedAt).toISOString()}\n\n`;
    summary += `## Statistics\n\n`;
    summary += `- **Total Files**: ${metadata.fileCount}\n`;
    summary += `- **Total Size**: ${(metadata.totalBytes / 1024).toFixed(2)} KB\n`;
    summary += `- **Max Depth**: ${metadata.maxDepth}\n\n`;

    // Directory structure
    summary += `## Directory Structure\n\n\`\`\`\n`;
    const sortedDirs = Object.keys(dirTree).sort();
    sortedDirs.forEach(dir => {
      const files = dirTree[dir];
      summary += `${dir}/\n`;
      files.forEach(file => {
        const name = path.basename(file.path);
        const size = `${(file.bytes / 1024).toFixed(1)}KB`;
        summary += `  ${name} (${size})\n`;
      });
    });
    summary += `\`\`\`\n\n`;

    // Large files (>200 lines or >50KB)
    const largeFiles = repoScan.filter(f => 
      (f.lines && f.lines > 200) || f.bytes > 50 * 1024
    );
    if (largeFiles.length > 0) {
      summary += `## Large Files\n\n`;
      largeFiles.forEach(f => {
        const size = `${(f.bytes / 1024).toFixed(1)}KB`;
        const lines = f.lines ? `, ${f.lines} lines` : '';
        summary += `- \`${f.path}\` (${size}${lines})\n`;
      });
      summary += `\n`;
    }

    // File extensions distribution
    const extMap: Record<string, number> = {};
    repoScan.forEach(f => {
      const ext = path.extname(f.path) || '(no extension)';
      extMap[ext] = (extMap[ext] || 0) + 1;
    });
    summary += `## File Types\n\n`;
    Object.entries(extMap)
      .sort((a, b) => b[1] - a[1])
      .forEach(([ext, count]) => {
        summary += `- ${ext}: ${count} file${count > 1 ? 's' : ''}\n`;
      });

    return summary;
  }

  async execute(context: WorkflowContext): Promise<StepResult> {
    const config = this.config.config as ContextConfig;
    const { 
      repoPath: rawRepoPath, 
      includePatterns = ["**/*"],
      excludePatterns = ["node_modules/**", ".git/**", "dist/**", "build/**"],
      maxFiles = 1000,
      maxBytes = 10 * 1024 * 1024, // 10MB
      maxDepth = 10,
      trackLines = true,
      trackHash = false,
      forceRescan = false
    } = config;

    // Resolve variables in repoPath (e.g., ${repo_root})
    const repoPath = this.resolveVariables(rawRepoPath, context);

    // CRITICAL: Abort if repoPath wasn't resolved or is invalid
    if (!repoPath || repoPath.includes('${')) {
      const error = `FATAL: repo_root variable not resolved! Got: "${repoPath}" from config: "${rawRepoPath}"`;
      logger.error(error, {
        rawRepoPath,
        resolvedRepoPath: repoPath,
        workflowId: context.workflowId
      });
      return {
        status: 'failure',
        error: new Error(error),
        data: {}
      };
    }

    // Verify the resolved path is a valid directory
    try {
      const fs = await import('fs/promises');
      const stats = await fs.stat(repoPath);
      if (!stats.isDirectory()) {
        const error = `FATAL: Resolved repo_root is not a directory: ${repoPath}`;
        logger.error(error, { repoPath, rawRepoPath });
        return {
          status: 'failure',
          error: new Error(error),
          data: {}
        };
      }
    } catch (err) {
      const error = `FATAL: Resolved repo_root does not exist or is not accessible: ${repoPath}`;
      logger.error(error, { repoPath, rawRepoPath, error: err });
      return {
        status: 'failure',
        error: new Error(error),
        data: {}
      };
    }

    logger.info(`Gathering context for repository: ${repoPath}`, {
      includePatterns,
      excludePatterns,
      maxFiles,
      maxBytes,
      maxDepth,
      forceRescan
    });

    try {
      let contextData: ContextData | undefined;
      let reusedExisting = false;

      // Check if we need to rescan or can reuse existing context
      if (!forceRescan) {
        const needsRescan = await this.isRescanNeeded(repoPath, includePatterns, excludePatterns);
        
        if (!needsRescan) {
          const existingContext = await this.loadExistingContext(repoPath);
          if (existingContext) {
            contextData = existingContext;
            reusedExisting = true;
            
            logger.info('Context gathering completed using existing data', {
              fileCount: contextData.metadata.fileCount,
              totalBytes: contextData.metadata.totalBytes,
              originalScanTime: new Date(contextData.metadata.scannedAt).toISOString()
            });
          }
        }
      }

      // Perform new scan if needed
      if (!contextData || forceRescan) {
        logger.info('Performing new repository scan', {
          reason: forceRescan ? 'forced rescan' : 'source files changed'
        });

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
        contextData = {
          repoScan,
          metadata: {
            scannedAt: Date.now(),
            repoPath,
            fileCount: repoScan.length,
            totalBytes,
            maxDepth
          }
        };

        logger.info('Context gathering completed with new scan', {
          fileCount: contextData.metadata.fileCount,
          totalBytes: contextData.metadata.totalBytes
        });

        // Write snapshot.json and summary.md for distributed persistence
        await this.writeContextArtifacts(repoPath, contextData);
      }

      // Set context variables
      context.setVariable('context', contextData);
      context.setVariable('repoScan', contextData.repoScan);

      return {
        status: 'success',
        data: contextData,
        outputs: {
          context: contextData,
          repoScan: contextData.repoScan,
          reused_existing: reusedExisting,
          scan_timestamp: contextData.metadata.scannedAt
        },
        metrics: {
          duration_ms: Date.now() - (contextData.metadata.scannedAt || Date.now()),
          operations_count: contextData.metadata.fileCount
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

  protected async validateConfig(_context: WorkflowContext): Promise<ValidationResult> {
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

  /**
   * Resolves variable placeholders like ${variable_name} in strings
   */
  private resolveVariables(str: string, context: WorkflowContext): string {
    return str.replace(/\$\{([^}]+)\}/g, (match, varPath) => {
      try {
        const parts = varPath.trim().split('.');
        
        // First check if it's a direct context property (repo_root, branch, etc.)
        const firstPart = parts[0];
        let value: any;
        
        if (firstPart === 'repo_root') {
          value = context.repoRoot;
        } else if (firstPart === 'branch') {
          value = context.branch;
        } else if (firstPart === 'workflow_id') {
          value = context.workflowId;
        } else if (firstPart === 'project_id') {
          value = context.projectId;
        } else {
          // Otherwise get from variables map
          value = context.getVariable(firstPart);
        }
        
        // Traverse nested properties
        for (let i = 1; i < parts.length; i++) {
          if (value && typeof value === 'object' && parts[i] in value) {
            value = value[parts[i]];
          } else {
            // Property not found, return original placeholder
            return match;
          }
        }
        
        return String(value ?? match);
      } catch (error) {
        logger.warn(`Failed to resolve variable ${varPath}`, { error });
        return match;
      }
    });
  }
}