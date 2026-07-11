import { fetch, Agent } from "undici";
import { cfg } from "./config.js";
import { logger } from "./logger.js";
import { sleep, calculateBackoffDelay } from "./util/retry.js";
import { lmStudioCircuitBreaker } from "./services/LMStudioCircuitBreaker.js";

const dispatcher = new Agent({
  headersTimeout: 0,
  bodyTimeout: 0,
  keepAliveTimeout: 10 * 60 * 1000,
});

export type ChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

export type ResponseFormat = {
  type: "json_schema";
  json_schema: {
    name: string;
    strict?: boolean;
    schema: Record<string, unknown>;
  };
};

export async function callLMStudio(
  model: string,
  messages: ChatMessage[],
  temperature = 0.2,
  opts?: {
    timeoutMs?: number;
    retries?: number;
    responseFormat?: ResponseFormat;
    maxTokens?: number;
    frequencyPenalty?: number;
  },
) {
  const timeoutMs = opts?.timeoutMs ?? 20000;
  const maxRetries = Math.max(0, Math.floor(opts?.retries ?? 3));
  const url = `${cfg.lmsBaseUrl.replace(/\/$/, "")}/v1/chat/completions`;
  let responseFormat = opts?.responseFormat;

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

      const payload: Record<string, unknown> = { model, messages, temperature };
      const maxTokens = opts?.maxTokens ?? cfg.lmsMaxTokens ?? 6000;
      if (Number.isFinite(maxTokens) && maxTokens > 0) {
        payload.max_tokens = Math.floor(maxTokens);
      }
      const frequencyPenalty =
        opts?.frequencyPenalty ?? cfg.lmsFrequencyPenalty ?? 0.5;
      if (
        Number.isFinite(frequencyPenalty) &&
        frequencyPenalty >= -2 &&
        frequencyPenalty <= 2
      ) {
        payload.frequency_penalty = frequencyPenalty;
      }
      if (responseFormat) payload.response_format = responseFormat;
      logger.debug("callLMStudio attempt", {
        url,
        attempt,
        timeoutMs,
        model,
        structured: !!responseFormat,
      });

      const res = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
        signal: controller.signal as any,
        dispatcher,
      });
      clearTimeout(timer);

      if (!res.ok) {
        const text = await res.text().catch(() => "<no body>");

        if (
          res.status === 400 &&
          responseFormat &&
          !isPromptTooLargeResponse(text)
        ) {
          logger.warn(
            "callLMStudio: server rejected response_format, retrying without structured output",
            { url, model, body: text.slice(0, 300) },
          );
          responseFormat = undefined;
          attempt -= 1;
          continue;
        }

        const statusErr = new Error(`LM Studio error ${res.status}: ${text}`);
        if (res.status === 400 && isPromptTooLargeResponse(text)) {
          (statusErr as any).promptTooLarge = true;
          (statusErr as any).nonRetryable = true;
        }
        logger.warn("callLMStudio non-ok response", {
          url,
          status: res.status,
          body: text,
          attempt,
        });
        throw statusErr;
      }
      const data: any = await res.json().catch(() => null);
      const content = data?.choices?.[0]?.message?.content ?? "";
      const finishReason = data?.choices?.[0]?.finish_reason;
      if (finishReason === "length") {
        logger.warn(
          "callLMStudio response truncated at max_tokens - output was too large",
          { url, model, maxTokens: payload.max_tokens, contentLength: content.length },
        );
      }
      lmStudioCircuitBreaker.recordSuccess();
      return { content, raw: data, finishReason };
    } catch (err: any) {
      clearTimeout(timer);
      const isAbort = !!(
        err &&
        (err.name === "AbortError" || err.type === "aborted")
      );

      if (isAbort) {
        lastErr = new Error(`LM Studio request aborted after ${timeoutMs}ms`);
        lmStudioCircuitBreaker.recordFailure(true);
        break;
      } else if ((err as any).promptTooLarge || (err as any).nonRetryable) {
        lastErr = err;
        logger.warn("callLMStudio non-retryable request error", {
          url,
          attempt,
          errorMessage: err?.message,
          promptTooLarge: !!(err as any).promptTooLarge,
        });
        break;
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
  (err as any).promptTooLarge = !!(lastErr as any)?.promptTooLarge;
  (err as any).nonRetryable = !!(lastErr as any)?.nonRetryable;
  logger.error("callLMStudio failed after retries", {
    url,
    error: errDetails,
    circuitBreaker: lmStudioCircuitBreaker.getStats().state,
  });
  throw err;
}

function isPromptTooLargeResponse(body: string): boolean {
  const normalized = body.toLowerCase();
  return (
    normalized.includes("context length") ||
    normalized.includes("number of tokens to keep") ||
    normalized.includes("prompt is too long") ||
    normalized.includes("maximum context")
  );
}
