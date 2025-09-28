import { cfg } from "./config.js";
import { makeRedis } from "./redisClient.js";
import { RequestSchema } from "./schema.js";
import { SYSTEM_PROMPTS } from "./personas.js";
import { callLMStudio } from "./lmstudio.js";
import { fetchContext, recordEvent } from "./dashboard.js";
import { applyEditOps } from "./fileops.js";

function groupForPersona(p: string) { return `${cfg.groupPrefix}:${p}`; }
function nowIso() { return new Date().toISOString(); }

async function ensureGroups(r: any) {
  for (const p of cfg.allowedPersonas) {
    try { await r.xGroupCreate(cfg.requestStream, groupForPersona(p), "$", { MKSTREAM: true }); } catch {}
  }
  try { await r.xGroupCreate(cfg.eventStream, `${cfg.groupPrefix}:coordinator`, "$", { MKSTREAM: true }); } catch {}
}

async function readOne(r: any, persona: string) {
  const res = await r.xReadGroup(groupForPersona(persona), cfg.consumerId, { key: cfg.requestStream, id: ">" }, { COUNT: 1, BLOCK: 200 }).catch(() => null);
  if (!res) return;
  for (const stream of res) {
    for (const msg of stream.messages) {
      const id = msg.id;
      const fields = msg.message as Record<string, string>;
      await processOne(r, persona, id, fields).catch(async (e: any) => {
        console.error(`[worker][${persona}] error`, e?.message);
        await r.xAdd(cfg.eventStream, "*", {
          workflow_id: fields?.workflow_id ?? "", step: fields?.step ?? "",
          from_persona: persona, status: "error", corr_id: fields?.corr_id ?? "",
          error: String(e?.message || e), ts: nowIso()
        }).catch(()=>{});
        await r.xAck(cfg.requestStream, groupForPersona(persona), id).catch(()=>{});
      });
    }
  }
}

async function main() {
  if (cfg.allowedPersonas.length === 0) { console.error("ALLOWED_PERSONAS is empty; nothing to do."); process.exit(1); }
  const r = await makeRedis(); await ensureGroups(r);
  console.log("[worker] personas:", cfg.allowedPersonas.join(", "));
  while (true) { for (const p of cfg.allowedPersonas) { await readOne(r, p); } }
}

async function processOne(r: any, persona: string, entryId: string, fields: Record<string,string>) {
  const parsed = RequestSchema.safeParse(fields);
  if (!parsed.success) { await r.xAck(cfg.requestStream, groupForPersona(persona), entryId); return; }
  const msg = parsed.data;
  if (msg.to_persona !== persona) { await r.xAck(cfg.requestStream, groupForPersona(persona), entryId); return; }

  const model = cfg.personaModels[persona]; if (!model) throw new Error(`No model mapping for '${persona}'`);
  const ctx = await fetchContext(msg.workflow_id);
  const systemPrompt = SYSTEM_PROMPTS[persona] || `You are the ${persona} agent.`;

  // --- Context scan (pre-model) ---
  let scanSummaryText = "";
  if (persona === "context" && cfg.contextScan) {
    try {
      const specFromPayload = (() => { try { return msg.payload ? JSON.parse(msg.payload) : {}; } catch { return {}; } })();
      const repoRoot = (specFromPayload.repo_root as string) || cfg.repoRoot;
      const include = (specFromPayload.include as string[] | undefined) || cfg.scanInclude;
      const exclude = (specFromPayload.exclude as string[] | undefined) || cfg.scanExclude;
      const max_files = typeof specFromPayload.max_files === "number" ? specFromPayload.max_files : cfg.scanMaxFiles;
      const max_bytes = typeof specFromPayload.max_bytes === "number" ? specFromPayload.max_bytes : cfg.scanMaxBytes;
      const max_depth = typeof specFromPayload.max_depth === "number" ? specFromPayload.max_depth : cfg.scanMaxDepth;
      const track_lines = typeof specFromPayload.track_lines === "boolean" ? specFromPayload.track_lines : cfg.scanTrackLines;
      const track_hash = typeof specFromPayload.track_hash === "boolean" ? specFromPayload.track_hash : cfg.scanTrackHash;

      const { scanRepo, summarize } = await import("./scanRepo.js");
      const files = await scanRepo({ repo_root: repoRoot, include, exclude, max_files, max_bytes, max_depth, track_lines, track_hash });

      const lines = files.map(f => JSON.stringify(f)).join("\n") + "\n";
      const sum = summarize(files);
      const snapshot = {
        repo: repoRoot, generated_at: new Date().toISOString(), totals: sum.totals,
        hotspots: { largest_files: sum.largest, longest_files: sum.longest }
      };
      const summaryMd = [
        "# Context Snapshot", "", `Repo: ${repoRoot}`, `Generated: ${new Date().toISOString()}`, "",
        "## Totals", `- Files: ${sum.totals.files}`, `- Bytes: ${sum.totals.bytes}`, `- Lines: ${sum.totals.lines}`, "",
        "## Largest files (top 20)", ...sum.largest.map(f => `- ${f.path} (${f.bytes} bytes)`), "",
        "## Longest files (top 20)", ...sum.longest.map(f => `- ${f.path} (${f.lines} lines)`)
      ].join("\n");

      const { writeArtifacts } = await import("./artifacts.js");
      await writeArtifacts({
        repoRoot,
        artifacts: { snapshot, filesNdjson: lines, summaryMd },
        apply: cfg.applyEdits && cfg.allowedEditPersonas.includes("context"),
        branchName: `feat/context-${msg.workflow_id}-${(msg.corr_id||"c").slice(0,8)}`,
        commitMessage: `context: snapshot for ${msg.workflow_id}`
      });

      scanSummaryText = `Context scan: files=${sum.totals.files}, bytes=${sum.totals.bytes}, lines=${sum.totals.lines}.`;
    } catch (e:any) {
      scanSummaryText = `Context scan failed: ${String(e?.message || e)}`;
    }
  }

  const userPayload = msg.payload ? msg.payload : "{}";
  const userText = `Intent: ${msg.intent}\nPayload: ${userPayload}\nConstraints/Limits: ${ctx?.limits || ""}\nPersona hints: ${ctx?.personaHints || ""}\nScan: ${scanSummaryText}`;

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
    workflow_id: msg.workflow_id, step: msg.step || "", from_persona: persona,
    status: "done", result: JSON.stringify(result), corr_id: msg.corr_id || "", ts: new Date().toISOString()
  });
  await recordEvent({ workflow_id: msg.workflow_id, step: msg.step, persona, model, duration_ms: duration, corr_id: msg.corr_id, content: resp.content }).catch(()=>{});
  await r.xAck(cfg.requestStream, groupForPersona(persona), entryId);
}

main().catch(e => { console.error("[worker] fatal", e); process.exit(1); });
