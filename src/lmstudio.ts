import { cfg } from "./config.js";
import { fetch } from "undici";
import { logger } from "./logger.js";
import { sleep, calculateBackoffDelay } from "./util/retry.js";

export type ChatMessage = { role: "system"|"user"|"assistant"; content: string };

export async function callLMStudio(model: string, messages: ChatMessage[], temperature = 0.2, opts?: { timeoutMs?: number; retries?: number }) {
  const timeoutMs = opts?.timeoutMs ?? 20000;
  const maxRetries = Math.max(0, Math.floor(opts?.retries ?? 3));
  const url = `${cfg.lmsBaseUrl.replace(/\/$/, "")}/v1/chat/completions`;

  let lastErr: any = null;
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const headers: Record<string,string> = { "Content-Type": "application/json" };
      // allow LM Studio API key via config if present
      if ((cfg as any).lmsApiKey) headers["Authorization"] = `Bearer ${(cfg as any).lmsApiKey}`;

      const payload = { model, messages, temperature };
      logger.debug("callLMStudio attempt", { url, attempt, timeoutMs, model });

      const res = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
        signal: controller.signal as any
      });
      clearTimeout(timer);

      if (!res.ok) {
        const text = await res.text().catch(() => "<no body>");
        const statusErr = new Error(`LM Studio error ${res.status}: ${text}`);
        logger.warn("callLMStudio non-ok response", { url, status: res.status, body: text, attempt });
        throw statusErr;
      }
      const data: any = await res.json().catch(() => null);
      const content = data?.choices?.[0]?.message?.content ?? "";
      return { content, raw: data };
    } catch (err: any) {
      clearTimeout(timer);
      lastErr = err;
      // If aborted due to timeout, mark clearly
      if (err && (err.name === 'AbortError' || err.type === 'aborted')) {
        lastErr = new Error(`LM Studio request aborted after ${timeoutMs}ms`);
      }
      // Log network/undici-specific errors with details
      logger.warn("callLMStudio attempt failed", { url, attempt, errorName: err?.name, errorMessage: err?.message, code: err?.code, stack: err?.stack ? String(err.stack).slice(0,200) : undefined });

      // If last attempt, break and rethrow a contextual error below
      if (attempt === maxRetries) break;

      // exponential backoff with jitter
      const backoff = calculateBackoffDelay(attempt, {
        initialDelayMs: 500,
        backoffMultiplier: 2,
        maxDelayMs: 15000,
        addJitter: true,
        maxJitterMs: 300
      });
      await sleep(backoff);
    }
  }

  const errDetails = lastErr && typeof lastErr === 'object' ? (lastErr.message || String(lastErr)) : String(lastErr || 'fetch failed');
  const err = new Error(`callLMStudio fetch failed for ${url}: ${errDetails}`);
  // attach original error for callers that inspect it
  (err as any).cause = lastErr;
  logger.error("callLMStudio failed after retries", { url, error: errDetails });
  throw err;
}
