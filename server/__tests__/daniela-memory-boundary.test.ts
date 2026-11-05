import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  AUTO_GROUNDING_DIAGNOSTIC_TAG,
  AUTOBIOGRAPHICAL_MEMORY_TAG,
  LOOKUP_FAILURE_TAG,
  OPERATIONAL_MEMORY_TAG,
  autoGroundingMemoryTags,
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
      /excludesOperationalMemories\(danielaSelfReflections\.tags\)/,
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