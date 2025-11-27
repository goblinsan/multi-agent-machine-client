import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { parse as parseToml } from "@iarna/toml";
import { XMLParser } from "fast-xml-parser";

export interface ConfigValidationError {
  file: string;
  reason: string;
}

type ConfigFormat = "json" | "yaml" | "toml" | "xml";

const extensionMap = new Map<string, ConfigFormat>([
  [".json", "json"],
  [".jsonc", "json"],
  [".json5", "json"],
  [".yaml", "yaml"],
  [".yml", "yaml"],
  [".toml", "toml"],
  [".tml", "toml"],
  [".xml", "xml"],
  [".config", "xml"],
]);

const basenameOverrides = new Map<string, ConfigFormat>([
  ["pom.xml", "xml"],
  ["package.json", "json"],
]);

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  allowBooleanAttributes: true,
  ignoreDeclaration: false,
  attributesGroupName: "__attrs",
});

export function identifyConfigFiles(files: string[]): string[] {
  return files.filter((filePath) => resolveFormat(filePath) !== null);
}

export function validateConfigFiles(
  repoRoot: string,
  files: string[],
): ConfigValidationError[] {
  const errors: ConfigValidationError[] = [];

  for (const relativePath of files) {
    const format = resolveFormat(relativePath);
    if (!format) {
      continue;
    }

    const absolutePath = path.resolve(repoRoot, relativePath);
    if (!fs.existsSync(absolutePath)) {
      continue;
    }

    let content: string;
    try {
      content = fs.readFileSync(absolutePath, "utf8");
    } catch (error) {
      errors.push({
        file: relativePath,
        reason: error instanceof Error ? error.message : String(error),
      });
      continue;
    }

    if (content.trim().length === 0) {
      errors.push({ file: relativePath, reason: "file is empty" });
      continue;
    }

    const failure = runValidator(content, format);
    if (failure) {
      errors.push({ file: relativePath, reason: failure });
    }
  }

  return errors;
}

function resolveFormat(filePath: string): ConfigFormat | null {
  const normalized = filePath.toLowerCase();
  const base = path.basename(normalized);
  if (basenameOverrides.has(base)) {
    return basenameOverrides.get(base) || null;
  }

  const ext = path.extname(normalized);
  if (!ext) {
    return null;
  }
  return extensionMap.get(ext) || null;
}

function runValidator(content: string, format: ConfigFormat): string | null {
  try {
    if (format === "json") {
      JSON.parse(content);
      return null;
    }

    if (format === "yaml") {
      YAML.parse(content);
      return null;
    }

    if (format === "toml") {
      parseToml(content);
      return null;
    }

    xmlParser.parse(content);
    return null;
  } catch (error) {
    if (error instanceof Error) {
      return error.message;
    }
    return String(error);
  }
}
