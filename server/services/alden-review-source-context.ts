import { parseAldenReviewContext, safeAldenReviewReferences } from "./alden-review-source";

/** Read only server-persisted references. Never infer them from caller/model prose. */
export async function loadAldenReviewSourceReferences(engine: "anthropic" | "gemini", conversationId?: string) {
  const { getSharedDb } = await import("../db");
  const { aldenConversations, aldenMessages } = await import("@shared/schema");
  const { and, desc, eq, gt, inArray, isNull } = await import("drizzle-orm");
  const db = getSharedDb();
  let id = conversationId;
  if (!id) {
    const [active] = await db.select({ id: aldenConversations.id }).from(aldenConversations)
      .where(and(isNull(aldenConversations.endedAt), gt(aldenConversations.startedAt, new Date(Date.now() - 4 * 60 * 60 * 1000))))
      .orderBy(desc(aldenConversations.startedAt)).limit(1);
    id = active?.id;
  }
  if (!id) return [];
  const rows = await db.select({ context: aldenMessages.context }).from(aldenMessages)
    .where(and(eq(aldenMessages.conversationId, id), inArray(aldenMessages.role, ["alden", `alden-${engine}`])))
    .orderBy(desc(aldenMessages.createdAt)).limit(12);
  return safeAldenReviewReferences(rows.flatMap(row => parseAldenReviewContext(row.context, engine)));
}
