import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { workspaceResolution } from './workspace-root';

type CapturedTurn = {
  speaker: 'DAVID' | 'LUCA' | 'CLAUDE_CODE';
  source?: 'replit' | 'claude-code' | 'antigravity' | 'codex';
  captureId?: string;
  text?: string;
};

export interface HistoricalAttributionApproval {
  episodeId: string;
  authorization: string;
  receiptSha256: string;
}

interface OverlayEntry {
  captureId: string;
  spokenSha256: string;
  sourceId: string;
  evidenceKind: 'complete-turn' | 'explicit-luca-casing';
}

export type HistoricalAttributionPauseCode =
  | 'spoken-bytes-changed' | 'casing-only-bare-evidence'
  | 'mixed-capture-mirror' | 'source-capture-unavailable' | 'mirror-evidence-mismatch';

export interface HistoricalAttributionPauseReason {
  code: HistoricalAttributionPauseCode;
  captureIds: string[];
  approvedSources: OverlayEntry[];
  observedSpokenSha256?: string;
  message: string;
  reconciliation: string;
}

/** A diagnostic, never an attribution grant. No spoken text is carried here. */
export class HistoricalAttributionRecoveryPaused extends Error {
  constructor(readonly reason: HistoricalAttributionPauseReason) {
    super(reason.message);
    this.name = 'HistoricalAttributionRecoveryPaused';
  }
}

const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

/**
 * An approval is separate from evidence: an applied receipt alone cannot grant
 * authorship. Only the two fixed, founder-approved historical repairs are
 * enabled below. New captures, sessions, or receipts require a new approval.
 * This does not edit the immutable capture, source row, or cursor fingerprint.
 */
export class HistoricalAttributionOverlay {
  private readonly entries = new Map<string, OverlayEntry>();
  private readonly captureIds = new Set<string>();

  addApprovedReceipt(bytes: string, approval: HistoricalAttributionApproval): void {
    if (!approval.authorization.trim() || sha256(bytes) !== approval.receiptSha256) {
      throw new Error('Historical attribution receipt is not explicitly approved for these bytes');
    }
    const receipt = JSON.parse(bytes);
    if (receipt.episodeId !== approval.episodeId || receipt.applied !== true ||
        receipt.replicaParity !== true || receipt.nonLabelBytesUnchanged !== true ||
        !Array.isArray(receipt.edits) || !receipt.edits.length) {
      throw new Error('Historical attribution receipt is not a completed label-only repair');
    }
    const additions: OverlayEntry[] = [];
    for (const edit of receipt.edits) {
      if (typeof edit.captureId !== 'string' || !edit.captureId ||
          typeof edit.sourceId !== 'string' || !edit.sourceId ||
          typeof edit.spokenSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(edit.spokenSha256) ||
          !['complete-turn', 'explicit-luca-casing'].includes(edit.evidenceKind) ||
          !/^(?:\*\*)?LUCA \[Claude Code\]:(?:\*\*)?$/.test(edit.newLabel) ||
          !/^(?:\*\*)?(?:Claude Code|LUCA \[claude code\]|Luca \[Claude Code\]):(?:\*\*)?$/.test(edit.oldLabel)) {
        throw new Error('Invalid approved historical attribution entry');
      }
      additions.push({
        captureId: edit.captureId, spokenSha256: edit.spokenSha256,
        sourceId: edit.sourceId, evidenceKind: edit.evidenceKind,
      });
    }
    // Validate the whole receipt before enabling any of it.
    for (const entry of additions) {
      const key = this.key(entry.captureId, entry.spokenSha256);
      if (this.entries.get(key)?.evidenceKind !== 'complete-turn') this.entries.set(key, entry);
      this.captureIds.add(entry.captureId);
    }
  }

  private key(captureId: string, hash: string): string {
    return JSON.stringify([captureId, hash]);
  }

  pause(code: HistoricalAttributionPauseCode, captureIds: string[], message: string, observedSpokenSha256?: string): never {
    const guidance: Record<HistoricalAttributionPauseCode, string> = {
      'spoken-bytes-changed': 'Compare the original length-delimited capture with the approved source row and receipt by capture ID and exact SHA-256. Retain both versions; a changed reply needs new explicit complete-turn approval, not normalization to an old hash.',
      'casing-only-bare-evidence': 'Obtain explicit complete-turn authorship approval for this exact capture and spoken SHA-256. A casing-only receipt or runtime name cannot establish bare authorship.',
      'mixed-capture-mirror': 'Reconcile the queued mirror into independently source-delimited single-capture items through an audited operator repair. Preserve the original queue and source evidence; do not split on rendered speaker headers.',
      'source-capture-unavailable': 'Locate the original length-delimited capture range for this queued item and verify its capture identity and exact boundaries. Do not reconstruct evidence from rendered dialogue.',
      'mirror-evidence-mismatch': 'Compare the entire queued rendering with the independently delimited source capture and approved receipt. Preserve mismatching evidence and use an audited source-backed queue repair, not a matching suffix.',
    };
    throw new HistoricalAttributionRecoveryPaused({
      code, captureIds: [...new Set(captureIds)],
      approvedSources: [...this.entries.values()]
        .filter(entry => captureIds.includes(entry.captureId)).map(entry => ({ ...entry })),
      ...(observedSpokenSha256 ? { observedSpokenSha256 } : {}),
      message,
      reconciliation: guidance[code] + ' Never infer an author, trim or normalize spoken bytes, delete evidence, or advance a cursor/acknowledgement to bypass this pause. Retry the same source identity after reconciliation.',
    });
  }

  label(turn: CapturedTurn): 'LUCA [Claude Code]' | undefined {
    if (turn.speaker === 'DAVID' || !turn.captureId || turn.text === undefined) return;
    // The source hash is exact: whitespace is speech too. No trim, prefix,
    // source-only, session-wide, or text-only authorship inference.
    const entry = this.entries.get(this.key(turn.captureId, sha256(turn.text)));
    if (!entry) {
      if (this.captureIds.has(turn.captureId)) {
        this.pause('spoken-bytes-changed', [turn.captureId],
          `Approved historical capture ${turn.captureId} has different spoken bytes; attribution recovery remains pending`, sha256(turn.text));
      }
      return;
    }
    // Casing-only evidence never authorizes changing a bare assistant identity.
    if (turn.speaker === 'CLAUDE_CODE' && entry.evidenceKind !== 'complete-turn') {
      this.pause('casing-only-bare-evidence', [turn.captureId],
        `Historical capture ${turn.captureId} has casing-only evidence; bare authorship recovery requires explicit complete-turn approval`);
    }
    return 'LUCA [Claude Code]';
  }

  /**
   * Recovery of a persisted autosave mirror. Source turns must come from the
   * original length-delimited capture range, NOT parsed rendered dialogue.
   * Compare the entire queued rendering against those independently delimited
   * turns before changing a label. Quoted headers are just spoken bytes.
   */
  hasApprovedCaptures(captureIds: string[]): boolean {
    return captureIds.some(id => this.captureIds.has(id));
  }

  projectPendingMirror(content: string, captureIds: string[], sourceTurns?: CapturedTurn[]): string {
    if (!this.hasApprovedCaptures(captureIds)) return content;
    if (captureIds.length !== 1) {
      this.pause('mixed-capture-mirror', captureIds, 'Historical attribution mirror mixes capture identities; recovery requires an isolated turn');
    }
    if (!sourceTurns || sourceTurns.length < 1 || sourceTurns.length > 2 ||
        sourceTurns.some(turn => turn.captureId !== captureIds[0] || turn.text === undefined) ||
        sourceTurns[sourceTurns.length - 1].speaker === 'DAVID' ||
        (sourceTurns.length === 2 && sourceTurns[0].speaker !== 'DAVID')) {
      this.pause('source-capture-unavailable', captureIds, 'Approved historical mirror requires its complete independently delimited source capture');
    }
    const originalLabel = (turn: CapturedTurn): string => {
      if (turn.speaker === 'CLAUDE_CODE') return 'Claude Code';
      const name = turn.speaker === 'DAVID' ? 'David' : 'Luca';
      return turn.source === 'claude-code' ? `${name} [Claude Code]`
        : turn.source === 'replit' ? `${name} [Replit]`
        : turn.source === 'antigravity' ? `${name} [Antigravity]` : name;
    };
    const original = sourceTurns.map(turn => `**${originalLabel(turn)}:** ${turn.text}`).join('\n\n');
    const projected = sourceTurns.map(turn =>
      `**${this.label(turn) ?? originalLabel(turn)}:** ${turn.text}`,
    ).join('\n\n');
    if (content !== original && content !== projected) {
      this.pause('mirror-evidence-mismatch', captureIds, `Approved historical mirror ${captureIds[0]} does not match complete spoken evidence`);
    }
    return projected;
  }
}

const APPROVED_RECEIPTS = [
  {
    path: 'episode-34-attribution-repair-evidence.json',
    receiptSha256: '83040bd8ca7ed8369d67af2bc0a7e25460899462fd48a9e57e5dd380c8668d45',
  },
  {
    path: 'episode-34-attribution-repair-backfill-evidence.json',
    receiptSha256: '963932075c107b62f27b37342d8218473c6795979277044eb3f36b5177b5a297',
  },
] as const;

let approvedOverlay: HistoricalAttributionOverlay | undefined;
let testOverlay: HistoricalAttributionOverlay | undefined;
export function setHistoricalAttributionOverlayForTest(overlay?: HistoricalAttributionOverlay): void {
  testOverlay = overlay;
}
/**
 * Unrelated turns do not need historical evidence files at all. This is only
 * a loading filter, never an authorship grant; exact receipt keys still decide.
 */
export function getHistoricalAttributionOverlayForCaptures(captureIds: string[]): HistoricalAttributionOverlay | undefined {
  if (testOverlay) return testOverlay;
  if (!captureIds.some(id => id.startsWith('cc-c52bede8-dd68-4804-8f77-59290f60b9e2-'))) return;
  return getApprovedHistoricalAttributionOverlay();
}

export function historicalAttributionLabel(turn: CapturedTurn): 'LUCA [Claude Code]' | undefined {
  if (turn.speaker === 'DAVID' || !turn.captureId) return;
  return getHistoricalAttributionOverlayForCaptures([turn.captureId])?.label(turn);
}

export function getApprovedHistoricalAttributionOverlay(): HistoricalAttributionOverlay {
  if (testOverlay) return testOverlay;
  if (!approvedOverlay) {
    const overlay = new HistoricalAttributionOverlay();
    for (const receipt of APPROVED_RECEIPTS) {
      overlay.addApprovedReceipt(
        readFileSync(join(workspaceResolution.root, 'docs', receipt.path), 'utf8'),
        {
          episodeId: '41200170-1c49-4660-838c-9d397aff5d27',
          authorization: 'Founder-approved Episode 34 label repair; docs/alden-agent-handoff.md historical attribution handoff. Assigned historical-overlay authorization, 2026-10-03.',
          receiptSha256: receipt.receiptSha256,
        },
      );
    }
    approvedOverlay = overlay;
  }
  return approvedOverlay;
}