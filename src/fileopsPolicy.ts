import path from "path";

export type ExtensionPolicy = {
  blockedExts: Set<string>;
  blockedBasenames: Set<string>;
};

export type PolicyVerdict = {
  allowed: boolean;
  reason?: "blocked";
  rule?: string;
};

function normalizePolicyEntries(list?: string[]): {
  extSet: Set<string>;
  basenameSet: Set<string>;
} {
  const extSet = new Set<string>();
  const basenameSet = new Set<string>();

  for (const entry of list || []) {
    if (typeof entry !== "string") continue;
    const trimmed = entry.trim().toLowerCase();
    if (!trimmed.length) continue;
    if (trimmed.startsWith(".")) {
      extSet.add(trimmed);
      basenameSet.add(trimmed);
    } else {
      basenameSet.add(trimmed);
    }
  }

  return { extSet, basenameSet };
}

export function buildExtensionPolicy(blockedList?: string[]): ExtensionPolicy {
  const blocked = normalizePolicyEntries(blockedList);

  return {
    blockedExts: blocked.extSet,
    blockedBasenames: blocked.basenameSet,
  };
}

export function evaluatePolicy(
  relPath: string,
  policy: ExtensionPolicy,
): PolicyVerdict {
  const normalized = relPath.replace(/\\/g, "/");
  const baseName = path.basename(normalized).toLowerCase();
  const ext = path.extname(baseName).toLowerCase();

  if (policy.blockedExts.has(ext)) {
    return { allowed: false, reason: "blocked", rule: ext || baseName };
  }

  if (policy.blockedBasenames.has(baseName)) {
    return { allowed: false, reason: "blocked", rule: baseName };
  }

  return { allowed: true };
}

export function isGloballyBlockedPath(relPath: string): boolean {
  const normalized = relPath.replace(/\\/g, "/");

  if (normalized === ".git" || normalized === ".git/") {
    return true;
  }

  if (normalized.startsWith(".git/")) {
    return true;
  }

  if (normalized.includes("/.git/")) {
    return true;
  }

  return false;
}
