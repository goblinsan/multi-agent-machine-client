import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { acquireSingleInstanceLock } from "../src/util/singleInstanceLock";

describe("acquireSingleInstanceLock", () => {
  let lockDir: string;

  beforeEach(() => {
    lockDir = fs.mkdtempSync(path.join(os.tmpdir(), "ma-lock-test-"));
  });

  afterEach(() => {
    fs.rmSync(lockDir, { recursive: true, force: true });
  });

  it("acquires the lock when none exists", () => {
    const result = acquireSingleInstanceLock(lockDir, "test-instance");
    expect(result.acquired).toBe(true);
    expect(fs.existsSync(result.lockPath)).toBe(true);
    if (result.acquired) result.release();
  });

  it("refuses a second acquisition while the holder is alive", () => {
    const first = acquireSingleInstanceLock(lockDir, "test-instance");
    expect(first.acquired).toBe(true);

    const second = acquireSingleInstanceLock(lockDir, "test-instance");
    expect(second.acquired).toBe(false);
    if (!second.acquired) {
      expect(second.holderPid).toBe(process.pid);
    }

    if (first.acquired) first.release();
  });

  it("allows reacquisition after release", () => {
    const first = acquireSingleInstanceLock(lockDir, "test-instance");
    expect(first.acquired).toBe(true);
    if (first.acquired) first.release();

    const second = acquireSingleInstanceLock(lockDir, "test-instance");
    expect(second.acquired).toBe(true);
    if (second.acquired) second.release();
  });

  it("steals a stale lock whose holder process is dead", () => {
    const lockPath = path.join(lockDir, ".test-instance.lock");
    fs.writeFileSync(
      lockPath,
      JSON.stringify({ pid: 2 ** 22 + 12345, startedAt: "2020-01-01T00:00:00Z" }),
    );

    const result = acquireSingleInstanceLock(lockDir, "test-instance");
    expect(result.acquired).toBe(true);
    if (result.acquired) {
      const contents = JSON.parse(fs.readFileSync(result.lockPath, "utf8"));
      expect(contents.pid).toBe(process.pid);
      result.release();
    }
  });

  it("steals a lock with unparseable contents", () => {
    const lockPath = path.join(lockDir, ".test-instance.lock");
    fs.writeFileSync(lockPath, "not json");

    const result = acquireSingleInstanceLock(lockDir, "test-instance");
    expect(result.acquired).toBe(true);
    if (result.acquired) result.release();
  });
});
