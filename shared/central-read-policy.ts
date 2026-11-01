import type { CoordinationActorId } from "./schema";

/** Recognition is not issuance: generic enrollment must reject these scopes. */
export const CENTRAL_READ_SCOPES = [
  "central-records:read", "central-documents:read",
] as const;
export function isCentralReadScope(value: string): boolean {
  return (CENTRAL_READ_SCOPES as readonly string[]).includes(value);
}

/** Shared by authentication and the future document audience validator. */
export const CENTRAL_READER_ACTORS: readonly CoordinationActorId[] = Object.freeze([
  "luca-replit", "luca-claude-code", "luca-gemini", "luca-antigravity",
  "luca-holahola", "luca-cursor", "luca-openai-agents", "luca-codex", "alden",
]);

export function validCentralReaderAudience(values: readonly string[]): boolean {
  return values.length > 0 && new Set(values).size === values.length
    && values.every(value => (CENTRAL_READER_ACTORS as readonly string[]).includes(value));
}

/** No founder grant entry point is released in the first source increment. */
export function assertGenericRegistrationScopes(values: readonly string[]): void {
  if (values.some(isCentralReadScope)) {
    throw new Error("Central read scopes require the separately reviewed founder issuance path");
  }
}
