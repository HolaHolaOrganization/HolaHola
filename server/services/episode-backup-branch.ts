/** Neon schema-only copies are detached: init_source=parent-schema, no parent_id. */
export function assertEpisodeRestoreBranch(
  branch: { id: string; name: string; parent_id?: string; default: boolean; protected: boolean; init_source?: string; expires_at?: string },
  expected: { id: string; name: string; parentId: string; expiresAt: string },
): void {
  if (branch.id !== expected.id || branch.name !== expected.name ||
      branch.default !== false || branch.protected !== false || branch.init_source !== "parent-schema" ||
      (branch.parent_id !== undefined && branch.parent_id !== expected.parentId) ||
      !branch.expires_at || !Number.isFinite(Date.parse(branch.expires_at)) ||
      Math.abs(Date.parse(branch.expires_at) - Date.parse(expected.expiresAt)) >= 1000) {
    throw new Error("Disposable schema-only branch identity differs from recorded creation request");
  }
}
