export function normalizeTitle(title: string): string {
  if (!title) return "";

  return title
    .toLowerCase()
    .replace(/🚨|📋|⚠️|✅|❌|✓|⚡|🔥/g, "")
    .replace(/\[.*?\]/g, "")
    .replace(/\(.*?\)/g, "")
    .replace(/urgent/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function extractKeyPhrases(text: string, minLength = 5): Set<string> {
  if (!text) return new Set();

  const regex = new RegExp(`\\b\\w{${minLength},}\\b`, "g");
  const matches = text.toLowerCase().match(regex) || [];

  return new Set(matches);
}
