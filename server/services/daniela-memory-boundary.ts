import { sql, type SQL } from "drizzle-orm";

export const AUTOBIOGRAPHICAL_MEMORY_TAG = "memory:autobiographical";
export const OPERATIONAL_MEMORY_TAG = "memory:operational";
export const LOOKUP_FAILURE_TAG = "operation:lookup_failure";
export const AUTO_GROUNDING_DIAGNOSTIC_TAG = "operation:auto_grounding";

function normalizeTags(tags?: string[] | null): string[] {
  return (tags ?? []).map(tag => tag.trim()).filter(Boolean);
}

export function withAutobiographicalMemoryTag(tags?: string[] | null): string[] {
  return Array.from(new Set([
    ...normalizeTags(tags).filter(tag => tag !== OPERATIONAL_MEMORY_TAG && tag !== LOOKUP_FAILURE_TAG),
    AUTOBIOGRAPHICAL_MEMORY_TAG,
  ]));
}

export function groundingMemoryTags(foundGrounding: boolean): string[] {
  return foundGrounding
    ? [AUTOBIOGRAPHICAL_MEMORY_TAG]
    : [OPERATIONAL_MEMORY_TAG, LOOKUP_FAILURE_TAG];
}

export function autoGroundingMemoryTags(foundGrounding: boolean): string[] {
  return foundGrounding
    ? [OPERATIONAL_MEMORY_TAG, AUTO_GROUNDING_DIAGNOSTIC_TAG]
    : [OPERATIONAL_MEMORY_TAG, AUTO_GROUNDING_DIAGNOSTIC_TAG, LOOKUP_FAILURE_TAG];
}

/**
 * Felt-history readers include legacy rows with null/empty tags and reject only
 * records explicitly classified as operational (including legacy [AUTO-GROUNDING]
 * diagnostic rows written before operational tagging). Provenance (`source`) is a
 * separate axis and must not be used as a proxy for autobiographical meaning.
 */
export function excludesOperationalMemories(
  tagsColumn: unknown,
  contentColumn: unknown = (tagsColumn as any)?.table?.content,
): SQL {
  const tagPredicate = sql`NOT (
    COALESCE(${tagsColumn as any}, ARRAY[]::text[])
    @> ARRAY[${OPERATIONAL_MEMORY_TAG}]::text[]
  )`;
  if (!contentColumn) {
    return tagPredicate;
  }
  return sql`${tagPredicate} AND COALESCE(${contentColumn as any}, '') NOT LIKE '[AUTO-GROUNDING]%'`;
}

export function isOperationalLookupFailure(tags?: string[] | null): boolean {
  const normalized = normalizeTags(tags);
  return normalized.includes(OPERATIONAL_MEMORY_TAG) && normalized.includes(LOOKUP_FAILURE_TAG);
}

export function isAutobiographicalMemory(
  tags?: string[] | null,
  content?: string | null,
): boolean {
  if (typeof content === "string" && content.trimStart().startsWith("[AUTO-GROUNDING]")) {
    return false;
  }
  return !normalizeTags(tags).includes(OPERATIONAL_MEMORY_TAG);
}