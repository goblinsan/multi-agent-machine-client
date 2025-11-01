import fs from "fs/promises";
import path from "path";
import { cfg } from "../../config.js";
import { logger } from "../../logger.js";
import { runGit } from "../core.js";
import {
  hasLocalChanges,
  remoteBranchExists,
  detectRemoteDefaultBranch,
} from "../queries.js";
import { parseRemote, maskRemote } from "../utils/remoteUtils.js";
import { sanitizeSegment, directoryExists } from "../utils/fsUtils.js";

type RemoteInfo = {
  remote: string;
  sanitized: string;
  credentialUrl?: URL;
};

export async function ensureProjectBase() {
  await fs.mkdir(cfg.projectBase, { recursive: true });
}

export function repoDirectoryFor(remote: string, projectHint?: string | null) {
  if (projectHint && projectHint.trim().length) {
    const segments = projectHint
      .split(/[\\/]+/)
      .map(sanitizeSegment)
      .filter(Boolean);
    if (segments.length > 0) {
      return path.join(cfg.projectBase, ...segments);
    }
  }

  const parsed = parseRemote(remote);
  const rel = parsed.path.replace(/\.git$/i, "");
  const pieces = rel
    .split(/[\\/]+/)
    .map(sanitizeSegment)
    .filter(Boolean);

  if (pieces.length > 0) {
    const projectName = pieces[pieces.length - 1];
    return path.join(cfg.projectBase, projectName);
  }

  return path.join(cfg.projectBase, cfg.defaultRepoName);
}

export function remoteWithCredentials(remote: string): RemoteInfo {
  const secret = cfg.git.token || cfg.git.password;
  const hasSshKey = Boolean(cfg.git.sshKeyPath && cfg.git.sshKeyPath.length);

  if (hasSshKey) {
    try {
      const parsed = parseRemote(remote);
      const host = parsed.host.replace(/^https?:/i, "");
      const sshRemote = `git@${host}:${parsed.path}`;
      return { remote: sshRemote, sanitized: sshRemote };
    } catch (e) {
      logger.debug("Failed to convert HTTP(S) remote to SSH", {
        remote: maskRemote(remote),
        error: String(e),
      });
    }
  }

  const sanitized = maskRemote(remote);
  if (!secret) {
    return { remote, sanitized };
  }

  try {
    const url = new URL(remote);
    const username =
      (cfg.git.username || (cfg.git.token ? "git" : "")).trim() || "git";
    if (!url.username) url.username = username;
    url.password = secret;
    const credentialUrl = new URL(url.toString());
    return { remote: url.toString(), sanitized, credentialUrl };
  } catch {
    return { remote, sanitized };
  }
}

export async function configureCredentialStore(
  repoRoot: string,
  credentialUrl?: URL,
) {
  if (!credentialUrl) return;
  if (!cfg.git.credentialsPath) return;
  const credentialsPath = cfg.git.credentialsPath;

  try {
    await fs.mkdir(path.dirname(credentialsPath), { recursive: true });
  } catch (e) {
    logger.warn("Failed to create credentials directory", {
      path: path.dirname(credentialsPath),
      error: String(e),
    });
  }

  const username =
    credentialUrl.username || cfg.git.username || (cfg.git.token ? "git" : "");
  const password = credentialUrl.password || cfg.git.token || cfg.git.password;
  if (!password) return;

  const entry = `${credentialUrl.protocol}//${encodeURIComponent(username)}:${encodeURIComponent(password)}@${credentialUrl.host}`;

  try {
    await fs.writeFile(credentialsPath, `${entry}\n`, { mode: 0o600 });
  } catch (e) {
    logger.warn("git credential store write failed", {
      error: e,
      path: credentialsPath,
    });
    return;
  }

  try {
    await runGit(
      ["config", "credential.helper", `store --file=${credentialsPath}`],
      { cwd: repoRoot },
    );
  } catch (e) {
    logger.warn("git credential helper config failed", {
      error: e,
      repoRoot,
      credentialsPath,
    });
  }
}

export async function ensureRepo(
  remote: string,
  branch: string | null,
  projectHint: string | null,
) {
  await ensureProjectBase();
  const remoteInfo = remoteWithCredentials(remote);
  const repoRoot = repoDirectoryFor(remote, projectHint);
  const displayRemote = maskRemote(remoteInfo.sanitized);

  const repoExists = await directoryExists(repoRoot);
  const gitDirExists = await directoryExists(path.join(repoRoot, ".git"));

  if (!repoExists) {
    await fs.mkdir(path.dirname(repoRoot), { recursive: true });
    logger.info("git clone", { remote: displayRemote, repoRoot });

    await runGit(["clone", remoteInfo.remote, repoRoot], {
      cwd: cfg.projectBase,
    });
  } else if (!gitDirExists) {
    throw new Error(
      `Cannot reuse ${repoRoot}: path exists but is not a git repo`,
    );
  } else {
    logger.info("git fetch", { remote: displayRemote, repoRoot });
    try {
      await runGit(["remote", "set-url", "origin", remoteInfo.sanitized], {
        cwd: repoRoot,
      });
    } catch (e) {
      logger.debug("Failed to set remote origin URL", {
        repoRoot,
        error: String(e),
      });
    }
    await runGit(["fetch", "--all", "--tags"], { cwd: repoRoot });
  }

  if (remoteInfo.sanitized !== remoteInfo.remote) {
    try {
      await runGit(["remote", "set-url", "origin", remoteInfo.sanitized], {
        cwd: repoRoot,
      });
    } catch (e) {
      logger.warn("git set-url origin failed", {
        error: e,
        repoRoot,
        url: remoteInfo.sanitized,
      });
    }
  }

  await configureCredentialStore(repoRoot, remoteInfo.credentialUrl);

  if (branch) {
    const remoteExists = await remoteBranchExists(repoRoot, branch);

    try {
      await runGit(["checkout", branch], { cwd: repoRoot });
    } catch {
      try {
        if (remoteExists) {
          await runGit(["checkout", "-B", branch, `origin/${branch}`], {
            cwd: repoRoot,
          });
        } else {
          logger.debug("Branch does not exist locally or remotely", {
            repoRoot,
            branch,
          });
        }
      } catch (e) {
        logger.warn("git checkout branch failed", {
          error: e,
          repoRoot,
          branch,
        });
      }
    }

    if (remoteExists) {
      try {
        await runGit(["pull", "--ff-only", "origin", branch], {
          cwd: repoRoot,
        });
      } catch (e) {
        logger.warn("git pull failed", { error: e, repoRoot, branch });

        try {
          if (!(await hasLocalChanges(repoRoot))) {
            await runGit(["fetch", "origin", branch], { cwd: repoRoot }).catch(
              () => {},
            );
            await runGit(["reset", "--hard", `origin/${branch}`], {
              cwd: repoRoot,
            });
            logger.info(
              "git branch aligned to origin after non-FF pull (ensureRepo)",
              { repoRoot, branch },
            );
          }
        } catch (alignErr) {
          logger.warn("git align to origin failed (ensureRepo)", {
            repoRoot,
            branch,
            error: alignErr,
          });
        }
      }
    } else {
      logger.debug("Skipping pull for new branch", { repoRoot, branch });
    }
  } else {
    let current = "";
    try {
      current = (
        await runGit(["rev-parse", "--abbrev-ref", "HEAD"], { cwd: repoRoot })
      ).stdout.trim();
    } catch (e) {
      logger.debug("Failed to get current branch", {
        repoRoot,
        error: String(e),
      });
    }

    if (!current || current === "HEAD") {
      const fallback =
        (await detectRemoteDefaultBranch(repoRoot)) || cfg.git.defaultBranch;
      if (fallback) {
        try {
          await runGit(["checkout", fallback], { cwd: repoRoot });
        } catch (e) {
          logger.warn("git default branch checkout failed", {
            error: e,
            repoRoot,
            fallback,
          });
        }
      }
    }
  }

  return { repoRoot, remote: remoteInfo.sanitized };
}
