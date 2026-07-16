import { promises as fs } from "fs";
import * as path from "path";

export type MissingExportError = {
  file?: string;
  message?: string;
  reason?: string;
};

const MISSING_MEMBER_PATTERN =
  /Module\s+'"?([^"'`]+)"?'\s+has no exported member(?:\s+named)?\s+'([^']+)'/;

export function extractExportNames(source: string): string[] {
  const names = new Set<string>();
  const declPattern =
    /export\s+(?:async\s+)?(?:const|let|var|function|class|type|interface|enum)\s+([A-Za-z_$][\w$]*)/g;
  let match: RegExpExecArray | null;
  while ((match = declPattern.exec(source)) !== null) {
    names.add(match[1]);
  }
  const bracePattern = /export\s*\{([^}]*)\}/g;
  while ((match = bracePattern.exec(source)) !== null) {
    for (const part of match[1].split(",")) {
      const segment = part.trim();
      if (!segment) continue;
      const asMatch = segment.match(/\bas\s+([A-Za-z_$][\w$]*)/);
      if (asMatch) {
        names.add(asMatch[1]);
        continue;
      }
      const bare = segment.match(/^([A-Za-z_$][\w$]*)/);
      if (bare) names.add(bare[1]);
    }
  }
  if (/export\s+default\b/.test(source)) {
    names.add("default");
  }
  return Array.from(names);
}

async function readModuleExports(
  repoRoot: string,
  importerFile: string,
  specifier: string,
): Promise<string[] | null> {
  const importerDir = path.dirname(path.resolve(repoRoot, importerFile));
  const base = path.resolve(importerDir, specifier);
  const candidates = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    path.join(base, "index.ts"),
    path.join(base, "index.tsx"),
  ];
  for (const candidate of candidates) {
    if (!candidate.startsWith(repoRoot)) continue;
    try {
      const content = await fs.readFile(candidate, "utf-8");
      return extractExportNames(content);
    } catch {
      void 0;
    }
  }
  return null;
}

export async function buildMissingExportDirective(
  repoRoot: string,
  errors: MissingExportError[],
): Promise<string | null> {
  const byModule = new Map<
    string,
    { importer: string; specifier: string; missing: Set<string> }
  >();
  for (const error of errors) {
    const message = String(error.message || error.reason || "");
    const match = message.match(MISSING_MEMBER_PATTERN);
    if (!match) continue;
    const specifier = match[1];
    if (!specifier.startsWith(".")) continue;
    const importer = error.file;
    if (!importer) continue;
    const key = `${importer}::${specifier}`;
    const entry =
      byModule.get(key) || { importer, specifier, missing: new Set<string>() };
    entry.missing.add(match[2]);
    byModule.set(key, entry);
  }
  if (byModule.size === 0) return null;

  const lines: string[] = [];
  for (const entry of byModule.values()) {
    const exports = await readModuleExports(
      repoRoot,
      entry.importer,
      entry.specifier,
    );
    if (!exports || exports.length === 0) continue;
    const missing = Array.from(entry.missing)
      .map((name) => `'${name}'`)
      .join(", ");
    lines.push(
      `Module '${entry.specifier}' exports only: ${exports.join(", ")}. ` +
        `It does NOT export ${missing}. ` +
        "Import and call only the names listed above; do not invent exports. " +
        "If the data you need is not exposed directly, compose it from the listed helpers (for example call a generic request helper with the correct path).",
    );
  }
  return lines.length > 0 ? lines.join("\n\n") : null;
}
