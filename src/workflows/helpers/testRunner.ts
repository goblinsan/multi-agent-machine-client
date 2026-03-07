import { Worker } from "worker_threads";
import { fileURLToPath } from "url";
import { existsSync } from "fs";

const workerPath = (() => {
  const jsPath = fileURLToPath(
    new URL("../workers/testRunnerWorker.js", import.meta.url),
  );
  if (existsSync(jsPath)) {
    return jsPath;
  }
  return fileURLToPath(
    new URL("../workers/testRunnerWorker.ts", import.meta.url),
  );
})();

export interface TestRunnerOptions {
  command: string;
  cwd: string;
  timeoutMs: number;
  idleTimeoutMs?: number;
  env?: NodeJS.ProcessEnv;
}

export interface TestRunnerResult {
  stdout: string;
  stderr: string;
  durationMs: number;
}

export async function runTestCommandWithWorker(
  options: TestRunnerOptions,
): Promise<TestRunnerResult> {
  const sanitizedTimeout = Math.max(options.timeoutMs, 2000);
  const defaultIdleTimeout = Math.max(
    Math.min(sanitizedTimeout - 1000, 60000),
    1000,
  );
  const { command, cwd, timeoutMs, idleTimeoutMs = defaultIdleTimeout, env } = options;

  return new Promise((resolve, reject) => {
    const worker = new Worker(workerPath, {
      workerData: {
        command,
        cwd,
        timeoutMs,
        idleTimeoutMs,
        env,
      },
    });

    const overallTimeout = setTimeout(() => {
      worker.postMessage({ type: "abort", reason: "Test command exceeded guard timeout" });
      setTimeout(() => worker.terminate(), 5000).unref();
    }, timeoutMs + 5000);

    const cleanup = () => {
      clearTimeout(overallTimeout);
    };

    worker.once("error", (error) => {
      cleanup();
      worker.terminate().catch(() => undefined);
      reject(error);
    });

    worker.on("message", (msg: any) => {
      if (!msg || msg.type !== "result") return;
      cleanup();
      if (msg.success) {
        resolve({
          stdout: msg.stdout || "",
          stderr: msg.stderr || "",
          durationMs: msg.durationMs || timeoutMs,
        });
      } else {
        const error = new Error(msg.errorMessage || "Test command failed");
        (error as any).stdout = msg.stdout;
        (error as any).stderr = msg.stderr;
        (error as any).timedOut = msg.timedOut;
        (error as any).idleTimedOut = msg.idleTimedOut;
        (error as any).exitCode = msg.exitCode;
        reject(error);
      }
      worker.terminate().catch(() => undefined);
    });
  });
}
