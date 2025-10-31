import { logger } from '../../../logger.js';
import { sleep, isRetryableError as utilIsRetryableError } from '../../../util/retry.js';

export interface RetryConfig {
  max_attempts?: number;
  initial_delay_ms?: number;
  backoff_multiplier?: number;
  retryable_errors?: string[];
}

export interface RetryContext {
  stepName: string;
  operation: string;
}

export class RetryHandler {
  async executeWithRetry<T>(
    operation: () => Promise<T>,
    config: RetryConfig,
    context: RetryContext,
    shouldRetry: (result: T, error: Error | null) => boolean
  ): Promise<{ result: T | null; lastError: Error | null }> {
    const maxAttempts = config.max_attempts || 3;
    const initialDelay = config.initial_delay_ms || 1000;
    const backoffMultiplier = config.backoff_multiplier || 2;

    let result: T | null = null;
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        if (attempt > 1) {
          const delay = initialDelay * Math.pow(backoffMultiplier, attempt - 2);
          logger.info('Retrying operation', {
            stepName: context.stepName,
            operation: context.operation,
            attempt,
            maxAttempts,
            delay_ms: delay,
            backoff_strategy: 'exponential'
          });
          await sleep(delay);
        }

        logger.info(`Operation attempt ${attempt}/${maxAttempts}`, {
          stepName: context.stepName,
          operation: context.operation
        });

        result = await operation();

        if (!shouldRetry(result, null)) {
          logger.info('Operation succeeded', {
            stepName: context.stepName,
            operation: context.operation,
            attempt
          });
          break;
        }

        if (attempt < maxAttempts) {
          logger.warn('Operation requires retry', {
            stepName: context.stepName,
            operation: context.operation,
            attempt
          });
        }

      } catch (error: any) {
        lastError = error instanceof Error ? error : new Error(String(error));
        
        logger.error('Operation attempt failed', {
          stepName: context.stepName,
          operation: context.operation,
          attempt,
          maxAttempts,
          error: lastError.message
        });

        if (attempt === maxAttempts) {
          break;
        }
      }
    }

    return { result, lastError };
  }

  hasRetryableErrors(errors: string[], retryableErrorPatterns?: string[]): boolean {
    if (!errors || errors.length === 0) {
      return false;
    }

    const patterns = retryableErrorPatterns || ['timeout', 'network', 'connection', 'ECONNREFUSED', 'ETIMEDOUT'];

    return errors.some(error => 
      patterns.some(pattern => 
        error.toLowerCase().includes(pattern.toLowerCase())
      )
    );
  }
}
