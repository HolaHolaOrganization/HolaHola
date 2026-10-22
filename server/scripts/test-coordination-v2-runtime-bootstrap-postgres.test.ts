import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { generateKeyPairSync, randomUUID, sign, verify } from "node:crypto";
import { canonicalJson } from "../services/coordination-policy-canonicalization";
import { runtimeEvidenceDigest } from "../services/coordination-v2-runtime-evidence-canonicalization";

// COORDINATOR_V2_TEST_DATABASE_URL (not the ambient NEON_SHARED_DATABASE_URL,
// which is already set in a normal dev shell as the app's own database) is
// checked first, so running this file directly outside the Neon migration
// gate skips cleanly instead of throwing.
function disposableTarget(): string | undefined {
  const url = process.env.COORDINATOR_V2_TEST_DATABASE_URL;
  const required = process.env.COORDINATOR_V2_REQUIRE_DATABASE_TESTS === "1";
  const sharedUrl = process.env.NEON_SHARED_DATABASE_URL;
  const forbiddenShared = process.env.COORDINATOR_V2_FORBIDDEN_SHARED_URL;

  if (!url) {
    if (required) {
      throw new Error("COORDINATOR_V2_TEST_DATABASE_URL is required by the migration gate");
    }
    return undefined;
  }
  if (process.env.COORDINATOR_V2_TEST_DATABASE_DISPOSABLE !== "1") {
    throw new Error("COORDINATOR_V2_TEST_DATABASE_DISPOSABLE=1 is required");
  }
  if (!sharedUrl || sharedUrl !== url) {
    throw new Error("Coordinator V2 runtime bootstrap test requires the gate-provided disposable database URL");
  }
  if (!forbiddenShared || url === forbiddenShared) {
    throw new Error("Coordinator V2 runtime bootstrap test refuses the shared Neon database");
  }
  return url;
}

// disposableTarget() above must hard-fail -- not silently context.skip() --
// when COORDINATOR_V2_REQUIRE_DATABASE_TESTS='1' but its own URL/DISPOSABLE
// vars are missing while still running inside the gate. Mirror of the "this
// file hard-fails under the gate instead of silently skipping DB coverage"
// check in server/scripts/test-coordination-runtime-postgres-repository.test.ts
// and server/scripts/test-founder-task-ownership-postgres.test.ts.
const OWN_SOURCE = readFileSync(fileURLToPath(import.meta.url), "utf8");
test("this file hard-fails under the gate instead of silently skipping DB coverage", () => {
  assert.ok(OWN_SOURCE.includes('COORDINATOR_V2_REQUIRE_DATABASE_TESTS === "1"'));
  assert.ok(OWN_SOURCE.includes("COORDINATOR_V2_FORBIDDEN_SHARED_URL"));
  assert.ok(OWN_SOURCE.includes("context.skip("));
});

function digest(character: string): string {
  assert.match(character, /^[0-9a-f]$/, "fixture digest seed must be lowercase hexadecimal");
  return character.repeat(64);
}

async function expectCode(
  client: pg.Client,
  savepoint: string,
  action: () => Promise<unknown>,
  code: string,
): Promise<void> {
  await client.query(`SAVEPOINT ${savepoint}`);
  try {
    await assert.rejects(action(), (error: unknown) => (error as { code?: string })?.code === code);
  } finally {
    await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
    await client.query(`RELEASE SAVEPOINT ${savepoint}`);
  }
}

type RuntimeReleaseRow = {
  id: string;
  protocolVersion: number;
  sourcePromotionId: string;
  repositoryIdentity: string;
  promotedCommitSha: string;
  exactTreeSha: string;
  publicationReference: string;
  protectedValidationId: string;
  sourcePromotionRecordDigest: string;
  releaseDigest: string;
  manifestTemplateDigest: string;
  nodeVersion: string;
  nodeReleaseKeyringCommit: string;
  nodeReleaseKeyringDigest: string;
  nodeShasumsDigest: string;
  nodeSignatureDigest: string;
  nodeSignerFingerprint: string;
  lockfileDigest: string;
  runtimeClosureDigest: string;
  provenanceDigest: string;
  sourceMembers: Array<{ fixedPath: string; sha256: string }>;
};

async function insertRelease(client: pg.Client, release: RuntimeReleaseRow): Promise<void> {
  await client.query(
    `INSERT INTO coordination_v2_runtime_releases
       (id, protocol_version, source_promotion_id, repository_identity,
        promoted_commit_sha, exact_tree_sha, publication_reference,
        protected_validation_id, source_promotion_record_digest, release_digest,
        manifest_template_digest, node_version, node_release_keyring_commit,
        node_release_keyring_digest, node_shasums_digest, node_signature_digest,
        node_signer_fingerprint, lockfile_digest, runtime_closure_digest,
        provenance_digest, source_members, published_at)
     VALUES
       ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
        $15, $16, $17, $18, $19, $20, $21::jsonb, now())`,
    [
      release.id,
      release.protocolVersion,
      release.sourcePromotionId,
      release.repositoryIdentity,
      release.promotedCommitSha,
      release.exactTreeSha,
      release.publicationReference,
      release.protectedValidationId,
      release.sourcePromotionRecordDigest,
      release.releaseDigest,
      release.manifestTemplateDigest,
      release.nodeVersion,
      release.nodeReleaseKeyringCommit,
      release.nodeReleaseKeyringDigest,
      release.nodeShasumsDigest,
      release.nodeSignatureDigest,
      release.nodeSignerFingerprint,
      release.lockfileDigest,
      release.runtimeClosureDigest,
      release.provenanceDigest,
      JSON.stringify(release.sourceMembers),
    ],
  );
}

function releaseFixture(id: string, sourcePromotionId: string, seed: string): RuntimeReleaseRow {
  const sourceMembers = [
    { fixedPath: "launcher/verify-runtime.mjs", sha256: digest(seed) },
    { fixedPath: "launcher/runtime-bootstrap.ps1", sha256: digest(seed === "f" ? "0" : "f") },
    { fixedPath: "coordinator/cli.mjs", sha256: digest(seed === "e" ? "1" : "e") },
  ];
  return {
    id,
    protocolVersion: 1,
    sourcePromotionId,
    repositoryIdentity: "github.com/holahola/holahola",
    promotedCommitSha: "1".repeat(40),
    exactTreeSha: "2".repeat(40),
    publicationReference: `runtime-bootstrap-publication-${id}`,
    protectedValidationId: `runtime-bootstrap-validation-${id}`,
    sourcePromotionRecordDigest: digest("a"),
    releaseDigest: digest(seed),
    manifestTemplateDigest: digest("b"),
    nodeVersion: "v22.14.0",
    nodeReleaseKeyringCommit: "3".repeat(40),
    nodeReleaseKeyringDigest: digest("c"),
    nodeShasumsDigest: digest("d"),
    nodeSignatureDigest: digest("e"),
    nodeSignerFingerprint: "ABCDEF0123456789ABCDEF0123456789ABCDEF01",
    lockfileDigest: digest("f"),
    runtimeClosureDigest: digest("0"),
    provenanceDigest: digest("1"),
    sourceMembers,
  };
}

async function insertHost(client: pg.Client, id: string, ordinal: string): Promise<void> {
  const fingerprintSeed = ordinal === "one" ? "2" : ordinal === "lineage" ? "3" : "6";
  const enrollmentSeed = ordinal === "one" ? "4" : ordinal === "lineage" ? "5" : "7";
  await client.query(
    `INSERT INTO coordination_v2_host_enrollments
       (id, host_key, host_type, display_name, protocol_version, public_key,
        key_fingerprint, capabilities, enrollment_digest, enrollment_request_key,
        status, created_by)
     VALUES ($1, $2, 'windows', $3, 1, $4, $5, ARRAY['runtime_bootstrap'],
        $6, $7, 'active', 'runtime-bootstrap-postgres-test')`,
    [
      id,
      `runtime-bootstrap-host-key-${ordinal}`,
      `Runtime bootstrap disposable host ${ordinal}`,
      `runtime-bootstrap-public-key-${ordinal}`,
      digest(fingerprintSeed),
      digest(enrollmentSeed),
      `runtime-bootstrap-enrollment-request-${ordinal}`,
    ],
  );
}

async function insertIssue(
  client: pg.Client,
  issueId: string,
  hostId: string,
  releaseId: string,
  requestKey: string,
  manifestDigest: string,
): Promise<void> {
  await client.query(
    `INSERT INTO coordination_v2_runtime_bootstrap_issues
       (id, host_enrollment_id, runtime_release_id, request_key,
        request_digest, manifest_digest, issued_at, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, now(), now() + interval '4 minutes')`,
    [issueId, hostId, releaseId, requestKey, digest("6"), manifestDigest],
  );
}

async function insertAcknowledgement(
  client: pg.Client,
  acknowledgementId: string,
  hostId: string,
  releaseId: string,
  issueId: string,
  requestKey: string,
  manifestDigest: string,
): Promise<void> {
  await client.query(
    `INSERT INTO coordination_v2_runtime_bootstrap_acknowledgements
       (id, host_enrollment_id, runtime_release_id, issue_id, request_key,
        manifest_digest, local_evidence_digest, acknowledgement_digest,
        host_signature_digest, acknowledged_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now())`,
    [
      acknowledgementId,
      hostId,
      releaseId,
      issueId,
      requestKey,
      manifestDigest,
      digest("7"),
      digest("8"),
      digest("9"),
    ],
  );
}

async function insertRevocation(
  client: pg.Client,
  revocationId: string,
  releaseId: string,
  requestKey: string,
): Promise<void> {
  await client.query(
    `INSERT INTO coordination_v2_runtime_release_revocations
       (id, runtime_release_id, request_key, reason_code, revoked_by,
        revoked_at, canonical_record_digest)
     VALUES ($1, $2, $3, 'TEST_REVOCATION', 'runtime-bootstrap-test', now(), $4)`,
    [revocationId, releaseId, requestKey, digest("a")],
  );
}

test("runtime manifests survive a real PostgreSQL round trip without changing historical evidence", async (context) => {
  if (!disposableTarget()) {
    context.skip("run through the disposable Coordinator V2 database gate");
    return;
  }
  // Import the DB-touching service only AFTER proving the disposable target.
  const { db, closeDbConnections } = await import("../db");
  const runtime = await import("../services/coordination-v2-runtime-bootstrap-service");
  const keys = generateKeyPairSync("ed25519");
  const hostKeys = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const previousSigningKey = process.env.COORDINATION_V2_SERVER_SIGNING_PRIVATE_KEY;
  process.env.COORDINATION_V2_SERVER_SIGNING_PRIVATE_KEY =
    keys.privateKey.export({ format: "pem", type: "pkcs8" }).toString();
  const originalTransaction = db.transaction;
  const originalExecute = db.execute;
  const rollback = new Error("synthetic runtime fixture rollback");
  try {
    await originalTransaction.call(db, async (tx) => {
      // Keep service calls on the actual driver's transaction: all fixtures,
      // including service-created issues, disappear in ONE final rollback.
      const client = (tx as unknown as { session: { client: pg.Client } }).session.client;
      const sourceId = randomUUID(), hostId = randomUUID(), releaseId = randomUUID();
      await client.query(
        `INSERT INTO coordination_v2_source_promotions
          (id, repository_identity, promoted_commit_sha, exact_tree_sha,
           publication_reference, protected_validation_id, canonical_record_digest,
           operation_receipt_digest, operation_receipt_reference, created_at)
         VALUES ($1, 'github.com/holahola/holahola', $2, $3, $4, $5, $6, $7, $8,
           now() + interval '1 day')`,
        [sourceId, "1".repeat(40), "2".repeat(40), randomUUID(), randomUUID(),
          digest("c"), digest("d"), randomUUID()],
      );
      await client.query(
        `INSERT INTO coordination_v2_host_enrollments
          (id, host_key, host_type, display_name, protocol_version, public_key,
           key_fingerprint, capabilities, enrollment_digest, enrollment_request_key,
           status, created_by)
         VALUES ($1, $2, 'windows', 'Synthetic timestamp host', 1, $3, $4,
           ARRAY['runtime_bootstrap'], $5, $6, 'active', 'runtime-timestamp-test')`,
        [hostId, randomUUID(), JSON.stringify(hostKeys.publicKey.export({ format: "jwk" })),
          digest("2"), digest("4"), randomUUID()],
      );
      await insertRelease(client, {
        ...releaseFixture(releaseId, sourceId, "e"),
        sourceMembers: runtime.RUNTIME_SOURCE_MEMBER_PATHS.map((fixedPath) => ({
          fixedPath, sha256: digest("d"),
        })),
      });
      const artifactId = randomUUID();
      await client.query(
        `INSERT INTO coordination_v2_runtime_release_artifacts
          (id, runtime_release_id, role, fixed_destination, object_key,
           object_digest, byte_length, media_type, requires_authenticode)
         VALUES ($1, $2, 'node_executable', 'runtime/node.exe', $3, $4, 4,
           'application/vnd.microsoft.portable-executable', TRUE)`,
        [artifactId, releaseId, `coordination-v2/runtime/${digest("2")}/node.exe`, digest("2")],
      );
      Object.defineProperty(db, "transaction", {
        value: (callback: Parameters<typeof db.transaction>[0]) => callback(tx),
        configurable: true, writable: true,
      });
      Object.defineProperty(db, "execute", {
        value: tx.execute.bind(tx), configurable: true, writable: true,
      });
      const now = new Date();
      now.setUTCMilliseconds(191);
      const freshKey = randomUUID();
      const fresh = await runtime.issueCoordinationV2RuntimeBootstrapManifest({
        hostEnrollmentId: hostId, requestKey: freshKey, protocolVersion: 1, now,
      });
      const replayFresh = await runtime.issueCoordinationV2RuntimeBootstrapManifest({
        hostEnrollmentId: hostId, requestKey: freshKey, protocolVersion: 1, now,
      });
      assert.equal(fresh.created, true);
      assert.equal(replayFresh.created, false);
      assert.deepEqual(replayFresh.payload, fresh.payload);
      assert.equal(replayFresh.canonicalResponseDigest, fresh.canonicalResponseDigest);
      assert.equal(new Date(fresh.payload.issuedAt).getUTCMilliseconds(), 191);
      assert.equal(verify(null, Buffer.from(canonicalJson(replayFresh.payload)), keys.publicKey,
        Buffer.from(replayFresh.signature, "base64")), true);
      await assert.rejects(runtime.issueCoordinationV2RuntimeBootstrapManifest({
        hostEnrollmentId: hostId, requestKey: randomUUID(), protocolVersion: 1, now: new Date(NaN),
      }), (error: unknown) => error instanceof runtime.CoordinationV2RuntimeError &&
        error.code === "V2_RUNTIME_DATABASE_UNAVAILABLE");

      const legacyKey = randomUUID(), legacyId = randomUUID();
      const issued = new Date(String(new Date(fresh.payload.issuedAt))).toISOString();
      const expires = new Date(String(new Date(fresh.payload.expiresAt))).toISOString();
      const requestDigest = (key: string) => runtimeEvidenceDigest(key);
      const legacyPayload = {
        ...fresh.payload, issueId: legacyId, requestKeyDigest: requestDigest(legacyKey),
        issuedAt: issued, expiresAt: expires,
        nonce: runtimeEvidenceDigest({ issueId: legacyId, releaseDigest: digest("e"), host: hostId }),
      };
      const legacyDigest = runtimeEvidenceDigest(legacyPayload);
      const insertSyntheticIssue = (id: string, key: string, stored: string) => client.query(
        `INSERT INTO coordination_v2_runtime_bootstrap_issues
          (id, host_enrollment_id, runtime_release_id, request_key, request_digest,
           manifest_digest, issued_at, expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        // Date values, not ISO strings: issued_at/expires_at are timestamp WITHOUT time zone,
        // and node-postgres reads them back as local time. An ISO "Z" string would be stored
        // as UTC wall-clock and then re-read as local, shifting the instant by the process
        // timezone offset on any non-UTC host. A Date round-trips in every timezone.
        [id, hostId, releaseId, key, requestDigest(key), stored,
          new Date(fresh.payload.issuedAt), new Date(fresh.payload.expiresAt)],
      );
      await insertSyntheticIssue(legacyId, legacyKey, legacyDigest);
      const snapshot = () => client.query(
        `SELECT * FROM coordination_v2_runtime_bootstrap_issues
          WHERE host_enrollment_id=$1 ORDER BY id`, [hostId],
      ).then((result) => result.rows);
      const before = await snapshot();
      for (let attempt = 0; attempt < 2; attempt++) {
        const replay = await runtime.issueCoordinationV2RuntimeBootstrapManifest({
          hostEnrollmentId: hostId, requestKey: legacyKey, protocolVersion: 1, now,
        });
        assert.equal(replay.created, false);
        assert.deepEqual(replay.payload, legacyPayload);
        assert.equal(replay.canonicalResponseDigest, legacyDigest);
        assert.equal(verify(null, Buffer.from(canonicalJson(replay.payload)), keys.publicKey,
          Buffer.from(replay.signature, "base64")), true);
      }
      assert.deepEqual(await snapshot(), before, "replay must not rewrite or append evidence");

      const expiredNow = new Date(new Date(fresh.payload.expiresAt).getTime() + 1);
      const expiredCode = (error: unknown) => error instanceof runtime.CoordinationV2RuntimeError &&
        error.code === "V2_RUNTIME_ISSUE_EXPIRED";
      await assert.rejects(runtime.openCoordinationV2RuntimeArtifact({
        hostEnrollmentId: hostId, issueId: legacyId, artifactId, now: expiredNow,
      }), expiredCode);
      const ackPayload = {
        protocolVersion: 1, issueId: legacyId, requestKey: legacyKey,
        runtimeReleaseId: releaseId, manifestDigest: legacyDigest, localEvidenceDigest: digest("8"),
      };
      const ackSignature = sign("RSA-SHA256", Buffer.from(canonicalJson(ackPayload)),
        hostKeys.privateKey).toString("base64");
      await assert.rejects(runtime.acknowledgeCoordinationV2RuntimeBootstrap({
        hostEnrollmentId: hostId, issueId: legacyId, payload: ackPayload,
        signature: ackSignature, now: expiredNow,
      }), expiredCode);
      await assert.rejects(runtime.acknowledgeCoordinationV2RuntimeBootstrap({
        hostEnrollmentId: hostId, issueId: legacyId, payload: ackPayload,
        signature: Buffer.from("wrong-signature").toString("base64"), now,
      }), (error: unknown) => error instanceof runtime.CoordinationV2RuntimeError &&
        error.code === "V2_RUNTIME_ACK_SIGNATURE_INVALID");
      assert.deepEqual(await snapshot(), before);

      // Response lost after commit: exact successor replay is a distinct issue,
      // never renewal or mutation of the expired original.
      const successorKey = randomUUID();
      const successor = await runtime.issueCoordinationV2RuntimeBootstrapManifest({
        hostEnrollmentId: hostId, requestKey: successorKey, protocolVersion: 1, now: expiredNow,
      });
      const successorReplay = await runtime.issueCoordinationV2RuntimeBootstrapManifest({
        hostEnrollmentId: hostId, requestKey: successorKey, protocolVersion: 1, now: expiredNow,
      });
      assert.equal(successor.created, true);
      assert.equal(successorReplay.created, false);
      assert.deepEqual(successorReplay.payload, successor.payload);
      assert.notEqual(successor.issueId, legacyId);
      assert.equal(new Date(successor.payload.expiresAt).getTime() - expiredNow.getTime(), 300_000);
      assert.equal(verify(null, Buffer.from(canonicalJson(successorReplay.payload)), keys.publicKey,
        Buffer.from(successorReplay.signature, "base64")), true);
      const withSuccessor = await snapshot();
      assert.deepEqual(withSuccessor.filter((row) => row.id !== successor.issueId), before);
      assert.equal(withSuccessor.filter((row) => row.request_key === successorKey).length, 1);
      const expiredReplay = await runtime.issueCoordinationV2RuntimeBootstrapManifest({
        hostEnrollmentId: hostId, requestKey: legacyKey, protocolVersion: 1, now: expiredNow,
      });
      assert.deepEqual(expiredReplay.payload, legacyPayload);
      assert.deepEqual(await snapshot(), withSuccessor);
      await assert.rejects(runtime.openCoordinationV2RuntimeArtifact({
        hostEnrollmentId: hostId, issueId: legacyId, artifactId, now: expiredNow,
      }), expiredCode);
      await assert.rejects(runtime.acknowledgeCoordinationV2RuntimeBootstrap({
        hostEnrollmentId: hostId, issueId: legacyId, payload: ackPayload,
        signature: ackSignature, now: expiredNow,
      }), expiredCode);

      for (const field of ["hostKeyFingerprint", "runtimeReleaseDigest", "requestKeyDigest"]) {
        const badId = randomUUID(), badKey = randomUUID();
        const badPayload = {
          ...legacyPayload, issueId: badId, requestKeyDigest: requestDigest(badKey),
          nonce: runtimeEvidenceDigest({ issueId: badId, releaseDigest: digest("e"), host: hostId }),
          [field]: digest("f"),
        };
        await insertSyntheticIssue(badId, badKey, runtimeEvidenceDigest(badPayload));
        const badBefore = await snapshot();
        await assert.rejects(runtime.issueCoordinationV2RuntimeBootstrapManifest({
          hostEnrollmentId: hostId, requestKey: badKey, protocolVersion: 1, now,
        }), (error: unknown) => error instanceof runtime.CoordinationV2RuntimeError &&
          error.code === "V2_RUNTIME_EVIDENCE_INVALID");
        assert.deepEqual(await snapshot(), badBefore);
      }
      throw rollback;
    });
  } catch (error) {
    if (error !== rollback) throw error;
  } finally {
    Object.defineProperty(db, "transaction", { value: originalTransaction, configurable: true, writable: true });
    Object.defineProperty(db, "execute", { value: originalExecute, configurable: true, writable: true });
    if (previousSigningKey === undefined) delete process.env.COORDINATION_V2_SERVER_SIGNING_PRIVATE_KEY;
    else process.env.COORDINATION_V2_SERVER_SIGNING_PRIVATE_KEY = previousSigningKey;
    await closeDbConnections();
  }
});

test("Coordinator V2 runtime bootstrap PostgreSQL evidence is lineage-bound and append-only", async (context) => {
  const url = disposableTarget();
  if (!url) {
    context.skip("run through the Neon migration gate");
    return;
  }

  const client = new pg.Client({ connectionString: url });
  let connected = false;
  let transactionStarted = false;
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 100000)}`;
  const id = (kind: string) => `runtime-bootstrap-${kind}-${suffix}`;
  const sourcePromotionId = id("source-promotion");
  const hostId = id("host-one");
  const releaseId = id("release-one");
  const issueId = id("issue-one");
  const requestKey = id("issue-request-one");
  const manifestDigest = digest("b");
  const acknowledgementId = id("ack-one");
  const revocationId = id("revocation-one");

  try {
    await client.connect();
    connected = true;
    await client.query("BEGIN");
    transactionStarted = true;
    await client.query(
      `INSERT INTO coordination_v2_source_promotions
         (id, repository_identity, promoted_commit_sha, exact_tree_sha,
          publication_reference, protected_validation_id, canonical_record_digest,
          operation_receipt_digest, operation_receipt_reference)
       VALUES ($1, 'github.com/holahola/holahola', $2, $3, $4, $5, $6, $7, $8)`,
      [
        sourcePromotionId,
        "1".repeat(40),
        "2".repeat(40),
        `runtime-bootstrap-source-publication-${suffix}`,
        `runtime-bootstrap-source-validation-${suffix}`,
        digest("c"),
        digest("d"),
        `runtime-bootstrap-source-receipt-${suffix}`,
      ],
    );
    await insertHost(client, hostId, "one");

    const release = releaseFixture(releaseId, sourcePromotionId, "e");
    await insertRelease(client, release);
    await client.query(
      `INSERT INTO coordination_v2_runtime_release_artifacts
         (id, runtime_release_id, role, fixed_destination, object_key,
          object_digest, byte_length, media_type, requires_authenticode)
       VALUES
         ($1, $2, 'node_executable', 'runtime/node.exe',
          $3, $4, 4, 'application/vnd.microsoft.portable-executable', TRUE),
         ($5, $2, 'tsx_runtime_module', 'node_modules/tsx/index.mjs',
           $6, $7, 4, 'text/javascript', FALSE),
          ($8, $2, 'tsx_runtime_module', 'node_modules/tsx/lib/cli.mjs',
           $6, $7, 4, 'text/javascript', FALSE)`,
      [
        id("artifact-node"),
        releaseId,
        `coordination-v2/runtime/${digest("2")}/node.exe`,
        digest("2"),
        id("artifact-tsx"),
        `coordination-v2/runtime/${digest("3")}/tsx-index.mjs`,
        digest("3"),
        id("artifact-tsx-shared-object"),
      ],
    );
    await insertIssue(client, issueId, hostId, releaseId, requestKey, manifestDigest);
    await insertAcknowledgement(
      client,
      acknowledgementId,
      hostId,
      releaseId,
      issueId,
      requestKey,
      manifestDigest,
    );
    await insertRevocation(client, revocationId, releaseId, id("revocation-request-one"));

    const persistedRelease = await client.query(
      `SELECT node_version, node_release_keyring_commit,
              node_release_keyring_digest, node_shasums_digest,
              node_signature_digest, node_signer_fingerprint, lockfile_digest,
              runtime_closure_digest, provenance_digest, source_members
         FROM coordination_v2_runtime_releases WHERE id = $1`,
      [releaseId],
    );
    assert.equal(persistedRelease.rows.length, 1);
    assert.deepEqual(persistedRelease.rows[0], {
      node_version: release.nodeVersion,
      node_release_keyring_commit: release.nodeReleaseKeyringCommit,
      node_release_keyring_digest: release.nodeReleaseKeyringDigest,
      node_shasums_digest: release.nodeShasumsDigest,
      node_signature_digest: release.nodeSignatureDigest,
      node_signer_fingerprint: release.nodeSignerFingerprint,
      lockfile_digest: release.lockfileDigest,
      runtime_closure_digest: release.runtimeClosureDigest,
      provenance_digest: release.provenanceDigest,
      source_members: release.sourceMembers,
    });
    const artifacts = await client.query(
      `SELECT role, fixed_destination FROM coordination_v2_runtime_release_artifacts
        WHERE runtime_release_id = $1 ORDER BY role`,
      [releaseId],
    );
    assert.deepEqual(artifacts.rows, [
      { role: "node_executable", fixed_destination: "runtime/node.exe" },
      { role: "tsx_runtime_module", fixed_destination: "node_modules/tsx/index.mjs" },
      { role: "tsx_runtime_module", fixed_destination: "node_modules/tsx/lib/cli.mjs" },
    ]);
    await expectCode(
      client,
      "runtime_artifact_duplicate_destination",
      () => client.query(
        `INSERT INTO coordination_v2_runtime_release_artifacts
           (id, runtime_release_id, role, fixed_destination, object_key,
            object_digest, byte_length, media_type, requires_authenticode)
         VALUES ($1, $2, 'tsx_runtime_module', 'node_modules/tsx/index.mjs',
                 $3, $4, 1, 'text/javascript', FALSE)`,
        [
          id("artifact-duplicate-destination"),
          releaseId,
          `coordination-v2/runtime/${digest("4")}/tsx-index-duplicate.mjs`,
          digest("4"),
        ],
      ),
      "23505",
    );

    await expectCode(
      client,
      "runtime_release_update",
      () => client.query(
        `UPDATE coordination_v2_runtime_releases SET repository_identity = 'mutated' WHERE id = $1`,
        [releaseId],
      ),
      "P0001",
    );
    await expectCode(
      client,
      "runtime_release_delete",
      () => client.query(`DELETE FROM coordination_v2_runtime_releases WHERE id = $1`, [releaseId]),
      "P0001",
    );
    await expectCode(
      client,
      "runtime_artifact_update",
      () => client.query(
        `UPDATE coordination_v2_runtime_release_artifacts SET media_type = 'text/plain' WHERE id = $1`,
        [id("artifact-node")],
      ),
      "P0001",
    );
    await expectCode(
      client,
      "runtime_artifact_delete",
      () => client.query(`DELETE FROM coordination_v2_runtime_release_artifacts WHERE id = $1`, [id("artifact-node")]),
      "P0001",
    );
    await expectCode(
      client,
      "runtime_issue_update",
      () => client.query(
        `UPDATE coordination_v2_runtime_bootstrap_issues SET request_digest = $2 WHERE id = $1`,
        [issueId, digest("0")],
      ),
      "P0001",
    );
    await expectCode(
      client,
      "runtime_issue_delete",
      () => client.query(`DELETE FROM coordination_v2_runtime_bootstrap_issues WHERE id = $1`, [issueId]),
      "P0001",
    );
    await expectCode(
      client,
      "runtime_ack_update",
      () => client.query(
        `UPDATE coordination_v2_runtime_bootstrap_acknowledgements
            SET local_evidence_digest = $2 WHERE id = $1`,
        [acknowledgementId, digest("1")],
      ),
      "P0001",
    );
    await expectCode(
      client,
      "runtime_ack_delete",
      () => client.query(
        `DELETE FROM coordination_v2_runtime_bootstrap_acknowledgements WHERE id = $1`,
        [acknowledgementId],
      ),
      "P0001",
    );
    await expectCode(
      client,
      "runtime_revocation_update",
      () => client.query(
        `UPDATE coordination_v2_runtime_release_revocations
            SET reason_code = 'OTHER_REASON' WHERE id = $1`,
        [revocationId],
      ),
      "P0001",
    );
    await expectCode(
      client,
      "runtime_revocation_delete",
      () => client.query(
        `DELETE FROM coordination_v2_runtime_release_revocations WHERE id = $1`,
        [revocationId],
      ),
      "P0001",
    );

    const lineageHostId = id("host-lineage");
    const lineageReleaseId = id("release-lineage");
    await insertHost(client, lineageHostId, "lineage");
    await insertRelease(
      client,
      releaseFixture(lineageReleaseId, sourcePromotionId, "f"),
    );

    const mismatchCases: Array<[string, string, {
      hostId?: string;
      releaseId?: string;
      requestKey?: string;
      manifestDigest?: string;
    }]> = [
      ["host", "4", { hostId: id("mismatched-host") }],
      ["release", "5", { releaseId: id("mismatched-release") }],
      ["request", "6", { requestKey: id("mismatched-request") }],
      ["manifest", "7", { manifestDigest: digest("0") }],
    ] as const;
    for (const [label, manifestSeed, mismatch] of mismatchCases) {
      const mismatchIssueId = id(`mismatch-issue-${label}`);
      const mismatchRequestKey = id(`mismatch-request-${label}`);
      const mismatchIssueManifest = digest(manifestSeed);
      await insertIssue(
        client,
        mismatchIssueId,
        lineageHostId,
        lineageReleaseId,
        mismatchRequestKey,
        mismatchIssueManifest,
      );
      await expectCode(
        client,
        `runtime_ack_mismatch_${label}`,
        () => insertAcknowledgement(
          client,
          id(`ack-mismatch-${label}`),
          mismatch.hostId ?? lineageHostId,
          mismatch.releaseId ?? lineageReleaseId,
          mismatchIssueId,
          mismatch.requestKey ?? mismatchRequestKey,
          mismatch.manifestDigest ?? mismatchIssueManifest,
        ),
        "23503",
      );
    }

    await expectCode(
      client,
      "runtime_issue_expiry_too_long",
      () => client.query(
        `INSERT INTO coordination_v2_runtime_bootstrap_issues
           (id, host_enrollment_id, runtime_release_id, request_key,
            request_digest, manifest_digest, issued_at, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, now(), now() + interval '6 minutes')`,
        [id("issue-expired"), hostId, releaseId, id("issue-expired-request"), digest("1"), digest("0")],
      ),
      "23514",
    );
    await expectCode(
      client,
      "runtime_artifact_bad_role",
      () => client.query(
        `INSERT INTO coordination_v2_runtime_release_artifacts
           (id, runtime_release_id, role, fixed_destination, object_key,
            object_digest, byte_length, media_type, requires_authenticode)
         VALUES ($1, $2, 'invalid_role', 'runtime/bad.exe', $3, $4, 1,
                 'application/octet-stream', TRUE)`,
        [id("artifact-bad-role"), releaseId, `coordination-v2/runtime/${digest("4")}/bad.exe`, digest("4")],
      ),
      "23514",
    );
    await expectCode(
      client,
      "runtime_artifact_bad_digest",
      () => client.query(
        `INSERT INTO coordination_v2_runtime_release_artifacts
           (id, runtime_release_id, role, fixed_destination, object_key,
            object_digest, byte_length, media_type, requires_authenticode)
         VALUES ($1, $2, 'tsx_runtime_module', 'node_modules/tsx/bad.mjs', $3,
                 $4, 1, 'text/javascript', FALSE)`,
        [id("artifact-bad-digest"), releaseId, `coordination-v2/runtime/${digest("5")}/bad.mjs`, "g".repeat(64)],
      ),
      "23514",
    );

    const invalidProvenanceCases: Array<[string, Partial<RuntimeReleaseRow>]> = [
      ["node_version", { nodeVersion: "" }],
      ["node_keyring_commit", { nodeReleaseKeyringCommit: "G".repeat(40) }],
      ["node_keyring_digest", { nodeReleaseKeyringDigest: "g".repeat(64) }],
      ["node_shasums_digest", { nodeShasumsDigest: "g".repeat(64) }],
      ["node_signature_digest", { nodeSignatureDigest: "g".repeat(64) }],
      ["node_signer_fingerprint", { nodeSignerFingerprint: "a".repeat(40) }],
      ["lockfile_digest", { lockfileDigest: "g".repeat(64) }],
      ["runtime_closure_digest", { runtimeClosureDigest: "g".repeat(64) }],
      ["provenance_digest", { provenanceDigest: "g".repeat(64) }],
    ];
    for (const [label, override] of invalidProvenanceCases) {
      await expectCode(
        client,
        `runtime_release_bad_${label}`,
        () => insertRelease(
          client,
          { ...releaseFixture(id(`release-bad-${label}`), sourcePromotionId, "0"), ...override },
        ),
        "23514",
      );
    }

    await expectCode(
      client,
      "runtime_ack_duplicate_release",
      () => insertAcknowledgement(
        client,
        id("ack-duplicate-release"),
        hostId,
        releaseId,
        issueId,
        requestKey,
        manifestDigest,
      ),
      "23505",
    );
    await expectCode(
      client,
      "runtime_revocation_duplicate_release",
      () => insertRevocation(client, id("revocation-duplicate"), releaseId, id("revocation-request-two")),
      "23505",
    );

    const hostTwo = id("host-two");
    const releaseTwoId = id("release-two");
    const issueTwoId = id("issue-two");
    const requestTwo = id("issue-request-two");
    const manifestTwo = digest("2");
    await insertHost(client, hostTwo, "two");
    await insertRelease(client, releaseFixture(releaseTwoId, sourcePromotionId, "0"));
    await insertIssue(client, issueTwoId, hostTwo, releaseTwoId, requestTwo, manifestTwo);
    await insertAcknowledgement(
      client,
      id("ack-two"),
      hostTwo,
      releaseTwoId,
      issueTwoId,
      requestTwo,
      manifestTwo,
    );
    const unrelated = await client.query(
      `SELECT count(*)::integer AS count
         FROM coordination_v2_runtime_bootstrap_acknowledgements
        WHERE issue_id = $1 AND host_enrollment_id = $2 AND runtime_release_id = $3`,
      [issueTwoId, hostTwo, releaseTwoId],
    );
    assert.equal(unrelated.rows[0].count, 1);
  } finally {
    if (transactionStarted) {
      await client.query("ROLLBACK").catch(() => undefined);
    }
    if (connected) {
      await client.end();
    }
  }
});