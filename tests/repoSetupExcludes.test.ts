import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs/promises";
import path from "path";
import { cfg } from "../src/config";
import { ensureMaExcludes } from "../src/git/setup/RepoSetup";
import { makeTempRepo } from "./makeTempRepo";

describe("ensureMaExcludes", () => {
  const originalMode = cfg.maArtifactsMode;
  let repo: string;

  beforeEach(async () => {
    repo = await makeTempRepo({ "README.md": "hello" });
  });

  afterEach(() => {
    (cfg as any).maArtifactsMode = originalMode;
  });

  async function readExclude(): Promise<string> {
    try {
      return await fs.readFile(
        path.join(repo, ".git", "info", "exclude"),
        "utf8",
      );
    } catch {
      return "";
    }
  }

  it("adds .ma exclude patterns in api mode", async () => {
    (cfg as any).maArtifactsMode = "api";
    await ensureMaExcludes(repo);

    const contents = await readExclude();
    expect(contents).toContain(".ma/");
  });

  it("is idempotent across repeated calls", async () => {
    (cfg as any).maArtifactsMode = "api";
    await ensureMaExcludes(repo);
    await ensureMaExcludes(repo);

    const contents = await readExclude();
    const occurrences = contents
      .split(/\r?\n/)
      .filter((line) => line.trim() === ".ma/").length;
    expect(occurrences).toBe(1);
  });

  it("preserves existing exclude entries", async () => {
    (cfg as any).maArtifactsMode = "api";
    const excludePath = path.join(repo, ".git", "info", "exclude");
    await fs.mkdir(path.dirname(excludePath), { recursive: true });
    await fs.writeFile(excludePath, "custom-entry\n", "utf8");

    await ensureMaExcludes(repo);

    const contents = await readExclude();
    expect(contents).toContain("custom-entry");
    expect(contents).toContain(".ma/");
  });

  it("does nothing outside api mode", async () => {
    (cfg as any).maArtifactsMode = "both";
    await ensureMaExcludes(repo);
    expect(await readExclude()).not.toContain(".ma/");

    (cfg as any).maArtifactsMode = "git";
    await ensureMaExcludes(repo);
    expect(await readExclude()).not.toContain(".ma/");
  });
});
