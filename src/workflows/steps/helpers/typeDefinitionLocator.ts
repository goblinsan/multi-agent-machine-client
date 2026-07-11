import fs from "fs/promises";
import path from "path";
import { logger } from "../../../logger.js";

const TYPE_REFERENCE_PATTERNS = [
  /does not exist (?:on|in) type '([^']+)'/g,
  /not assignable to (?:type|parameter of type) '([^']+)'/g,
  /Conversion of type '[^']*' to type '([^']+)'/g,
  /missing the following properties from type '([^']+)'/g,
  /Argument of type '[^']*' is not assignable to parameter of type '([^']+)'/g,
];

const MAX_TYPE_NAMES = 6;
const MAX_FILES_TO_SCAN = 400;
const MAX_DEFINITION_FILES = 4;
const FALLBACK_SCAN_ROOTS = ["src", "tests"];

export function extractTypeNamesFromDiagnostics(
  diagnostics: Array<{ message?: string; reason?: string }>,
): string[] {
  const names = new Set<string>();

  for (const diagnostic of diagnostics) {
    const text = diagnostic.message || diagnostic.reason || "";
    for (const pattern of TYPE_REFERENCE_PATTERNS) {
      pattern.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(text)) !== null) {
        for (const identifier of match[1].split(/[^A-Za-z0-9_]+/)) {
          if (
            /^[A-Z][A-Za-z0-9_]{2,60}$/.test(identifier) &&
            !["Array", "Promise", "Record", "Partial", "Readonly", "Pick", "Omit", "Date", "Error", "Map", "Set"].includes(identifier)
          ) {
            names.add(identifier);
          }
        }
      }
    }
  }

  return Array.from(names).slice(0, MAX_TYPE_NAMES);
}

const MAX_DEFINITION_SUMMARY_CHARS = 1500;

export function extractOffendingProperties(
  diagnostics: Array<{ message?: string; reason?: string }>,
): string[] {
  const properties = new Set<string>();
  const pattern = /'([A-Za-z0-9_]+)' does not exist (?:on|in) type/g;
  for (const diagnostic of diagnostics) {
    const text = diagnostic.message || diagnostic.reason || "";
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
      properties.add(match[1]);
    }
  }
  return Array.from(properties);
}

export interface InvalidUnionLiteralUse {
  literal: string;
  typeName: string;
}

export interface PrimitiveAssignabilityMismatch {
  actualType: string;
  expectedType: string;
}

const PRIMITIVE_TYPES = new Set([
  "bigint",
  "boolean",
  "number",
  "object",
  "string",
  "symbol",
  "undefined",
]);

export function extractPrimitiveAssignabilityMismatches(
  diagnostics: Array<{ message?: string; reason?: string }>,
): PrimitiveAssignabilityMismatch[] {
  const mismatches = new Map<string, PrimitiveAssignabilityMismatch>();
  const pattern = /Type '([^']+)' is not assignable to type '([^']+)'/g;

  for (const diagnostic of diagnostics) {
    const text = diagnostic.message || diagnostic.reason || "";
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
      const actualType = match[1].trim();
      const expectedType = match[2].trim();
      if (
        !PRIMITIVE_TYPES.has(actualType) ||
        !PRIMITIVE_TYPES.has(expectedType) ||
        actualType === expectedType
      ) {
        continue;
      }
      mismatches.set(`${actualType}\0${expectedType}`, {
        actualType,
        expectedType,
      });
    }
  }

  return Array.from(mismatches.values());
}

export function extractInvalidUnionLiteralUses(
  diagnostics: Array<{ message?: string; reason?: string }>,
): InvalidUnionLiteralUse[] {
  const uses = new Map<string, InvalidUnionLiteralUse>();
  const patterns = [
    /Type '"([^"]+)"' is not assignable to type '([^']+)'/g,
    /Conversion of type '"([^"]+)"' to type '([^']+)'/g,
  ];

  for (const diagnostic of diagnostics) {
    const text = diagnostic.message || diagnostic.reason || "";
    for (const pattern of patterns) {
      pattern.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(text)) !== null) {
        const literal = match[1].trim();
        const typeName = match[2].trim();
        if (!literal || !/^[A-Z][A-Za-z0-9_]{2,60}$/.test(typeName)) {
          continue;
        }
        uses.set(`${literal}\0${typeName}`, { literal, typeName });
      }
    }
  }

  return Array.from(uses.values());
}

export async function summarizeTypeDefinitions(
  repoRoot: string,
  definitionFiles: string[],
  typeNames: string[],
): Promise<string> {
  const blocks: string[] = [];

  for (const file of definitionFiles) {
    let content: string;
    try {
      content = await fs.readFile(path.join(repoRoot, file), "utf-8");
    } catch {
      continue;
    }

    for (const name of typeNames) {
      const startPattern = new RegExp(
        `(?:export\\s+)?(?:interface|type|enum|class)\\s+${name}\\b[^\\n]*`,
      );
      const startMatch = startPattern.exec(content);
      if (!startMatch || startMatch.index === undefined) continue;

      const start = startMatch.index;
      let end = start + startMatch[0].length;
      const bodyStart = content.indexOf("{", start);
      if (bodyStart !== -1 && bodyStart < start + startMatch[0].length + 5) {
        let depth = 0;
        for (let i = bodyStart; i < content.length; i++) {
          if (content[i] === "{") depth += 1;
          if (content[i] === "}") {
            depth -= 1;
            if (depth === 0) {
              end = i + 1;
              break;
            }
          }
        }
      } else {
        const semicolon = content.indexOf(";", start);
        end = semicolon !== -1 ? semicolon + 1 : end;
      }

      const definition = content.slice(start, end).trim();
      if (definition.length > 0) {
        blocks.push(
          `// ${file}\n${definition.slice(0, MAX_DEFINITION_SUMMARY_CHARS)}`,
        );
      }
    }
  }

  return blocks.join("\n\n");
}

export async function locateTypeDefinitionFiles(
  repoRoot: string,
  typeNames: string[],
  repoScan: Array<{ path: string }> | null,
): Promise<string[]> {
  if (typeNames.length === 0) return [];

  const sourceFiles =
    repoScan && repoScan.length > 0
      ? repoScan.map((entry) => entry.path.replace(/\\/g, "/"))
      : await scanTypeScriptFiles(repoRoot);

  const candidateFiles = sourceFiles.filter(isTypeDefinitionCandidate);

  if (candidateFiles.length === 0) return [];

  const lowerNames = typeNames.map((name) => name.toLowerCase());
  const prioritized = [
    ...candidateFiles.filter((file) => {
      const base = path.posix.basename(file).toLowerCase();
      return lowerNames.some((name) => base.includes(name));
    }),
    ...candidateFiles.filter((file) =>
      /(^|\/)(types?|interfaces?|models?|schema)(\/|\.)/i.test(file),
    ),
    ...candidateFiles,
  ];
  const seen = new Set<string>();
  const scanOrder = prioritized
    .filter((file) => {
      if (seen.has(file)) return false;
      seen.add(file);
      return true;
    })
    .slice(0, MAX_FILES_TO_SCAN);

  const remaining = new Set(typeNames);
  const definitionFiles = new Set<string>();

  for (const file of scanOrder) {
    if (remaining.size === 0 || definitionFiles.size >= MAX_DEFINITION_FILES) {
      break;
    }
    let content: string;
    try {
      content = await fs.readFile(path.join(repoRoot, file), "utf-8");
    } catch {
      continue;
    }
    for (const name of Array.from(remaining)) {
      const definitionPattern = new RegExp(
        `\\b(?:interface|type|class|enum)\\s+${name}\\b`,
      );
      if (definitionPattern.test(content)) {
        definitionFiles.add(file);
        remaining.delete(name);
      }
    }
  }

  const files = Array.from(definitionFiles);
  if (files.length > 0) {
    logger.info("Located type definition files for retry context", {
      typeNames,
      files,
    });
  }
  return files;
}

function isTypeDefinitionCandidate(file: string): boolean {
  return (
    /\.(ts|tsx|mts|cts)$/.test(file) &&
    !file.includes("node_modules/") &&
    !file.endsWith(".d.ts") &&
    !file.includes("__tests__/") &&
    !/\.(test|spec)\.(ts|tsx)$/.test(file)
  );
}

async function scanTypeScriptFiles(repoRoot: string): Promise<string[]> {
  const files: string[] = [];

  for (const root of FALLBACK_SCAN_ROOTS) {
    await walk(path.join(repoRoot, root), root, files);
    if (files.length >= MAX_FILES_TO_SCAN) {
      break;
    }
  }

  return files.slice(0, MAX_FILES_TO_SCAN);
}

async function walk(
  absDir: string,
  relDir: string,
  files: string[],
): Promise<void> {
  if (files.length >= MAX_FILES_TO_SCAN) return;

  let entries: Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>;
  try {
    entries = await fs.readdir(absDir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (files.length >= MAX_FILES_TO_SCAN) return;
    if (
      entry.name === "node_modules" ||
      entry.name === ".git" ||
      entry.name === ".ma" ||
      entry.name === "dist" ||
      entry.name === "build" ||
      entry.name === "coverage"
    ) {
      continue;
    }

    const relPath = path.posix.join(relDir.replace(/\\/g, "/"), entry.name);
    const absPath = path.join(absDir, entry.name);
    if (entry.isDirectory()) {
      await walk(absPath, relPath, files);
    } else if (entry.isFile()) {
      files.push(relPath);
    }
  }
}
