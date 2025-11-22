import { firstString } from "../../util.js";

export function extractRepoRemote(
  details: any,
  projectInfo: any,
  payload: any,
): string {
  const pickRemoteFrom = (obj: any) => {
    if (!obj || typeof obj !== "object") {
      return "";
    }

    const direct = firstString(
      obj?.primary_repository?.clone_url,
      obj?.primary_repository?.url,
      obj?.primary_repository?.remote,
      obj?.repository?.clone_url,
      obj?.repository?.url,
      obj?.repository?.remote,
      obj?.repo?.clone_url,
      obj?.repo?.url,
      obj?.repo?.remote,
      obj?.repo_remote,
      obj?.repository_url,
      obj?.repo,
      obj?.repository,
    );
    if (direct) {
      return direct;
    }

    const repoLists = [
      Array.isArray(obj?.repositories) ? obj.repositories : null,
      Array.isArray(obj?.repos) ? obj.repos : null,
    ].filter(Boolean) as Array<any[]>;

    for (const repoList of repoLists) {
      for (const entry of repoList) {
        const candidate = firstString(
          entry?.clone_url,
          entry?.url,
          entry?.remote,
          entry?.git_url,
          entry?.ssh_url,
        );
        if (candidate) {
          return candidate;
        }
      }
    }

    return "";
  };

  return (
    firstString(
      pickRemoteFrom(details),
      pickRemoteFrom(projectInfo),
      pickRemoteFrom(payload),
    ) || ""
  );
}
