import { promises as fs } from "fs";
import * as path from "path";

export type UnusedImportError = {
  file?: string;
  code?: string;
  message?: string;
  reason?: string;
};

export type UnusedImportRepair = {
  file: string;
  removed: string[];
};

const UNUSED_PATTERN =
  /'([A-Za-z_$][\w$]*)' is declared but its value is never read/;

function collectUnusedNamesByFile(
  errors: UnusedImportError[],
): Map<string, Set<string>> {
  const byFile = new Map<string, Set<string>>();
  for (const error of errors) {
    const code = error.code || "";
    const text = String(error.message || error.reason || "");
    if (code !== "TS6133" && !/TS6133/.test(text)) continue;
    const match = text.match(UNUSED_PATTERN);
    if (!match) continue;
    if (!error.file) continue;
    const set = byFile.get(error.file) || new Set<string>();
    set.add(match[1]);
    byFile.set(error.file, set);
  }
  return byFile;
}

function rewriteImportClause(
  clause: string,
  unused: Set<string>,
  removed: Set<string>,
): string | null {
  const trimmed = clause.trim();
  let defaultPart: string | null = null;
  let namespacePart: string | null = null;
  let namedPart: string | null = null;

  const namedMatch = trimmed.match(/\{([\s\S]*)\}/);
  if (namedMatch) {
    namedPart = namedMatch[1];
  }
  const withoutNamed = trimmed.replace(/\{[\s\S]*\}/, "").trim();
  for (const segment of withoutNamed.split(",")) {
    const seg = segment.trim().replace(/,$/, "").trim();
    if (!seg) continue;
    if (/^\*\s+as\s+/.test(seg)) {
      namespacePart = seg;
    } else if (/^[A-Za-z_$][\w$]*$/.test(seg)) {
      defaultPart = seg;
    }
  }

  if (defaultPart && unused.has(defaultPart)) {
    removed.add(defaultPart);
    defaultPart = null;
  }
  if (namespacePart) {
    const alias = namespacePart.replace(/^\*\s+as\s+/, "").trim();
    if (unused.has(alias)) {
      removed.add(alias);
      namespacePart = null;
    }
  }

  const keptNamed: string[] = [];
  if (namedPart !== null) {
    const specifiers = namedPart
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean);
    for (const spec of specifiers) {
      const asMatch = spec.match(/\bas\s+([A-Za-z_$][\w$]*)$/);
      const localName = asMatch
        ? asMatch[1]
        : (spec.match(/^([A-Za-z_$][\w$]*)/)?.[1] ?? spec);
      if (unused.has(localName)) {
        removed.add(localName);
        continue;
      }
      keptNamed.push(spec);
    }
  }

  const pieces: string[] = [];
  if (defaultPart) pieces.push(defaultPart);
  if (namespacePart) pieces.push(namespacePart);
  if (namedPart !== null && keptNamed.length > 0) {
    pieces.push(`{ ${keptNamed.join(", ")} }`);
  }
  if (pieces.length === 0) {
    return null;
  }
  return pieces.join(", ");
}

export async function repairUnusedImports(
  repoRoot: string,
  errors: UnusedImportError[],
): Promise<UnusedImportRepair[]> {
  const byFile = collectUnusedNamesByFile(errors);
  if (byFile.size === 0) return [];

  const repairs: UnusedImportRepair[] = [];
  const importRegex = /import\s+([\s\S]*?)\s+from\s+(['"][^'"]+['"])(;?)/g;

  for (const [relFile, unused] of byFile) {
    const absPath = path.resolve(repoRoot, relFile);
    if (!absPath.startsWith(repoRoot)) continue;
    let source: string;
    try {
      source = await fs.readFile(absPath, "utf-8");
    } catch {
      continue;
    }

    const removed = new Set<string>();
    const rewritten = source.replace(
      importRegex,
      (whole, clause: string, spec: string, semi: string) => {
        const kept = rewriteImportClause(clause, unused, removed);
        if (kept === null) {
          return "";
        }
        if (kept === clause.trim()) {
          return whole;
        }
        return `import ${kept} from ${spec}${semi}`;
      },
    );

    if (removed.size === 0) continue;
    const cleaned = rewritten.replace(/^[ \t]*\n(?=[ \t]*\n)/gm, "");
    try {
      await fs.writeFile(absPath, cleaned, "utf-8");
      repairs.push({ file: relFile, removed: Array.from(removed) });
    } catch {
      continue;
    }
  }
  return repairs;
}
