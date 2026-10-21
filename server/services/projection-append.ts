/**
 * The pure core of an attribution-aware projection append (attribution
 * design f5d77712, revision 9a294bc3, section 3.3 "Atomic, idempotent
 * projection appends"). No I/O: the caller runs this inside ONE transaction
 * with the row locked FOR UPDATE and writes back exactly what it returns.
 *
 * Given the row's current content and turnAttribution and one source event
 * ({ source, sourceEventId, frames }), it returns one of:
 *   - append:   the new content and turnAttribution (bytes and entries together)
 *   - noop:     every frame already present with identical label+body bytes
 *   - conflict: a frame key already present with different bytes, or a
 *               partially present event, or a row whose current attribution
 *               does not verify; nothing may be written.
 *
 * The first aware append to a row sets legacyPrefixEnd to the current
 * content length; legacy bytes are never rewritten and no entries are
 * invented for them.
 */
import { createHash } from 'node:crypto';
import { TURN_ATTRIBUTION_SEPARATOR, verifyTurnAttribution } from './turn-attribution';

export interface AppendFrame {
  kind: 'attributed' | 'participant';
  frameKey: string;
  /** Exact rendered label bytes, e.g. "**Luca:** ". */
  label: string;
  /** Exact authored body; never trimmed or rewritten here. */
  body: string;
  // attributed only
  speaker?: 'david' | 'luca';
  hat?: string;
  hatEvidence?: string;
  captureId?: string | null;
  provenance?: Record<string, unknown> | null;
  // participant only
  participant?: string;
}

export interface AppendEvent {
  source: string;
  sourceEventId: string;
  frames: AppendFrame[];
}

export type AppendPlan =
  | { kind: 'append'; content: string; turnAttribution: Record<string, unknown> }
  | { kind: 'noop' }
  | { kind: 'conflict'; reason: string };

const sha256Hex = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** The identity/evidence a frame claims, compared on retry (provenance excluded). */
function frameEvidence(f: { kind?: unknown; speaker?: unknown; participant?: unknown; hat?: unknown; hatEvidence?: unknown }): string {
  return JSON.stringify(f.kind === 'participant'
    ? ['participant', f.participant]
    : ['attributed', f.speaker, f.hat, f.hatEvidence]);
}

export function planProjectionAppend(currentContent: string, currentTurnAttribution: unknown, event: AppendEvent): AppendPlan {
  // Validate the whole incoming event before any idempotency decision, so a
  // malformed retry is refused rather than reported as a no-op.
  if (event.frames.length === 0) return { kind: 'conflict', reason: 'an event must carry at least one frame' };
  const keysInEvent = new Set(event.frames.map(frame => frame.frameKey));
  if (keysInEvent.size !== event.frames.length) return { kind: 'conflict', reason: 'duplicate frameKey within the event' };
  const existingBytes = encoder.encode(currentContent);

  let turns: Record<string, unknown>[] = [];
  let legacyPrefixEnd = existingBytes.length;
  if (currentTurnAttribution !== undefined && currentTurnAttribution !== null) {
    const verdict = verifyTurnAttribution(currentContent, currentTurnAttribution);
    if (verdict.status !== 'valid') {
      return { kind: 'conflict', reason: `current attribution does not verify: ${verdict.status === 'invalid' ? verdict.reason : verdict.status}` };
    }
    const t = currentTurnAttribution as Record<string, unknown>;
    turns = (t.turns as Record<string, unknown>[]).map(entry => ({ ...entry }));
    legacyPrefixEnd = verdict.legacyPrefixEnd;
  }

  // Idempotency by (source, sourceEventId, frameKey). First receipt wins:
  // - an exact retry (same label and body bytes, same claimed identity and
  //   hat evidence) is a no-op, in any frame order;
  // - the same key with different bytes, or a different claimed identity or
  //   hat evidence, is a conflict;
  // - a retry whose only difference is provenance keeps the FIRST stored
  //   provenance (no-op); evidence is never silently replaced;
  // - an event that is only partly present is a conflict (never half-appended twice).
  const byKey = new Map(turns.map(entry => [JSON.stringify([entry.source, entry.sourceEventId, entry.frameKey]), entry]));
  let present = 0;
  for (const frame of event.frames) {
    const existing = byKey.get(JSON.stringify([event.source, event.sourceEventId, frame.frameKey]));
    if (!existing) continue;
    const label = decoder.decode(existingBytes.subarray(existing.labelStart as number, existing.bodyStart as number));
    const body = decoder.decode(existingBytes.subarray(existing.bodyStart as number, existing.bodyEnd as number));
    if (label !== frame.label || body !== frame.body) {
      return { kind: 'conflict', reason: `frame ${frame.frameKey} of ${event.source}/${event.sourceEventId} already present with different bytes` };
    }
    if (frameEvidence(existing) !== frameEvidence(frame)) {
      return { kind: 'conflict', reason: `frame ${frame.frameKey} of ${event.source}/${event.sourceEventId} already present with different identity or evidence` };
    }
    present++;
  }
  if (present === event.frames.length) return { kind: 'noop' };
  if (present > 0) return { kind: 'conflict', reason: `event ${event.source}/${event.sourceEventId} is only partly present` };

  let content = currentContent;
  let index = turns.length;
  for (const frame of event.frames) {
    if (encoder.encode(content).length > 0) content += TURN_ATTRIBUTION_SEPARATOR;
    const labelStart = encoder.encode(content).length;
    content += frame.label;
    const bodyStart = encoder.encode(content).length;
    content += frame.body;
    const bodyEnd = encoder.encode(content).length;
    const base = {
      index: index++, kind: frame.kind, source: event.source, sourceEventId: event.sourceEventId, frameKey: frame.frameKey,
      labelStart, bodyStart, bodyEnd,
    };
    turns.push(frame.kind === 'participant'
      ? { ...base, participant: frame.participant }
      : {
          ...base, speaker: frame.speaker, hat: frame.hat, hatEvidence: frame.hatEvidence,
          captureId: frame.captureId ?? null, provenance: frame.provenance ?? null,
        });
  }

  const bytes = encoder.encode(content);
  for (const entry of turns) {
    entry.labelSha256 = sha256Hex(bytes.subarray(entry.labelStart as number, entry.bodyStart as number));
    entry.bodySha256 = sha256Hex(bytes.subarray(entry.bodyStart as number, entry.bodyEnd as number));
  }
  const turnAttribution = {
    version: 1, encoding: 'utf8-bytes', legacyPrefixEnd,
    coveredEnd: bytes.length, coveredSha256: sha256Hex(bytes), separator: TURN_ATTRIBUTION_SEPARATOR, turns,
  };
  const verdict = verifyTurnAttribution(content, turnAttribution);
  if (verdict.status !== 'valid') return { kind: 'conflict', reason: `appended attribution does not verify: ${verdict.status === 'invalid' ? verdict.reason : verdict.status}` };
  return { kind: 'append', content, turnAttribution };
}
