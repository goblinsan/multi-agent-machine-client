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
  
  export async function gatherQaDiagnostics(commandsInput: any, repoRoot: string): Promise<QaDiagnostics | null> {
    const commands = Array.isArray(commandsInput)
      ? (commandsInput as any[]).map((cmd: any) => (typeof cmd === "string" ? cmd.trim() : "")).filter((value: string): value is string => value.length > 0)
      : [];
  
    if (!commands.length) return null;
  
    const entries: QaDiagnostics["entries"] = [];
  
    for (const command of commands) {
      const result = await runShellCommand(command, repoRoot).catch((error: any) => {
        return {
          command,
          stdout: "",
          stderr: "",
          exitCode: 1,
          signal: null,
          durationMs: 0,
          error: String(error?.message || error)
        } as CommandRunResult;
      });
  
      const entry = {
        command: result.command,
        exitCode: result.exitCode,
        signal: result.signal,
        durationMs: result.durationMs,
        stdout: clipText((result.stdout || "").trim(), 2000) || "(no stdout)",
        stderr: clipText((result.stderr || "").trim(), 2000) || "(no stderr)",
        error: result.error,
        logs: [] as Array<{ path: string; content: string }>
      };
  
      entries.push(entry);
  
      if (result.exitCode !== 0) {
        // On failure, look for common log files produced by test/lint tools and attach their contents.
        try {
          const candidates = [
            "npm-debug.log",
            "npm-debug.log.*",
            "test-results.log",
            "test-output.log",
            "jest-results.json",
            "lint-report.txt",
            "eslint-report.txt",
            "coverage/lcov.info",
            "coverage/coverage-final.json",
            "reports/test-results.xml"
          ];
          for (const pattern of candidates) {
            const globPath = path.join(repoRoot, pattern);
            try {
              // simple existence check for exact files, and for patterns try a wildcard glob via readdir when necessary
              if (!pattern.includes("*")) {
                const stat = await fs.stat(globPath).catch(() => null);
                if (stat) {
                  const raw = await fs.readFile(globPath, "utf8").catch(() => "");
                  if (raw && raw.trim().length) {
                    entry.logs!.push({ path: path.relative(repoRoot, globPath), content: clipText(raw, 10000) });
                  }
                }
              } else {
                // pattern contains wildcard - list directory and match
                const dir = path.dirname(globPath);
                const basePattern = path.basename(pattern).replace(/\*/g, "");
                const files = await fs.readdir(dir).catch(() => [] as string[]);
                for (const f of files) {
                  if (basePattern && !f.includes(basePattern)) continue;
                  const full = path.join(dir, f);
                  const stat = await fs.stat(full).catch(() => null);
                  if (!stat || !stat.isFile()) continue;
                  const raw = await fs.readFile(full, "utf8").catch(() => "");
                  if (raw && raw.trim().length) entry.logs!.push({ path: path.relative(repoRoot, full), content: clipText(raw, 10000) });
                }
              }
            } catch (err) {
              // ignore individual file read errors
            }
          }
          // Also look for absolute paths mentioned in stdout/stderr (e.g. npm debug log path) and attach them
          try {
            const combined = `${result.stdout || ""}\n${result.stderr || ""}`;
            const npmMatch = /A complete log of this run can be found in:\s*(\S+)/i.exec(combined);
            const pathsFound = new Set<string>();
            if (npmMatch && npmMatch[1]) pathsFound.add(npmMatch[1]);
            // generic absolute path matches (Unix)
            const absPathRegex = /(?<!\S)(\/[^\s:]+)/g;
            let m: RegExpExecArray | null;
            while ((m = absPathRegex.exec(combined))) {
              const candidate = m[1];
              if (candidate.includes("/.npm/_logs/") || candidate.startsWith(repoRoot) || candidate.startsWith(process.env.HOME || "")) {
                pathsFound.add(candidate);
              }
            }
            for (const p of Array.from(pathsFound)) {
              try {
                const raw = await fs.readFile(p, "utf8").catch(() => "");
                if (raw && raw.trim().length) entry.logs!.push({ path: path.relative(repoRoot, p), content: clipText(raw, 10000) });
              } catch (err) {
                // ignore
              }
            }
          } catch (err) {
            // ignore
          }
        } catch (err) {
          // ignore overall diagnostics attach failures
        }
        break;
      }
    }
  
    if (!entries.length) return null;
  
    const textParts = entries.map(entry => {
      const lines: string[] = [];
      lines.push(`Command: ${entry.command}`);
      lines.push(`Exit code: ${entry.exitCode}` + (entry.signal ? ` (signal: ${entry.signal})` : ""));
      if (entry.error) lines.push(`Error: ${entry.error}`);
      if (entry.stdout && entry.stdout !== "(no stdout)") {
        lines.push(`STDOUT:\n${entry.stdout}`);
      }
      if (entry.stderr && entry.stderr !== "(no stderr)") {
        lines.push(`STDERR:\n${entry.stderr}`);
      }
      if (entry.logs && entry.logs.length) {
        for (const l of entry.logs) {
          lines.push(`LOG ${l.path}:\n${l.content}`);
        }
      }
      return lines.join("\n");
    });
  
    return { text: textParts.join("\n\n"), entries };
  }
