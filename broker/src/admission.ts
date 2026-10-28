// Signed large-body admission for blob.put (stage-1 design dc6f8927 revision
// 4, section 8).
//
// Every request body is capped at STANDARD_BODY_LIMIT. A blob.put that
// cannot fit first sends a small signed admission manifest in a request
// header. The broker verifies it with one Ed25519 check against the current
// policy, BEFORE reading any body bytes, and only then reserves one of a
// bounded number of slots. The body must then match the manifest exactly,
// and the request is fully authorized again as usual. Admission is never
// authority to execute anything.
//
// Founder decision F5: no limits are set in code. The large-body path is
// disabled unless every cap below is configured as a finite value on the
// broker service itself (see loadConfig in main.ts).

import { type KeyObject, randomBytes, sign, verify } from 'node:crypto';
import { canonicalJson } from './canonical.ts';
import { type Policy } from './policy.ts';

/** Every request without a valid admission is capped here, as before. */
export const STANDARD_BODY_LIMIT = 64 * 1024;
export const ADMISSION_HEADER = 'holahola-admission';
export const ADMISSION_DOMAIN = 'holahola-admission/v1';
export const MAX_ADMISSION_HEADER_CHARS = 2048;
export const MAX_ADMISSION_VALIDITY_MS = 60_000;
export const ADMISSION_CLOCK_SKEW_MS = 5_000;
/** Room for the envelope, signature and JSON framing around the encoded content. */
export const ENVELOPE_ALLOWANCE_BYTES = 65_536;

/** All five values must be configured; there are no defaults (F5). */
export type AdmissionConfig = {
  /** Largest admitted blob, in raw (decoded) bytes. */
  maxRawBytes: number;
  /** Concurrent admitted bodies across all actors. */
  globalSlots: number;
  /** Concurrent admitted bodies per actor. */
  actorSlots: number;
  /** Whole-body deadline, from admission to the last byte. */
  bodyDeadlineMs: number;
  /** Minimum average transfer rate once the first second has passed. */
  minBytesPerSecond: number;
};

export type AdmissionManifest = {
  domain: typeof ADMISSION_DOMAIN;
  actor: string;
  keyId: string;
  operation: 'blob.put';
  repositoryId: number;
  rawSize: number;
  encodedSize: number;
  bodySize: number;
  /** The envelope's payloadSha256 for the request that follows. */
  payloadDigest: string;
  admissionId: string;
  issuedAt: number;
  expiresAt: number;
};

export type AdmissionRejection = 'admission_invalid' | 'too_large';

const FIELDS = ['domain', 'actor', 'keyId', 'operation', 'repositoryId', 'rawSize', 'encodedSize', 'bodySize', 'payloadDigest', 'admissionId', 'issuedAt', 'expiresAt'];
const ADMISSION_ID = /^[A-Za-z0-9_-]{16,128}$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const BASE64URL = /^[A-Za-z0-9_-]+$/;

/** Exact base64 length of `rawSize` bytes: 4 * ceil(raw / 3). */
export function encodedLength(rawSize: number): number {
  return 4 * Math.ceil(rawSize / 3);
}

/** The header value: base64url of canonical JSON {manifest, signature}. */
export function signAdmission(privateKey: KeyObject, manifest: AdmissionManifest): string {
  const signature = sign(null, Buffer.from(canonicalJson(manifest), 'utf8'), privateKey).toString('base64');
  return Buffer.from(canonicalJson({ manifest, signature }), 'utf8').toString('base64url');
}

function isCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

/** Strict shape only; nothing is trusted until verifyAdmission passes. */
export function parseAdmissionHeader(value: unknown): { manifest: AdmissionManifest; signature: string } | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_ADMISSION_HEADER_CHARS || !BASE64URL.test(value)) return null;
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (typeof decoded !== 'object' || decoded === null || Array.isArray(decoded)) return null;
  const outer = decoded as Record<string, unknown>;
  if (Object.keys(outer).sort().join(',') !== 'manifest,signature' || typeof outer.signature !== 'string' || outer.signature.length > 128) return null;
  const m = outer.manifest as Record<string, unknown>;
  if (typeof m !== 'object' || m === null || Array.isArray(m)) return null;
  const keys = Object.keys(m);
  if (keys.length !== FIELDS.length || !FIELDS.every((field) => keys.includes(field))) return null;
  const ok = m.domain === ADMISSION_DOMAIN && m.operation === 'blob.put'
    && typeof m.actor === 'string' && typeof m.keyId === 'string'
    && Number.isSafeInteger(m.repositoryId) && isCount(m.rawSize) && isCount(m.encodedSize) && isCount(m.bodySize)
    && typeof m.payloadDigest === 'string' && SHA256_HEX.test(m.payloadDigest)
    && typeof m.admissionId === 'string' && ADMISSION_ID.test(m.admissionId)
    && Number.isSafeInteger(m.issuedAt) && Number.isSafeInteger(m.expiresAt);
  return ok ? { manifest: m as unknown as AdmissionManifest, signature: outer.signature } : null;
}

/**
 * Verifies an admission against the current policy and the configured caps.
 * Signature first, so nothing else is evaluated for an unauthenticated
 * caller; then repository, freshness and the exact size arithmetic.
 */
export function verifyAdmission(
  parsed: { manifest: AdmissionManifest; signature: string }, policy: Policy, config: AdmissionConfig, now: number,
): { ok: true; manifest: AdmissionManifest } | { ok: false; reason: AdmissionRejection } {
  const { manifest, signature } = parsed;
  const key = policy.actors.get(manifest.actor)?.signingKeys.find((candidate) => candidate.id === manifest.keyId);
  if (!key) return { ok: false, reason: 'admission_invalid' };
  let valid = false;
  try {
    valid = verify(null, Buffer.from(canonicalJson(manifest), 'utf8'), key.publicKey, Buffer.from(signature, 'base64'));
  } catch {
    valid = false;
  }
  if (!valid) return { ok: false, reason: 'admission_invalid' };
  if (policy.state === 'closed' || manifest.repositoryId !== policy.repositoryId) return { ok: false, reason: 'admission_invalid' };
  if (manifest.expiresAt <= manifest.issuedAt || manifest.expiresAt - manifest.issuedAt > MAX_ADMISSION_VALIDITY_MS) return { ok: false, reason: 'admission_invalid' };
  if (now + ADMISSION_CLOCK_SKEW_MS < manifest.issuedAt || now >= manifest.expiresAt) return { ok: false, reason: 'admission_invalid' };
  if (manifest.rawSize > config.maxRawBytes) return { ok: false, reason: 'too_large' };
  if (manifest.encodedSize !== encodedLength(manifest.rawSize)) return { ok: false, reason: 'admission_invalid' };
  if (manifest.bodySize < manifest.encodedSize || manifest.bodySize > manifest.encodedSize + ENVELOPE_ALLOWANCE_BYTES) return { ok: false, reason: 'admission_invalid' };
  return { ok: true, manifest };
}

/**
 * The admitted request must be exactly the one the manifest announced: same
 * actor, key, operation and repository, the same payload digest, and content
 * of exactly the announced raw and encoded size. Canonical base64 and the
 * blob sha are then checked by the gateway's blob.put validation.
 */
export function matchesManifest(body: unknown, manifest: AdmissionManifest): boolean {
  if (typeof body !== 'object' || body === null) return false;
  const { envelope, payload } = body as { envelope?: Record<string, unknown>; payload?: Record<string, unknown> };
  if (typeof envelope !== 'object' || envelope === null || typeof payload !== 'object' || payload === null) return false;
  return envelope.actor === manifest.actor && envelope.keyId === manifest.keyId && envelope.operation === 'blob.put'
    && envelope.repositoryId === manifest.repositoryId && envelope.payloadSha256 === manifest.payloadDigest
    && payload.rawSize === manifest.rawSize && typeof payload.contentBase64 === 'string'
    && payload.contentBase64.length === manifest.encodedSize;
}

/** Bounded concurrent admissions: global and per actor, with in-flight admission ids unique. */
export class AdmissionSlots {
  private readonly config: AdmissionConfig;
  private total = 0;
  private readonly perActor = new Map<string, number>();
  private readonly inFlight = new Set<string>();

  constructor(config: AdmissionConfig) {
    this.config = config;
  }

  /** A release function, or a reason. Release is idempotent and must run when the request ends, however it ends. */
  reserve(actor: string, admissionId: string): { ok: true; release: () => void } | { ok: false; reason: 'busy' | 'admission_invalid' } {
    if (this.inFlight.has(admissionId)) return { ok: false, reason: 'admission_invalid' };
    const mine = this.perActor.get(actor) ?? 0;
    if (this.total >= this.config.globalSlots || mine >= this.config.actorSlots) return { ok: false, reason: 'busy' };
    this.total += 1;
    this.perActor.set(actor, mine + 1);
    this.inFlight.add(admissionId);
    let released = false;
    return {
      ok: true,
      release: () => {
        if (released) return;
        released = true;
        this.total -= 1;
        const left = (this.perActor.get(actor) ?? 1) - 1;
        if (left === 0) this.perActor.delete(actor);
        else this.perActor.set(actor, left);
        this.inFlight.delete(admissionId);
      },
    };
  }

  /** For health and tests: slots in use. */
  inUse(): { total: number; actors: number } {
    return { total: this.total, actors: this.perActor.size };
  }
}

/** A unique id for one admission. */
export function newAdmissionId(): string {
  return `adm-${randomBytes(16).toString('hex')}`;
}
