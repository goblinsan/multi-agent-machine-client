import { cfg } from "./config.js";
import { fetch } from "undici";
import { logger } from "./logger.js";
import { sleep, calculateBackoffDelay } from "./util/retry.js";
import { lmStudioCircuitBreaker } from "./services/LMStudioCircuitBreaker.js";

export type ChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

export async function callLMStudio(
  model: string,
  messages: ChatMessage[],
  temperature = 0.2,
  opts?: { timeoutMs?: number; retries?: number },
) {
  const timeoutMs = opts?.timeoutMs ?? 20000;
  const maxRetries = Math.max(0, Math.floor(opts?.retries ?? 3));
  const url = `${cfg.lmsBaseUrl.replace(/\/$/, "")}/v1/chat/completions`;

  if (!lmStudioCircuitBreaker.canExecute()) {
    const stats = lmStudioCircuitBreaker.getStats();
    const err = new Error(
      `LM Studio circuit breaker is OPEN — ${stats.failureCount} failures, ${stats.consecutiveAborts} consecutive aborts. Will retry after reset timeout.`,
    );
    (err as any).circuitBreakerOpen = true;
    logger.error("callLMStudio rejected by circuit breaker", {
      url,
      model,
      state: stats.state,
      failureCount: stats.failureCount,
      consecutiveAborts: stats.consecutiveAborts,
    });
    throw err;
  }

  let lastErr: any = null;
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    if (attempt > 0 && !lmStudioCircuitBreaker.canExecute()) {
      const stats = lmStudioCircuitBreaker.getStats();
      lastErr = new Error(
        `LM Studio circuit breaker tripped during retries — ${stats.failureCount} failures, ${stats.consecutiveAborts} consecutive aborts`,
      );
      (lastErr as any).circuitBreakerOpen = true;
      break;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
      };

      if ((cfg as any).lmsApiKey)
        headers["Authorization"] = `Bearer ${(cfg as any).lmsApiKey}`;

      const payload = { model, messages, temperature };
      logger.debug("callLMStudio attempt", { url, attempt, timeoutMs, model });

      const res = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
        signal: controller.signal as any,
      });
      clearTimeout(timer);

      if (!res.ok) {
        const text = await res.text().catch(() => "<no body>");
        const statusErr = new Error(`LM Studio error ${res.status}: ${text}`);
        logger.warn("callLMStudio non-ok response", {
          url,
          status: res.status,
          body: text,
          attempt,
        });
        lmStudioCircuitBreaker.recordFailure(false);
        throw statusErr;
      }
      const data: any = await res.json().catch(() => null);
      const content = data?.choices?.[0]?.message?.content ?? "";
      lmStudioCircuitBreaker.recordSuccess();
      return { content, raw: data };
    } catch (err: any) {
      clearTimeout(timer);
      const isAbort = !!(
        err &&
        (err.name === "AbortError" || err.type === "aborted")
      );

      if (isAbort) {
        lastErr = new Error(`LM Studio request aborted after ${timeoutMs}ms`);
        lmStudioCircuitBreaker.recordFailure(true);
      } else if (!(err as any).circuitBreakerOpen) {
        lastErr = err;
        const isConnError = !!(
          err.code === "ECONNREFUSED" ||
          err.code === "ECONNRESET" ||
          err.code === "ENOTFOUND"
        );
        lmStudioCircuitBreaker.recordFailure(isConnError);
      } else {
        lastErr = err;
      }

      logger.warn("callLMStudio attempt failed", {
        url,
        attempt,
        errorName: err?.name,
        errorMessage: err?.message,
        code: err?.code,
        circuitBreaker: lmStudioCircuitBreaker.getStats().state,
        stack: err?.stack ? String(err.stack).slice(0, 200) : undefined,
      });

      if (attempt === maxRetries) break;
      if ((lastErr as any)?.circuitBreakerOpen) break;

      const backoff = calculateBackoffDelay(attempt, {
        initialDelayMs: 500,
        backoffMultiplier: 2,
        maxDelayMs: 15000,
        addJitter: true,
        maxJitterMs: 300,
      });
      await sleep(backoff);
    }
  }

  const errDetails =
    lastErr && typeof lastErr === "object"
      ? lastErr.message || String(lastErr)
      : String(lastErr || "fetch failed");
  const err = new Error(`callLMStudio fetch failed for ${url}: ${errDetails}`);

  (err as any).cause = lastErr;
  (err as any).circuitBreakerOpen =
    !!(lastErr as any)?.circuitBreakerOpen ||
    !lmStudioCircuitBreaker.canExecute();
  logger.error("callLMStudio failed after retries", {
    url,
    error: errDetails,
    circuitBreaker: lmStudioCircuitBreaker.getStats().state,
  });
  throw err;
}
