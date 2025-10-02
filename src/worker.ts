import { randomUUID } from "crypto";
import { cfg } from "./config.js";
import { makeRedis } from "./redisClient.js";
import { RequestSchema } from "./schema.js";
import { SYSTEM_PROMPTS } from "./personas.js";
import { callLMStudio } from "./lmstudio.js";
import { fetchContext, recordEvent, uploadContextSnapshot, fetchProjectStatus } from "./dashboard.js";
import { resolveRepoFromPayload, getRepoMetadata, commitAndPushPaths, checkoutBranchFromBase, ensureBranchPublished } from "./gitUtils.js";
import { logger } from "./logger.js";

function groupForPersona(p: string) { return `${cfg.groupPrefix}:${p}`; }
function nowIso() { return new Date().toISOString(); }

function firstString(...values: any[]): string | null {
  for (const value of values) {
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (trimmed.length) return trimmed;
    }
  }
  return null;
}

function shouldUploadDashboardFlag(value: any): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    return !["0", "false", "no", "off"].includes(normalized);
  }
  return Boolean(value);
}

const PERSONA_WAIT_TIMEOUT_MS = Number(process.env.COORDINATOR_WAIT_TIMEOUT_MS || 600000);

function slugify(value: string) {
  return (value || "").toString().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").replace(/-{2,}/g, "-") || "milestone";
}

type PersonaEvent = { id: string; fields: Record<string, string> };

async function waitForPersonaCompletion(
  r: any,
  persona: string,
  workflowId: string,
  corrId: string,
  timeoutMs = PERSONA_WAIT_TIMEOUT_MS
): Promise<PersonaEvent> {
  const started = Date.now();
  let lastId = "$";

  while (Date.now() - started < timeoutMs) {
    const remaining = timeoutMs - (Date.now() - started);
    const blockMs = Math.max(1000, Math.min(remaining, 5000));
    const streams = await r.xRead([{ key: cfg.eventStream, id: lastId }], { BLOCK: blockMs, COUNT: 20 }).catch(() => null);
    if (!streams) continue;

    for (const stream of streams) {
      for (const message of stream.messages) {
        lastId = message.id;
        const rawFields = message.message as Record<string, string>;
        const fields: Record<string, string> = {};
        for (const [k, v] of Object.entries(rawFields)) fields[k] = typeof v === "string" ? v : String(v);
        if (
          fields.workflow_id === workflowId &&
          fields.from_persona === persona &&
          fields.status === "done" &&
          (!corrId || fields.corr_id === corrId)
        ) {
          return { id: message.id, fields };
        }
      }
      const messages = stream.messages;
      if (messages.length) lastId = messages[messages.length - 1].id;
    }
  }

  throw new Error(`Timed out waiting for ${persona} completion (workflow ${workflowId}, corr ${corrId})`);
}

function parseEventResult(result: string | undefined) {
  if (!result) return null;
  try {
    return JSON.parse(result);
  } catch {
    return { raw: result };
  }
}

async function sendPersonaRequest(r: any, opts: {
  workflowId: string;
  toPersona: string;
  step?: string;
  intent?: string;
  fromPersona?: string;
  payload?: any;
  corrId?: string;
  deadlineSeconds?: number;
  repo?: string;
  branch?: string;
  projectId?: string;
}): Promise<string> {
  const corrId = opts.corrId || randomUUID();
  const entry: Record<string, string> = {
    workflow_id: opts.workflowId,
    step: opts.step || "",
    from: opts.fromPersona || "coordination",
    to_persona: opts.toPersona,
    intent: opts.intent || "",
    payload: JSON.stringify(opts.payload ?? {}),
    corr_id: corrId,
    deadline_s: String(opts.deadlineSeconds ?? 600)
  };
  if (opts.repo) entry.repo = opts.repo;
  if (opts.branch) entry.branch = opts.branch;
  if (opts.projectId) entry.project_id = opts.projectId;

  await r.xAdd(cfg.requestStream, "*", entry);
  logger.info("coordinator dispatched request", {
    workflowId: opts.workflowId,
    targetPersona: opts.toPersona,
    corrId,
    step: entry.step,
    branch: opts.branch,
    projectId: opts.projectId
  });
  return corrId;
}

function clipText(text: string, max = 6000) {
  if (!text) return text;
  if (text.length <= max) return text;
  return text.slice(0, max) + `\n... (truncated ${text.length - max} chars)`;
}

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

async function handleCoordinator(r: any, msg: any, payloadObj: any) {
  const workflowId = msg.workflow_id;
  const projectId = firstString(payloadObj.project_id, payloadObj.projectId, msg.project_id);
  if (!projectId) throw new Error("Coordinator requires project_id in payload or message");

  const projectStatus: any = await fetchProjectStatus(projectId);
  const projectSlug = firstString(payloadObj.project_slug, payloadObj.projectSlug, projectStatus?.slug, projectStatus?.id);
  const projectRepo = firstString(
    payloadObj.repo,
    payloadObj.repository,
    typeof projectStatus?.repository === "string" ? projectStatus.repository : null,
    projectStatus?.repository?.url,
    projectStatus?.repository?.remote,
    projectStatus?.repo?.url,
    projectStatus?.repo_url,
    projectStatus?.git_url,
    Array.isArray(projectStatus?.repositories) ? projectStatus.repositories[0]?.url : null
  );

  if (!projectRepo) {
    logger.error("coordinator abort: project repository missing", { workflowId, projectId });
    throw new Error(`Project ${projectId} has no repository associated`);
  }

  if (!payloadObj.repo) payloadObj.repo = projectRepo;
  if (!payloadObj.project_slug && projectSlug) payloadObj.project_slug = projectSlug;
  if (!payloadObj.project_name && projectStatus?.name) payloadObj.project_name = projectStatus.name;

  const repoResolution = await resolveRepoFromPayload(payloadObj);
  const repoRoot = normalizeRepoPath(repoResolution.repoRoot, cfg.repoRoot);
  const repoMeta = await getRepoMetadata(repoRoot);

  const baseBranch = firstString(
    payloadObj.base_branch,
    payloadObj.branch,
    repoResolution.branch,
    repoMeta.currentBranch,
    cfg.git.defaultBranch
  ) || cfg.git.defaultBranch;

  const milestones = Array.isArray(projectStatus?.milestones) ? projectStatus.milestones : [];
  const nextMilestone = milestones.find((m: any) => (m?.status || "").toLowerCase() === "unstarted") || milestones[0] || null;
  const milestoneName = nextMilestone?.name || nextMilestone?.title || nextMilestone?.goal || "next milestone";
  const milestoneSlug = slugify(nextMilestone?.slug || milestoneName || "milestone");
  const branchName = payloadObj.branch_name || `milestone/${milestoneSlug}`;

  await checkoutBranchFromBase(repoRoot, baseBranch, branchName);
  logger.info("coordinator prepared branch", { workflowId, repoRoot, baseBranch, branchName });

  await ensureBranchPublished(repoRoot, branchName);

  const repoSlug = repoMeta.remoteSlug;
  const repoRemote = repoSlug ? `https://${repoSlug}.git` : (payloadObj.repo || projectRepo || repoMeta.remoteUrl || repoResolution.remote || "");
  if (!repoRemote) throw new Error("Coordinator could not determine repo remote");

  const milestoneDescriptor = nextMilestone
    ? {
        id: nextMilestone.id ?? milestoneSlug,
        name: milestoneName,
        slug: milestoneSlug,
        status: nextMilestone.status,
        goal: nextMilestone.goal,
        due: nextMilestone.due
      }
    : null;

  const contextCorrId = randomUUID();
  await sendPersonaRequest(r, {
    workflowId,
    toPersona: "context",
    step: "1-context",
    intent: "hydrate_project_context",
    payload: {
      repo: repoRemote,
      branch: branchName,
      project_id: projectId,
      project_slug: projectSlug,
      milestone: milestoneDescriptor,
      upload_dashboard: true
    },
    corrId: contextCorrId,
    repo: repoRemote,
    branch: branchName,
    projectId
  });

  const contextEvent = await waitForPersonaCompletion(r, "context", workflowId, contextCorrId);
  const contextResult = parseEventResult(contextEvent.fields.result);
  logger.info("coordinator received context completion", { workflowId, corrId: contextCorrId, eventId: contextEvent.id });

  const leadCorrId = randomUUID();
  await sendPersonaRequest(r, {
    workflowId,
    toPersona: "lead-engineer",
    step: "2-implementation",
    intent: "implement_milestone",
    payload: {
      repo: repoRemote,
      branch: branchName,
      project_id: projectId,
      project_slug: projectSlug,
      milestone: milestoneDescriptor,
      goal: projectStatus?.goal || projectStatus?.direction || milestoneDescriptor?.goal,
      base_branch: baseBranch
    },
    corrId: leadCorrId,
    repo: repoRemote,
    branch: branchName,
    projectId
  });

  const leadEvent = await waitForPersonaCompletion(r, "lead-engineer", workflowId, leadCorrId);
  const leadResult = parseEventResult(leadEvent.fields.result);
  logger.info("coordinator received lead engineer completion", { workflowId, corrId: leadCorrId, eventId: leadEvent.id });

  const summaryCorrId = randomUUID();
  await sendPersonaRequest(r, {
    workflowId,
    toPersona: "summarization",
    step: "3-summary",
    intent: "summarize_milestone",
    payload: {
      repo: repoRemote,
      branch: branchName,
      project_id: projectId,
      project_slug: projectSlug,
      milestone: milestoneDescriptor,
      lead_engineer_result: leadResult
    },
    corrId: summaryCorrId,
    repo: repoRemote,
    branch: branchName,
    projectId,
    deadlineSeconds: 300
  });

  const summaryEvent = await waitForPersonaCompletion(r, "summarization", workflowId, summaryCorrId);
  const summaryResult = parseEventResult(summaryEvent.fields.result);
  logger.info("coordinator received summarization completion", { workflowId, corrId: summaryCorrId, eventId: summaryEvent.id });

  const lines = [
    `Workflow orchestrated for project ${projectId}.`,
    `Milestone: ${milestoneName} (branch ${branchName}).`,
    `Context completed (corr ${contextCorrId}).`,
    `Lead engineer completed (corr ${leadCorrId}).`,
    `Summarization completed (corr ${summaryCorrId}).`
  ];

  if (summaryResult?.output) {
    lines.push("Summary:", summaryResult.output);
  }

  return lines.join("\n");
}

async function readOne(r: any, persona: string) {
  const res = await r.xReadGroup(groupForPersona(persona), cfg.consumerId, { key: cfg.requestStream, id: ">" }, { COUNT: 1, BLOCK: 200 }).catch(() => null);
  if (!res) return;
  for (const stream of res) {
    for (const msg of stream.messages) {
      const id = msg.id;
      const fields = msg.message as Record<string, string>;
      await processOne(r, persona, id, fields).catch(async (e: any) => {
        logger.error(`worker error`, { persona, error: e, entryId: id });
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
  if (cfg.allowedPersonas.length === 0) { logger.error("ALLOWED_PERSONAS is empty; nothing to do."); process.exit(1); }
  const r = await makeRedis(); await ensureGroups(r);
  logger.info("worker ready", {
    personas: cfg.allowedPersonas,
    projectBase: cfg.projectBase,
    defaultRepo: cfg.repoRoot,
    contextScan: cfg.contextScan,
    summaryMode: cfg.summaryMode,
    logFile: cfg.log.file,
    logLevel: cfg.log.level,
    logConsole: cfg.log.console
  });
  while (true) { for (const p of cfg.allowedPersonas) { await readOne(r, p); } }
}

async function processOne(r: any, persona: string, entryId: string, fields: Record<string,string>) {
  const parsed = RequestSchema.safeParse(fields);
  if (!parsed.success) { await r.xAck(cfg.requestStream, groupForPersona(persona), entryId); return; }
  const msg = parsed.data;
  if (msg.to_persona !== persona) { await r.xAck(cfg.requestStream, groupForPersona(persona), entryId); return; }

  const model = cfg.personaModels[persona]; if (!model) throw new Error(`No model mapping for '${persona}'`);
  const ctx: any = await fetchContext(msg.workflow_id);
  const systemPrompt = SYSTEM_PROMPTS[persona] || `You are the ${persona} agent.`;
  const payloadObj = (() => { try { return msg.payload ? JSON.parse(msg.payload) : {}; } catch { return {}; } })();
  if (msg.repo && !payloadObj.repo) payloadObj.repo = msg.repo;
  if (msg.branch && !payloadObj.branch) payloadObj.branch = msg.branch;
  if (msg.project_id && !payloadObj.project_id) payloadObj.project_id = msg.project_id;

  logger.info("processing request", {
    persona,
    workflowId: msg.workflow_id,
    intent: msg.intent,
    repo: payloadObj.repo,
    branch: payloadObj.branch,
    projectId: payloadObj.project_id
  });

  if (persona === "coordination") {
    const started = Date.now();
    try {
      const output = await handleCoordinator(r, msg, payloadObj);
      const duration = Date.now() - started;
      const result = { output, model: "orchestrator", duration_ms: duration };
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
        workflow_id: msg.workflow_id,
        step: msg.step,
        persona,
        model: "orchestrator",
        duration_ms: duration,
        corr_id: msg.corr_id,
        content: output
      }).catch(() => {});
    } catch (e: any) {
      const duration = Date.now() - started;
      const errorMsg = String(e?.message || e);
      logger.error("coordinator failed", { workflowId: msg.workflow_id, error: errorMsg });
      await r.xAdd(cfg.eventStream, "*", {
        workflow_id: msg.workflow_id,
        step: msg.step || "",
        from_persona: persona,
        status: "error",
        error: errorMsg,
        corr_id: msg.corr_id || "",
        ts: new Date().toISOString()
      });
      await recordEvent({
        workflow_id: msg.workflow_id,
        step: msg.step,
        persona,
        model: "orchestrator",
        duration_ms: duration,
        corr_id: msg.corr_id,
        error: errorMsg
      }).catch(() => {});
    }
    await r.xAck(cfg.requestStream, groupForPersona(persona), entryId);
    return;
  }

  // --- Context scan (pre-model), supports multi-components & Alembic ---
  let scanSummaryText = "";
  let scanArtifacts: null | {
    repoRoot: string;
    ndjson: string;
    snapshot: any;
    summaryMd: string;
    branch: string | null;
    repoSlug: string | null;
    remoteUrl: string | null;
    snapshotPath: string;
    summaryPath: string;
    filesNdjsonPath: string;
    snapshotRel: string;
    summaryRel: string;
    filesNdjsonRel: string;
    totals: { files: number; bytes: number; lines: number };
    components: any;
    hotspots: any;
    paths: string[];
  } = null;
  let repoInfo: Awaited<ReturnType<typeof resolveRepoFromPayload>> | null = null;
  let dashboardUploadEnabled = false;
  const dashboardProject: { id?: string; name?: string; slug?: string } = {};
  if (persona === "context" && cfg.contextScan) {
    try {
      repoInfo = await resolveRepoFromPayload(payloadObj);
      const repoRoot = normalizeRepoPath(repoInfo.repoRoot, cfg.repoRoot);
      const components = Array.isArray(payloadObj.components) ? payloadObj.components
                        : (Array.isArray(cfg.scanComponents) ? cfg.scanComponents : null);

      logger.info("context scan starting", {
        repoRoot,
        branch: repoInfo.branch ?? null,
        components: components?.map((c:any) => ({ base: c.base || "", include: c.include, exclude: c.exclude })),
        include: cfg.scanInclude,
        exclude: cfg.scanExclude,
        maxFiles: cfg.scanMaxFiles,
        maxBytes: cfg.scanMaxBytes,
        maxDepth: cfg.scanMaxDepth
      });

      const { scanRepo, summarize } = await import("./scanRepo.js");
      type Comp = { base: string; include: string[]; exclude: string[] };
      const comps: Comp[] = components && components.length
        ? components.map((c:any)=>({ base: String(c.base||"").replace(/\\/g,"/"), include: (c.include||cfg.scanInclude), exclude: (c.exclude||cfg.scanExclude) }))
        : [{ base: "", include: cfg.scanInclude, exclude: cfg.scanExclude }];

      let allFiles: any[] = [];
      const perComp: any[] = [];
      const localSummaries: { component: string; totals: any; largest: any[]; longest: any[] }[] = [];

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
        const compName = c.base || ".";
        perComp.push({ component: compName, totals: sum.totals, largest: sum.largest.slice(0,10), longest: sum.longest.slice(0,10) });
        localSummaries.push({ component: compName, totals: sum.totals, largest: sum.largest.slice(0,5), longest: sum.longest.slice(0,5) });
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

      const repoMeta = await getRepoMetadata(repoRoot);
      const branchUsed = repoInfo.branch ?? repoMeta.currentBranch ?? null;
      repoInfo.branch = branchUsed;
      repoInfo.remote = repoInfo.remote || repoMeta.remoteUrl || undefined;
      const repoSlug = repoMeta.remoteSlug || null;

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

      const pathMod = await import("path");
      const contextFolder = ".ma/context";
      const snapshotRel = `${contextFolder}/snapshot.json`;
      const summaryRel = `${contextFolder}/summary.md`;
      const filesNdjsonRel = `${contextFolder}/files.ndjson`;

      scanArtifacts = {
        repoRoot,
        ndjson,
        snapshot,
        summaryMd: scanMd,
        branch: branchUsed,
        repoSlug,
        remoteUrl: repoInfo.remote || null,
        snapshotPath: pathMod.resolve(repoRoot, snapshotRel),
        summaryPath: pathMod.resolve(repoRoot, summaryRel),
        filesNdjsonPath: pathMod.resolve(repoRoot, filesNdjsonRel),
        snapshotRel,
        summaryRel,
        filesNdjsonRel,
        totals: global.totals,
        components: perComp,
        hotspots: snapshot.hotspots,
        paths: writeRes.paths
      };
      const branchNote = branchUsed ? `, branch=${branchUsed}` : "";
      scanSummaryText = `Context scan: files=${global.totals.files}, bytes=${global.totals.bytes}, lines=${global.totals.lines}, components=${perComp.length}${branchNote}.`;

      logger.info("context scan completed", {
        repoRoot,
        branch: branchUsed,
        remote: repoInfo.remote || null,
        repoSlug,
        totals: global.totals,
        components: localSummaries
      });

      const shouldUpload = shouldUploadDashboardFlag(payloadObj.upload_dashboard);
      if (shouldUpload) {
        dashboardUploadEnabled = true;
        const projectId = firstString(payloadObj.project_id, payloadObj.projectId, msg.project_id);
        const projectName = firstString(payloadObj.project_name, payloadObj.projectName, payloadObj.project);
        const projectSlug = firstString(payloadObj.project_slug, payloadObj.projectSlug);
        if (projectId) dashboardProject.id = projectId;
        if (projectName) dashboardProject.name = projectName;
        if (projectSlug) dashboardProject.slug = projectSlug;
      }
    } catch (e:any) {
      scanSummaryText = `Context scan failed: ${String(e?.message || e)}`;
      logger.error("context scan failed", { error: e, repo: payloadObj.repo, branch: payloadObj.branch });
    }
  }

  const userPayload = msg.payload ? msg.payload : "{}";
  const scanSummaryForPrompt = scanArtifacts
    ? clipText(scanArtifacts.summaryMd, persona === "context" ? 8000 : 4000)
    : scanSummaryText;

  const userLines = [
    `Intent: ${msg.intent}`,
    `Payload: ${userPayload}`,
    `Constraints/Limits: ${ctx?.limits || ""}`,
    `Persona hints: ${ctx?.personaHints || ""}`
  ];

  if (persona === "context") {
    if (scanArtifacts) {
      userLines.push("Instruction: Use only the files, directories, and facts present in the scan summary above. If something is missing, explicitly state it was not observed.");
    } else {
      userLines.push(`Scan note: ${scanSummaryText}`);
    }
  } else {
    userLines.push(`Scan note: ${scanSummaryText}`);
  }

  const userText = userLines.join("\n");

  const messages: any[] = [
    { role: "system", content: systemPrompt }
  ];

  if (scanSummaryForPrompt && scanSummaryForPrompt.length) {
    const label = persona === "context" ? "Authoritative file scan summary" : "File scan summary";
    messages.push({ role: "system", content: `${label}:\n${scanSummaryForPrompt}` });
  }

  if ((persona !== "context" || !scanArtifacts) && (ctx?.projectTree || ctx?.fileHotspots)) {
    messages.push({ role: "system", content: `Dashboard context (may be stale):\nTree: ${ctx?.projectTree || ""}\nHotspots: ${ctx?.fileHotspots || ""}` });
  }

  messages.push({ role: "user", content: userText });

  const started = Date.now();
  const resp = await callLMStudio(model, messages, 0.2);
  const duration = Date.now() - started;

  // After model call: write/replace summary.md per SUMMARY_MODE
  if (persona === "context" && scanArtifacts) {
    try {
      const fs = await import("fs/promises");
      const pathMod = await import("path");
      const summaryPath = scanArtifacts.summaryPath || pathMod.resolve(scanArtifacts.repoRoot, ".ma/context/summary.md");
      let contentToWrite = resp.content;
      if (cfg.summaryMode === "scan") contentToWrite = scanArtifacts.summaryMd;
      if (cfg.summaryMode === "both") {
        contentToWrite = `# Model Summary\n\n${resp.content}\n\n---\n\n` + scanArtifacts.summaryMd;
      }
      await fs.mkdir(pathMod.dirname(summaryPath), { recursive: true });
      await fs.writeFile(summaryPath, contentToWrite, "utf8");

      // ensure the stored summaryPath reflects latest location
      scanArtifacts.summaryPath = summaryPath;

      const commitPaths = Array.from(new Set([
        scanArtifacts.snapshotRel,
        scanArtifacts.summaryRel,
        scanArtifacts.filesNdjsonRel
      ].filter(Boolean)));

      try {
        const commitRes = await commitAndPushPaths({
          repoRoot: scanArtifacts.repoRoot,
          branch: scanArtifacts.branch,
          message: `context: snapshot for ${msg.workflow_id}`,
          paths: commitPaths
        });
        logger.info("context artifacts push result", { workflowId: msg.workflow_id, result: commitRes });
      } catch (commitErr: any) {
        logger.error("context artifacts push failed", { error: commitErr, workflowId: msg.workflow_id });
      }

      if (dashboardUploadEnabled) {
        const repoId = scanArtifacts.repoSlug
          || dashboardProject.id
          || dashboardProject.slug
          || payloadObj.repo
          || scanArtifacts.repoRoot;

        logger.info("uploading context snapshot", {
          workflowId: msg.workflow_id,
          project: dashboardProject,
          repo: scanArtifacts.repoRoot,
          repoId,
          branch: scanArtifacts.branch,
          summaryPath: scanArtifacts.summaryRel,
          snapshotPath: scanArtifacts.snapshotRel,
          filesNdjsonPath: scanArtifacts.filesNdjsonRel
        });
        const uploadRes = await uploadContextSnapshot({
          workflowId: msg.workflow_id,
          repoId,
          projectId: dashboardProject.id,
          projectName: dashboardProject.name,
          projectSlug: dashboardProject.slug,
          repoRoot: scanArtifacts.repoRoot,
          branch: scanArtifacts.branch,
          snapshotPath: scanArtifacts.snapshotRel,
          summaryPath: scanArtifacts.summaryRel,
          filesNdjsonPath: scanArtifacts.filesNdjsonRel,
          totals: scanArtifacts.totals,
          components: scanArtifacts.components,
          hotspots: scanArtifacts.hotspots
        });
        if (!uploadRes.ok) {
          logger.warn("dashboard upload reported failure", { status: uploadRes.status, workflowId: msg.workflow_id });
        }
      }
    } catch (e:any) {
      logger.warn("context summary write failed", { error: e });
    }
  }

  const result = { output: resp.content, model, duration_ms: duration };
  logger.info("persona completed", { persona, workflowId: msg.workflow_id, duration_ms: duration });
  await r.xAdd(cfg.eventStream, "*", {
    workflow_id: msg.workflow_id, step: msg.step || "", from_persona: persona,
    status: "done", result: JSON.stringify(result), corr_id: msg.corr_id || "", ts: new Date().toISOString()
  });
  await recordEvent({ workflow_id: msg.workflow_id, step: msg.step, persona, model, duration_ms: duration, corr_id: msg.corr_id, content: resp.content }).catch(()=>{});
  await r.xAck(cfg.requestStream, groupForPersona(persona), entryId);
}

main().catch(e => { logger.error("worker fatal", { error: e }); process.exit(1); });
