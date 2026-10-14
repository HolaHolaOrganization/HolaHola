import type { ApprovalPromotionDescriptor, PromotionApprovalContext } from "@shared/promotion-approval-context";
import { promotionContextDigest, validatePromotionCandidate } from "./promotion-candidate";

export type PromotionBinding = { id: string; contextDigest?: string | null };
export type StoredPromotionContext = {
  challenge_id: string; context_digest: string; parent_context_digest: string | null;
  descriptor: unknown;
};
type Executor = { execute(statement: any): Promise<any> };
const rowsOf = (result: any): any[] => Array.isArray(result) ? result : result.rows;

export function checkedPromotionDescriptor(value: unknown, contextDigest: unknown): ApprovalPromotionDescriptor {
  try { validatePromotionCandidate(value); }
  catch { throw new Error("PROMOTION_DESCRIPTOR_INVALID"); }
  const descriptor = value as ApprovalPromotionDescriptor;
  if (typeof contextDigest !== "string" || !/^[a-f0-9]{64}$/.test(contextDigest) ||
      promotionContextDigest(descriptor) !== contextDigest) throw new Error("PROMOTION_CONTEXT_MISMATCH");
  return { purpose: descriptor.purpose, repository: descriptor.repository, branch: descriptor.branch, candidateCommit: descriptor.candidateCommit };
}

export function projectPromotionApprovalContext(
  binding: PromotionBinding,
  storageAvailable: boolean,
  row?: StoredPromotionContext,
): PromotionApprovalContext {
  if (binding.contextDigest == null) return { status: "context_free", contextDigest: null };
  const base = { contextDigest: binding.contextDigest };
  if (!storageAvailable) return { ...base, status: "storage_unavailable" };
  if (!row) return { ...base, status: "descriptor_missing" };
  if (row.challenge_id !== binding.id || row.context_digest !== binding.contextDigest ||
      row.parent_context_digest !== binding.contextDigest) return { ...base, status: "hash_mismatch" };
  try {
    const descriptor = checkedPromotionDescriptor(row.descriptor, binding.contextDigest);
    return { ...base, status: "verified", computedDigest: promotionContextDigest(descriptor), descriptor };
  } catch {
    return { ...base, status: "invalid" };
  }
}

/** Catalog SELECT distinguishes absent storage from a present table's missing row. */
export async function loadPromotionApprovalContexts(bindings: PromotionBinding[], provided?: Executor) {
  const needed = bindings.filter(binding => binding.contextDigest != null);
  const result = new Map<string, PromotionApprovalContext>();
  const add = (available: boolean, records: StoredPromotionContext[] = []) => {
    const indexed = new Map(records.map(row => [row.challenge_id, row]));
    for (const binding of bindings) result.set(binding.id, projectPromotionApprovalContext(binding, available, indexed.get(binding.id)));
    return result;
  };
  if (!needed.length) return add(true);
  try {
    const database = provided ?? (await import("../db")).db;
    const { sql } = await import("drizzle-orm");
    const catalog = rowsOf(await database.execute(sql`SELECT to_regclass('public.task_ownership_promotion_contexts') AS relation`));
    if (!catalog[0]?.relation) return add(false);
    const ids = needed.map(binding => binding.id);
    const records = rowsOf(await database.execute(sql`
      SELECT p.challenge_id, p.context_digest, p.descriptor, c.context_digest AS parent_context_digest
      FROM public.task_ownership_promotion_contexts p
      JOIN public.task_ownership_challenges c ON c.id = p.challenge_id
      WHERE p.challenge_id IN (${sql.join(ids.map(id => sql`${id}`), sql`, `)})
    `));
    return add(true, records);
  } catch {
    return add(false);
  }
}

export async function requireVerifiedPromotionContext(binding: PromotionBinding, database?: Executor) {
  if (binding.contextDigest == null) return;
  const context = (await loadPromotionApprovalContexts([binding], database)).get(binding.id)!;
  if (context.status !== "verified") {
    throw new Error(context.status === "storage_unavailable" ? "PROMOTION_CONTEXT_UNAVAILABLE" : "PROMOTION_CONTEXT_REQUIRED");
  }
}

export async function insertPromotionApprovalContext(
  database: Executor, challengeId: string, contextDigest: string, descriptor: ApprovalPromotionDescriptor,
) {
  const { sql } = await import("drizzle-orm");
  const catalog = rowsOf(await database.execute(sql`SELECT to_regclass('public.task_ownership_promotion_contexts') AS relation`));
  if (!catalog[0]?.relation) throw new Error("PROMOTION_CONTEXT_UNAVAILABLE");
  await database.execute(sql`INSERT INTO public.task_ownership_promotion_contexts(challenge_id, context_digest, descriptor)
    VALUES (${challengeId}, ${contextDigest}, ${JSON.stringify(descriptor)}::jsonb)`);
}
