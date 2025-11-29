import type { InformationRequest, RepoFileInformationRequest } from "./types.js";

export function clampLine(
  value: number | undefined,
  fallback: number,
  max: number,
): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (value < 1) return 1;
  if (value > max) return max;
  return value;
}

export function parseRepoFilePath(rawPath: string): {
  normalizedPath: string;
  inferredStartLine?: number;
  inferredEndLine?: number;
} {
  const trimmed = (rawPath || "").trim();
  if (!trimmed.length) {
    return { normalizedPath: trimmed };
  }

  const hashIndex = trimmed.lastIndexOf("#");
  if (hashIndex === -1) {
    return { normalizedPath: trimmed };
  }

  const basePath = trimmed.slice(0, hashIndex).trim() || trimmed;
  const fragment = trimmed.slice(hashIndex + 1);
  const anchorMatch = fragment.match(/^L(\d+)(?:-L?(\d+))?$/i);
  if (!anchorMatch) {
    return { normalizedPath: basePath };
  }

  const start = Number.parseInt(anchorMatch[1], 10);
  const end = anchorMatch[2]
    ? Number.parseInt(anchorMatch[2], 10)
    : undefined;

  return {
    normalizedPath: basePath,
    inferredStartLine: Number.isFinite(start) ? start : undefined,
    inferredEndLine:
      end !== undefined && Number.isFinite(end) ? end : undefined,
  };
}

export function trimToLimits(
  value: string,
  maxBytes: number,
  maxChars: number,
  alreadyTruncated = false,
): { content: string; truncated: boolean } {
  const byteLength = Buffer.byteLength(value, "utf8");
  if (byteLength <= maxBytes && value.length <= maxChars && !alreadyTruncated) {
    return { content: value, truncated: false };
  }

  let content = value;
  let truncated = alreadyTruncated;
  if (content.length > maxChars) {
    content = content.slice(0, maxChars);
    truncated = true;
  }

  while (Buffer.byteLength(content, "utf8") > maxBytes && content.length > 0) {
    content = content.slice(0, -1);
    truncated = true;
  }

  return { content, truncated };
}

export function buildSummaryBlock(
  ordinal: number,
  request: InformationRequest,
  error: string | undefined,
  snippet: string | undefined,
  truncated?: boolean,
  metadata?: Record<string, any>,
  artifactPath?: string,
): string {
  const header = `Information Request #${ordinal}`;
  const typeLabel = request.type === "repo_file" ? "Repository File" : "HTTP";
  const entries: string[] = [
    header,
    `Type: ${typeLabel}`,
  ];

  if (request.type === "repo_file") {
    entries.push(`Source: ${request.path}`);
    if (request.startLine || request.endLine) {
      entries.push(
        `Lines: ${request.startLine ?? "?"}-${request.endLine ?? "?"}`,
      );
    }
  } else if (request.type === "http_get") {
    entries.push(`URL: ${request.url}`);
  }

  if (request.reason) {
    entries.push(`Reason: ${request.reason}`);
  }

  if (metadata?.bytesReturned !== undefined) {
    entries.push(`Bytes Returned: ${metadata.bytesReturned}`);
  }

  if (truncated) {
    entries.push("Note: Content truncated to configured limits.");
  }

  if (artifactPath) {
    entries.push(`Saved artifact: ${artifactPath}`);
  }

  if (error) {
    entries.push(`Error: ${error}`);
    return entries.join("\n");
  }

  if (snippet) {
    entries.push("Snippet:");
    entries.push("```\n" + snippet + "\n```");
  }

  return entries.join("\n");
}

export function isHttpHostDenied(hostname: string, denyHosts: string[]): boolean {
  if (!denyHosts || denyHosts.length === 0) {
    return false;
  }

  const normalizedHost = hostname.toLowerCase();
  for (const pattern of denyHosts) {
    const trimmed = pattern.trim().toLowerCase();
    if (!trimmed) continue;
    if (trimmed === normalizedHost) return true;
    if (trimmed.startsWith("*.")) {
      const suffix = trimmed.slice(1);
      if (
        normalizedHost.endsWith(suffix) &&
        normalizedHost.split(".").length >= suffix.split(".").length
      ) {
        return true;
      }
    }
  }
  return false;
}

export function extractGithubSlug(
  remote: string,
): { owner: string; repo: string } | undefined {
  if (!remote || !remote.toLowerCase().includes("github.com")) {
    return undefined;
  }

  const match = remote
    .trim()
    .match(/github\.com[:/](.+)$/i);
  if (!match) {
    return undefined;
  }

  const segments = match[1]
    .split(/[\\/]/)
    .filter(Boolean)
    .map((segment) => segment.trim());
  if (segments.length < 2) {
    return undefined;
  }

  const owner = segments[0].toLowerCase();
  const repo = stripGitSuffix(segments[1]).toLowerCase();
  if (!owner || !repo) {
    return undefined;
  }
  return { owner, repo };
}

export function parseGithubFileUrl(urlObj: URL):
  | { owner: string; repo: string; relativePath: string; anchor?: string }
  | undefined {
  const host = urlObj.hostname.toLowerCase();
  const anchor = urlObj.hash ? urlObj.hash.slice(1) : undefined;

  if (host === "github.com") {
    const parts = decodeGithubSegments(urlObj.pathname);
    if (parts.length < 4) return undefined;
    const [owner, repoRaw, variant, ...rest] = parts;
    if (!owner || !repoRaw || !rest.length) return undefined;
    if (variant !== "blob" && variant !== "raw") return undefined;
    if (rest.length < 2) return undefined;
    rest.shift();
    if (!rest.length) return undefined;
    return {
      owner: owner.toLowerCase(),
      repo: stripGitSuffix(repoRaw).toLowerCase(),
      relativePath: rest.join("/"),
      anchor,
    };
  }

  if (host === "raw.githubusercontent.com") {
    const parts = decodeGithubSegments(urlObj.pathname);
    if (parts.length < 4) return undefined;
    const [owner, repoRaw, _branch, ...rest] = parts;
    if (!owner || !repoRaw || !rest.length) return undefined;
    return {
      owner: owner.toLowerCase(),
      repo: stripGitSuffix(repoRaw).toLowerCase(),
      relativePath: rest.join("/"),
      anchor,
    };
  }

  return undefined;
}

export function convertGithubRequestToRepoFile(
  urlObj: URL,
  request: { id?: string; maxBytes?: number; reason?: string },
  repoSlug: { owner: string; repo: string } | undefined,
): RepoFileInformationRequest | undefined {
  if (!repoSlug) {
    return undefined;
  }

  const target = parseGithubFileUrl(urlObj);
  if (!target) {
    return undefined;
  }

  if (
    target.owner !== repoSlug.owner ||
    target.repo !== repoSlug.repo ||
    !target.relativePath
  ) {
    return undefined;
  }

  const anchorSuffix = target.anchor ? `#${target.anchor}` : "";
  return {
    id: request.id,
    type: "repo_file",
    path: `${target.relativePath}${anchorSuffix}`,
    maxBytes: request.maxBytes,
    reason: request.reason,
  };
}

function decodeGithubSegments(pathname: string): string[] {
  return pathname
    .split("/")
    .filter(Boolean)
    .map((segment) => {
      try {
        return decodeURIComponent(segment);
      } catch {
        return segment;
      }
    });
}

function stripGitSuffix(value: string): string {
  return value.endsWith(".git") ? value.slice(0, -4) : value;
}
