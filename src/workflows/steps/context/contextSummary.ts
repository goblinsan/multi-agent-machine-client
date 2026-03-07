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

export interface SetupCommandInsight {
  id: string;
  title: string;
  language: string;
  ecosystem: string;
  reason: string;
  commands: string[];
  evidence: string[];
  workingDirectory?: string;
  notes?: string;
}

export interface SetupGuidanceGap {
  language: string;
  reason: string;
  evidence: string[];
}

export interface ContextInsights {
  primaryLanguage: string | null;
  secondaryLanguages: string[];
  frameworks: string[];
  potentialIssues: string[];
  setupCommands: SetupCommandInsight[];
  setupGaps: SetupGuidanceGap[];
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
  const setupInsights = detectSetupCommands(repoScan, languageInsights);

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

  if (setupInsights.commands.length > 0) {
    summary += `## Local Environment Setup\n\n`;
    setupInsights.commands.forEach((entry) => {
      summary += `- **${entry.title}** (${entry.reason})\n`;
      entry.commands.forEach((command) => {
        summary += `  - \`${command}\`\n`;
      });
      if (entry.workingDirectory && entry.workingDirectory !== ".") {
        summary += `  - Run from: \`${entry.workingDirectory}\`\n`;
      }
      if (entry.evidence.length > 0) {
        summary += `  - Evidence: ${entry.evidence.join(", ")}\n`;
      }
      if (entry.notes) {
        summary += `  - ${entry.notes}\n`;
      }
    });
    summary += `\n`;
  }

  if (setupInsights.gaps.length > 0) {
    summary += `## Missing Setup Guidance\n\n`;
    setupInsights.gaps.forEach((gap) => {
      summary += `- ${gap.language}: ${gap.reason}`;
      if (gap.evidence.length > 0) {
        summary += ` (evidence: ${gap.evidence.join(", ")})`;
      }
      summary += `\n`;
    });
    summary += `\n`;
  }

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
      setupCommands: setupInsights.commands,
      setupGaps: setupInsights.gaps,
    },
  };
}

function analyzeLanguages(repoScan: FileInfo[]): LanguageInsights {
  const counts: Record<string, number> = {};
  const samples = new Map<string, string[]>();

  repoScan.forEach((file) => {
    const language = languageForPath(file.path);
    if (!language) return;
    counts[language] = (counts[language] || 0) + 1;
    if (!samples.has(language)) {
      samples.set(language, []);
    }
    const collection = samples.get(language)!;
    if (collection.length < 5) {
      collection.push(file.path);
    }
  });

  const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  const primary = sorted[0]?.[0] || null;
  const secondary = sorted.slice(1, 4).map(([language]) => language);

  return { primary, secondary, allLanguages: samples };
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

type SetupEcosystemKey =
  | "node"
  | "python"
  | "go"
  | "rust"
  | "ruby"
  | "php";

const LANGUAGE_ECOSYSTEM_MAP: Record<string, SetupEcosystemKey> = {
  javascript: "node",
  typescript: "node",
  python: "python",
  go: "go",
  rust: "rust",
  ruby: "ruby",
  php: "php",
};

interface LanguageInsights {
  primary: string | null;
  secondary: string[];
  allLanguages: Map<string, string[]>;
}

function detectSetupCommands(
  repoScan: FileInfo[],
  languageInsights: LanguageInsights,
): { commands: SetupCommandInsight[]; gaps: SetupGuidanceGap[] } {
  const fileSet = new Set(
    repoScan.map((file) => file.path.replace(/^\.\//, "")),
  );
  const fileList = Array.from(fileSet.values());
  const hasFile = (name: string) => {
    if (fileSet.has(name) || fileSet.has(`./${name}`)) {
      return true;
    }
    return fileList.some((entry) => entry.endsWith(`/${name}`));
  };
  const commands: SetupCommandInsight[] = [];
  const coveredEcosystems = new Set<SetupEcosystemKey>();
  const addCommand = (
    entry: SetupCommandInsight,
    ecosystems: SetupEcosystemKey[],
  ) => {
    commands.push(entry);
    ecosystems.forEach((eco) => coveredEcosystems.add(eco));
  };

  if (hasFile("package.json")) {
    const evidence = ["package.json"];
    const notes: string[] = [];
    if (hasFile("pnpm-lock.yaml")) evidence.push("pnpm-lock.yaml");
    if (hasFile("yarn.lock")) evidence.push("yarn.lock");
    if (hasFile("package-lock.json")) evidence.push("package-lock.json");
    if (hasFile("npm-shrinkwrap.json")) evidence.push("npm-shrinkwrap.json");
    const commandsList: string[] = [];
    if (hasFile("pnpm-lock.yaml")) {
      commandsList.push("pnpm install --frozen-lockfile");
    } else if (hasFile("yarn.lock")) {
      commandsList.push("yarn install --immutable");
    } else {
      commandsList.push("npm install --no-package-lock");
      if (!hasFile("package-lock.json") && !hasFile("npm-shrinkwrap.json")) {
        notes.push("No lockfile detected; npm install --no-package-lock used as fallback.");
      }
    }
    addCommand(
      {
        id: "node-tooling",
        title: "Node.js dependencies",
        language: "JavaScript / TypeScript",
        ecosystem: "node",
        reason: "Detected package.json",
        commands: commandsList,
        evidence,
        notes: notes.join(" ") || undefined,
      },
      ["node"],
    );
  }

  if (hasFile("poetry.lock")) {
    addCommand(
      {
        id: "python-poetry",
        title: "Python environment (Poetry)",
        language: "Python",
        ecosystem: "python",
        reason: "Detected poetry.lock",
        commands: ["poetry install --no-root"],
        evidence: ["poetry.lock"],
      },
      ["python"],
    );
  } else if (hasFile("Pipfile.lock")) {
    addCommand(
      {
        id: "python-pipenv",
        title: "Python environment (Pipenv)",
        language: "Python",
        ecosystem: "python",
        reason: "Detected Pipfile.lock",
        commands: ["pipenv sync"],
        evidence: ["Pipfile.lock"],
      },
      ["python"],
    );
  } else if (hasFile("requirements.txt")) {
    addCommand(
      {
        id: "python-requirements",
        title: "Python environment (requirements.txt)",
        language: "Python",
        ecosystem: "python",
        reason: "Detected requirements.txt",
        commands: ["python -m pip install -r requirements.txt"],
        evidence: ["requirements.txt"],
      },
      ["python"],
    );
  }

  if (hasFile("go.mod")) {
    addCommand(
      {
        id: "go-modules",
        title: "Go modules",
        language: "Go",
        ecosystem: "go",
        reason: "Detected go.mod",
        commands: ["go mod download"],
        evidence: ["go.mod"],
      },
      ["go"],
    );
  }

  if (hasFile("Cargo.lock") || hasFile("Cargo.toml")) {
    const evidence = hasFile("Cargo.lock")
      ? ["Cargo.lock"]
      : ["Cargo.toml"];
    addCommand(
      {
        id: "rust-cargo",
        title: "Rust workspace",
        language: "Rust",
        ecosystem: "rust",
        reason: `Detected ${evidence[0]}`,
        commands: ["cargo fetch"],
        evidence,
      },
      ["rust"],
    );
  }

  if (hasFile("Gemfile")) {
    const evidence = ["Gemfile"];
    if (hasFile("Gemfile.lock")) {
      evidence.push("Gemfile.lock");
    }
    addCommand(
      {
        id: "ruby-bundler",
        title: "Ruby gems",
        language: "Ruby",
        ecosystem: "ruby",
        reason: "Detected Gemfile",
        commands: ["bundle install"],
        evidence,
      },
      ["ruby"],
    );
  }

  if (hasFile("composer.json")) {
    const evidence = ["composer.json"];
    if (hasFile("composer.lock")) {
      evidence.push("composer.lock");
    }
    addCommand(
      {
        id: "php-composer",
        title: "PHP Composer",
        language: "PHP",
        ecosystem: "php",
        reason: "Detected composer.json",
        commands: ["composer install --no-interaction"],
        evidence,
      },
      ["php"],
    );
  }

  const gaps: SetupGuidanceGap[] = [];
  languageInsights.allLanguages.forEach((samples, language) => {
    const key = LANGUAGE_ECOSYSTEM_MAP[language.toLowerCase()];
    if (!key) {
      gaps.push({
        language,
        reason: "Language detected but no automation is defined for this stack",
        evidence: samples.slice(0, 3),
      });
      return;
    }
    if (coveredEcosystems.has(key)) {
      return;
    }
    const manifestExpectations = getManifestExpectations(key).join(", ");
    gaps.push({
      language,
      reason: `Detected source files but missing known dependency manifests (${manifestExpectations})`,
      evidence: samples.slice(0, 3),
    });
  });

  return { commands, gaps };
}

function getManifestExpectations(key: SetupEcosystemKey): string[] {
  switch (key) {
    case "node":
      return ["package.json"];
    case "python":
      return ["poetry.lock", "Pipfile.lock", "requirements.txt"];
    case "go":
      return ["go.mod"];
    case "rust":
      return ["Cargo.toml", "Cargo.lock"];
    case "ruby":
      return ["Gemfile", "Gemfile.lock"];
    case "php":
      return ["composer.json", "composer.lock"];
    default:
      return [];
  }
}
