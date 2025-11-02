import path from "path";

export const EXTENSION_LANGUAGE_MAP: Record<string, string> = {
  ".ts": "TypeScript",
  ".tsx": "TypeScript",
  ".js": "JavaScript",
  ".jsx": "JavaScript",
  ".mjs": "JavaScript",
  ".cjs": "JavaScript",
  ".py": "Python",
  ".rb": "Ruby",
  ".go": "Go",
  ".rs": "Rust",
  ".java": "Java",
  ".kt": "Kotlin",
  ".swift": "Swift",
  ".cs": "C#",
  ".php": "PHP",
  ".c": "C",
  ".cc": "C++",
  ".cpp": "C++",
  ".h": "C/C++ Header",
  ".hpp": "C++",
  ".mm": "Objective-C++",
  ".m": "Objective-C",
  ".scala": "Scala",
  ".dart": "Dart",
  ".lua": "Lua",
  ".pl": "Perl",
  ".sh": "Shell",
  ".ps1": "PowerShell",
  ".bat": "Batch",
  ".sql": "SQL",
  ".elm": "Elm",
  ".ex": "Elixir",
  ".exs": "Elixir",
};

export function languageForPath(filePath: string): string | null {
  const ext = path.extname(filePath).toLowerCase();
  return EXTENSION_LANGUAGE_MAP[ext] || null;
}
