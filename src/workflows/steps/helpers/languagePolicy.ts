import { EXTENSION_LANGUAGE_MAP, languageForPath } from "../context/languageMap.js";
import type { ContextInsights } from "../context/contextSummary.js";

export interface AllowedLanguagesInfo {
  normalized: Set<string>;
  display: string[];
}

export interface LanguageViolation {
  file: string;
  language: string;
}

const KNOWN_LANGUAGE_NAMES = Array.from(
  new Set(Object.values(EXTENSION_LANGUAGE_MAP)),
).filter((name) => typeof name === "string" && name.trim().length > 0);

export function collectAllowedLanguages(
  insights: Partial<ContextInsights> | null | undefined,
  additionalLanguages: Array<string | null | undefined> = [],
): AllowedLanguagesInfo {
  const normalized = new Set<string>();
  const display: string[] = [];

  const addLanguage = (value: unknown) => {
    if (typeof value !== "string") return;
    const trimmed = value.trim();
    if (!trimmed) return;
    const lowered = trimmed.toLowerCase();
    if (normalized.has(lowered)) return;
    normalized.add(lowered);
    display.push(trimmed);
  };

  if (insights) {
    addLanguage(insights.primaryLanguage);

    const secondary = (insights as any).secondaryLanguages;
    if (Array.isArray(secondary)) {
      secondary.forEach(addLanguage);
    }

    const additional = (insights as any).languages;
    if (Array.isArray(additional)) {
      additional.forEach(addLanguage);
    }
  }

  additionalLanguages.forEach(addLanguage);

  return { normalized, display };
}

export function mergeAllowedLanguages(
  base: AllowedLanguagesInfo,
  extras: Array<string | null | undefined>,
): AllowedLanguagesInfo {
  const mergedNormalized = new Set(base.normalized);
  const mergedDisplay = [...base.display];

  const addLanguage = (value: unknown) => {
    if (typeof value !== "string") return;
    const trimmed = value.trim();
    if (!trimmed) return;
    const lowered = trimmed.toLowerCase();
    if (mergedNormalized.has(lowered)) return;
    mergedNormalized.add(lowered);
    mergedDisplay.push(trimmed);
  };

  extras.forEach(addLanguage);

  return {
    normalized: mergedNormalized,
    display: mergedDisplay,
  };
}

export function findLanguageViolationsForFiles(
  files: string[],
  allowedLanguages: Set<string>,
): LanguageViolation[] {
  if (!Array.isArray(files) || files.length === 0) {
    return [];
  }

  const normalizedAllowed = new Set(
    Array.from(allowedLanguages.values()).map((value) => value.toLowerCase()),
  );

  const violations: LanguageViolation[] = [];
  const seen = new Set<string>();

  files.forEach((file) => {
    if (typeof file !== "string") return;
    const trimmed = file.trim();
    if (!trimmed) return;

    const language = languageForPath(trimmed);
    if (!language) return;

    const key = `${trimmed}::${language}`;
    if (seen.has(key)) return;
    seen.add(key);

    if (!normalizedAllowed.has(language.toLowerCase())) {
      violations.push({ file: trimmed, language });
    }
  });

  return violations;
}

export function detectLanguagesInText(text: string | undefined | null): string[] {
  if (!text) return [];
  const lower = text.toLowerCase();
  const detected = new Set<string>();

  KNOWN_LANGUAGE_NAMES.forEach((name) => {
    const normalized = name.toLowerCase();
    if (lower.includes(normalized)) {
      detected.add(name);
    }
  });

  return Array.from(detected);
}
