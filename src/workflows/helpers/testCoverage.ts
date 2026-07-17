import fs from "fs/promises";
import path from "path";

export const TEST_FILE_PATTERN = /\.(?:test|spec)\.[a-z]+$/;

export const SOURCE_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
]);

const SKIP_SCAN_DIRS = new Set([
  "node_modules",
  ".git",
  ".ma",
  "dist",
  "build",
  "coverage",
]);

export interface TestSource {
  file: string;
  text: string;
}

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function isTestFile(file: string): boolean {
  return TEST_FILE_PATTERN.test(file);
}

export function isSourceFile(file: string): boolean {
  return (
    SOURCE_EXTENSIONS.has(path.extname(file)) &&
    !isTestFile(file) &&
    !file.endsWith(".d.ts")
  );
}

export function hasRuntimeExport(text: string): boolean {
  const withoutTypeOnly = text
    .replace(/^\s*export\s+(?:type|interface)\b[\s\S]*?(?:\n\}|;)\s*$/gm, "")
    .replace(/^\s*export\s+type\s+\{[^}]*\}[^\n]*$/gm, "");

  const declaresRuntime =
    /export\s+(?:async\s+)?(?:function|class|const|let|var|default)\b/.test(
      withoutTypeOnly,
    );
  if (declaresRuntime) return true;

  const namedExports = withoutTypeOnly.match(/export\s+\{[^}]*\}[^\n;]*/g) || [];
  return namedExports.some((statement) => !/\bfrom\s*["']/.test(statement));
}

export async function collectTestSources(
  repoRoot: string,
): Promise<TestSource[]> {
  const results: TestSource[] = [];

  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > 8) return;
    let entries;
    try {
      entries = await fs.readdir(path.join(repoRoot, dir), {
        withFileTypes: true,
      });
    } catch {
      return;
    }
    for (const entry of entries) {
      const rel = dir ? `${dir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (SKIP_SCAN_DIRS.has(entry.name)) continue;
        await walk(rel, depth + 1);
        continue;
      }
      if (!TEST_FILE_PATTERN.test(entry.name)) continue;
      try {
        results.push({
          file: rel,
          text: await fs.readFile(path.join(repoRoot, rel), "utf-8"),
        });
      } catch {
        continue;
      }
    }
  };

  await walk("", 0);
  return results;
}

export function importPatternFor(file: string): RegExp {
  const stem = path.basename(file).replace(/\.[^.]+$/, "");
  return new RegExp(
    `from\\s+["'][^"']*(?:/|^)${escapeRegExp(stem)}(?:\\.[a-z]+)?["']|import\\(\\s*["'][^"']*(?:/|^)${escapeRegExp(stem)}(?:\\.[a-z]+)?["']`,
  );
}

export function findCoveringTests(
  file: string,
  testSources: TestSource[],
): string[] {
  const pattern = importPatternFor(file);
  return testSources
    .filter((source) => pattern.test(source.text))
    .map((source) => source.file);
}
