export function cleanResponse(response: string): string {
  let cleaned = response.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

  cleaned = cleaned.replace(/^\s*`{3,}[a-zA-Z]*\s*$/gm, "```");

  cleaned = cleaned.replace(/<\/?pre[^>]*>/gi, "");
  cleaned = cleaned.replace(/<\/?code[^>]*>/gi, "");

  return cleaned;
}
