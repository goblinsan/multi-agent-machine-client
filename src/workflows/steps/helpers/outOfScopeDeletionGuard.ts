import { runGit } from "../../../gitUtils.js";

function normalizeScopePath(value: string): string {
  return String(value || "")
    .replace(/\\/g, "/")
    .replace(/^\.\/+/, "")
    .replace(/^\/+/, "")
    .trim();
}

export interface DeletionGuardResult {
  restored: string[];
  failed: string[];
}

export async function restoreOutOfScopeDeletions(
  repoRoot: string,
  allowedPaths: string[] | undefined,
): Promise<DeletionGuardResult> {
  const normalized = (allowedPaths || [])
    .map(normalizeScopePath)
    .filter((p) => p.length > 0);
  if (normalized.length === 0) return { restored: [], failed: [] };
  const allowedFiles = new Set(normalized.filter((p) => !p.endsWith("/")));
  const allowedDirs = normalized.filter((p) => p.endsWith("/"));

  let statusText: string;
  try {
    const status = await runGit(["status", "--porcelain"], { cwd: repoRoot });
    statusText = status.stdout || "";
  } catch {
    return { restored: [], failed: [] };
  }

  const restored: string[] = [];
  const failed: string[] = [];
  for (const line of statusText.split(/\r?\n/)) {
    if (line.length < 4) continue;
    if (line[0] !== "D" && line[1] !== "D") continue;
    const rawPath = line.slice(3).trim().replace(/^"|"$/g, "");
    const scopePath = normalizeScopePath(rawPath);
    const inScope =
      allowedFiles.has(scopePath) ||
      allowedDirs.some((dir) => scopePath.startsWith(dir));
    if (inScope) continue;
    try {
      await runGit(["checkout", "HEAD", "--", rawPath], { cwd: repoRoot });
      restored.push(scopePath);
    } catch {
      failed.push(scopePath);
    }
  }
  return { restored, failed };
}
