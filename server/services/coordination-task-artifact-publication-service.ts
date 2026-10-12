import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { coordinationV2TaskArtifacts } from '@shared/schema';
import { db } from '../db';
import type { CoordinationTaskMetadata } from './coordination-task-metadata-service';

/**
 * Writes the one durable copy of a task's launch artifact that
 * PostgresCoordinationTaskMetadataRegistry reads back from -- see that
 * class's doc comment in coordination-task-metadata-service.ts for why this
 * table exists at all (short version: `.local/tasks/*.md` is gitignored and
 * never present in a deployed build).
 *
 * This function trusts its `metadata` argument only as far as re-verifying
 * it against the bytes -- the same defense-in-depth
 * `resolveCoordinationTaskMetadataWithArtifact` already applies to a
 * registry's own claims. It does not re-derive repositoryIdentity/
 * startingCommit/taskRef shape from scratch; callers are expected to obtain
 * `metadata` from `FixedRootCoordinationTaskMetadataRegistry.resolve()` (see
 * the `coordination-v2-publish-task-artifact` CLI script), which already
 * enforces clean git provenance, the configured GitHub remote, and a
 * non-symlinked task file under `.local/tasks/`.
 */

const MAX_ARTIFACT_BYTES = 256 * 1024; // must match coordination-v2-preparation-material-service's cap

export class CoordinationTaskArtifactPublicationError extends Error {
  readonly code: 'TASK_ARTIFACT_PUBLISH_INVALID' | 'TASK_ARTIFACT_PUBLISH_DATABASE_UNAVAILABLE' | 'TASK_ARTIFACT_PUBLISH_CONFLICT' | 'TASK_ARTIFACT_REGISTRATION_REQUIRED';
  constructor(code: CoordinationTaskArtifactPublicationError['code']) {
    super(code);
    this.name = 'CoordinationTaskArtifactPublicationError';
    this.code = code;
  }
}

export async function publishCoordinationTaskArtifact(input: {
  metadata: CoordinationTaskMetadata;
  artifact: Uint8Array;
  publishedBy: string;
}): Promise<{ taskRef: string; taskArtifactSha256: string; updatedAt: string }> {
  const { metadata, artifact, publishedBy } = input;
  if (artifact.length === 0 || artifact.length > MAX_ARTIFACT_BYTES) {
    throw new CoordinationTaskArtifactPublicationError('TASK_ARTIFACT_PUBLISH_INVALID');
  }
  if (createHash('sha256').update(artifact).digest('hex') !== metadata.taskArtifactSha256) {
    throw new CoordinationTaskArtifactPublicationError('TASK_ARTIFACT_PUBLISH_INVALID');
  }
  if (typeof publishedBy !== 'string' || publishedBy.trim().length === 0 || publishedBy.length > 128) {
    throw new CoordinationTaskArtifactPublicationError('TASK_ARTIFACT_PUBLISH_INVALID');
  }
  const artifactBase64 = Buffer.from(artifact).toString('base64');
  const now = new Date();
  try {
    const rows = await db.insert(coordinationV2TaskArtifacts).values({
      taskRef: metadata.taskRef,
      artifactBase64,
      taskArtifactSha256: metadata.taskArtifactSha256,
      repositoryIdentity: metadata.repositoryIdentity,
      startingCommit: metadata.startingCommit,
      publishedBy,
      updatedAt: now,
    }).onConflictDoUpdate({
      target: coordinationV2TaskArtifacts.taskRef,
      set: {
        artifactBase64,
        taskArtifactSha256: metadata.taskArtifactSha256,
        repositoryIdentity: metadata.repositoryIdentity,
        startingCommit: metadata.startingCommit,
        publishedBy,
        updatedAt: now,
      },
    }).returning({
      taskRef: coordinationV2TaskArtifacts.taskRef,
      taskArtifactSha256: coordinationV2TaskArtifacts.taskArtifactSha256,
      updatedAt: coordinationV2TaskArtifacts.updatedAt,
    });
    const row = rows[0];
    if (!row) throw new CoordinationTaskArtifactPublicationError('TASK_ARTIFACT_PUBLISH_DATABASE_UNAVAILABLE');
    return { taskRef: row.taskRef, taskArtifactSha256: row.taskArtifactSha256, updatedAt: row.updatedAt.toISOString() };
  } catch (error) {
    if (error instanceof CoordinationTaskArtifactPublicationError) throw error;
    const cause = (error as { cause?: { message?: string }; message?: string });
    const message = cause.cause?.message || cause.message || '';
    if (/TASK_ARTIFACT_FROZEN|TASK_REFERENCE_IMMUTABLE/.test(message)) {
      throw new CoordinationTaskArtifactPublicationError('TASK_ARTIFACT_PUBLISH_CONFLICT');
    }
    if (/TASK_REGISTRY_IMPORT_REQUIRED/.test(message)) {
      throw new CoordinationTaskArtifactPublicationError('TASK_ARTIFACT_REGISTRATION_REQUIRED');
    }
    throw new CoordinationTaskArtifactPublicationError('TASK_ARTIFACT_PUBLISH_DATABASE_UNAVAILABLE');
  }
}

/** Read-only lookup before publication; frozen registered rows cannot be overwritten. */
export async function readCoordinationTaskArtifactPublicationState(taskRef: string): Promise<{
  taskArtifactSha256: string; publishedBy: string; updatedAt: string;
} | undefined> {
  const rows = await db.select({
    taskArtifactSha256: coordinationV2TaskArtifacts.taskArtifactSha256,
    publishedBy: coordinationV2TaskArtifacts.publishedBy,
    updatedAt: coordinationV2TaskArtifacts.updatedAt,
  }).from(coordinationV2TaskArtifacts)
    .where(eq(coordinationV2TaskArtifacts.taskRef, taskRef)).limit(1);
  const row = rows[0];
  return row ? { ...row, updatedAt: row.updatedAt.toISOString() } : undefined;
}
