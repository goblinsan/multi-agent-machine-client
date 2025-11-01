import fs from "fs";
import path from "path";
import { cfg } from "./config.js";

type Level = "error" | "warn" | "info" | "debug" | "trace";

const LEVELS: Record<Level, number> = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
  trace: 4
};

const configuredLevel = ((): Level => {
  const lvl = (cfg.log.level || "info") as Level;
  return (lvl in LEVELS) ? lvl : "info";
})();

const minLevel = LEVELS[configuredLevel];
const consoleEnabled = cfg.log.console;
const logFile = cfg.log.file;

let stream: fs.WriteStream | null = null;

function ensureStream() {
  if (!logFile) return null;
  if (stream) return stream;
  try {
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
  } catch (e) {
    console.error('[logger] failed to create log directory', e);
  }
  try {
    
    const header = `# machine-client log (level=${configuredLevel}) started ${new Date().toISOString()}\n`;
    try {
      fs.appendFileSync(logFile, header);
    } catch (e) {
      console.error('[logger] failed to write log header', e);
    }
    stream = fs.createWriteStream(logFile, { flags: "a" });
    
    stream.on('error', (err) => {
      console.error('[logger] write stream error', err);
      try { 
        stream?.end(); 
      } catch (e) {
        console.error('[logger] failed to close stream', e);
      }
      stream = null;
    });
    stream.on('open', () => {
      if (consoleEnabled) console.log(`[logger] log stream opened ${logFile}`);
    });
  } catch (e) {
    console.error("[logger] failed to create log file stream", e);
    stream = null;
  }
  return stream;
}

export function getLogFilePath() {
  return logFile;
}

export function isFileLoggingActive() {
  return !!stream;
}

function serialize(value: any): any {
  if (value instanceof Error) {
    const base: Record<string, any> = {
      name: value.name,
      message: value.message,
      stack: value.stack
    };
    for (const key of Object.keys(value)) {
      const v = (value as any)[key];
      if (v !== undefined) base[key] = v;
    }
    return base;
  }
  if (!value || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(serialize);
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = serialize(v);
  }
  return out;
}

function write(level: Level, message: string, meta?: any) {
  if (LEVELS[level] > minLevel) return;
  const entry: Record<string, any> = {
    ts: new Date().toISOString(),
    level,
    msg: message
  };
  if (meta !== undefined) entry.meta = serialize(meta);

  const line = JSON.stringify(entry);
  if (consoleEnabled) {
    const consoleMethod = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
    if (entry.meta !== undefined) {
      consoleMethod(`[${level}] ${message}`, entry.meta);
    } else {
      consoleMethod(`[${level}] ${message}`);
    }
  }
  const s = ensureStream();
  if (s) {
    s.write(line + "\n");
  }
}

export const logger = {
  error(message: string, meta?: any) { write("error", message, meta); },
  warn(message: string, meta?: any) { write("warn", message, meta); },
  info(message: string, meta?: any) { write("info", message, meta); },
  debug(message: string, meta?: any) { write("debug", message, meta); },
  trace(message: string, meta?: any) { write("trace", message, meta); }
};

if (logFile) {
  ensureStream();
  if (consoleEnabled) {
    console.log(`[logger] writing to ${logFile} at level ${configuredLevel}`);
  }
}
