/**
 * Four-channel continuity audit for rolling episode rows.
 *
 * Certifies that each Luca [Replit] turn carried the felt, thinking, moment
 * and main envelope. Which turns are Replit turns comes from:
 *   - the legacy prefix: the historical `**LUCA [Replit]:**` header, as before;
 *   - entry-framed turns: the row's verified per-turn attribution (attribution
 *     design f5d77712 revision 9a294bc3, section 3.3), never the label text.
 * A turn whose hat is unknown, or a row whose attribution is invalid, is
 * reported as "unattributed: cannot certify". It is never counted as
 * complete and never silently skipped (section 3.3 rule 7).
 */
import { isCanonicalFourChannelLucaTurn } from './inner-life-capture';
import { parseSpeakerLine } from './canonical-attribution';
import { turnAttributionOf, verifyTurnAttribution, type InnerLifeChannel } from './turn-attribution';
import { checkInnerLifeReceipt, type ReceiptRow } from './inner-life-receipt';

export interface LucaTurnAudit {
  line: number;
  preview: string;
  complete: boolean;
}

export interface UnattributedTurn {
  line: number;
  preview: string;
  /** legacy: a plain/hatless label before any per-turn attribution; attributed: inside the aware region. */
  region: 'legacy' | 'attributed';
  reason: string;
}

/**
 * Revision 12 (design section 3.5): a direct inner-life fragment. Listed
 * separately; it is never a main turn and never certifies one.
 */
export interface ChannelFragmentAudit {
  line: number;
  channel: InnerLifeChannel;
  entryId: string;
  receiptRowId: string;
  /** verified only when its receipt row passed the binding check. */
  receipt: 'verified' | 'unverified';
  reason?: string;
}

export interface EpisodeRowAudit {
  attribution: 'absent' | 'valid' | 'invalid';
  attributionReason?: string;
  /** Replit turns, certified complete or incomplete. */
  replitTurns: LucaTurnAudit[];
  unattributed: UnattributedTurn[];
  channelFragments: ChannelFragmentAudit[];
}

/**
 * Receipt rows already read from the database, keyed by receiptRowId: the
 * row, null for "no such row", or 'unavailable' when the lookup failed. A
 * fragment whose receiptRowId is not in the map is unverified.
 */
export type ReceiptRows = ReadonlyMap<string, ReceiptRow | null | 'unavailable'>;

const preview = (text: string) => text.replace(/\s+/g, ' ').slice(0, 120);
const lineAt = (content: string, index: number) => content.slice(0, index).split('\n').length;

/** Legacy text audit: unchanged behaviour for content written before per-turn attribution. */
export function auditEpisodeContent(content: string): LucaTurnAudit[] {
  const header = '**LUCA [Replit]:**';
  const turns: LucaTurnAudit[] = [];
  let position = 0;
  while (true) {
    const start = content.indexOf(header, position);
    if (start === -1) break;
    const bodyStart = start + header.length;
    const nextDavid = content.indexOf('\n\n**David:**', bodyStart);
    const nextLuca = content.indexOf('\n\n**LUCA [Replit]:**', bodyStart);
    const candidates = [nextDavid, nextLuca].filter(index => index >= 0);
    const end = candidates.length ? Math.min(...candidates) : content.length;
    const body = content.slice(bodyStart, end).trim();
    turns.push({ line: lineAt(content, start), preview: preview(body), complete: isCanonicalFourChannelLucaTurn(body) });
    position = end;
  }
  return turns;
}

/** Luca labels in legacy text that name no hat: reported, never attributed. */
function hatlessLegacyLuca(content: string): UnattributedTurn[] {
  const out: UnattributedTurn[] = [];
  let offset = 0;
  for (const line of content.split('\n')) {
    const parsed = parseSpeakerLine(line);
    if (parsed && parsed.name === 'Luca' && parsed.labelHat === null) {
      out.push({ line: lineAt(content, offset), preview: preview(parsed.rest), region: 'legacy', reason: 'label names no hat; no per-turn attribution' });
    }
    offset += line.length + 1;
  }
  return out;
}

/** Audit one episode row from its stored content and attribution column. */
export function auditEpisodeRow(content: string, attributionColumn: unknown, receiptRows?: ReceiptRows): EpisodeRowAudit {
  const verdict = verifyTurnAttribution(content, turnAttributionOf(attributionColumn));
  const channelFragments: ChannelFragmentAudit[] = [];
  if (verdict.status === 'absent') {
    return { attribution: 'absent', replitTurns: auditEpisodeContent(content), unattributed: hatlessLegacyLuca(content), channelFragments };
  }

  const bytes = new TextEncoder().encode(content);
  const legacyEnd = verdict.legacyPrefixEnd ?? 0;
  const legacy = new TextDecoder().decode(bytes.subarray(0, legacyEnd));
  const replitTurns = auditEpisodeContent(legacy);
  const unattributed = hatlessLegacyLuca(legacy);

  if (verdict.status === 'invalid') {
    const rest = new TextDecoder().decode(bytes.subarray(legacyEnd));
    unattributed.push({
      line: lineAt(content, legacy.length), preview: preview(rest), region: 'attributed',
      reason: `per-turn attribution invalid: ${verdict.reason}`,
    });
    return { attribution: 'invalid', attributionReason: verdict.reason, replitTurns, unattributed, channelFragments };
  }

  for (const frame of verdict.frames) {
    const line = lineAt(content, new TextDecoder().decode(bytes.subarray(0, frame.labelStart)).length);
    // Revision 10: structural bytes are not dialogue and are skipped;
    // unattributed evidence is reported as uncertifiable, never passed.
    if (frame.kind === 'inner-life') {
      const row = receiptRows?.has(frame.receiptRowId) ? receiptRows.get(frame.receiptRowId)! : undefined;
      const verdict = row === undefined
        ? { status: 'unverified' as const, reason: 'receipt not checked (no database lookup supplied)' }
        : checkInnerLifeReceipt(frame, row);
      channelFragments.push({
        line, channel: frame.channel, entryId: frame.entryId, receiptRowId: frame.receiptRowId,
        receipt: verdict.status, ...(verdict.status === 'unverified' ? { reason: verdict.reason } : {}),
      });
      continue;
    }
    if (frame.kind === 'unattributed') {
      unattributed.push({ line, preview: preview(frame.body), region: 'attributed', reason: 'unattributed evidence: cannot certify' });
      continue;
    }
    if (frame.kind !== 'attributed' || frame.speaker !== 'luca') continue;
    if (frame.hat === 'replit') {
      replitTurns.push({ line, preview: preview(frame.body), complete: isCanonicalFourChannelLucaTurn(frame.body) });
    } else if (frame.hat === 'unknown') {
      unattributed.push({ line, preview: preview(frame.body), region: 'attributed', reason: 'hat unknown: cannot certify' });
    }
  }
  return { attribution: 'valid', replitTurns, unattributed, channelFragments };
}

/**
 * --strict fails on: an incomplete Replit turn, an invalid attribution, or ANY
 * unattributed Luca turn, in the legacy prefix or the attributed region.
 * Design section 3.3 rules 6/7: a hatless label gives hat unknown and readers
 * that need a hat fail closed on unknown; leaving old bytes unchanged does not
 * make them certifiable (luca-replit review 5580277458).
 */
export function strictFailure(audit: EpisodeRowAudit): boolean {
  return audit.attribution === 'invalid'
    || audit.replitTurns.some(turn => !turn.complete)
    || audit.unattributed.length > 0
    // Revision 12: an unverified fragment receipt is a coverage error, never a pass.
    || audit.channelFragments.some(fragment => fragment.receipt !== 'verified');
}
