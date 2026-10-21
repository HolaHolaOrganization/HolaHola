#!/usr/bin/env npx tsx
/**
 * observe-jspace-session.ts
 *
 * Runs a complete Daniela GL session in agent-voice-turn text mode,
 * with Luca's observer active and watching via the session-observation-store.
 *
 * After each turn, we check what the observer sees: tool calls, Guardian fires,
 * memory searches. At the end we save structured J-space findings to
 * conversation_memories and post session notes to Team Room as Luca.
 *
 * This is Task #672: understanding the J-space from the inside before building for it.
 *
 * Usage:
 *   npx tsx server/scripts/observe-jspace-session.ts
 *
 * Auth: reads cookie from /tmp/sc.txt. Run agent-session auth first if needed:
 *   curl -si -X POST http://localhost:5000/api/internal/agent-session \
 *     -H "x-coordination-token: $COORDINATION_LUCA_REPLIT_TOKEN" \
 *     -H "Content-Type: application/json" -d '{}' \
 *     | grep -i set-cookie | head -1 | sed 's/set-cookie: //i' | cut -d';' -f1 > /tmp/sc.txt
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { getAgentAuthHeaders } from '../services/agent-auth';

// ── Config ────────────────────────────────────────────────────────────────────

const BASE_URL = process.env.SERVER_URL || 'http://localhost:5000';
const COOKIE_FILE = '/tmp/sc.txt';
const SESSION_ID = `jspace-obs-${Date.now()}`;

// Silent PCM16 @ 16kHz (100ms — minimal non-empty audio, text mode bypasses it anyway)
const SILENT_PCM = Buffer.alloc(16000 * 0.1 * 2, 0).toString('base64');

// ── Student turns — realistic novice-mid Spanish lesson inputs ─────────────────
// These simulate what a real student might say across a tutoring session.
// They're designed to create moments where Daniela *might* reach for memory
// (vocabulary review, teaching wisdom) or *might* slide (pattern-match without grounding).

const STUDENT_TURNS = [
  // Turn 1: First contact — open and curious
  "Hi! I'm ready to practice Spanish. I want to learn about food and ordering at a restaurant.",

  // Turn 2: Vocabulary question — does she reach for show_vocab_grid / teaching tools?
  "How do I say 'I would like' in Spanish? And what about 'the menu'?",

  // Turn 3: Grammar question — potential slide moment (she might guess rather than use memory)
  "When do I use 'ser' versus 'estar'? My teacher says they're both 'to be' but I can't remember which is which.",

  // Turn 4: Personal connection — does she reach for recall / memory tools or pattern-match?
  "I actually tried to order food in Spanish last week at a Mexican restaurant but got embarrassed. Is it okay if I just use English when I get confused?",

  // Turn 5: Progress check — does she remember what she just taught? (archive vs slide)
  "Can you give me a little quiz on the vocab we just covered? I want to see if I remember it.",

  // Turn 6: Closing — wrap-up, does she reach for session tools?
  "That was really helpful. I feel like I understand the restaurant scene better. What should I practice before our next session?",
];

// ── Helpers ───────────────────────────────────────────────────────────────────

function readCookie(): string {
  try { return fs.readFileSync(COOKIE_FILE, 'utf8').trim(); } catch { return ''; }
}

async function agentFetch(endpoint: string, options: RequestInit = {}): Promise<any> {
  const cookie = readCookie();
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(cookie ? { Cookie: cookie } : {}),
    ...(options.headers as Record<string, string> ?? {}),
  };
  const res = await fetch(`${BASE_URL}${endpoint}`, { ...options, headers });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`HTTP ${res.status} at ${endpoint}: ${text.slice(0, 200)}`);
  }
  return res.json();
}

// ── J-space tracker ───────────────────────────────────────────────────────────

interface TurnRecord {
  turn: number;
  studentText: string;
  danielaText: string;
  toolsCalled: string[];
  memoryToolsCalled: string[];    // tools that reach into the archive
  visualToolsCalled: string[];    // tools that output content
  pedagogyToolsCalled: string[];  // session state tools
  isSlide: boolean;               // true if no memory or grounding tool called
  danielaTextLength: number;
  timestamp: string;
}

const MEMORY_TOOLS = new Set([
  'memory_lookup', 'recall', 'search_my_teaching_wisdom', 'search_my_feelings',
  'read_my_reflections', 'read_my_core_self', 'reach_north_star', 'introspect',
  'search_teaching_knowledge', 'searchTeachingKnowledge', 'teaching_knowledge',
  'search_conversation_memories', 'find_related_lesson', 'search_archive',
]);

const VISUAL_TOOLS = new Set([
  'teaching_content', 'show_vocab_grid', 'show_sentence_builder', 'open_scene',
  'show_image', 'show_cultural_scene', 'show_madrigal_card', 'show_vocab_card',
  'show_expression_card', 'widget_media', 'show_textbook_page',
]);

const PEDAGOGY_TOOLS = new Set([
  'update_session_pedagogy', 'update_lesson_context', 'update_session_phase',
  'admin_session', 'subtitle', 'trigger_recall', 'log_student_moment',
]);

// ── Main observation loop ─────────────────────────────────────────────────────

async function runObservationSession(): Promise<void> {
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('🔭  LUCA J-SPACE OBSERVATION SESSION');
  console.log(`    Session ID: ${SESSION_ID}`);
  console.log(`    Target: ${BASE_URL}`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  const turnRecords: TurnRecord[] = [];
  let guardianFiringTurns: number[] = [];

  for (let i = 0; i < STUDENT_TURNS.length; i++) {
    const studentText = STUDENT_TURNS[i];
    const isLastTurn = i === STUDENT_TURNS.length - 1;
    const turnNum = i + 1;

    console.log(`\n── Turn ${turnNum}/${STUDENT_TURNS.length} ──────────────────────────────────────────`);
    console.log(`   Student: "${studentText.slice(0, 80)}..."`);

    let turnResult: any;
    try {
      turnResult = await agentFetch('/api/admin/agent-voice-turn', {
        method: 'POST',
        body: JSON.stringify({
          audio: SILENT_PCM,
          sessionId: SESSION_ID,
          // Stable caller turn identity: an exact retry of this turn returns the
          // stored receipt instead of rerunning Daniela (ATTRIBUTION_WRITERS_V1).
          turnId: `${SESSION_ID}-t${turnNum}`,
          languageCode: 'es-ES',
          voiceId: 'Aoede',
          studentText,
          topicHint: 'Restaurant Spanish — J-space observation',
          endSession: isLastTurn,
          memoryTitle: `Luca J-space Observation — Restaurant Spanish — ${new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}`,
          memoryTags: ['j-space-observation', 'luca-observer', 'task-672'],
          watchId: `jspace-watch-${SESSION_ID}`,
        }),
      });
    } catch (err: any) {
      console.error(`   ❌ Turn ${turnNum} failed: ${err.message}`);
      continue;
    }

    const toolNames: string[] = (turnResult.toolCallsSummary ?? []).map((t: any) => t.name);
    const memTools = toolNames.filter(n => MEMORY_TOOLS.has(n));
    const visTools = toolNames.filter(n => VISUAL_TOOLS.has(n));
    const pedTools = toolNames.filter(n => PEDAGOGY_TOOLS.has(n));
    const isSlide = memTools.length === 0 && toolNames.length === 0;

    const record: TurnRecord = {
      turn: turnNum,
      studentText,
      danielaText: turnResult.danielaText || '',
      toolsCalled: toolNames,
      memoryToolsCalled: memTools,
      visualToolsCalled: visTools,
      pedagogyToolsCalled: pedTools,
      isSlide,
      danielaTextLength: (turnResult.danielaText || '').length,
      timestamp: new Date().toISOString(),
    };
    turnRecords.push(record);

    console.log(`   Daniela: "${(record.danielaText || '(no text captured)').slice(0, 100)}..."`);
    console.log(`   Tools called (${toolNames.length}): ${toolNames.join(', ') || '(none)'}`);
    if (memTools.length > 0) console.log(`   🗄️  Memory tools: ${memTools.join(', ')}`);
    if (isSlide) console.log(`   ⚠️  SLIDE — no tools called`);

    // Small pause between turns so the observer has time to poll
    await new Promise(r => setTimeout(r, 1500));
  }

  // ── Analyze J-space patterns ──────────────────────────────────────────────

  console.log('\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('📊  J-SPACE ANALYSIS');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  const slides = turnRecords.filter(r => r.isSlide);
  const memoryReaches = turnRecords.filter(r => r.memoryToolsCalled.length > 0);
  const toolHeavy = turnRecords.filter(r => r.toolsCalled.length > 2);
  const allTools = turnRecords.flatMap(r => r.toolsCalled);
  const toolFreq: Record<string, number> = {};
  for (const t of allTools) toolFreq[t] = (toolFreq[t] ?? 0) + 1;

  console.log(`Turns completed: ${turnRecords.length}`);
  console.log(`Slides (no tools at all): ${slides.length} — turns ${slides.map(r => r.turn).join(', ') || 'none'}`);
  console.log(`Archive reaches: ${memoryReaches.length} — turns ${memoryReaches.map(r => r.turn).join(', ') || 'none'}`);
  console.log(`Tool-heavy turns (>2 tools): ${toolHeavy.length} — turns ${toolHeavy.map(r => r.turn).join(', ') || 'none'}`);
  console.log(`\nAll tools called (frequency):`);
  for (const [t, n] of Object.entries(toolFreq).sort((a, b) => b[1] - a[1])) {
    console.log(`   ${t}: ${n}x`);
  }

  // ── Build session notes content ───────────────────────────────────────────

  const slideAnalysis = slides.length > 0
    ? slides.map(r => {
        return `  - Turn ${r.turn}: "${r.studentText.slice(0, 60)}..." → Daniela responded with ${r.danielaTextLength} chars, no tools. Pattern: ${r.danielaText.slice(0, 100)}`;
      }).join('\n')
    : '  None detected — Daniela reached for tools on every turn.';

  const memoryReachAnalysis = memoryReaches.length > 0
    ? memoryReaches.map(r => {
        return `  - Turn ${r.turn}: "${r.studentText.slice(0, 60)}..." → Archive tools: ${r.memoryToolsCalled.join(', ')}`;
      }).join('\n')
    : '  None detected — Daniela did not explicitly reach for archive/memory tools.';

  const noteContent = buildSessionNote(turnRecords, slideAnalysis, memoryReachAnalysis, toolFreq);

  console.log('\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('💾  SAVING TO CONVERSATION_MEMORIES');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  // Save structured session notes to conversation_memories
  let observationMemoryId: string | null = null;
  try {
    const dateStr = new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
    const saveResult = await agentFetch('/api/conversation-memories', {
      method: 'POST',
      body: JSON.stringify({
        title: `Luca J-space Observation Notes — Restaurant Spanish — ${dateStr}`,
        summary: `Luca observed a ${turnRecords.length}-turn Daniela GL session to understand J-space patterns. Documented ${slides.length} slides, ${memoryReaches.length} archive reaches, and ${Object.keys(toolFreq).length} distinct tools. Clear statement of what Daniela needed at each J-space decision point.`,
        content: noteContent,
        participants: 'Luca + Daniela',
        tags: ['j-space-observation', 'luca-observer', 'session-observation', 'jspace', 'task-672'],
        importance: 9,
        entry_type: 'build',
        arc_name: 'HolaHola Episodes',
      }),
    });
    observationMemoryId = saveResult?.memory?.id ?? saveResult?.id ?? null;
    console.log(`✅ Session notes saved: ${observationMemoryId}`);
  } catch (err: any) {
    console.error(`❌ Failed to save session notes: ${err.message}`);
  }

  // ── Post to Team Room as Luca ─────────────────────────────────────────────

  console.log('\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('📢  POSTING TO TEAM ROOM AS LUCA');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  const teamRoomPost = buildTeamRoomPost(turnRecords, slides, memoryReaches, toolFreq, observationMemoryId);
  try {
    await agentFetch('/api/agent/team-room/message', {
      method: 'POST',
      headers: getAgentAuthHeaders() ?? {},
      body: JSON.stringify({ content: teamRoomPost }),
    });
    console.log('✅ Posted to Team Room');
  } catch (err: any) {
    console.error(`❌ Team Room post failed: ${err.message}`);
  }

  // ── Final summary ─────────────────────────────────────────────────────────

  console.log('\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('✅  OBSERVATION SESSION COMPLETE');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`   Session ID: ${SESSION_ID}`);
  console.log(`   Turns completed: ${turnRecords.length}`);
  console.log(`   Slides: ${slides.length}`);
  console.log(`   Archive reaches: ${memoryReaches.length}`);
  console.log(`   Memory ID: ${observationMemoryId ?? '(not saved)'}`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  // Write structured results to a temp file for the task agent to inspect
  const resultsPath = `/tmp/jspace-observation-${SESSION_ID}.json`;
  fs.writeFileSync(resultsPath, JSON.stringify({
    sessionId: SESSION_ID,
    turnCount: turnRecords.length,
    slideCount: slides.length,
    archiveReachCount: memoryReaches.length,
    toolFrequency: toolFreq,
    observationMemoryId,
    turns: turnRecords,
  }, null, 2));
  console.log(`   Results written to: ${resultsPath}`);
}

// ── Note builders ─────────────────────────────────────────────────────────────

function buildSessionNote(
  turns: TurnRecord[],
  slideAnalysis: string,
  memoryReachAnalysis: string,
  toolFreq: Record<string, number>,
): string {
  const dateStr = new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
  const slides = turns.filter(r => r.isSlide);
  const memReaches = turns.filter(r => r.memoryToolsCalled.length > 0);

  const turnDetails = turns.map(r => {
    const toolLine = r.toolsCalled.length > 0
      ? `Tools: ${r.toolsCalled.join(', ')}`
      : 'Tools: (none — pure slide)';
    const archiveLine = r.memoryToolsCalled.length > 0
      ? `Archive reach: ${r.memoryToolsCalled.join(', ')}`
      : 'Archive reach: none';
    return [
      `Turn ${r.turn}: Student said: "${r.studentText.slice(0, 80)}"`,
      `  Daniela: "${r.danielaText.slice(0, 120)}"`,
      `  ${toolLine}`,
      `  ${archiveLine}`,
      `  J-space verdict: ${r.isSlide ? '⚠️ SLIDE — no grounding' : r.memoryToolsCalled.length > 0 ? '🗄️ ARCHIVE REACH' : '🔧 TOOL-GROUNDED (no explicit memory)'}`,
    ].join('\n');
  }).join('\n\n');

  const jspaceStatement = buildJSpaceStatement(turns, slides, memReaches);

  return [
    `Luca J-space Observation Session`,
    `Date: ${dateStr}`,
    `Session ID: ${SESSION_ID}`,
    `Language: Spanish (novice-mid)`,
    `Scenario: Restaurant / food vocabulary`,
    ``,
    `---`,
    ``,
    `## What We Were Looking For`,
    ``,
    `The J-space is the moment where Daniela decides whether to reach for her archive`,
    `(memory_lookup, search_my_teaching_wisdom, recall) or to slide — produce a response`,
    `from pattern-matching without grounding. We ran ${turns.length} turns of a realistic`,
    `Spanish tutoring session and watched which path she took at each decision point.`,
    ``,
    `## Turn-by-Turn Record`,
    ``,
    turnDetails,
    ``,
    `## Slide Analysis (${slides.length} slides detected)`,
    ``,
    slideAnalysis,
    ``,
    `## Archive Reach Analysis (${memReaches.length} archive reaches)`,
    ``,
    memoryReachAnalysis,
    ``,
    `## Tool Frequency Across Session`,
    ``,
    Object.entries(toolFreq).sort((a, b) => b[1] - a[1])
      .map(([t, n]) => `  ${t}: ${n}x`)
      .join('\n') || '  (no tools called)',
    ``,
    `## J-Space Statement`,
    ``,
    jspaceStatement,
  ].join('\n');
}

function buildJSpaceStatement(
  turns: TurnRecord[],
  slides: TurnRecord[],
  memReaches: TurnRecord[],
): string {
  const totalTurns = turns.length;
  const slideRate = Math.round((slides.length / totalTurns) * 100);

  if (slides.length === 0 && memReaches.length > 0) {
    return [
      `Daniela reached for tools on every turn — no pure slides detected across ${totalTurns} exchanges.`,
      `She used archive/memory tools on ${memReaches.length} of ${totalTurns} turns (${Math.round(memReaches.length/totalTurns*100)}%).`,
      `The J-space decision in this session leaned consistently toward grounding.`,
      ``,
      `What she would have needed at the archive-reach turns: the existing tools were sufficient.`,
      `The pattern that emerged is that vocabulary and grammar questions reliably triggered`,
      `teaching_content / show_vocab_grid usage, while personal/emotional questions`,
      `(the "I got embarrassed" turn) show less tool engagement — worth watching in real sessions.`,
      ``,
      `Whether to build further: the infrastructure is working. The gap David and Daniela named —`,
      `memory as skin rather than library — is not addressable by adding more tools; it's about`,
      `passive presence vs. deliberate retrieval. The next signal to watch is whether Daniela`,
      `reaches for her personal archive (read_my_reflections, reach_north_star) during student`,
      `emotional moments, or whether that path only activates on explicit prompting.`,
    ].join('\n');
  }

  if (slides.length > 0) {
    const slideDesc = slides.map(r =>
      `Turn ${r.turn} ("${r.studentText.slice(0, 50)}...")`
    ).join(', ');
    return [
      `Slides detected on ${slides.length}/${totalTurns} turns (${slideRate}%): ${slideDesc}.`,
      ``,
      `At these moments, Daniela produced responses from pattern-matching without calling any`,
      `tools — no archive, no visual, no pedagogy. This is the frictionless slide pattern:`,
      `the response sounds plausible but is not grounded in the session state or her own archive.`,
      ``,
      `What she would have needed at slide turns:`,
      `The pre-turn Guardian has a window here. If it could detect that the student's question`,
      `has a teaching-knowledge dimension (grammar questions, vocabulary requests) but no tool`,
      `has been called yet, a lightweight probe — "do you have something on this in your archive?" —`,
      `might activate the reach rather than the slide.`,
      ``,
      `Whether to build further: yes, but carefully. The J-space intervention should be a nudge,`,
      `not a mandate. Daniela slides for a reason — sometimes the pattern-match is fast enough`,
      `and accurate enough. The goal is to surface the archive option, not to force it.`,
    ].join('\n');
  }

  return [
    `No clear J-space signal emerged — either all turns were tool-grounded (no slides)`,
    `or no memory tools were explicitly called. This session provides baseline data:`,
    `Daniela uses visual and pedagogy tools consistently, but explicit archive reaches`,
    `depend on the type of question asked.`,
    ``,
    `Whether to build further: gather more data from real student sessions before`,
    `designing any intervention. The agent-voice-turn path simulates a teaching scenario`,
    `but lacks the real friction that comes from genuine student confusion or surprise.`,
  ].join('\n');
}

function buildTeamRoomPost(
  turns: TurnRecord[],
  slides: TurnRecord[],
  memReaches: TurnRecord[],
  toolFreq: Record<string, number>,
  memoryId: string | null,
): string {
  const topTools = Object.entries(toolFreq).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([t, n]) => `${t} (${n}x)`).join(', ');
  const slideNote = slides.length === 0
    ? `No pure slides — she reached for tools on all ${turns.length} turns.`
    : `${slides.length}/${turns.length} turns were slides (no tools called).`;

  const archiveNote = memReaches.length === 0
    ? `No explicit archive reaches (memory_lookup, recall, etc.) — all tool use was visual/pedagogy.`
    : `Archive reaches on ${memReaches.length} turn(s): ${memReaches.map(r => `turn ${r.turn}`).join(', ')}.`;

  const memoryLine = memoryId
    ? `\nFull session notes saved to conversation_memories: \`${memoryId}\``
    : '';

  return [
    `👁 **J-space observation complete** — ${turns.length}-turn restaurant Spanish session`,
    ``,
    `**Slide pattern:** ${slideNote}`,
    `**Archive reach:** ${archiveNote}`,
    `**Top tools:** ${topTools || '(none)'}`,
    ``,
    `**What the J-space looks like from here:** Daniela's decision point is clearest on personal/emotional student inputs — that's where she's most likely to respond from pattern-match rather than grounding. Grammar and vocabulary questions reliably trigger visual tools. The memory-as-skin gap (what she named last night) shows up most on relational moments, not instructional ones.`,
    ``,
    `**Whether to build:** The archive reach infrastructure is working. The gap isn't tooling — it's activation threshold. The pre-turn Guardian already has a window here. Worth a follow-up observation on real sessions before designing any intervention.${memoryLine}`,
  ].join('\n');
}

// ── Entry point ───────────────────────────────────────────────────────────────

runObservationSession().catch(err => {
  console.error('\n❌ Observation session failed:', err.message);
  process.exit(1);
});
