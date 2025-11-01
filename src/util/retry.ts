


export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}


export interface RetryOptions {
  
  maxRetries?: number;
  
  initialDelayMs?: number;
  
  backoffMultiplier?: number;
  
  maxDelayMs?: number;
  
  addJitter?: boolean;
  
  maxJitterMs?: number;
}


export function calculateBackoffDelay(attempt: number, options: RetryOptions = {}): number {
  const {
    initialDelayMs = 500,
    backoffMultiplier = 2,
    maxDelayMs = 15000,
    addJitter = true,
    maxJitterMs = 300
  } = options;

  
  const baseDelay = initialDelayMs * Math.pow(backoffMultiplier, attempt);
  
  
  const jitter = addJitter ? Math.floor(Math.random() * maxJitterMs) : 0;
  
  
  return Math.min(baseDelay + jitter, maxDelayMs);
}


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
      
      
      if (attempt === maxRetries) {
        break;
      }
      
      
      const delay = calculateBackoffDelay(attempt, options);
      await sleep(delay);
    }
  }
  
  
  throw lastError;
}


export function isRetryableError(
  error: string | Error,
  retryablePatterns?: string[]
): boolean {
  const errorMessage = typeof error === 'string' ? error : error.message;
  const lowerError = errorMessage.toLowerCase();
  
  
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
