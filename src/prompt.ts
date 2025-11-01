import _fs from "fs/promises";
import { cfg } from "./config.js";

const PROMPT_FILE_MAX_TOTAL_CHARS = Math.max(2000, Math.floor(cfg.promptFileMaxChars || 48000));
const PROMPT_FILE_MAX_PER_FILE_CHARS = Math.max(500, Math.floor(cfg.promptFileMaxPerFileChars || 12000));
const PROMPT_FILE_MAX_FILES = Math.max(1, Math.floor(cfg.promptFileMaxFiles || 8));
const PROMPT_FILE_ALLOWED_EXTS = new Set(
  (cfg.promptFileAllowedExts && cfg.promptFileAllowedExts.length ? cfg.promptFileAllowedExts : [
    ".ts", ".tsx", ".js", ".jsx", ".json", ".css", ".md", ".html", ".yml", ".yaml"
  ]).map(ext => ext.toLowerCase())
);
const PROMPT_FILE_ALWAYS_INCLUDE = new Set([
  "package.json",
  "tsconfig.json",
  "vite.config.ts",
  "project.json",
  "README.md"
].map(path => path.toLowerCase()));
