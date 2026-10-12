/** One builder for nonce issuance and verification; null-context bytes stay legacy-compatible. */
export function ownershipProofPayload(
  receipt: {
    id: string; challengeId: string; taskRef: string; artifactSha256: string;
    intendedActor: string; publicKey: string; keyFingerprint: string;
    payloadDigest: string; expiresAt: Date; contextDigest?: string | null;
  },
  nonce: { id: string; nonce: string },
) {
  return {
    nonce: nonce.nonce, nonceId: nonce.id, receiptId: receipt.id,
    challengeId: receipt.challengeId, taskRef: receipt.taskRef,
    artifactSha256: receipt.artifactSha256, intendedActor: receipt.intendedActor,
    publicKey: receipt.publicKey, keyFingerprint: receipt.keyFingerprint,
    payloadDigest: receipt.payloadDigest, expiresAt: receipt.expiresAt.toISOString(),
    ...(receipt.contextDigest ? { contextDigest: receipt.contextDigest } : {}),
  };
}
