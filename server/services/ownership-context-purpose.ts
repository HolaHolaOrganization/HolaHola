import { sql } from "drizzle-orm";
import { requireVerifiedPromotionContext, type PromotionBinding } from "./promotion-approval-context";

export type OwnershipPurpose = "ownership" | "runtime_provisioning" | "source_promotion";
type Executor = { execute(statement: any): Promise<any> };
function failure(code: string): never {
  throw Object.assign(new Error(code), { code });
}

export function checkedOwnershipPurpose(purpose: unknown, contextDigest: unknown): OwnershipPurpose {
  if ((purpose === "ownership" || purpose == null) && contextDigest == null) return "ownership";
  if ((purpose === "runtime_provisioning" || purpose === "source_promotion") &&
      typeof contextDigest === "string" && /^[a-f0-9]{64}$/.test(contextDigest)) return purpose;
  // A legacy digest has no trustworthy purpose. Never infer it from task IDs
  // or from the absence of a promotion-context row.
  return failure("OWNERSHIP_PURPOSE_INVALID");
}

/** Receipts inherit immutable intent from their exact parent challenge. */
export async function requireOwnershipContext(
  binding: PromotionBinding,
  database: Executor,
  expectedPurpose?: OwnershipPurpose,
): Promise<OwnershipPurpose> {
  const result = await database.execute(sql`
    SELECT purpose, context_digest FROM public.task_ownership_challenges
    WHERE id = ${binding.id}
  `);
  const rows: any[] = Array.isArray(result) ? result : result.rows;
  const row = rows[0];
  if (!row || (row.context_digest ?? null) !== (binding.contextDigest ?? null)) {
    failure("OWNERSHIP_CONTEXT_MISMATCH");
  }
  const purpose = checkedOwnershipPurpose(row.purpose, row.context_digest);
  if (expectedPurpose && purpose !== expectedPurpose) failure("OWNERSHIP_PURPOSE_MISMATCH");
  if (purpose === "source_promotion") await requireVerifiedPromotionContext(binding, database);
  return purpose;
}
