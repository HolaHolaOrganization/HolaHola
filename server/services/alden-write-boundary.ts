/**
 * Alden's production write boundary (gated-fixes design e4f8e988, P0/P0b,
 * approved 2026-10-30).
 *
 * On Render the server runs the pre-built dist bundle, so a source-file edit
 * never reaches the running server or git, and the guardian then reports a
 * success that did not happen. File writes and shell execution are therefore
 * allowed only when the instance role is exactly `dev`. A `production` role,
 * or a missing or unknown role, fails closed.
 */
import { resolveInstanceRole } from './instance-role';

/** Alden tools that write source files or run processes. */
export const ALDEN_WRITE_TOOLS: readonly string[] = Object.freeze(['apply_code_change', 'patch_file', 'run_shell']);

export type AldenWriteBoundary =
  | { allowed: true }
  | { allowed: false; role: 'production' | 'unknown'; reason: string };

export function aldenWriteBoundary(env: NodeJS.ProcessEnv = process.env): AldenWriteBoundary {
  let role: string;
  try {
    role = resolveInstanceRole(env);
  } catch {
    return { allowed: false, role: 'unknown', reason: 'instance role unknown; file writes and shell are refused' };
  }
  if (role === 'dev') return { allowed: true };
  return {
    allowed: false,
    role: 'production',
    reason: 'production runs the built bundle, so a source edit cannot reach the running server or git; file writes and shell are refused',
  };
}

/** The refusal for a write tool outside `dev`, or null when the tool may run. */
export function aldenWriteToolRefusal(toolName: string, env: NodeJS.ProcessEnv = process.env): { error: string; refused: 'production_write_disabled' | 'instance_role_unknown' } | null {
  if (!ALDEN_WRITE_TOOLS.includes(toolName)) return null;
  const boundary = aldenWriteBoundary(env);
  if (boundary.allowed) return null;
  return {
    error: `The tool "${toolName}" is not available here: ${boundary.reason}. Describe the change for review instead (queue_build_proposal).`,
    refused: boundary.role === 'unknown' ? 'instance_role_unknown' : 'production_write_disabled',
  };
}
