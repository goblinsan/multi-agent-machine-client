export type ParsedRemote = {
  host: string;
  path: string;
};

export function parseRemote(remote: string): ParsedRemote {
  const trimmed = remote.trim();
  if (!trimmed) throw new Error("Remote URL is empty");

  const isWindowsDrive = /^[A-Za-z]:[/\\]/.test(trimmed);
  const isUnc = /^\\\\/.test(trimmed);
  const isPosixAbs = /^\//.test(trimmed);
  if (!trimmed.includes("://") && (isWindowsDrive || isUnc || isPosixAbs)) {
    throw new Error(`Local path is not a git remote: ${trimmed}`);
  }

  if (!trimmed.includes("://")) {
    const sshMatch = /^(?:[^@]+@)?([^:]+):(.+)$/.exec(trimmed);
    if (sshMatch) {
      return {
        host: sshMatch[1],
        path: sshMatch[2].replace(/^\/+/, ""),
      };
    }
  }

  try {
    const url = new URL(trimmed);
    return {
      host: url.host,
      path: url.pathname.replace(/^\/+/, ""),
    };
  } catch {
    throw new Error(`Unable to parse git remote: ${trimmed}`);
  }
}

export function maskRemote(remote: string) {
  try {
    const url = new URL(remote);
    url.username = "";
    url.password = "";
    return `${url.protocol}//${url.host}${url.pathname}${url.search}`;
  } catch {
    return remote;
  }
}
