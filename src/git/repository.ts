/**
 * repository.ts - Main git repository coordination module
 * 
 * This module serves as the main facade for git repository operations.
 * It exports the two primary entry points used throughout the application:
 * - resolveRepoFromPayload: Resolve repository location from task payloads
 * - checkoutBranchFromBase: Checkout or create branches for tasks
 * 
 * All git operations have been extracted into focused modules:
 * - resolution/RepoResolver: Parse payloads and resolve repo locations
 * - setup/RepoSetup: Clone and initialize repositories
 * - operations/BranchOperations: Branch checkout and management
 * - utils/remoteUtils: Git remote URL parsing
 * - utils/fsUtils: Filesystem utilities
 */

export type { RepoResolution } from "./resolution/RepoResolver.js";
export { resolveRepoFromPayload } from "./resolution/RepoResolver.js";
export { checkoutBranchFromBase } from "./operations/BranchOperations.js";
