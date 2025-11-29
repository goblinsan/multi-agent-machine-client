import type {
  HttpInformationRequest,
  InformationRequest,
  RepoFileInformationRequest,
} from "./types.js";

export function isInformationRequestResult(result: any): boolean {
  if (!result || typeof result !== "object") {
    return false;
  }

  const status = typeof result.status === "string" ? result.status : "";
  if (status.toLowerCase() === "info_request") {
    return Array.isArray(result.requests) && result.requests.length > 0;
  }

  if (result.info_request === true && Array.isArray(result.requests)) {
    return result.requests.length > 0;
  }

  if (Array.isArray(result.requests) && result.requests.length > 0) {
    const first = result.requests[0];
    return typeof first === "object" && typeof first.type === "string";
  }

  return false;
}

export function normalizeInformationRequests(raw: any): InformationRequest[] {
  if (!raw || (typeof raw !== "object" && !Array.isArray(raw))) {
    return [];
  }

  const requests = Array.isArray(raw)
    ? raw
    : Array.isArray((raw as any).requests)
      ? (raw as any).requests
      : [];

  const normalized: InformationRequest[] = [];
  for (const entry of requests) {
    if (!entry || typeof entry !== "object") continue;
    const inferredType = inferRequestType(entry);
    const explicitType =
      typeof entry.type === "string" && entry.type.trim().length > 0
        ? entry.type.trim().toLowerCase()
        : typeof entry.kind === "string" && entry.kind.trim().length > 0
          ? entry.kind.trim().toLowerCase()
          : "";
    const typeValue = (explicitType || inferredType || "").trim();
    if (!typeValue) continue;

    if (typeValue === "repo_file") {
      const pathValue = String(
        entry.path ||
          entry.file ||
          entry.file_path ||
          entry.repo_file ||
          entry.repoPath ||
          "",
      ).trim();
      if (!pathValue) continue;
      const request: RepoFileInformationRequest = {
        id: sanitizeId(entry.id || entry.request_id),
        type: "repo_file",
        path: pathValue,
        startLine: coercePositiveInt(entry.startLine ?? entry.start_line),
        endLine: coercePositiveInt(entry.endLine ?? entry.end_line),
        maxBytes: coercePositiveInt(entry.maxBytes ?? entry.max_bytes),
        reason: sanitizeReason(entry.reason || entry.explanation),
      };
      normalized.push(request);
      continue;
    }

    if (typeValue === "http" || typeValue === "http_get" || typeValue === "url") {
      const urlValue = String(
        entry.url ||
          entry.uri ||
          entry.http_get ||
          entry.link ||
          "",
      ).trim();
      if (!urlValue) continue;
      const headers = normalizeHeaders(entry.headers);
      const request: HttpInformationRequest = {
        id: sanitizeId(entry.id || entry.request_id),
        type: "http_get",
        url: urlValue,
        method: "GET",
        headers,
        maxBytes: coercePositiveInt(entry.maxBytes ?? entry.max_bytes),
        reason: sanitizeReason(entry.reason || entry.explanation),
      };
      normalized.push(request);
      continue;
    }
  }
  return normalized;
}

function inferRequestType(entry: Record<string, any>): string | "" {
  if (typeof entry.repo_file === "string") {
    return "repo_file";
  }
  if (typeof entry.http_get === "string") {
    return "http_get";
  }
  if (typeof entry.url === "string") {
    return "http_get";
  }
  if (typeof entry.file === "string" || typeof entry.file_path === "string") {
    return "repo_file";
  }
  return "";
}

function coercePositiveInt(value: any): number | undefined {
  if (value === undefined || value === null) return undefined;
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return undefined;
  return Math.floor(num);
}

function sanitizeId(value: any): string | undefined {
  if (!value) return undefined;
  const str = String(value).trim();
  return str.length ? str.slice(0, 64) : undefined;
}

function sanitizeReason(value: any): string | undefined {
  if (!value) return undefined;
  const str = String(value).trim();
  return str.length ? str : undefined;
}

function normalizeHeaders(headers: any): Record<string, string> | undefined {
  if (!headers || typeof headers !== "object") {
    return undefined;
  }

  const normalizedEntries = Object.entries(headers).flatMap(([key, value]) => {
    if (!key) return [];
    const headerName = String(key).trim().toLowerCase();
    if (!headerName) return [];
    if (typeof value === "string" && value.trim().length > 0)
      return [[headerName, value.trim()]];
    if (Array.isArray(value)) {
      return value
        .map((entry) => String(entry || "").trim())
        .filter(Boolean)
        .map((val) => [headerName, val]);
    }
    if (value === undefined || value === null) return [];
    return [[headerName, String(value)]];
  });

  if (!normalizedEntries.length) return undefined;
  return Object.fromEntries(normalizedEntries);
}
