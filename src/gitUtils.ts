// Barrel export for git utilities
// Re-export all git functionality from modular files

// Core git execution and guards
export { runGit, __setRunGitImplForTests, gitEnv, isWorkspaceRepo, guardWorkspaceMutation } from "./git/core.js";

// Repository operations (clone, checkout, branch management, resolution)
export { resolveRepoFromPayload, checkoutBranchFromBase } from "./git/repository.js";
export type { RepoResolution } from "./git/repository.js";

// Commit and push operations
export { ensureBranchPublished, commitAndPushPaths } from "./git/commits.js";

// Query operations (status, diff, metadata)
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
