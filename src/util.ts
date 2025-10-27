import { cfg as _cfg } from "./config.js";

export const CODING_PERSONA_SET = new Set([
  "lead-engineer", 
  "devops", 
  "ui-engineer", 
  "qa-engineer", 
  "ml-engineer"
].map(p => p.trim().toLowerCase()).filter(Boolean));

export const ENGINEER_PERSONAS_REQUIRING_PLAN = new Set(["lead-engineer", "ui-engineer"]);

export function firstString(...values: any[]): string | null {
    for (const value of values) {
      if (typeof value === "string") {
        const trimmed = value.trim();
        if (trimmed.length) return trimmed;
      }
    }
    return null;
  }
  
export function numericHint(value: any): number {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string") {
      const num = Number(value);
      if (!Number.isNaN(num)) return num;
    }
    return Number.POSITIVE_INFINITY;
  }

export function slugify(value: string) {
    return (value || "").toString().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").replace(/-{2,}/g, "-") || "milestone";
  }

  export function toArray(value: any): any[] {
    if (!value) return [];
    if (Array.isArray(value)) return value;
    if (typeof value === "object") {
      const edges = (value as any).edges;
      if (Array.isArray(edges)) {
        return edges.map((edge: any) => edge?.node ?? edge).filter(Boolean);
      }
      const candidates = ["items", "data", "nodes", "list", "values", "results"];
      for (const key of candidates) {
        const nested = (value as any)[key];
        if (Array.isArray(nested)) return nested;
      }
      return [value];
    }
    return [];
  }

  export function normalizeRepoPath(p: string | undefined, fallback: string) {
    if (!p || typeof p !== "string") return fallback;
    const unescaped = p.replace(/\\/g, "/"); // collapse escaped backslashes
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

  export function clipText(text: string, max = 6000) {
    if (!text) return text;
    if (text.length <= max) return text;
    return text.slice(0, max) + `\n... (truncated ${text.length - max} chars)`;
  }

  export function shouldUploadDashboardFlag(value: any): boolean {
    if (value === undefined || value === null) return true;
    if (typeof value === "boolean") return value;
    if (typeof value === "number") return value !== 0;
    if (typeof value === "string") {
      const normalized = value.trim().toLowerCase();
      return !["0", "false", "no", "off"].includes(normalized);
    }
    return Boolean(value);
  }

  export function personaTimeoutMs(persona: string, cfg: any) {
    const key = (persona || "").toLowerCase();
    if (key && cfg.personaTimeouts[key] !== undefined) return cfg.personaTimeouts[key];
    return cfg.personaDefaultTimeoutMs;
  }

  /**
   * Get max retries for a persona (returns null for unlimited)
   */
  export function personaMaxRetries(persona: string, cfg: any): number | null {
    const key = (persona || "").toLowerCase();
    if (key && cfg.personaMaxRetries && cfg.personaMaxRetries[key] !== undefined) {
      return cfg.personaMaxRetries[key];
    }
    return cfg.personaDefaultMaxRetries ?? 3;
  }

  /**
   * Calculate progressive backoff timeout for a retry attempt
   * Formula: baseTimeout + (attemptNumber * backoffIncrement)
   * 
   * Example with 60s base timeout and 30s increment:
   * - Attempt 1: 60s
   * - Attempt 2: 90s (60 + 30)
   * - Attempt 3: 120s (60 + 60)
   * - Attempt 4: 150s (60 + 90)
   * 
   * @param baseTimeoutMs Base timeout in milliseconds
   * @param attemptNumber Current attempt number (1-based)
   * @param backoffIncrementMs Backoff increment per attempt (default: 30000ms)
   * @returns Timeout in milliseconds for this attempt
   */
  export function calculateProgressiveTimeout(
    baseTimeoutMs: number,
    attemptNumber: number,
    backoffIncrementMs: number = 30000
  ): number {
    if (attemptNumber <= 1) return baseTimeoutMs;
    const additionalBackoff = (attemptNumber - 1) * backoffIncrementMs;
    return baseTimeoutMs + additionalBackoff;
  }