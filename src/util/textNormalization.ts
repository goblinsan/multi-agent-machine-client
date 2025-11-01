


export function normalizeTitle(title: string): string {
  if (!title) return '';
  
  return title
    .toLowerCase()
    .replace(/🚨|📋|⚠️|✅|❌|✓|⚡|🔥/g, '')
    .replace(/\[.*?\]/g, '')
    .replace(/\(.*?\)/g, '')
    .replace(/urgent/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}


export function extractKeyPhrases(text: string, minLength = 5): Set<string> {
  if (!text) return new Set();
  
  const regex = new RegExp(`\\b\\w{${minLength},}\\b`, 'g');
  const matches = text.toLowerCase().match(regex) || [];
  
  return new Set(matches);
}


export function calculateOverlapPercentage(
  text1: string,
  text2: string,
  minLength = 5
): number {
  const phrases1 = extractKeyPhrases(text1, minLength);
  const phrases2 = extractKeyPhrases(text2, minLength);
  
  if (phrases1.size === 0) return 0;
  
  let intersection = 0;
  phrases1.forEach(phrase => {
    if (phrases2.has(phrase)) intersection++;
  });
  
  return (intersection / phrases1.size) * 100;
}


export function removeCommonPrefixes(title: string): string {
  if (!title) return '';
  
  return title
    .replace(/^(fix|update|add|remove|delete|create|implement|refactor|improve):\s*/i, '')
    .trim();
}


export function extractSignificantWords(text: string): Set<string> {
  return extractKeyPhrases(text, 3);
}
