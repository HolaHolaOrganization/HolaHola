CREATE TABLE "task_ownership_promotion_contexts" (
  "challenge_id" varchar PRIMARY KEY NOT NULL,
  "context_digest" varchar(64) NOT NULL,
  "descriptor" jsonb NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "task_ownership_promotion_context_digest" CHECK ("task_ownership_promotion_contexts"."context_digest" ~ '^[a-f0-9]{64}$'),
  CONSTRAINT "task_ownership_promotion_context_object" CHECK (jsonb_typeof("task_ownership_promotion_contexts"."descriptor") = 'object')
);
--> statement-breakpoint
ALTER TABLE "task_ownership_promotion_contexts" ADD CONSTRAINT "task_ownership_promotion_contexts_challenge_id_task_ownership_challenges_id_fk" FOREIGN KEY ("challenge_id") REFERENCES "public"."task_ownership_challenges"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.guard_task_ownership_promotion_context()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE parent_record record; canonical_descriptor text;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'Promotion approval context is immutable';
  END IF;
  SELECT context_digest, status, decided_at INTO parent_record
    FROM public.task_ownership_challenges WHERE id = NEW.challenge_id FOR UPDATE;
  IF NOT FOUND OR parent_record.status <> 'pending' OR parent_record.decided_at IS NOT NULL
     OR parent_record.context_digest IS DISTINCT FROM NEW.context_digest THEN
    RAISE EXCEPTION 'Promotion context requires its matching pending challenge';
  END IF;
  IF jsonb_typeof(NEW.descriptor) IS DISTINCT FROM 'object'
     OR NOT (NEW.descriptor ?& ARRAY['branch','candidateCommit','purpose','repository'])
     OR (SELECT count(*) FROM jsonb_object_keys(NEW.descriptor)) <> 4 THEN
    RAISE EXCEPTION 'Invalid promotion descriptor keys';
  END IF;
  IF jsonb_typeof(NEW.descriptor->'branch') IS DISTINCT FROM 'string'
     OR jsonb_typeof(NEW.descriptor->'candidateCommit') IS DISTINCT FROM 'string'
     OR jsonb_typeof(NEW.descriptor->'purpose') IS DISTINCT FROM 'string'
     OR jsonb_typeof(NEW.descriptor->'repository') IS DISTINCT FROM 'string'
     OR NEW.descriptor->>'purpose' <> 'cross-tool-promote'
     OR NEW.descriptor->>'repository' <> 'github:davidwmcintosh/holahola'
     OR (NEW.descriptor->>'candidateCommit') !~ '^[a-f0-9]{40}$'
     OR length(NEW.descriptor->>'branch') NOT BETWEEN 1 AND 200
     OR (NEW.descriptor->>'branch') !~ '^[A-Za-z0-9._/-]+$'
     OR (NEW.descriptor->>'branch') LIKE '-%'
     OR position('..' IN NEW.descriptor->>'branch') > 0 THEN
    RAISE EXCEPTION 'Invalid promotion descriptor values';
  END IF;
  -- Explicit lexical order matches canonicalJson, not PostgreSQL JSONB key order.
  canonical_descriptor := format('{"branch":%s,"candidateCommit":%s,"purpose":%s,"repository":%s}',
    to_jsonb(NEW.descriptor->>'branch')::text, to_jsonb(NEW.descriptor->>'candidateCommit')::text,
    to_jsonb(NEW.descriptor->>'purpose')::text, to_jsonb(NEW.descriptor->>'repository')::text);
  IF encode(sha256(convert_to(canonical_descriptor,'UTF8')),'hex') IS DISTINCT FROM NEW.context_digest THEN
    RAISE EXCEPTION 'Promotion context digest mismatch';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER task_ownership_promotion_context_immutable
BEFORE INSERT OR UPDATE OR DELETE ON public.task_ownership_promotion_contexts
FOR EACH ROW EXECUTE FUNCTION public.guard_task_ownership_promotion_context();
--> statement-breakpoint
CREATE TRIGGER task_ownership_promotion_context_no_truncate
BEFORE TRUNCATE ON public.task_ownership_promotion_contexts
FOR EACH STATEMENT EXECUTE FUNCTION public.guard_task_ownership_promotion_context();