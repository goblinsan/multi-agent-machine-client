import path from "path";
import fs from "fs/promises";
import { clipText } from "../../util.js";

type CommandRunResult = {
    command: string;
    stdout: string;
    stderr: string;
    exitCode: number;
    signal: string | null;
    durationMs: number;
    error?: string;
  };
  
  async function runShellCommand(command: string, cwd: string, timeoutMs = 300000): Promise<CommandRunResult> {
    const childProcess = await import("child_process");
    const started = Date.now();
    return await new Promise((resolve) => {
      let resolved = false;
      try {
        const child = childProcess.exec(command, { cwd, timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024 }, (error: any, stdout: string, stderr: string) => {
          if (resolved) return;
          resolved = true;
          const durationMs = Date.now() - started;
          if (error) {
            resolve({
              command,
              stdout: stdout ?? "",
              stderr: stderr ?? "",
              exitCode: typeof error.code === "number" ? error.code : 1,
              signal: error.signal ?? null,
              durationMs,
              error: typeof error.message === "string" ? error.message : undefined
            });
          } else {
            resolve({ command, stdout: stdout ?? "", stderr: stderr ?? "", exitCode: 0, signal: null, durationMs });
          }
        });
        child.on("error", (error: any) => {
          if (resolved) return;
          resolved = true;
          const durationMs = Date.now() - started;
          resolve({
            command,
            stdout: "",
            stderr: "",
            exitCode: typeof error?.code === "number" ? error.code : 1,
            signal: null,
            durationMs,
            error: String(error?.message || error)
          });
        });
      } catch (error: any) {
        if (resolved) return;
        resolved = true;
        const durationMs = Date.now() - started;
        resolve({
          command,
          stdout: "",
          stderr: "",
          exitCode: typeof error?.code === "number" ? error.code : 1,
          signal: null,
          durationMs,
          error: String(error?.message || error)
        });
      }
    });
  }
  
  type QaDiagnostics = {
    text: string;
    entries: Array<{
      command: string;
      exitCode: number;
      signal: string | null;
      durationMs: number;
      stdout: string;
      stderr: string;
      error?: string;
      logs?: Array<{ path: string; content: string }>;
    }>;
  };
  
