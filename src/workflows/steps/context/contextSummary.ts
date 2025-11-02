import path from "path";
import type { FileInfo } from "../../../scanRepo.js";
import { languageForPath } from "./languageMap.js";

export interface ContextSummaryInput {
  repoScan: FileInfo[];
  metadata: {
    scannedAt: number;
    repoPath: string;
    fileCount: number;
    totalBytes: number;
    maxDepth: number;
  };
}

export interface ContextInsights {
  primaryLanguage: string | null;
  secondaryLanguages: string[];
  frameworks: string[];
  potentialIssues: string[];
}

export function buildContextSummary(
  input: ContextSummaryInput,
): {
  summary: string;
  insights: ContextInsights;
} {
  const { repoScan, metadata } = input;
  const languageInsights = analyzeLanguages(repoScan);
  const frameworks = detectFrameworks(repoScan);
  const potentialIssues = detectPotentialIssues(repoScan);

  const dirTree: Record<string, FileInfo[]> = {};
  repoScan.forEach((file) => {
    const dir = path.dirname(file.path);
    if (!dirTree[dir]) dirTree[dir] = [];
    dirTree[dir].push(file);
  });

  let summary = `# Repository Context Summary\n\n`;
  summary += `Generated: ${new Date(metadata.scannedAt).toISOString()}\n\n`;

  summary += `## Overview\n\n`;
  summary += `- **Primary Language**: ${
    languageInsights.primary || "Unknown"
  }\n`;
  if (languageInsights.secondary.length > 0) {
    summary += `- **Other Languages**: ${
      languageInsights.secondary.join(", ")
    }\n`;
  }
  if (frameworks.length > 0) {
    summary += `- **Tooling & Frameworks**: ${frameworks.join(", ")}\n`;
  }
  summary += `\n`;

  if (potentialIssues.length > 0) {
    summary += `## Potential Issues\n\n`;
    potentialIssues.forEach((issue) => {
      summary += `- ${issue}\n`;
    });
    summary += `\n`;
  }

  summary += `## Statistics\n\n`;
  summary += `- **Total Files**: ${metadata.fileCount}\n`;
  summary += `- **Total Size**: ${(metadata.totalBytes / 1024).toFixed(2)} KB\n`;
  summary += `- **Max Depth**: ${metadata.maxDepth}\n\n`;

  summary += `## Directory Structure\n\n\`\`\`\n`;
  const sortedDirs = Object.keys(dirTree).sort();
  sortedDirs.forEach((dir) => {
    const files = dirTree[dir];
    summary += `${dir}/\n`;
    files.forEach((file) => {
      const name = path.basename(file.path);
      const size = `${(file.bytes / 1024).toFixed(1)}KB`;
      summary += `  ${name} (${size})\n`;
    });
  });
  summary += `\`\`\`\n\n`;

  const largeFiles = repoScan.filter(
    (f) => (f.lines && f.lines > 200) || f.bytes > 50 * 1024,
  );
  if (largeFiles.length > 0) {
    summary += `## Large Files\n\n`;
    largeFiles.forEach((f) => {
      const size = `${(f.bytes / 1024).toFixed(1)}KB`;
      const lines = f.lines ? `, ${f.lines} lines` : "";
      summary += `- \`${f.path}\` (${size}${lines})\n`;
    });
    summary += `\n`;
  }

  const extMap: Record<string, number> = {};
  repoScan.forEach((f) => {
    const ext = path.extname(f.path) || "(no extension)";
    extMap[ext] = (extMap[ext] || 0) + 1;
  });
  summary += `## File Types\n\n`;
  Object.entries(extMap)
    .sort((a, b) => b[1] - a[1])
    .forEach(([ext, count]) => {
      summary += `- ${ext}: ${count} file${count > 1 ? "s" : ""}\n`;
    });

  return {
    summary,
    insights: {
      primaryLanguage: languageInsights.primary,
      secondaryLanguages: languageInsights.secondary,
      frameworks,
      potentialIssues,
    },
  };
}

function analyzeLanguages(repoScan: FileInfo[]): {
  primary: string | null;
  secondary: string[];
} {
  const counts: Record<string, number> = {};
  repoScan.forEach((file) => {
    const language = languageForPath(file.path);
    if (!language) return;
    counts[language] = (counts[language] || 0) + 1;
  });

  const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  const primary = sorted[0]?.[0] || null;
  const secondary = sorted.slice(1, 4).map(([language]) => language);

  return { primary, secondary };
}

function detectFrameworks(repoScan: FileInfo[]): string[] {
  const frameworks: string[] = [];
  const fileSet = new Set(repoScan.map((file) => file.path));
  const has = (name: string) => fileSet.has(name) || fileSet.has(`./${name}`);

  if (has("package.json")) frameworks.push("Node.js (package.json)");
  if (has("tsconfig.json")) frameworks.push("TypeScript compiler (tsconfig.json)");
  if (has("vitest.config.ts") || has("vitest.config.js")) frameworks.push("Vitest test runner");
  if (has("jest.config.js") || has("jest.config.ts")) frameworks.push("Jest test runner");
  if (has("eslint.config.js") || has(".eslintrc.js") || has(".eslintrc.cjs")) frameworks.push("ESLint configuration");
  if (has("pyproject.toml") || has("requirements.txt")) frameworks.push("Python tooling (pyproject/requirements)");
  if (has("Cargo.toml")) frameworks.push("Rust workspace (Cargo.toml)");
  if (has("go.mod")) frameworks.push("Go modules (go.mod)");
  if (has("composer.json")) frameworks.push("PHP Composer (composer.json)");

  return frameworks;
}

function detectPotentialIssues(repoScan: FileInfo[]): string[] {
  const issues: string[] = [];

  const largeLogs = repoScan.filter(
    (file) => file.path.endsWith(".log") && file.bytes > 500 * 1024,
  );
  if (largeLogs.length > 0) {
    const preview = largeLogs
      .slice(0, 3)
      .map((file) => file.path)
      .join(", ");
    const suffix =
      largeLogs.length > 3 ? ` (+${largeLogs.length - 3} more)` : "";
    issues.push(`Large log files committed: ${preview}${suffix}`);
  }

  const binaryFiles = repoScan.filter((file) =>
    /(\.db|\.sqlite|\.sqlite3|\.bin)$/i.test(file.path),
  );
  if (binaryFiles.length > 0) {
    const preview = binaryFiles
      .slice(0, 3)
      .map((file) => file.path)
      .join(", ");
    const suffix =
      binaryFiles.length > 3 ? ` (+${binaryFiles.length - 3} more)` : "";
    issues.push(`Binary artifacts present in repo: ${preview}${suffix}`);
  }

  const hasTests = repoScan.some((file) =>
    /(^|\/)__tests__\//i.test(file.path) ||
    /(^|\/)tests?\//i.test(file.path) ||
    /(\.test|\.spec)\./i.test(file.path),
  );
  if (!hasTests) {
    issues.push("No obvious test/spec files detected in scan results");
  }

  return issues;
}
