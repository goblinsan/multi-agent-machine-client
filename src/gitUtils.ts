



export { runGit, __setRunGitImplForTests, gitEnv, isWorkspaceRepo, guardWorkspaceMutation } from "./git/core.js";


export { resolveRepoFromPayload, checkoutBranchFromBase } from "./git/repository.js";
export type { RepoResolution } from "./git/repository.js";


export { ensureBranchPublished, commitAndPushPaths } from "./git/commits.js";


export { 
  detectRemoteDefaultBranch, 
  branchExists, 
  remoteBranchExists, 
  hasLocalChanges,
  describeWorkingTree,
  getRepoMetadata,
  verifyRemoteBranchHasDiff,
  getBranchHeadSha
} from "./git/queries.js";
export type { WorkingTreeEntry, WorkingTreeSummary, RemoteDiffVerification } from "./git/queries.js";
