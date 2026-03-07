import { parentPort, workerData } from "worker_threads";
import { spawn } from "child_process";

if (!parentPort) {
  throw new Error("testRunnerWorker requires a parent port");
}

interface WorkerPayload {
  command: string;
  cwd: string;
  timeoutMs: number;
  idleTimeoutMs: number;
  env?: NodeJS.ProcessEnv;
}

const payload = workerData as WorkerPayload;
const { command, cwd, timeoutMs, idleTimeoutMs, env } = payload;

const startTime = Date.now();
let completed = false;
let timedOut = false;
let idleTimedOut = false;
let stdoutBuffer = "";
let stderrBuffer = "";
let lastActivity = Date.now();

const child = spawn(command, {
  cwd,
  shell: true,
  env: { ...process.env, ...env },
  stdio: ["ignore", "pipe", "pipe"],
});

function cleanupTimers() {
  clearTimeout(timeout);
  clearInterval(idleCheck);
}

function handleAbort(reason: string) {
  if (completed) return;
  completed = true;
  try {
    child.kill("SIGTERM");
  } catch {}
  cleanupTimers();
  parentPort?.postMessage({
    type: "result",
    success: false,
    errorMessage: reason,
    stdout: stdoutBuffer,
    stderr: stderrBuffer,
    timedOut,
    idleTimedOut,
  });
}

const timeout = setTimeout(() => {
  timedOut = true;
  handleAbort(`Command timed out after ${timeoutMs}ms`);
}, timeoutMs);

const idleCheck = setInterval(() => {
  if (Date.now() - lastActivity >= idleTimeoutMs) {
    idleTimedOut = true;
    handleAbort(
      `Command produced no output for ${idleTimeoutMs}ms (idle timeout)`,
    );
  }
}, Math.min(idleTimeoutMs, 1000));

child.stdout?.on("data", (data) => {
  const chunk = data.toString();
  stdoutBuffer += chunk;
  lastActivity = Date.now();
  parentPort?.postMessage({ type: "stdout", chunk });
});

child.stderr?.on("data", (data) => {
  const chunk = data.toString();
  stderrBuffer += chunk;
  lastActivity = Date.now();
  parentPort?.postMessage({ type: "stderr", chunk });
});

child.on("close", (code) => {
  if (completed) return;
  completed = true;
  cleanupTimers();

  if (code === 0) {
    parentPort?.postMessage({
      type: "result",
      success: true,
      stdout: stdoutBuffer,
      stderr: stderrBuffer,
      durationMs: Date.now() - startTime,
    });
  } else {
    parentPort?.postMessage({
      type: "result",
      success: false,
      errorMessage: `Command failed with code ${code}: ${stderrBuffer || stdoutBuffer}`,
      stdout: stdoutBuffer,
      stderr: stderrBuffer,
      exitCode: code,
    });
  }
});

child.on("error", (error) => {
  if (completed) return;
  completed = true;
  cleanupTimers();
  parentPort?.postMessage({
    type: "result",
    success: false,
    errorMessage: error.message,
    stdout: stdoutBuffer,
    stderr: stderrBuffer,
  });
});

parentPort.on("message", (msg) => {
  if (!msg) return;
  if (msg.type === "abort") {
    handleAbort(msg.reason || "Command aborted by coordinator");
  }
});
