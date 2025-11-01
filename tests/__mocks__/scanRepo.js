import { vi } from "vitest";

export const scanRepo = vi.fn().mockResolvedValue([
  { path: "src/main.ts", bytes: 1024, lines: 50, mtime: Date.now() },
  { path: "src/utils.ts", bytes: 512, lines: 25, mtime: Date.now() },
  { path: "package.json", bytes: 256, lines: 15, mtime: Date.now() },
]);
