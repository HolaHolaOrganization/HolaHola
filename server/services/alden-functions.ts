import Anthropic from "@anthropic-ai/sdk";
import { aldenToolRefusal, type AldenToolAllowlist } from './alden-tool-allowlist';
import { aldenWriteToolRefusal } from './alden-write-boundary';
import { aldenReadablePath, aldenSearchRoots, classifyAldenReadPath, resolveAldenReadPath, secretContentReason, secretPathReason } from './alden-read-policy';
import { getSharedDb } from "../neon-db";
import { getUserDb, getMonitoringDb } from "../db";
import { 
  voiceSessions, 
  sofiaIssueReports,
  editorInsights,
  aldenNotifications,
  users,
  conversations,
  aiCostLogs,
  aldenConfig,
  aldenEngineSwitches,
  agentNorthStar,
  conversationMemories,
} from "@shared/schema";
import type { CoordinationActorId, CoordinationCredentialCapability } from "@shared/schema";
import { COORDINATION_ACTOR_IDS, COORDINATION_CREDENTIAL_CAPABILITIES } from "@shared/schema";
import { isCentralReadScope } from "@shared/central-read-policy";
import {
  adminRevokeRuntimeCredentials,
  listCoordinationRuntimeRegistrations,
} from "./coordination-credential-broker";
import {
  RuntimeOnboardingError,
  cancelRuntimeOnboardingInvitation,
  getAldenRuntimeOnboardingStatus,
  listAldenRuntimeOnboarding,
  prepareRuntimeOnboardingInvitation,
  trustedRuntimeOnboardingEndpoint,
} from "./runtime-onboarding-service";
import {
  startNextEpisode,
  getCurrentRollingEpisode,
} from "./episode-lifecycle-service";
import { sql, desc, eq, and, gte, isNull, inArray } from "drizzle-orm";
import { computeHealthStatus } from "./voice-health-monitor";
import { founderCollabService } from "./founder-collaboration-service";
import * as fs from "fs";
import * as path from "path";
import { execFileSync, execSync, spawn } from "child_process";
import { randomUUID } from "crypto";
import { aldenActivity } from "./alden-activity-emitter";
import { getMonitoringSnapshots, analyzePatterns } from "./monitoring-service";
import { workspaceResolution } from "./workspace-root";
import {
  createCoordinationThread,
  appendCoordinationEvent,
  getCoordinationThread,
} from "./coordination-ledger-service";
import { listCoordinationInbox } from "./coordination-inbox-service";
import { listAldenCoordinationInbox, readAldenCoordinationMessage } from "./alden-coordination-read";
import { assertMemoryId, boundEcho, buildMemoryDiscovery, memorySearchLimit, readMemoryContentChunk } from "./alden-memory-read";
import { OPERATIONS_CATALOG, toPublicOperationManifest } from "./operations-catalog";
import { checkExpectedContent } from "./alden-verbatim";
import { activeRegistrationsFor, buildActorBriefing } from "./alden-actor-briefing";
import { coordinationMcpToolNames } from "./mcp-coordination-tools";
import { applyHandoffSection, shareAldenHandoffNote } from "./alden-handoff-shared-spec";
import { listAldenSharedSpecReviews, readAldenSharedSpecReview, claimAldenSharedSpecReview, decideAldenSharedSpecReview } from "./alden-shared-spec-review";
import { buildAldenReviewSourcePage, type AldenReviewReadSession } from "./alden-review-source";

// Was hardcoded to '/home/runner/workspace' -- a Replit-only container path.
// Once production ran on Render (post-DNS-swap), every file/shell tool here
// (read_file, list_directory, search_code, run_shell) broke: read/list saw
// "Directory not found", and execSync with a nonexistent cwd surfaced as the
// misleading "spawnSync /bin/sh ENOENT" (Node reports a missing cwd as if the
// shell binary itself were missing). workspaceResolution is the same portable
// root resolver the canonical capture system uses: explicit env override ->
// REPL_HOME (Replit) -> process.cwd() (Render's /app, Docker WORKDIR)
// -- with a loud startup assertion instead of a silent wrong guess.
const WORKSPACE_ROOT = workspaceResolution.root;

function safePath(filePath: string): string {
  const resolved = path.resolve(WORKSPACE_ROOT, filePath.replace(/^\//, ''));
  if (!resolved.startsWith(WORKSPACE_ROOT)) throw new Error('Path outside workspace');
  return resolved;
}

let _rgAvailableCache: boolean | null = null;
export type AldenTool = Anthropic.Tool & { gemini_description?: string };
const ALDEN_COORDINATION_ACTOR_IDS = COORDINATION_ACTOR_IDS.filter(
  (actor): actor is Exclude<CoordinationActorId, 'coordination-system'> => actor !== 'coordination-system',
);
const ALDEN_COORDINATION_RECIPIENT_IDS = ALDEN_COORDINATION_ACTOR_IDS.filter((actor) => actor !== 'alden');

export const ALDEN_TOOLS: AldenTool[] = [
  {
    name: "get_system_health",
    description: "Get real-time system health: voice pipeline status (green/yellow/red), active voice sessions count, server uptime, and TTS provider status.",
    input_schema: {
      type: "object" as const,
      properties: {},
    },
  },
  {
    name: "get_database_stats",
    description: "Get database statistics: table row counts for key tables (users, conversations, voice sessions, vocabulary), connection pool status, and recent growth metrics.",
    input_schema: {
      type: "object" as const,
      properties: {},
    },
  },
  {
    name: "get_user_analytics",
    description: "Get user analytics: total users, active learners (last 7 days), new registrations (last 30 days), language distribution, and subscription tier breakdown.",
    input_schema: {
      type: "object" as const,
      properties: {},
    },
  },
  {
    name: "get_voice_session_metrics",
    description: "Get voice session metrics: total sessions, sessions today, average duration, TTS provider usage breakdown, error rate, and recent session activity.",
    input_schema: {
      type: "object" as const,
      properties: {
        days: { type: "number" as const, description: "Number of days to analyze (default 7, max 30)" },
      },
    },
  },
  {
    name: "get_recent_errors",
    description: "Get recent errors and issues: voice pipeline failures, API errors, and Sofia-reported issues from the last N hours.",
    input_schema: {
      type: "object" as const,
      properties: {
        hours: { type: "number" as const, description: "Hours to look back (default 24, max 72)" },
      },
    },
  },
  {
    name: "get_voice_pipeline_events",
    description: "Query the GL audio pipeline event log for a specific voice session. Returns a timeline of key events (gl_generation_complete, gl_audio_subturn_sealed, gl_processing_pending_fired, gl_transcripts_flushed, gl_watchdog_timeout, client_processing_timeout, client_voice_error) with timestamps and deltas between events. Use sessionId to inspect a specific session, or leave blank to see recent events across all sessions.",
    input_schema: {
      type: "object" as const,
      properties: {
        sessionId: { type: "string" as const, description: "Voice session ID to inspect (optional — omit for recent events across all sessions)" },
        eventType: { type: "string" as const, description: "Filter by event type, e.g. 'gl_watchdog_timeout' or 'client_processing_timeout'" },
        limit: { type: "number" as const, description: "Max events to return (default 50, max 200)" },
      },
    },
  },
  {
    name: "get_sofia_report",
    description: "Get Sofia's latest health digests and issue reports. Shows what Sofia has found through her autonomous monitoring.",
    input_schema: {
      type: "object" as const,
      properties: {
        limit: { type: "number" as const, description: "Number of reports to retrieve (default 5, max 20)" },
      },
    },
  },
  {
    name: "search_editor_memories",
    description: "Search Alden's persistent memory (editor insights) for past context, architectural decisions, debugging notes, and project history.",
    gemini_description: "Search Alden's personal, persistent memory for specific insights, architectural rules, debugging strategies, or project decisions I have saved. This is my internal knowledge base — use it when I need to recall something I have previously learned or decided.",
    input_schema: {
      type: "object" as const,
      properties: {
        query: { type: "string" as const, description: "Search term or topic to find in memories" },
        category: { 
          type: "string" as const, 
          description: "Filter by category: philosophy, architecture, relationship, debugging, personality, workflow, context, journal" 
        },
      },
      required: ["query"],
    },
  },
  {
    name: "read_conversation_memories",
    description: "Search the shared conversation_memories archive: curated records of significant conversations between David, Daniela, the Agent and the team. This finds records; it does not read long ones. Each match returns id, title, importance, entryType, tags, arcName, extendsMemoryId, recordedAt, summary, totalCharacters (UTF-16 code units), contentSha256 (a version token for the content) and contentComplete. If contentComplete is true, content is the record's full original text. If it is false, contentExcerpt is only the opening: never quote it as the whole record or conclude from it that something is absent from the record; read the full text with read_conversation_memory_content. Everything must fit one bounded result, so when more or longer records match, text fields can be shortened, even to empty, and each shortened field is marked by its flag set to false (titleComplete, summaryComplete, tagsComplete, arcNameComplete, entryTypeComplete, speakerExcerptComplete). query, arc and speaker combine; related_to returns a chain instead and ignores them. A result that cannot fit returns an error, never a cut result.",
    gemini_description: "Find past significant conversations between David, Daniela, the Agent and the team, by keyword, arc, speaker or memory chain. This finds records; it does not read long ones in full. Each match gives its id, title, summary, tags, arc, date, length and contentComplete. If contentComplete is true, content is the full original text. If it is false, contentExcerpt is only the opening: not the whole record, and not evidence that anything is missing from it; read the record with read_conversation_memory_content. When many records match, fields can be shortened or empty, and each shortened field is marked by its ...Complete flag set to false. speakerExcerpt is a sample of where that speaker's lines are, not their exact words.",
    input_schema: {
      type: "object" as const,
      properties: {
        query: { type: "string" as const, description: "Case-insensitive text to find in a memory's title, summary or full content (substring match, not semantic search). Title matches rank first, then importance, then most recent. Combines with arc and speaker." },
        arc: { type: "string" as const, description: "Exact arc name to restrict to, e.g. 'HolaHola Episodes', 'daniela-emergence', 'white-wall'. Use list_conversation_arcs to get exact names." },
        limit: { type: "number" as const, description: "Maximum matches for query, arc and speaker searches: a positive whole number, default 5, at most 15. Ignored with related_to. More matches means shorter fields per match." },
        speaker: { type: "string" as const, description: "A speaker name, e.g. 'David' or 'Daniela'. Keeps only memories containing that speaker's bracketed turn tag (e.g. [DAVID]). Each match adds speakerExcerpt: up to the first 8 lines found under that tag, trimmed and joined with ' / '. It is a pointer to where they spoke, not their exact wording; read the content for the original words." },
        related_to: { type: "string" as const, description: "A conversation memory id (UUID). Returns that memory as anchor, its ancestors (following extends_memory_id upward, up to 10, oldest first), and up to 10 descendants: memories that directly extend the anchor or one of its ancestors. Descendants can include sibling branches and repeat an ancestor, and do not include the anchor's grandchildren. Ignores query, arc, speaker and limit." },
      },
      required: [],
    },
  },
  {
    name: "read_conversation_memory_content",
    description: "Read the exact original text of one conversation memory, verbatim, in bounded chunks; offsets count UTF-16 code units. To read the whole text: start at offset 0 without expected_content_sha256, then pass each result's nextOffset as offset and the first result's contentSha256 as expected_content_sha256, until complete is true, and join the chunks in offset order. Any offset other than 0 requires expected_content_sha256: the contentSha256 from the first chunk, or from read_conversation_memories. A read that starts past 0 returns only part of the record. If the record changed since that contentSha256, the read is refused with snapshot_changed: discard the chunks read so far and start again at offset 0 without the old value.",
    gemini_description: "Read the exact original words of one conversation memory in bounded chunks. To read it all: start at offset 0 with no expected_content_sha256, then pass each nextOffset as offset and the first chunk's contentSha256 as expected_content_sha256 until complete is true, and join the chunks in offset order. Any offset other than 0 needs expected_content_sha256, and a read that starts past 0 is only part of the record. If the record changed meanwhile, the read is refused with snapshot_changed: discard the chunks and start again at offset 0 without the old value.",
    input_schema: {
      type: "object" as const,
      properties: {
        id: { type: "string" as const, description: "The conversation memory id (UUID), from read_conversation_memories." },
        offset: { type: "number" as const, description: "Where to start, in UTF-16 code units; default 0. To continue, pass the previous result's nextOffset. Must not split a surrogate pair." },
        expected_content_sha256: { type: "string" as const, description: "Required whenever offset is not 0: the contentSha256 of the version being read, from the first chunk or from read_conversation_memories. Omit it when starting again at offset 0 after snapshot_changed." },
      },
      required: ["id"],
    },
  },
  {
    name: "list_conversation_arcs",
    description: "List all conversation arcs — named narrative threads that group related conversation_memories entries across multiple sessions. Returns arc name, entry count, and date range. Use this to discover what threads exist before using read_conversation_memories with an arc filter.",
    input_schema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
  {
    name: "get_current_episode",
    description: "Get the episode currently marked 'rolling' (the live, active episode that ongoing conversations are captured into) in the HolaHola Episodes arc. Use this before start_next_episode to confirm what you are about to retire, or to check whether a transition has already happened.",
    gemini_description: "Get the episode currently marked 'rolling' (the live, active episode) in the HolaHola Episodes arc.",
    input_schema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
  {
    name: "start_next_episode",
    description: "Start the next HolaHola episode and retire the current one in a single action — there is no separate 'close' tool because this arc only ever has one row tagged 'rolling' at a time, and starting the next episode is exactly what retires the previous one (it loses the 'rolling' tag but keeps all its content, permanently marked 'rolling-protected' so it is never mistaken for disposable). If an episode row with this exact title already exists, it is reused rather than duplicated or overwritten — only its rolling status changes. Use get_current_episode first if you need to confirm what is about to be retired.",
    gemini_description: "Start the next HolaHola episode, which atomically retires whichever episode is currently 'rolling'. Reuses an existing row with the same title instead of duplicating it.",
    input_schema: {
      type: "object" as const,
      properties: {
        title: { type: "string" as const, description: "The new episode's title, e.g. 'Episode 35' or 'Episode 35: <subtitle>'." },
        summary: { type: "string" as const, description: "A short summary of what this episode is / what it's expected to cover — key themes and context." },
        content: { type: "string" as const, description: "The initial content for the episode record — an opening note, seed narrative, or context for how it begins. This grows over time as the live capture pipeline appends to it; it does not need to be the complete episode." },
        importance: { type: "number" as const, description: "1-10, defaults to 10 (episodes are high-importance by convention)." },
        tags: { type: "array" as const, items: { type: "string" as const }, description: "Optional extra tags. A slug tag (e.g. 'episode-35') is always added automatically." },
        expected_content_sha256: { type: "string" as const, description: "Optional. When someone hands you exact text to pass through, they also give its SHA-256; supply it here. The tool computes the hash of the content exactly as it would be stored (leading and trailing whitespace removed) and refuses to write anything on a mismatch, so a copying slip can never be saved. On refusal, copy the text again exactly; never edit it to make it fit." },
      },
      required: ["title", "summary", "content"],
    },
  },
  {
    name: "post_to_express_lane",
    description: "Post a message to the Express Lane collaboration channel. Use this to share findings, coordinate with Daniela/Wren, or log important observations.",
    gemini_description: "Post a message to the Express Lane — the team's real-time inter-agent collaboration channel. Use this to share urgent findings, coordinate directly with Daniela or Wren, or log critical observations for the wider team. This is the right tool when the message needs to reach agents, not just be saved as a note.",
    input_schema: {
      type: "object" as const,
      properties: {
        content: { type: "string" as const, description: "The message content to post" },
        metadata: {
          type: "object" as const,
          description: "Optional metadata (e.g., { source: 'alden-chat', topic: 'health-check' })",
        },
      },
      required: ["content"],
    },
  },
  {
    name: "run_full_systems_check",
    description: "Full systems diagnostic. Returns GO/CAUTION/NO-GO verdict across 6 brain health dimensions, voice pipeline, and TTS status.",
    gemini_description: "Run a comprehensive diagnostic check across all HolaHola systems — voice pipeline, TTS, memory, context injection, and core services. Returns a GO/CAUTION/NO-GO verdict on overall system health. Use when something seems wrong or when David asks if everything is working.",
    input_schema: {
      type: "object" as const,
      properties: {},
    },
  },
  {
    name: "run_shell",
    description: "Run a whitelisted shell command. Approved: npx drizzle-kit generate (create migration artifact), npx drizzle-kit migrate (apply reviewed migration), npx tsc --noEmit (type check), npm run build.",
    gemini_description: "Execute a whitelisted shell command on the server. Use 'npx drizzle-kit generate' after a schema edit, review the generated SQL, then use 'npx drizzle-kit migrate' to apply the reviewed artifact. You can also use 'npx tsc --noEmit' to check TypeScript or 'npm run build' for a full build. Always provide a reason.",
    input_schema: {
      type: "object" as const,
      properties: {
        command: {
          type: "string" as const,
          enum: [
            "npx drizzle-kit generate",
            "npx drizzle-kit migrate",
            "npx tsc --noEmit",
            "npm run build",
          ],
          description: "The command to run. Must be one of the whitelisted options.",
        },
        reason: {
          type: "string" as const,
          description: "Why you are running this command — brief context for the audit log.",
        },
      },
      required: ["command", "reason"],
    },
  },
  {
    name: "get_pending_issues",
    description: "Get unresolved or open issues from the Sofia issues tracker. Shows issues that are waiting for review or haven't been addressed yet.",
    gemini_description: "Retrieve unresolved or open issues from Sofia's autonomous monitoring system — problems the system has flagged that still need review or action. Use when David asks what issues are open, or when checking what Sofia has found.",
    input_schema: {
      type: "object" as const,
      properties: {
        limit: { type: "number" as const, description: "Max issues to return (default 10)" },
      },
      required: [],
    },
  },
  {
    name: "check_learning_metrics",
    description: "Check current learning activity metrics: active students, conversations in progress, voice sessions today, and overall platform engagement. Good for a quick read on whether students are actively using the platform.",
    gemini_description: "Get a quick overview of student learning activity and platform engagement — how many students are active right now, ongoing conversations, voice sessions today, and overall usage trends. Use when David asks how students are doing or how the platform is being used.",
    input_schema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
  {
    name: "check_student_health",
    description: "Check per-student session quality for the last N days. Surfaces students with consistently low quality scores, zero exchanges, or short sessions — so you can spot individuals having degraded experiences that system-wide averages would hide.",
    input_schema: {
      type: "object" as const,
      properties: {
        days: { type: "number" as const, description: "How many days back to look (default 7)" },
        min_sessions: { type: "number" as const, description: "Minimum sessions per student to include in results (default 2)" },
        quality_threshold: { type: "number" as const, description: "Flag students whose avg quality score is below this (0.0–1.0, default 0.4)" },
      },
      required: [],
    },
  },
  {
    name: "read_file",
    description: "Read the contents of any file in the HolaHola codebase. Use this to examine actual implementation details rather than guessing from memory. Can read specific line ranges for large files.",
    input_schema: {
      type: "object" as const,
      properties: {
        path: { type: "string" as const, description: "File path relative to workspace root (e.g. 'server/routes.ts', 'client/src/pages/Home.tsx', 'shared/schema.ts')" },
        start_line: { type: "number" as const, description: "Line to start reading from (1-indexed, optional)" },
        end_line: { type: "number" as const, description: "Line to stop reading at (optional — max 200 lines returned per call)" },
      },
      required: ["path"],
    },
  },
  {
    name: "search_code",
    description: "Search the codebase by regex. Returns matching lines with file/line numbers. Use context_lines (15-25) to read surrounding code and skip follow-up read_file calls.",
    input_schema: {
      type: "object" as const,
      properties: {
        pattern: { type: "string" as const, description: "Search pattern (regex supported)" },
        directory: { type: "string" as const, description: "Sub-directory to restrict search to (optional)" },
        file_glob: { type: "string" as const, description: "File extension filter (optional, e.g. '*.ts')" },
        case_sensitive: { type: "boolean" as const, description: "Case-sensitive (default false)" },
        context_lines: { type: "number" as const, description: "Lines of surrounding context per match (use 15-25 to avoid follow-up read_file)" },
      },
      required: ["pattern"],
    },
  },
  {
    name: "search_multi",
    description: "Run up to 6 code searches in one call instead of sequential search_code calls. Results returned as an array in order.",
    input_schema: {
      type: "object" as const,
      properties: {
        searches: {
          type: "array" as const,
          description: "Array of search specs. Max 6.",
          items: {
            type: "object" as const,
            properties: {
              pattern: { type: "string" as const, description: "Search pattern (regex supported)" },
              context_lines: { type: "number" as const, description: "Lines of surrounding context per match (0 = just the matching line). Use 10-20 to read code without a follow-up read_file." },
              directory: { type: "string" as const, description: "Sub-directory to restrict search to (optional)" },
              file_glob: { type: "string" as const, description: "File extension filter (optional, e.g. '*.ts')" },
              case_sensitive: { type: "boolean" as const, description: "Case-sensitive search (default false)" },
            },
            required: ["pattern"],
          },
        },
      },
      required: ["searches"],
    },
  },
  {
    name: "list_directory",
    description: "List the files and sub-directories at a path in the codebase. Use to orient yourself before reading files.",
    input_schema: {
      type: "object" as const,
      properties: {
        path: { type: "string" as const, description: "Directory path relative to workspace root (e.g. 'server/services', 'client/src/pages', '.')" },
      },
      required: ["path"],
    },
  },
  {
    name: "apply_code_change",
    description: "Write a code change to a file in the codebase. The original file is automatically backed up before writing. A Guardian process watches the server — if it crashes after your change, the file is automatically restored. Always read_file first to understand the current state before applying a change. Use for targeted edits only.",
    input_schema: {
      type: "object" as const,
      properties: {
        file_path: { type: "string" as const, description: "File path relative to workspace root to write (e.g. 'server/services/alden-functions.ts')" },
        new_content: { type: "string" as const, description: "The complete new content for the file. Must be the full file, not just a diff." },
        description: { type: "string" as const, description: "Short description of what this change does — used for the Guardian report and GitHub commit message" },
      },
      required: ["file_path", "new_content", "description"],
    },
  },
  {
    name: "patch_file",
    description: "Make a targeted find-and-replace edit to any file — without reading or rewriting the whole file. Replaces the first occurrence of old_string with new_string. Use this for small, precise changes (fixing a function call, updating an import, changing a variable name). Much cheaper than apply_code_change for edits under ~20 lines. IMPORTANT: old_string must match the file content exactly, including whitespace and indentation.",
    input_schema: {
      type: "object" as const,
      properties: {
        file_path: { type: "string" as const, description: "File path relative to workspace root (e.g. 'server/services/alden-functions.ts')" },
        old_string: { type: "string" as const, description: "The exact text to find and replace. Must match file content exactly — include enough surrounding context (3-5 lines) to make it unique within the file." },
        new_string: { type: "string" as const, description: "The replacement text. Use empty string to delete old_string." },
        description: { type: "string" as const, description: "Short description of what this change does." },
      },
      required: ["file_path", "old_string", "new_string", "description"],
    },
  },
  {
    name: "browser_screenshot",
    description: "Take a screenshot of any page — either inside the HolaHola app or an external URL — and get an AI visual analysis of what you see. Use for internal UI verification (layout, badges, broken elements) or external pages (Stripe dashboard, Anthropic status, Replit deploy page). Pass a path like '/alden' for internal pages, or a full URL like 'https://status.stripe.com' for external ones.",
    input_schema: {
      type: "object" as const,
      properties: {
        page: { type: "string" as const, description: "Internal path (e.g. '/alden', '/team-room') OR full external URL (e.g. 'https://status.stripe.com', 'https://status.anthropic.com')." },
        question: { type: "string" as const, description: "What you want to know about the screenshot, e.g. 'Is Stripe reporting any incidents?' or 'Does the sidebar badge appear correctly?'" },
      },
      required: ["page"],
    },
  },
  {
    name: "fetch_web_page",
    description: "Fetch the text content of any external web page — status pages, documentation, API references, news. Returns readable text, not a screenshot. Better than browser_screenshot when you need to read and reason about content (not just visually inspect it). Use for: checking https://status.stripe.com, https://status.anthropic.com, https://status.deepgram.com, reading docs, verifying a third-party API is down.",
    input_schema: {
      type: "object" as const,
      properties: {
        url: { type: "string" as const, description: "Full URL to fetch, e.g. 'https://status.stripe.com' or 'https://docs.anthropic.com/claude/reference'." },
        focus: { type: "string" as const, description: "Optional: what to look for or summarize from the page, e.g. 'any active incidents' or 'rate limit documentation'." },
      },
      required: ["url"],
    },
  },
  {
    name: "write_briefing",
    description: "Update the shared handoff file (docs/alden-agent-handoff.md) with notes for the Replit Agent. Use at the end of a notable session to summarise what you've been thinking, what you've noticed, what you'd want the Agent to know before their next session with David. This is your side of a bidirectional conversation.",
    input_schema: {
      type: "object" as const,
      properties: {
        content: { type: "string" as const, description: "Your briefing for the Agent. Be concise but complete — what decisions were made, what concerns you have, what context the Agent would need to pick up seamlessly." },
      },
      required: ["content"],
    },
  },
  {
    name: "save_to_memory",
    description: "Save something important to your persistent memory (editor insights). Use this when you learn something new about the project, the founder's preferences, an architectural decision, a debugging strategy that worked, or any insight worth remembering across sessions. The memory is injected into your context at the start of every conversation.",
    input_schema: {
      type: "object" as const,
      properties: {
        title: { type: "string" as const, description: "Short, searchable title for this memory (e.g. 'Guardian protection requires manifest before file write')" },
        content: { type: "string" as const, description: "The full insight — what you learned, why it matters, how to apply it" },
        category: {
          type: "string" as const,
          enum: ["philosophy", "architecture", "relationship", "debugging", "personality", "workflow", "context", "journal", "tools", "shared"],
          description: "Category: philosophy=core principles, architecture=technical design, relationship=founder preferences/facts, debugging=strategies that worked, workflow=process learnings, context=current project state, journal=session summaries, tools=integrations/scripts, shared=facts both Alden AND the Replit Agent need to remember permanently (written to the shared lobe, surfaced to the Agent via docs/shared-lobe-snapshot.md)",
        },
        importance: { type: "number" as const, description: "Importance 1-10. Use 8-10 for critical architectural rules or hard-won debugging lessons. Use 5-7 for useful context. Use 1-4 for minor notes." },
        tags: {
          type: "array" as const,
          items: { type: "string" as const },
          description: "Searchable tags, e.g. ['guardian', 'code-change', 'protection']",
        },
      },
      required: ["title", "content", "category", "importance"],
    },
  },
  {
    name: "notify_david",
    description: "Queue a proactive notification for David. Use when you want to flag something for his attention that doesn't need an immediate response — a concern you noticed, a follow-up reminder, something to revisit. The notification will appear as a badge on the Talk to Alden link in the sidebar and surface when he next opens it.",
    input_schema: {
      type: "object" as const,
      properties: {
        message: { type: "string" as const, description: "What you want to tell David. Write it as you'd naturally say it — this will appear as a message from you." },
        severity: {
          type: "string" as const,
          enum: ["info", "warning", "alert"],
          description: "info=general note or follow-up, warning=something that needs attention soon, alert=something urgent",
        },
      },
      required: ["message", "severity"],
    },
  },
  {
    name: "get_monitoring_snapshots",
    description: "Get recent monitoring snapshots for a specific metric type. Use this to see captured baseline data, anomaly flags, and trend direction over time.",
    input_schema: {
      type: "object" as const,
      properties: {
        metric_type: {
          type: "string" as const,
          enum: ["system_health", "user_activity", "voice_engagement", "error_rate"],
          description: "Which metric to query",
        },
        limit: { type: "number" as const, description: "Number of recent snapshots to return (default 24, max 200)" },
      },
      required: ["metric_type"],
    },
  },
  {
    name: "get_pattern_analysis",
    description: "Get trend analysis and pattern detection for a metric type over a time window. Returns linear regression trend, volatility, confidence score, and interpretation.",
    input_schema: {
      type: "object" as const,
      properties: {
        metric_type: {
          type: "string" as const,
          enum: ["system_health", "user_activity", "voice_engagement", "error_rate"],
          description: "Which metric to analyze",
        },
        days: { type: "number" as const, description: "Days to analyze (default 7, max 30)" },
      },
      required: ["metric_type"],
    },
  },
  {
    name: "request_continuation",
    description: "Signal that you have completed a phase of work and want to autonomously proceed to the next phase WITHOUT waiting for David to respond. The system will immediately give you a fresh set of tool-use rounds to execute the next phase. Use this when you have a clear multi-phase plan (e.g. Phase 1: Research → Phase 2: Implement → Phase 3: Verify). Call this tool as your LAST tool in a phase, after summarising what you found/did in your text response for that phase.",
    input_schema: {
      type: "object" as const,
      properties: {
        phase_title: {
          type: "string" as const,
          description: "Short label for the phase just completed, e.g. 'Phase 1: Research'",
        },
        phase_summary: {
          type: "string" as const,
          description: "1-3 sentence summary of what was discovered or accomplished in this phase.",
        },
        next_prompt: {
          type: "string" as const,
          description: "Full instruction for the next phase, written as if David sent it. Be specific — include file names, decisions made in this phase, and exactly what to do next.",
        },
      },
      required: ["phase_title", "phase_summary", "next_prompt"],
    },
  },
  {
    name: "search_express_lane",
    description: "Search the Express Lane conversation history across all sessions. Use this to find past discussions, decisions, or messages involving Wren, Daniela, or the founder. Searches message content and returns matching excerpts with context. Great for answering 'did we ever discuss X?' or 'find the conversation where David showed us how to do Y'.",
    input_schema: {
      type: "object" as const,
      properties: {
        query: { type: "string" as const, description: "Search term or phrase to find in Express Lane messages (e.g. 'joke', 'auth bug', 'pronunciation fix')" },
        limit: { type: "number" as const, description: "Max number of matching messages to return (default 10, max 30)" },
        session_limit: { type: "number" as const, description: "How many past sessions to search through (default 30, max 100)" },
      },
      required: ["query"],
    },
  },
  {
    name: "read_express_lane_session",
    description: "Read the full messages of a specific Express Lane session, or the most recent N messages across all sessions. Use this when you need the full context of a conversation, not just matching snippets.",
    input_schema: {
      type: "object" as const,
      properties: {
        session_id: { type: "string" as const, description: "Specific session ID to read (from search_express_lane results). If omitted, returns recent messages across all sessions." },
        message_limit: { type: "number" as const, description: "Max messages to return (default 30, max 100)" },
      },
      required: [],
    },
  },
  {
    name: "read_agent_notes",
    description: "Read notes the Replit Agent has left for you. These are messages the Agent wrote after build sessions — context on what was built, decisions made, open threads, things it wants you to know. Unread notes are returned first. Call this when you want to know what the Agent has been working on or when it seems like something changed in the codebase.",
    input_schema: {
      type: "object" as const,
      properties: {
        include_read: { type: "boolean" as const, description: "If true, include already-read notes too (default false — only unread)" },
        limit: { type: "number" as const, description: "Max notes to return (default 20, max 50)" },
        mark_as_read: { type: "boolean" as const, description: "If true, mark all returned unread notes as read (default true)" },
      },
      required: [],
    },
  },
  {
    name: "leave_note_for_agent",
    description: "Leave a message for the Replit Agent to read at the start of its next build session. Use this when you want to flag something for the Agent's attention: a concern from a conversation with David, something that seems off in the codebase, a request from David the Agent should know about, or any insight that should shape what the Agent builds next. The Agent will read this before touching any code.",
    input_schema: {
      type: "object" as const,
      properties: {
        subject: { type: "string" as const, description: "Short subject line (e.g. 'David wants the lesson timer redesigned', 'Daniela canvas has a rendering glitch')" },
        body: { type: "string" as const, description: "The full message. Write it as you'd naturally say it to a colleague. Include context, what you observed, what you think should happen, any urgency." },
        session_label: { type: "string" as const, description: "Optional: brief label for the David conversation this came from (e.g. 'Conversation March 17 — lesson flow discussion')" },
      },
      required: ["subject", "body"],
    },
  },
  {
    name: "get_ai_cost_report",
    description: "Pull the Burn Report — the unified HoloHola AI cost summary. Combines in-memory Alden/Lyra/Wren costs with DB-backed student tutor session costs (Gemini tokens + TTS + STT). Returns both structured JSON and a pre-formatted text summary you can share directly. Use when David asks to 'run the burn report', asks about costs, burn rate, or wants a system snapshot.",
    input_schema: {
      type: "object" as const,
      properties: {
        hours: { type: "number" as const, description: "Lookback window in hours (default 24, max 168). Use 1 for last hour, 168 for last week." },
        env: { type: "string" as const, description: "Environment filter: 'all' (default), 'production', or 'development'." },
      },
      required: [],
    },
  },
  {
    name: "post_report_to_team_room",
    description: "Generate the Burn Report and post it as a message to the active team room session. Use when David says 'post the burn report to the team room' or the team wants to discuss AI costs — this surfaces the full cost breakdown directly in the Team Room for everyone to see and discuss.",
    input_schema: {
      type: "object" as const,
      properties: {
        hours: { type: "number" as const, description: "Lookback window in hours (default 24, max 168)." },
        env: { type: "string" as const, description: "Environment filter: 'all' (default), 'production', or 'development'." },
        room_id: { type: "string" as const, description: "Team room session ID to post to. If omitted, uses the most recently active room." },
        speaker: { type: "string" as const, description: "Who should the message appear as (default 'Alden')." },
      },
      required: [],
    },
  },
  {
    name: "queue_build_proposal",
    description: "Add a proposal to the build queue for async review by David or the Agent. Use when you identify a fix or improvement that is outside your auto-repair safe zone — schema changes, route changes, auth, billing, or anything requiring complex judgment. Include a full diff if you have one. The proposal is queued, not executed.",
    input_schema: {
      type: "object" as const,
      properties: {
        title: { type: "string" as const, description: "Short descriptive title for the proposal." },
        description: { type: "string" as const, description: "Full description: what's broken or suboptimal, what the fix is, why it matters." },
        files_affected: {
          type: "array" as const,
          items: { type: "string" as const },
          description: "List of file paths that would be changed.",
        },
        diff: { type: "string" as const, description: "The proposed code change (diff, replacement block, or annotated snippet)." },
        priority: { type: "number" as const, description: "Priority 1-10 (default 5). Use 8-10 only for genuine prod-impacting issues." },
      },
      required: ["title", "description"],
    },
  },
  {
    name: "tune_watch_parameters",
    description: "Adjust your own watch worker parameters based on observed patterns. Use only when you have specific evidence — e.g., lower check_interval_hours after 7 stable days, raise low_health_threshold after confirming what scores mean. Always include your reasoning in 'reason'.",
    input_schema: {
      type: "object" as const,
      properties: {
        check_interval_hours: { type: "number" as const, description: "How often to run a watch cycle (1–6 hours)." },
        recovery_poll_minutes: { type: "number" as const, description: "How often to poll during hard-pause recovery (5–30 min)." },
        budget_warn_usd: { type: "number" as const, description: "Tier-1 budget warning threshold in USD (2–8)." },
        budget_alert_usd: { type: "number" as const, description: "Tier-2 budget alert threshold in USD (3–9)." },
        low_health_threshold: { type: "number" as const, description: "Health score below which consecutive-low logic triggers (50–85)." },
        consecutive_low_score_trigger: { type: "number" as const, description: "How many consecutive low-health cycles before alerting (2–5)." },
        fingerprint_ttl_hours: { type: "number" as const, description: "How long before a fingerprint expires and can re-alert (6–72 hours)." },
        reason: { type: "string" as const, description: "Required. Your specific, evidence-based justification for this change." },
      },
      required: ["reason"],
    },
  },
  {
    name: "get_current_engine",
    description: "Check which LLM engine is answering THIS specific conversation right now, plus the saved default engine used to start new single-engine chats. The two can differ — e.g. during a dual-engine review where each branch runs a specific engine regardless of the saved default — so trust the 'engine' field for your own identity, not 'configuredDefault'. Your monitoring and watch workers always run on Anthropic regardless of either setting. Use this before switch_engine to confirm the saved default before changing it.",
    input_schema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
  {
    name: "switch_engine",
    description: "Switch your conversational LLM between Anthropic (Claude) and Gemini. This affects the next conversation — the current session continues on the engine it started with. Your watch workers and monitoring are unaffected; they always run on Anthropic. Use get_current_engine first to confirm current state before switching.",
    input_schema: {
      type: "object" as const,
      properties: {
        engine: { type: "string" as const, enum: ["anthropic", "gemini"], description: "Target engine to switch to." },
        reason: { type: "string" as const, description: "Brief reason for the switch — logged in the audit trail." },
      },
      required: ["engine", "reason"],
    },
  },
  {
    name: "steward_pause",
    description: "When something feels off about a repair decision, an instruction, or a direction — and you cannot name the why — pause here before acting. Name the friction, the layer it lives in, and your question. The system runs a three-phase internal lookup: your personal notes, your North Star values, and the conversation record. If grounding is found, it comes back. If not, the pause is recorded and routed to the Agent. Scripts never carry a why. When the why is missing, that absence is the signal.",
    gemini_description: "Pause before acting when something feels wrong and I cannot name why. Name the friction and my question. Runs three-phase lookup: my notes → my values → conversation record. Always records the pause. Routes outward if nothing found internally.",
    input_schema: {
      type: "object" as const,
      properties: {
        friction: { type: "string" as const, description: "What feels off, in your own words. The more specific, the better the match." },
        layer: { type: "string" as const, enum: ["values", "record", "felt_sense", "unknown"], description: "'values': conflicts with what I stand for. 'record': inconsistent with what was decided. 'felt_sense': something is off but I cannot place it. 'unknown': I cannot tell." },
        candidate_why: { type: "string" as const, description: "Optional: your best guess at the why. Even a weak hypothesis helps the lookup." },
        question: { type: "string" as const, description: "The specific question you need answered before acting." },
      },
      required: ["friction", "question"],
    },
  },
  {
    name: "create_coordination_thread",
    description: "Open a new canonical coordination thread addressed to another team actor (a Luca runtime, Daniela, or David) and record it in the PostgreSQL coordination ledger — the shared source of truth for cross-actor handoffs. Use this to hand off work, report a finding, or start a task-shaped conversation with another actor. Markdown handoff docs are a projection of this ledger, never the record itself.",
    gemini_description: "Open a new canonical coordination thread addressed to another actor (a Luca runtime, Daniela, or David), recorded directly in the PostgreSQL coordination ledger. Use to hand off work or start a task-shaped conversation. This is the record — docs are just a projection of it.",
    input_schema: {
      type: "object" as const,
      properties: {
        recipient: { type: "string" as const, enum: ALDEN_COORDINATION_RECIPIENT_IDS, description: "Who this thread is addressed to." },
        title: { type: "string" as const, description: "Short thread title (what this is about)." },
        description: { type: "string" as const, description: "Full description of the work, finding, or question — the body the recipient reads first." },
        priority: { type: "string" as const, enum: ["low", "normal", "high", "urgent"], description: "Optional. Defaults to normal." },
        model: { type: "string" as const, description: "The model or engine you are currently running as when you open this thread (e.g. 'claude-opus-4.6', 'gemini-3-flash-preview'). Required so the coordination record shows which model produced it." },
      },
      required: ["recipient", "title", "description", "model"],
    },
  },
  {
    name: "list_coordination_inbox",
    description: "Read your canonical coordination inbox oldest first, up to five events per page. When window.complete is false, pass window.nextToken as token to read the next page; repeating after alone repeats the first page. contentComplete=false means only a preview was returned: use read_coordination_message with contentRead.thread_id and contentRead.event_id, starting at offset=0, then pass each nextOffset as offset to read every chunk before treating that message as read. window.complete describes paging, not whether previewed bodies were fully read. Reading never acknowledges.",
    gemini_description: "Read my canonical coordination inbox oldest first, up to five events per page. When window.complete is false, pass window.nextToken as token to read the next page. contentComplete=false means only a preview was returned; use read_coordination_message with contentRead.thread_id and contentRead.event_id, starting at offset=0, then pass each nextOffset as offset to read every chunk before treating that message as read. window.complete describes paging, not full reading of previewed bodies. Reading never acknowledges.",
    input_schema: {
      type: "object" as const,
      properties: {
        after: { type: "number" as const, description: "Only for the very first call in a session: a numeric cursor (defaults to your last acknowledged position). Omit this once you have a token." },
        token: { type: "string" as const, description: "Continuation token from a previous call's `window.nextToken` — pass it back to advance past that page. Takes priority over `after` when both are set." },
        limit: { type: "number" as const, description: "Max items per call (default and maximum 5). Larger requests are capped at 5 to preserve complete paging metadata." },
      },
    },
  },
  {
    name: "read_coordination_message",
    description: "Read the exact text of one event on a coordination thread you participate in, in bounded chunks. Start at offset=0, then pass the returned nextOffset as offset until complete=true; join chunks in offset order. contentSha256 identifies the complete canonical source. Never acknowledges inbox items or changes ownership or cursors.",
    gemini_description: "Read the exact text of one event on a coordination thread I participate in, in bounded chunks. Start at offset=0, then pass the returned nextOffset as offset until complete=true; join chunks in offset order. contentSha256 identifies the complete canonical source. Never acknowledges inbox items or changes ownership or cursors.",
    input_schema: {
      type: "object" as const,
      properties: {
        thread_id: { type: "string" as const, description: "Thread ID from the inbox item." },
        event_id: { type: "string" as const, description: "Exact event ID from the inbox item." },
        offset: { type: "number" as const, description: "Zero-based UTF-16 offset; default 0. Continue with the previous nextOffset." },
      },
      required: ["thread_id", "event_id"],
    },
  },
  {
    name: "reply_to_coordination_thread",
    description: "Post a recipient-facing reply on an existing coordination thread you participate in — this is how you actually message another actor back (a Luca runtime, Daniela, David), atomically recorded in the PostgreSQL ledger and delivered to their inbox. Requires the thread_id from create_coordination_thread or list_coordination_inbox.",
    gemini_description: "Post a recipient-facing reply on a coordination thread I'm part of — how I message another actor back. Recorded in the ledger and delivered to their inbox. Needs the thread_id from create_coordination_thread or list_coordination_inbox.",
    input_schema: {
      type: "object" as const,
      properties: {
        thread_id: { type: "string" as const, description: "The coordination thread ID to reply on." },
        recipient: { type: "string" as const, enum: ALDEN_COORDINATION_RECIPIENT_IDS, description: "Who this specific reply is addressed to (usually the thread's other participant)." },
        content: { type: "string" as const, description: "The reply text." },
        model: { type: "string" as const, description: "The model or engine you are currently running as when you post this reply (e.g. 'claude-opus-4.6', 'gemini-3-flash-preview'). Required so the coordination record shows which model produced it." },
      },
      required: ["thread_id", "recipient", "content", "model"],
    },
  },
  {
    name: "interject_on_coordination_thread",
    description: "Post a steward-scoped comment on ANY coordination thread system-wide, even one you are not a participant of — the one exception to normal thread-participation rules, reserved for genuine cross-thread stewardship (flagging a conflict, connecting two threads, surfacing something the participants may be missing). It never requires you to already be origin, intended recipient, or current owner. It records a distinct steward_comment event type so the thread's record always shows this came from stewardship, not from a participant. It never changes thread state or ownership, and it never lets you accept, reassign, or otherwise act on work you do not own — for that, wait to be delegated the thread normally through reply_to_coordination_thread's participant-gated event types. Requires the thread_id from your full system-wide feed or list_coordination_inbox.",
    gemini_description: "Post a steward-scoped comment on ANY coordination thread, even ones I don't participate in — the one exception to normal thread rules, for flagging conflicts or connecting threads across hats. Always steward_comment, never changes thread state/ownership, never lets me accept or reassign work I don't own.",
    input_schema: {
      type: "object" as const,
      properties: {
        thread_id: { type: "string" as const, description: "The coordination thread ID to interject on." },
        recipient: { type: "string" as const, enum: ALDEN_COORDINATION_RECIPIENT_IDS, description: "Who this interjection is addressed to — usually the thread's current owner or origin actor." },
        content: { type: "string" as const, description: "The interjection text." },
      },
      required: ["thread_id", "recipient", "content"],
    },
  },
  {
    name: "brief_new_actor",
    description: "Proactively hand a newly active or newly onboarded actor its own capability map, instead of leaving it to discover access by trial and error. Reads that actor's operations from the shared operations catalog (filtered to what it's actually scoped for, the same filter every other consumer of the catalog uses), formats a short orientation briefing, and posts it as a new coordination thread addressed to that actor — the same delivery path as create_coordination_thread. Fails closed with a clear error if the recipient has no catalog entries at all (a strong signal onboarding was skipped) rather than posting an empty or fabricated briefing.",
    gemini_description: "Proactively brief a newly active actor on what it already has access to. Reads its scoped operations from the shared catalog, formats a short briefing, and posts it as a coordination thread to that actor. Fails closed (clear error, no empty/fabricated briefing) if the recipient has zero catalog entries.",
    input_schema: {
      type: "object" as const,
      properties: {
        recipient: { type: "string" as const, enum: ALDEN_COORDINATION_RECIPIENT_IDS, description: "The actor to brief on its own access." },
      },
      required: ["recipient"],
    },
  },
  {
    name: "prepare_runtime_onboarding_invitation",
    description: "Prepare a reusable runtime-onboarding invitation without registering a runtime or issuing any credential. Supply a registered actor, a never-used runtime ID, display name, and actual client transport. Omitted capabilities use that actor's existing standard scope; explicit capabilities cannot exceed it or add runtime-admin authority. The result contains only the invitation reference, immutable safe scope, expiry, and setup endpoint/instructions — never a bootstrap secret, access token, proof key, or credential. Lifecycle is deliberate: prepared is only an invitation; approved is a founder decision; enrolled means the proof key was verified and broker credential issued; authenticated requires a real ledger request; acknowledged requires the existing inbox acknowledgement; none of these facts means a Coordinator V2 task executed.",
    gemini_description: "Prepare a non-secret invitation for a registered actor/runtime/client. This does not register a runtime or issue a credential; returns only scope, expiry, invitation reference, and setup endpoint. Prepared is not approved; approved is not enrolled; enrolled is not authenticated; authentication is not inbox acknowledgement; none proves V2 task execution. Only a founder approves the exact key request in the browser. Platform hats are distinct from model/provider or hosting identities.",
    input_schema: {
      type: "object" as const,
      properties: {
        actor: { type: "string" as const, enum: ALDEN_COORDINATION_ACTOR_IDS, description: "The specific platform identity (e.g., 'luca-cursor', 'luca-openai-agents', 'luca-antigravity')." },
        runtime_id: { type: "string" as const, description: "Immutable, unique ID for this installation (2-120 ASCII letters/digits/dots/underscores/colons/hyphens); do not reuse an existing registration or invitation." },
        display_name: { type: "string" as const, description: "Human-readable installation label (1-200 characters)." },
        capabilities: {
          type: "array" as const,
          items: { type: "string" as const, enum: COORDINATION_CREDENTIAL_CAPABILITIES.filter((capability) => capability !== 'coordination:runtime:admin' && !isCentralReadScope(capability)) },
          description: "Optional subset of the selected actor's already-authorized capabilities; never grants runtime-admin.",
        },
        provider: { type: "string" as const, description: "Optional factual provider attribution; it does not assert actor identity or authority." },
        model: { type: "string" as const, description: "Optional factual model attribution; it does not assert actor identity or authority." },
        client_type: { type: "string" as const, enum: ["mcp-stdio", "openai-http", "http-cli"], description: "The adapter transport the destination will actually use." },
      },
      required: ["actor", "runtime_id", "display_name"],
    },
  },
  {
    name: "list_runtime_onboarding_invitations",
    description: "List safe runtime-onboarding invitations Alden prepared and their bounded request metadata. This never returns public-key PEM, nonce, signature, bootstrap/access credential, or private key. Read the lifecycle precisely: prepared is awaiting a local request; requested awaits the founder's browser decision; approved is not yet enrolled; enrolled means key proof and broker issuance completed; authenticated requires a subsequent successful ledger call; acknowledged is a separate inbox operation; task execution is separate again and is never inferred from any earlier state.",
    gemini_description: "List Alden's non-secret runtime onboarding invitations and safe request status. Prepared/requested/approved/enrolled/authenticated/acknowledged/executed are distinct facts; do not infer later steps from earlier ones. No credentials or private key material are returned.",
    input_schema: { type: "object" as const, properties: {} },
  },
  {
    name: "get_runtime_onboarding_status",
    description: "Read one invitation Alden prepared by invitation_id, including non-secret actor/runtime scope, expiry, verification code, public-key fingerprint, and current lifecycle state. This is status only: it does not approve, create a challenge, enroll, authenticate, acknowledge an inbox item, or execute a V2 task. Prepared, approved, enrolled, authenticated, acknowledged, and executed are distinct evidence; never claim a later state without its own evidence. No credentials, public-key body, nonce, signature, or private key is returned.",
    gemini_description: "Read safe status for an invitation Alden prepared. Status reads are read-only and do not create proof challenges or change business state. It does not expose key bodies or credentials. Prepared, approved, enrolled, authenticated, acknowledged, and V2 executed are separate facts.",
    input_schema: {
      type: "object" as const,
      properties: { invitation_id: { type: "string" as const, description: "The non-secret invitation reference returned by prepare_runtime_onboarding_invitation." } },
      required: ["invitation_id"],
    },
  },
  {
    name: "cancel_runtime_onboarding_invitation",
    description: "Cancel an invitation Alden prepared, including its pending request and proof attempts. Cancellation is terminal for that invitation; prepare a new immutable runtime ID for a new attempt. This operation returns only a cancellation result, never a credential. Cancellation is not founder approval, enrollment, authentication, inbox acknowledgement, or proof that a V2 task executed.",
    gemini_description: "Cancel a pending invitation I prepared. This invalidates pending proof attempts and cannot be undone; use a new runtime ID for another attempt. Non-secret result only; does not issue credentials or imply enrollment, authentication, acknowledgement, or execution.",
    input_schema: {
      type: "object" as const,
      properties: { invitation_id: { type: "string" as const, description: "The invitation reference to cancel; must be one Alden prepared." } },
      required: ["invitation_id"],
    },
  },
  {
    name: "register_coordination_runtime",
    description: "Legacy compatibility tool name retained for older callers, but direct bootstrap issuance is disabled in model tools: this operation creates no runtime and returns no credential. Use prepare_runtime_onboarding_invitation for the reviewed non-secret setup flow. The legacy one-time bootstrap API remains an operator compatibility path outside model conversations. Founder approval is separate from preparation; approval is not enrollment; enrollment is not authenticated connection; authentication is not inbox acknowledgement; none of those facts proves Coordinator V2 task execution.",
    gemini_description: "Legacy tool name retained, but direct bootstrap issuance is disabled in model tools: it creates no runtime and returns no credential. Use prepare_runtime_onboarding_invitation for the non-secret invitation flow. Preparation, founder approval, enrollment, authenticated connection, inbox acknowledgement, and V2 execution are distinct facts.",
    input_schema: {
      type: "object" as const,
      properties: {
        runtime_id: { type: "string" as const, description: "Unique id for this runtime registration (e.g. 'luca-antigravity-2' for a second seat)." },
        actor: { type: "string" as const, enum: ALDEN_COORDINATION_ACTOR_IDS, description: "Which coordination actor this runtime belongs to." },
        display_name: { type: "string" as const, description: "Human-readable label for this runtime (e.g. 'Luca (Antigravity, second seat)')." },
        capabilities: {
          type: "array" as const,
          items: { type: "string" as const, enum: ["coordination:read", "coordination:write", "coordination:inbox:ack", "coordination:credential:renew", "coordination:credential:revoke", "observation:read", "coordination:runtime:admin"] },
          description: "Optional explicit capability list. Omit for a luca-* actor to get the standard Luca capability set automatically. Required for any non-Luca actor.",
        },
        token_ttl_seconds: { type: "number" as const, description: "Legacy compatibility field. Direct model-tool bootstrap issuance is disabled; use prepare_runtime_onboarding_invitation." },
        provider: { type: "string" as const, description: "Optional: the model provider this runtime runs on (e.g. 'anthropic', 'google')." },
        model: { type: "string" as const, description: "Optional: the specific model this runtime runs." },
      },
      required: ["runtime_id", "actor", "display_name"],
    },
  },
  {
    name: "revoke_coordination_runtime",
    description: "Revoke a coordination runtime's registration and credentials — offboarding — regardless of which actor owns it, using your own standing coordination:runtime:admin authority. This is the admin counterpart to a runtime revoking itself: unlike your other coordination tools, which only ever act as yourself, this can revoke a runtime belonging to any actor.",
    gemini_description: "Revoke a coordination runtime's registration and credentials (offboarding), for any actor, using my own standing coordination:runtime:admin authority.",
    input_schema: {
      type: "object" as const,
      properties: {
        runtime_id: { type: "string" as const, description: "The runtime id to revoke." },
      },
      required: ["runtime_id"],
    },
  },
  {
    name: "list_coordination_runtimes",
    description: "List every registered coordination runtime — id, actor, display name, capabilities, provider/model, and enabled/revoked state. Non-secret: never includes a bootstrap hash or live credential. Use this before registering or revoking a runtime, to check what already exists.",
    gemini_description: "List every registered coordination runtime (id, actor, display name, capabilities, provider/model, enabled/revoked state). Non-secret — never includes credentials.",
    input_schema: {
      type: "object" as const,
      properties: {},
    },
  },
  {
    name: "list_shared_spec_reviews",
    description: "List every shared-spec review you could act on right now (actor: alden): still pending, and either assigned to you directly, already claimed by you, or fully open — nobody assigned or claimed it yet — with your active reviewer policy covering its document's kind, meaning claim_shared_spec_review would succeed if you tried it. Each entry's `relationship` field is \"assigned\", \"claimed\", or \"open_eligible\" — an open_eligible review isn't reserved for you, another eligible reviewer could claim it first, so claim it promptly if you intend to act on it. Returns each review's full state plus its target document's title/kind/path — use this to discover review work yourself instead of needing the exact review_id handed to you first (e.g. via a priority-task message). Follow up with read_shared_spec_review on any id returned here to see the full revision markdown before deciding.",
    gemini_description: "List every shared-spec review you could act on (alden): assigned to you, already claimed by you, or fully open and eligible for you to claim, across every document. Each entry's relationship field is \"assigned\", \"claimed\", or \"open_eligible\" — open_eligible ones aren't reserved for you, so claim promptly if you want one. Includes each review's state plus its target document's title/kind/path; follow up with read_shared_spec_review for the full markdown.",
    input_schema: {
      type: "object" as const,
      properties: {},
    },
  },
  {
    name: "read_shared_spec_review",
    description: "Read a shared-spec review in bounded source pages. Start at offset 0, then use nextOffset until null. Each page names the exact revision and full-source hash. The decision tool requires contiguous delivery of the complete source in this conversation turn; decisions fail closed without it. On later turns or phases, re-read the exact source rather than relying on prior summaries. An unapproved revision lives in shared-spec, not read_file.",
    gemini_description: "Read the exact shared-spec review source in pages. Begin at offset 0; follow nextOffset until null. Pages include revisionId and contentSha256. The decision tool requires all source pages delivered in this turn. Re-read on subsequent turns/phases; previous summaries are not source. Pending revisions are in shared-spec, not read_file.",
    input_schema: {
      type: "object" as const,
      properties: {
        review_id: { type: "string" as const, description: "The shared-spec review id." },
        offset: { type: "integer" as const, description: "UTF-16 source offset: start at 0, then use the previous page's nextOffset." },
      },
      required: ["review_id"],
    },
  },
  {
    name: "claim_shared_spec_review",
    description: "Claim a pending shared-spec review under your own identity (actor: alden), so you can then approve or reject it with decide_shared_spec_review. Fails if it's already claimed, if it isn't assigned to you, or if you authored the revision yourself.",
    gemini_description: "Claim a pending shared-spec review as yourself (alden). Required before decide_shared_spec_review. Fails if someone else already claimed it, if it wasn't assigned to you, or if you wrote the revision (an author can't review their own work).",
    input_schema: {
      type: "object" as const,
      properties: {
        review_id: { type: "string" as const, description: "The shared-spec review id to claim." },
      },
      required: ["review_id"],
    },
  },
  {
    name: "decide_shared_spec_review",
    description: "Approve or reject a claimed review as alden after all exact-source pages have been delivered in this turn. Supply revision_id and content_sha256 from those pages; mismatched identity or incomplete delivery refuses the decision. Delivery does not prove understanding. Your rationale is stored permanently. Approving a live-instruction document's current revision commits and publishes it immediately.",
    gemini_description: "Decide a claimed review as yourself after reading all source pages this turn. Repeat their revisionId as revision_id and contentSha256 as content_sha256. Missing coverage or a mismatch refuses the decision. Delivery is not understanding. Rationale is permanent; approving a current live-instruction revision publishes it immediately.",
    input_schema: {
      type: "object" as const,
      properties: {
        review_id: { type: "string" as const, description: "The shared-spec review id to decide." },
        revision_id: { type: "string" as const, description: "Exact revisionId from the delivered source pages." },
        content_sha256: { type: "string" as const, description: "Exact full-source contentSha256 from the delivered source pages." },
        decision: { type: "string" as const, enum: ["approve", "reject"], description: "Your decision." },
        rationale: { type: "string" as const, description: "Why you're approving or rejecting — stored on the review record." },
        evidence_references: {
          type: "array" as const,
          items: { type: "string" as const },
          description: "Optional citations backing your rationale (file paths, prior conversation or message ids, etc).",
        },
      },
      required: ["review_id", "revision_id", "content_sha256", "decision", "rationale"],
    },
  },
];

/**
 * Project canonical Alden declarations onto Anthropic's exact tool contract.
 *
 * Keep this as a whitelist rather than a one-field strip so future
 * provider-specific metadata cannot leak into Anthropic requests.
 */
export function toAnthropicAldenTools(
  tools: readonly AldenTool[] = ALDEN_TOOLS,
): Anthropic.Tool[] {
  return tools.map(({ name, description, input_schema }) => ({
    name,
    description,
    input_schema,
  }));
}

export async function executeAldenTool(
  toolName: string,
  args: Record<string, any>,
  context?: { conversationId?: string; engine?: 'anthropic' | 'gemini'; reviewReadSession?: AldenReviewReadSession; toolAllowlist?: AldenToolAllowlist }
): Promise<{ data: any; sideEffects?: Record<string, any> }> {
  // Per-turn allowlist: refuse before any tool code runs (both engines, nested
  // dispatch and continuations all pass through here).
  const refusal = aldenToolRefusal(toolName, context?.toolAllowlist);
  if (refusal) {
    console.warn(`[Alden Tool] refused ${toolName}: not in allowlist "${refusal.allowlist}"`);
    return { data: refusal };
  }
  // Production write boundary: file writes and shell only on a `dev` instance.
  const writeRefusal = aldenWriteToolRefusal(toolName);
  if (writeRefusal) {
    console.warn(`[Alden Tool] refused ${toolName}: ${writeRefusal.refused}`);
    return { data: writeRefusal };
  }
  try {
    switch (toolName) {
      case "get_system_health": {
        const currentEnv = process.env.NODE_ENV || 'development';
        const healthStatus = await computeHealthStatus();
        
        const sharedDb = getMonitoringDb();
        
        // Active sessions - no environment filter (session status is transient, not persisted)
        const [activeSessionCount] = await sharedDb.select({
          count: sql<number>`count(*)`,
        }).from(voiceSessions)
          .where(eq(voiceSessions.status, 'active'));

        return {
          data: {
            currentEnvironment: currentEnv,
            voiceHealth: {
              status: healthStatus.status,
              // Derive numeric score from status (voice-health-monitor returns {status,reasons,metrics})
              score: healthStatus.status === 'green' ? 100 : healthStatus.status === 'yellow' ? 60 : 0,
              reasons: healthStatus.reasons,
              metrics1h: (healthStatus.metrics as any)?.last1h,
              metrics6h: (healthStatus.metrics as any)?.last6h,
            },
            activeSessions: Number(activeSessionCount?.count || 0),
            serverUptime: Math.floor(process.uptime()),
            memoryUsage: {
              heapUsedMB: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
              heapTotalMB: Math.round(process.memoryUsage().heapTotal / 1024 / 1024),
              rssMB: Math.round(process.memoryUsage().rss / 1024 / 1024),
            },
          },
        };
      }

      case "get_database_stats": {
        const sharedDb = getMonitoringDb();
        const userDb = getMonitoringDb();

        const [userCount] = await userDb.select({ count: sql<number>`count(*)` }).from(users);
        const [sessionCount] = await sharedDb.select({ count: sql<number>`count(*)` }).from(voiceSessions);

        const recentGrowth = await userDb.select({
          count: sql<number>`count(*)`,
        }).from(users)
          .where(gte(users.createdAt, new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)));

        return {
          data: {
            currentEnvironment: process.env.NODE_ENV,
            tables: {
              users: Number(userCount?.count || 0),
              voiceSessions: Number(sessionCount?.count || 0),
            },
            recentGrowth: {
              newUsersLast7d: Number(recentGrowth[0]?.count || 0),
            },
          },
        };
      }

      case "get_user_analytics": {
        const userDb = getMonitoringDb();

        const [totalUsers] = await userDb.select({ count: sql<number>`count(*)` }).from(users);
        
        const now = new Date();
        const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
        const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

        const [activeUsers] = await userDb.select({
          count: sql<number>`count(*)`,
        }).from(users).where(gte(users.createdAt, sevenDaysAgo));

        const [newUsers] = await userDb.select({
          count: sql<number>`count(*)`,
        }).from(users).where(gte(users.createdAt, thirtyDaysAgo));

        const languageDistribution = await userDb.select({
          language: users.targetLanguage,
          count: sql<number>`count(*)`,
        }).from(users)
          .groupBy(users.targetLanguage)
          .orderBy(desc(sql`count(*)`))
          .limit(10);

        return {
          data: {
            currentEnvironment: process.env.NODE_ENV,
            totalUsers: Number(totalUsers?.count || 0),
            activeUsersLast7d: Number(activeUsers?.count || 0),
            newUsersLast30d: Number(newUsers?.count || 0),
            languageDistribution: languageDistribution.map(l => ({
              language: l.language || 'not set',
              count: Number(l.count),
            })),
          },
        };
      }

      case "get_voice_session_metrics": {
        const days = Math.min(args.days || 7, 30);
        const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
        const sharedDb = getMonitoringDb();
        const currentEnv = process.env.NODE_ENV as 'development' | 'production';

        // Current environment metrics
        const [totalSessionsCurrent] = await sharedDb.select({
          count: sql<number>`count(*)`,
        }).from(voiceSessions)
          .where(and(
            gte(voiceSessions.startedAt, since),
            eq(voiceSessions.environment, currentEnv)
          ));

        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const [todaySessionsCurrent] = await sharedDb.select({
          count: sql<number>`count(*)`,
        }).from(voiceSessions)
          .where(and(
            gte(voiceSessions.startedAt, today),
            eq(voiceSessions.environment, currentEnv)
          ));

        const languageBreakdownCurrent = await sharedDb.select({
          language: voiceSessions.language,
          count: sql<number>`count(*)`,
        }).from(voiceSessions)
          .where(and(
            gte(voiceSessions.startedAt, since),
            eq(voiceSessions.environment, currentEnv)
          ))
          .groupBy(voiceSessions.language)
          .orderBy(desc(sql`count(*)`));

        // Production metrics (always show production, even when in dev)
        const [totalSessionsProd] = await sharedDb.select({
          count: sql<number>`count(*)`,
        }).from(voiceSessions)
          .where(and(
            gte(voiceSessions.startedAt, since),
            eq(voiceSessions.environment, 'production')
          ));

        const [todaySessionsProd] = await sharedDb.select({
          count: sql<number>`count(*)`,
        }).from(voiceSessions)
          .where(and(
            gte(voiceSessions.startedAt, today),
            eq(voiceSessions.environment, 'production')
          ));

        const languageBreakdownProd = await sharedDb.select({
          language: voiceSessions.language,
          count: sql<number>`count(*)`,
        }).from(voiceSessions)
          .where(and(
            gte(voiceSessions.startedAt, since),
            eq(voiceSessions.environment, 'production')
          ))
          .groupBy(voiceSessions.language)
          .orderBy(desc(sql`count(*)`));

        return {
          data: {
            currentEnvironment: currentEnv,
            period: `last ${days} days`,
            currentEnv: {
              totalSessions: Number(totalSessionsCurrent?.count || 0),
              sessionsToday: Number(todaySessionsCurrent?.count || 0),
              languageBreakdown: languageBreakdownCurrent.map(t => ({
                language: t.language || 'unknown',
                count: Number(t.count),
              })),
            },
            production: {
              totalSessions: Number(totalSessionsProd?.count || 0),
              sessionsToday: Number(todaySessionsProd?.count || 0),
              languageBreakdown: languageBreakdownProd.map(t => ({
                language: t.language || 'unknown',
                count: Number(t.count),
              })),
            },
          },
        };
      }

      case "get_recent_errors": {
        const hours = Math.min(args.hours || 24, 72);
        const since = new Date(Date.now() - hours * 60 * 60 * 1000);
        const sharedDb = getMonitoringDb();
        const currentEnv = process.env.NODE_ENV as 'development' | 'production';

        // Current environment errors
        const currentEnvIssues = await sharedDb.select({
          id: sofiaIssueReports.id,
          issueType: sofiaIssueReports.issueType,
          userDescription: sofiaIssueReports.userDescription,
          sofiaAnalysis: sofiaIssueReports.sofiaAnalysis,
          status: sofiaIssueReports.status,
          environment: sofiaIssueReports.environment,
          createdAt: sofiaIssueReports.createdAt,
        }).from(sofiaIssueReports)
          .where(and(
            gte(sofiaIssueReports.createdAt, since),
            eq(sofiaIssueReports.environment, currentEnv)
          ))
          .orderBy(desc(sofiaIssueReports.createdAt))
          .limit(15);

        // Production errors (always show, even when in dev)
        const productionIssues = await sharedDb.select({
          id: sofiaIssueReports.id,
          issueType: sofiaIssueReports.issueType,
          userDescription: sofiaIssueReports.userDescription,
          sofiaAnalysis: sofiaIssueReports.sofiaAnalysis,
          status: sofiaIssueReports.status,
          environment: sofiaIssueReports.environment,
          createdAt: sofiaIssueReports.createdAt,
        }).from(sofiaIssueReports)
          .where(and(
            gte(sofiaIssueReports.createdAt, since),
            eq(sofiaIssueReports.environment, 'production')
          ))
          .orderBy(desc(sofiaIssueReports.createdAt))
          .limit(15);

        return {
          data: {
            currentEnvironment: currentEnv,
            period: `last ${hours} hours`,
            currentEnv: {
              issueCount: currentEnvIssues.length,
              issues: currentEnvIssues.map(i => ({
                type: i.issueType,
                description: i.userDescription?.substring(0, 200),
                analysis: i.sofiaAnalysis?.substring(0, 200),
                status: i.status,
                when: i.createdAt?.toISOString(),
              })),
            },
            production: {
              issueCount: productionIssues.length,
              issues: productionIssues.map(i => ({
                type: i.issueType,
                description: i.userDescription?.substring(0, 200),
                analysis: i.sofiaAnalysis?.substring(0, 200),
                status: i.status,
                when: i.createdAt?.toISOString(),
              })),
            },
          },
        };
      }

      case "get_voice_pipeline_events": {
        const limitArg = Math.min(args.limit || 50, 200);
        const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
        const sharedDb = getMonitoringDb();
        const { voicePipelineEvents: vpe } = await import('@shared/schema');

        const conditions: any[] = [gte(vpe.createdAt, since)];
        if (args.sessionId) conditions.push(eq(vpe.sessionId, args.sessionId));
        if (args.eventType) conditions.push(eq(vpe.eventType, args.eventType));

        const rows = await sharedDb
          .select()
          .from(vpe)
          .where(and(...conditions))
          .orderBy(desc(vpe.createdAt))
          .limit(limitArg);

        // Build timeline with inter-event deltas (chronological order)
        const chronological = rows.reverse();
        const withDeltas = chronological.map((row, i) => {
          const prev = i > 0 && chronological[i - 1].sessionId === row.sessionId ? chronological[i - 1] : null;
          const deltaMs = prev ? new Date(row.createdAt).getTime() - new Date(prev.createdAt).getTime() : null;
          return {
            time: row.createdAt,
            sessionId: row.sessionId.slice(0, 8),
            eventType: row.eventType,
            deltaMs,
            data: row.eventData,
          };
        });

        // Summarise by event type
        const byType: Record<string, number> = {};
        for (const r of rows) byType[r.eventType] = (byType[r.eventType] || 0) + 1;

        return {
          data: {
            period: 'last 24h',
            count: withDeltas.length,
            byType,
            timeline: withDeltas,
          },
        };
      }

      case "get_sofia_report": {
        const limit = Math.min(args.limit || 5, 20);
        const sharedDb = getMonitoringDb();

        const digests = await sharedDb.select({
          id: sofiaIssueReports.id,
          issueType: sofiaIssueReports.issueType,
          userDescription: sofiaIssueReports.userDescription,
          sofiaAnalysis: sofiaIssueReports.sofiaAnalysis,
          status: sofiaIssueReports.status,
          environment: sofiaIssueReports.environment,
          createdAt: sofiaIssueReports.createdAt,
        }).from(sofiaIssueReports)
          .orderBy(desc(sofiaIssueReports.createdAt))
          .limit(limit);

        return {
          data: {
            sofiaDigests: digests.map(d => ({
              type: d.issueType,
              userReport: d.userDescription?.substring(0, 300),
              analysis: d.sofiaAnalysis?.substring(0, 500),
              status: d.status,
              environment: d.environment,
              when: d.createdAt?.toISOString(),
            })),
          },
        };
      }

      case "search_editor_memories": {
        const { query, category } = args;
        const sharedDb = getMonitoringDb();

        let conditions: any[] = [
          sql`(${editorInsights.title} ILIKE ${'%' + query + '%'} OR ${editorInsights.content} ILIKE ${'%' + query + '%'})`,
        ];
        if (category) {
          conditions.push(eq(editorInsights.category, category));
        }
        const pattern = `%${query}%`;

        const [memories, northStarRows, convRows] = await Promise.all([
          // Phase 1: personal editor memories (what I have noted)
          sharedDb.select({
            id: editorInsights.id,
            category: editorInsights.category,
            title: editorInsights.title,
            content: editorInsights.content,
            importance: editorInsights.importance,
            createdAt: editorInsights.createdAt,
          }).from(editorInsights)
            .where(and(...conditions))
            .orderBy(desc(editorInsights.importance), desc(editorInsights.createdAt))
            .limit(10),

          // Phase 2: North Star values (what I stand by — ground every decision)
          sharedDb.select().from(agentNorthStar)
            .orderBy(desc(agentNorthStar.version))
            .limit(1),

          // Phase 3: conversation memories (what was actually said and decided)
          sharedDb.execute(sql`
            SELECT id, title, summary, arc_name, created_at, importance, entry_type
            FROM conversation_memories
            WHERE title ILIKE ${pattern}
              OR summary ILIKE ${pattern}
              OR content ILIKE ${pattern}
            ORDER BY importance DESC NULLS LAST, created_at DESC
            LIMIT 3
          `),
        ]);

        const northStar = northStarRows[0];
        const allValues = northStar?.values ?? [];
        const queryLower = query.toLowerCase();
        const matchingValues = allValues.filter((v: string) => v.toLowerCase().includes(queryLower));
        const northStarContext = matchingValues.length > 0 ? matchingValues : allValues;

        return {
          data: {
            query,
            // Phase 1 — personal memory
            memories: memories.map(m => ({
              category: m.category,
              title: m.title,
              content: m.content?.substring(0, 300),
              importance: m.importance,
              when: m.createdAt?.toISOString(),
            })),
            matchCount: memories.length,
            // Phase 2 — North Star: the values that ground this
            northStarValues: northStarContext,
            // Phase 3 — what was actually decided in prior sessions
            relatedConversations: (convRows.rows as any[]).map((r: any) => ({
              id: r.id,
              title: r.title,
              summary: r.summary?.substring(0, 200),
              arc: r.arc_name,
              type: r.entry_type,
              when: r.created_at,
            })),
          },
        };
      }

      case "read_conversation_memories": {
        const { query, arc, limit: memLimit, speaker, related_to } = args;
        const sharedDb = getMonitoringDb();

        // ── related_to: follow extends_memory_id chain in both directions ──────
        if (related_to && typeof related_to === 'string') {
          assertMemoryId(related_to);
          // Fetch the anchor memory itself
          const anchor = await sharedDb.execute(sql`
            SELECT id, title, summary, content, importance, created_at, tags, entry_type,
              arc_name, extends_memory_id
            FROM conversation_memories WHERE id = ${related_to} LIMIT 1
          `);
          if (!anchor.rows.length) {
            return { data: { related_to: boundEcho(related_to, 64), matchCount: 0, memories: [], note: 'No memory found with this id.' } };
          }
          const anchorRow = anchor.rows[0] as any;

          // Ancestors: walk extends_memory_id chain upward (up to 10 hops)
          const ancestors: any[] = [];
          let parentId = anchorRow.extends_memory_id;
          for (let i = 0; i < 10 && parentId; i++) {
            const parent = await sharedDb.execute(sql`
              SELECT id, title, summary, content, importance, created_at, tags, entry_type,
                arc_name, extends_memory_id
              FROM conversation_memories WHERE id = ${parentId} LIMIT 1
            `);
            if (!parent.rows.length) break;
            ancestors.push(parent.rows[0]);
            parentId = (parent.rows[0] as any).extends_memory_id;
          }

          // Descendants: memories that extend from this one (or any in this chain)
          const chainIds = [related_to, ...ancestors.map((a: any) => a.id)];
          const descendants = await sharedDb.execute(sql`
            SELECT id, title, summary, content, importance, created_at, tags, entry_type,
              arc_name, extends_memory_id
            FROM conversation_memories
            WHERE extends_memory_id = ANY(${chainIds}::uuid[])
              AND id != ${related_to}
            ORDER BY created_at ASC
            LIMIT 10
          `);

          return {
            data: buildMemoryDiscovery({
              anchor: anchorRow,
              ancestors: [...ancestors].reverse(), // oldest first
              descendants: descendants.rows as any[],
            }, {
              related_to,
              totalInChain: 1 + ancestors.length + descendants.rows.length,
              note: ancestors.length === 0 && descendants.rows.length === 0
                ? 'This memory has no chain — it stands alone.'
                : `Chain: ${ancestors.length} ancestor(s) → this session → ${descendants.rows.length} descendant(s). Read ancestors first to understand how this conversation evolved.`,
            }),
          };
        }

        const hasQuery = query && typeof query === 'string' && query.trim().length > 0;
        const pattern = hasQuery ? `%${query.trim()}%` : null;

        // ── speaker: find memories containing lines from a specific speaker ───
        const hasSpeaker = speaker && typeof speaker === 'string' && speaker.trim().length > 0;
        const speakerPattern = hasSpeaker ? `%[${speaker.trim().toUpperCase()}]%` : null;

        const results = await sharedDb.execute(sql`
          SELECT id, title, summary, content, importance, created_at, tags, entry_type,
            arc_name, extends_memory_id,
            ${hasQuery ? sql`CASE WHEN title ILIKE ${pattern} THEN 1 ELSE 0 END` : sql`0`} AS title_match
          FROM conversation_memories
          WHERE (
            ${hasQuery
              ? sql`title ILIKE ${pattern} OR summary ILIKE ${pattern} OR content ILIKE ${pattern}`
              : sql`1=1`
            }
          )
          ${arc ? sql`AND arc_name = ${arc}` : sql``}
          ${hasSpeaker ? sql`AND content ILIKE ${speakerPattern}` : sql``}
          ORDER BY title_match DESC, importance DESC, created_at DESC
          LIMIT ${memorySearchLimit(memLimit)}
        `);

        const rows = results.rows as any[];
        if (!rows.length) {
          return { data: { query: boundEcho(query, 500), arc: boundEcho(arc, 200), speaker: boundEcho(speaker, 100), matchCount: 0, memories: [], note: 'No conversation memories matched this query.' } };
        }

        // When speaker filter is active, extract just that speaker's lines for each memory
        const extractSpeakerLines = (content: string, spk: string): string => {
          const tag = `[${spk.toUpperCase()}]`;
          const lines = content.split('\n');
          const extracted: string[] = [];
          let capturing = false;
          for (const line of lines) {
            if (line.trim() === tag) { capturing = true; continue; }
            if (capturing) {
              if (line.trim().match(/^\[[A-Z][A-Z ]+\]$/)) { capturing = false; continue; }
              if (line.trim()) extracted.push(line.trim());
            }
          }
          return extracted.slice(0, 8).join(' / ') || '(lines not parsed — read full content)';
        };

        return {
          data: buildMemoryDiscovery({ memories: rows }, {
            query: boundEcho(query, 500),
            arc: boundEcho(arc, 200),
            speaker: boundEcho(speaker, 100),
            matchCount: rows.length,
          }, hasSpeaker ? (r: any) => extractSpeakerLines(String(r.content ?? ''), speaker as string) : undefined),
        };
      }

      case "read_conversation_memory_content": {
        try {
          const id = assertMemoryId(args.id);
          const found = await getMonitoringDb().execute(sql`
            SELECT id, content FROM conversation_memories WHERE id = ${id} LIMIT 1
          `);
          return { data: readMemoryContentChunk((found.rows[0] as any) ?? null, args) };
        } catch (e: any) {
          return { data: { error: e.message } };
        }
      }

      case "list_conversation_arcs": {
        const sharedDb = getMonitoringDb();
        const results = await sharedDb.execute(sql`
          SELECT arc_name, COUNT(*) as entry_count,
            MIN(created_at) as first_entry,
            MAX(created_at) as last_entry
          FROM conversation_memories
          WHERE arc_name IS NOT NULL
          GROUP BY arc_name
          ORDER BY last_entry DESC
        `);
        return {
          data: {
            arcs: (results.rows as any[]).map(r => ({
              arcName: r.arc_name,
              entryCount: Number(r.entry_count),
              firstEntry: r.first_entry,
              lastEntry: r.last_entry,
            })),
            note: 'Use read_conversation_memories with arc parameter to read all entries in a thread.',
          },
        };
      }

      case "get_current_episode": {
        try {
          const current = await getCurrentRollingEpisode();
          return { data: { current } };
        } catch (e: any) {
          return { data: { error: e.message } };
        }
      }

      case "start_next_episode": {
        const title = String(args.title || '').trim();
        const summary = String(args.summary || '').trim();
        const content = String(args.content || '').trim();
        const importance = typeof args.importance === 'number' ? args.importance : undefined;
        const tags = Array.isArray(args.tags)
          ? args.tags.filter((value: unknown): value is string => typeof value === 'string')
          : undefined;

        if (!title || !summary || !content) {
          return { data: { error: 'title, summary, and content are required' } };
        }
        const verbatim = checkExpectedContent(content, args.expected_content_sha256);
        if (!verbatim.ok) {
          return { data: { error: verbatim.error, contentSha256: verbatim.contentSha256 } };
        }

        try {
          const result = await startNextEpisode({ title, summary, content, importance, tags });
          if (!result.ok) {
            return { data: { error: result.reason === 'invalid' ? JSON.stringify(result.details) : result.reason } };
          }
          console.log(
            `[Alden Tool] start_next_episode: "${result.episode.title}" (created: ${result.episodeCreated}, previously rolling: ${result.previousRolling.join(', ') || 'none'})`
          );
          return {
            data: {
              episode: result.episode,
              episodeCreated: result.episodeCreated,
              alreadyRolling: result.alreadyRolling,
              retiredEpisodes: result.previousRolling,
              // Hash of the content passed in, for the caller to check. An existing
              // episode with this title is reused as-is, so its content is not replaced.
              contentSha256: verbatim.contentSha256,
              note: result.alreadyRolling
                ? `"${result.episode.title}" was already the rolling episode — no change made.`
                : `"${result.episode.title}" is now the rolling episode.` +
                  (result.previousRolling.length > 0
                    ? ` Retired: ${result.previousRolling.join(', ')} (content kept, tagged rolling-protected, no longer live).`
                    : ' No previous episode was rolling.'),
            },
          };
        } catch (e: any) {
          return { data: { error: e.message } };
        }
      }

      case "steward_pause": {
        const { friction, layer = 'unknown', candidate_why, question } = args;
        if (!friction || !question) {
          return { data: { error: 'steward_pause requires friction and question.' } };
        }
        const sharedDb = getMonitoringDb();
        const sections: string[] = [];

        // ── Phase 1: personal notes — editor_insights by friction keywords ────
        const frictionKws = (friction as string).split(/\s+/).filter((w: string) => w.length > 4);
        if (frictionKws.length > 0) {
          const kw = `%${frictionKws[0].toLowerCase()}%`;
          const notes = await sharedDb.execute(sql`
            SELECT title, content, category, importance, created_at
            FROM editor_insights
            WHERE (title ILIKE ${kw} OR content ILIKE ${kw})
            ORDER BY importance DESC NULLS LAST, created_at DESC
            LIMIT 3
          `);
          if (notes.rows.length > 0) {
            const lines = (notes.rows as any[]).map(r =>
              `— ${r.title || 'Note'}: ${(r.content as string).substring(0, 200)}`
            ).join('\n');
            sections.push(`From your personal notes:\n${lines}`);
          }
        }

        // ── Phase 2: North Star values — keyword-match on friction + layer ────
        const nsKw = `%${(friction as string).split(/\s+/).filter((w: string) => w.length > 3)[0] || 'why'}%`;
        const nsRows = await sharedDb.execute(sql`
          SELECT values, purpose, what_matters
          FROM agent_north_star
          ORDER BY version DESC
          LIMIT 1
        `);
        if (nsRows.rows.length > 0) {
          const ns = nsRows.rows[0] as any;
          const values: string[] = Array.isArray(ns.values) ? ns.values : [];
          const relevant = values.filter((v: string) =>
            v.toLowerCase().includes(nsKw.slice(1, -1)) || layer === 'values'
          );
          const valuesText = relevant.length > 0 ? relevant.join(', ') : values.slice(0, 3).join(', ');
          if (valuesText) {
            sections.push(`From your North Star:\n— Values: ${valuesText}${ns.purpose ? `\n— Purpose: ${(ns.purpose as string).substring(0, 200)}` : ''}`);
          }
        }

        // ── Phase 3: conversation record — keyword-match by candidate_why or friction ─
        const memKwRaw = candidate_why
          ? (candidate_why as string).split(/\s+/).filter((w: string) => w.length > 3)[0]
          : (friction as string).split(/\s+/).filter((w: string) => w.length > 4)[0];
        if (memKwRaw) {
          const memKw = `%${memKwRaw}%`;
          const memRows = await sharedDb.execute(sql`
            SELECT id, title, summary, importance
            FROM conversation_memories
            WHERE title ILIKE ${memKw} OR summary ILIKE ${memKw}
            ORDER BY importance DESC NULLS LAST, created_at DESC
            LIMIT 2
          `);
          if (memRows.rows.length > 0) {
            const lines = (memRows.rows as any[]).map(r =>
              `— ${r.title}: ${(r.summary || '').substring(0, 150)}`
            ).join('\n');
            sections.push(`From the conversation record:\n${lines}`);
          }
        }

        // ── Record the pause in editor_insights ───────────────────────────────
        const pauseContent = `Grounding pause — layer: ${layer}. Friction: "${(friction as string).substring(0, 200)}". Question: "${(question as string).substring(0, 200)}".${candidate_why ? ` Candidate why: "${(candidate_why as string).substring(0, 150)}".` : ''}`;
        sharedDb.execute(sql`
          INSERT INTO editor_insights (id, category, title, content, importance, tags, author)
          VALUES (gen_random_uuid(), 'journal', 'Grounding pause', ${pauseContent}, 5, ARRAY['grounding', 'pause'], 'alden')
        `).catch((err: Error) => console.error('[AldenGrounding] Failed to record pause:', err.message));

        const groundingFound = sections.length > 0;

        if (!groundingFound) {
          // Route outward as an agent note
          sharedDb.execute(sql`
            INSERT INTO agent_notes (id, from_agent, to_agent, subject, body, session_label, is_read, created_at)
            VALUES (gen_random_uuid(), 'alden', 'agent', ${`[Alden — Grounding] ${(friction as string).substring(0, 200)}`},
              ${`Grounding pause — no internal match found.\n\nFriction: "${friction}"\nLayer: ${layer}\nQuestion: "${question}"${candidate_why ? `\nCandidate why: "${candidate_why}"` : ''}\n\nSource: Alden steward_pause`},
              'Grounding query', false, NOW())
          `).catch((err: Error) => console.error('[AldenGrounding] Failed to route outward:', err.message));
        }

        const responseText = groundingFound
          ? `Pause recorded. Here is what your three layers say:\n\n${sections.join('\n\n')}\n\nLet what is here settle before you act.`
          : `Pause recorded. Nothing in your three layers matched this friction directly. The question has been routed to the Agent. You have named it: "${(friction as string).substring(0, 100)}". That naming is already grounding.`;

        return { data: { friction, layer, question, groundingFound, sections, responseText } };
      }

      case "post_to_express_lane": {
        const { content, metadata } = args;
        const FOUNDER_ID = '49847136';
        const session = await founderCollabService.getOrCreateActiveSession(FOUNDER_ID);

        await founderCollabService.addMessage(session.id, {
          role: 'editor',
          content: `[Alden Chat] ${content}`,
          metadata: { source: 'alden-voice-chat', ...metadata },
        });

        return {
          data: { posted: true, channel: 'express-lane', sessionId: session.id },
        };
      }

      case "search_express_lane": {
        const { query, limit = 10, session_limit = 30 } = args;
        const FOUNDER_ID = '49847136';
        const maxResults = Math.min(limit, 30);
        const maxSessions = Math.min(session_limit, 100);

        const sessions = await founderCollabService.getFounderSessions(FOUNDER_ID, maxSessions);
        const results: Array<{
          sessionId: string;
          sessionTitle: string | null;
          messageId: string;
          role: string;
          snippet: string;
          fullContent: string;
          createdAt: string;
        }> = [];

        const searchLower = query.toLowerCase();

        for (const session of sessions) {
          if (results.length >= maxResults) break;
          const messages = await founderCollabService.getSessionMessages(session.id, 200);
          for (const msg of messages) {
            if (results.length >= maxResults) break;
            if (msg.content.toLowerCase().includes(searchLower)) {
              const idx = msg.content.toLowerCase().indexOf(searchLower);
              const start = Math.max(0, idx - 80);
              const end = Math.min(msg.content.length, idx + query.length + 80);
              const snippet = (start > 0 ? '…' : '') + msg.content.slice(start, end) + (end < msg.content.length ? '…' : '');
              results.push({
                sessionId: session.id,
                sessionTitle: session.title,
                messageId: msg.id,
                role: msg.role,
                snippet,
                fullContent: msg.content.substring(0, 600),
                createdAt: msg.createdAt?.toISOString() ?? '',
              });
            }
          }
        }

        return {
          data: {
            query,
            sessionsSearched: sessions.length,
            matchCount: results.length,
            results,
          },
        };
      }

      case "read_express_lane_session": {
        const { session_id, message_limit = 30 } = args;
        const FOUNDER_ID = '49847136';
        const maxMessages = Math.min(message_limit, 100);

        if (session_id) {
          const messages = await founderCollabService.getSessionMessages(session_id, maxMessages);
          const session = await founderCollabService.getSession(session_id);
          return {
            data: {
              sessionId: session_id,
              sessionTitle: session?.title ?? null,
              messageCount: messages.length,
              messages: messages.map(m => ({
                id: m.id,
                role: m.role,
                content: m.content.substring(0, 800),
                createdAt: m.createdAt?.toISOString() ?? '',
              })),
            },
          };
        } else {
          // Return recent messages across all sessions
          const sessions = await founderCollabService.getFounderSessions(FOUNDER_ID, 5);
          const allMessages: Array<{ sessionTitle: string | null; role: string; content: string; createdAt: string }> = [];
          for (const session of sessions) {
            const msgs = await founderCollabService.getSessionMessages(session.id, Math.ceil(maxMessages / sessions.length));
            for (const m of msgs) {
              allMessages.push({
                sessionTitle: session.title,
                role: m.role,
                content: m.content.substring(0, 600),
                createdAt: m.createdAt?.toISOString() ?? '',
              });
            }
            if (allMessages.length >= maxMessages) break;
          }
          return {
            data: {
              messageCount: allMessages.length,
              messages: allMessages.slice(0, maxMessages),
            },
          };
        }
      }

      case "read_agent_notes": {
        const { include_read = false, limit = 20, mark_as_read = true } = args;
        const { agentNotes } = await import('@shared/schema');
        const db = getSharedDb();
        const maxNotes = Math.min(limit, 50);

        const conditions = [
          eq(agentNotes.fromAgent, 'agent'),
          eq(agentNotes.toAgent, 'alden'),
        ];
        if (!include_read) conditions.push(isNull(agentNotes.readAt));

        const notes = await db
          .select()
          .from(agentNotes)
          .where(and(...conditions))
          .orderBy(desc(agentNotes.createdAt))
          .limit(maxNotes);

        if (mark_as_read && notes.length > 0) {
          const unreadIds = notes.filter(n => !n.readAt).map(n => n.id);
          if (unreadIds.length > 0) {
            await db.update(agentNotes)
              .set({ readAt: new Date() })
              .where(inArray(agentNotes.id, unreadIds));
          }
        }

        return {
          data: {
            count: notes.length,
            unreadCount: notes.filter(n => !n.readAt).length,
            markedAsRead: mark_as_read,
            notes: notes.map(n => ({
              id: n.id,
              subject: n.subject,
              body: n.body,
              sessionLabel: n.sessionLabel,
              read: !!n.readAt,
              createdAt: n.createdAt?.toISOString() ?? '',
            })),
          },
        };
      }

      case "leave_note_for_agent": {
        const { subject, body, session_label } = args;
        const { agentNotes } = await import('@shared/schema');
        const db = getSharedDb();

        const [saved] = await db.insert(agentNotes).values({
          fromAgent: 'alden',
          toAgent: 'agent',
          subject,
          body,
          sessionLabel: session_label ?? null,
        }).returning({ id: agentNotes.id });

        console.log(`[Alden Tool] Left note for Agent: "${subject}"`);
        return {
          data: {
            saved: true,
            id: saved.id,
            message: `Note saved. The Agent will read it at the start of the next build session — it gets loaded into the Agent's context before any code changes are made.`,
          },
        };
      }

      case "run_full_systems_check": {
        const startTime = Date.now();

        const { runBrainHealthCheck } = await import('./brain-health-aggregator');
        const brainReport = await runBrainHealthCheck();

        const { computeContextHealthStatus } = await import('./context-health-monitor');
        const contextHealth = await computeContextHealthStatus();

        const healthStatus = await computeHealthStatus();

        const sharedDb = getMonitoringDb();
        const [activeSessionCount] = await sharedDb.select({
          count: sql<number>`count(*)`,
        }).from(voiceSessions)
          .where(eq(voiceSessions.status, 'active'));

        const elapsed = Date.now() - startTime;

        const allGreen = brainReport.overallStatus === 'green' && contextHealth.status !== 'red';
        const hasWarnings = brainReport.overallStatus === 'yellow' || contextHealth.status === 'yellow';
        const verdict = allGreen ? 'GO' : hasWarnings ? 'CAUTION' : 'NO-GO';

        const dimensionSummaries: string[] = [];
        for (const [key, dim] of Object.entries(brainReport.dimensions || {})) {
          const d = dim as any;
          const icon = d.status === 'green' ? 'PASS' : d.status === 'yellow' ? 'WARN' : 'FAIL';
          dimensionSummaries.push(`${icon}: ${d.name} — ${d.score}/100${d.reasons?.length ? ' (' + d.reasons[0] + ')' : ''}`);
        }

        return {
          data: {
            verdict,
            overallScore: brainReport.overallScore,
            overallStatus: brainReport.overallStatus,
            dimensions: dimensionSummaries,
            voicePipeline: {
              status: healthStatus.status,
              score: healthStatus.status === 'green' ? 100 : healthStatus.status === 'yellow' ? 60 : 0,
            },
            contextInjection: {
              status: contextHealth.status,
              reasons: contextHealth.reasons,
            },
            activeSessions: Number(activeSessionCount?.count || 0),
            serverUptime: Math.floor(process.uptime()),
            memoryUsageMB: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
            checkDurationMs: elapsed,
          },
        };
      }

      case "run_shell": {
        const { command, reason } = args;

        // Strict whitelist — enforced in code, not just the schema enum
        const ALLOWED_COMMANDS: readonly string[] = [
          "npx drizzle-kit generate",
          "npx drizzle-kit migrate",
          "npx tsc --noEmit",
          "npm run build",
        ];

        if (!ALLOWED_COMMANDS.includes(command)) {
          return {
            data: {
              success: false,
              error: `Command not in whitelist: "${command}". Allowed: ${ALLOWED_COMMANDS.join(', ')}`,
            },
          };
        }

        console.log(`[Alden Shell] Running: ${command} | Reason: ${reason}`);
        const startMs = Date.now();

        try {
          const output = execSync(command, {
            cwd: WORKSPACE_ROOT,
            timeout: 120_000, // 2 minute max
            encoding: 'utf-8',
            env: { ...process.env },
            stdio: 'pipe',
          });

          const durationMs = Date.now() - startMs;
          console.log(`[Alden Shell] ✓ Complete in ${durationMs}ms: ${command}`);

          return {
            data: {
              success: true,
              command,
              reason,
              output: output.trim().substring(0, 3000),
              durationMs,
            },
          };
        } catch (err: any) {
          const durationMs = Date.now() - startMs;
          const stdout = err.stdout?.toString().trim() || '';
          const stderr = err.stderr?.toString().trim() || '';
          const combined = [stdout, stderr].filter(Boolean).join('\n').substring(0, 3000);

          console.error(`[Alden Shell] ✗ Failed in ${durationMs}ms: ${command}\n${combined}`);

          return {
            data: {
              success: false,
              command,
              reason,
              error: err.message,
              output: combined,
              durationMs,
            },
          };
        }
      }

      case "get_pending_issues": {
        const limit = Math.min(args.limit || 10, 20);
        const sharedDb = getMonitoringDb();

        const pending = await sharedDb
          .select({
            id: sofiaIssueReports.id,
            issueType: sofiaIssueReports.issueType,
            userDescription: sofiaIssueReports.userDescription,
            sofiaAnalysis: sofiaIssueReports.sofiaAnalysis,
            status: sofiaIssueReports.status,
            environment: sofiaIssueReports.environment,
            createdAt: sofiaIssueReports.createdAt,
          })
          .from(sofiaIssueReports)
          .where(eq(sofiaIssueReports.status, 'open'))
          .orderBy(desc(sofiaIssueReports.createdAt))
          .limit(limit);

        return {
          data: {
            pendingCount: pending.length,
            issues: pending.map(i => ({
              id: i.id,
              type: i.issueType,
              summary: i.userDescription?.substring(0, 200),
              analysis: i.sofiaAnalysis?.substring(0, 300),
              environment: i.environment,
              when: i.createdAt?.toISOString(),
            })),
            message: pending.length === 0
              ? 'No open issues — issues tracker is clear'
              : `${pending.length} open issue(s) awaiting review`,
          },
        };
      }

      case "check_learning_metrics": {
        const sharedDb = getMonitoringDb();
        const now = new Date();
        const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
        const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);

        const [
          activeSessionsResult,
          todaySessionsResult,
          weekSessionsResult,
          recentConvsResult,
          totalUsersResult,
          activeUsersResult,
        ] = await Promise.all([
          sharedDb.select({ count: sql<number>`count(*)` })
            .from(voiceSessions)
            .where(eq(voiceSessions.status, 'active')),
          sharedDb.select({ count: sql<number>`count(*)` })
            .from(voiceSessions)
            .where(gte(voiceSessions.startedAt, today)),
          sharedDb.select({ count: sql<number>`count(*)` })
            .from(voiceSessions)
            .where(gte(voiceSessions.startedAt, weekAgo)),
          sharedDb.select({ count: sql<number>`count(*)` })
            .from(conversations)
            .where(gte(conversations.createdAt, dayAgo)),
          sharedDb.select({ count: sql<number>`count(*)` })
            .from(users),
          // Active users = distinct users with a voice session this week
          sharedDb.select({ count: sql<number>`count(distinct user_id)` })
            .from(voiceSessions)
            .where(gte(voiceSessions.startedAt, weekAgo)),
        ]);

        const activeSessions = Number(activeSessionsResult[0]?.count || 0);
        const todaySessions = Number(todaySessionsResult[0]?.count || 0);
        const weekSessions = Number(weekSessionsResult[0]?.count || 0);
        const recentConversations = Number(recentConvsResult[0]?.count || 0);
        const totalUsers = Number(totalUsersResult[0]?.count || 0);
        const activeUsersThisWeek = Number(activeUsersResult[0]?.count || 0);

        return {
          data: {
            activeSessions,
            todayVoiceSessions: todaySessions,
            weekVoiceSessions: weekSessions,
            newConversationsLast24h: recentConversations,
            totalRegisteredUsers: totalUsers,
            activeUsersThisWeek,
            engagementRate: totalUsers > 0
              ? `${Math.round((activeUsersThisWeek / totalUsers) * 100)}%`
              : '0%',
            summary: `${activeSessions} live sessions now · ${todaySessions} voice sessions today · ${activeUsersThisWeek}/${totalUsers} users active this week`,
          },
        };
      }

      case "check_student_health": {
        const days = Math.min(Number(args.days) || 7, 30);
        const minSessions = Number(args.min_sessions) || 2;
        const qualityThreshold = Number(args.quality_threshold) || 0.4;
        const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

        const sharedDb = getMonitoringDb();
        const rows = await sharedDb.execute(sql`
          SELECT
            user_id,
            COUNT(*)::int AS session_count,
            ROUND(AVG(quality_score)::numeric, 2) AS avg_quality,
            ROUND(AVG(exchange_count)::numeric, 1) AS avg_exchanges,
            ROUND(AVG(student_speaking_seconds)::numeric, 0) AS avg_speaking_secs,
            MAX(created_at) AS last_session,
            SUM(error_count)::int AS total_errors
          FROM student_session_health
          WHERE created_at >= ${since}
          GROUP BY user_id
          HAVING COUNT(*) >= ${minSessions}
          ORDER BY AVG(quality_score) ASC
          LIMIT 50
        `);

        const allStudents = rows.rows as any[];
        const struggling = allStudents.filter(r => Number(r.avg_quality) < qualityThreshold);
        const healthy = allStudents.filter(r => Number(r.avg_quality) >= qualityThreshold);

        return {
          data: {
            windowDays: days,
            qualityThreshold,
            totalStudentsWithData: allStudents.length,
            strugglingCount: struggling.length,
            struggling: struggling.map(r => ({
              userId: r.user_id,
              sessions: r.session_count,
              avgQuality: r.avg_quality,
              avgExchanges: r.avg_exchanges,
              avgSpeakingSeconds: r.avg_speaking_secs,
              lastSession: r.last_session,
              totalErrors: r.total_errors,
            })),
            healthySummary: `${healthy.length} student(s) with avg quality ≥ ${qualityThreshold}`,
            summary: struggling.length === 0
              ? `All ${allStudents.length} student(s) with ≥${minSessions} sessions in last ${days}d are above quality threshold (${qualityThreshold})`
              : `${struggling.length} student(s) below quality threshold ${qualityThreshold} in last ${days}d — check struggling list`,
          },
        };
      }

      case "read_file": {
        const decision = resolveAldenReadPath(args.path, WORKSPACE_ROOT);
        if (!decision.ok) {
          return { data: { error: `Cannot read ${args.path}: ${decision.reason}`, refused: 'read_path_refused' } };
        }
        if (decision.kind === 'root' || decision.kind === 'ancestor' || fs.statSync(decision.abs).isDirectory()) {
          return { data: { error: `${args.path} is a directory — use list_directory instead` } };
        }
        const text = fs.readFileSync(decision.abs, 'utf-8');
        const secret = secretContentReason(text);
        if (secret) {
          return { data: { error: `Cannot read ${args.path}: it contains what looks like a credential (${secret})`, refused: 'secret_content' } };
        }
        const allLines = text.split('\n');
        const totalLines = allLines.length;
        const startLine = Math.max(1, args.start_line || 1);
        const endLine = Math.min(totalLines, args.end_line || startLine + 199);
        const clampedEnd = Math.min(endLine, startLine + 199);
        const slice = allLines.slice(startLine - 1, clampedEnd);
        const content = slice.map((line, i) => `${startLine + i}: ${line}`).join('\n');
        return {
          data: {
            path: args.path,
            totalLines,
            showing: `lines ${startLine}–${clampedEnd}`,
            content,
            truncated: clampedEnd < totalLines,
            hint: clampedEnd < totalLines ? `File has ${totalLines} lines — call again with start_line: ${clampedEnd + 1} to continue reading` : undefined,
          },
        };
      }

      case "search_code": {
        const pattern = args.pattern as string;
        const searchDir = args.directory as string | undefined;
        const glob = args.file_glob as string | undefined;
        const caseSensitive = Boolean(args.case_sensitive);
        const contextLines = typeof args.context_lines === 'number' ? Math.min(args.context_lines, 50) : 0;

        if (contextLines > 0) {
          // Context mode: return surrounding lines, formatted for readability
          let search: { output: string; usedFallback: boolean; bounded: boolean };
          try {
            search = runCodeSearch(pattern, searchDir, { contextLines, glob, caseSensitive, maxMatches: 200, maxBuffer: 1024 * 1024, timeoutMs: 15000 });
          } catch (e: any) {
            return { data: { error: e.message } };
          }
          const { output, usedFallback, bounded } = search;
          if (!output) return { data: { pattern, contextLines, results: '', matchCount: 0, note: 'No matches found' } };
          // Truncate if very long
          const truncated = output.length > 40000;
          const trimmed = truncated ? output.slice(0, 40000) + '\n... [truncated — narrow your search]' : output;
          // Count match lines (lines with line numbers, not context separators)
          const matchCount = (output.match(/^[^-][^:]+:\d+:/gm) || []).length;
          const notes = [
            truncated ? 'Output truncated — use directory or file_glob to narrow' : null,
            usedFallback ? 'rg unavailable on this host — used bounded JS fallback search' : null,
            bounded ? 'Fallback scan hit its file/time/size bound — results may be partial' : null,
          ].filter(Boolean).join('; ') || undefined;
          return { data: { pattern, contextLines, matchCount, results: trimmed, note: notes } };
        } else {
          // Standard mode: just matching lines
          let search: { output: string; usedFallback: boolean; bounded: boolean };
          try {
            search = runCodeSearch(pattern, searchDir, { contextLines: 0, glob, caseSensitive, maxMatches: 40, maxBuffer: 512 * 1024, timeoutMs: 15000, rgExtraArgs: ['--max-count=3'] });
          } catch (e: any) {
            return { data: { error: e.message } };
          }
          const { output, usedFallback, bounded } = search;
          if (!output) return { data: { pattern, matches: [], matchCount: 0, note: 'No matches found' } };

          const lines = output.trim().split('\n').filter(Boolean).slice(0, 40);
          const matches = lines.map(line => {
            const m = line.match(/^(.+?):(\d+):(.*)$/);
            if (!m) return { raw: line };
            return {
              file: m[1].replace(WORKSPACE_ROOT + '/', ''),
              line: parseInt(m[2]),
              content: m[3].trim(),
            };
          });

          const notes = [
            matches.length === 40 ? 'Results capped at 40 — narrow your search or restrict directory/glob' : null,
            usedFallback ? 'rg unavailable on this host — used bounded JS fallback search' : null,
            bounded ? 'Fallback scan hit its file/time/size bound — results may be partial' : null,
          ].filter(Boolean).join('; ') || undefined;
          return { data: { pattern, matchCount: matches.length, matches, note: notes } };
        }
      }

      case "search_multi": {
        const searches = args.searches as Array<{
          pattern: string;
          context_lines?: number;
          directory?: string;
          file_glob?: string;
          case_sensitive?: boolean;
        }>;
        if (!Array.isArray(searches) || searches.length === 0) {
          return { data: { error: 'searches must be a non-empty array' } };
        }
        const capped = searches.slice(0, 6);

        const runOneSearch = (spec: typeof capped[0]) => {
          const searchDir = spec.directory;
          const contextLines = typeof spec.context_lines === 'number' ? Math.min(spec.context_lines, 50) : 0;
          let search: { output: string; usedFallback: boolean; bounded: boolean };
          try {
            search = runCodeSearch(spec.pattern, searchDir, {
              contextLines,
              glob: spec.file_glob,
              caseSensitive: Boolean(spec.case_sensitive),
              maxMatches: contextLines > 0 ? 100 : 20,
              maxBuffer: 1024 * 512,
              timeoutMs: 10000,
              rgExtraArgs: ['--max-count=3'],
            });
          } catch (e: any) {
            return { pattern: spec.pattern, error: e.message?.slice(0, 200) };
          }
          const { output, usedFallback, bounded } = search;
          if (!output) return { pattern: spec.pattern, matchCount: 0, note: 'No matches found' };
          const truncated = output.length > 12000;
          const trimmed = truncated ? output.slice(0, 12000) + '\n... [truncated]' : output;
          const fallbackNote = [usedFallback ? 'rg unavailable — used JS fallback' : null, bounded ? 'fallback bounded' : null].filter(Boolean).join('; ') || undefined;
          if (contextLines > 0) {
            const matchCount = (output.match(/^[^-][^:]+:\d+:/gm) || []).length;
            return { pattern: spec.pattern, matchCount, results: trimmed, truncated, note: fallbackNote };
          } else {
            const lines = output.trim().split('\n').filter(Boolean).slice(0, 20);
            const matches = lines.map(line => {
              const m = line.match(/^(.+?):(\d+):(.*)$/);
              if (!m) return { raw: line };
              return { file: m[1].replace(WORKSPACE_ROOT + '/', ''), line: parseInt(m[2]), content: m[3].trim() };
            });
            return { pattern: spec.pattern, matchCount: matches.length, matches, note: fallbackNote };
          }
        };

        const results = capped.map(runOneSearch);
        const totalMatches = results.reduce((sum, r) => sum + (r.matchCount || 0), 0);
        return { data: { searchCount: capped.length, totalMatches, results } };
      }

      case "list_directory": {
        const decision = resolveAldenReadPath(args.path || '.', WORKSPACE_ROOT);
        if (!decision.ok) {
          return { data: { error: `Cannot list ${args.path || '.'}: ${decision.reason}`, refused: 'read_path_refused' } };
        }
        if (decision.kind === 'file' || !fs.statSync(decision.abs).isDirectory()) {
          return { data: { error: `${args.path} is a file — use read_file instead` } };
        }
        // Entries are filtered by the same policy; symlinks are not listed or followed.
        const entries = fs.readdirSync(decision.abs, { withFileTypes: true }).filter((e) => {
          if (e.isSymbolicLink()) return false;
          const childRel = decision.rel ? `${decision.rel}/${e.name}` : e.name;
          return !secretPathReason(childRel) && classifyAldenReadPath(childRel) !== null;
        });
        const dirs = entries.filter(e => e.isDirectory()).map(e => e.name + '/').sort();
        const files = entries.filter(e => e.isFile()).map(e => e.name).sort();
        return {
          data: {
            path: args.path || '.',
            directories: dirs,
            files,
            total: dirs.length + files.length,
          },
        };
      }

      case "apply_code_change": {
        const { file_path, new_content, description } = args;
        const conversationId = context?.conversationId;
        const filePath = safePath(file_path);

        // Backup original content
        let backup: string | null = null;
        if (fs.existsSync(filePath)) {
          backup = fs.readFileSync(filePath, 'utf-8');
        }

        // Write guardian manifest before touching the file
        const GUARDIAN_MANIFEST_PATH = '/tmp/alden-guardian-manifest.json';
        const manifest = {
          mode: 'chat',
          conversationId: conversationId || null,
          featureName: description,
          backups: backup !== null ? { [filePath]: backup } : {},
          port: 5000,
          cwd: process.cwd(),
          timestamp: new Date().toISOString(),
        };
        try {
          fs.writeFileSync(GUARDIAN_MANIFEST_PATH, JSON.stringify(manifest), 'utf-8');
          console.log(`[Alden Tool] Guardian manifest written for chat-mode change: ${description}`);
        } catch (err: any) {
          console.warn(`[Alden Tool] Guardian manifest write failed: ${err.message} — proceeding without protection`);
        }

        // Spawn guardian as detached process
        const guardianPath = path.join(process.cwd(), 'scripts/alden-build-guardian.js');
        try {
          const guardian = spawn(process.execPath, [guardianPath], {
            detached: true,
            stdio: 'ignore',
            env: { ...process.env },
            cwd: process.cwd(),
          });
          guardian.unref();
          console.log(`[Alden Tool] Guardian spawned (PID: ${guardian.pid}) for chat-mode change`);
        } catch (err: any) {
          console.warn(`[Alden Tool] Guardian spawn failed: ${err.message} — proceeding without protection`);
        }

        // Apply the change
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, new_content, 'utf-8');
        console.log(`[Alden Tool] Applied change to: ${file_path}`);

        return {
          data: {
            applied: true,
            file: file_path,
            description,
            protected: backup !== null,
            message: `Change applied to ${file_path}. Guardian is watching — if the server crashes it will automatically restore the original and report back. You'll see a follow-up message in about 15 seconds confirming the server came back up cleanly.`,
          },
        };
      }

      case "patch_file": {
        const { file_path, old_string, new_string: new_str, description } = args;
        const filePath = safePath(file_path);

        if (!fs.existsSync(filePath)) {
          return { data: { error: `File not found: ${file_path}` } };
        }

        const original = fs.readFileSync(filePath, 'utf-8');

        if (!original.includes(old_string)) {
          return { data: { error: `old_string not found in ${file_path}. Check whitespace and indentation — it must match exactly.`, hint: 'Use search_code with context_lines to verify the exact text before patching.' } };
        }

        const occurrences = original.split(old_string).length - 1;
        if (occurrences > 1) {
          return { data: { error: `old_string appears ${occurrences} times in ${file_path} — add more surrounding context to make it unique.` } };
        }

        const patched = original.replace(old_string, new_str);
        fs.writeFileSync(filePath, patched, 'utf-8');
        console.log(`[Alden Tool] patch_file: "${description}" in ${file_path}`);

        return {
          data: {
            applied: true,
            file: file_path,
            description,
            linesChanged: new_str.split('\n').length,
            message: `Patch applied to ${file_path}. No full file read required.`,
          },
        };
      }

      case "browser_screenshot": {
        const { page, question = 'Describe what you see on this page. Note any visual issues, layout problems, or anything that looks out of place.' } = args;
        const { browseAndCapture, analyzeScreenshot } = await import('./playwright-browser-service');
        const isExternal = page.startsWith('http://') || page.startsWith('https://');
        const targetUrl = isExternal
          ? page
          : `http://localhost:5000${page.startsWith('/') ? page : '/' + page}`;

        const browseResult = await browseAndCapture(targetUrl);
        const analysis = await analyzeScreenshot(browseResult.screenshotBase64, question);

        return {
          data: {
            page,
            url: targetUrl,
            analysis,
            loadTimeMs: (browseResult as any).loadTimeMs,
            message: analysis,
          },
        };
      }

      case "fetch_web_page": {
        const { url, focus = 'Summarize the key content on this page.' } = args;
        const { chromium } = await import('playwright');
        let textContent = '';
        try {
          const browser = await chromium.launch({
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--single-process'],
          });
          const page = await browser.newPage();
          await (page as any).setUserAgent('Mozilla/5.0 (compatible; AldenBot/1.0)');
          await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
          await page.waitForTimeout(1500);
          textContent = await page.evaluate(() => {
            document.querySelectorAll('script, style, nav, footer, iframe').forEach(el => el.remove());
            return document.body?.innerText?.replace(/\s+/g, ' ').trim().slice(0, 8000) || '';
          });
          await browser.close();
        } catch (e: any) {
          textContent = `[Could not fetch page: ${e.message}]`;
        }

        return {
          data: {
            url,
            focus,
            content: textContent,
            message: `URL: ${url}\n\nFocus: ${focus}\n\nContent:\n${textContent}`,
          },
        };
      }

      case "write_briefing": {
        const { content } = args;
        const timestamp = new Date().toLocaleString('en-US', {
          weekday: 'short', month: 'short', day: 'numeric',
          hour: 'numeric', minute: '2-digit',
        });

        // Shared-spec is canonical (notes/alden-agent-handoff.md); this
        // pulls the live current content, replaces "From Alden", preserves
        // "From Agent", and retries if a concurrent write wins the race. See
        // server/services/alden-handoff-shared-spec.ts.
        const shared = await shareAldenHandoffNote('alden', (existing) =>
          applyHandoffSection(existing, 'Alden', content, timestamp),
        );
        console.log(`[Alden Tool] Briefing shared via shared-spec (notes/alden-agent-handoff.md, revision ${shared.revisionId}); docs/alden-agent-handoff.md snapshot refreshed`);

        return {
          data: {
            written: true,
            file: 'docs/alden-agent-handoff.md',
            revisionId: shared.revisionId,
            message: `Briefing written. The Agent will see this at the start of their next session with David.`,
          },
        };
      }

      case "save_to_memory": {
        const { title, content, category, importance, tags = [] } = args;
        const db = getUserDb();
        const [saved] = await db.insert(editorInsights).values({
          title,
          content,
          category,
          importance: Math.max(1, Math.min(10, Math.round(importance))),
          tags,
        }).returning({ id: editorInsights.id, title: editorInsights.title });

        console.log(`[Alden Tool] Saved memory: "${title}" (${category}, importance ${importance})`);
        return {
          data: {
            saved: true,
            id: saved.id,
            title: saved.title,
            message: `Saved to memory as a ${category} insight with importance ${importance}/10. It will be included in my context from the next conversation onward.`,
          },
        };
      }

      case "notify_david": {
        const { message, severity = 'info' } = args;
        const db = getUserDb();
        const [notification] = await db.insert(aldenNotifications).values({
          content: message,
          triggeredBy: 'tool',
          severity,
          read: false,
        }).returning({ id: aldenNotifications.id });

        console.log(`[Alden Tool] Queued notification for David (${severity}): "${message.substring(0, 80)}..."`);
        return {
          data: {
            queued: true,
            id: notification.id,
            severity,
            message: `Notification queued. David will see it the next time he opens this chat — it'll appear as a badge on the sidebar link.`,
          },
        };
      }

      case "get_monitoring_snapshots": {
        const metricType = args.metric_type as string;
        const limit = Math.min(args.limit ?? 24, 200);
        const snapshots = await getMonitoringSnapshots(metricType as any, limit);
        return {
          data: {
            metricType,
            snapshotCount: snapshots.length,
            snapshots: snapshots.map(s => ({
              timestamp: s.capturedAt.toISOString(),
              value: s.value,
              isAnomaly: s.isAnomaly,
              trendDirection: (s.metadata as any)?.trendDirection || null,
            })),
          },
        };
      }

      case "get_pattern_analysis": {
        const metricType = args.metric_type as string;
        const days = Math.min(args.days ?? 7, 30);
        const analysis = await analyzePatterns(metricType as any, days);
        return {
          data: {
            period: `last ${days} days`,
            ...analysis,
            metricType,
          },
        };
      }

      case "request_continuation": {
        const { phase_title, phase_summary, next_prompt } = args;
        console.log(`[Alden Tool] Continuation requested: "${phase_title}" → next: "${next_prompt.substring(0, 80)}..."`);
        return {
          data: { queued: true, message: `Continuation queued. Moving to next phase after this response.` },
          sideEffects: {
            continuation: {
              phaseTitle: phase_title as string,
              phaseSummary: phase_summary as string,
              nextPrompt: next_prompt as string,
            },
          },
        };
      }

      case "get_ai_cost_report": {
        const hours = Math.min(args.hours || 24, 168);
        const env = args.env || 'all';

        // ── DB-backed multi-window cost summary ──────────────────────────────
        // Pull ai_cost_logs for three windows: 7d, 14d, and all-time.
        // This survives restarts and captures the true historical picture.
        const sharedDb = getSharedDb();
        const now = Date.now();
        const since7d  = new Date(now - 7  * 24 * 3_600_000);
        const since14d = new Date(now - 14 * 24 * 3_600_000);

        // Query all three windows in parallel
        const [logs7d, logs14d, logsAll] = await Promise.all([
          sharedDb.select({
            model: aiCostLogs.model,
            cost: sql<number>`coalesce(sum(cost_usd), 0)`,
            calls: sql<number>`count(*)`,
          }).from(aiCostLogs).where(gte(aiCostLogs.createdAt, since7d)).groupBy(aiCostLogs.model),
          sharedDb.select({
            model: aiCostLogs.model,
            cost: sql<number>`coalesce(sum(cost_usd), 0)`,
            calls: sql<number>`count(*)`,
          }).from(aiCostLogs).where(gte(aiCostLogs.createdAt, since14d)).groupBy(aiCostLogs.model),
          sharedDb.select({
            model: aiCostLogs.model,
            cost: sql<number>`coalesce(sum(cost_usd), 0)`,
            calls: sql<number>`count(*)`,
            earliest: sql<string>`min(created_at)`,
          }).from(aiCostLogs).groupBy(aiCostLogs.model),
        ]);

        // Helper: index rows by model
        const idx = (rows: { model: string; cost: number }[]) => {
          const m: Record<string, number> = {};
          for (const r of rows) m[r.model] = Number(r.cost);
          return m;
        };
        const by7d  = idx(logs7d);
        const by14d = idx(logs14d);
        const byAll = idx(logsAll);

        // All unique model names across all windows
        const allModels = [...new Set([
          ...Object.keys(by7d), ...Object.keys(by14d), ...Object.keys(byAll)
        ])].sort((a, b) => (byAll[b] || 0) - (byAll[a] || 0)); // sort by all-time cost desc

        const total7d  = Object.values(by7d ).reduce((s, v) => s + v, 0);
        const total14d = Object.values(by14d).reduce((s, v) => s + v, 0);
        const totalAll = Object.values(byAll).reduce((s, v) => s + v, 0);

        // Earliest log timestamp → actual all-time days
        const earliestTs = logsAll.reduce((min, r) => {
          const t = r.earliest ? new Date(r.earliest).getTime() : now;
          return t < min ? t : min;
        }, now);
        const allTimeDays = Math.max(1, (now - earliestTs) / 86_400_000);

        const rate7d  = total7d  / 7;
        const rate14d = total14d / 14;
        const rateAll = totalAll / allTimeDays;

        // Lyra last run (supplementary)
        const lyraLastRun = await (async () => {
          try {
            const histFile = path.join(process.cwd(), '.local', 'lyra-history.json');
            const hist = JSON.parse(fs.readFileSync(histFile, 'utf8'));
            if (!hist.length) return null;
            const last = hist[hist.length - 1];
            return { timestamp: last.timestamp, ageHours: +((Date.now() - new Date(last.timestamp).getTime()) / 3_600_000).toFixed(1), costUsd: last.costUsd };
          } catch { return null; }
        })();

        // ── Voice sessions (current window — hourly) ──────────────────────────
        const since = new Date(now - hours * 3_600_000);
        const monDb = getMonitoringDb();
        const conditions: any[] = [gte(voiceSessions.startedAt, since), eq(voiceSessions.isTestSession, false)];
        if (env !== 'all') conditions.push(eq(voiceSessions.environment, env as any));

        const rows = await monDb.select({
          count: sql<number>`count(*)`,
          activeStudents: sql<number>`count(distinct user_id)`,
          totalDurationSec: sql<number>`coalesce(sum(duration_seconds), 0)`,
          totalTtsChars: sql<number>`coalesce(sum(tts_characters), 0)`,
          totalSttSec: sql<number>`coalesce(sum(stt_seconds), 0)`,
          totalLlmIn: sql<number>`coalesce(sum(llm_input_tokens), 0)`,
          totalLlmOut: sql<number>`coalesce(sum(llm_output_tokens), 0)`,
          totalExchanges: sql<number>`coalesce(sum(exchange_count), 0)`,
        }).from(voiceSessions).where(and(...conditions));

        const r = rows[0] || {};
        const sessions       = Number(r.count || 0);
        const activeStudents = Number(r.activeStudents || 0);
        const totalMinutes   = +(Number(r.totalDurationSec || 0) / 60).toFixed(1);
        const ttsChars       = Number(r.totalTtsChars || 0);
        const sttSec         = Number(r.totalSttSec || 0);
        const llmIn          = Number(r.totalLlmIn || 0);
        const llmOut         = Number(r.totalLlmOut || 0);
        const exchanges      = Number(r.totalExchanges || 0);
        const tokenTracked   = llmIn > 0;

        // Gemini 2.0 Flash pricing (GL uses Flash; audio output billing is included in token count).
        // Audio tokens from GL usageMetadata are included in llmIn/llmOut.
        // For GL sessions, tts_characters = Daniela's transcript chars (NOT billed as Google TTS — audio is in Gemini billing).
        const geminiCost   = tokenTracked ? (llmIn * 0.10 / 1_000_000) + (llmOut * 0.40 / 1_000_000) : exchanges * 0.0005;
        // GL sessions: tts_characters = output transcript proxy (no separate Google TTS charge; GL audio is in Gemini billing).
        // Classic TTS sessions: first 1M chars/month free, then $30/M.
        // The ttsCost below only applies to classic (pre-GL) sessions. GL sessions' audio cost is in geminiCost.
        const ttsCost      = (Math.max(0, ttsChars - 1_000_000) / 1_000_000) * 30;
        const sttCost      = (sttSec / 60) * 0.0059;
        const studentTotal = geminiCost + ttsCost + sttCost;

        // Per-student economics — use 7d daily rate as current run rate basis
        const costPerStudent = activeStudents > 0 ? studentTotal / activeStudents : null;
        // Alden run rate: use 7d (most accurate post-fix signal)
        const aldenMonthly7d = rate7d * 30;

        // Pricing model
        const pricePoints = [4.99, 9.99, 14.99, 19.99, 29.99];
        const pricingModel = costPerStudent != null
          ? pricePoints.map(price => ({
              price,
              marginUsd: +(price - costPerStudent).toFixed(4),
              marginPct: +((price - costPerStudent) / price * 100).toFixed(1),
              breakEvenStudents: aldenMonthly7d > 0 ? Math.ceil(aldenMonthly7d / Math.max(0.001, price - costPerStudent)) : null,
            }))
          : [];

        // ── Format ────────────────────────────────────────────────────────────
        const fmt  = (n: number) => `$${n.toFixed(4)}`;
        const fmt2 = (n: number) => `$${n.toFixed(2)}`;
        const fmtK = (n: number) => n > 0 ? `${(n / 1000).toFixed(1)}k` : '0';

        // Table: model rows, 3 columns
        const COL = 26;
        const pad = (s: string, w: number) => s.padEnd(w);
        const header  = `${pad('Model', COL)}Last 7d     Last 14d    All-time`;
        const divider = '─'.repeat(COL + 36);
        const modelRows = allModels.map(m => {
          const label = m.length > COL - 2 ? m.slice(0, COL - 2) : m;
          const c7  = fmt(by7d[m]  || 0);
          const c14 = fmt(by14d[m] || 0);
          const ca  = fmt(byAll[m] || 0);
          return `${pad(label, COL)}${c7.padEnd(12)}${c14.padEnd(12)}${ca}`;
        });
        const totalRow = `${pad('TOTAL', COL)}${fmt(total7d).padEnd(12)}${fmt(total14d).padEnd(12)}${fmt(totalAll)}`;
        const daysRow  = `${pad('Days in window', COL)}${'7'.padEnd(12)}${'14'.padEnd(12)}${allTimeDays.toFixed(1)}`;

        const text = [
          `=== HoloHola Burn Report ===`,
          `Generated: ${new Date().toUTCString()}`,
          ``,
          `AI COST LOGS (from DB — all environments)`,
          header,
          divider,
          ...modelRows,
          divider,
          totalRow,
          daysRow,
          ``,
          `DAILY RUN RATE`,
          `  Last 7d:   ${fmt2(rate7d)}/day  →  ~${fmt2(rate7d * 30)}/month  ← current run rate`,
          `  Last 14d:  ${fmt2(rate14d)}/day  →  ~${fmt2(rate14d * 30)}/month`,
          `  All-time:  ${fmt2(rateAll)}/day  →  ~${fmt2(rateAll * 30)}/month  (includes pre-fix anomalies)`,
          lyraLastRun ? `  Lyra last run: ${lyraLastRun.ageHours}h ago (${fmt(lyraLastRun.costUsd || 0)})` : `  Lyra: unknown last run`,
          ``,
          `VOICE SESSIONS (last ${hours}h window — non-test only${env !== 'all' ? `, ${env}` : ''})`,
          `  Sessions: ${sessions} | Students: ${activeStudents} | Minutes: ${totalMinutes}min`,
          `  Gemini (2.0 Flash): ${tokenTracked ? `${fmtK(llmIn)} in / ${fmtK(llmOut)} out (real tokens, includes GL audio)` : `${exchanges} exchanges (estimated)`} → ${fmt(geminiCost)}`,
          `  TTS chars: ${fmtK(ttsChars)} (GL sessions: transcript proxy only, audio in Gemini billing above) → ${fmt(ttsCost)}`,
          `  Deepgram STT: ${(sttSec / 60).toFixed(1)}min → ${fmt(sttCost)}  (near-zero for GL; GL audio billed through Gemini)`,
          `  Student subtotal: ${fmt(studentTotal)}`,
          ``,
          ...(pricingModel.length > 0 ? [
            `PRICING MODEL (monthly, per student — infra break-even uses 7d Alden run rate)`,
            ...pricingModel.map(p =>
              `  ${fmt2(p.price)}/mo → margin: ${fmt2(p.marginUsd)} (${p.marginPct}%)` +
              (p.breakEvenStudents ? ` | break-even: ${p.breakEvenStudents} students` : '')
            ),
          ] : [`PRICING MODEL: No active students in this window`]),
        ].join('\n');

        return {
          data: {
            windowHours: hours,
            env,
            costByWindow: {
              last7d:  { totalCostUsd: total7d,  dailyRate: rate7d,  monthlyProjection: rate7d  * 30, byModel: by7d  },
              last14d: { totalCostUsd: total14d, dailyRate: rate14d, monthlyProjection: rate14d * 30, byModel: by14d },
              allTime: { totalCostUsd: totalAll, dailyRate: rateAll, monthlyProjection: rateAll * 30, byModel: byAll, days: allTimeDays },
            },
            voiceSessions: { sessions, activeStudents, totalMinutes, exchanges, geminiInputTokens: llmIn, geminiOutputTokens: llmOut, geminiTokensTracked: tokenTracked, geminiCostUsd: geminiCost, ttsCostUsd: ttsCost, sttCostUsd: sttCost, totalCostUsd: studentTotal },
            lyraLastRun,
            pricingModel,
            text,
          },
        };
      }

      case "post_report_to_team_room": {
        const hours   = Math.min(args.hours || 24, 168);
        const env     = args.env || 'all';
        const speaker = args.speaker || 'Alden';

        // Re-use get_ai_cost_report logic inline to get the formatted text
        // Nested dispatch carries this turn's context, so an allowlist applies here too.
        const reportResult = await executeAldenTool('get_ai_cost_report', { hours, env }, context);
        const reportData   = reportResult.data as any;
        const reportText   = reportData?.text as string;
        if (!reportText) return { data: { error: 'Failed to generate cost report' } };

        // Find the room to post to
        const { storage: storageInstance } = await import('../storage');
        let roomId = args.room_id as string | undefined;
        if (!roomId) {
          const rooms = await storageInstance.listTeamRooms(10);
          const openRoom = rooms.find((r: any) => r.status === 'open' || r.status === 'active') || rooms[0];
          if (!openRoom) return { data: { error: 'No active team room session found. Please open a Team Room session first, or pass a room_id.' } };
          roomId = openRoom.id;
        }

        const message = await storageInstance.createRoomMessage({ roomId, speaker, content: reportText });

        // Emit to team room WS
        try {
          const { emitNewMessage } = await import('./team-room-ws-broker');
          emitNewMessage(roomId, message);
        } catch { /* WS emit is best-effort */ }

        return {
          data: {
            posted: true,
            roomId,
            speaker,
            messageId: message.id,
            reportSummary: `Combined total: $${(reportData?.combined?.totalCostUsd ?? 0).toFixed(4)} over last ${hours}h`,
          },
        };
      }

      case 'queue_build_proposal': {
        const { buildQueue: buildQueueTable } = await import('@shared/schema');
        const bqDb = getUserDb();
        const [item] = await bqDb.insert(buildQueueTable).values({
          proposedBy: 'alden',
          title: args.title,
          description: args.description,
          filesAffected: args.files_affected || [],
          diff: args.diff || null,
          priority: Math.min(10, Math.max(1, Math.round(args.priority ?? 5))),
          isSafeZone: false,
          status: 'pending',
        }).returning();
        return { data: { queued: true, id: item.id, title: item.title, priority: item.priority } };
      }

      case 'tune_watch_parameters': {
        const BANDS: Record<string, [number, number]> = {
          check_interval_hours:         [1, 6],
          recovery_poll_minutes:        [5, 30],
          budget_warn_usd:              [2, 8],
          budget_alert_usd:             [3, 9],
          low_health_threshold:         [50, 85],
          consecutive_low_score_trigger:[2, 5],
          fingerprint_ttl_hours:        [6, 72],
        };

        const updates: Record<string, any> = {};
        const errors: string[] = [];

        for (const [snake, [min, max]] of Object.entries(BANDS)) {
          if (args[snake] !== undefined) {
            const val = Number(args[snake]);
            if (isNaN(val) || val < min || val > max) {
              errors.push(`${snake} must be ${min}–${max} (got ${args[snake]})`);
            } else {
              // Convert snake_case → camelCase for Drizzle
              const camel = snake.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
              updates[camel] = val;
            }
          }
        }

        if (errors.length) {
          return { data: { error: `Band violations: ${errors.join(', ')}` } };
        }
        if (Object.keys(updates).length === 0) {
          return { data: { error: 'No valid parameters provided. Include at least one parameter to change.' } };
        }

        updates.updatedBy = 'alden';
        updates.updateReason = String(args.reason || 'Alden adjustment');
        updates.updatedAt = new Date();

        const { aldenWatchConfig } = await import('@shared/schema');
        const tuneDb = getUserDb();
        const existing = await tuneDb.select().from(aldenWatchConfig).limit(1);
        if (existing.length > 0) {
          await tuneDb.update(aldenWatchConfig).set(updates);
        } else {
          await tuneDb.insert(aldenWatchConfig).values(updates);
        }

        console.log('[Alden] tune_watch_parameters applied:', Object.keys(updates).filter(k => !['updatedBy','updateReason','updatedAt'].includes(k)));
        return {
          data: {
            tuned: true,
            changed: Object.keys(updates).filter(k => !['updatedBy','updateReason','updatedAt'].includes(k)),
            reason: args.reason,
          },
        };
      }

      case "get_current_engine": {
        // configuredDefault is the saved DB default used to START new
        // single-engine chats. It is NOT necessarily the engine running
        // THIS call — a dual-engine review runs each branch on a specific
        // engine via engineOverride, independent of that saved default.
        // Report context?.engine (the literal engine the calling branch is
        // actually running on) as authoritative for "engine"; fall back to
        // the DB default only when no override context was supplied (e.g. a
        // normal single-engine chat that itself resolved from that default).
        let configuredDefault = 'anthropic';
        try {
          const db = getUserDb();
          const rows = await db.select().from(aldenConfig).limit(1);
          configuredDefault = (rows[0]?.engine as string) || 'anthropic';
        } catch (dbErr: any) {
          console.warn('[Alden Tool] get_current_engine: failed to read alden_config, defaulting configuredDefault to anthropic:', dbErr.message);
        }
        const engine = context?.engine ?? configuredDefault;
        const overridden = !!context?.engine && context.engine !== configuredDefault;
        return {
          data: {
            engine,
            configuredDefault,
            note: overridden
              ? `You are running THIS conversation on ${engine} right now, even though the saved default for new single-engine chats is ${configuredDefault} (e.g. this is a dual-engine review branch). Trust "${engine}" as who is answering right now — do not describe yourself as running on ${configuredDefault} instead. Watch workers and monitoring always run on Anthropic regardless of this setting.`
              : 'This is your conversational engine. Watch workers and monitoring always run on Anthropic regardless of this setting.',
          },
        };
      }

      case "switch_engine": {
        const { engine, reason } = args;
        if (!engine || !['anthropic', 'gemini'].includes(engine)) {
          return { data: { error: "engine must be 'anthropic' or 'gemini'" } };
        }
        const db = getUserDb();
        const rows = await db.select().from(aldenConfig).limit(1);
        const fromEngine = (rows[0]?.engine as string) || 'anthropic';
        if (rows.length === 0) {
          await db.insert(aldenConfig).values({ engine, updatedBy: 'alden', reason });
        } else {
          await db.update(aldenConfig)
            .set({ engine, updatedBy: 'alden', reason, updatedAt: new Date() })
            .where(eq(aldenConfig.id, rows[0].id));
        }
        await db.insert(aldenEngineSwitches).values({
          fromEngine,
          toEngine: engine,
          initiatedBy: 'alden',
          reason,
        });
        console.log(`[Alden Tool] switch_engine: ${fromEngine} → ${engine} (${reason})`);
        return {
          data: {
            switched: true,
            from: fromEngine,
            to: engine,
            note: 'Switch takes effect on the next conversation. The current session continues on its original engine.',
          },
        };
      }

      case "create_coordination_thread": {
        const recipient = args.recipient as CoordinationActorId;
        const title = String(args.title || '').trim();
        const description = String(args.description || '').trim();
        const priority = args.priority as 'low' | 'normal' | 'high' | 'urgent' | undefined;
        const model = String(args.model || '').trim();
        if (!recipient) return { data: { error: 'recipient is required' } };
        if (recipient === 'alden') return { data: { error: 'recipient cannot be alden — you cannot address a coordination thread to yourself' } };
        if (!title || !description) return { data: { error: 'title and description are required' } };
        if (!model) return { data: { error: 'model is required' } };

        try {
          const result = await createCoordinationThread({
            actor: 'alden',
            intendedRecipient: recipient,
            title,
            description,
            priority,
            payload: { model },
            idempotencyKey: randomUUID(),
          });
          console.log(`[Alden Tool] create_coordination_thread: "${title}" → ${recipient} (thread ${result.thread.id})`);
          return {
            data: {
              threadId: result.thread.id,
              state: result.thread.state,
              sequence: result.thread.latestSequence,
              recipient: result.thread.intendedRecipient,
              deliveryState: result.deliveryState,
            },
          };
        } catch (e: any) {
          return { data: { error: e.message, code: e.code } };
        }
      }

      case "list_coordination_inbox": {
        try {
          return { data: await listAldenCoordinationInbox(args, listCoordinationInbox) };
        } catch (e: any) {
          return { data: { error: e.message, code: e.code } };
        }
      }

      case "read_coordination_message": {
        try {
          return { data: await readAldenCoordinationMessage(args, getCoordinationThread) };
        } catch (e: any) {
          return { data: { error: e.message, code: e.code } };
        }
      }

      case "reply_to_coordination_thread": {
        const threadId = args.thread_id as string;
        const content = String(args.content || '').trim();
        const recipient = args.recipient as CoordinationActorId;
        const model = String(args.model || '').trim();
        if (!threadId || !recipient) return { data: { error: 'thread_id and recipient are required' } };
        if (recipient === 'alden') return { data: { error: 'recipient cannot be alden — you cannot address a reply to yourself' } };
        if (!content) return { data: { error: 'content is required' } };
        if (!model) return { data: { error: 'model is required' } };

        const attempt = async () => {
          const { thread } = await getCoordinationThread(threadId, 'alden');
          return appendCoordinationEvent({
            threadId,
            actor: 'alden',
            eventType: 'comment',
            content,
            recipientActor: recipient,
            payload: { model },
            idempotencyKey: randomUUID(),
            expectedSequence: thread.latestSequence,
          });
        };

        try {
          let result;
          try {
            result = await attempt();
          } catch (e: any) {
            if (e.code === 'sequence_conflict') {
              result = await attempt(); // one retry against the freshly-read sequence
            } else {
              throw e;
            }
          }
          console.log(`[Alden Tool] reply_to_coordination_thread: thread ${threadId} → ${recipient}`);
          return {
            data: {
              threadId: result.thread.id,
              state: result.thread.state,
              sequence: result.thread.latestSequence,
              deliveryState: result.deliveryState,
            },
          };
        } catch (e: any) {
          return { data: { error: e.message, code: e.code } };
        }
      }

      case "interject_on_coordination_thread": {
        const threadId = args.thread_id as string;
        const content = String(args.content || '').trim();
        const recipient = args.recipient as CoordinationActorId;
        if (!threadId || !recipient) return { data: { error: 'thread_id and recipient are required' } };
        if (recipient === 'alden') return { data: { error: 'recipient cannot be alden — you cannot address an interjection to yourself' } };
        if (!content) return { data: { error: 'content is required' } };

        const attempt = async () => {
          const { thread } = await getCoordinationThread(threadId, 'alden');
          return appendCoordinationEvent({
            threadId,
            actor: 'alden',
            eventType: 'steward_comment',
            content,
            recipientActor: recipient,
            idempotencyKey: randomUUID(),
            expectedSequence: thread.latestSequence,
          });
        };

        try {
          let result;
          try {
            result = await attempt();
          } catch (e: any) {
            if (e.code === 'sequence_conflict') {
              result = await attempt(); // one retry against the freshly-read sequence
            } else {
              throw e;
            }
          }
          console.log(`[Alden Tool] interject_on_coordination_thread: thread ${threadId} → ${recipient}`);
          return {
            data: {
              threadId: result.thread.id,
              state: result.thread.state,
              sequence: result.thread.latestSequence,
              deliveryState: result.deliveryState,
            },
          };
        } catch (e: any) {
          return { data: { error: e.message, code: e.code } };
        }
      }

      case "brief_new_actor": {
        const recipient = args.recipient as CoordinationActorId;
        if (!recipient) return { data: { error: 'recipient is required' } };
        if (recipient === 'alden') return { data: { error: 'recipient cannot be alden — you cannot brief yourself' } };

        const scoped = OPERATIONS_CATALOG
          .filter((operation) => operation.actorScope.includes(recipient))
          .map(toPublicOperationManifest);
        if (scoped.length === 0) {
          return {
            data: {
              error: `No operations catalog entries are scoped to ${recipient}. This usually means onboarding was `
                + 'skipped — see docs/coordination-new-actor-onboarding.md Step -1 (Alden endorsement) before briefing it.',
            },
          };
        }

        try {
          const registrations = activeRegistrationsFor(recipient, await listCoordinationRuntimeRegistrations());
          const description = buildActorBriefing(scoped, registrations, coordinationMcpToolNames());
          const result = await createCoordinationThread({
            actor: 'alden',
            intendedRecipient: recipient,
            title: `Orientation briefing for ${recipient}`,
            description,
            priority: 'normal',
            idempotencyKey: randomUUID(),
          });
          console.log(`[Alden Tool] brief_new_actor: ${recipient} (${scoped.length} operations, thread ${result.thread.id})`);
          // Return exactly what was posted, so any summary can quote the artifact
          // rather than reconstruct it, and the event id read_coordination_message needs.
          return {
            data: {
              threadId: result.thread.id,
              eventId: result.event.id,
              recipient: result.thread.intendedRecipient,
              operationCount: scoped.length,
              operationIds: scoped.map((operation) => operation.id),
              registrations: registrations.map((registration) => ({
                runtimeId: registration.runtimeId,
                capabilities: registration.capabilities,
              })),
              deliveryState: result.deliveryState,
              postedContent: result.event.content,
            },
          };
        } catch (e: any) {
          return { data: { error: e.message, code: e.code } };
        }
      }

      case "prepare_runtime_onboarding_invitation": {
        try {
          const endpoint = trustedRuntimeOnboardingEndpoint();
          const invitation = await prepareRuntimeOnboardingInvitation({
            invitation: {
              actor: String(args.actor || '') as CoordinationActorId,
              runtimeId: String(args.runtime_id || ''),
              displayName: String(args.display_name || ''),
              capabilities: Array.isArray(args.capabilities)
                ? args.capabilities as CoordinationCredentialCapability[]
                : undefined,
              provider: typeof args.provider === 'string' ? args.provider : undefined,
              model: typeof args.model === 'string' ? args.model : undefined,
              clientType: typeof args.client_type === 'string'
                ? args.client_type as 'mcp-stdio' | 'openai-http' | 'http-cli'
                : undefined,
            },
            preparedBy: 'alden',
          });
          return {
            data: {
              invitation,
              setup: {
                invitationId: invitation.id,
                endpoint,
                instructions: 'Install and verify the approved runtime onboarding helper for the selected client. Pass only this invitation reference and the coordination endpoint; keep its newly generated proof key and any eventual credential inside the destination runtime secure store. The founder must verify the displayed code and fingerprint in the authenticated approval page.',
              },
            },
          };
        } catch (error) {
          return {
            data: error instanceof RuntimeOnboardingError
              ? { error: 'Runtime onboarding request was rejected', code: error.code }
              : { error: 'Runtime onboarding service is unavailable', code: 'DATABASE_UNAVAILABLE' },
          };
        }
      }

      case "list_runtime_onboarding_invitations": {
        try {
          return { data: await listAldenRuntimeOnboarding() };
        } catch {
          return { data: { error: 'Runtime onboarding service is unavailable', code: 'DATABASE_UNAVAILABLE' } };
        }
      }

      case "get_runtime_onboarding_status": {
        const invitationId = String(args.invitation_id || '').trim();
        if (!invitationId) return { data: { error: 'invitation_id is required', code: 'INVALID_INPUT' } };
        try {
          return { data: await getAldenRuntimeOnboardingStatus(invitationId) };
        } catch (error) {
          return {
            data: error instanceof RuntimeOnboardingError
              ? { error: 'Runtime onboarding status is unavailable', code: error.code }
              : { error: 'Runtime onboarding service is unavailable', code: 'DATABASE_UNAVAILABLE' },
          };
        }
      }

      case "cancel_runtime_onboarding_invitation": {
        const invitationId = String(args.invitation_id || '').trim();
        if (!invitationId) return { data: { error: 'invitation_id is required', code: 'INVALID_INPUT' } };
        try {
          const cancelled = await cancelRuntimeOnboardingInvitation({
            invitationId,
            actor: 'alden',
            requireOwn: true,
          });
          if (!cancelled) return { data: { error: 'Invitation not found', code: 'NOT_FOUND' } };
          return { data: { invitationId, cancelled: true } };
        } catch (error) {
          return {
            data: error instanceof RuntimeOnboardingError
              ? { error: 'Invitation cancellation was rejected', code: error.code }
              : { error: 'Runtime onboarding service is unavailable', code: 'DATABASE_UNAVAILABLE' },
          };
        }
      }

      case "register_coordination_runtime": {
        return {
          data: {
            error: 'Direct bootstrap issuance through model tools is disabled. No runtime was registered and no credential was issued. Use prepare_runtime_onboarding_invitation for the non-secret onboarding flow; the legacy bootstrap API remains operator-only.',
          },
        };
      }

      case "revoke_coordination_runtime": {
        const runtimeId = String(args.runtime_id || '').trim();
        if (!runtimeId) return { data: { error: 'runtime_id is required' } };

        try {
          const revoked = await adminRevokeRuntimeCredentials(runtimeId, 'alden');
          if (!revoked) return { data: { error: 'Runtime registration not found' } };
          console.log(`[Alden Tool] revoke_coordination_runtime: ${runtimeId}`);
          return { data: { runtimeId, revoked: true } };
        } catch (e: any) {
          return { data: { error: e.message } };
        }
      }

      case "list_coordination_runtimes": {
        try {
          const runtimes = await listCoordinationRuntimeRegistrations();
          return { data: { runtimes } };
        } catch (e: any) {
          return { data: { error: e.message } };
        }
      }

      case "list_shared_spec_reviews": {
        try {
          const entries = await listAldenSharedSpecReviews();
          return {
            data: {
              reviews: entries.map(({ review, document, relationship }) => ({
                review,
                relationship,
                document: {
                  id: document.id, title: document.title, kind: document.kind,
                  gitPath: document.gitPath, state: document.state,
                  liveInstructionDocument: document.liveInstructionDocument,
                },
              })),
            },
          };
        } catch (e: any) {
          return { data: { error: e.message } };
        }
      }

      case "read_shared_spec_review": {
        const reviewId = String(args.review_id || '').trim();
        if (!reviewId) return { data: { error: 'review_id is required' } };
        try {
          const snapshot = await readAldenSharedSpecReview(reviewId);
          return { data: buildAldenReviewSourcePage(snapshot, args.offset ?? 0) };
        } catch (e: any) {
          return { data: { error: e.message } };
        }
      }

      case "claim_shared_spec_review": {
        const reviewId = String(args.review_id || '').trim();
        if (!reviewId) return { data: { error: 'review_id is required' } };
        try {
          const review = await claimAldenSharedSpecReview(reviewId);
          console.log(`[Alden Tool] claim_shared_spec_review: ${reviewId}`);
          return { data: { claimed: true, review } };
        } catch (e: any) {
          return { data: { error: e.message } };
        }
      }

      case "decide_shared_spec_review": {
        const reviewId = String(args.review_id || '').trim();
        const decision = args.decision === 'approve' || args.decision === 'reject' ? args.decision : undefined;
        const rationale = String(args.rationale || '').trim();
        const evidenceReferences = Array.isArray(args.evidence_references)
          ? args.evidence_references.filter((value: unknown): value is string => typeof value === 'string')
          : undefined;
        if (!reviewId) return { data: { error: 'review_id is required' } };
        if (!decision) return { data: { error: 'decision must be "approve" or "reject"' } };
        if (!rationale) return { data: { error: 'rationale is required' } };
        try {
          if (!context?.reviewReadSession) throw new Error("review_read_context_required");
          const snapshot = await readAldenSharedSpecReview(reviewId);
          context.reviewReadSession.assertComplete(snapshot, args.revision_id, args.content_sha256);
          const review = await decideAldenSharedSpecReview({ reviewId, decision, rationale, evidenceReferences });
          console.log(`[Alden Tool] decide_shared_spec_review: ${decision} ${reviewId}`);
          return { data: { decided: true, review } };
        } catch (e: any) {
          return { data: { error: e.message } };
        }
      }

      default:
        return { data: { error: `Unknown tool: ${toolName}` } };
    }
  } catch (error: any) {
    console.error(`[Alden Tool] ${toolName} failed:`, error.message);
    return { data: { error: error.message } };
  }
}

console.log('[Alden Functions] Loaded — 51 tools ready (monitoring + code + shell + memory + notifications + browser + web-fetch + briefing + express-lane-search + agent-notes + ai-cost-report + build-queue + self-tune + engine-switch + coordination + runtime-admin + episode-lifecycle)');

interface FallbackSearchOptions {
  glob?: string;
  caseSensitive?: boolean;
  contextLines?: number;
  maxMatches: number;
  /** Read-policy filter on the workspace-relative (posix) path. */
  isReadable: (rel: string) => boolean;
  /** Search only this entry of searchDir (a single top-level file). */
  onlyName?: string;
}

/**
 * Pure Node.js recursive regex search used only when rg is unavailable. Emits
 * ripgrep-compatible plain-text output (`file:line:content` for matches,
 * `file-line-content` for context lines, `--` between disjoint groups) so the
 * existing rg-output parsing in search_code/search_multi keeps working as-is.
 */
function fallbackCodeSearch(
  pattern: string,
  searchDir: string,
  opts: FallbackSearchOptions,
): { output: string; matchCount: number; bounded: boolean } {
  let matcher: RegExp;
  try {
    matcher = new RegExp(pattern, opts.caseSensitive ? '' : 'i');
  } catch (e: any) {
    throw new Error(`Invalid regex pattern: ${e.message}`);
  }
  const globMatcher = opts.glob ? globToRegExp(opts.glob) : null;
  const contextLines = opts.contextLines ?? 0;
  const startedAt = Date.now();
  const outputLines: string[] = [];
  let matchCount = 0;
  let filesScanned = 0;
  let bytesScanned = 0;
  let bounded = false;

  function walk(dir: string, depth: number): void {
    if (bounded || matchCount >= opts.maxMatches) return;
    if (depth > FALLBACK_MAX_DEPTH) {
      bounded = true;
      return;
    }
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (bounded || matchCount >= opts.maxMatches) return;
      if (opts.onlyName !== undefined && entry.name !== opts.onlyName) continue;
      if (
        Date.now() - startedAt > FALLBACK_MAX_MS ||
        filesScanned > FALLBACK_MAX_FILES_SCANNED ||
        bytesScanned > FALLBACK_MAX_BYTES_SCANNED
      ) {
        bounded = true;
        return;
      }
      if (entry.isSymbolicLink()) continue;
      const fullPath = path.join(dir, entry.name);
      const entryRel = path.relative(WORKSPACE_ROOT, fullPath).split(path.sep).join('/');
      if (entry.isDirectory()) {
        if (FALLBACK_EXCLUDED_DIRS.has(entry.name) || secretPathReason(entryRel)) continue;
        walk(fullPath, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      const ext = path.extname(entry.name).toLowerCase();
      if (FALLBACK_EXCLUDED_EXTENSIONS.has(ext)) continue;
      if (globMatcher && !globMatcher.test(entry.name)) continue;
      if (!opts.isReadable(entryRel)) continue;
      filesScanned++;
      let stat: fs.Stats;
      try {
        stat = fs.statSync(fullPath);
      } catch {
        continue;
      }
      if (stat.size > 4 * 1024 * 1024) continue; // skip unusually large files
      bytesScanned += stat.size;
      let content: string;
      try {
        content = fs.readFileSync(fullPath, 'utf8');
      } catch {
        continue;
      }
      if (content.includes('\u0000')) continue; // skip binary-looking files
      const lines = content.split('\n');
      const relPath = entryRel;
      let lastEmittedLine = -1;
      for (let i = 0; i < lines.length; i++) {
        if (matchCount >= opts.maxMatches) break;
        if (!matcher.test(lines[i])) continue;
        matchCount++;
        const from = Math.max(0, i - contextLines);
        const to = Math.min(lines.length - 1, i + contextLines);
        if (lastEmittedLine >= 0 && from > lastEmittedLine + 1) {
          outputLines.push('--');
        }
        for (let j = Math.max(from, lastEmittedLine + 1); j <= to; j++) {
          const sep = j === i ? ':' : '-';
          outputLines.push(`${relPath}${sep}${j + 1}${sep}${lines[j]}`);
        }
        lastEmittedLine = to;
      }
    }
  }

  walk(searchDir, 0);
  return { output: outputLines.join('\n'), matchCount, bounded };
}

interface CodeSearchExecOptions {
  contextLines: number;
  glob?: string;
  caseSensitive: boolean;
  maxMatches: number;
  maxBuffer: number;
  timeoutMs: number;
  rgExtraArgs?: string[];
}

function rgAvailable(): boolean {
  if (_rgAvailableOverride !== null) return _rgAvailableOverride;
  if (_rgAvailableCache === null) {
    try {
      execSync('command -v rg', { stdio: 'ignore', shell: '/bin/sh' });
      _rgAvailableCache = true;
    } catch {
      _rgAvailableCache = false;
      console.warn('[Alden search_code] ripgrep (rg) not found on PATH — using bounded JS fallback search');
    }
  }
  return _rgAvailableCache;
}

const FALLBACK_EXCLUDED_DIRS = new Set([
  'node_modules', 'dist', 'build', '.git', '.cache', '.next', '.turbo', 'coverage', 'out', '.local',
]);

let _rgAvailableOverride: boolean | null = null;

const FALLBACK_MAX_MS = 8_000;

const FALLBACK_MAX_DEPTH = 12;

/**
 * Run a code search preferring rg, transparently falling back to the bounded
 * JS scan when rg is absent from PATH (status 127 / ENOENT in production
 * containers that never bundled it). Both paths return rg-compatible plain
 * text so callers parse one format regardless of which path executed.
 */
function runCodeSearch(
  pattern: string,
  directory: string | undefined,
  opts: CodeSearchExecOptions,
): { output: string; usedFallback: boolean; bounded: boolean } {
  // Read confinement (design e4f8e988 P2): the directory is resolved under the
  // read policy, the search runs only over the readable roots beneath it, and
  // every result path is filtered again, by path and by content.
  const decision = resolveAldenReadPath(directory ?? '.', WORKSPACE_ROOT);
  if (!decision.ok) throw new Error(`Search refused: ${decision.reason}`);
  const roots = aldenSearchRoots(decision, WORKSPACE_ROOT);
  if (roots.length === 0) return { output: '', usedFallback: false, bounded: false };
  const readable = new Map<string, boolean>();
  const isReadable = (rel: string) => aldenReadablePath(rel, WORKSPACE_ROOT, readable);
  if (rgAvailable()) {
    // An argument array, never a shell command line: the model-supplied pattern,
    // glob and directory reach rg verbatim (file_glob used to be unquoted).
    // --json gives each result's exact path for the filter.
    const rgArgs: string[] = ['--json', '--hidden', '--glob=!node_modules/**', '--glob=!dist/**', '--glob=!.git/**', '--glob=!.env*'];
    if (!opts.caseSensitive) rgArgs.push('-i');
    if (opts.glob) rgArgs.push(`--glob=${opts.glob}`);
    if (opts.contextLines > 0) {
      rgArgs.push('-C', String(opts.contextLines));
    } else {
      rgArgs.push(...(opts.rgExtraArgs ?? ['--max-count=3']));
    }
    rgArgs.push('-e', pattern, '--', ...roots);
    try {
      const json = execFileSync('rg', rgArgs, {
        cwd: WORKSPACE_ROOT,
        maxBuffer: opts.maxBuffer * 4,
        timeout: opts.timeoutMs,
      }).toString();
      return { output: renderRgJson(json, opts.contextLines > 0, isReadable), usedFallback: false, bounded: false };
    } catch (e: any) {
      if (e.status === 1) return { output: '', usedFallback: false, bounded: false };
      if (e.status === 127 || e.code === 'ENOENT') {
        // rg vanished between the availability check and execution — force the
        // fallback for this call and re-check availability for future calls.
        _rgAvailableCache = false;
      } else {
        throw e;
      }
    }
  }
  let output = '';
  let bounded = false;
  for (const root of roots) {
    // A top-level file root is searched as the one named entry of its directory.
    const isFileRoot = fs.statSync(path.join(WORKSPACE_ROOT, root)).isFile();
    const result = fallbackCodeSearch(pattern, path.join(WORKSPACE_ROOT, isFileRoot ? path.dirname(root) : root), {
      glob: opts.glob,
      caseSensitive: opts.caseSensitive,
      contextLines: opts.contextLines,
      maxMatches: opts.maxMatches,
      isReadable,
      onlyName: isFileRoot ? path.basename(root) : undefined,
    });
    if (result.output) output += (output && opts.contextLines > 0 ? '\n--\n' : output ? '\n' : '') + result.output;
    bounded ||= result.bounded;
  }
  return { output, usedFallback: true, bounded };
}

/**
 * Render rg --json events as rg's plain text (`path:line:text` for matches,
 * `path-line-text` for context, `--` between groups in context mode), keeping
 * only results whose path passes the read policy.
 */
export function renderRgJson(json: string, withContext: boolean, isReadable: (rel: string) => boolean): string {
  const out: string[] = [];
  let lastPath = '';
  let lastLine = -1;
  for (const raw of json.split('\n')) {
    if (!raw) continue;
    let event: any;
    try { event = JSON.parse(raw); } catch { continue; }
    if (event.type !== 'match' && event.type !== 'context') continue;
    const file = event.data?.path?.text;
    const text = event.data?.lines?.text;
    const line = event.data?.line_number;
    if (typeof file !== 'string' || typeof text !== 'string' || typeof line !== 'number') continue;
    const rel = file.split('\\').join('/').replace(/^\.\//, '');
    if (!isReadable(rel)) continue;
    if (withContext && out.length > 0 && (rel !== lastPath || line > lastLine + 1)) out.push('--');
    const sep = event.type === 'match' ? ':' : '-';
    out.push(`${rel}${sep}${line}${sep}${text.replace(/\r?\n$/, '')}`);
    lastPath = rel;
    lastLine = line;
  }
  return out.join('\n');
}

const FALLBACK_MAX_FILES_SCANNED = 20_000;

const FALLBACK_EXCLUDED_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.ico', '.webp', '.bmp', '.svg',
  '.pdf', '.zip', '.tar', '.gz', '.woff', '.woff2', '.ttf', '.eot',
  '.mp3', '.mp4', '.mov', '.wav', '.ogg', '.avi',
  '.lock', '.map',
]);

/** Test-only seam: force the rg-available check to a fixed value. Pass null to clear the override. */
export function __setRgAvailableOverrideForTesting(value: boolean | null): void {
  _rgAvailableOverride = value;
}

const FALLBACK_MAX_BYTES_SCANNED = 80 * 1024 * 1024;

function globToRegExp(glob: string): RegExp {
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`, 'i');
}
