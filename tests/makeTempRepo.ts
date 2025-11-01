import fs from "fs/promises";
import path from "path";
import os from "os";
import { exec } from "child_process";
import { promisify } from "util";
const execP = promisify(exec);

export async function makeTempRepo(initialFiles?: Record<string, string>) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mc-repo-"));
  if (initialFiles) {
    for (const [rel, content] of Object.entries(initialFiles)) {
      const full = path.join(dir, rel);
      await fs.mkdir(path.dirname(full), { recursive: true });
      await fs.writeFile(full, content, "utf8");
    }
  } else {
    await fs.writeFile(path.join(dir, "README.md"), "# temp\n", "utf8");
  }
  await execP("git init -b main", { cwd: dir });
  await execP("git add .", { cwd: dir });
  await execP('git commit -m "init"', { cwd: dir });
  return dir;
}
