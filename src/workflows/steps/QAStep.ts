import { WorkflowStep, StepResult, ValidationResult } from '../engine/WorkflowStep.js';
import { WorkflowContext } from '../engine/WorkflowContext.js';
import { logger } from '../../logger.js';

export interface QAConfig {
  testCommand?: string;
  testPath?: string;
  timeout?: number;
  retryCount?: number;
  failureThreshold?: number;
  requiredCoverage?: number;
  skipOnNoTests?: boolean;
}

export interface QAResult {
  passed: boolean;
  testResults: {
    total: number;
    passed: number;
    failed: number;
    skipped: number;
    duration_ms: number;
  };
  coverage?: {
    percentage: number;
    lines: { covered: number; total: number };
    functions: { covered: number; total: number };
  };
  failures: Array<{
    test: string;
    error: string;
    file?: string;
    line?: number;
  }>;
  metadata: {
    executedAt: number;
    command: string;
    workingDir: string;
  };
}


export class QAStep extends WorkflowStep {
  async execute(context: WorkflowContext): Promise<StepResult> {
    const config = this.config.config as QAConfig;
    const {
      testCommand = 'npm test',
      testPath,
      timeout = 300000,
      retryCount = 1,
      failureThreshold = 0,
      requiredCoverage,
      skipOnNoTests = false
    } = config;

    logger.info('Starting QA execution', {
      testCommand,
      testPath,
      timeout,
      retryCount,
      failureThreshold,
      requiredCoverage
    });

    try {
      
      const contextData = context.getVariable('context');
      const workingDir = contextData?.metadata?.repoPath || process.cwd();

      let lastError: Error | null = null;
      let qaResult: QAResult | null = null;

      
      for (let attempt = 0; attempt <= retryCount; attempt++) {
        try {
          qaResult = await this.executeTests(workingDir, testCommand, testPath, timeout);
          break;
        } catch (error: any) {
          lastError = error;
          logger.warn(`QA execution attempt ${attempt + 1} failed`, {
            error: error.message,
            attempt: attempt + 1,
            maxAttempts: retryCount + 1
          });

          if (attempt < retryCount) {
            
            const delay = Math.min(2000 * Math.pow(2, attempt), 10000);
            await new Promise(resolve => setTimeout(resolve, delay));
          }
        }
      }

      if (!qaResult) {
        if (skipOnNoTests && lastError?.message.includes('no tests found')) {
          logger.info('No tests found, skipping QA step');
          return {
            status: 'skipped',
            data: { reason: 'No tests found' }
          };
        }
        throw lastError || new Error('QA execution failed after all retries');
      }

      
      const passRate = (qaResult.testResults.passed / qaResult.testResults.total) * 100;
      const failureRate = (qaResult.testResults.failed / qaResult.testResults.total) * 100;
      
      let qaStatus: 'success' | 'failure' = 'success';
      const issues: string[] = [];

      
      if (failureRate > failureThreshold) {
        qaStatus = 'failure';
        issues.push(`Test failure rate ${failureRate.toFixed(1)}% exceeds threshold ${failureThreshold}%`);
      }

      
      if (requiredCoverage && qaResult.coverage) {
        if (qaResult.coverage.percentage < requiredCoverage) {
          qaStatus = 'failure';
          issues.push(`Coverage ${qaResult.coverage.percentage.toFixed(1)}% below required ${requiredCoverage}%`);
        }
      }

      
      context.setVariable('qaResult', qaResult);
      context.setVariable('testsPassed', qaStatus === 'success');
      context.setVariable('failures', qaResult.failures);

      logger.info('QA execution completed', {
        status: qaStatus,
        totalTests: qaResult.testResults.total,
        passed: qaResult.testResults.passed,
        failed: qaResult.testResults.failed,
        passRate: passRate.toFixed(1) + '%',
        duration: qaResult.testResults.duration_ms,
        issues: issues.length
      });

      return {
        status: qaStatus,
        data: qaResult,
        outputs: {
          qaResult,
          testsPassed: qaStatus === 'success',
          failures: qaResult.failures
        },
        metrics: {
          duration_ms: qaResult.testResults.duration_ms,
          operations_count: qaResult.testResults.total
        },
        error: qaStatus === 'failure' ? new Error(`QA failed: ${issues.join(', ')}`) : undefined
      };

    } catch (error: any) {
      logger.error('QA execution failed', {
        error: error.message,
        step: this.config.name
      });

      return {
        status: 'failure',
        error: new Error(`QA execution failed: ${error.message}`)
      };
    }
  }

  private async executeTests(workingDir: string, command: string, testPath?: string, timeoutMs: number = 300000): Promise<QAResult> {
    const startTime = Date.now();
    
    
    let fullCommand = command;
    if (testPath) {
      fullCommand += ` ${testPath}`;
    }

    logger.debug('Executing test command', { command: fullCommand, workingDir, timeoutMs });

    try {
      
      const testOutput = await this.runCommand(fullCommand, workingDir, timeoutMs);

      const duration_ms = Date.now() - startTime;

      
      const parsed = this.parseTestOutput(testOutput);

      return {
        passed: parsed.failed === 0,
        testResults: {
          total: parsed.total,
          passed: parsed.passed,
          failed: parsed.failed,
          skipped: parsed.skipped,
          duration_ms
        },
        coverage: parsed.coverage,
        failures: parsed.failures,
        metadata: {
          executedAt: Date.now(),
          command: fullCommand,
          workingDir
        }
      };

    } catch (error: any) {
      logger.error('Test execution failed', {
        error: error.message,
        command: fullCommand,
        workingDir
      });
      throw error;
    }
  }

  private async runCommand(command: string, workingDir: string, timeoutMs: number): Promise<string> {
    const { spawn } = await import('child_process');
    
    return new Promise((resolve, reject) => {
      const [cmd, ...args] = command.split(' ');
      const child = spawn(cmd, args, {
        cwd: workingDir,
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: true
      });

      let output = '';
      let errorOutput = '';

      child.stdout?.on('data', (data) => {
        output += data.toString();
      });

      child.stderr?.on('data', (data) => {
        errorOutput += data.toString();
      });

      const timeout = setTimeout(() => {
        child.kill('SIGTERM');
        reject(new Error(`Command timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      child.on('close', (code) => {
        clearTimeout(timeout);
        if (code === 0) {
          resolve(output);
        } else {
          reject(new Error(`Command failed with code ${code}: ${errorOutput}`));
        }
      });

      child.on('error', (error) => {
        clearTimeout(timeout);
        reject(error);
      });
    });
  }

  private parseTestOutput(output: string): any {
    
    const lines = output.split('\n');
    
    let total = 0;
    let passed = 0;
    let failed = 0;
    let skipped = 0;
    const failures: Array<{test: string; error: string; file?: string; line?: number}> = [];
    let coverage: any = null;

    
    for (const line of lines) {
      
      if (line.match(/Tests:\s*(\d+)\s*passed,\s*(\d+)\s*total/)) {
        const match = line.match(/Tests:\s*(\d+)\s*passed,\s*(\d+)\s*total/);
        if (match) {
          passed = parseInt(match[1]);
          total = parseInt(match[2]);
          failed = total - passed;
        }
      }
      
      
      if (line.match(/✓\s*(\d+)\s*passed/)) {
        const match = line.match(/✓\s*(\d+)\s*passed/);
        if (match) passed = parseInt(match[1]);
      }
      
      if (line.match(/✗\s*(\d+)\s*failed/)) {
        const match = line.match(/✗\s*(\d+)\s*failed/);
        if (match) failed = parseInt(match[1]);
      }

      
      if (line.includes('FAIL') || line.includes('✗')) {
        const errorMatch = line.match(/(.+?)\s+(FAIL|✗)\s+(.+)/);
        if (errorMatch) {
          failures.push({
            test: errorMatch[3] || 'Unknown test',
            error: line,
            file: errorMatch[1]
          });
        }
      }

      
      if (line.includes('All files') && line.includes('%')) {
        const coverageMatch = line.match(/(\d+\.?\d*)%/);
        if (coverageMatch) {
          coverage = {
            percentage: parseFloat(coverageMatch[1]),
            lines: { covered: 0, total: 0 },
            functions: { covered: 0, total: 0 }
          };
        }
      }
    }

    
    if (total === 0 && (passed > 0 || failed > 0)) {
      total = passed + failed + skipped;
    }

    return {
      total,
      passed,
      failed,
      skipped,
      failures,
      coverage
    };
  }

  protected async validateConfig(_context: WorkflowContext): Promise<ValidationResult> {
    const config = this.config.config as any;
    const errors: string[] = [];
    const warnings: string[] = [];

    if (config.testCommand !== undefined && typeof config.testCommand !== 'string') {
      errors.push('QAStep: testCommand must be a string');
    }

    if (config.testPath !== undefined && typeof config.testPath !== 'string') {
      errors.push('QAStep: testPath must be a string');
    }

    if (config.timeout !== undefined && (typeof config.timeout !== 'number' || config.timeout < 1000)) {
      errors.push('QAStep: timeout must be a number >= 1000');
    }

    if (config.retryCount !== undefined && (typeof config.retryCount !== 'number' || config.retryCount < 0)) {
      errors.push('QAStep: retryCount must be a non-negative number');
    }

    if (config.failureThreshold !== undefined && (typeof config.failureThreshold !== 'number' || config.failureThreshold < 0 || config.failureThreshold > 100)) {
      errors.push('QAStep: failureThreshold must be a number between 0 and 100');
    }

    if (config.requiredCoverage !== undefined && (typeof config.requiredCoverage !== 'number' || config.requiredCoverage < 0 || config.requiredCoverage > 100)) {
      errors.push('QAStep: requiredCoverage must be a number between 0 and 100');
    }

    if (config.skipOnNoTests !== undefined && typeof config.skipOnNoTests !== 'boolean') {
      errors.push('QAStep: skipOnNoTests must be a boolean');
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings
    };
  }

  async cleanup(context: WorkflowContext): Promise<void> {
    
    const qaResult = context.getVariable('qaResult');
    if (qaResult) {
      logger.debug('Cleaning up QA test results');
    }
  }
}