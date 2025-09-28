import { cfg } from "./config.js";
import { makeRedis } from "./redisClient.js";
import { RequestSchema } from "./schema.js";
import { SYSTEM_PROMPTS } from "./personas.js";
import { callLMStudio } from "./lmstudio.js";
import { fetchContext, recordEvent } from "./dashboard.js";
import { applyEditOps } from "./fileops.js";

function groupForPersona(p: string) { return `${cfg.groupPrefix}:${p}`; }
function nowIso() { return new Date().toISOString(); }

function normalizeRepoPath(p: string | undefined, fallback: string) {
  if (!p || typeof p !== "string") return fallback;
  const unescaped = p.replace(/\\\\/g, "\\"); // collapse escaped backslashes
  const m = /^([A-Za-z]):\\(.*)$/.exec(unescaped);
  if (m) {
    const drive = m[1].toLowerCase();
    const rest = m[2].replace(/\\/g, "/");
    return `/mnt/${drive}/${rest}`;
  }
  const m2 = /^([A-Za-z]):\/(.*)$/.exec(p);
  if (m2) {
    return `/mnt/${m2[1].toLowerCase()}/${m2[2]}`;
  }
  return p.replace(/\\/g, "/");
}

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
  console.log("[cfg] repoRoot:", cfg.repoRoot, "contextScan:", cfg.contextScan, "summaryMode:", cfg.summaryMode);
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

  // --- Context scan (pre-model), supports multi-components & Alembic ---
  let scanSummaryText = "";
  let scanArtifacts: null | { repoRoot: string; ndjson: string; snapshot: any; summaryMd: string; paths: string[] } = null;
  if (persona === "context" && cfg.contextScan) {
    try {
      const specFromPayload = (() => { try { return msg.payload ? JSON.parse(msg.payload) : {}; } catch { return {}; } })();
      const repoRootRaw = (specFromPayload.repo_root as string) || cfg.repoRoot;
      const repoRoot = normalizeRepoPath(repoRootRaw, cfg.repoRoot);
      const components = Array.isArray(specFromPayload.components) ? specFromPayload.components
                        : (Array.isArray(cfg.scanComponents) ? cfg.scanComponents : null);

      const { scanRepo, summarize } = await import("./scanRepo.js");
      type Comp = { base: string; include: string[]; exclude: string[] };
      const comps: Comp[] = components && components.length
        ? components.map((c:any)=>({ base: String(c.base||"").replace(/\\/g,"/"), include: (c.include||cfg.scanInclude), exclude: (c.exclude||cfg.scanExclude) }))
        : [{ base: "", include: cfg.scanInclude, exclude: cfg.scanExclude }];

      let allFiles: any[] = [];
      const perComp: any[] = [];

      for (const c of comps) {
        const basePath = (c.base && c.base.length) ? (repoRoot.replace(/\/$/,'') + "/" + c.base.replace(/^\//,'')) : repoRoot;
        const files = await scanRepo({
          repo_root: basePath,
          include: c.include,
          exclude: c.exclude,
          max_files: cfg.scanMaxFiles,
          max_bytes: cfg.scanMaxBytes,
          max_depth: cfg.scanMaxDepth,
          track_lines: cfg.scanTrackLines,
          track_hash: cfg.scanTrackHash
        });
        const prefixed = files.map(f => ({ ...f, path: (c.base ? (c.base.replace(/^\/+|\/+$/g,'') + '/' + f.path) : f.path) }));
        allFiles.push(...prefixed);
        const sum = summarize(prefixed);
        perComp.push({ component: c.base || ".", totals: sum.totals, largest: sum.largest.slice(0,10), longest: sum.longest.slice(0,10) });
      }

      const ndjson = allFiles.map(f => JSON.stringify(f)).join("\n") + "\n";
      const { summarize: summarize2 } = await import("./scanRepo.js");
      const global = summarize2(allFiles);

      // Build scanMd with Alembic awareness
      const scanMd = (() => {
        const lines: string[] = [];
        lines.push("# Context Snapshot (Scan)", "", `Repo: ${repoRoot}`, `Generated: ${new Date().toISOString()}`, "", "## Totals");
        lines.push(`- Files: ${global.totals.files}`, `- Bytes: ${global.totals.bytes}`, `- Lines: ${global.totals.lines}`, "", "## Components");
        for (const pc of perComp) {
          lines.push(`### ${pc.component}`, `- Files: ${pc.totals.files}`, `- Bytes: ${pc.totals.bytes}`, `- Lines: ${pc.totals.lines}`);
          lines.push(`- Largest (top 10):`);
          for (const f of pc.largest) lines.push(`  - ${f.path} (${f.bytes} bytes)`);
          lines.push(`- Longest (top 10):`);
          for (const f of pc.longest) lines.push(`  - ${f.path} (${f.lines || 0} lines)`);
          lines.push("");
        }
        // Alembic detection
        const alembicFiles = allFiles.filter(f => /(^|\/)alembic(\/|$)/i.test(f.path));
        if (alembicFiles.length) {
          const versions = alembicFiles.filter(f => /(^|\/)alembic(\/|$).*\bversions\b(\/|$).+\.py$/i.test(f.path));
          const latest = [...versions].sort((a,b)=> (b.mtime||0) - (a.mtime||0)).slice(0, 10);
          lines.push("## Alembic Migrations");
          lines.push(`- Alembic tree detected (files: ${alembicFiles.length}, versions: ${versions.length})`);
          lines.push(versions.length ? "- Latest versions (by modified time):" : "- No versioned migrations found under alembic/versions");
          for (const f of latest) {
            lines.push(`  - ${f.path}  (mtime=${new Date(f.mtime).toISOString()}, bytes=${f.bytes}${typeof f.lines==='number'?`, lines=${f.lines}`:''})`);
          }
          lines.push("");
        }
        return lines.join("\n");
      })();

      const snapshot = {
        repo: repoRoot,
        generated_at: new Date().toISOString(),
        totals: global.totals,
        components: perComp,
        hotspots: { largest_files: global.largest, longest_files: global.longest }
      };

      const { writeArtifacts } = await import("./artifacts.js");
      const writeRes = await writeArtifacts({
        repoRoot,
        artifacts: { snapshot, filesNdjson: ndjson, summaryMd: scanMd },
        apply: cfg.applyEdits && cfg.allowedEditPersonas.includes("context"),
        branchName: `feat/context-${msg.workflow_id}-${(msg.corr_id||"c").slice(0,8)}`,
        commitMessage: `context: snapshot for ${msg.workflow_id}`
      });

      scanArtifacts = { repoRoot, ndjson, snapshot, summaryMd: scanMd, paths: writeRes.paths };
      scanSummaryText = `Context scan: files=${global.totals.files}, bytes=${global.totals.bytes}, lines=${global.totals.lines}, components=${perComp.length}.`;
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

  // After model call: write/replace summary.md per SUMMARY_MODE
  if (persona === "context" && scanArtifacts) {
    try {
      const fs = await import("fs/promises");
      const path = await import("path");
      const summaryPath = path.resolve(scanArtifacts.repoRoot, ".ma/context/summary.md");
      let contentToWrite = resp.content;
      if (cfg.summaryMode === "scan") contentToWrite = scanArtifacts.summaryMd;
      if (cfg.summaryMode === "both") {
        contentToWrite = `# Model Summary\n\n${resp.content}\n\n---\n\n` + scanArtifacts.summaryMd;
      }
      await fs.mkdir(path.dirname(summaryPath), { recursive: true });
      await fs.writeFile(summaryPath, contentToWrite, "utf8");
    } catch (e:any) {
      console.warn("[context] failed to write model summary.md:", e?.message);
    }
  }

  const result = { output: resp.content, model, duration_ms: duration };
  await r.xAdd(cfg.eventStream, "*", {
    workflow_id: msg.workflow_id, step: msg.step || "", from_persona: persona,
    status: "done", result: JSON.stringify(result), corr_id: msg.corr_id || "", ts: new Date().toISOString()
  });
  await recordEvent({ workflow_id: msg.workflow_id, step: msg.step, persona, model, duration_ms: duration, corr_id: msg.corr_id, content: resp.content }).catch(()=>{});
  await r.xAck(cfg.requestStream, groupForPersona(persona), entryId);
}

main().catch(e => { console.error("[worker] fatal", e); process.exit(1); });
