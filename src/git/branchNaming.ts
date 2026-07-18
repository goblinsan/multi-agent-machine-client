const NON_SEGMENT = /[^a-z0-9]+/g;

export function toBranchSegment(value: string): string {
  return String(value ?? "")
    .toLowerCase()
    .replace(NON_SEGMENT, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

export function changeBranchName(changeSlug: string): string {
  const segment = toBranchSegment(changeSlug);
  if (!segment) {
    throw new Error("changeBranchName: change slug produced an empty segment");
  }
  return `change/${segment}`;
}

export function fileBranchName(changeSlug: string, fileId: string): string {
  const change = toBranchSegment(changeSlug);
  const file = toBranchSegment(fileId);
  if (!change) {
    throw new Error("fileBranchName: change slug produced an empty segment");
  }
  if (!file) {
    throw new Error("fileBranchName: file id produced an empty segment");
  }
  return `change/${change}__${file}`;
}

export function isFileBranchOf(changeSlug: string, branch: string): boolean {
  const change = toBranchSegment(changeSlug);
  if (!change) return false;
  return branch.startsWith(`change/${change}__`);
}
