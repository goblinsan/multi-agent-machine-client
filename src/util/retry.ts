/**
 * Retry utilities with exponential backoff
 */

/**
 * Sleep for specified milliseconds
 */
export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Retry configuration options
 */
export interface RetryOptions {
  /** Maximum number of retry attempts (default: 3) */
  maxRetries?: number;
  /** Initial delay in milliseconds before first retry (default: 500) */
  initialDelayMs?: number;
  /** Backoff multiplier for exponential backoff (default: 2) */
  backoffMultiplier?: number;
  /** Maximum delay cap in milliseconds (default: 15000) */
  maxDelayMs?: number;
  /** Whether to add random jitter to backoff (default: true) */
  addJitter?: boolean;
  /** Maximum jitter in milliseconds (default: 300) */
  maxJitterMs?: number;
}

/**
 * Calculate exponential backoff delay with optional jitter
 * 
 * @param attempt Current attempt number (0-based)
 * @param options Retry options
 * @returns Delay in milliseconds
 */
export function calculateBackoffDelay(attempt: number, options: RetryOptions = {}): number {
  const {
    initialDelayMs = 500,
    backoffMultiplier = 2,
    maxDelayMs = 15000,
    addJitter = true,
    maxJitterMs = 300
  } = options;

  // Exponential backoff: initialDelay * multiplier^attempt
  const baseDelay = initialDelayMs * Math.pow(backoffMultiplier, attempt);
  
  // Add random jitter if enabled
  const jitter = addJitter ? Math.floor(Math.random() * maxJitterMs) : 0;
  
  // Cap at maximum delay
  return Math.min(baseDelay + jitter, maxDelayMs);
}

/**
 * Execute a function with retry logic and exponential backoff
 * 
 * @param fn Function to execute (can be async)
 * @param options Retry configuration
 * @returns Promise resolving to function result
 * @throws Error if all retry attempts fail
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {}
): Promise<T> {
  const { maxRetries = 3 } = options;
  
  let lastError: any = null;
  
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      
      // If this was the last attempt, throw
      if (attempt === maxRetries) {
        break;
      }
      
      // Calculate and wait for backoff delay
      const delay = calculateBackoffDelay(attempt, options);
      await sleep(delay);
    }
  }
  
  // All attempts failed
  throw lastError;
}

/**
 * Check if an error message matches retryable patterns
 * 
 * @param error Error message or Error object
 * @param retryablePatterns Array of patterns to match (case-insensitive)
 * @returns true if error matches any retryable pattern
 */
export function isRetryableError(
  error: string | Error,
  retryablePatterns?: string[]
): boolean {
  const errorMessage = typeof error === 'string' ? error : error.message;
  const lowerError = errorMessage.toLowerCase();
  
  // Default retryable patterns
  const defaultPatterns = [
    'timeout',
    'ETIMEDOUT',
    'ESOCKETTIMEDOUT',
    'ECONNRESET',
    'ECONNREFUSED',
    'ENOTFOUND',
    'network',
    'rate limit',
    '429',
    '500',
    '502',
    '503',
    '504'
  ];
  
  const patterns = retryablePatterns || defaultPatterns;
  
  return patterns.some(pattern => 
    lowerError.includes(pattern.toLowerCase())
  );
}
