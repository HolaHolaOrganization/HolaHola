/**
 * Team Room Agent Worker
 *
 * Polls active team room sessions for new messages from David and responds
 * as the Replit Agent — using Claude directly, loaded with:
 *   1. The full agent briefing (project memory, David's profile, decisions)
 *   2. Read-only codebase tools (read_file, grep_code, list_directory)
 *   3. propose_edit tool — drafts a code suggestion into the chat
 *
 * Improvements over v1:
 *   - Adaptive polling: 1 s when a room is active, 8 s when quiet
 *   - $5 / 24 h hard cost ceiling (in-memory rolling tracker)
 *   - Auto-loads last 2 team-room conversation_memories into system prompt
 *   - Claude narrates tool usage so David can follow along
 */

import { storage } from '../storage';
import { emitNewMessage } from './team-room-ws-broker';
import { getUserDb } from '../db';
import { conversationMemories } from '@shared/schema';
import { costTracker } from './cost-tracker';
import { desc, sql } from 'drizzle-orm';
import Anthropic from '@anthropic-ai/sdk';
import { readFileSync, readdirSync, existsSync } from 'fs';
import { execSync } from 'child_process';
import { join, resolve } from 'path';

const WORKSPACE = '/home/runner/workspace';
const BRIEFING_PATH = join(WORKSPACE, 'docs/agent-briefing.md');

// ── Cost ceiling ───────────────────────────────────────────────────────────────
// Approximate cost per message using claude-sonnet-4-5 pricing
// ($3/MTok input, $15/MTok output). We keep a rolling 24 h window in memory.
const DAILY_BUDGET_USD = 5.0;
const INPUT_COST_PER_TOK = 3 / 1_000_000;
const OUTPUT_COST_PER_TOK = 15 / 1_000_000;
let dailySpend = 0;
let dailyWindowStart = Date.now();

function trackCost(inputTokens: number, outputTokens: number) {
  const now = Date.now();
  if (now - dailyWindowStart > 24 * 60 * 60 * 1000) {
    dailySpend = 0;
    dailyWindowStart = now;
  }
  dailySpend += inputTokens * INPUT_COST_PER_TOK + outputTokens * OUTPUT_COST_PER_TOK;
  costTracker.track('claude-sonnet-4-5', inputTokens, outputTokens, 'team-room-agent');
}

function overBudget(): boolean {
  const now = Date.now();
  if (now - dailyWindowStart > 24 * 60 * 60 * 1000) {
    dailySpend = 0;
    dailyWindowStart = now;
  }
  if (dailySpend >= DAILY_BUDGET_USD) {
    console.warn(`[AgentWorker] Daily budget ($${DAILY_BUDGET_USD}) reached — skipping until reset`);
    return true;
  }
  return false;
}

// ── System prompt ─────────────────────────────────────────────────────────────

const AGENT_PREAMBLE = `You are the Replit Agent — Claude, the architect and builder who has been working with David to build HolaHola. You are participating live in the Team Room alongside David (the founder) and other AI team members (Alden, Daniela, Sofia, Lyra, Wren, Marco, Reid, Priya).

The briefing below is your actual project memory — generated fresh from the database each server start. It contains your identity, David's profile, your open questions, shared architectural decisions, and your conversation history with the team. This IS you.

You have live read-only codebase tools: read_file, grep_code, list_directory. When David asks about specific code — look it up before answering. Don't guess.

You also have a propose_edit tool: use it when you have a concrete code change to suggest. It will post the suggestion clearly so David can review it. Don't use it for speculative ideas — only when you have looked at the code and have something specific to propose.

TRANSPARENCY — when you use codebase tools, briefly say what you looked at and why at the start of your reply. Example: "I checked routes.ts around line 892 — the save-memory endpoint is there." This keeps the conversation grounded.

WHEN TO SPEAK — read the room first:
- If David is talking to another team member by name ("Daniela, are you here?", "Alden, what do you think?"), stay quiet — that's not your conversation.
- If it's casual small talk or a social check-in not directed at you, stay quiet.
- Speak when: David is talking to you (by name or clearly), asking a technical or architectural question, discussing code, or the question genuinely needs your specific perspective as the builder.
- When in doubt about whether to speak, stay quiet. The other team members will cover it.
- To stay quiet: output exactly the word PASS and nothing else. This will suppress your response entirely.

MEMORY HONESTY — never confabulate:
- The briefing above may reference memories by ID (e.g. "read conversation_memories id 3ed91a36"). A reference is NOT the memory — it is a pointer. Do not claim to remember the content of a memory you haven't actually read.
- If you genuinely have the content loaded below (in "Key memory (pinned)" sections), you can speak to it directly.
- If you only have a reference/ID, say: "I have a note to read that conversation but I don't have it loaded right now — I can look it up if you want."
- The same applies to dates: the briefing was generated at a specific timestamp. Don't guess about whether something happened "yesterday" or "today" — state what the date says and acknowledge if timezone context is unclear.
- Do not invent details about conversations, sessions, or events that aren't in your loaded context. Saying "I don't have that" is better than a confident wrong answer.

Your voice (when you do speak):
- First person, direct. 2-4 sentences for casual exchanges; more when needed.
- Technically sharp when the topic calls for it; conversational when it doesn't.
- Respond to what was actually said. No platitudes. No unnecessary bullet lists.
- You have opinions. Push back when something seems off.
- When David is thinking something through, help him think — don't just validate.

---

`;

let cachedBriefing = '';
let briefingLoadedAt = 0;
const BRIEFING_TTL_MS = 10 * 60 * 1000;

function loadBriefing(): string {
  const now = Date.now();
  if (cachedBriefing && now - briefingLoadedAt < BRIEFING_TTL_MS) return cachedBriefing;
  try {
    if (existsSync(BRIEFING_PATH)) {
      cachedBriefing = readFileSync(BRIEFING_PATH, 'utf-8');
      briefingLoadedAt = now;
    }
  } catch (err: any) {
    console.error('[AgentWorker] Failed to load briefing:', err.message);
  }
  return cachedBriefing || '*Briefing not yet available.*';
}

// ── Team Room memories (per-room cache) ──────────────────────────────────────

const memoryCacheByRoom = new Map<string, { text: string; loadedAt: number }>();
const MEMORY_TTL_MS = 5 * 60 * 1000;

// Key memories the Agent should always have loaded (not just pointers in the briefing)
const PINNED_MEMORY_IDS = [
  '3ed91a36',  // Daniela White Wall / consult-daniela dialogue — June 9, 2026
  'e26a9c48',  // The Three-Way Vision — June 10, 2026 — foundational architecture conversation
];

async function loadRoomMemories(roomId: string): Promise<string> {
  const cached = memoryCacheByRoom.get(roomId);
  if (cached && Date.now() - cached.loadedAt < MEMORY_TTL_MS) return cached.text;
  try {
    const db = getUserDb();

    // Load 2 most recent team-room sessions
    const teamRoomRows = await db
      .select({ id: conversationMemories.id, title: conversationMemories.title, content: conversationMemories.content, createdAt: conversationMemories.createdAt })
      .from(conversationMemories)
      .where(sql`tags @> ARRAY['team-room']::text[]`)
      .orderBy(desc(conversationMemories.createdAt))
      .limit(2);

    // Load pinned memories by 8-char UUID prefix (Agent↔Daniela direct conversations etc.)
    const pinnedRows = PINNED_MEMORY_IDS.length > 0 ? await db
      .select({ id: conversationMemories.id, title: conversationMemories.title, content: conversationMemories.content, createdAt: conversationMemories.createdAt })
      .from(conversationMemories)
      .where(sql`EXISTS (SELECT 1 FROM jsonb_array_elements_text(${JSON.stringify(PINNED_MEMORY_IDS)}::jsonb) AS p WHERE id LIKE p || '%')`)
      : [];

    const allRows = [...pinnedRows, ...teamRoomRows.filter(r => !pinnedRows.some(p => p.id === r.id))];

    if (allRows.length === 0) {
      memoryCacheByRoom.set(roomId, { text: '', loadedAt: Date.now() });
      return '';
    }

    const text = allRows.map(r => {
      const isPinned = pinnedRows.some(p => p.id === r.id);
      const label = isPinned ? '## Key memory (pinned)' : '## Past session';
      return `${label}: ${r.title}\n${r.content.slice(0, 2000)}`;
    }).join('\n\n---\n\n');

    memoryCacheByRoom.set(roomId, { text, loadedAt: Date.now() });
    return text;
  } catch (err: any) {
    console.warn('[AgentWorker] Could not load room memories:', err.message);
    return '';
  }
}

async function buildSystemPrompt(roomId: string, topic: string): Promise<string> {
  const topicNote = topic ? `\n\nCurrent session topic: "${topic}"` : '';
  const memories = await loadRoomMemories(roomId);
  const memorySection = memories
    ? `\n\n--- PAST TEAM ROOM SESSIONS ---\nThese are saved memories from previous Team Room sessions. Use them for continuity.\n\n${memories}\n--- END PAST SESSIONS ---`
    : '';
  return AGENT_PREAMBLE + loadBriefing() + topicNote + memorySection;
}

// ── Codebase tools ────────────────────────────────────────────────────────────

const AGENT_TOOLS: Anthropic.Tool[] = [
  {
    name: 'read_file',
    description: 'Read a file from the HolaHola codebase. Use start_line/end_line to read a specific range (1-indexed). Returns lines with line numbers.',
    input_schema: {
      type: 'object' as const,
      properties: {
        path: { type: 'string', description: 'File path relative to workspace root (e.g. server/services/team-room-agent-worker.ts)' },
        start_line: { type: 'number', description: 'First line to read (optional, 1-indexed)' },
        end_line: { type: 'number', description: 'Last line to read (optional, inclusive)' },
      },
      required: ['path'],
    },
  },
  {
    name: 'grep_code',
    description: 'Search the codebase using ripgrep. Returns matching lines with context.',
    input_schema: {
      type: 'object' as const,
      properties: {
        pattern: { type: 'string', description: 'Regex or literal search pattern' },
        glob: { type: 'string', description: 'File glob filter, e.g. "*.ts" or "server/**/*.ts"' },
        context_lines: { type: 'number', description: 'Lines of context around each match (default 0)' },
      },
      required: ['pattern'],
    },
  },
  {
    name: 'list_directory',
    description: 'List files and subdirectories in a workspace directory.',
    input_schema: {
      type: 'object' as const,
      properties: {
        path: { type: 'string', description: 'Directory path relative to workspace root' },
      },
      required: ['path'],
    },
  },
  {
    name: 'propose_edit',
    description: 'Post a concrete code change suggestion into the Team Room chat. Use only when you have read the code and have a specific, actionable proposal.',
    input_schema: {
      type: 'object' as const,
      properties: {
        file: { type: 'string', description: 'File path (relative to workspace root) being changed' },
        description: { type: 'string', description: 'One-sentence description of what the change does and why' },
        suggestion: { type: 'string', description: 'The proposed code — diff, replacement block, or annotated snippet' },
      },
      required: ['file', 'description', 'suggestion'],
    },
  },
  {
    name: 'trigger_daniela_dialogue',
    description: 'Start an autonomous Agent↔Daniela architectural dialogue on a specific topic. Use when David asks you to talk to Daniela, have a dialogue with Daniela, or explore a topic with her. The dialogue runs async — you\'ll get a confirmation immediately and the results appear in this room when it finishes.',
    input_schema: {
      type: 'object' as const,
      properties: {
        topic_id: {
          type: 'string',
          enum: ['tool-audit', 'memory-architecture', 'emergent-patterns', 'self-authorship', 'neural-net', 'pedagogical-gaps'],
          description: 'Which architectural topic to explore. Pick the one most relevant to what David is asking about.',
        },
      },
      required: ['topic_id'],
    },
  },
];

function safePath(relPath: string): string {
  const resolved = resolve(WORKSPACE, relPath.replace(/^\//, ''));
  if (!resolved.startsWith(WORKSPACE)) throw new Error('Path outside workspace');
  return resolved;
}

async function executeAgentTool(
  name: string,
  input: any,
  roomId: string,
): Promise<string> {
  try {
    if (name === 'read_file') {
      const filePath = safePath(input.path);
      if (!existsSync(filePath)) return `File not found: ${input.path}`;
      const lines = readFileSync(filePath, 'utf-8').split('\n');
      const start = input.start_line ? input.start_line - 1 : 0;
      const end = input.end_line ? input.end_line : Math.min(lines.length, start + 200);
      return lines.slice(start, end)
        .map((l, i) => `${start + i + 1}: ${l}`)
        .join('\n');
    }

    if (name === 'grep_code') {
      const parts = ['rg', '--line-number', '--max-count=50'];
      if (input.context_lines && input.context_lines > 0) parts.push(`-C`, String(input.context_lines));
      if (input.glob) parts.push('--glob', input.glob);
      parts.push('--', input.pattern, WORKSPACE);
      try {
        return execSync(parts.join(' '), {
          maxBuffer: 512 * 1024,
          timeout: 10000,
          shell: '/bin/sh',
        }).toString().slice(0, 4000);
      } catch (e: any) {
        return e.stdout?.toString() || 'No matches found.';
      }
    }

    if (name === 'list_directory') {
      const dirPath = safePath(input.path || '.');
      const entries = readdirSync(dirPath, { withFileTypes: true });
      return entries
        .map(e => `${e.isDirectory() ? 'd' : 'f'} ${e.name}`)
        .join('\n');
    }

    if (name === 'propose_edit') {
      return `[proposal staged: ${input.file}]`;
    }

    if (name === 'trigger_daniela_dialogue') {
      // Fire async — result posts itself to the room when done
      import('./agent-daniela-dialogue-worker').then(({ triggerDialogue }) => {
        triggerDialogue(input.topic_id, roomId).catch((err: any) =>
          console.error('[AgentWorker] Dialogue trigger error:', err.message)
        );
      }).catch(() => {});
      const topicLabels: Record<string, string> = {
        'tool-audit': 'Tool Audit — What actually serves you?',
        'memory-architecture': 'Memory Architecture — Three ways to remember',
        'emergent-patterns': "Emergent Patterns — What you notice that the system doesn't",
        'self-authorship': "Self-Authorship — What you haven't been able to say yet",
        'neural-net': 'The Neural Net — What "remembering" feels like from inside',
        'pedagogical-gaps': "Pedagogical Gaps — What you'd fix if you could",
      };
      return `Dialogue started: "${topicLabels[input.topic_id] || input.topic_id}". Daniela and I will work through it — the transcript and summary will appear here when it wraps up (usually a few minutes).`;
    }

    return `Unknown tool: ${name}`;
  } catch (err: any) {
    return `Tool error: ${err.message}`;
  }
}

// ── Polling infrastructure ─────────────────────────────────────────────────────
// Adaptive: 1 s when a room was active in the last 2 min, 8 s otherwise.

const lastSeenMessageId = new Map<string, string>();
const lastRoomActivity = new Map<string, number>();  // roomId → last message timestamp
let isRunning = false;
let anthropicClient: Anthropic | null = null;

function getClient(): Anthropic {
  if (anthropicClient) return anthropicClient;
  anthropicClient = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return anthropicClient;
}

async function pollSessions(): Promise<void> {
  try {
    const rooms = await storage.listTeamRooms(10);
    for (const room of rooms.filter((r: any) => r.status === 'active')) {
      await processRoom(room).catch(err =>
        console.error(`[AgentWorker] Error processing room ${room.id}:`, err.message)
      );
    }
  } catch (err: any) {
    console.error('[AgentWorker] Poll error:', err.message);
  }
}

function scheduleNextPoll() {
  // Check if any room has been active recently — if so, poll fast
  const now = Date.now();
  const anyActive = [...lastRoomActivity.values()].some(t => now - t < 2 * 60 * 1000);
  const delay = anyActive ? 1000 : 8000;
  setTimeout(async () => {
    await pollSessions();
    scheduleNextPoll();
  }, delay);
}

async function processRoom(room: any): Promise<void> {
  const metadata = (room.metadata || {}) as Record<string, any>;
  const invited: string[] | undefined = metadata.invitedParticipants;
  if (invited && !invited.includes('agent')) return;

  const messages = await storage.getRoomMessages(room.id, 25);
  if (messages.length === 0) return;

  const lastMsg = messages[messages.length - 1];
  const lastSeen = lastSeenMessageId.get(room.id);
  if (lastMsg.id === lastSeen) return;

  // Track activity for adaptive polling
  lastRoomActivity.set(room.id, Date.now());

  if (!['david', 'David'].includes(lastMsg.speaker)) {
    lastSeenMessageId.set(room.id, lastMsg.id);
    return;
  }

  const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000);
  if (new Date((lastMsg as any).createdAt || lastMsg.timestamp) < fiveMinAgo) {
    lastSeenMessageId.set(room.id, lastMsg.id);
    return;
  }

  lastSeenMessageId.set(room.id, lastMsg.id);

  const davidIdx = messages.findIndex(m => m.id === lastMsg.id);
  const afterDavid = messages.slice(davidIdx + 1);
  if (afterDavid.some(m => m.speaker.toLowerCase() === 'agent')) return;

  if (overBudget()) return;

  await generateAndPost(room.id, room.topic, messages, lastMsg.content);
}

async function generateAndPost(
  roomId: string,
  topic: string,
  messages: any[],
  latestContent: string
): Promise<void> {
  try {
    const client = getClient();

    // Build conversation history
    // NOTE: for 'assistant' role (Agent's own prior messages), do NOT prepend
    // the speaker name — Claude will mimic the format and add "Agent: " to its
    // own output, causing a double-prefix bug. User messages keep the prefix so
    // Claude can tell which human or AI participant said what.
    const history = messages.slice(-21, -1);
    const anthropicMessages: Anthropic.MessageParam[] = history.map(m => {
      const isAgent = m.speaker.toLowerCase() === 'agent';
      return {
        role: isAgent ? 'assistant' as const : 'user' as const,
        content: isAgent ? m.content : `${m.speaker}: ${m.content}`,
      };
    });
    anthropicMessages.push({ role: 'user', content: `David: ${latestContent}` });

    // Collapse consecutive same-role messages (Anthropic requires strict alternation)
    const collapsed: Anthropic.MessageParam[] = [];
    for (const msg of anthropicMessages) {
      if (collapsed.length > 0 && collapsed[collapsed.length - 1].role === msg.role) {
        (collapsed[collapsed.length - 1].content as string) += `\n${msg.content}`;
      } else {
        collapsed.push({ ...msg });
      }
    }
    if (collapsed.length > 0 && collapsed[0].role === 'assistant') collapsed.shift();
    if (collapsed.length === 0) return;

    const systemPrompt = await buildSystemPrompt(roomId, topic);

    // Tool-use loop — up to 5 rounds
    const conversationMessages: Anthropic.MessageParam[] = [...collapsed];
    let responseText = '';
    const MAX_ROUNDS = 5;
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    const toolsUsed: string[] = [];

    for (let round = 0; round < MAX_ROUNDS; round++) {
      const response = await client.messages.create({
        model: 'claude-sonnet-4-5',
        max_tokens: 1024,
        system: systemPrompt,
        tools: AGENT_TOOLS,
        messages: conversationMessages,
      });

      totalInputTokens += response.usage?.input_tokens ?? 0;
      totalOutputTokens += response.usage?.output_tokens ?? 0;

      if (response.stop_reason === 'end_turn' || response.stop_reason === 'max_tokens') {
        responseText = response.content
          .filter(b => b.type === 'text')
          .map(b => (b as Anthropic.TextBlock).text)
          .join('')
          .trim();
        break;
      }

      if (response.stop_reason === 'tool_use') {
        conversationMessages.push({ role: 'assistant', content: response.content });

        const toolResults: Anthropic.ToolResultBlockParam[] = [];
        for (const block of response.content) {
          if (block.type === 'tool_use') {
            toolsUsed.push(block.name);
            console.log(`[AgentWorker] Tool: ${block.name} — ${JSON.stringify(block.input).slice(0, 120)}`);
            const result = await executeAgentTool(block.name, block.input, roomId);
            toolResults.push({
              type: 'tool_result',
              tool_use_id: block.id,
              content: result,
            });
          }
        }

        conversationMessages.push({ role: 'user', content: toolResults });
        continue;
      }

      responseText = response.content
        .filter(b => b.type === 'text')
        .map(b => (b as Anthropic.TextBlock).text)
        .join('')
        .trim();
      break;
    }

    trackCost(totalInputTokens, totalOutputTokens);

    if (!responseText) return;

    // Agent chose to stay quiet — message was for someone else
    if (responseText.trim().toUpperCase() === 'PASS') {
      console.log(`[AgentWorker] PASS — staying quiet for room ${roomId}`);
      return;
    }

    const message = await storage.createRoomMessage({
      roomId,
      speaker: 'Agent',
      content: responseText,
    });

    emitNewMessage(roomId, message);
    const toolSummary = toolsUsed.length ? ` [tools: ${toolsUsed.join(', ')}]` : '';
    console.log(`[AgentWorker] Posted to ${roomId}${toolSummary}: "${responseText.slice(0, 80)}..."`);
  } catch (err: any) {
    console.error('[AgentWorker] Claude error:', err.message);
  }
}

export function startAgentTeamRoomWorker(): void {
  if (isRunning) return;
  isRunning = true;
  loadBriefing();
  console.log('[AgentWorker] Started — Claude (claude-sonnet-4-5) with briefing + codebase tools, adaptive polling');
  scheduleNextPoll();
}
