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
import { turnAttributionOf, verifyTurnAttribution } from './turn-attribution';

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

export interface EpisodeRowAudit {
  attribution: 'absent' | 'valid' | 'invalid';
  attributionReason?: string;
  /** Replit turns, certified complete or incomplete. */
  replitTurns: LucaTurnAudit[];
  unattributed: UnattributedTurn[];
}

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
export function auditEpisodeRow(content: string, attributionColumn: unknown): EpisodeRowAudit {
  const verdict = verifyTurnAttribution(content, turnAttributionOf(attributionColumn));
  if (verdict.status === 'absent') {
    return { attribution: 'absent', replitTurns: auditEpisodeContent(content), unattributed: hatlessLegacyLuca(content) };
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
    return { attribution: 'invalid', attributionReason: verdict.reason, replitTurns, unattributed };
  }

  for (const frame of verdict.frames) {
    if (frame.kind !== 'attributed' || frame.speaker !== 'luca') continue;
    const line = lineAt(content, new TextDecoder().decode(bytes.subarray(0, frame.labelStart)).length);
    if (frame.hat === 'replit') {
      replitTurns.push({ line, preview: preview(frame.body), complete: isCanonicalFourChannelLucaTurn(frame.body) });
    } else if (frame.hat === 'unknown') {
      unattributed.push({ line, preview: preview(frame.body), region: 'attributed', reason: 'hat unknown: cannot certify' });
    }
  }
  return { attribution: 'valid', replitTurns, unattributed };
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
    || audit.unattributed.length > 0;
}
