import fs from "fs";
import path from "path";

export type SingleInstanceLockResult =
  | { acquired: true; lockPath: string; release: () => void }
  | { acquired: false; lockPath: string; holderPid: number };

export function acquireSingleInstanceLock(
  lockDir: string,
  name = "machine-client",
): SingleInstanceLockResult {
  const lockPath = path.join(lockDir, `.${name}.lock`);
  fs.mkdirSync(lockDir, { recursive: true });

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(
        lockPath,
        JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }),
        { flag: "wx" },
      );
      const release = () => releaseLock(lockPath);
      process.once("exit", release);
      return { acquired: true, lockPath, release };
    } catch (err: any) {
      if (err?.code !== "EEXIST") throw err;

      const holderPid = readLockPid(lockPath);
      if (holderPid !== null && isProcessAlive(holderPid)) {
        return { acquired: false, lockPath, holderPid };
      }

      try {
        fs.unlinkSync(lockPath);
      } catch (unlinkErr: any) {
        if (unlinkErr?.code !== "ENOENT") throw unlinkErr;
      }
    }
  }

  const holderPid = readLockPid(lockPath) ?? -1;
  return { acquired: false, lockPath, holderPid };
}

function releaseLock(lockPath: string): void {
  try {
    const holderPid = readLockPid(lockPath);
    if (holderPid === process.pid) {
      fs.unlinkSync(lockPath);
    }
  } catch {
    void 0;
  }
}

function readLockPid(lockPath: string): number | null {
  try {
    const raw = fs.readFileSync(lockPath, "utf8");
    const parsed = JSON.parse(raw);
    return typeof parsed?.pid === "number" ? parsed.pid : null;
  } catch {
    return null;
  }
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    return err?.code === "EPERM";
  }
}
