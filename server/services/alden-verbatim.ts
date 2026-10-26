/**
 * Byte-exact guard for text Alden passes through on someone else's behalf.
 *
 * A language model asked to retype a long text drifts, and sometimes "improves"
 * it (2026-10-25: Alden rewrote a sentence of its own September 19 entry while
 * copying it into Episode 35). The caller supplies the SHA-256 of the exact
 * text; the write happens only if the bytes match.
 */
import { createHash } from "node:crypto";

export const sha256Utf8 = (text: string): string =>
  createHash("sha256").update(text, "utf8").digest("hex");

export type VerbatimCheck =
  | { ok: true; contentSha256: string }
  | { ok: false; contentSha256: string; error: string };

/** No expected hash: nothing to check (the hash is still reported). Malformed or mismatched: refuse. */
export function checkExpectedContent(content: string, expectedSha256: unknown): VerbatimCheck {
  const contentSha256 = sha256Utf8(content);
  if (expectedSha256 === undefined || expectedSha256 === null || expectedSha256 === '') {
    return { ok: true, contentSha256 };
  }
  const expected = String(expectedSha256).trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(expected)) {
    return { ok: false, contentSha256, error: 'expected_content_sha256 must be 64 hex characters; nothing was written' };
  }
  if (expected !== contentSha256) {
    return {
      ok: false,
      contentSha256,
      error: `content does not match expected_content_sha256 (got ${contentSha256}); nothing was written. `
        + 'Copy the text again exactly as given; do not edit it to make it match.',
    };
  }
  return { ok: true, contentSha256 };
}
