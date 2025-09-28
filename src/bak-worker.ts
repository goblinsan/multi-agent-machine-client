import { cfg } from "./config.js";
import { makeRedis } from "./redisClient.js";
import { RequestSchema } from "./schema.js";
import { SYSTEM_PROMPTS } from "./personas.js";
import { callLMStudio } from "./lmstudio.js";
import { fetchContext, recordEvent } from "./dashboard.js";

function groupForPersona(p: string) {
  return `${cfg.groupPrefix}:${p}`;
}
function nowIso() { return new Date().toISOString(); }

async function ensureGroups(r: any) {
  for (const p of cfg.allowedPersonas) {
    try {
      await r.xGroupCreate(cfg.requestStream, groupForPersona(p), "$", { MKSTREAM: true });
      console.log("[redis] created group", groupForPersona(p));
    } catch {}
  }
  try { await r.xGroupCreate(cfg.eventStream, `${cfg.groupPrefix}:coordinator`, "$", { MKSTREAM: true }); } catch {}
}

async function readOne(r: any, persona: string) {
  // node-redis v4 shape:
  // Array<{ name: string, messages: Array<{ id: string, message: Record<string,string> }> }>
  const res = await r
    .xReadGroup(groupForPersona(persona), cfg.consumerId, { key: cfg.requestStream, id: ">" }, { COUNT: 1, BLOCK: 200 })
    .catch(() => null);

  if (!res) return;
  for (const stream of res) {
    for (const msg of stream.messages) {
      const id = msg.id;
      const fields = msg.message as Record<string, string>;

      await processOne(r, persona, id, fields).catch(async (e: any) => {
        console.error(`[worker][${persona}] error`, e?.message);
        // emit error event
        await r.xAdd(cfg.eventStream, "*", {
          workflow_id: fields?.workflow_id ?? "",
          step: fields?.step ?? "",
          from_persona: persona,
          status: "error",
          corr_id: fields?.corr_id ?? "",
          error: String(e?.message || e),
          ts: nowIso()
        }).catch(() => {});
        // always ack so it doesn’t get stuck in PEL
        await r.xAck(cfg.requestStream, groupForPersona(persona), id).catch(() => {});
      });
    }
  }
}


async function main() {
  if (cfg.allowedPersonas.length === 0) {
    console.error("ALLOWED_PERSONAS is empty; nothing to do.");
    process.exit(1);
  }
  const r = await makeRedis();
  await ensureGroups(r);

  console.log("[worker] personas:", cfg.allowedPersonas.join(", "));
  while (true) {
    for (const p of cfg.allowedPersonas) {
      await readOne(r, p);
    }
  }
}

async function processOne(r: any, persona: string, entryId: string, fields: Record<string,string>) {
  const parsed = RequestSchema.safeParse(fields);
  if (!parsed.success) {
    console.warn(`[worker][${persona}] invalid message`, parsed.error.issues);
    await r.xAck(cfg.requestStream, groupForPersona(persona), entryId);
    return;
  }
  const msg = parsed.data;
  if (msg.to_persona !== persona) {
    await r.xAck(cfg.requestStream, groupForPersona(persona), entryId);
    return;
  }

  const model = cfg.personaModels[persona];
  if (!model) throw new Error(`No model mapping for persona '${persona}'`);

  const ctx = await fetchContext(msg.workflow_id);
  const systemPrompt = SYSTEM_PROMPTS[persona] || `You are the ${persona} agent.`;

  const userPayload = msg.payload ? msg.payload : "{}";
  const userText = `Intent: ${msg.intent}\nPayload: ${userPayload}\nConstraints/Limits: ${ctx?.limits || ""}\nPersona hints: ${ctx?.personaHints || ""}`;

  const messages = [
    { role: "system", content: systemPrompt },
    { role: "system", content: `Project context (summary):\nTree: ${ctx?.projectTree || ""}\nHotspots: ${ctx?.fileHotspots || ""}` },
    { role: "user", content: userText }
  ] as any;

  const started = Date.now();
  const resp = await callLMStudio(model, messages, 0.2);
  const duration = Date.now() - started;

  const result = { output: resp.content, model, duration_ms: duration };
  await r.xAdd(cfg.eventStream, "*", {
    workflow_id: msg.workflow_id,
    step: msg.step || "",
    from_persona: persona,
    status: "done",
    result: JSON.stringify(result),
    corr_id: msg.corr_id || "",
    ts: new Date().toISOString()
  });

  await recordEvent({
    workflow_id: msg.workflow_id, step: msg.step, persona, model,
    duration_ms: duration, corr_id: msg.corr_id, content: resp.content
  }).catch(()=>{});

  await r.xAck(cfg.requestStream, groupForPersona(persona), entryId);
}

main().catch(e => { console.error("[worker] fatal", e); process.exit(1); });
