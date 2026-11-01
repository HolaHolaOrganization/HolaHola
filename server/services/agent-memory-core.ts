// Agent Memory core service — DB-canonical shared docs.
//
// .agents/memory/MEMORY.md and every .agents/memory/<slug>.md file are
// generated projections of the agent_memory_topics / agent_memory_entries /
// agent_memory_topic_blocks tables. This module holds all read/write/render
// logic. It has no CLI or HTTP surface of its own — server/scripts/
// agent-memory-cli.ts (a later phase) is the only sanctioned writer that end
// users or other hats invoke.
//
// See docs/superpowers/specs/2026-09-21-shared-docs-db-canonical-design.md
// and docs/superpowers/plans/2026-09-21-shared-docs-db-canonical-implementation-plan.md
// (Phase 2) for the design this implements.
//
// Every write here does three things synchronously, in order: (1) the DB
// write, (2) regenerate and write the affected file(s) to disk, (3) return
// evidence of other actors' recent activity on the same topic. Step 2 is
// never wrapped in a try/catch that swallows failures — a regeneration
// failure after a successful DB write must throw and propagate, never leave
// the DB and the file silently inconsistent. `regenerateAll()` is the
// recovery path: it re-renders every file from current DB state alone.

import { promises as fs } from "node:fs";
import path from "node:path";
import { and, asc, desc, eq, gt, isNull, sql } from "drizzle-orm";
import {
  agentMemoryEntries,
  agentMemoryTopicBlocks,
  agentMemoryTopics,
  type AgentMemoryEntry,
  type AgentMemoryTopicBlock,
} from "@shared/schema";
import { getSharedDb } from "../db";

// ===== Constants ================================================================

// Fixed, not templated — must read identically regardless of which file a
// hat happens to open first. Lives at the top of the generated MEMORY.md,
// above the entry index. A parallel copy prepended to
// docs/shared-agent-instructions.md is a later phase's concern.
export const AGENT_MEMORY_PREAMBLE = `> **You are not alone.** This file is generated from the \`agent_memory_*\` database tables — other hats (Replit Agent, Claude Code, Gemini, HolaHola runtime agents) may be reading and writing it in the same window you are. Never hand-edit this file or any \`.agents/memory/<topic>.md\` file directly; every change goes through \`server/scripts/agent-memory-cli.ts\`, which writes the database first and regenerates the file from it. A hand-edit here will be silently overwritten the next time anyone runs a CLI write.`;

// AGENT_MEMORY_TEST_FILES_DIR lets a disposable-database test point generated
// files at a scratch directory instead of the real .agents/memory/ — without
// it, a test running against a disposable Neon branch would still overwrite
// this checkout's real MEMORY.md and topic files with content generated from
// throwaway test rows. Read once at module load, like NEON_SHARED_DATABASE_URL
// in ../db, so it must be set in the process environment before this module
// is first imported (before spawning `tsx`, not from within the test file).
const MEMORY_DIR = process.env.AGENT_MEMORY_TEST_FILES_DIR
  ? path.resolve(process.env.AGENT_MEMORY_TEST_FILES_DIR)
  : path.join(process.cwd(), ".agents/memory");
const MEMORY_INDEX_PATH = path.join(MEMORY_DIR, "MEMORY.md");
const RECENT_ACTIVITY_WINDOW_MS = 24 * 60 * 60 * 1000;

// Live-state files consulted by computeLiveStatusBanner() below. These are
// plain workspace-relative paths (not test-overridable) because
// computeLiveStatusBanner() short-circuits entirely under
// AGENT_MEMORY_TEST_FILES_DIR -- see that function for why.
const LIVE_STATE_DIR = path.join(process.cwd(), ".local");
const STALE_CHANNEL_ALERT_PATH = path.join(LIVE_STATE_DIR, "stale-channel-alert.md");
const LISTENER_BOOT_ALERT_PATH = path.join(LIVE_STATE_DIR, "listener-boot-alert.md");
const EPISODE_CAPTURE_STATUS_PATH = path.join(LIVE_STATE_DIR, "episode-capture-status.md");

function topicFilePath(topicSlug: string): string {
  return path.join(MEMORY_DIR, `${topicSlug}.md`);
}

// ===== Errors ====================================================================

export type AgentMemoryErrorKind = "NOT_FOUND" | "CONFLICT" | "VALIDATION";

export class AgentMemoryError extends Error {
  constructor(
    public readonly kind: AgentMemoryErrorKind,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "AgentMemoryError";
  }
}

// The topic_slug foreign key is the only one this module ever needs to
// detect by name. Drizzle/postgres wrap the real driver error (with its
// SQLSTATE and constraint name) inside a `cause` chain rather than exposing
// them on the outer thrown error, so a shallow `error.code` check silently
// never matches. Walk a small bounded chain and require the exact
// allowlisted constraint name, not just any 23503, so an unrelated future FK
// can never be misclassified as "unknown topic". See
// .agents/memory/postgres-hermetic-testing-gotchas.md ("wrapped structured
// errors") and the identical pattern in coordination-windows-generation.ts's
// isCoordinationPreparationUniqueConflict / postgresCode.
const TOPIC_SLUG_FK_CONSTRAINTS = new Set([
  "agent_memory_entries_topic_slug_agent_memory_topics_slug_fk",
  "agent_memory_topic_blocks_topic_slug_agent_memory_topics_slug_fk",
]);

function isUnknownTopicSlugViolation(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current && typeof current === "object"; depth += 1) {
    const value = current as { code?: unknown; constraint?: unknown; cause?: unknown };
    if (value.code === "23503" && typeof value.constraint === "string" && TOPIC_SLUG_FK_CONSTRAINTS.has(value.constraint)) {
      return true;
    }
    current = value.cause;
  }
  return false;
}

// ===== Order-key generation ======================================================
//
// order_key is a base-36 string treated as a fraction with implicit trailing
// zeros: "" < "0" < "05" < "1" < "1z" < "1zi" < "2" ... exactly matching
// plain JS/SQL string comparison. This lets an append or an insert-between
// always find a key strictly between two neighbors without ever rewriting an
// existing row's key.
//
// keyBetween(lo, hi) returns a key k such that lo < k < hi (as strings).
// lo === undefined means "no lower bound" (insert at the very start).
// hi === undefined means "no upper bound" (append at the very end).

const ORDER_KEY_ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";
const ORDER_KEY_BASE = ORDER_KEY_ALPHABET.length; // 36

export function keyBetween(lo: string | undefined, hi: string | undefined): string {
  if (lo !== undefined && hi !== undefined && lo >= hi) {
    throw new Error(`keyBetween: lo (${JSON.stringify(lo)}) must sort strictly before hi (${JSON.stringify(hi)})`);
  }
  const loStr = lo ?? "";
  let hiUnbounded = hi === undefined;
  const hiStr = hi ?? "";
  let result = "";
  let i = 0;
  for (;;) {
    const loDigit = i < loStr.length ? ORDER_KEY_ALPHABET.indexOf(loStr[i]) : 0;
    const hiDigit = hiUnbounded ? ORDER_KEY_BASE : i < hiStr.length ? ORDER_KEY_ALPHABET.indexOf(hiStr[i]) : 0;
    const gap = hiDigit - loDigit;
    if (gap >= 2) {
      const midDigit = loDigit + Math.floor(gap / 2);
      result += ORDER_KEY_ALPHABET[midDigit];
      return result;
    }
    // gap is 0 or 1: no room at this digit alone. Emit lo's digit and go
    // deeper. Once gap is exactly 1, the digit we just emitted is already
    // strictly less than hi's digit at this position, so hi can never
    // constrain any later position — switch it to unbounded so the
    // recursion is guaranteed to terminate against lo's own (finite) tail.
    if (gap === 1) hiUnbounded = true;
    result += ORDER_KEY_ALPHABET[loDigit];
    i++;
    if (i > 512) {
      // Unreachable given the precondition above, kept as a hard backstop
      // against an infinite loop from a future change to this function.
      throw new Error(`keyBetween: exceeded maximum digit depth between ${JSON.stringify(lo)} and ${JSON.stringify(hi)}`);
    }
  }
}

// ===== Recent-activity evidence ==================================================

export interface RecentActivityEvidence {
  topicSlug: string;
  otherActors: string[];
  windowHours: 24;
}

export async function recentActivity(topicSlug: string, excludeActor: string): Promise<RecentActivityEvidence> {
  const db = getSharedDb();
  const since = new Date(Date.now() - RECENT_ACTIVITY_WINDOW_MS);
  const [entryActors, blockActors] = await Promise.all([
    db
      .selectDistinct({ actor: agentMemoryEntries.createdByActor })
      .from(agentMemoryEntries)
      .where(and(eq(agentMemoryEntries.topicSlug, topicSlug), gt(agentMemoryEntries.createdAt, since))),
    db
      .selectDistinct({ actor: agentMemoryTopicBlocks.authorActor })
      .from(agentMemoryTopicBlocks)
      .where(and(eq(agentMemoryTopicBlocks.topicSlug, topicSlug), gt(agentMemoryTopicBlocks.createdAt, since))),
  ]);
  const actors = new Set<string>();
  for (const row of entryActors) actors.add(row.actor);
  for (const row of blockActors) actors.add(row.actor);
  actors.delete(excludeActor);
  return { topicSlug, otherActors: [...actors].sort(), windowHours: 24 };
}

// ===== Rendering (pure formatters over already-fetched rows) ====================

export async function fetchMemoryIndexEntries(): Promise<AgentMemoryEntry[]> {
  const db = getSharedDb();
  return db
    .select()
    .from(agentMemoryEntries)
    .where(isNull(agentMemoryEntries.deletedAt))
    .orderBy(asc(agentMemoryEntries.createdAt));
}

export function formatMemoryIndex(entries: readonly AgentMemoryEntry[], liveBanner = ""): string {
  const lines = entries.map((entry) => `- [${entry.title}](${entry.topicSlug}.md) — ${entry.hook}`);
  // liveBanner is "" in the common case, which collapses this to the exact
  // original `${AGENT_MEMORY_PREAMBLE}\n\n${lines...}` — the blank line
  // comes from the two \n's either side of an empty banner, not from a
  // separate literal. See computeLiveStatusBanner() for what populates it.
  return `${AGENT_MEMORY_PREAMBLE}\n${liveBanner}\n${lines.join("\n")}\n`;
}

// ===== Live-status banner =========================================================
//
// Session-start protocol compliance depends on a hat actually opening
// .local/stale-channel-alert.md and .local/episode-capture-status.md before
// its first output -- both require active discipline to read and neither is
// auto-injected. MEMORY.md is the one artifact guaranteed to reach every
// hat's context on every turn, so folding a short live-state headline into
// its generated banner closes that gap: a hat that skips the live-state
// files still sees the headline the moment MEMORY.md is (re)generated.
//
// Read-only and best-effort by design. A missing or unreadable live-state
// file is the common/healthy case (ENOENT — no alert open, or no rolling
// episode active), not an error, and any other failure here must never
// block memory rendering, so every branch swallows its own error.
//
// Short-circuits entirely under AGENT_MEMORY_TEST_FILES_DIR: that env var
// marks a hermetic test run against a disposable DB + scratch output dir,
// but the live-state files below live under this checkout's real .local/
// with no parallel scratch location. Reading them during such a test would
// let whatever the real workspace happens to contain (or not, mid-session)
// leak into content-equality assertions (e.g.
// test-agent-memory-drift-guard.ts) that never intended to depend on it.
export async function computeLiveStatusBanner(): Promise<string> {
  if (process.env.AGENT_MEMORY_TEST_FILES_DIR) return "";

  const lines: string[] = [];

  try {
    const alert = await fs.readFile(STALE_CHANNEL_ALERT_PATH, "utf8");
    // "silent for 10+ min" is the one substring common to all three writers'
    // phrasing ("channels have been silent for 10+ min" vs "channels silent
    // for 10+ min" -- agent-session-autosave.ts's main cycle, its boot-seed
    // path, and capture-watchdog.ts each word it slightly differently).
    const headline =
      alert.split("\n").find((line) => line.includes("silent for 10+ min")) ??
      alert.split("\n").find((line) => line.trim().length > 0) ??
      "";
    lines.push(`🔴 **Unread stale-channel alert** (\`.local/stale-channel-alert.md\`): ${headline.replace(/\*/g, "").trim().slice(0, 200)}`);
  } catch {
    // ENOENT is the healthy/expected state -- no alert currently open.
  }

  try {
    const boot = await fs.readFile(LISTENER_BOOT_ALERT_PATH, "utf8");
    const headline = boot.split("\n").find((line) => line.trim().length > 0) ?? "";
    if (headline) lines.push(`🔴 **Coordination listener boot failed** (\`.local/listener-boot-alert.md\`): ${headline.slice(0, 200)}`);
  } catch {
    // ENOENT is the healthy state -- no failed boot recorded.
  }

  try {
    const status = await fs.readFile(EPISODE_CAPTURE_STATUS_PATH, "utf8");
    const missing = [...status.matchAll(/⚠️ MISSING (\w+):/g)].map((match) => match[1]);
    if (missing.length > 0) {
      lines.push(
        `🟡 **Inner-life capture gap**: \`.local/episode-capture-status.md\` last reported missing ${missing.join("/")} in the rolling episode file — read it before your next output.`,
      );
    }
  } catch {
    // No active rolling episode / file not present -- nothing to report.
  }

  if (lines.length === 0) return "";
  return `\n${lines.join("\n")}\n`;
}

export async function fetchTopicBlocks(topicSlug: string): Promise<AgentMemoryTopicBlock[]> {
  const db = getSharedDb();
  return db
    .select()
    .from(agentMemoryTopicBlocks)
    .where(and(eq(agentMemoryTopicBlocks.topicSlug, topicSlug), isNull(agentMemoryTopicBlocks.deletedAt)))
    .orderBy(asc(agentMemoryTopicBlocks.orderKey));
}

export function formatTopicFile(blocks: readonly AgentMemoryTopicBlock[]): string {
  const sections = blocks.map((block) => (block.heading ? `## ${block.heading}\n\n${block.bodyMarkdown}` : block.bodyMarkdown));
  return `${sections.join("\n\n")}\n`;
}

export async function writeMemoryIndexFile(): Promise<string> {
  const entries = await fetchMemoryIndexEntries();
  const liveBanner = await computeLiveStatusBanner();
  const content = formatMemoryIndex(entries, liveBanner);
  await fs.mkdir(MEMORY_DIR, { recursive: true });
  await fs.writeFile(MEMORY_INDEX_PATH, content, "utf8");
  return MEMORY_INDEX_PATH;
}

// Call sites outside the CLI — specifically wherever
// .local/stale-channel-alert.md is written or cleared
// (agent-session-autosave.ts, capture-watchdog.ts) — use this to get the
// live-status banner above refreshed immediately, instead of waiting for the
// next CLI-driven memory write to happen to pick it up. Fire-and-forget by
// construction: a failure here must never interrupt the caller's own
// (unrelated) work, matching the existing non-fatal style at those call
// sites.
export function refreshMemoryIndexBestEffort(caller: string): void {
  writeMemoryIndexFile().catch((error) => {
    console.warn(
      `[AgentMemory] best-effort MEMORY.md refresh from "${caller}" failed (non-fatal):`,
      error instanceof Error ? error.message : error,
    );
  });
}

export async function writeTopicFile(topicSlug: string): Promise<string> {
  const blocks = await fetchTopicBlocks(topicSlug);
  const content = formatTopicFile(blocks);
  await fs.mkdir(MEMORY_DIR, { recursive: true });
  const filePath = topicFilePath(topicSlug);
  await fs.writeFile(filePath, content, "utf8");
  return filePath;
}

export async function fetchAllTopicSlugs(): Promise<string[]> {
  const db = getSharedDb();
  const topics = await db.select({ slug: agentMemoryTopics.slug }).from(agentMemoryTopics).orderBy(asc(agentMemoryTopics.slug));
  return topics.map((topic) => topic.slug);
}

export async function regenerateAll(): Promise<{ indexPath: string; topicPaths: string[] }> {
  const topicSlugs = await fetchAllTopicSlugs();
  const indexPath = await writeMemoryIndexFile();
  const topicPaths: string[] = [];
  for (const slug of topicSlugs) {
    topicPaths.push(await writeTopicFile(slug));
  }
  return { indexPath, topicPaths };
}

// ===== Entries ====================================================================

export interface AddEntryInput {
  topicSlug: string;
  title: string;
  hook: string;
  actor: string;
}

export async function addEntry(input: AddEntryInput): Promise<{ entry: AgentMemoryEntry; evidence: RecentActivityEvidence }> {
  const db = getSharedDb();
  let entry: AgentMemoryEntry;
  try {
    const [row] = await db
      .insert(agentMemoryEntries)
      .values({
        topicSlug: input.topicSlug,
        title: input.title,
        hook: input.hook,
        createdByActor: input.actor,
      })
      .returning();
    entry = row;
  } catch (error) {
    if (isUnknownTopicSlugViolation(error)) {
      throw new AgentMemoryError(
        "VALIDATION",
        `Topic "${input.topicSlug}" does not exist — create it first with add-block`,
        { topicSlug: input.topicSlug },
      );
    }
    throw error;
  }
  await writeMemoryIndexFile();
  const evidence = await recentActivity(input.topicSlug, input.actor);
  return { entry, evidence };
}

// A zero-row CAS update means either the version moved under the caller
// (another edit landed first) or the row was soft-deleted out from under
// them -- deletion never touches `version`, so those are the only two ways
// the WHERE clause (id + version + deletedAt IS NULL) can match nothing for
// an id that still exists. Callers (the CLI in particular) must not collapse
// this back into one "stale version" message: a deleted row's version often
// still matches exactly what the caller passed, which reads as a CLI bug
// rather than the real cause. See
// .agents/memory/agent-memory-cas-failure-reason.md.
export type CasFailureReason = "deleted" | "version_mismatch";
export type CasResult<T> =
  | { ok: true; value: T; evidence: RecentActivityEvidence }
  | { ok: false; current: T; reason: CasFailureReason };

export interface EditEntryInput {
  entryId: string;
  baseVersion: number;
  hook: string;
  actor: string;
}

export async function editEntry(input: EditEntryInput): Promise<CasResult<AgentMemoryEntry>> {
  const db = getSharedDb();
  const updated = await db
    .update(agentMemoryEntries)
    .set({ hook: input.hook, version: sql`${agentMemoryEntries.version} + 1` })
    .where(
      and(
        eq(agentMemoryEntries.id, input.entryId),
        eq(agentMemoryEntries.version, input.baseVersion),
        isNull(agentMemoryEntries.deletedAt),
      ),
    )
    .returning();

  if (updated.length === 0) {
    const [current] = await db.select().from(agentMemoryEntries).where(eq(agentMemoryEntries.id, input.entryId));
    if (!current) {
      throw new AgentMemoryError("NOT_FOUND", `Entry "${input.entryId}" not found`, { entryId: input.entryId });
    }
    // Deletion never bumps version, so a non-null deletedAt is the reliable
    // signal that deletion (not a version race) is why the update matched
    // nothing -- even when current.version happens to equal input.baseVersion.
    const reason: CasFailureReason = current.deletedAt !== null ? "deleted" : "version_mismatch";
    return { ok: false, current, reason };
  }

  await writeMemoryIndexFile();
  const evidence = await recentActivity(updated[0].topicSlug, input.actor);
  return { ok: true, value: updated[0], evidence };
}

export interface RemoveResult<T> {
  value: T;
  alreadyDeleted: boolean;
  evidence?: RecentActivityEvidence;
}

export async function removeEntry(entryId: string, actor: string): Promise<RemoveResult<AgentMemoryEntry>> {
  const db = getSharedDb();
  const updated = await db
    .update(agentMemoryEntries)
    .set({ deletedAt: new Date(), deletedByActor: actor })
    .where(and(eq(agentMemoryEntries.id, entryId), isNull(agentMemoryEntries.deletedAt)))
    .returning();

  if (updated.length > 0) {
    await writeMemoryIndexFile();
    const evidence = await recentActivity(updated[0].topicSlug, actor);
    return { value: updated[0], alreadyDeleted: false, evidence };
  }

  const [existing] = await db.select().from(agentMemoryEntries).where(eq(agentMemoryEntries.id, entryId));
  if (!existing) {
    throw new AgentMemoryError("NOT_FOUND", `Entry "${entryId}" not found`, { entryId });
  }
  return { value: existing, alreadyDeleted: true };
}

// ===== Blocks =====================================================================

export interface AddBlockInput {
  topicSlug: string;
  heading?: string;
  bodyMarkdown: string;
  actor: string;
  afterBlockId?: string;
}

// db/tx param is typed loosely (not ReturnType<typeof getSharedDb>) because
// callers pass either the pool-level db or a transaction handle from
// db.transaction(), and Drizzle gives those two call sites structurally
// incompatible types for the same query-builder surface this function uses.
async function computeOrderKey(
  db: { select: ReturnType<typeof getSharedDb>["select"] },
  topicSlug: string,
  afterBlockId: string | undefined,
): Promise<string> {
  if (afterBlockId) {
    const rows = await db
      .select({ id: agentMemoryTopicBlocks.id, orderKey: agentMemoryTopicBlocks.orderKey })
      .from(agentMemoryTopicBlocks)
      .where(eq(agentMemoryTopicBlocks.topicSlug, topicSlug))
      .orderBy(asc(agentMemoryTopicBlocks.orderKey));
    const idx = rows.findIndex((row) => row.id === afterBlockId);
    if (idx === -1) {
      throw new AgentMemoryError("NOT_FOUND", `Block "${afterBlockId}" not found in topic "${topicSlug}"`, {
        afterBlockId,
        topicSlug,
      });
    }
    const lower = rows[idx].orderKey;
    const upper = idx + 1 < rows.length ? rows[idx + 1].orderKey : undefined;
    return keyBetween(lower, upper);
  }

  const [last] = await db
    .select({ orderKey: agentMemoryTopicBlocks.orderKey })
    .from(agentMemoryTopicBlocks)
    .where(eq(agentMemoryTopicBlocks.topicSlug, topicSlug))
    .orderBy(desc(agentMemoryTopicBlocks.orderKey))
    .limit(1);
  return keyBetween(last?.orderKey, undefined);
}

export async function addBlock(input: AddBlockInput): Promise<{ block: AgentMemoryTopicBlock; evidence: RecentActivityEvidence }> {
  const db = getSharedDb();

  // The whole append decision -- "what does 'currently last/neighboring
  // block' mean right now" plus the insert that acts on that answer -- must
  // be one atomic unit, or two true concurrent appends to the same brand-new
  // topic both read "no rows yet", both compute keyBetween(undefined,
  // undefined) (a pure function -- same inputs, same output), and the second
  // insert dies on uq_agent_memory_topic_blocks_order instead of landing
  // after the first the way invariant 2 (no hat ever loses a concurrent
  // contribution) requires. A transaction alone doesn't fix this under
  // READ COMMITTED (each statement sees a fresh snapshot, not the
  // transaction-start snapshot) -- the FOR UPDATE lock on the topic's own
  // row is what actually serializes concurrent appends to the same topic,
  // while appends to different topics still proceed fully in parallel.
  // Covered by test-agent-memory-concurrent-write-postgres.test.ts.
  const block = await db.transaction(async (tx) => {
    // First-block-creates-topic: an unknown topic_slug is created
    // implicitly. ON CONFLICT DO NOTHING makes two concurrent first-block
    // writers race safely at the DB level -- whichever loses this insert
    // race blocks here until the winner commits or rolls back, matching the
    // FOR UPDATE lock immediately below.
    await tx.insert(agentMemoryTopics).values({ slug: input.topicSlug }).onConflictDoNothing({ target: agentMemoryTopics.slug });

    const [topic] = await tx.select({ slug: agentMemoryTopics.slug }).from(agentMemoryTopics)
      .where(eq(agentMemoryTopics.slug, input.topicSlug)).for("update");
    if (!topic) {
      // Unreachable in practice (the upsert above guarantees the row), but
      // narrows the type and fails loudly instead of computing an order key
      // against a topic that turned out not to exist.
      throw new AgentMemoryError("NOT_FOUND", `Topic "${input.topicSlug}" does not exist`, { topicSlug: input.topicSlug });
    }

    const orderKey = await computeOrderKey(tx, input.topicSlug, input.afterBlockId);

    const [inserted] = await tx
      .insert(agentMemoryTopicBlocks)
      .values({
        topicSlug: input.topicSlug,
        orderKey,
        heading: input.heading,
        bodyMarkdown: input.bodyMarkdown,
        authorActor: input.actor,
      })
      .returning();
    return inserted;
  });

  await writeTopicFile(input.topicSlug);
  const evidence = await recentActivity(input.topicSlug, input.actor);
  return { block, evidence };
}

export interface EditBlockInput {
  blockId: string;
  baseVersion: number;
  bodyMarkdown: string;
  actor: string;
}

export async function editBlock(input: EditBlockInput): Promise<CasResult<AgentMemoryTopicBlock>> {
  const db = getSharedDb();
  const updated = await db
    .update(agentMemoryTopicBlocks)
    .set({ bodyMarkdown: input.bodyMarkdown, version: sql`${agentMemoryTopicBlocks.version} + 1`, updatedAt: new Date() })
    .where(
      and(
        eq(agentMemoryTopicBlocks.id, input.blockId),
        eq(agentMemoryTopicBlocks.version, input.baseVersion),
        isNull(agentMemoryTopicBlocks.deletedAt),
      ),
    )
    .returning();

  if (updated.length === 0) {
    const [current] = await db.select().from(agentMemoryTopicBlocks).where(eq(agentMemoryTopicBlocks.id, input.blockId));
    if (!current) {
      throw new AgentMemoryError("NOT_FOUND", `Block "${input.blockId}" not found`, { blockId: input.blockId });
    }
    // See the matching comment in editEntry(): deletion never bumps version,
    // so deletedAt is the reliable signal, not a version comparison.
    const reason: CasFailureReason = current.deletedAt !== null ? "deleted" : "version_mismatch";
    return { ok: false, current, reason };
  }

  await writeTopicFile(updated[0].topicSlug);
  const evidence = await recentActivity(updated[0].topicSlug, input.actor);
  return { ok: true, value: updated[0], evidence };
}

export async function removeBlock(blockId: string, actor: string): Promise<RemoveResult<AgentMemoryTopicBlock>> {
  const db = getSharedDb();
  const updated = await db
    .update(agentMemoryTopicBlocks)
    .set({ deletedAt: new Date(), deletedByActor: actor, updatedAt: new Date() })
    .where(and(eq(agentMemoryTopicBlocks.id, blockId), isNull(agentMemoryTopicBlocks.deletedAt)))
    .returning();

  if (updated.length > 0) {
    await writeTopicFile(updated[0].topicSlug);
    const evidence = await recentActivity(updated[0].topicSlug, actor);
    return { value: updated[0], alreadyDeleted: false, evidence };
  }

  const [existing] = await db.select().from(agentMemoryTopicBlocks).where(eq(agentMemoryTopicBlocks.id, blockId));
  if (!existing) {
    throw new AgentMemoryError("NOT_FOUND", `Block "${blockId}" not found`, { blockId });
  }
  return { value: existing, alreadyDeleted: true };
}
