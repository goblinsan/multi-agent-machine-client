import { describe, it, expect, beforeEach } from "vitest";
import fs from "fs/promises";
import path from "path";
import { ensureMaExcludes } from "../src/git/setup/RepoSetup";
import { makeTempRepo } from "./makeTempRepo";

describe("ensureMaExcludes", () => {
  let repo: string;

  beforeEach(async () => {
    repo = await makeTempRepo({ "README.md": "hello" });
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
    await ensureMaExcludes(repo);

    const contents = await readExclude();
    expect(contents).toContain(".ma/");
  });

  it("is idempotent across repeated calls", async () => {
    await ensureMaExcludes(repo);
    await ensureMaExcludes(repo);

    const contents = await readExclude();
    const occurrences = contents
      .split(/\r?\n/)
      .filter((line) => line.trim() === ".ma/").length;
    expect(occurrences).toBe(1);
  });

  it("preserves existing exclude entries", async () => {
    const excludePath = path.join(repo, ".git", "info", "exclude");
    await fs.mkdir(path.dirname(excludePath), { recursive: true });
    await fs.writeFile(excludePath, "custom-entry\n", "utf8");

    await ensureMaExcludes(repo);

    const contents = await readExclude();
    expect(contents).toContain("custom-entry");
    expect(contents).toContain(".ma/");
  });

});
