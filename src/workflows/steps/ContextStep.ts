import {
  WorkflowStep,
  StepResult,
  ValidationResult,
} from "../engine/WorkflowStep.js";
import { WorkflowContext } from "../engine/WorkflowContext.js";
import { logger } from "../../logger.js";
import { scanRepo, ScanSpec, FileInfo } from "../../scanRepo.js";
import fs from "fs/promises";
import { execSync } from "child_process";
import path from "path";
import {
  ensureContextDir,
  hydrateContextArtifacts,
  loadExistingSnapshot,
  writeContextArtifacts,
} from "./context/ContextArtifacts.js";
import {
  buildContextSummary,
  ContextInsights,
} from "./context/contextSummary.js";
import {
  determineRepoPath,
  lookupContextValue,
} from "./context/ContextPathResolver.js";
import { coalesceRescanFlags } from "./context/ContextBoolean.js";
import { collectAllowedLanguages } from "./helpers/languagePolicy.js";
import {
  assessAnalysisReuse,
  computeDelta,
  ContextDelta,
  filterPathsBySpec,
  getGitDelta,
  getHeadSha,
  incrementalScan,
} from "./context/IncrementalScan.js";
import { fetchProjectArtifactContentFromApi } from "../helpers/artifactReader.js";

export interface ContextConfig {
  repoPath?: string;
  includePatterns?: string[];
  excludePatterns?: string[];
  maxFiles?: number;
  maxBytes?: number;
  maxDepth?: number;
  trackLines?: boolean;
  trackHash?: boolean;
  forceRescan?: boolean;
  analysisReuseMaxChangedFiles?: number;
}

export interface ContextData {
  repoScan: FileInfo[];
  metadata: {
    scannedAt: number;
    repoPath: string;
    fileCount: number;
    totalBytes: number;
    maxDepth: number;
  };
}

export class ContextStep extends WorkflowStep {
  private static readonly ADDITIONAL_EXCLUDES = [
    ".ma/tasks/**",
    ".ma/**/acquisitions/**",
  ];

  private async isRescanNeeded(
    repoPath: string,
    includePatterns: string[],
    excludePatterns: string[],
  ): Promise<boolean> {
    try {
      const snapshotInfo = await loadExistingSnapshot(repoPath);

      if (!snapshotInfo.exists) {
        logger.info("Context artifacts missing, rescan needed", {
          repoPath,
          snapshotExists: snapshotInfo.snapshotExists,
          summaryExists: snapshotInfo.summaryExists,
          filesNdjsonExists: snapshotInfo.filesNdjsonExists,
        });
        return true;
      }

      const snapshotStat = await fs.stat(snapshotInfo.snapshotPath);
      const lastScanTime = snapshotStat.mtime.getTime();

      const quickScanSpec: ScanSpec = {
        repo_root: repoPath,
        include: includePatterns,
        exclude: excludePatterns,
        max_files: 50,
        max_bytes: 1024 * 1024,
        max_depth: 5,
        track_lines: false,
        track_hash: false,
      };

      const quickScan = await scanRepo(quickScanSpec);

      const hasNewerFiles = quickScan.some((file) => file.mtime > lastScanTime);

      if (hasNewerFiles) {
        logger.info("Source files modified since last scan, rescan needed", {
          lastScanTime: new Date(lastScanTime).toISOString(),
          newerFilesFound: quickScan.filter((f) => f.mtime > lastScanTime)
            .length,
        });
        return true;
      }

      logger.info("Source files unchanged since last scan, reusing context", {
        lastScanTime: new Date(lastScanTime).toISOString(),
        filesChecked: quickScan.length,
      });
      return false;
    } catch (error) {
      logger.warn("Error checking context freshness, will rescan", {
        error: String(error),
        repoPath,
      });
      return true;
    }
  }

  private async loadPreviousSnapshot(repoPath: string): Promise<{
    files: FileInfo[];
    headSha: string | null;
    timestamp: number;
  } | null> {
    try {
      const info = await loadExistingSnapshot(repoPath);
      if (!info.exists) return null;
      const raw = await fs.readFile(info.snapshotPath, "utf8");
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed?.files)) return null;
      return {
        files: parsed.files as FileInfo[],
        headSha: typeof parsed.headSha === "string" ? parsed.headSha : null,
        timestamp: typeof parsed.timestamp === "number" ? parsed.timestamp : 0,
      };
    } catch (error) {
      logger.debug("Failed to load previous snapshot for incremental scan", {
        repoPath,
        error: String(error),
      });
      return null;
    }
  }

  private async loadExistingContext(
    repoPath: string,
  ): Promise<ContextData | null> {
    try {
      const { snapshotPath } = await loadExistingSnapshot(repoPath);

      const snapshotContent = await fs.readFile(snapshotPath, "utf8");
      const snapshot = JSON.parse(snapshotContent);

      const contextData: ContextData = {
        repoScan: snapshot.files || [],
        metadata: {
          scannedAt: snapshot.timestamp || Date.now(),
          repoPath,
          fileCount: snapshot.totals?.files || 0,
          totalBytes: snapshot.totals?.bytes || 0,
          maxDepth: 10,
        },
      };

      logger.info("Loaded existing context data", {
        fileCount: contextData.metadata.fileCount,
        totalBytes: contextData.metadata.totalBytes,
        scannedAt: new Date(contextData.metadata.scannedAt).toISOString(),
      });

      return contextData;
    } catch (error) {
      logger.warn("Failed to load existing context", {
        error: String(error),
        repoPath,
      });
      return null;
    }
  }

  async execute(context: WorkflowContext): Promise<StepResult> {
    const config = this.config.config as ContextConfig;
    const startedAt = Date.now();
    const {
      repoPath: configRepoPath,
      includePatterns = ["**/*"],
      excludePatterns: configExcludePatterns = [
        "node_modules/**",
        ".git/**",
        "dist/**",
        "build/**",
      ],
      maxFiles = 1000,
      maxBytes = 10 * 1024 * 1024,
      maxDepth = 10,
      trackLines = true,
      trackHash = false,
      forceRescan: rawForceRescan = false,
    } = config;

    const excludePatterns = this.mergeExcludePatterns(configExcludePatterns);
    const lookup = (varPath: string) => lookupContextValue(varPath, context);
    const repoPath = determineRepoPath(configRepoPath, context, lookup);
    const forceRescan = coalesceRescanFlags(context, rawForceRescan, lookup);

    if (!repoPath || repoPath.includes("${")) {
      const error = `FATAL: repo_root variable not resolved! Got: "${repoPath}" from config: "${configRepoPath}"`;
      logger.error(error, {
        rawRepoPath: configRepoPath,
        resolvedRepoPath: repoPath,
        workflowId: context.workflowId,
      });
      return {
        status: "failure",
        error: new Error(error),
        data: {},
      };
    }

    try {
      const stats = await fs.stat(repoPath);
      if (!stats.isDirectory()) {
        const error = `FATAL: Resolved repo_root is not a directory: ${repoPath}`;
        logger.error(error, { repoPath, rawRepoPath: configRepoPath });
        return {
          status: "failure",
          error: new Error(error),
          data: {},
        };
      }
    } catch (err) {
      const error = `FATAL: Resolved repo_root does not exist or is not accessible: ${repoPath}`;
      logger.error(error, {
        repoPath,
        rawRepoPath: configRepoPath,
        error: err,
      });
      return {
        status: "failure",
        error: new Error(error),
        data: {},
      };
    }

    const contextPaths = await ensureContextDir(repoPath);
    await hydrateContextArtifacts(repoPath, context.projectId);

    logger.info(`Gathering context for repository: ${repoPath}`, {
      includePatterns,
      excludePatterns,
      maxFiles,
      maxBytes,
      maxDepth,
      forceRescan,
    });

    try {
      let contextData: ContextData | undefined;
      let reusedExisting = false;
      let scanMode: "reused" | "incremental" | "full" = "full";
      let delta: ContextDelta = { added: [], modified: [], removed: [] };
      let filesRead = 0;
      let filesCarried = 0;

      const scanSpec: ScanSpec = {
        repo_root: repoPath,
        include: includePatterns,
        exclude: excludePatterns,
        max_files: maxFiles,
        max_bytes: maxBytes,
        max_depth: maxDepth,
        track_lines: trackLines,
        track_hash: trackHash,
      };

      const previousSnapshot = forceRescan
        ? null
        : await this.loadPreviousSnapshot(repoPath);

      if (!forceRescan && previousSnapshot) {
        let gitChanged: Set<string> | null = null;
        let changeKnown = false;

        if (previousSnapshot.headSha) {
          const gitDelta = await getGitDelta(
            repoPath,
            previousSnapshot.headSha,
          );
          if (gitDelta.ok) {
            gitChanged = filterPathsBySpec(
              gitDelta.changed,
              includePatterns,
              excludePatterns,
            );
            changeKnown = true;
          }
        }

        if (!changeKnown) {
          const needsRescan = await this.isRescanNeeded(
            repoPath,
            includePatterns,
            excludePatterns,
          );
          if (!needsRescan) {
            gitChanged = new Set();
            changeKnown = true;
          }
        }

        if (changeKnown && gitChanged !== null && gitChanged.size === 0) {
          const existingContext = await this.loadExistingContext(repoPath);
          if (existingContext) {
            contextData = existingContext;
            reusedExisting = true;
            scanMode = "reused";

            logger.info("Context gathering completed using existing data", {
              fileCount: contextData.metadata.fileCount,
              totalBytes: contextData.metadata.totalBytes,
              originalScanTime: new Date(
                contextData.metadata.scannedAt,
              ).toISOString(),
            });
          }
        }

        if (!contextData) {
          const merged = await incrementalScan(
            scanSpec,
            previousSnapshot.files,
            gitChanged,
          );
          delta = computeDelta(
            previousSnapshot.files,
            merged.files,
            gitChanged,
          );
          filesRead = merged.readCount;
          filesCarried = merged.carriedCount;
          scanMode = "incremental";

          const totalBytes = merged.files.reduce(
            (sum, file) => sum + file.bytes,
            0,
          );
          contextData = {
            repoScan: merged.files,
            metadata: {
              scannedAt: Date.now(),
              repoPath,
              fileCount: merged.files.length,
              totalBytes,
              maxDepth,
            },
          };

          logger.info("Incremental repository scan completed", {
            fileCount: merged.files.length,
            filesRead,
            filesCarried,
            added: delta.added.length,
            modified: delta.modified.length,
            removed: delta.removed.length,
            gitAnchored: gitChanged !== null,
          });
        }
      }

      let summaryBundle: { summary: string; insights: ContextInsights } | null =
        null;

      if (!contextData || forceRescan) {
        logger.info("Performing new repository scan", {
          reason: forceRescan ? "forced rescan" : "no previous snapshot",
        });

        const repoScan = await scanRepo(scanSpec);

        const totalBytes = repoScan.reduce((sum, file) => sum + file.bytes, 0);
        filesRead = repoScan.length;
        scanMode = "full";

        logger.info("Repository scan completed", {
          fileCount: repoScan.length,
          totalBytes,
          maxDepth,
        });

        contextData = {
          repoScan,
          metadata: {
            scannedAt: Date.now(),
            repoPath,
            fileCount: repoScan.length,
            totalBytes,
            maxDepth,
          },
        };

        logger.info("Context gathering completed with new scan", {
          fileCount: contextData.metadata.fileCount,
          totalBytes: contextData.metadata.totalBytes,
        });
      }

      if (!contextData) {
        throw new Error("Context data unavailable after gather step");
      }

      if (!summaryBundle) {
        summaryBundle = buildContextSummary(contextData);
        summaryBundle.summary = await this.appendCompilationDiagnostics(
          summaryBundle.summary,
          repoPath,
          context,
        );
      }

      const headSha = await getHeadSha(repoPath);

      const snapshotPayload = {
        timestamp: contextData.metadata.scannedAt,
        repoPath,
        files: contextData.repoScan,
        totals: {
          files: contextData.metadata.fileCount,
          bytes: contextData.metadata.totalBytes,
          depth: contextData.metadata.maxDepth,
        },
        headSha,
      };

      if (scanMode !== "reused") {
        const writtenPaths = await writeContextArtifacts(
          repoPath,
          snapshotPayload,
          summaryBundle.summary,
          contextData.repoScan,
          {
            projectId: context.projectId,
            workflowId: context.workflowId,
          },
        );

        contextPaths.snapshotPath = writtenPaths.snapshotPath;
        contextPaths.summaryPath = writtenPaths.summaryPath;
        contextPaths.filesNdjsonPath = writtenPaths.filesNdjsonPath;
      }
      const snapshotJson = JSON.stringify(snapshotPayload, null, 2);
      const filesNdjson = contextData.repoScan
        .map((file) => JSON.stringify(file))
        .join("\n");

      const slimFiles = contextData.repoScan.map(({ path, bytes, lines }) => ({
        path,
        bytes,
        lines,
      }));
      const snapshotSlim = JSON.stringify(
        { repoPath, files: slimFiles, totals: snapshotPayload.totals },
        null,
        2,
      );
      context.setVariable("context_snapshot_slim", snapshotSlim);

      context.setVariable("context_summary_md", summaryBundle.summary);
      context.setVariable("context_insights", summaryBundle.insights);
      context.setVariable(
        "context_primary_language",
        summaryBundle.insights.primaryLanguage,
      );
      context.setVariable(
        "context_secondary_languages",
        summaryBundle.insights.secondaryLanguages,
      );
      context.setVariable(
        "context_frameworks",
        summaryBundle.insights.frameworks,
      );
      context.setVariable(
        "context_potential_issues",
        summaryBundle.insights.potentialIssues,
      );
      context.setVariable(
        "context_setup_commands",
        summaryBundle.insights.setupCommands,
      );
      context.setVariable(
        "context_setup_gaps",
        summaryBundle.insights.setupGaps,
      );
      const allowedLanguages = collectAllowedLanguages(summaryBundle.insights);
      context.setVariable(
        "context_allowed_languages",
        allowedLanguages.display,
      );
      context.setVariable(
        "context_allowed_languages_normalized",
        Array.from(allowedLanguages.normalized),
      );
      context.setVariable("context", contextData);
      context.setVariable("repoScan", contextData.repoScan);
      context.setVariable("context_snapshot_path", contextPaths.snapshotPath);
      context.setVariable("context_summary_path", contextPaths.summaryPath);
      context.setVariable(
        "context_files_ndjson_path",
        contextPaths.filesNdjsonPath,
      );
      context.setVariable("context_snapshot_json", snapshotJson);
      context.setVariable("context_files_ndjson", filesNdjson);

      let analysisRequired = scanMode === "full";
      let analysisDecision =
        scanMode === "full" ? "full scan performed" : "context unchanged";

      if (scanMode === "incremental") {
        const assessment = assessAnalysisReuse(
          delta,
          previousSnapshot?.files ?? [],
          config.analysisReuseMaxChangedFiles ?? 10,
        );
        analysisRequired = !assessment.reusable;
        analysisDecision = assessment.reason;
      }

      if (!analysisRequired) {
        const previousAnalysis = await fetchProjectArtifactContentFromApi({
          projectId: context.projectId,
          kind: "context_analysis",
        });
        if (previousAnalysis !== null) {
          try {
            context.setVariable(
              "context_request_result",
              JSON.parse(previousAnalysis),
            );
          } catch {
            context.setVariable("context_request_result", previousAnalysis);
          }
          context.setVariable("context_request_status", "pass");
          logger.info("Reused previous context analysis", {
            scanMode,
            reason: analysisDecision,
          });
        } else if (scanMode === "incremental") {
          analysisRequired = true;
          analysisDecision = "no cached context analysis available";
        }
      }

      context.setVariable("context_delta", delta);

      logger.info("Context scan decision", {
        scanMode,
        analysisRequired,
        analysisDecision,
        filesRead,
        filesCarried,
      });

      return {
        status: "success",
        data: contextData,
        outputs: {
          context: contextData,
          repoScan: contextData.repoScan,
          reused_existing: reusedExisting,
          scan_mode: scanMode,
          analysis_required: analysisRequired,
          analysis_decision: analysisDecision,
          delta_added: delta.added.length,
          delta_modified: delta.modified.length,
          delta_removed: delta.removed.length,
          delta_files: [
            ...delta.added,
            ...delta.modified,
            ...delta.removed,
          ].slice(0, 50),
          files_read: filesRead,
          files_carried: filesCarried,
          scan_timestamp: contextData.metadata.scannedAt,
          snapshot_path: contextPaths.snapshotPath,
          summary_path: contextPaths.summaryPath,
          files_ndjson_path: contextPaths.filesNdjsonPath,
          summary_md: summaryBundle.summary,
          insights: summaryBundle.insights,
        },
        metrics: {
          duration_ms: Date.now() - startedAt,
          operations_count: contextData.metadata.fileCount,
        },
      };
    } catch (error: any) {
      logger.error("Failed to gather context", {
        error: error.message,
        repoPath,
      });

      return {
        status: "failure",
        error: new Error(`Failed to gather context: ${error.message}`),
      };
    }
  }

  private async appendCompilationDiagnostics(
    summary: string,
    repoPath: string,
    context?: WorkflowContext,
  ): Promise<string> {
    let compilationDiagnostics = "";
    try {
      const hasTsConfig = await fs.access(path.join(repoPath, "tsconfig.json")).then(() => true).catch(() => false);
      if (hasTsConfig) {
        logger.info("Running typecheck diagnostic for repository context...");
        try {
          execSync("npx tsc --noEmit", { cwd: repoPath, encoding: "utf8", stdio: "pipe" });
          compilationDiagnostics = "No compilation or typecheck errors detected.\n";
        } catch (execErr: any) {
          const output = execErr.stdout || execErr.stderr || String(execErr);
          compilationDiagnostics = output.slice(0, 15000);
        }
      }
    } catch (diagErr) {
      logger.debug("Failed to run typecheck diagnostics", { error: String(diagErr) });
    }

    if (compilationDiagnostics) {
      if (compilationDiagnostics.includes("No compilation or typecheck errors detected")) {
        context?.setVariable("baseline_compile_errors", []);
        return summary + `\n## Compilation Diagnostics\n\nNo compilation or typecheck errors detected.\n`;
      }

      const lines = compilationDiagnostics.split("\n");
      const fileErrors = new Map<string, string[]>();
      const otherErrors: string[] = [];

      const errorRegex = /^([a-zA-Z0-9_\-./]+)(?:\((\d+),(\d+)\)|:(\d+):(\d+))[\s:-]+(.*)$/;

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const match = errorRegex.exec(trimmed);
        if (match) {
          const filePath = match[1];
          const lineNum = match[2] || match[4];
          const colNum = match[3] || match[5];
          const message = match[6];
          const formatted = `- Line ${lineNum}, Col ${colNum}: ${message}`;

          if (!fileErrors.has(filePath)) {
            fileErrors.set(filePath, []);
          }
          fileErrors.get(filePath)!.push(formatted);
        } else {
          otherErrors.push(trimmed);
        }
      }

      context?.setVariable(
        "baseline_compile_errors",
        Array.from(fileErrors.entries()).map(([file, errors]) => ({
          file,
          errorCount: errors.length,
          sample: errors.slice(0, 3),
        })),
      );

      let formattedDiagnostics = "";
      if (fileErrors.size > 0) {
        for (const [filePath, errors] of fileErrors.entries()) {
          formattedDiagnostics += `### File: ${filePath}\n`;
          for (const err of errors) {
            formattedDiagnostics += `${err}\n`;
          }
          formattedDiagnostics += "\n";
        }
      }

      if (otherErrors.length > 0) {
        formattedDiagnostics += `### Other Diagnostics\n\`\`\`\n${otherErrors.join("\n")}\n\`\`\`\n`;
      }

      return summary + `\n## Compilation Diagnostics\n\n${formattedDiagnostics}`;
    }
    context?.setVariable("baseline_compile_errors", []);
    return summary;
  }

  private mergeExcludePatterns(patterns: string[]): string[] {
    const merged = new Set(patterns);
    for (const pattern of ContextStep.ADDITIONAL_EXCLUDES) {
      merged.add(pattern);
    }
    return Array.from(merged);
  }

  protected async validateConfig(
    context: WorkflowContext,
  ): Promise<ValidationResult> {
    const config = this.config.config as any;
    const errors: string[] = [];
    const warnings: string[] = [];

    if (
      config.repoPath !== undefined &&
      typeof config.repoPath !== "string"
    ) {
      errors.push("ContextStep: repoPath must be a string when provided");
    }

    if (config.includePatterns !== undefined) {
      if (!Array.isArray(config.includePatterns)) {
        errors.push("ContextStep: includePatterns must be an array");
      } else if (
        !config.includePatterns.every(
          (pattern: any) => typeof pattern === "string",
        )
      ) {
        errors.push("ContextStep: includePatterns must be an array of strings");
      }
    }

    if (config.excludePatterns !== undefined) {
      if (!Array.isArray(config.excludePatterns)) {
        errors.push("ContextStep: excludePatterns must be an array");
      } else if (
        !config.excludePatterns.every(
          (pattern: any) => typeof pattern === "string",
        )
      ) {
        errors.push("ContextStep: excludePatterns must be an array of strings");
      }
    }

    if (
      config.maxFiles !== undefined &&
      (typeof config.maxFiles !== "number" || config.maxFiles < 1)
    ) {
      errors.push("ContextStep: maxFiles must be a positive number");
    }

    if (
      config.maxBytes !== undefined &&
      (typeof config.maxBytes !== "number" || config.maxBytes < 1)
    ) {
      errors.push("ContextStep: maxBytes must be a positive number");
    }

    if (
      config.maxDepth !== undefined &&
      (typeof config.maxDepth !== "number" || config.maxDepth < 0)
    ) {
      errors.push("ContextStep: maxDepth must be a non-negative number");
    }

    if (
      config.trackLines !== undefined &&
      typeof config.trackLines !== "boolean"
    ) {
      errors.push("ContextStep: trackLines must be a boolean");
    }

    if (
      config.trackHash !== undefined &&
      typeof config.trackHash !== "boolean"
    ) {
      errors.push("ContextStep: trackHash must be a boolean");
    }

    const pathCandidate =
      typeof config.repoPath === "string" && !config.repoPath.includes("${")
        ? config.repoPath
        : context.repoRoot;

    if (typeof pathCandidate === "string" && pathCandidate.trim().length) {
      try {
        const fsModule = await import("fs");
        const stats = await fsModule.promises.stat(pathCandidate);
        if (!stats.isDirectory()) {
          warnings.push(
            `ContextStep: repoPath '${pathCandidate}' is not a directory`,
          );
        }
      } catch (error: any) {
        warnings.push(
          `ContextStep: repoPath '${pathCandidate}' may not exist or be accessible`,
        );
      }
    } else {
      warnings.push(
        "ContextStep: No resolvable repoPath during validation; will attempt resolution during execution",
      );
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings,
    };
  }

  async cleanup(context: WorkflowContext): Promise<void> {
    const contextData = context.getVariable("context");
    if (contextData) {
      logger.debug("Cleaning up context data");
    }
  }
}

