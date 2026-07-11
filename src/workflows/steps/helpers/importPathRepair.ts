import fs from "fs/promises";
import path from "path";
import { logger } from "../../../logger.js";

export type ImportRepair = {
  file: string;
  from: string;
  to: string;
};

const RESOLVE_EXTENSIONS = [
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
];

const MODULE_NOT_FOUND_PATTERN = /Cannot find module '(\.{1,2}\/[^']+)'/;
const BARE_MODULE_NOT_FOUND_PATTERN =
  /Cannot find module '((?:@[^'/]+\/)?[^'./][^']*)'/;

function bareSpecPackageRoot(spec: string): string | null {
  const segments = spec.split("/");
  if (spec.startsWith("@")) {
    if (segments.length <= 2) return null;
    return segments.slice(0, 2).join("/");
  }
  if (segments.length <= 1) return null;
  return segments[0];
}

async function resolveBareSpec(
  repoRoot: string,
  spec: string,
): Promise<string | null> {
  const packageRoot = bareSpecPackageRoot(spec);
  if (!packageRoot) return null;
  try {
    await fs.access(
      path.join(repoRoot, "node_modules", packageRoot, "package.json"),
    );
    return packageRoot;
  } catch {
    return null;
  }
}

async function moduleTargetExists(
  repoRoot: string,
  importerDir: string,
  spec: string,
): Promise<string | null> {
  const cleanSpec = spec.replace(/\.(ts|tsx|js|jsx|mts|cts|mjs|cjs)$/, "");
  const base = path.posix.join(importerDir, cleanSpec);
  const candidates = [
    ...RESOLVE_EXTENSIONS.map((ext) => `${base}${ext}`),
    ...RESOLVE_EXTENSIONS.map((ext) => `${base}/index${ext}`),
  ];
  for (const candidate of candidates) {
    try {
      await fs.access(path.join(repoRoot, candidate));
      return candidate;
    } catch {
      continue;
    }
  }
  return null;
}

async function resolveCandidateSpec(
  repoRoot: string,
  importerFile: string,
  brokenSpec: string,
): Promise<string | null> {
  const importerDir = path.posix.dirname(
    importerFile.replace(/\\/g, "/"),
  );

  if (await moduleTargetExists(repoRoot, importerDir, brokenSpec)) {
    return null;
  }

  const segments = brokenSpec.split("/");
  const candidateSpecs: string[] = [];

  const importerBase = path.posix.basename(importerDir);
  if (
    segments.length >= 3 &&
    segments[0] === "." &&
    segments[1] === importerBase
  ) {
    candidateSpecs.push(`./${segments.slice(2).join("/")}`);
  }

  const lastSegment = segments[segments.length - 1];
  if (lastSegment && lastSegment !== "." && lastSegment !== "..") {
    candidateSpecs.push(`./${lastSegment}`);
    candidateSpecs.push(`../${lastSegment}`);
  }

  const resolvedTargets = new Map<string, string>();
  for (const candidate of candidateSpecs) {
    if (candidate === brokenSpec) continue;
    const target = await moduleTargetExists(repoRoot, importerDir, candidate);
    if (target && !resolvedTargets.has(target)) {
      resolvedTargets.set(target, candidate);
    }
  }

  if (resolvedTargets.size !== 1) {
    return null;
  }
  return Array.from(resolvedTargets.values())[0];
}

export async function repairRelativeImportErrors(
  repoRoot: string,
  errors: Array<{ file: string; code?: string; message?: string; reason?: string }>,
  allowedFiles: string[],
): Promise<ImportRepair[]> {
  const allowed = new Set(
    allowedFiles.map((file) => file.replace(/\\/g, "/")),
  );
  const repairs: ImportRepair[] = [];
  const rewritesByFile = new Map<string, Map<string, string>>();

  for (const error of errors) {
    if (error.code && error.code !== "TS2307") continue;
    const text = error.message || error.reason || "";

    const file = error.file.replace(/\\/g, "/");
    if (allowed.size > 0 && !allowed.has(file)) continue;

    const relativeMatch = MODULE_NOT_FOUND_PATTERN.exec(text);
    const bareMatch = relativeMatch
      ? null
      : BARE_MODULE_NOT_FOUND_PATTERN.exec(text);
    const brokenSpec = relativeMatch?.[1] || bareMatch?.[1];
    if (!brokenSpec) continue;

    const fileRewrites = rewritesByFile.get(file) || new Map<string, string>();
    if (fileRewrites.has(brokenSpec)) continue;

    const fixedSpec = relativeMatch
      ? await resolveCandidateSpec(repoRoot, file, brokenSpec)
      : await resolveBareSpec(repoRoot, brokenSpec);
    if (!fixedSpec) continue;

    fileRewrites.set(brokenSpec, fixedSpec);
    rewritesByFile.set(file, fileRewrites);
  }

  for (const [file, fileRewrites] of rewritesByFile.entries()) {
    const absPath = path.join(repoRoot, file);
    let content: string;
    try {
      content = await fs.readFile(absPath, "utf-8");
    } catch {
      continue;
    }

    let updated = content;
    for (const [from, to] of fileRewrites.entries()) {
      updated = updated.split(`'${from}'`).join(`'${to}'`);
      updated = updated.split(`"${from}"`).join(`"${to}"`);
      updated = updated.split(`'${from}.js'`).join(`'${to}.js'`);
      updated = updated.split(`"${from}.js"`).join(`"${to}.js"`);
    }

    if (updated === content) continue;

    try {
      await fs.writeFile(absPath, updated, "utf-8");
      for (const [from, to] of fileRewrites.entries()) {
        repairs.push({ file, from, to });
      }
    } catch (error) {
      logger.warn("Failed to write import path repair", {
        file,
        error: String(error),
      });
    }
  }

  if (repairs.length > 0) {
    logger.info("Auto-repaired unresolvable relative import paths", {
      repairs,
    });
  }
  return repairs;
}
