/**
 * Per-turn tool allowlist for Alden (shared by the inbox-wake design eb2ed6bf
 * and the gated-fixes design e4f8e988, both approved 2026-10-30).
 *
 * A turn that carries an allowlist may run only the listed tools. The check is
 * enforced in executeAldenTool itself, before any tool runs, so it covers both
 * engines, every nested dispatch and every continuation phase that reuses the
 * same allowlist. The model-visible tool list is filtered too, but that is
 * courtesy, not the boundary.
 *
 * An allowlist is immutable once made: it exposes only `has` and `names`, so no
 * code path in the turn can widen it. A turn without an allowlist behaves
 * exactly as before.
 */
export interface AldenToolAllowlist {
  readonly label: string;
  has(toolName: string): boolean;
  readonly names: readonly string[];
}

export function makeAldenToolAllowlist(label: string, toolNames: readonly string[]): AldenToolAllowlist {
  if (!label) throw new Error('an Alden tool allowlist needs a label');
  const names = Object.freeze([...new Set(toolNames)].sort());
  const set = new Set(names);
  return Object.freeze({ label, names, has: (toolName: string) => set.has(toolName) });
}

/**
 * The refusal returned to the model for a tool outside the turn's allowlist.
 * Null when the tool may run (no allowlist, or the tool is listed).
 */
export function aldenToolRefusal(toolName: string, allowlist: AldenToolAllowlist | undefined): { error: string; refused: 'tool_not_allowed'; allowlist: string } | null {
  if (!allowlist || allowlist.has(toolName)) return null;
  return {
    error: `The tool "${toolName}" is not available in this turn (${allowlist.label}).`,
    refused: 'tool_not_allowed',
    allowlist: allowlist.label,
  };
}
