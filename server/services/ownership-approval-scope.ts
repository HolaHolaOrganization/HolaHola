import { createHash } from "node:crypto";
import type { OwnershipApprovalScope } from "@shared/task-ownership-scope";
import type { RegistryTask } from "./shared-task-registry-service";
import { TASK_ARTIFACT_LIMIT, TaskRegistryError } from "./shared-task-registry-contract";

type ChallengeBinding = { taskRef: string; artifactSha256: string };
export type OwnershipRegistryLookup =
  | { kind: "found"; task: RegistryTask }
  | { kind: "missing"; bootstrapReserved: boolean }
  | { kind: "unavailable" };
export type OwnershipRegistryReader = (taskRef: string) => Promise<OwnershipRegistryLookup>;

const hashPattern = /^[a-f0-9]{64}$/;
const threadPattern = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const recordedText = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0 &&
  value.length <= TASK_ARTIFACT_LIMIT && !value.includes("\0");
const recordedList = (value: unknown): value is string[] =>
  Array.isArray(value) && value.length <= 64 && value.every(recordedText);

/** Registry metadata is evidence about an artifact, never an ownership grant. */
export function projectOwnershipApprovalScope(
  challenge: ChallengeBinding,
  lookup: OwnershipRegistryLookup,
): OwnershipApprovalScope {
  const base = {
    taskRef: challenge.taskRef,
    submittedArtifactSha256: challenge.artifactSha256,
    artifactHashMatch: null,
  };
  if (lookup.kind === "unavailable") return { ...base, status: "registry_unavailable" };
  if (lookup.kind === "missing") {
    return { ...base, status: lookup.bootstrapReserved ? "unregistered_bootstrap" : "missing_registry" };
  }
  const row = lookup.task;
  const invalid = (): OwnershipApprovalScope => ({ ...base, status: "registry_invalid" });
  if (row.task_ref !== challenge.taskRef || !hashPattern.test(row.artifact_sha256) ||
      typeof row.artifact_base64 !== "string" ||
      row.artifact_base64.length > Math.ceil(TASK_ARTIFACT_LIMIT / 3) * 4) return invalid();
  const bytes = Buffer.from(row.artifact_base64, "base64");
  if (!bytes.length || bytes.length > TASK_ARTIFACT_LIMIT ||
      bytes.toString("base64") !== row.artifact_base64 ||
      !Buffer.from(bytes.toString("utf8"), "utf8").equals(bytes) ||
      createHash("sha256").update(bytes).digest("hex") !== row.artifact_sha256) return invalid();

  const matched = row.artifact_sha256 === challenge.artifactSha256;
  const bound = { ...base, registeredArtifactSha256: row.artifact_sha256, artifactHashMatch: matched };
  if (!matched) return { ...bound, status: "hash_mismatch" };
  const definition = row.definition as Record<string, unknown> | null;
  if (!definition || typeof definition !== "object" || Array.isArray(definition) ||
      !recordedText(definition.title) || !recordedText(definition.purpose) ||
      !recordedList(definition.scope) || !recordedList(definition.exclusions) ||
      !recordedText(row.creator_actor) || !recordedText(row.source_thread) ||
      !threadPattern.test(row.source_thread) || row.source_kind === "legacy" ||
      !["hat", "replit", "bootstrap"].includes(row.source_kind) ||
      !recordedText(row.repository_identity) ||
      !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(row.starting_commit)) {
    return { ...bound, status: "metadata_unavailable" };
  }
  // Do not pass through external platform/publisher claims as authenticated authors.
  return {
    ...bound,
    status: "verified",
    definition: {
      title: definition.title,
      purpose: definition.purpose,
      scope: [...definition.scope],
      exclusions: [...definition.exclusions],
      creatorActor: row.creator_actor,
      sourceThread: row.source_thread,
      sourceKind: row.source_kind,
      repositoryIdentity: row.repository_identity,
      startingCommit: row.starting_commit,
    },
  };
}

/** Existing project-scoped registry contract only; no initialization or writes. */
export async function readOwnershipRegistryTask(taskRef: string): Promise<OwnershipRegistryLookup> {
  const repository = process.env.COORDINATION_V2_REPOSITORY_IDENTITY ||
    (process.env.SHARED_SPEC_GITHUB_REPOSITORY ? `github:${process.env.SHARED_SPEC_GITHUB_REPOSITORY}` : "");
  if (!repository) return { kind: "unavailable" };
  try {
    const { productionTaskRegistry } = await import("./shared-task-registry-service");
    return { kind: "found", task: await productionTaskRegistry(repository).show(taskRef) };
  } catch (error) {
    if (!(error instanceof TaskRegistryError) || error.code !== "TASK_NOT_FOUND") {
      return { kind: "unavailable" };
    }
    try {
      const { getSharedDb } = await import("../db");
      const { sql } = await import("drizzle-orm");
      const result = await getSharedDb().execute(sql`
        SELECT task_ref FROM shared_task_reservations WHERE task_ref = ${taskRef} LIMIT 1
      `);
      const rows = Array.isArray(result) ? result : result.rows;
      return { kind: "missing", bootstrapReserved: rows.length > 0 };
    } catch {
      return { kind: "unavailable" };
    }
  }
}

/** Dedupe and bound registry I/O; challenge/receipt states are left untouched. */
export async function enrichOwnershipApprovalScopes<T extends ChallengeBinding>(
  challenges: T[],
  read: OwnershipRegistryReader = readOwnershipRegistryTask,
): Promise<Array<T & { scopeContext: OwnershipApprovalScope }>> {
  const lookups = new Map<string, OwnershipRegistryLookup>();
  const references = [...new Set(challenges.map(item => item.taskRef))];
  for (let offset = 0; offset < references.length; offset += 4) {
    await Promise.all(references.slice(offset, offset + 4).map(async ref => {
      try { lookups.set(ref, await read(ref)); }
      catch { lookups.set(ref, { kind: "unavailable" }); }
    }));
  }
  return challenges.map(challenge => ({
    ...challenge,
    scopeContext: projectOwnershipApprovalScope(challenge, lookups.get(challenge.taskRef)!),
  }));
}
