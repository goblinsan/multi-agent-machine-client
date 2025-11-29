import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { fetch } from "undici";

import { cfg } from "../../../config.js";
import { WorkflowContext } from "../../engine/WorkflowContext.js";
import { logger } from "../../../logger.js";
import type {
  HandlerMeta,
  HttpInformationRequest,
  InformationRequest,
  InformationRequestRecord,
  RepoFileInformationRequest,
} from "./informationRequest/types.js";
import {
  buildSummaryBlock,
  clampLine,
  convertGithubRequestToRepoFile,
  extractGithubSlug,
  isHttpHostDenied,
  parseRepoFilePath,
  trimToLimits,
} from "./informationRequest/utils.js";

export type {
  HandlerMeta,
  HttpInformationRequest,
  InformationRequest,
  InformationRequestRecord,
  RepoFileInformationRequest,
} from "./informationRequest/types.js";
export {
  isInformationRequestResult,
  normalizeInformationRequests,
} from "./informationRequest/normalization.js";

export class InformationRequestHandler {
  constructor(private readonly context: WorkflowContext) {}

  fulfillRequests(
    requests: InformationRequest[],
    meta: HandlerMeta,
    duplicateTracker?: Set<string>,
  ): Promise<InformationRequestRecord[]> {
    const limited = this.limitRequests(requests);
    const executions = limited.map((request, index) =>
      this.fulfillSingleRequest(request, index + 1, meta, duplicateTracker),
    );
    return Promise.all(executions);
  }

  private limitRequests(requests: InformationRequest[]): InformationRequest[] {
    const { informationRequests } = cfg;
    if (!informationRequests) return requests;
    const limit = Math.max(1, informationRequests.maxRequestsPerIteration || 1);
    if (requests.length <= limit) return requests;

    logger.warn("Limiting information requests to configured maximum", {
      workflowId: this.context.workflowId,
      requested: requests.length,
      limit,
    });

    return requests.slice(0, limit);
  }

  private async fulfillSingleRequest(
    request: InformationRequest,
    ordinal: number,
    meta: HandlerMeta,
    duplicateTracker?: Set<string>,
  ): Promise<InformationRequestRecord> {
    const signature = this.computeRequestSignature(request);
    if (signature && duplicateTracker?.has(signature)) {
      return this.buildDuplicateRecord(request, ordinal, signature);
    }

    if (request.type === "repo_file") {
      const record = await this.handleRepoFile(request, ordinal, meta);
      if (signature && record.status === "success") {
        duplicateTracker?.add(signature);
      }
      return record;
    }
    if (request.type === "http_get") {
      const record = await this.handleHttpRequest(request, ordinal, meta);
      if (signature && record.status === "success") {
        duplicateTracker?.add(signature);
      }
      return record;
    }

    const unknownType = (request as InformationRequest | { type?: string }).type;
    return {
      request,
      status: "error",
      summaryBlock: buildSummaryBlock(
        ordinal,
        request,
        "Unsupported request type",
        undefined,
        true,
      ),
      error: unknownType
        ? `Unsupported request type: ${unknownType}`
        : "Unsupported request type",
    };
  }

  private buildDuplicateRecord(
    request: InformationRequest,
    ordinal: number,
    signature: string,
  ): InformationRequestRecord {
    const guidance =
      "Request already satisfied earlier; refer to prior context and proceed with analysis.";
    return {
      request,
      status: "duplicate",
      summaryBlock: buildSummaryBlock(
        ordinal,
        request,
        `${guidance} (hash ${signature.slice(0, 8)})`,
        undefined,
        undefined,
        undefined,
        undefined,
      ),
      metadata: {
        duplicateOf: signature,
      },
    };
  }

  private computeRequestSignature(request: InformationRequest): string | null {
    try {
      if (request.type === "repo_file") {
        const { normalizedPath, inferredStartLine, inferredEndLine } =
          parseRepoFilePath(request.path);
        const payload = {
          type: request.type,
          path: normalizedPath,
          startLine: request.startLine ?? inferredStartLine ?? null,
          endLine: request.endLine ?? inferredEndLine ?? null,
          maxBytes: request.maxBytes ?? null,
        };
        return createHash("sha1").update(JSON.stringify(payload)).digest("hex");
      }
      if (request.type === "http_get") {
        const payload = {
          type: request.type,
          url: (request.url || "").trim(),
          maxBytes: request.maxBytes ?? null,
        };
        return createHash("sha1").update(JSON.stringify(payload)).digest("hex");
      }
    } catch (_error) {
      return null;
    }
    return null;
  }

  private async handleRepoFile(
    request: RepoFileInformationRequest,
    ordinal: number,
    meta: HandlerMeta,
  ): Promise<InformationRequestRecord> {
    const { informationRequests } = cfg;
    const repoRoot = this.context.repoRoot;
    const { normalizedPath, inferredStartLine, inferredEndLine } =
      parseRepoFilePath(request.path);
    const resolvedPath = path.resolve(repoRoot, normalizedPath);
    const repoNormalized = path.normalize(repoRoot + path.sep);
    if (!resolvedPath.startsWith(repoNormalized)) {
      const error = "Requested file is outside the repository";
      return {
        request,
        status: "error",
        error,
        summaryBlock: buildSummaryBlock(ordinal, request, error, undefined, true),
      };
    }

    let snippet = "";
    let truncated = false;
    let metadata: Record<string, any> = {};

    try {
      const rawContent = await fs.readFile(resolvedPath, "utf8");
      const lines = rawContent.split(/\r?\n/);
      const startLine = clampLine(
        request.startLine ?? inferredStartLine,
        1,
        lines.length,
      );
      const endLine = clampLine(
        request.endLine ?? inferredEndLine,
        lines.length,
        lines.length,
      );
      const hasLineWindow = startLine !== undefined || endLine !== undefined;
      const appliedStartLine = startLine ?? 1;
      const appliedEndLine = endLine ?? startLine ?? lines.length;
      const normalizedEndLine = Math.max(appliedStartLine, appliedEndLine);
      const slice = hasLineWindow
        ? lines.slice(appliedStartLine - 1, normalizedEndLine).join("\n")
        : rawContent;

      const maxBytes = request.maxBytes || informationRequests?.maxFileBytes || 200000;
      const maxChars = informationRequests?.maxSnippetChars || 8000;
      const trimmed = trimToLimits(slice, maxBytes, maxChars);
      snippet = trimmed.content;
      truncated = trimmed.truncated;
      metadata = {
        path: path.relative(repoRoot, resolvedPath),
        startLine: hasLineWindow ? appliedStartLine : undefined,
        endLine: hasLineWindow ? normalizedEndLine : undefined,
        bytesReturned: Buffer.byteLength(snippet, "utf8"),
        truncated,
      };
    } catch (error: any) {
      const message = error?.message || String(error);
      return {
        request,
        status: "error",
        error: message,
        summaryBlock: buildSummaryBlock(ordinal, request, message, undefined, true),
      };
    }

    const artifactPath = await this.writeArtifact(
      {
        request,
        persona: meta.persona,
        step: meta.step,
        iteration: meta.iteration,
        snippet,
        truncated,
        metadata,
        fetchedAt: new Date().toISOString(),
      },
      meta.taskId,
    );

    const summaryBlock = buildSummaryBlock(
      ordinal,
      request,
      undefined,
      snippet,
      truncated,
      metadata,
      artifactPath,
    );

    return {
      request,
      status: "success",
      summaryBlock,
      contentSnippet: snippet,
      truncated,
      metadata,
      artifactPath,
    };
  }

  private async handleHttpRequest(
    request: HttpInformationRequest,
    ordinal: number,
    meta: HandlerMeta,
  ): Promise<InformationRequestRecord> {
    const { informationRequests } = cfg;
    const denyHosts = informationRequests?.denyHosts || [];
    const maxBytes = request.maxBytes || informationRequests?.maxHttpBytes || 200000;
    const timeoutMs = informationRequests?.httpTimeoutMs || 20000;

    let urlObj: URL;
    try {
      urlObj = new URL(request.url);
    } catch (error) {
      const message = "Invalid URL provided";
      return {
        request,
        status: "error",
        error: message,
        summaryBlock: buildSummaryBlock(ordinal, request, message, undefined, true),
      };
    }

    const remote = this.context.getVariable("repo_remote");
    const repoSlug =
      typeof remote === "string" ? extractGithubSlug(remote) : undefined;
    const githubRepoRequest = convertGithubRequestToRepoFile(
      urlObj,
      request,
      repoSlug,
    );
    if (githubRepoRequest) {
      logger.info("Serving GitHub info request via local repository", {
        workflowId: this.context.workflowId,
        path: githubRepoRequest.path,
        url: request.url,
      });
      return this.handleRepoFile(githubRepoRequest, ordinal, meta);
    }

    if (isHttpHostDenied(urlObj.hostname, denyHosts)) {
      const message = informationRequests?.denyHostsFile
        ? `Host '${urlObj.hostname}' is blocked by ${informationRequests.denyHostsFile}.`
        : `Host '${urlObj.hostname}' is blocked by INFO_REQUEST_DENY_HOSTS_FILE.`;
      return {
        request,
        status: "error",
        error: message,
        summaryBlock: buildSummaryBlock(ordinal, request, message, undefined, true),
      };
    }

    try {
      const controller = new AbortController();
      const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs);
      const response = await fetch(request.url, {
        method: "GET",
        headers: request.headers,
        signal: controller.signal,
        redirect: "follow",
      }).finally(() => clearTimeout(timeoutHandle));

      if (!response.ok) {
        const message = `Request failed with status ${response.status}`;
        return {
          request,
          status: "error",
          error: message,
          summaryBlock: buildSummaryBlock(ordinal, request, message, undefined, true),
        };
      }

      const reader = response.body?.getReader();
      if (!reader) {
        const message = "Response stream unavailable";
        return {
          request,
          status: "error",
          error: message,
          summaryBlock: buildSummaryBlock(ordinal, request, message, undefined, true),
        };
      }

      let received = 0;
      const chunks: Uint8Array[] = [];
      let truncated = false;
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        if (!value) continue;
        received += value.length;
        if (received > maxBytes) {
          const remaining = maxBytes - (received - value.length);
          if (remaining > 0) {
            chunks.push(value.slice(0, remaining));
          }
          truncated = true;
          break;
        }
        chunks.push(value);
      }

      const buffer = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
      let text = buffer.toString("utf8");
      const maxChars = informationRequests?.maxSnippetChars || 8000;
      const trimmed = trimToLimits(text, maxBytes, maxChars, truncated);
      text = trimmed.content;
      truncated = truncated || trimmed.truncated;

      const metadata = {
        url: request.url,
        status: response.status,
        contentType: response.headers.get("content-type") || "",
        bytesReturned: Buffer.byteLength(text, "utf8"),
        truncated,
      };

      const artifactPath = await this.writeArtifact(
        {
          request,
          persona: meta.persona,
          step: meta.step,
          iteration: meta.iteration,
          snippet: text,
          truncated,
          metadata,
          fetchedAt: new Date().toISOString(),
        },
        meta.taskId,
      );

      const summaryBlock = buildSummaryBlock(
        ordinal,
        request,
        undefined,
        text,
        truncated,
        metadata,
        artifactPath,
      );

      return {
        request,
        status: "success",
        summaryBlock,
        contentSnippet: text,
        truncated,
        metadata,
        artifactPath,
      };
    } catch (error: any) {
      const message = error?.message || String(error);
      return {
        request,
        status: "error",
        error: message,
        summaryBlock: buildSummaryBlock(ordinal, request, message, undefined, true),
      };
    }
  }

  private async writeArtifact(
    record: Record<string, any>,
    taskId?: string | number,
  ): Promise<string | undefined> {
    try {
      if (taskId === undefined || taskId === null) {
        return undefined;
      }

      const normalizedTaskId = String(taskId).trim();
      if (!normalizedTaskId.length) {
        return undefined;
      }
      const artifactDir = path.join(
        this.context.repoRoot,
        cfg.informationRequests?.artifactSubdir || ".ma/tasks",
        normalizedTaskId,
        "acquisitions",
      );
      await fs.mkdir(artifactDir, { recursive: true });
      const fileName = `info-${Date.now()}.json`;
      const filePath = path.join(artifactDir, fileName);
      await fs.writeFile(filePath, JSON.stringify(record, null, 2), "utf8");
      return path.relative(this.context.repoRoot, filePath);
    } catch (error) {
      logger.warn("Failed to persist information request artifact", {
        workflowId: this.context.workflowId,
        error: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    }
  }
}
