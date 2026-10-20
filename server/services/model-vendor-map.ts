/**
 * Reviewed, versioned model-vendor map for canonical-record attribution
 * (shared-spec f5d77712, section 3.2). It is the ONLY source of a
 * provider attribution derived from a model id: a run may claim
 * `providerEvidence: "audited-model-vendor-map:v1"` only if its exact model id
 * matches an entry here AND the claimed provider equals that entry's vendor.
 *
 * `provider` is the model vendor (the developer of the model), never the
 * hosting platform. Changing this table changes what counts as evidence, so
 * every change goes through review, and a changed mapping gets a new version
 * rather than silently re-interpreting records written under v1.
 */
export const MODEL_VENDOR_MAP_V1_EVIDENCE = 'audited-model-vendor-map:v1';

export const MODEL_VENDOR_MAP_V1: ReadonlyArray<{ readonly prefix: string; readonly provider: string }> = Object.freeze([
  Object.freeze({ prefix: 'claude-', provider: 'anthropic' }),
]);

/** The vendor for an exact model id under map v1, or undefined if unmapped. */
export function vendorForModelV1(model: string): string | undefined {
  const matches = MODEL_VENDOR_MAP_V1.filter(entry => model.startsWith(entry.prefix) && model.length > entry.prefix.length);
  // Overlapping prefixes that disagree would make the map ambiguous; treat as unmapped.
  const vendors = new Set(matches.map(entry => entry.provider));
  return vendors.size === 1 ? [...vendors][0] : undefined;
}
