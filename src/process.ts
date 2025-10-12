import { cfg } from "./config.js";
import { makeRedis } from "./redisClient.js";
import { RequestSchema } from "./schema.js";
import { SYSTEM_PROMPTS } from "./personas.js";
import { PERSONAS } from "./personaNames.js";
import { callLMStudio } from "./lmstudio.js";
import { fetchContext, recordEvent, uploadContextSnapshot, fetchProjectStatus, fetchProjectStatusDetails, fetchProjectNextAction, fetchProjectStatusSummary, createDashboardTask, updateTaskStatus } from "./dashboard.js";
import { resolveRepoFromPayload, getRepoMetadata, commitAndPushPaths, checkoutBranchFromBase, ensureBranchPublished, runGit } from "./gitUtils.js";
import { logger } from "./logger.js";
// applyModelGeneratedChanges not exported from implementation stage; omit import

// Lightweight type alias for edit outcome used in this module
type ApplyEditsOutcome = any;

// Local stub for applying model-generated changes. The real implementation
// lives in the implementation stage module in some workflows; if available
// it should be imported there. For now return a conservative result.
async function applyModelGeneratedChanges(_: any): Promise<ApplyEditsOutcome> {
  return { attempted: false, applied: false, reason: 'not_implemented' } as ApplyEditsOutcome;
}
import { gatherPromptFileSnippets, extractMentionedPaths } from "./prompt.js";
import { normalizeRepoPath, firstString, clipText, shouldUploadDashboardFlag, personaTimeoutMs, CODING_PERSONA_SET, ENGINEER_PERSONAS_REQUIRING_PLAN } from "./util.js";

export async function processContext(r: any, persona: string, msg: any, payloadObj: any, entryId: string) {
    const model = cfg.personaModels[persona]; if (!model) throw new Error(`No model mapping for '${persona}'`);
    const ctx: any = await fetchContext(msg.workflow_id);
    const systemPrompt = SYSTEM_PROMPTS[persona] || `You are the ${persona} agent.`;
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
  if (persona !== PERSONAS.COORDINATION) {
      try {
        repoInfo = await resolveRepoFromPayload(payloadObj);
      } catch (e:any) {
        logger.warn("resolve repo from payload failed", { persona, workflowId: msg.workflow_id, error: e?.message || String(e) });
      }
    }
  // Use the resolved repoRoot directly for filesystem and git operations.
  // Avoid cross-OS path normalization that could produce invalid paths on Windows.
  let repoRootNormalized = repoInfo ? repoInfo.repoRoot : null;
    let dashboardUploadEnabled = false;
    const dashboardProject: { id?: string; name?: string; slug?: string } = {};
  if (persona === PERSONAS.CONTEXT && cfg.contextScan && repoInfo && repoRootNormalized) {
      try {
          const repoRoot = repoRootNormalized;
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
          ? components.map((c:any)=>({
              base: String(c.base||"").replace(/\\/g,"/"),
              include: (c.include||cfg.scanInclude),
              exclude: (c.exclude||cfg.scanExclude)
            }))
          : [{ base: "", include: cfg.scanInclude, exclude: cfg.scanExclude }];
  
        let allFiles: any[] = [];
        const perComp: any[] = [];
        const localSummaries: { component: string; totals: any; largest: any[]; longest: any[] }[] = [];
  
        for (const c of comps) {
          const basePath = (c.base && c.base.length) ? (repoRoot.replace(/\/$/,"") + "/" + c.base.replace(/^\//,"")) : repoRoot;
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
          const prefixed = files.map(f => ({ ...f, path: (c.base ? (c.base.replace(/^\/+|\/+$|/g,'') + '/' + f.path) : f.path) }));
          allFiles.push(...prefixed);
          const sum = summarize(prefixed);
          const compName = c.base || ".";
          perComp.push({ component: compName, totals: sum.totals, largest: sum.largest.slice(0,10), longest: sum.longest.slice(0,10) });
          localSummaries.push({ component: compName, totals: sum.totals, largest: sum.largest.slice(0,5), longest: sum.longest.slice(0,5) });
        }
  
        const ndjson = allFiles.map(f => JSON.stringify(f)).join("\n") + "\n";
        const { summarize: summarize2 } = await import("./scanRepo.js");
        const global = summarize2(allFiles);
  
        // Build scanMd with Alembic awareness and full file tree
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
          
          // Add complete file tree organized by directory
          lines.push("## File Tree");
          lines.push("");
          
          // Group files by directory
          const filesByDir = new Map<string, typeof allFiles>();
          for (const file of allFiles) {
            const dirPath = file.path.includes('/') ? file.path.substring(0, file.path.lastIndexOf('/')) : '.';
            if (!filesByDir.has(dirPath)) {
              filesByDir.set(dirPath, []);
            }
            filesByDir.get(dirPath)!.push(file);
          }
          
          // Sort directories alphabetically
          const sortedDirs = Array.from(filesByDir.keys()).sort();
          
          for (const dir of sortedDirs) {
            const files = filesByDir.get(dir)!.sort((a, b) => a.path.localeCompare(b.path));
            lines.push(`### ${dir === '.' ? 'Root' : dir}`);
            lines.push("");
            for (const f of files) {
              const fileName = f.path.includes('/') ? f.path.substring(f.path.lastIndexOf('/') + 1) : f.path;
              const sizeInfo = `${f.bytes} bytes${typeof f.lines === 'number' ? `, ${f.lines} lines` : ''}`;
              lines.push(`- **${fileName}** (${sizeInfo})`);
            }
            lines.push("");
          }
          
          // Alembic detection
          const alembicFiles = allFiles.filter(f => /(^|\/)alembic(\/|$)/i.test(f.path));
          if (alembicFiles.length) {
            const versions = alembicFiles.filter(f => /(^|\/)alembic(\/|).*\bversions\b(\/|).+\.py$/i.test(f.path));
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
          files: allFiles,  // Include full file list in snapshot
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
  
  if (persona === PERSONAS.CONTEXT && cfg.contextScan && !repoInfo) {
      scanSummaryText = scanSummaryText || "Context scan unavailable: repository could not be resolved.";
      logger.warn("context scan skipped: repo unresolved", { workflowId: msg.workflow_id, repo: payloadObj.repo, branch: payloadObj.branch });
    }
  
    const userPayload = msg.payload ? msg.payload : "{}";
    let externalSummary: string | null = null;
    let preferredPaths: string[] = [];
    
    // First, check if the payload contains a fresh context summary from a recent context persona run
    // This ensures we use the most up-to-date context rather than reading stale data from disk
    if (persona !== "context") {
      try {
        const contextFromPayload = payloadObj.context?.output || payloadObj.context_summary || payloadObj.context;
        if (contextFromPayload && typeof contextFromPayload === 'string' && contextFromPayload.length > 100) {
          externalSummary = contextFromPayload;
          scanSummaryText = "Context summary provided from recent context scan";
          preferredPaths = extractMentionedPaths(contextFromPayload);
          logger.info("Using fresh context summary from payload", { 
            persona, 
            workflowId: msg.workflow_id,
            summaryLength: contextFromPayload.length 
          });
        }
      } catch (e: any) {
        logger.debug("Unable to extract context from payload, will try disk", { 
          persona, 
          workflowId: msg.workflow_id, 
          error: e?.message 
        });
      }
    }
    
    // If no fresh context in payload, fall back to reading from disk
    if (!externalSummary && persona !== "context" && repoInfo && repoRootNormalized) {
      try {
        const fs = await import("fs/promises");
        const pathMod = await import("path");
  const repoRoot = repoRootNormalized;
        const summaryPath = pathMod.resolve(repoRoot, ".ma/context/summary.md");
        const content = await fs.readFile(summaryPath, "utf8");
        externalSummary = content;
        if (!scanSummaryText) scanSummaryText = `Context summary loaded from ${pathMod.relative(repoRoot, summaryPath)}`;
        preferredPaths = extractMentionedPaths(content);
        logger.debug("Using context summary from disk file", {
          persona,
          workflowId: msg.workflow_id,
          summaryPath: pathMod.relative(repoRoot, summaryPath)
        });
      } catch (e:any) {
        logger.debug("persona prompt: context summary unavailable", { persona, workflowId: msg.workflow_id, error: e?.message || String(e) });
      }
    }
  
    if (!scanSummaryText && persona !== PERSONAS.CONTEXT && persona !== PERSONAS.COORDINATION) {
      scanSummaryText = "Context summary not available.";
    }
  
    // Load QA results for implementation-planner and plan-evaluator to inform their decisions
    let qaHistory: string | null = null;
    if ((persona === PERSONAS.IMPLEMENTATION_PLANNER || persona === PERSONAS.PLAN_EVALUATOR) && repoInfo && repoRootNormalized) {
      try {
        const fs = await import("fs/promises");
        const pathMod = await import("path");
        const repoRoot = repoRootNormalized;
        
        const taskId = firstString(
          payloadObj.task_id,
          payloadObj.taskId,
          payloadObj.task?.id,
          msg.workflow_id
        ) || "unknown";
        
        const qaLogPath = pathMod.resolve(repoRoot, ".ma/qa", `task-${taskId}-qa.log`);
        
        try {
          const qaContent = await fs.readFile(qaLogPath, "utf8");
          // Extract only the most recent QA run (last entry in the log)
          const entries = qaContent.split("=".repeat(80)).filter(e => e.trim());
          const latestEntry = entries.length > 0 ? entries[entries.length - 1] : qaContent;
          qaHistory = latestEntry.trim();
          
          logger.info("Loaded QA history for persona", {
            persona,
            taskId,
            qaLogPath: pathMod.relative(repoRoot, qaLogPath),
            workflowId: msg.workflow_id
          });
        } catch (readErr: any) {
          // QA log doesn't exist yet - this is normal for first run
          logger.debug("QA log not found (first run?)", {
            persona,
            taskId,
            qaLogPath: pathMod.relative(repoRoot, qaLogPath)
          });
        }
      } catch (e: any) {
        logger.debug("Unable to load QA history", {
          persona,
          workflowId: msg.workflow_id,
          error: e?.message || String(e)
        });
      }
    }
  
    const scanSummaryForPrompt = scanArtifacts
      ? clipText(scanArtifacts.summaryMd, persona === PERSONAS.CONTEXT ? 8000 : 4000)
      : (externalSummary ? clipText(externalSummary, 4000) : scanSummaryText);
  
    let promptFileSnippets: any[] = [];
    if (persona !== PERSONAS.CONTEXT && repoRootNormalized) {
      promptFileSnippets = await gatherPromptFileSnippets(repoRootNormalized, preferredPaths);
    }
  
    const userLines = [
      `Intent: ${msg.intent}`,
      `Payload: ${userPayload}`,
      `Constraints/Limits: ${ctx?.limits || ""}`,
      `Persona hints: ${ctx?.personaHints || ""}`
    ];
  
    if (persona === PERSONAS.CONTEXT) {
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
      const label = persona === PERSONAS.CONTEXT ? "Authoritative file scan summary" : "File scan summary";
      messages.push({ role: "system", content: `${label}:\n${scanSummaryForPrompt}` });
    }
  
    if (cfg.injectDashboardContext && (persona !== PERSONAS.CONTEXT || !scanArtifacts) && (ctx?.projectTree || ctx?.fileHotspots)) {
      messages.push({ role: "system", content: `Dashboard context (may be stale):\nTree: ${ctx?.projectTree || ""}\nHotspots: ${ctx?.fileHotspots || ""}` });
    }
  
    // Coordinator-managed short summary insertion: fetch a concise project summary (if available)
    try {
      const projectIdForSummary = firstString(payloadObj.project_id, payloadObj.projectId, msg.project_id, dashboardProject.id) || null;
      const projSummary = await fetchProjectStatusSummary(projectIdForSummary);
      if (projSummary && typeof projSummary === 'string' && projSummary.trim().length) {
        messages.push({ role: 'system', content: `Previous step summary (from dashboard):\n${projSummary.trim()}` });
      }
    } catch (err) {
      // ignore summary fetch failures
    }
  
    // Include QA test results for planners/evaluators to inform their decisions
    if (qaHistory && qaHistory.length > 0) {
      messages.push({ 
        role: 'system', 
        content: `Latest QA Test Results:\n${clipText(qaHistory, 2000)}\n\nUse this to understand what failed in previous attempts and adjust your plan accordingly.` 
      });
    }
  
    if (promptFileSnippets.length) {
      const snippetParts: string[] = ["Existing project files for reference (read-only):"];
      for (const snippet of promptFileSnippets) {
        snippetParts.push(`File: ${snippet.path}`);
        snippetParts.push("```");
        snippetParts.push(snippet.content);
        snippetParts.push("```");
      }
      messages.push({ role: "system", content: snippetParts.join("\n") });
    }
  
  
    const personaLower = persona.toLowerCase();
    const stepLower = (msg.step || "").toLowerCase();
    const repoHint = firstString(
      payloadObj.repo,
      payloadObj.repository,
      payloadObj.remote,
      payloadObj.repo_url,
      payloadObj.repository_url,
      msg.repo
    ) || "the existing repository";
  
    if (ENGINEER_PERSONAS_REQUIRING_PLAN.has(personaLower) && stepLower === "2-plan") {
      messages.push({
        role: "system",
        content: `You are preparing an execution plan for work in ${repoHint}. This is a planning step only. Do not provide code snippets, diffs, or file changes. Respond with JSON containing a 'plan' array where each item describes a concrete numbered step (include goals, files to touch, owners if relevant, and dependencies). Add optional context such as 'risks' or 'open_questions'. Await coordinator approval before attempting any implementation.`
      });
    } else if (CODING_PERSONA_SET.has(personaLower)) {
      messages.push({
        role: "system",
        content: `You are working inside ${repoHint}. The repository already exists; modify only the necessary files. Do not generate a brand-new project scaffold. Provide concrete code edits as unified diffs that apply cleanly with \`git apply\`. Wrap each patch in \`\`\`diff\`\`\` fences. If you add or delete files, include the appropriate diff headers. Always reference existing files by their actual paths.`
      });
    }
    messages.push({ role: "user", content: userText });
  
    // Ensure we don't accidentally pass prior assistant messages as history; use only system+user messages
    const freshMessages = messages.filter(m => m && (m.role === 'system' || m.role === 'user')) as any[];
    const started = Date.now();
    // Use persona-specific timeout for LM calls so long-running personas can be configured via env
    const lmTimeoutMs = personaTimeoutMs(persona, cfg);
    logger.debug("calling LM model", { persona, model, timeoutMs: lmTimeoutMs });
    const resp = await callLMStudio(model, freshMessages, 0.2, { timeoutMs: lmTimeoutMs });
    const duration = Date.now() - started;
    const responsePreview = resp.content && resp.content.length > 4000
      ? resp.content.slice(0, 4000) + "... (truncated)"
      : resp.content;
    logger.info("persona response", { persona, workflowId: msg.workflow_id, corrId: msg.corr_id || "", preview: responsePreview });
  
    // After model call: write/replace summary.md per SUMMARY_MODE
    if (persona === PERSONAS.CONTEXT && scanArtifacts) {
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
  
    let editOutcome: ApplyEditsOutcome | null = null;
    if (cfg.applyEdits && cfg.allowedEditPersonas.includes(persona)) {
      try {
        if (!repoInfo) {
          repoInfo = await resolveRepoFromPayload(payloadObj);
          repoRootNormalized = repoInfo ? repoInfo.repoRoot : repoRootNormalized;
        }
        if (repoInfo) {
          const repoRootForEdits = repoRootNormalized || repoInfo.repoRoot;
          const branchHint = firstString(
            payloadObj.branch,
            payloadObj.branch_name,
            payloadObj.base_branch,
            payloadObj.default_branch,
            repoInfo.branch
          );
          editOutcome = await applyModelGeneratedChanges({
            persona,
            workflowId: msg.workflow_id,
            repoRoot: repoRootForEdits,
            branchHint,
            responseText: resp.content
          });
          if (branchHint && repoInfo) repoInfo.branch = branchHint;
        } else {
          editOutcome = { attempted: false, applied: false, reason: "repo_unresolved" };
        }
      } catch (error: any) {
        logger.error("persona apply edits failed", { persona, workflowId: msg.workflow_id, error });
        editOutcome = { attempted: true, applied: false, reason: "apply_failed", error: error?.message || String(error) };
      }
    }
  
    const result: any = { output: resp.content, model, duration_ms: duration };
    if (editOutcome) result.applied_edits = editOutcome;
    
    // Write QA results to task-specific log for tester-qa persona
    if (persona === PERSONAS.TESTER_QA && repoInfo && repoRootNormalized) {
      try {
        const fs = await import("fs/promises");
        const pathMod = await import("path");
        const repoRoot = repoRootNormalized;
        const qaDir = pathMod.resolve(repoRoot, ".ma/qa");
        await fs.mkdir(qaDir, { recursive: true });
        
        const taskId = firstString(
          payloadObj.task_id,
          payloadObj.taskId,
          payloadObj.task?.id,
          msg.workflow_id
        ) || "unknown";
        
        const qaLogPath = pathMod.resolve(qaDir, `task-${taskId}-qa.log`);
        
        // Parse QA response to extract pass/fail status
        const responseText = resp.content || "";
        const isPassed = responseText.toLowerCase().includes("pass") && 
                        !responseText.toLowerCase().includes("fail");
        const isFailed = responseText.toLowerCase().includes("fail");
        const status = isPassed && !isFailed ? "PASS" : isFailed ? "FAIL" : "UNKNOWN";
        
        const logEntry = [
          `\n${"=".repeat(80)}`,
          `QA Test Run - ${new Date().toISOString()}`,
          `Task ID: ${taskId}`,
          `Workflow ID: ${msg.workflow_id}`,
          `Status: ${status}`,
          `Duration: ${duration}ms`,
          `${"=".repeat(80)}`,
          ``,
          responseText,
          ``,
          `${"=".repeat(80)}`,
          ``
        ].join("\n");
        
        await fs.appendFile(qaLogPath, logEntry, "utf8");
        logger.info("QA results written to log", { 
          taskId, 
          qaLogPath: pathMod.relative(repoRoot, qaLogPath),
          status,
          workflowId: msg.workflow_id 
        });
      } catch (e: any) {
        logger.warn("Failed to write QA log", { 
          persona, 
          workflowId: msg.workflow_id, 
          error: e?.message || String(e) 
        });
      }
    }
    
    logger.info("persona completed", { persona, workflowId: msg.workflow_id, duration_ms: duration });
    await r.xAdd(cfg.eventStream, "*", {
      workflow_id: msg.workflow_id, step: msg.step || "", from_persona: persona,
      status: "done", result: JSON.stringify(result), corr_id: msg.corr_id || "", ts: new Date().toISOString()
    });
    await recordEvent({ workflow_id: msg.workflow_id, step: msg.step, persona, model, duration_ms: duration, corr_id: msg.corr_id, content: resp.content }).catch(()=>{});
    try { await r.xAck(cfg.requestStream, `${cfg.groupPrefix}:${persona}`, entryId); } catch {}
  }

export async function processPersona(r: any, persona: string, msg: any, payloadObj: any, entryId: string) {
    const model = cfg.personaModels[persona]; if (!model) throw new Error(`No model mapping for '${persona}'`);
    const ctx: any = await fetchContext(msg.workflow_id);
    const systemPrompt = SYSTEM_PROMPTS[persona] || `You are the ${persona} agent.`;
    const userPayload = msg.payload ? msg.payload : "{}";
    let externalSummary: string | null = null;
    let preferredPaths: string[] = [];
    let repoInfo: Awaited<ReturnType<typeof resolveRepoFromPayload>> | null = null;
    if (persona !== PERSONAS.COORDINATION) {
      try {
        repoInfo = await resolveRepoFromPayload(payloadObj);
      } catch (e:any) {
        // For non-editing personas (e.g., summarization, PM), allow proceeding without a repo
        logger.warn("resolve repo from payload failed", { persona, workflowId: msg.workflow_id, error: e?.message || String(e) });
        repoInfo = null;
      }
    }
    let repoRootNormalized = repoInfo ? normalizeRepoPath(repoInfo.repoRoot, cfg.repoRoot) : null;
    let scanSummaryText = "";
  if (persona !== "context" && repoInfo && repoRootNormalized) {
      try {
        const fs = await import("fs/promises");
        const pathMod = await import("path");
        const repoRoot = repoRootNormalized;
        const summaryPath = pathMod.resolve(repoRoot, ".ma/context/summary.md");
        const content = await fs.readFile(summaryPath, "utf8");
        externalSummary = content;
        if (!scanSummaryText) scanSummaryText = `Context summary loaded from ${pathMod.relative(repoRoot, summaryPath)}`;
        preferredPaths = extractMentionedPaths(content);
      } catch (e:any) {
        logger.debug("persona prompt: context summary unavailable", { persona, workflowId: msg.workflow_id, error: e?.message || String(e) });
      }
    }
  
    if (!scanSummaryText && persona !== PERSONAS.CONTEXT && persona !== PERSONAS.COORDINATION) {
      scanSummaryText = "Context summary not available.";
    }
  
    const scanSummaryForPrompt = externalSummary ? clipText(externalSummary, 4000) : scanSummaryText;
  
    let promptFileSnippets: any[] = [];
    if (persona !== PERSONAS.CONTEXT && repoRootNormalized) {
      promptFileSnippets = await gatherPromptFileSnippets(repoRootNormalized, preferredPaths);
    }
  
    const userLines = [
      `Intent: ${msg.intent}`,
      `Payload: ${userPayload}`,
      `Constraints/Limits: ${ctx?.limits || ""}`,
      `Persona hints: ${ctx?.personaHints || ""}`
    ];
  
    userLines.push(`Scan note: ${scanSummaryText}`);
  
    const userText = userLines.join("\n");
  
    const messages: any[] = [
      { role: "system", content: systemPrompt }
    ];
  
    if (scanSummaryForPrompt && scanSummaryForPrompt.length) {
      const label = "File scan summary";
      messages.push({ role: "system", content: `${label}:\n${scanSummaryForPrompt}` });
    }
  
    if (cfg.injectDashboardContext && (ctx?.projectTree || ctx?.fileHotspots)) {
      messages.push({ role: "system", content: `Dashboard context (may be stale):\nTree: ${ctx?.projectTree || ""}\nHotspots: ${ctx?.fileHotspots || ""}` });
    }
  
    // Coordinator-managed short summary insertion: fetch a concise project summary (if available)
    try {
      const projectIdForSummary = firstString(payloadObj.project_id, payloadObj.projectId, msg.project_id) || null;
      const projSummary = await fetchProjectStatusSummary(projectIdForSummary);
      if (projSummary && typeof projSummary === 'string' && projSummary.trim().length) {
        messages.push({ role: 'system', content: `Previous step summary (from dashboard):\n${projSummary.trim()}` });
      }
    } catch (err) {
      // ignore summary fetch failures
    }
  
    if (promptFileSnippets.length) {
      const snippetParts: string[] = ["Existing project files for reference (read-only):"];
      for (const snippet of promptFileSnippets) {
        snippetParts.push(`File: ${snippet.path}`);
        snippetParts.push("```");
        snippetParts.push(snippet.content);
        snippetParts.push("```");
      }
      messages.push({ role: "system", content: snippetParts.join("\n") });
    }
  
  
    const personaLower = persona.toLowerCase();
    const stepLower = (msg.step || "").toLowerCase();
    const repoHint = firstString(
      payloadObj.repo,
      payloadObj.repository,
      payloadObj.remote,
      payloadObj.repo_url,
      payloadObj.repository_url,
      msg.repo
    ) || "the existing repository";
  
    messages.push({ role: "user", content: userText });
  
    // Ensure we don't accidentally pass prior assistant messages as history; use only system+user messages
    const freshMessages = messages.filter(m => m && (m.role === 'system' || m.role === 'user')) as any[];
    const started = Date.now();
    // Use persona-specific timeout for LM calls so long-running personas can be configured via env
    const lmTimeoutMs = personaTimeoutMs(persona, cfg);
    logger.debug("calling LM model", { persona, model, timeoutMs: lmTimeoutMs });
    const resp = await callLMStudio(model, freshMessages, 0.2, { timeoutMs: lmTimeoutMs });
    const duration = Date.now() - started;
    const responsePreview = resp.content && resp.content.length > 4000
      ? resp.content.slice(0, 4000) + "... (truncated)"
      : resp.content;
    logger.info("persona response", { persona, workflowId: msg.workflow_id, corrId: msg.corr_id || "", preview: responsePreview });
  
    let editOutcome: ApplyEditsOutcome | null = null;
    if (cfg.applyEdits && cfg.allowedEditPersonas.includes(persona)) {
      try {
        if (!repoInfo) {
          repoInfo = await resolveRepoFromPayload(payloadObj);
          repoRootNormalized = repoInfo ? normalizeRepoPath(repoInfo.repoRoot, cfg.repoRoot) : repoRootNormalized;
        }
        if (repoInfo) {
          const repoRootForEdits = repoRootNormalized || normalizeRepoPath(repoInfo.repoRoot, cfg.repoRoot);
          const branchHint = firstString(
            payloadObj.branch,
            payloadObj.branch_name,
            payloadObj.base_branch,
            payloadObj.default_branch,
            repoInfo.branch
          );
          editOutcome = await applyModelGeneratedChanges({
            persona,
            workflowId: msg.workflow_id,
            repoRoot: repoRootForEdits,
            branchHint,
            responseText: resp.content
          });
          if (branchHint && repoInfo) repoInfo.branch = branchHint;
        } else {
          editOutcome = { attempted: false, applied: false, reason: "repo_unresolved" };
        }
      } catch (error: any) {
        logger.error("persona apply edits failed", { persona, workflowId: msg.workflow_id, error });
        editOutcome = { attempted: true, applied: false, reason: "apply_failed", error: error?.message || String(error) };
      }
    }
  
    const result: any = { output: resp.content, model, duration_ms: duration };
    if (editOutcome) result.applied_edits = editOutcome;
    logger.info("persona completed", { persona, workflowId: msg.workflow_id, duration_ms: duration });
    await r.xAdd(cfg.eventStream, "*", {
      workflow_id: msg.workflow_id, step: msg.step || "", from_persona: persona,
      status: "done", result: JSON.stringify(result), corr_id: msg.corr_id || "", ts: new Date().toISOString()
    });
    await recordEvent({ workflow_id: msg.workflow_id, step: msg.step, persona, model, duration_ms: duration, corr_id: msg.corr_id, content: resp.content }).catch(()=>{});
    try { await r.xAck(cfg.requestStream, `${cfg.groupPrefix}:${persona}`, entryId); } catch {}
  }