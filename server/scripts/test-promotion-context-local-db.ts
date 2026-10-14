// This proof NEVER accepts an ambient shared/Neon connection.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import pg from "pg";
import { PgDialect } from "drizzle-orm/pg-core";
import { promotionContextDigest, type PromotionCandidate } from "../services/promotion-candidate";
import { loadPromotionApprovalContexts, insertPromotionApprovalContext, requireVerifiedPromotionContext } from "../services/promotion-approval-context";

const url = process.argv[2];
if (!url || !/^postgresql:\/\/postgres@127\.0\.0\.1:\d+\/ownership_context_disposable$/.test(url)) throw new Error("Explicit loopback disposable target required; ambient DB is forbidden.");
const client = new pg.Client({ connectionString: url });
await client.connect();
const dialect = new PgDialect();
const database = { execute: async (statement: any) => { const q = dialect.sqlToQuery(statement); return client.query(q.sql, q.params); } };
const descriptor: PromotionCandidate = { purpose: "cross-tool-promote", repository: "github:davidwmcintosh/holahola", branch: "fixture/pending", candidateCommit: "a".repeat(40) };
const hash = promotionContextDigest(descriptor);
let checks = 0;
try {
  await client.query("CREATE TABLE public.task_ownership_challenges(id varchar PRIMARY KEY, context_digest varchar, status varchar NOT NULL DEFAULT 'pending', decided_at timestamp)");
  assert.equal((await loadPromotionApprovalContexts([{ id: "fixture", contextDigest: hash }], database)).get("fixture")?.status, "storage_unavailable"); checks++;
  await client.query(await readFile("migrations/0066_ownership_promotion_contexts.sql", "utf8"));
  for (const id of ["valid", "invalid", "later", "approved", "other"]) await client.query("INSERT INTO task_ownership_challenges(id, context_digest) VALUES ($1,$2)", [id, id === "other" ? "b".repeat(64) : hash]);
  await client.query("UPDATE task_ownership_challenges SET status='approved',decided_at=now() WHERE id='approved'");
  assert.equal((await loadPromotionApprovalContexts([{ id: "valid", contextDigest: hash }], database)).get("valid")?.status, "descriptor_missing"); checks++;
  await insertPromotionApprovalContext(database, "valid", hash, descriptor);
  await requireVerifiedPromotionContext({ id: "valid", contextDigest: hash }, database); checks++;
  const rejects = async (sql: string, parameters?: unknown[]) => { await assert.rejects(client.query(sql, parameters)); checks++; };
  await rejects("UPDATE task_ownership_promotion_contexts SET descriptor=descriptor WHERE challenge_id='valid'");
  await rejects("DELETE FROM task_ownership_promotion_contexts WHERE challenge_id='valid'");
  await rejects("TRUNCATE task_ownership_promotion_contexts");
  for (const id of ["approved", "other", "missing"]) await rejects("INSERT INTO task_ownership_promotion_contexts(challenge_id,context_digest,descriptor) VALUES($1,$2,$3::jsonb)", [id, hash, JSON.stringify(descriptor)]);
  for (const bad of [{ ...descriptor, extra: true }, { ...descriptor, branch: "../wrong" }, { ...descriptor, purpose: "other" }, { ...descriptor, candidateCommit: "b".repeat(40) }, { ...descriptor, candidateCommit: 12 }, []]) {
    await rejects("INSERT INTO task_ownership_promotion_contexts(challenge_id,context_digest,descriptor) VALUES('invalid',$1,$2::jsonb)", [hash, JSON.stringify(bad)]);
  }
  await client.query("BEGIN");
  await client.query("INSERT INTO task_ownership_challenges(id,context_digest) VALUES('rollback',$1)", [hash]);
  await assert.rejects(insertPromotionApprovalContext(database, "rollback", hash, { ...descriptor, candidateCommit: "c".repeat(40) })); checks++;
  await client.query("ROLLBACK");
  assert.equal((await client.query("SELECT count(*) FROM task_ownership_challenges WHERE id='rollback'")).rows[0].count, "0"); checks++;
  await client.query("UPDATE task_ownership_challenges SET context_digest=$1 WHERE id='valid'", ["b".repeat(64)]);
  await assert.rejects(requireVerifiedPromotionContext({ id: "valid", contextDigest: hash }, database), /PROMOTION_CONTEXT_REQUIRED/); checks++;
  assert.equal((await client.query("SELECT count(*) FROM task_ownership_promotion_contexts")).rows[0].count, "1"); checks++;
  console.log(JSON.stringify({ localPostgresChecks: checks, sharedDDL: false, neonGate: "NOT_RUN", readyToPromote: false }));
} finally { await client.end(); }
