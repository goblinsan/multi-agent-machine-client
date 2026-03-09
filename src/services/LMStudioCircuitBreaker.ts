import { logger } from "../logger.js";

export type CircuitState = "closed" | "open" | "half-open";

export interface CircuitBreakerConfig {
  failureThreshold: number;
  resetTimeoutMs: number;
  halfOpenMaxAttempts: number;
  consecutiveAbortThreshold: number;
}

const DEFAULT_CONFIG: CircuitBreakerConfig = {
  failureThreshold: 5,
  resetTimeoutMs: 120_000,
  halfOpenMaxAttempts: 1,
  consecutiveAbortThreshold: 3,
};

export class LMStudioCircuitBreaker {
  private state: CircuitState = "closed";
  private failureCount = 0;
  private consecutiveAborts = 0;
  private lastFailureTime = 0;
  private halfOpenAttempts = 0;
  private readonly config: CircuitBreakerConfig;

  constructor(config?: Partial<CircuitBreakerConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  getState(): CircuitState {
    if (this.state === "open" && this.shouldAttemptReset()) {
      this.state = "half-open";
      this.halfOpenAttempts = 0;
      logger.info("LM Studio circuit breaker transitioning to half-open", {
        failureCount: this.failureCount,
        consecutiveAborts: this.consecutiveAborts,
        elapsedMs: Date.now() - this.lastFailureTime,
      });
    }
    return this.state;
  }

  canExecute(): boolean {
    const current = this.getState();
    if (current === "closed") return true;
    if (current === "half-open") {
      return this.halfOpenAttempts < this.config.halfOpenMaxAttempts;
    }
    return false;
  }

  recordSuccess(): void {
    if (this.state === "half-open") {
      logger.info("LM Studio circuit breaker closing after successful probe", {
        previousFailures: this.failureCount,
        previousAborts: this.consecutiveAborts,
      });
    }
    this.state = "closed";
    this.failureCount = 0;
    this.consecutiveAborts = 0;
    this.halfOpenAttempts = 0;
  }

  recordFailure(isAbort: boolean): void {
    this.failureCount += 1;
    this.lastFailureTime = Date.now();

    if (isAbort) {
      this.consecutiveAborts += 1;
    } else {
      this.consecutiveAborts = 0;
    }

    if (this.state === "half-open") {
      this.halfOpenAttempts += 1;
      this.trip("half-open probe failed");
      return;
    }

    if (this.consecutiveAborts >= this.config.consecutiveAbortThreshold) {
      this.trip(
        `${this.consecutiveAborts} consecutive abort errors (threshold: ${this.config.consecutiveAbortThreshold})`,
      );
      return;
    }

    if (this.failureCount >= this.config.failureThreshold) {
      this.trip(
        `${this.failureCount} total failures (threshold: ${this.config.failureThreshold})`,
      );
    }
  }

  reset(): void {
    this.state = "closed";
    this.failureCount = 0;
    this.consecutiveAborts = 0;
    this.halfOpenAttempts = 0;
    this.lastFailureTime = 0;
  }

  getStats(): {
    state: CircuitState;
    failureCount: number;
    consecutiveAborts: number;
    lastFailureTime: number;
  } {
    return {
      state: this.getState(),
      failureCount: this.failureCount,
      consecutiveAborts: this.consecutiveAborts,
      lastFailureTime: this.lastFailureTime,
    };
  }

  private trip(reason: string): void {
    this.state = "open";
    logger.error("LM Studio circuit breaker OPEN — requests will be rejected", {
      reason,
      failureCount: this.failureCount,
      consecutiveAborts: this.consecutiveAborts,
      resetTimeoutMs: this.config.resetTimeoutMs,
      willRetryAt: new Date(
        this.lastFailureTime + this.config.resetTimeoutMs,
      ).toISOString(),
    });
  }

  private shouldAttemptReset(): boolean {
    return Date.now() - this.lastFailureTime >= this.config.resetTimeoutMs;
  }
}

export const lmStudioCircuitBreaker = new LMStudioCircuitBreaker();
