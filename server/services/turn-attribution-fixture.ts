/** Test fixture: build a projection row exactly as an aware writer would append it. */
import { createHash } from 'node:crypto';

export const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
export const enc = (s: string) => new TextEncoder().encode(s);
const SEP = '\n\n';

export interface Spec {
  kind: 'attributed' | 'participant' | 'structural' | 'unattributed';
  source: string;
  eventId: string;
  frameKey: string;
  label: string;
  body: string;
  speaker?: 'david' | 'luca';
  hat?: string;
  hatEvidence?: string;
  participant?: string;
  captureId?: string | null;
  provenance?: unknown;
}

/** Build a projection row exactly as an aware writer would append it. */
export function row(legacy: string, specs: Spec[]) {
  let content = legacy;
  const turns: Record<string, unknown>[] = [];
  specs.forEach((spec, index) => {
    if (content.length > 0) content += SEP;
    const labelStart = enc(content).length;
    content += spec.label;
    const bodyStart = enc(content).length;
    content += spec.body;
    const bodyEnd = enc(content).length;
    const bytes = enc(content);
    const base = {
      index, kind: spec.kind, source: spec.source, sourceEventId: spec.eventId, frameKey: spec.frameKey,
      labelStart, bodyStart, bodyEnd,
      labelSha256: sha(bytes.subarray(labelStart, bodyStart)), bodySha256: sha(bytes.subarray(bodyStart, bodyEnd)),
    };
    turns.push(spec.kind === 'structural' || spec.kind === 'unattributed'
      ? base
      : spec.kind === 'participant'
      ? { ...base, participant: spec.participant }
      : {
          ...base, speaker: spec.speaker, hat: spec.hat, hatEvidence: spec.hatEvidence,
          captureId: spec.captureId ?? null, provenance: spec.provenance ?? null,
        });
  });
  const bytes = enc(content);
  return {
    content,
    turnAttribution: {
      version: 1, encoding: 'utf8-bytes', legacyPrefixEnd: enc(legacy).length,
      coveredEnd: bytes.length, coveredSha256: sha(bytes), separator: SEP, turns,
    } as Record<string, any>,
  };
}

