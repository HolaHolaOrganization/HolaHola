/**
 * What an `approve` from the code-review queue may do (gated-fixes design
 * e4f8e988, P0b), decided before any write:
 *
 * - **dev**: the current guarded path (applyPatch, then sync), but only after
 *   the change is resolved under the read policy, is not in a read-only
 *   directory, and its reviewed before-code matches the immutable HEAD bytes
 *   (`pin: dev-head`, clean working file, regular blob).
 * - **production**: never applied. The change is stored as a pending,
 *   release-pinned proposal through propose_fix's route (status
 *   approved_pending_review, linked by build_queue_id).
 * - **unknown or missing role**, or any change that cannot be pinned (path
 *   refused, read-only target, stale before-code, unusable manifest):
 *   review_blocked with the reason. No apply, no sync, no fabricated pin.
 *
 * The auto-repair blocklist is not applied here: it guards automatic
 * application, and a stored proposal is never applied without review.
 */
import { buildPinnedChange, groupEditsByResolvedPath, pinSourceForRole, ProposeFixRefusal, type PinnedChange, type PinSource } from './alden-propose-fix';

export interface ReviewedChange {
  id: string;
  findingTitle: string;
  filePath: string;
  lineStart: number;
  lineEnd: number;
  beforeCode: string;
  afterCode: string;
  patchRationale: string;
}

export type ApprovalPlan =
  | { kind: 'apply'; rel: string; pinCommit: string }
  | { kind: 'store'; change: PinnedChange; source: PinSource; recheckSource: () => PinSource }
  | { kind: 'blocked'; reason: string };

/** How far the find may grow, in lines each way, to become unique in the pinned original. */
const MAX_FIND_CONTEXT_LINES = 20;

/**
 * The reviewed line range as a unique find/replace edit against the pinned
 * original: the lines must equal the reviewed before-code exactly, and
 * surrounding lines are added (unchanged on both sides) until the find occurs
 * once.
 */
export function reviewedChangeAsEdit(rel: string, original: string, change: ReviewedChange): { find: string; replace: string } {
  const lines = original.split('\n');
  const start = change.lineStart - 1;
  const end = change.lineEnd;
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end > lines.length || start >= end) {
    throw new ProposeFixRefusal(`${rel}: the reviewed line range ${change.lineStart}-${change.lineEnd} is outside the pinned file`);
  }
  if (lines.slice(start, end).join('\n') !== change.beforeCode) {
    throw new ProposeFixRefusal(`stale base: ${rel} lines ${change.lineStart}-${change.lineEnd} no longer match the reviewed before-code`);
  }
  for (let pad = 0; pad <= MAX_FIND_CONTEXT_LINES; pad++) {
    const from = Math.max(0, start - pad);
    const to = Math.min(lines.length, end + pad);
    const before = lines.slice(from, start);
    const after = lines.slice(end, to);
    const find = [...before, ...lines.slice(start, end), ...after].join('\n');
    const first = original.indexOf(find);
    if (first >= 0 && original.indexOf(find, first + 1) < 0) {
      return { find, replace: [...before, change.afterCode, ...after].join('\n') };
    }
    if (from === 0 && to === lines.length) break;
  }
  throw new ProposeFixRefusal(`${rel}: the reviewed lines are not unique in the pinned file`);
}

export function planApproval(change: ReviewedChange, root: string, env: NodeJS.ProcessEnv = process.env): ApprovalPlan {
  try {
    const source = pinSourceForRole(root, env);
    const groups = groupEditsByResolvedPath([{ path: change.filePath, find: change.beforeCode || ' ', replace: change.afterCode }], root, { blocklist: false });
    const [rel] = [...groups.keys()];
    const original = source.read(rel).bytes.toString('utf8');
    const edit = reviewedChangeAsEdit(rel, original, change);
    if (source.kind === 'dev-head') return { kind: 'apply', rel, pinCommit: source.commit };
    const pinned = buildPinnedChange(new Map([[rel, [{ path: rel, ...edit }]]]), source);
    return { kind: 'store', change: pinned, source, recheckSource: () => pinSourceForRole(root, env) };
  } catch (err: any) {
    // Fail closed: anything that prevents an exact pin blocks the approval.
    return { kind: 'blocked', reason: err instanceof ProposeFixRefusal ? err.message : `could not pin the change: ${err?.message ?? err}` };
  }
}
