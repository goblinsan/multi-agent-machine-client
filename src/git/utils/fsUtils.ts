import fs from "fs/promises";

/**
 * fsUtils - Filesystem utility functions
 * 
 * Responsibilities:
 * - Check directory existence
 * - Sanitize path segments for safe filesystem operations
 */

/**
 * Sanitize a path segment for filesystem safety
 * Normalizes to lowercase for consistent paths
 */
export function sanitizeSegment(seg: string) {
  // Normalize to lowercase to ensure consistent repo paths regardless of casing in project hints
  // This prevents /Multi-Agent-Log-Summarizer and /machine-client-log-summarizer from being different paths
  return seg.replace(/[^A-Za-z0-9._-]/g, "-").toLowerCase();
}

/**
 * Check if a path exists and is a directory
 */
export async function directoryExists(p: string) {
  try {
    return (await fs.stat(p)).isDirectory();
  } catch {
    return false;
  }
}
