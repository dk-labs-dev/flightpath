// Allow-list keys use "/"; split on "\" too so Windows paths match anywhere.

export function toRepoPath(relativePath) {
  return relativePath.split(/[\\/]/).join("/");
}
