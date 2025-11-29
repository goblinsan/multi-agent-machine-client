import { cfg } from "./config.js";
import { logger } from "./logger.js";
import { buildExtensionPolicy, evaluatePolicy, isGloballyBlockedPath } from "./fileopsPolicy.js";

export { applyEditOps, writeDiagnostic } from "./fileops/applyEditOps.js";

export type Hunk = {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: string[];
};
export type UpsertOp = {
  action: "upsert";
  path: string;
  content?: string;
  hunks?: Hunk[];
};
export type DeleteOp = { action: "delete"; path: string };
export type EditSpec = { ops: Array<UpsertOp | DeleteOp>; warnings?: string[] };

export type ApplyOptions = {
  repoRoot: string;
  maxBytes?: number;
  blockedExts?: string[];
  branchName?: string;
  commitMessage?: string;
};

export function parseUnifiedDiffToEditSpec(
  diffText: string,
  opts?: { blockedExts?: string[]; warnings?: string[] },
) {
  const blockedPolicy = [
    ...(cfg.blockedExts || []),
    ...(opts?.blockedExts || []),
  ];
  const extensionPolicy = buildExtensionPolicy(blockedPolicy);
  const warnings: string[] = opts?.warnings || [];
  const skippedPolicyPaths = new Set<string>();
  const ops: Array<UpsertOp | DeleteOp> = [];
  if (!diffText || !diffText.length) return { ops, warnings };

  let raw = String(diffText);

  const rawDiffIdx = raw.indexOf("diff --git");
  if (rawDiffIdx >= 0) raw = raw.slice(rawDiffIdx);

  const fenced = /```(?:diff)?\n([\s\S]*?)```/.exec(raw);
  if (fenced && fenced[1]) {
    const inner = fenced[1];
    if (
      inner.includes("diff --git") ||
      inner.includes("+++ b/") ||
      inner.includes("@@")
    ) {
      raw = inner;
    }
  }

  const pre = /<pre[^>]*>([\s\S]*?)<\/pre>/.exec(raw);
  if (pre && pre[1]) raw = pre[1];

  const firstIdx = raw.search(/(^|\n)(diff --git |@@ |\+\+\+ b\/)/);
  if (firstIdx >= 0) raw = raw.slice(firstIdx);

  let fileSections: string[] =
    raw.match(/diff --git[\s\S]*?(?=(?:diff --git|$))/g) || ([] as string[]);

  if (fileSections.length === 0 && /^(?:--- |\+\+\+ |@@ )/m.test(raw)) {
    const headerless: string[] = [];
    const parts = raw.split(/(?=^---\s+)/m);
    for (const part of parts) {
      if (!/\+\+\+\s+/.test(part)) continue;
      headerless.push(part);
    }
    if (headerless.length) fileSections = headerless;
  }
  for (const section of fileSections) {
    const lines = section.split(/\r?\n/);

    const gitLine = lines.find((l) => l.startsWith("diff --git")) || "";
    const m = /diff --git a\/(.+?) b\/(.+)$/.exec(gitLine);
    let aPath: string | null = null;
    let bPath: string | null = null;
    for (const l of lines) {
      const aMatch = /^---\s+(?:a\/)?(?:"([^"]+)"|([^\t\n]+))/.exec(l);
      const bMatch = /^\+\+\+\s+(?:b\/)?(?:"([^"]+)"|([^\t\n]+))/.exec(l);
      if (aMatch) aPath = (aMatch[1] || aMatch[2] || "").trim();
      if (bMatch) bPath = (bMatch[1] || bMatch[2] || "").trim();
    }
    if (m) {
      aPath = aPath || m[1];
      bPath = bPath || m[2];
    }

    const deleted =
      bPath === "/dev/null" || (bPath && bPath.endsWith("/dev/null"));
    const targetPath = bPath && bPath !== "/dev/null" ? bPath : aPath;
    if (!targetPath) continue;

    if (isGloballyBlockedPath(targetPath)) {
      warnings.push(`Skipped path blocked by policy: ${targetPath}`);
      skippedPolicyPaths.add(targetPath);
      continue;
    }

    const verdict = evaluatePolicy(targetPath, extensionPolicy);
    if (!verdict.allowed) {
      warnings.push(`Skipped path blocked by extension policy: ${targetPath}`);
      skippedPolicyPaths.add(targetPath);
      continue;
    }

    const hunks: Array<{
      oldStart: number;
      oldCount: number;
      newStart: number;
      newCount: number;
      lines: string[];
    }> = [];
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];

      const h = /^@@\s+-?(\d+)(?:,(\d+))?\s+\+?(\d+)(?:,(\d+))?\s+@@/.exec(
        line,
      );
      if (h) {
        const oldStart = parseInt(h[1], 10);
        const oldCount = h[2] ? parseInt(h[2], 10) : 1;
        const newStart = parseInt(h[3], 10);
        const newCount = h[4] ? parseInt(h[4], 10) : 1;
        i += 1;
        const hLines: string[] = [];
        while (
          i < lines.length &&
          !/^@@\s+/.test(lines[i]) &&
          !lines[i].startsWith("diff --git ")
        ) {
          if (/^\\ No newline at end of file/.test(lines[i])) {
            i += 1;
            continue;
          }
          hLines.push(lines[i]);
          i += 1;
        }
        hunks.push({ oldStart, oldCount, newStart, newCount, lines: hLines });
        continue;
      }
      i += 1;
    }

    if (!hunks.length) {
      const plusLines = lines
        .filter((l) => l.startsWith("+") && !l.startsWith("+++"))
        .map((l) => l.slice(1));
      if (plusLines.length) {
        const content = plusLines.join("\n") + "\n";
        if (deleted) {
          ops.push({ action: "delete", path: targetPath });
        } else {
          ops.push({ action: "upsert", path: targetPath, content });
        }
      } else if (deleted) {
        ops.push({ action: "delete", path: targetPath });
      }
      continue;
    }

    let deletedByHunks = false;
    if (hunks.length && hunks.every((h) => h.newCount === 0))
      deletedByHunks = true;

    const outParts: string[] = [];
    for (const h of hunks) {
      for (const hl of h.lines) {
        if (!hl) continue;
        if (hl.startsWith("+")) {
          outParts.push(hl.slice(1));
        } else if (hl.startsWith(" ")) {
          outParts.push(hl.slice(1));
        } else if (!hl.startsWith("-")) {
          outParts.push(hl);
        }
      }
    }

    let content = outParts.join("\n");
    if (content.length) content = content.replace(/\n+$/, "") + "\n";
    const finalDeleted = deleted || deletedByHunks;
    if (finalDeleted) {
      ops.push({ action: "delete", path: targetPath });
    } else if (content.length) {
      ops.push({ action: "upsert", path: targetPath, content });
    }
  }

  try {
    if (ops.length === 0) {
      const fallbackOps: Array<UpsertOp | DeleteOp> = [];
      const sections = raw.match(/diff --git[\s\S]*?(?=(?:diff --git|$))/g);
      if (sections && sections.length) {
        for (const sec of sections) {
          const lines = sec.split(/\r?\n/);
          let aPath: string | null = null;
          let bPath: string | null = null;
          for (const l of lines) {
            const aMatch = /^---\s+(?:a\/)?(?:"([^"]+)"|([^\t\n]+))/.exec(l);
            const bMatch = /^\+\+\+\s+(?:b\/)?(?:"([^"]+)"|([^\t\n]+))/.exec(l);
            if (aMatch) aPath = (aMatch[1] || aMatch[2] || "").trim();
            if (bMatch) bPath = (bMatch[1] || bMatch[2] || "").trim();
          }
          const targetPath = bPath && bPath !== "/dev/null" ? bPath : aPath;
          if (!targetPath) continue;

          if (isGloballyBlockedPath(targetPath)) {
            if (!skippedPolicyPaths.has(targetPath)) {
              warnings.push(`Skipped path blocked by policy: ${targetPath}`);
              skippedPolicyPaths.add(targetPath);
            }
            continue;
          }

          const verdict = evaluatePolicy(targetPath, extensionPolicy);
          if (!verdict.allowed) {
            if (!skippedPolicyPaths.has(targetPath)) {
              warnings.push(
                `Skipped path blocked by extension policy (fallback parser): ${targetPath}`,
              );
              skippedPolicyPaths.add(targetPath);
            }
            continue;
          }
          const deleted =
            bPath === "/dev/null" || (bPath && bPath.endsWith("/dev/null"));

          const plusLines = lines
            .filter((l: string) => l.startsWith("+") && !l.startsWith("+++"))
            .map((l) => l.slice(1));
          if (deleted) {
            fallbackOps.push({ action: "delete", path: targetPath });
          } else if (plusLines.length) {
            let content = plusLines.join("\n");
            if (content.length) content = content.replace(/\n+$/, "") + "\n";
            fallbackOps.push({ action: "upsert", path: targetPath, content });
          }
        }
      }
      if (fallbackOps.length) return { ops: fallbackOps, warnings } as EditSpec;
    }
  } catch (err) {
    logger.warn("Error parsing edit spec, returning partial ops", {
      error: String(err),
      opsCount: ops.length,
    });
  }

  return { ops, warnings } as EditSpec;
}
