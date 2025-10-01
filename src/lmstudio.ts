import { cfg } from "./config.js";
import { fetch } from "undici";

export type ChatMessage = { role: "system"|"user"|"assistant"; content: string };

export async function callLMStudio(model: string, messages: ChatMessage[], temperature = 0.2) {
  const res = await fetch(`${cfg.lmsBaseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, messages, temperature })
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`LM Studio error ${res.status}: ${text}`);
  }
  const data: any = await res.json();
  const content = data?.choices?.[0]?.message?.content ?? "";
  return { content, raw: data };
}
