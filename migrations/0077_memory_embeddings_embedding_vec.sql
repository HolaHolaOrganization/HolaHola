-- F7 (live-test-1 debrief): store each 768-dim embedding once as a pgvector value so
-- similarity search runs in Postgres without a per-row jsonb cast or a bulk transfer.
--
-- Conditional on pgvector being available: production (Neon) has it; local harnesses
-- and plain postgres images may not, and there the column simply does not exist and
-- semanticSearch keeps using the jsonb path.
--
-- The column is nullable with no default, so adding it does not rewrite the table.
-- A row trigger keeps it in step with `embedding` for every writer (Drizzle inserts,
-- raw SQL inserts, ON CONFLICT ... DO UPDATE SET embedding). Rows whose embedding is
-- not a 768-element array (test stubs) get NULL rather than failing the write.
-- Existing rows are filled by scripts/data-ops/backfill-memory-embedding-vec.ts.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'vector') THEN
    RAISE NOTICE 'pgvector not available; skipping memory_embeddings.embedding_vec';
    RETURN;
  END IF;

  -- Never queue behind a long-running read for the brief ACCESS EXCLUSIVE lock.
  PERFORM set_config('lock_timeout', '5s', true);

  CREATE EXTENSION IF NOT EXISTS vector;
  ALTER TABLE memory_embeddings ADD COLUMN IF NOT EXISTS embedding_vec vector(768);

  CREATE OR REPLACE FUNCTION memory_embeddings_sync_embedding_vec() RETURNS trigger
  LANGUAGE plpgsql AS $fn$
  BEGIN
    IF NEW.embedding IS NOT NULL
       AND jsonb_typeof(NEW.embedding) = 'array'
       AND jsonb_array_length(NEW.embedding) = 768 THEN
      NEW.embedding_vec := (NEW.embedding::text)::vector(768);
    ELSE
      NEW.embedding_vec := NULL;
    END IF;
    RETURN NEW;
  END
  $fn$;

  DROP TRIGGER IF EXISTS memory_embeddings_sync_embedding_vec ON memory_embeddings;
  CREATE TRIGGER memory_embeddings_sync_embedding_vec
    BEFORE INSERT OR UPDATE OF embedding ON memory_embeddings
    FOR EACH ROW EXECUTE FUNCTION memory_embeddings_sync_embedding_vec();
END
$$;
