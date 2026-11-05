import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { and, desc, eq, ilike } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { PgDialect } from "drizzle-orm/pg-core";
import { Pool } from "pg";
import { danielaSelfReflections } from "@shared/schema";

import {
  AUTO_GROUNDING_DIAGNOSTIC_TAG,
  AUTOBIOGRAPHICAL_MEMORY_TAG,
  LOOKUP_FAILURE_TAG,
  OPERATIONAL_MEMORY_TAG,
  autoGroundingMemoryTags,
  excludesOperationalMemories,
  groundingMemoryTags,
  isAutobiographicalMemory,
  isOperationalLookupFailure,
  withAutobiographicalMemoryTag,
} from "../services/daniela-memory-boundary";

test("intentional reflections about forgetting remain autobiographical", () => {
  const tags = withAutobiographicalMemoryTag([
    "forgetting",
    "relationship",
    OPERATIONAL_MEMORY_TAG,
    LOOKUP_FAILURE_TAG,
  ]);

  assert.deepEqual(tags, [
    "forgetting",
    "relationship",
    AUTOBIOGRAPHICAL_MEMORY_TAG,
  ]);
  assert.equal(isAutobiographicalMemory(tags), true);
  assert.equal(isOperationalLookupFailure(tags), false);
});

test("no-match grounding attempts carry the explicit operational failure marker", () => {
  const tags = groundingMemoryTags(false);

  assert.deepEqual(tags, [OPERATIONAL_MEMORY_TAG, LOOKUP_FAILURE_TAG]);
  assert.equal(isAutobiographicalMemory(tags), false);
  assert.equal(isOperationalLookupFailure(tags), true);
});

test("successful grounding pauses and untouched legacy rows remain autobiographical", () => {
  assert.deepEqual(groundingMemoryTags(true), [AUTOBIOGRAPHICAL_MEMORY_TAG]);
  assert.equal(isAutobiographicalMemory(groundingMemoryTags(true)), true);
  assert.equal(isAutobiographicalMemory(null), true);
  assert.equal(isAutobiographicalMemory([]), true);
});

test("all felt-history readers use the explicit operational exclusion", () => {
  const readers = [
    "server/services/native-fc-handlers.ts",
    "server/services/frictionless-slide-detector.ts",
    "server/services/session-compass-service.ts",
    "server/services/pre-session-synthesis.ts",
    "server/services/daniela-presence-worker.ts",
    "server/services/session-reflection-worker.ts",
    "server/services/streaming-voice-orchestrator.ts",
    "server/routes.ts",
  ];

  for (const path of readers) {
    const source = readFileSync(path, "utf8");
    assert.match(
      source,
      /excludesOperationalMemories\(danielaSelfReflections\.tags(?:,\s*danielaSelfReflections\.content)?\)/,
      `${path} must exclude explicitly operational reflection rows`,
    );
  }
});

test("grounding classification happens only after the lookup result is known", () => {
  const source = readFileSync("server/services/native-fc-handlers.ts", "utf8");
  const foundIndex = source.indexOf("const groundingFound = sections.length > 0;");
  const tagsIndex = source.indexOf("tags: groundingMemoryTags(groundingFound)");

  assert.ok(foundIndex >= 0, "groundingFound assignment must exist");
  assert.ok(tagsIndex > foundIndex, "pause classification must happen after the lookup result is known");
});

test("background [AUTO-GROUNDING] diagnostic entries are always operational and excluded from felt history", () => {
  assert.deepEqual(autoGroundingMemoryTags(true), [
    OPERATIONAL_MEMORY_TAG,
    AUTO_GROUNDING_DIAGNOSTIC_TAG,
  ]);
  assert.deepEqual(autoGroundingMemoryTags(false), [
    OPERATIONAL_MEMORY_TAG,
    AUTO_GROUNDING_DIAGNOSTIC_TAG,
    LOOKUP_FAILURE_TAG,
  ]);
  assert.equal(isAutobiographicalMemory(autoGroundingMemoryTags(true)), false);
  assert.equal(isAutobiographicalMemory(autoGroundingMemoryTags(false)), false);
  assert.equal(
    isAutobiographicalMemory(
      [AUTOBIOGRAPHICAL_MEMORY_TAG],
      '[AUTO-GROUNDING] Frictionless Slide detected — phrase: "So I\'ve got my webcam on"',
    ),
    false,
  );

  const detectorSource = readFileSync("server/services/frictionless-slide-detector.ts", "utf8");
  assert.match(
    detectorSource,
    /tags:\s*autoGroundingMemoryTags\(sections\.length\s*>\s*0\)/,
    "runAutoGrounding must tag background [AUTO-GROUNDING] rows as operational diagnostics",
  );
  const boundarySource = readFileSync("server/services/daniela-memory-boundary.ts", "utf8");
  assert.match(
    boundarySource,
    /NOT LIKE '\[AUTO-GROUNDING\]%'/,
    "excludesOperationalMemories SQL must also filter legacy [AUTO-GROUNDING] rows",
  );
});

test("real felt-history reader query excludes legacy [AUTO-GROUNDING] row with null tags", async () => {
  const testUserId = "ci-felt-history-legacy-user-0001";
  const kw = "%webcam%";

  // 1. Verify the exact Drizzle felt-history reader query compiles both with explicit
  //    contentColumn and with automatic table.content resolution.
  const dialect = new PgDialect();
  const explicitSql = dialect.sqlToQuery(
    and(
      eq(danielaSelfReflections.userId, testUserId),
      excludesOperationalMemories(danielaSelfReflections.tags, danielaSelfReflections.content),
      ilike(danielaSelfReflections.content, kw),
    )!,
  );
  const implicitSql = dialect.sqlToQuery(
    and(
      eq(danielaSelfReflections.userId, testUserId),
      excludesOperationalMemories(danielaSelfReflections.tags),
      ilike(danielaSelfReflections.content, kw),
    )!,
  );
  assert.equal(explicitSql.sql, implicitSql.sql);
  assert.match(
    explicitSql.sql,
    /COALESCE\("daniela_self_reflections"\."content", ''\) NOT LIKE '\[AUTO-GROUNDING\]%'/,
  );
  assert.deepEqual(explicitSql.params, [testUserId, OPERATIONAL_MEMORY_TAG, kw]);

  // 2. When explicitly opted in (RUN_LIVE_DB_TESTS=1) and a live Postgres URL is
  //    configured, execute the real Drizzle felt-history reader query inside a
  //    rolled-back transaction against a legacy [AUTO-GROUNDING] row with tags=NULL
  //    and a genuine reflection row with tags=NULL.
  const dbUrl = process.env.NEON_SHARED_DATABASE_URL ?? "";
  if (process.env.RUN_LIVE_DB_TESTS === "1" && dbUrl && !dbUrl.includes("localhost:5432/db")) {
    const pool = new Pool({ connectionString: dbUrl, ssl: { rejectUnauthorized: false }, max: 1 });
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const txDb = drizzle(client);
      await txDb.insert(danielaSelfReflections).values([
        {
          userId: testUserId,
          content: '[AUTO-GROUNDING] Frictionless Slide detected — phrase: "So I\'ve got my webcam on"',
          source: "grounding_query",
          mood: "grounding",
          tags: null,
        } as any,
        {
          userId: testUserId,
          content: "Genuine felt reflection about the webcam session with David.",
          source: "self",
          mood: "warm",
          tags: null,
        } as any,
      ]);

      const feltMatches = await txDb
        .select()
        .from(danielaSelfReflections)
        .where(
          and(
            eq(danielaSelfReflections.userId, testUserId),
            excludesOperationalMemories(danielaSelfReflections.tags, danielaSelfReflections.content),
            ilike(danielaSelfReflections.content, kw),
          ),
        )
        .orderBy(desc(danielaSelfReflections.createdAt))
        .limit(3);

      assert.equal(feltMatches.length, 1);
      assert.equal(
        feltMatches[0].content,
        "Genuine felt reflection about the webcam session with David.",
      );
    } finally {
      await client.query("ROLLBACK");
      client.release();
      await pool.end();
    }
  }
});