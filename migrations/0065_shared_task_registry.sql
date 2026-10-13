CREATE TABLE "shared_task_definitions" (
	"task_ref" varchar(32) PRIMARY KEY NOT NULL,
	"repository_identity" varchar(512) NOT NULL,
	"starting_commit" varchar(64) NOT NULL,
	"source_kind" varchar(24) NOT NULL,
	"creator_actor" varchar(128),
	"source_thread" varchar(255),
	"supersedes" varchar(32),
	"definition" jsonb NOT NULL,
	"artifact_base64" text NOT NULL,
	"artifact_sha256" varchar(64) NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "shared_task_ref_format" CHECK ("shared_task_definitions"."task_ref" ~ '^[1-9][0-9]{0,31}$'),
	CONSTRAINT "shared_task_source_kind" CHECK ("shared_task_definitions"."source_kind" IN ('hat','replit','bootstrap','legacy')),
	CONSTRAINT "shared_task_sha_format" CHECK ("shared_task_definitions"."artifact_sha256" ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
CREATE TABLE "shared_task_events" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task_ref" varchar(32) NOT NULL,
	"version" integer NOT NULL,
	"actor" varchar(128) NOT NULL,
	"state" varchar(24) NOT NULL,
	"reason" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "shared_task_lifecycle" (
	"task_ref" varchar(32) PRIMARY KEY NOT NULL,
	"state" varchar(24) DEFAULT 'proposed' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "shared_task_state" CHECK ("shared_task_lifecycle"."state" IN ('proposed','active','blocked','completed','cancelled')),
	CONSTRAINT "shared_task_version" CHECK ("shared_task_lifecycle"."version" > 0)
);
--> statement-breakpoint
CREATE TABLE "shared_task_registry_gate" (
	"id" integer PRIMARY KEY NOT NULL,
	"ready" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "shared_task_requests" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"operation" varchar(16) NOT NULL,
	"actor" varchar(128) NOT NULL,
	"request_key" varchar(128) NOT NULL,
	"request_digest" varchar(64) NOT NULL,
	"task_ref" varchar(32) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "shared_task_reservations" (
	"task_ref" varchar(32) PRIMARY KEY NOT NULL,
	"actor" varchar(128) NOT NULL,
	"artifact_sha256" varchar(64) NOT NULL
);
--> statement-breakpoint
ALTER TABLE "shared_task_events" ADD CONSTRAINT "shared_task_events_task_ref_shared_task_definitions_task_ref_fk" FOREIGN KEY ("task_ref") REFERENCES "public"."shared_task_definitions"("task_ref") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shared_task_lifecycle" ADD CONSTRAINT "shared_task_lifecycle_task_ref_shared_task_definitions_task_ref_fk" FOREIGN KEY ("task_ref") REFERENCES "public"."shared_task_definitions"("task_ref") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shared_task_requests" ADD CONSTRAINT "shared_task_requests_task_ref_shared_task_definitions_task_ref_fk" FOREIGN KEY ("task_ref") REFERENCES "public"."shared_task_definitions"("task_ref") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "shared_task_event_version" ON "shared_task_events" USING btree ("task_ref","version");--> statement-breakpoint
CREATE UNIQUE INDEX "shared_task_request_identity" ON "shared_task_requests" USING btree ("operation","actor","request_key");
--> statement-breakpoint
-- Reviewed rollout: hold the legacy table until backfill + enforcement commit.
LOCK TABLE coordination_v2_task_artifacts IN ACCESS EXCLUSIVE MODE;
--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS pgcrypto;
--> statement-breakpoint
CREATE SEQUENCE shared_task_reference_sequence AS bigint MINVALUE 1000000 START 1000003;
--> statement-breakpoint
INSERT INTO shared_task_registry_gate(id,ready) VALUES (1,false);
--> statement-breakpoint
INSERT INTO shared_task_reservations(task_ref,actor,artifact_sha256) VALUES
 ('1000001','luca-claude-code','9886f203396684c13b1de56c5fbcf68a184628b5c548ac4a605117a18792567b'),
 ('1000002','luca-replit','4ec3630cc472605babe01b99e785760aef25b5921581b698e3db3077d3ab2fc8');
--> statement-breakpoint
DO $$
BEGIN
 IF EXISTS (
   SELECT 1 FROM coordination_v2_task_artifacts a
   LEFT JOIN shared_task_reservations r USING(task_ref)
   WHERE a.task_ref !~ '^[1-9][0-9]{0,31}$'
     OR a.task_artifact_sha256 <> encode(digest(decode(a.artifact_base64,'base64'),'sha256'),'hex')
     OR octet_length(decode(a.artifact_base64,'base64')) NOT BETWEEN 1 AND 262144
     OR a.repository_identity !~ '^github:[a-z0-9][a-z0-9_.-]*/[a-z0-9][a-z0-9_.-]*$'
     OR (r.task_ref IS NOT NULL AND r.artifact_sha256 <> a.task_artifact_sha256)
 ) THEN RAISE EXCEPTION 'TASK_REGISTRY_BACKFILL_CONFLICT'; END IF;
END $$;
--> statement-breakpoint
INSERT INTO shared_task_definitions
 (task_ref,repository_identity,starting_commit,source_kind,creator_actor,source_thread,
  definition,artifact_base64,artifact_sha256,created_at)
 SELECT task_ref,repository_identity,starting_commit,'legacy',NULL,NULL,
   jsonb_build_object('title',NULL,'purpose',NULL,'scope',NULL,'exclusions',NULL,
     'provenance','legacy/unknown','publishedBy',published_by,
     'publishedAt',created_at,'lastTransportUpdate',updated_at),
   artifact_base64,task_artifact_sha256,created_at
 FROM coordination_v2_task_artifacts WHERE task_ref NOT IN ('1000001','1000002');
--> statement-breakpoint
-- Accepted bootstrap artifacts are embedded verbatim, not reconstructed scope.
WITH accepted(task_ref,creator_actor,starting_commit,artifact) AS (VALUES
 ('1000001','luca-claude-code','0c81d21b44ca17ffe1fb5c8cc5fe0cad41e8cceb',
 $bootstrap1$# Task 1000001: Land the Luca active-session listener on main

Reserved by hand on 2026-10-10 by Luca [Claude Code] (`luca-claude-code`), with David's explicit approval. This is the single bootstrap number before the shared task registry exists; all later hat-created tasks come from the registry.

## Scope

- Land branch `lcc/session-delivery-listener` at commit `0c81d21b44ca17ffe1fb5c8cc5fe0cad41e8cceb` (parent `origin/main` `36614989d`) through `scripts/cross-tool-promote.ts push`.
- Contents:
  - The 14 files of shared-spec note `09121901` revision `5e29bf01`: the listener, its tests and the operating guide. These were reviewed and natively verified, 66/66 tests on Windows.
  - Five suite lines added to `scripts/run-ci-test-steps.mjs`.
- Code-only. `docs/shared-agent-instructions.md` (approved revision `e9f3bdb7`) is NOT part of this task. It lands separately through the shared-spec sync.

## Not authorized

- No other files.
- No credential, settings, schema or data changes.
- No deployment, no model or harness launch, and no worker activation.

## Coordination

- Build thread: `872ea6d0-bd94-4d0f-9ccf-187c18187a02`.
- Design: `69668936` / `3a025a66`.
$bootstrap1$),
 ('1000002','luca-replit','3cfd020540e1456f88666381129423b6b75a803a',
 $bootstrap2$# Task 1000002: Build the shared task registry in the Replit workspace

Reserved explicitly by David on 2026-10-10 through the Replit approval form:
"Approve workspace build + reserve task 1000002."
This is a registry-only bootstrap exception before the registry exists, not a
Replit platform-created project task and not permission to reuse task 1000001.

## Owner and immutable design

- Builder: Luca [Replit], authenticated actor `luca-replit`; no subagents.
- Independent source reviewer and native Windows verifier: Luca [Claude Code].
- Source coordination thread: `872ea6d0-bd94-4d0f-9ccf-187c18187a02`.
- Workspace starting commit: `3cfd020540e1456f88666381129423b6b75a803a`.
- Approved design document: `29ac4b24-58ee-4b06-a9f9-bc3eabf90561`.
- Exact design revision: `ef20f340-3194-4b32-a0fe-492717088b3d`.
- Independent review: `3db6f2b4-c7eb-4340-81c8-0e51c0587020`.
- Design SHA-256:
  `79dc5fa9c57ebff90fe3377d3f4acc0ae2049c4d5620189f02edaf740dce7b81`.
- Review carry-forward note: `7238dd4a-d988-4669-b5d4-253c8d8bae0a`,
  revision `108624a1-7e08-49a3-9120-3efeb933d075`.

## Authorized workspace scope

1. Inventory existing artifact publishers/direct writers and rollout behavior.
2. Implement the canonical insert-only globally unique registry, immutable task
   definitions/artifact bytes, frozen legacy projection and database-level
   per-reference serialization/enforcement against legacy upserts.
3. Implement authenticated allocation/import, actor-scoped idempotency, required
   authorized source threads, documented per-actor allocation bounds, discovery,
   exact-artifact reads, separately versioned lifecycle CAS, and portable CLI.
4. Preserve actual imported provenance; reject conflicts rather than overwrite,
   reuse references, round bigint identifiers or manufacture platform records.
5. Materialize exact task bytes with complete-temp/exclusive publication and
   refusal of differing existing files. Preserve ownership publication behavior;
   any shared-helper extraction requires fresh regression and native review.
6. Normalize valid GitHub owner/repository case at the common input boundary,
   retain all unsafe-input rejections, and prove existing signed identity/digest
   bytes remain unchanged with actual persisted-record read-only verification.
7. Update schema declarations, generate/review migration artifacts, and prove
   migration/backfill/enforcement and real races only on a verified disposable
   Neon branch. Creation/removal of that test branch is in scope; mutation of the
   shared application database is not.
8. Add/register focused tests, run type/build/CI checks with honest baselines,
   obtain LCC's independent exact-source/native Windows review, and record results.

## Preconditions and exclusions

- This reservation/artifact is not verified ownership. Implementation starts
  only after the ordinary begin / founder approve / prove flow for `luca-replit`
  and this exact artifact; never approve on David's behalf or bypass guards.
- Task 1000001 remains exclusively LCC's listener landing. Do not change its
  artifact or reviewed listener payload while that landing is pending. Coordinate
  any later shared-helper changes as this task's independently reviewed diff.
- No source promotion, merge/push to main, runtime publication or deployment.
- No shared/live database migration, backfill, mutation or startup DDL.
- No provider credential/settings changes; only normal task-ownership key custody
  and challenge/proof prerequisites for this task are included.
- No model/harness launch, worker activation, saved live-instruction rewrite or
  shared-instruction publication/sync.
- Founder Task Ownership context UI (review note N1) is a separately scoped
  follow-up, not part of this workspace build.
- Do not bundle unrelated dirty files or claim completion before required
  verification. Scope changes require a new artifact and fresh authorization.
$bootstrap2$))
INSERT INTO shared_task_definitions
 (task_ref,repository_identity,starting_commit,source_kind,creator_actor,source_thread,
 definition,artifact_base64,artifact_sha256)
SELECT task_ref,'github:davidwmcintosh/holahola',starting_commit,'bootstrap',creator_actor,
 '872ea6d0-bd94-4d0f-9ccf-187c18187a02',
 jsonb_build_object('title',split_part(split_part(artifact,E'\n',1),': ',2),
   'purpose',split_part(artifact,E'\n\n',2),
   'scope',jsonb_build_array(CASE WHEN task_ref='1000001' THEN
     split_part(split_part(artifact,E'\n## Scope\n',2),E'\n## Not authorized\n',1) ELSE
     split_part(split_part(artifact,E'\n## Authorized workspace scope\n',2),E'\n## Preconditions and exclusions\n',1) END),
   'exclusions',jsonb_build_array(CASE WHEN task_ref='1000001' THEN
     split_part(split_part(artifact,E'\n## Not authorized\n',2),E'\n## Coordination\n',1) ELSE
     split_part(artifact,E'\n## Preconditions and exclusions\n',2) END),
   'provenance','explicit founder-reserved bootstrap; allocation is not ownership'),
 replace(encode(convert_to(artifact,'UTF8'),'base64'),E'\n',''),
 encode(digest(convert_to(artifact,'UTF8'),'sha256'),'hex')
FROM accepted;
--> statement-breakpoint
DO $$
BEGIN
 IF EXISTS(SELECT 1 FROM shared_task_reservations r JOIN shared_task_definitions d USING(task_ref)
   WHERE r.artifact_sha256<>d.artifact_sha256)
 THEN RAISE EXCEPTION 'TASK_BOOTSTRAP_BYTES_MISMATCH'; END IF;
 IF EXISTS(SELECT 1 FROM coordination_v2_task_artifacts a JOIN shared_task_definitions d USING(task_ref)
   WHERE a.artifact_base64<>d.artifact_base64 OR a.task_artifact_sha256<>d.artifact_sha256
     OR a.repository_identity<>d.repository_identity OR a.starting_commit<>d.starting_commit)
 THEN RAISE EXCEPTION 'TASK_REGISTRY_BACKFILL_CONFLICT'; END IF;
END $$;
--> statement-breakpoint
INSERT INTO coordination_v2_task_artifacts
 (task_ref,repository_identity,starting_commit,artifact_base64,task_artifact_sha256,published_by)
 SELECT task_ref,repository_identity,starting_commit,artifact_base64,artifact_sha256,creator_actor
 FROM shared_task_definitions WHERE source_kind='bootstrap' ON CONFLICT(task_ref) DO NOTHING;
--> statement-breakpoint
INSERT INTO shared_task_lifecycle(task_ref) SELECT task_ref FROM shared_task_definitions;
--> statement-breakpoint
INSERT INTO shared_task_events(task_ref,version,actor,state,reason)
 SELECT task_ref,1,'coordination-system','proposed','Backfilled exact legacy transport; creator and historical scope unknown'
 FROM shared_task_definitions;
--> statement-breakpoint
SELECT setval('shared_task_reference_sequence',
 LEAST(9223372036854775807::numeric,GREATEST(1000002::numeric,
   COALESCE((SELECT max(task_ref::numeric) FROM shared_task_definitions),0)))::bigint,true);
--> statement-breakpoint
CREATE FUNCTION shared_task_definition_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'TASK_DEFINITION_IMMUTABLE'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('registry-allocator',0));
 PERFORM pg_advisory_xact_lock(hashtextextended(NEW.task_ref,0));
 IF NEW.artifact_sha256 <> encode(digest(decode(NEW.artifact_base64,'base64'),'sha256'),'hex')
   OR octet_length(decode(NEW.artifact_base64,'base64')) NOT BETWEEN 1 AND 262144
 THEN RAISE EXCEPTION 'TASK_ARTIFACT_INVALID'; END IF;
 IF EXISTS (SELECT 1 FROM coordination_v2_task_artifacts a WHERE a.task_ref=NEW.task_ref
   AND (a.artifact_base64<>NEW.artifact_base64 OR a.task_artifact_sha256<>NEW.artifact_sha256
     OR a.repository_identity<>NEW.repository_identity OR a.starting_commit<>NEW.starting_commit))
 THEN RAISE EXCEPTION 'TASK_ARTIFACT_FROZEN'; END IF;
 IF EXISTS (SELECT 1 FROM shared_task_reservations r WHERE r.task_ref=NEW.task_ref
   AND (r.artifact_sha256<>NEW.artifact_sha256 OR r.actor IS DISTINCT FROM NEW.creator_actor OR NEW.source_kind<>'bootstrap'))
 THEN RAISE EXCEPTION 'TASK_RESERVATION_CONFLICT'; END IF;
 PERFORM setval('shared_task_reference_sequence',
   LEAST(9223372036854775807::numeric,GREATEST(
     (SELECT last_value FROM shared_task_reference_sequence)::numeric,NEW.task_ref::numeric))::bigint,true);
 RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER shared_task_definition_insert_only
 BEFORE INSERT OR UPDATE OR DELETE ON shared_task_definitions
 FOR EACH ROW EXECUTE FUNCTION shared_task_definition_guard();
--> statement-breakpoint
CREATE FUNCTION shared_task_projection_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE ref text; canonical shared_task_definitions%ROWTYPE;
BEGIN
 ref := CASE WHEN TG_OP='DELETE' THEN OLD.task_ref ELSE NEW.task_ref END;
 -- An UPDATE/DELETE already holds a tuple lock. Never wait for an advisory
 -- lock in that order: fail/retry instead of deadlocking a registry insert.
 IF TG_OP='INSERT' THEN
   PERFORM pg_advisory_xact_lock(hashtextextended(ref,0));
 ELSIF NOT pg_try_advisory_xact_lock(hashtextextended(ref,0)) THEN
   RAISE EXCEPTION 'TASK_ARTIFACT_BUSY';
 END IF;
 IF TG_OP='UPDATE' AND NEW.task_ref<>OLD.task_ref THEN
   RAISE EXCEPTION 'TASK_REFERENCE_IMMUTABLE';
 END IF;
 SELECT * INTO canonical FROM shared_task_definitions WHERE task_ref=ref;
 IF FOUND THEN
   IF TG_OP='DELETE' THEN RAISE EXCEPTION 'TASK_ARTIFACT_FROZEN'; END IF;
   IF canonical.artifact_base64<>NEW.artifact_base64
     OR canonical.artifact_sha256<>NEW.task_artifact_sha256
     OR canonical.repository_identity<>NEW.repository_identity
     OR canonical.starting_commit<>NEW.starting_commit
   THEN RAISE EXCEPTION 'TASK_ARTIFACT_FROZEN'; END IF;
   IF TG_OP='UPDATE' THEN RETURN OLD; END IF;
 ELSIF (SELECT ready FROM shared_task_registry_gate WHERE id=1) THEN
   RAISE EXCEPTION 'TASK_REGISTRY_IMPORT_REQUIRED';
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER shared_task_projection_frozen
 BEFORE INSERT OR UPDATE OR DELETE ON coordination_v2_task_artifacts
 FOR EACH ROW EXECUTE FUNCTION shared_task_projection_guard();
--> statement-breakpoint
-- Allocation is enabled only after all historical bytes are verified and the
-- rolling-old-writer enforcement is installed in this same migration transaction.
UPDATE shared_task_registry_gate SET ready=true WHERE id=1;