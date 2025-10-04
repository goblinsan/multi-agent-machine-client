import { cfg } from "./config.js";
import { fetch } from "undici";

export type ChatMessage = { role: "system"|"user"|"assistant"; content: string };

function sleep(ms: number) { return new Promise(resolve => setTimeout(resolve, ms)); }

export async function callLMStudio(model: string, messages: ChatMessage[], temperature = 0.2, opts?: { timeoutMs?: number; retries?: number }) {
  const timeoutMs = opts?.timeoutMs ?? 20000;
  const retries = Math.max(0, Math.floor(opts?.retries ?? 2));
  const url = `${cfg.lmsBaseUrl.replace(/\/$/, "")}/v1/chat/completions`;

  let lastErr: any = null;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model, messages, temperature }),
        signal: controller.signal as any
      });
      clearTimeout(timer);

      if (!res.ok) {
        const text = await res.text().catch(() => "<no body>");
        throw new Error(`LM Studio error ${res.status}: ${text}`);
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
      // If this was the last attempt, rethrow with context
      if (attempt === retries) break;
      // otherwise backoff and retry
      const backoff = Math.min(2000 * (attempt + 1), 10000);
      await sleep(backoff);
    }
  }

  // throw a contextual error
  const errMsg = lastErr && lastErr.message ? String(lastErr.message) : String(lastErr || "fetch failed");
  throw new Error(`callLMStudio fetch failed for ${url}: ${errMsg}`);
}
