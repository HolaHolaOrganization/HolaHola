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
 * An allowlist is immutable once made: it exposes only `has`, `names` and its
 * bindings, so no code path in the turn can widen it. A turn without an
 * allowlist behaves exactly as before.
 *
 * Bindings (design e4f8e988 P3): a profile can bind a tool argument to a
 * server-supplied value, such as triage's support pattern id or a consult
 * thread id. A call whose argument differs, or a bound tool whose binding is
 * missing, is refused at dispatch; there is no fallback.
 */
export type AldenToolBindings = Readonly<Record<string, string>>;
/** For each tool, which argument must equal which binding. */
export type AldenBoundArgs = Readonly<Record<string, Readonly<{ arg: string; binding: string }>>>;

export interface AldenToolAllowlist {
  readonly label: string;
  has(toolName: string): boolean;
  readonly names: readonly string[];
  readonly bindings: AldenToolBindings;
  readonly boundArgs: AldenBoundArgs;
}

export function makeAldenToolAllowlist(
  label: string,
  toolNames: readonly string[],
  options: { bindings?: Record<string, string | null | undefined>; boundArgs?: Record<string, { arg: string; binding: string }> } = {},
): AldenToolAllowlist {
  if (!label) throw new Error('an Alden tool allowlist needs a label');
  const names = Object.freeze([...new Set(toolNames)].sort());
  const set = new Set(names);
  const bindings: Record<string, string> = {};
  for (const [key, value] of Object.entries(options.bindings ?? {})) if (typeof value === 'string' && value) bindings[key] = value;
  const boundArgs: Record<string, Readonly<{ arg: string; binding: string }>> = {};
  for (const [tool, rule] of Object.entries(options.boundArgs ?? {})) {
    if (!set.has(tool)) throw new Error(`bound tool ${tool} is not in the ${label} allowlist`);
    boundArgs[tool] = Object.freeze({ ...rule });
  }
  return Object.freeze({
    label, names, has: (toolName: string) => set.has(toolName),
    bindings: Object.freeze(bindings), boundArgs: Object.freeze(boundArgs),
  });
}

export type AldenToolRefusal =
  | { error: string; refused: 'tool_not_allowed'; allowlist: string }
  | { error: string; refused: 'tool_binding_mismatch'; allowlist: string };

/**
 * The refusal returned to the model for a tool outside the turn's allowlist,
 * or for a bound tool called with a different (or without its) bound value.
 * Null when the tool may run.
 */
export function aldenToolRefusal(toolName: string, allowlist: AldenToolAllowlist | undefined, args: Record<string, unknown> = {}): AldenToolRefusal | null {
  if (!allowlist) return null;
  if (!allowlist.has(toolName)) {
    return {
      error: `The tool "${toolName}" is not available in this turn (${allowlist.label}).`,
      refused: 'tool_not_allowed',
      allowlist: allowlist.label,
    };
  }
  const rule = allowlist.boundArgs[toolName];
  if (!rule) return null;
  const bound = allowlist.bindings[rule.binding];
  if (!bound || args[rule.arg] !== bound) {
    return {
      error: bound
        ? `In this turn (${allowlist.label}), "${toolName}" may only use ${rule.arg} ${bound}.`
        : `"${toolName}" has no ${rule.binding} in this turn (${allowlist.label}), so it cannot run.`,
      refused: 'tool_binding_mismatch',
      allowlist: allowlist.label,
    };
  }
  return null;
}
