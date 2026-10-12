import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import './test-shared-task-registry-postgres.test';

// Same disposable-gate hard-fail guard as the other Coordinator V2 PostgreSQL
// parity tests (see test-coordinator-v2-schema-postgres.test.ts): a stray
// NEON_SHARED_DATABASE_URL in a developer or shared-Neon process must never
// let this test write real rows, only the gate-provided disposable branch.
// COORDINATOR_V2_TEST_DATABASE_URL (not the ambient NEON_SHARED_DATABASE_URL,
// which is already set in a normal dev shell as the app's own database) is
// checked first, so running this file directly outside the Neon migration
// gate skips cleanly instead of throwing.
function disposableTarget(): string | undefined {
  const url = process.env.COORDINATOR_V2_TEST_DATABASE_URL;
  if (!url) {
    if (process.env.COORDINATOR_V2_REQUIRE_DATABASE_TESTS === '1') {
      throw new Error('COORDINATOR_V2_TEST_DATABASE_URL is required by the migration gate');
    }
    return undefined;
  }
  if (process.env.COORDINATOR_V2_TEST_DATABASE_DISPOSABLE !== '1') {
    throw new Error('COORDINATOR_V2_TEST_DATABASE_DISPOSABLE=1 is required');
  }
  if (process.env.NEON_SHARED_DATABASE_URL !== url) {
    throw new Error('Coordinator V2 task artifact test requires the gate-provided disposable database URL');
  }
  if (url === process.env.COORDINATOR_V2_FORBIDDEN_SHARED_URL) {
    throw new Error('Coordinator V2 task artifact test refuses the shared Neon database');
  }
  return url;
}

// disposableTarget() above must hard-fail -- not silently context.skip() --
// when COORDINATOR_V2_REQUIRE_DATABASE_TESTS='1' but its own URL/DISPOSABLE
// vars are missing while still running inside the gate. Mirror of the "this
// file hard-fails under the gate instead of silently skipping DB coverage"
// check in server/scripts/test-coordination-runtime-postgres-repository.test.ts
// and server/scripts/test-founder-task-ownership-postgres.test.ts.
const OWN_SOURCE = readFileSync(fileURLToPath(import.meta.url), 'utf8');
test('this file hard-fails under the gate instead of silently skipping DB coverage', () => {
  assert.ok(OWN_SOURCE.includes("COORDINATOR_V2_REQUIRE_DATABASE_TESTS === '1'"));
  assert.ok(OWN_SOURCE.includes('COORDINATOR_V2_FORBIDDEN_SHARED_URL'));
  assert.ok(OWN_SOURCE.includes('context.skip('));
});

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

test('Postgres task-artifact transport preserves a registered artifact and refuses revised bytes', async (context) => {
  const url = disposableTarget();
  if (!url) {
    context.skip('run through the Neon migration gate');
    return;
  }

  // The shared drizzle pool this test touches (via the registry/publication
  // service) keeps the event loop alive; without an explicit close, this
  // process never exits once the assertions below finish. See closeDbConnections
  // usage in test-coordination-policy-service.test.ts / test-coordination-session-service.test.ts.
  const { closeDbConnections } = await import('../db');
  try {
    const {
      publishCoordinationTaskArtifact,
      CoordinationTaskArtifactPublicationError,
    } = await import('../services/coordination-task-artifact-publication-service');
    const {
      resolveCoordinationTaskMetadataWithArtifact,
      CoordinationTaskMetadataError,
    } = await import('../services/coordination-task-metadata-service');
    const {
      PostgresCoordinationTaskMetadataRegistry,
    } = await import('../services/coordination-task-metadata-postgres-registry');

    const registry = new PostgresCoordinationTaskMetadataRegistry();
    const taskRef = String(900000 + Math.floor(Math.random() * 99999));

    // No row published yet: resolve() is undefined, readArtifact() fails closed.
    assert.equal(await registry.resolve(taskRef), undefined);
    await assert.rejects(
      () => registry.readArtifact(taskRef),
      (error: unknown) => error instanceof CoordinationTaskMetadataError && error.code === 'TASK_METADATA_UNSUPPORTED',
    );

    const artifactV1 = new TextEncoder().encode('# Task\n\nFirst version of the plan.');
    const metadataV1 = {
      taskRef,
      taskArtifactSha256: sha256(artifactV1),
      repositoryIdentity: 'github:example/repo',
      startingCommit: 'a'.repeat(40),
    };

    // A tampered (mismatched) pair is rejected before it ever reaches the row.
    await assert.rejects(
      () => publishCoordinationTaskArtifact({
        metadata: { ...metadataV1, taskArtifactSha256: 'b'.repeat(64) },
        artifact: artifactV1,
        publishedBy: 'ci-test',
      }),
      (error: unknown) => error instanceof CoordinationTaskArtifactPublicationError
        && error.code === 'TASK_ARTIFACT_PUBLISH_INVALID',
    );
    assert.equal(await registry.resolve(taskRef), undefined, 'rejected publish must not have written a row');

    // The migration gate installs frozen-registry enforcement. A legacy
    // publisher may retry an exact registered artifact, never create an
    // unregistered reference or revise it in place. This is disposable only.
    const { sharedTaskDefinitions } = await import('@shared/schema');
    const { db } = await import('../db');
    await db.insert(sharedTaskDefinitions).values({
      taskRef,repositoryIdentity:metadataV1.repositoryIdentity,startingCommit:metadataV1.startingCommit,
      sourceKind:'legacy',creatorActor:null,sourceThread:null,definition:{provenance:'synthetic CI fixture'},
      artifactBase64:Buffer.from(artifactV1).toString('base64'),artifactSha256:metadataV1.taskArtifactSha256,
    });
    const published = await publishCoordinationTaskArtifact({
      metadata: metadataV1, artifact: artifactV1, publishedBy: 'ci-test',
    });
    assert.equal(published.taskRef, taskRef);
    assert.equal(published.taskArtifactSha256, metadataV1.taskArtifactSha256);

    const resolved = await registry.resolve(taskRef);
    assert.deepEqual(resolved, {
      taskRef,
      taskArtifactSha256: metadataV1.taskArtifactSha256,
      repositoryIdentity: metadataV1.repositoryIdentity,
      startingCommit: metadataV1.startingCommit,
    });
    assert.deepEqual(Buffer.from(await registry.readArtifact(taskRef)), Buffer.from(artifactV1));

    // This is the exact call issueCoordinationV2PreparationEnvelope makes.
    const withArtifact = await resolveCoordinationTaskMetadataWithArtifact(taskRef, registry);
    assert.equal(withArtifact.metadata.taskArtifactSha256, metadataV1.taskArtifactSha256);
    assert.deepEqual(Buffer.from(withArtifact.artifact), Buffer.from(artifactV1));

    // Changed scope moves to a new task/supersedes; same-ref overwrite is forbidden.
    const artifactV2 = new TextEncoder().encode('# Task\n\nRevised plan after review.');
    const metadataV2 = { ...metadataV1, taskArtifactSha256: sha256(artifactV2) };
    await assert.rejects(publishCoordinationTaskArtifact({ metadata: metadataV2, artifact: artifactV2, publishedBy: 'ci-test-2' }),
      (err:any)=>err.code==='TASK_ARTIFACT_PUBLISH_CONFLICT');

    const resolvedV2 = await registry.resolve(taskRef);
    assert.equal(resolvedV2?.taskArtifactSha256, metadataV1.taskArtifactSha256);
    assert.deepEqual(Buffer.from(await registry.readArtifact(taskRef)), Buffer.from(artifactV1));
  } finally {
    await closeDbConnections();
  }
});
