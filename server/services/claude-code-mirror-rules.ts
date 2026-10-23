/** Pure validation and flag rules for the Claude Code transcript mirror (no database). */
import { canonicalJson, contentSha256, isFilterFixedPoint } from '@shared/claude-code-mirror-core.mjs';

export const MIRROR_LIMITS = Object.freeze({
  maxEntriesPerBatch: 200,
  maxEntryBytes: 256 * 1024,
  maxBlocksPerCoverage: 4096,
  maxSessionsPerRootQuery: 500,
  maxEvidenceBytes: 256 * 1024,
  maxPosition: 10_000_000,
});

export class MirrorInputError extends Error {}

const SESSION_ID = /^[A-Za-z0-9-]{8,64}$/;
const UUID = /^[A-Za-z0-9-]{1,64}$/;
export const SHA = /^[0-9a-f]{64}$/;

export function assertSessionId(value: unknown): string {
  if (typeof value !== 'string' || !SESSION_ID.test(value)) throw new MirrorInputError('invalid sessionId');
  return value;
}

export function assertPosition(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > MIRROR_LIMITS.maxPosition) {
    throw new MirrorInputError('invalid position');
  }
  return value as number;
}

export function normalizeUuid(value: unknown): string {
  if (value === undefined || value === null || value === '') return '';
  if (typeof value !== 'string' || !UUID.test(value)) throw new MirrorInputError('invalid uuid');
  return value;
}

export interface IncomingEntry { position: number; uuid?: string | null; entry: unknown }
export interface PreparedEntry { position: number; uuid: string; entry: Record<string, unknown>; sha256: string; byteLength: number }

/** Validates one incoming entry: it must already be in mirrored form (a fixed point of the filter). */
export function prepareEntry(input: IncomingEntry): PreparedEntry {
  const position = assertPosition(input?.position);
  const uuid = normalizeUuid(input?.uuid);
  if (!isFilterFixedPoint(input?.entry)) throw new MirrorInputError(`entry at ${position} is not in filtered form`);
  const json = canonicalJson(input.entry);
  const byteLength = Buffer.byteLength(json, 'utf8');
  if (byteLength > MIRROR_LIMITS.maxEntryBytes) throw new MirrorInputError(`entry at ${position} is too large`);
  return { position, uuid, entry: input.entry as Record<string, unknown>, sha256: contentSha256(input.entry), byteLength };
}

/**
 * Flags for a new observation, given what the session already holds.
 * Pure, so the rules are testable without a database.
 */
export function observationFlags(
  next: { position: number; uuid: string; sha256: string },
  held: Array<{ position: number; uuid: string; sha256: string }>,
): string[] {
  const flags = new Set<string>();
  if (!next.uuid) flags.add('no-uuid');
  for (const h of held) {
    if (h.position === next.position && h.uuid === next.uuid && h.sha256 === next.sha256) continue;
    if (next.uuid && h.uuid === next.uuid && h.sha256 !== next.sha256) flags.add('same-uuid-different-bytes');
    if (h.position === next.position && h.uuid !== next.uuid) flags.add('position-reused');
    if (next.uuid && h.uuid === next.uuid && h.sha256 === next.sha256 && h.position !== next.position) flags.add('position-moved');
  }
  return [...flags].sort();
}
