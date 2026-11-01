import { sql, eq, and, desc, ilike, or } from "drizzle-orm";
import { tutorSessions, hiveSnapshots, conversationMemories, userReviewItems, agentNotes, users, voiceSessions, voicePipelineEvents, pedagogicalSnapshots, studentMilestones, imageVisionCache, sophiaIncidents, neuralNetworkTelemetry } from "@shared/schema";
import { isValidActflLevel } from "../actfl-utils";
import { ExtractedFunctionCall } from "./gemini-streaming";
import type { StreamingSession } from "./streaming-voice-orchestrator";
import { getCharacter } from "./character-registry";
import { breakfastMenus, lunchMenus, menuTitleByLanguage } from '../data/language-menus-restaurant-mealtime';
import { restaurantMenus } from '../data/language-menus-restaurant-festival';
import { coffeeShopMenus } from '../data/language-menus-cafe-grocery';
import { getGeminiStreamingService } from "./gemini-streaming";
import { extractBoldMarkedWords } from "./language-segmenter";
import { TutorPersonality } from "./tts-service";
import { usageService } from "./usage-service";
import { brainHealthTelemetry } from "./brain-health-telemetry";
import { hiveCollaborationService, BeaconType } from "./hive-collaboration-service";
import { collaborationHubService } from "./collaboration-hub-service";
import { founderCollabService } from "./founder-collaboration-service";
import { journeyMemoryService } from "./journey-memory-service";
import { growthMemoryOutcomeService } from "./growth-memory-outcome-service";
import {
  excludesOperationalMemories,
  groundingMemoryTags,
  withAutobiographicalMemoryTag,
} from "./daniela-memory-boundary";
import { storage } from "../storage";
import { fetchPatternSignalContext } from './pattern-signal-context';
import { getSharedDb, getMonitoringDb } from "../db";
import { observeToolCall, observeSceneOpen, observeScenarioLoad, observeMemorySearch } from './session-observation-store';
import { WhiteboardItem, WordMapItem, isWordMapItem, SelfSurgeryItemData } from "@shared/whiteboard-types";
import { StreamingWhiteboardMessage } from "@shared/streaming-voice-types";
import { WebSocket as WS } from "ws";
import type { IStorage } from "../storage";
import { lookupLegacyType, isKnownTool } from "./daniela-function-registry";
import { generateReflectionNow } from "./session-reflection-worker";

// ─── Lesson Arc Context ────────────────────────────────────────────────────────
// In-memory per-session state that ties visual tools together into a coherent arc.
// Tools read from this when parameters are absent; update_lesson_context writes it explicitly.
// The heartbeat (UPDATE_SESSION_PEDAGOGY) writes phaseHint based on student readiness.

export interface LessonContext {
  phase: 'madrigal' | 'broadcast' | 'immersion' | 'free_flow' | 'recap' | null;
  scene: string | null;
  vocab: Array<{ text: string; translation: string; imageQuery?: string; imageUrl?: string }>;
  phaseObjective: string | null;
  phaseHint: string | null;    // suggestion written by pedagogical heartbeat
  updatedAt: number;
}

function initLessonContext(session: any): LessonContext {
  if (!(session as any).lessonContext) {
    (session as any).lessonContext = {
      phase: null, scene: null, vocab: [], phaseObjective: null, phaseHint: null, updatedAt: Date.now(),
    };
  }
  return (session as any).lessonContext as LessonContext;
}

function pushLessonStatusContext(session: any): void {
  const ctx = (session as any).lessonContext as LessonContext | undefined;
  if (!ctx) return;
  const parts: string[] = [];
  if (ctx.phase) parts.push(`Phase: ${ctx.phase}`);
  if (ctx.scene) parts.push(`Scene: ${ctx.scene}`);
  if (ctx.vocab.length > 0) parts.push(`Active vocab (${ctx.vocab.length}): ${ctx.vocab.map(v => v.text).join(', ')}`);
  if (ctx.phaseObjective) parts.push(`Objective: ${ctx.phaseObjective}`);
  if (ctx.phaseHint) parts.push(`Readiness signal: ${ctx.phaseHint}`);
  if (parts.length === 0) return;
  if (!session.pendingGlContext) session.pendingGlContext = [];
  // Deduplicate: remove any previous [Lesson context] line before pushing the current state.
  // Without this, pendingGlContext accumulates stale copies and eats into the 34K GL cap.
  session.pendingGlContext = (session.pendingGlContext as string[]).filter(s => !s.startsWith('[Lesson context]'));
  session.pendingGlContext.push(`[Lesson context] ${parts.join(' | ')}`);
}
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Parses the params_json string from a dispatcher tool call.
 *
 * Returns a discriminated union — callers must check .ok before using .params.
 * On failure, .error + .hint give GL enough to self-correct on the next turn.
 *
 * Phase 1 fix (June 13 2026): previously returned {} on unrecoverable failure,
 * causing silent success ("I've set the clock!" when nothing happened). Now
 * returns {ok:false} so the caller can surface the error to GL.
 */
type DispatchParseResult =
  | { ok: true; params: Record<string, any> }
  | { ok: false; error: string; hint: string };

function parseDispatcherParams(paramsJson: string | undefined, toolName: string): DispatchParseResult {
  if (!paramsJson || paramsJson.trim() === '' || paramsJson.trim() === '{}') {
    return { ok: true, params: {} };
  }

  let parsed: any;
  try {
    parsed = JSON.parse(paramsJson);
  } catch {
    try {
      parsed = JSON.parse(paramsJson.replace(/'/g, '"'));
    } catch {
      console.warn(`[Dispatcher] Failed to parse params_json for ${toolName}: ${paramsJson.slice(0, 120)}`);
      return {
        ok: false,
        error: `params_json is not valid JSON for "${toolName}". Got: ${paramsJson.slice(0, 80)}`,
        hint: 'Pass a valid JSON object string, e.g. {"key":"value"}. Do not use single quotes.',
      };
    }
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return {
      ok: false,
      error: `params_json for "${toolName}" must be a JSON object, not ${Array.isArray(parsed) ? 'array' : typeof parsed}.`,
      hint: 'Pass a JSON object: {"key":"value"}',
    };
  }

  // Redundant-key normalization: {"set_clock": {"time": "3:30"}} → {"time": "3:30"}
  if (parsed[toolName] !== undefined && typeof parsed[toolName] === 'object' && !Array.isArray(parsed[toolName])) {
    console.log(`[Dispatcher] Normalizing redundant key "${toolName}" in params_json`);
    return { ok: true, params: parsed[toolName] as Record<string, any> };
  }

  return { ok: true, params: parsed as Record<string, any> };
}

interface ArchitectMessage {
  type: 'question' | 'suggestion' | 'observation' | 'request';
  content: string;
  urgency?: 'low' | 'medium' | 'high';
}

export class NativeFunctionCallHandler {
  // Dedup guard for background Lyra re-extraction — keyed by conversationId, value is last extraction timestamp.
  // Prevents the same conversation from being re-extracted more than once per 24h, regardless of how many
  // search_conversation_threads / unified_recall calls hit it in a given session.
  private readonly lyraExtractionCache = new Map<string, number>();

  private readonly LYRA_EXTRACTION_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

  constructor(
    private sendMessage: (ws: any, message: any, session?: any) => void,
    private sendError: (ws: any, code: string, message: string, recoverable: boolean) => void,
    private processPhaseShift: (session: StreamingSession, data: { to: 'warmup' | 'active_teaching' | 'challenge' | 'reflection' | 'drill' | 'assessment'; reason: string }) => Promise<void>,
  ) {}

  /**
   * Phase 1 fix (June 13 2026):
   *  - Validates params_json via parseDispatcherParams discriminated union (no more silent {})
   *  - Tracks consecutive failures per dispatcher via session._dispatchFailures
   *  - Aborts after 2 consecutive parse failures to prevent GL self-correction loops
   */
  private async dispatchSubTool(
    sessionId: string,
    session: StreamingSession,
    selector: string | undefined,
    paramsJson: string | undefined,
    dispatcherName: string,
    selectorField: string,
  ): Promise<void> {
    const failures = ((session as any)._dispatchFailures ?? {}) as Record<string, number>;
    (session as any)._dispatchFailures = failures;

    if (!selector) {
      failures[dispatcherName] = (failures[dispatcherName] ?? 0) + 1;
      console.warn(`[Dispatcher] ${dispatcherName} called without ${selectorField} selector`);
      (session as any)._lastDispatch = { selector: '', status: 'error', error: `No ${selectorField} specified for ${dispatcherName}`, hint: `Pass ${selectorField}:"<value>" with one of the documented enum values.` };
      return;
    }

    if (!isKnownTool(selector)) {
      failures[dispatcherName] = (failures[dispatcherName] ?? 0) + 1;
      console.error(`[Dispatcher] ${dispatcherName}: unknown ${selectorField} "${selector}" — not in registry`);
      (session as any)._lastDispatch = { selector, status: 'error', error: `Unknown ${selectorField} "${selector}" in ${dispatcherName}. Use a valid enum value.`, hint: `Check the tool description for valid ${selectorField} values.` };
      return;
    }

    const parseResult = parseDispatcherParams(paramsJson, selector);

    if (!parseResult.ok) {
      failures[dispatcherName] = (failures[dispatcherName] ?? 0) + 1;
      const failCount = failures[dispatcherName];
      console.error(`[Dispatcher] ${dispatcherName} params_json parse failure #${failCount} for "${selector}": ${parseResult.error}`);

      if (failCount >= 2) {
        // Abort — prevent GL self-correction loop
        failures[dispatcherName] = 0;
        (session as any)._lastDispatch = { selector, status: 'abort' };
      } else {
        (session as any)._lastDispatch = {
          selector,
          status: 'error',
          error: parseResult.error,
          hint: parseResult.hint,
        };
      }
      return;
    }

    // Success — reset failure counter
    failures[dispatcherName] = 0;

    const legacyType = lookupLegacyType(selector);
    console.log(`[Dispatcher] ${dispatcherName} → ${selector} (${legacyType}), params: ${JSON.stringify(parseResult.params)}`);
    (session as any)._lastDispatch = { selector, status: 'success', params: parseResult.params };
    const syntheticFn: ExtractedFunctionCall = { name: selector, legacyType, args: parseResult.params };
    return this.handle(sessionId, session, syntheticFn);
  }

  async handle(sessionId: string, session: StreamingSession, fn: ExtractedFunctionCall): Promise<void> {
    console.log(`[Native Function Call] Processing: ${fn.name} -> ${fn.legacyType}`);
    const _convId = (session as any).conversationId as string | undefined;
    if (_convId) observeToolCall(_convId, fn.name);
    
    const fnText = (fn.args.text || fn.args.spoken_text) as string | undefined;
    if (fnText && fnText.includes('**')) {
      const fnBoldWords = extractBoldMarkedWords(fnText);
      if (fnBoldWords.length > 0) {
        const existing: string[] = session.accumulatedBoldWords || [];
        session.accumulatedBoldWords = [...new Set([...existing, ...fnBoldWords])];
        console.log(`[Native Function Call] Accumulated ${fnBoldWords.length} bold words from ${fn.name}: ${fnBoldWords.join(', ')}`);
        
        this.addSttKeyterms(session, fnBoldWords);
      }
    }
    
    if (!session.isIncognito) {
      brainHealthTelemetry.logToolCall({
        sessionId: session.id,
        conversationId: session.conversationId,
        userId: String(session.userId),
        targetLanguage: session.targetLanguage,
        toolName: fn.legacyType || fn.name,
      }).catch(err => console.warn('[BrainHealth] Tool call log failed:', err.message));
    }
    
    // Helper available to all cases: builds the COMPLETE scene canvas data object
    // from accumulated session state so every widget update carries ALL active widgets —
    // prevents later updates from overwriting earlier ones when multiple tools fire in
    // the same turn.
    const buildFullSceneCanvasData = (sc: typeof session.sceneCanvas, action: string) => ({
      environment: sc?.environment || '',
      environmentImageUrl: sc?.environmentImageUrl || '',
      environmentLabel: sc?.environmentLabel || '',
      props: [...(sc?.props || [])],
      clockTime: sc?.clockTime,
      clockLabel: sc?.clockLabel,
      clockShowLabel: sc?.clockShowLabel,
      thermometerData: sc?.thermometerData,
      emotionData: sc?.emotionData,
      weatherData: sc?.weatherData,
      worldMapData: sc?.worldMapData,
      canvasAction: action as any,
    });

    switch (fn.legacyType) {

      // ------------------------------------------------------------
      // DISPATCHER CASES — Hybrid architecture for GL 64-tool limit
      // Each dispatcher parses params_json and routes to the real handler.
      // ------------------------------------------------------------

      // ─── PHASE 2 DISPATCHERS — classroom_widget split into 6 (widget field) ───────
      case 'WIDGET_TIME': {
        // Flat-field dispatcher: Flash may pass time/date/temperature/unit directly
        // instead of serializing them into params_json. Normalize either path.
        const { widget: _wt, params_json: _pjt, ...flatT } = fn.args as any;
        const pjt = _pjt ?? (Object.keys(flatT).length > 0 ? JSON.stringify(flatT) : undefined);
        return this.dispatchSubTool(sessionId, session, _wt as string | undefined, pjt, 'widget_time', 'widget');
      }
      case 'WIDGET_STATE': {
        // Flat-field dispatcher: Flash may pass level/label/condition/country/content directly.
        const { widget: _ws, params_json: _pjs, ...flatS } = fn.args as any;
        const pjs = _pjs ?? (Object.keys(flatS).length > 0 ? JSON.stringify(flatS) : undefined);
        return this.dispatchSubTool(sessionId, session, _ws as string | undefined, pjs, 'widget_state', 'widget');
      }
      case 'WIDGET_BODY': {
        // Flat-field dispatcher: Flash may pass part directly.
        const { widget: _wb, params_json: _pjb, ...flatB } = fn.args as any;
        const pjb = _pjb ?? (Object.keys(flatB).length > 0 ? JSON.stringify(flatB) : undefined);
        return this.dispatchSubTool(sessionId, session, _wb as string | undefined, pjb, 'widget_body', 'widget');
      }
      case 'WIDGET_SCENE':
        return this.dispatchSubTool(sessionId, session, fn.args.widget as string | undefined, fn.args.params_json as string | undefined, 'widget_scene', 'widget');
      case 'WIDGET_BOARD':
        return this.dispatchSubTool(sessionId, session, fn.args.widget as string | undefined, fn.args.params_json as string | undefined, 'widget_board', 'widget');
      case 'WIDGET_MEDIA':
        return this.dispatchSubTool(sessionId, session, fn.args.widget as string | undefined, fn.args.params_json as string | undefined, 'widget_media', 'widget');

      // ─── exercise_tool split into 3 (type field) ────────────────────────────────
      case 'EXERCISE_LANGUAGE':
        return this.dispatchSubTool(sessionId, session, fn.args.type as string | undefined, fn.args.params_json as string | undefined, 'exercise_language', 'type');
      case 'EXERCISE_DRILL':
        return this.dispatchSubTool(sessionId, session, fn.args.type as string | undefined, fn.args.params_json as string | undefined, 'exercise_drill', 'type');
      case 'EXERCISE_CONTENT':
        return this.dispatchSubTool(sessionId, session, fn.args.type as string | undefined, fn.args.params_json as string | undefined, 'exercise_content', 'type');

      // ─── memory_action split into 2 (action field) ──────────────────────────────
      case 'MEMORY_RECORD':
        return this.dispatchSubTool(sessionId, session, fn.args.action as string | undefined, fn.args.params_json as string | undefined, 'memory_record', 'action');
      case 'MEMORY_REVIEW':
        return this.dispatchSubTool(sessionId, session, fn.args.action as string | undefined, fn.args.params_json as string | undefined, 'memory_review', 'action');

      // ─── admin_action split into 2 (action field) ───────────────────────────────
      case 'ADMIN_SESSION':
        return this.dispatchSubTool(sessionId, session, fn.args.action as string | undefined, fn.args.params_json as string | undefined, 'admin_session', 'action');
      case 'ADMIN_TOOLS':
        return this.dispatchSubTool(sessionId, session, fn.args.action as string | undefined, fn.args.params_json as string | undefined, 'admin_tools', 'action');

      // ─── daniela_internal split into 2 (action field) ───────────────────────────
      case 'SELF_WRITE':
        return this.dispatchSubTool(sessionId, session, fn.args.action as string | undefined, fn.args.params_json as string | undefined, 'self_write', 'action');
      case 'SELF_READ':
        return this.dispatchSubTool(sessionId, session, fn.args.action as string | undefined, fn.args.params_json as string | undefined, 'self_read', 'action');

      // ─── teaching_delivery split into 2 (type field) ────────────────────────────
      case 'TEACHING_CARDS':
        return this.dispatchSubTool(sessionId, session, fn.args.type as string | undefined, fn.args.params_json as string | undefined, 'teaching_cards', 'type');
      case 'TEACHING_CONTENT':
        return this.dispatchSubTool(sessionId, session, fn.args.type as string | undefined, fn.args.params_json as string | undefined, 'teaching_content', 'type');

      case 'SEARCH_MEMORY': {
        const smRelatedTo = fn.args.related_to as string | undefined;
        const smSpeaker = fn.args.speaker as string | undefined;
        const smMemoryId = fn.args.memory_id as string | undefined;
        const smQuery = fn.args.query as string | undefined;
        const smAfterDate = fn.args.after_date as string | undefined;
        const smBeforeDate = fn.args.before_date as string | undefined;

        if (smRelatedTo) {
          // Chain traversal through the shared conversation_memories archive
          console.log(`[Dispatcher] introspect → chain traversal from memory_id=${smRelatedTo}`);
          return this.processIntrospectChain(session, smRelatedTo);
        }
        if (smSpeaker) {
          // Speaker-filtered search through the shared conversation_memories archive
          console.log(`[Dispatcher] introspect → speaker filter speaker="${smSpeaker}" query="${smQuery?.substring(0, 60) ?? ''}"`);
          return this.processIntrospectSpeaker(session, smSpeaker, smQuery);
        }
        if (smMemoryId) {
          // Connected memory traversal → FIND_CONNECTED_MEMORIES
          console.log(`[Dispatcher] introspect → find_connected_memories, id=${smMemoryId}`);
          const smConnFn: ExtractedFunctionCall = { name: 'find_connected_memories', legacyType: 'FIND_CONNECTED_MEMORIES', args: { memory_id: smMemoryId, memory_type: fn.args.memory_type, limit: fn.args.limit } };
          return this.handle(sessionId, session, smConnFn);
        }
        if ((smAfterDate || smBeforeDate) && !smQuery) {
          // Time-based browse → CONVERSATION_DATE_BROWSE
          console.log(`[Dispatcher] introspect → browse_conversations_by_date after=${smAfterDate} before=${smBeforeDate}`);
          const smDateFn: ExtractedFunctionCall = { name: 'browse_conversations_by_date', legacyType: 'CONVERSATION_DATE_BROWSE', args: { after_date: smAfterDate, before_date: smBeforeDate, limit: fn.args.limit } };
          return this.handle(sessionId, session, smDateFn);
        }
        if (smQuery) {
          // Default: keyword search → UNIFIED_RECALL
          console.log(`[Dispatcher] introspect → unified_recall query="${smQuery.substring(0, 60)}"`);
          const smRecallFn: ExtractedFunctionCall = { name: 'recall', legacyType: 'UNIFIED_RECALL', args: { query: smQuery } };
          return this.handle(sessionId, session, smRecallFn);
        }
        console.warn('[Dispatcher] introspect called with no query, date range, memory_id, speaker, or related_to — ignoring');
        break;
      }

      case 'SAVE_NOTE': {
        const snTarget = (fn.args.target as string | undefined) || 'tutor';
        const snContent = fn.args.content as string | undefined;
        if (!snContent?.trim()) {
          console.warn('[Dispatcher] save_note called with no content');
          break;
        }
        if (snTarget === 'hive') {
          console.log(`[Dispatcher] save_note → save_hive_note`);
          const snHiveFn: ExtractedFunctionCall = { name: 'save_hive_note', legacyType: 'SAVE_HIVE_NOTE', args: { content: snContent, tags: fn.args.tags } };
          return this.handle(sessionId, session, snHiveFn);
        }
        if (snTarget === 'student') {
          console.log(`[Dispatcher] save_note → leave_for_next_session`);
          const snStudentFn: ExtractedFunctionCall = { name: 'leave_for_next_session', legacyType: 'LEAVE_FOR_NEXT_SESSION', args: { content: snContent, targetUserId: fn.args.targetUserId } };
          return this.handle(sessionId, session, snStudentFn);
        }
        // Default: tutor private notebook → TAKE_NOTE
        const snType = (fn.args.type as string | undefined) || 'session_reflection';
        const snTitle = (fn.args.title as string | undefined) || snContent.slice(0, 40);
        console.log(`[Dispatcher] save_note → take_note type="${snType}"`);
        const snTutorFn: ExtractedFunctionCall = { name: 'take_note', legacyType: 'TAKE_NOTE', args: { type: snType, title: snTitle, content: snContent, tags: fn.args.tags, language: fn.args.language } };
        return this.handle(sessionId, session, snTutorFn);
      }

      case 'SEARCH_TEACHING_WISDOM': {
        const stwQuery = fn.args.query as string | undefined;
        const stwLanguage = fn.args.language as string | undefined;
        if (!stwQuery?.trim()) {
          console.warn('[Dispatcher] search_my_teaching_wisdom called with no query — ignoring');
          break;
        }
        const stwKey = stwQuery.trim().toLowerCase(); // normalize for consistent lookup
        console.log(`[Dispatcher] search_my_teaching_wisdom query="${stwQuery.substring(0, 80)}" lang=${stwLanguage || 'any'}`);
        try {
          const { searchTeachingKnowledge: searchTeaching, formatTeachingKnowledge } = await import('./neural-memory-search');
          const stwStart = Date.now();
          const results = await searchTeaching(stwQuery, stwLanguage);
          const stwDurationMs = Date.now() - stwStart;
          const formatted = formatTeachingKnowledge(results);

          // Telemetry — mirrors the insert in streaming-voice-orchestrator.ts so GL sessions
          // appear in the neural_network_telemetry table alongside text-mode sessions.
          const stwDomainCounts = results.results.reduce((acc, r) => {
            acc[r.domain] = (acc[r.domain] || 0) + 1; return acc;
          }, {} as Record<string, number>);

          // Real-time observation bench update
          observeMemorySearch((session as any).conversationId, {
            query: stwQuery,
            tool: 'search_my_teaching_wisdom',
            resultCount: results.results.length,
            durationMs: stwDurationMs,
            domainsSearched: results.searchedDomains,
            formattedChars: formatted.length,
          });

          getSharedDb().insert(neuralNetworkTelemetry).values({
            voiceSessionId: session.id ?? null,
            userId: session.userId ? String(session.userId) : null,
            targetLanguage: stwLanguage ?? session.targetLanguage ?? null,
            query: stwQuery,
            domainsSearched: results.searchedDomains,
            domainsRequested: null,
            resultCount: results.results.length,
            formattedCharacterLength: formatted.length,
            idiomCount: stwDomainCounts['idiom'] || 0,
            culturalCount: stwDomainCounts['cultural'] || 0,
            procedureCount: stwDomainCounts['procedure'] || 0,
            principleCount: stwDomainCounts['principle'] || 0,
            errorPatternCount: stwDomainCounts['error-pattern'] || 0,
            situationalPatternCount: stwDomainCounts['situational-pattern'] || 0,
            subtletyCueCount: stwDomainCounts['subtlety-cue'] || 0,
            emotionalPatternCount: stwDomainCounts['emotional-pattern'] || 0,
            creativityTemplateCount: stwDomainCounts['creativity-template'] || 0,
            searchDurationMs: stwDurationMs,
          }).catch(() => {});

          if (!('teachingWisdomResults' in session)) (session as any).teachingWisdomResults = {};
          if (formatted && formatted.trim()) {
            const MAX_WISDOM_CHARS = 1000;
            const truncated = formatted.length > MAX_WISDOM_CHARS
              ? formatted.slice(0, MAX_WISDOM_CHARS) + '… [truncated for context budget]'
              : formatted;
            if (formatted.length > 1024) {
              console.warn(`[Dispatcher] search_my_teaching_wisdom: result ${formatted.length} chars — truncating to ${MAX_WISDOM_CHARS} (context budget protection)`);
            }
            (session as any).teachingWisdomResults[stwKey] = `[Teaching knowledge for "${stwQuery}"]\n\n${truncated}\n\nThese are your own teaching records. Speak from them.`;
          } else {
            (session as any).teachingWisdomResults[stwKey] = `No specific HolaHola pedagogy found for "${stwQuery}". Use a standard teaching explanation — avoid inventing a Madrigal image if none was returned.`;
          }
        } catch (err: any) {
          console.error('[Dispatcher] search_my_teaching_wisdom error:', err?.message);
          if (!('teachingWisdomResults' in session)) (session as any).teachingWisdomResults = {};
          (session as any).teachingWisdomResults[stwKey] = `Search failed: ${err?.message || 'unknown error'}. Use a standard teaching explanation rather than improvising.`;
        }
        break;
      }

      case 'SWITCH_TUTOR': {
        const target = fn.args.target as string | undefined;
        const language = fn.args.language as string | undefined;
        const role = fn.args.role as string | undefined;
        const makePermanent = fn.args.make_permanent as boolean | undefined;
        const mode = fn.args.mode as 'tutor_mode' | 'founder_mode' | 'honesty_mode' | undefined;
        
        const isCrossLangRequest = language && language.toLowerCase() !== (session.targetLanguage || '').toLowerCase();
        if (target && !session.pendingTutorSwitch && (!session.crossLanguageTransferBlocked || !isCrossLangRequest)) {
          const targetGender = target as 'male' | 'female';
          console.log(`[Native Function Call] SWITCH_TUTOR -> ${targetGender}, language: ${language || 'same'}, role: ${role || 'tutor'}${makePermanent ? ' [PERMANENT]' : ''}${mode ? ` [MODE: ${mode}]` : ''}`);
          
          session.pendingTutorSwitch = {
            targetGender,
            targetLanguage: language || session.targetLanguage,
            targetRole: (role === 'assistant' ? 'assistant' : 'tutor') as 'tutor' | 'assistant' | undefined,
            mode,
          };
          session.switchTutorTriggered = true;

          // Save as permanent preferred tutor when the student requests it
          if (makePermanent && session.userId && language) {
            try {
              const { users: usersTable } = await import('@shared/schema');
              const db = getSharedDb();
              await db.update(usersTable)
                .set({ targetLanguage: language, tutorGender: targetGender })
                .where(eq(usersTable.id, String(session.userId)));
              console.log(`[SWITCH_TUTOR] Saved permanent preferred tutor: ${language}/${targetGender} for user ${session.userId}`);
            } catch (err: any) {
              console.warn(`[SWITCH_TUTOR] Failed to save permanent preference:`, err.message);
            }
          }
        }
        break;
      }
      
      case 'PHASE_SHIFT': {
        const text = fn.args.text as string | undefined;
        const to = fn.args.to as string | undefined;
        const reason = fn.args.reason as string | undefined;
        if (to && reason) {
          this.processPhaseShift(session, { 
            to: to as 'warmup' | 'active_teaching' | 'challenge' | 'reflection' | 'drill' | 'assessment', 
            reason 
          }).catch(err => console.error(`[Native Function→PhaseShift] Error:`, err));
          console.log(`[Native Function→PhaseShift] Triggered: ${to} - ${reason}`);
        }
        if (text && !session.functionCallText) {
          session.functionCallText = text;
          console.log(`[Native Function→PhaseShift] Text included: "${text.substring(0, 50)}..."`);
        }
        break;
      }
      
      case 'VOICE_ADJUST': {
        const action = (fn.args.action as string | undefined) || 'set';
        if (action === 'reset') {
          const text = fn.args.text as string | undefined;
          const reason = fn.args.reason as string | undefined;
          if (session.voiceDefaults) {
            session.voiceOverride = {
              speakingRate: session.voiceDefaults.speakingRate,
              emotion: session.voiceDefaults.emotion,
              personality: session.voiceDefaults.personality,
              expressiveness: session.voiceDefaults.expressiveness,
            };
            console.log(`[Native Function→VoiceAdjust/Reset] Reset to defaults:`, session.voiceDefaults, `reason: ${reason || 'none'}`);
          } else {
            session.voiceOverride = undefined;
            console.log(`[Native Function→VoiceAdjust/Reset] Cleared override (no defaults stored), reason: ${reason || 'none'}`);
          }
          if (text && !session.functionCallText) session.functionCallText = text;
          break;
        }
        const text = fn.args.text as string | undefined;
        const speed = (fn.args.speed as string | undefined)?.toLowerCase();
        const emotion = (fn.args.emotion as string | undefined)?.toLowerCase();
        const personality = (fn.args.personality as string | undefined)?.toLowerCase();
        const vocalStyle = fn.args.vocal_style as string | undefined;
        const reason = fn.args.reason as string | undefined;
        
        const speedMap: Record<string, number> = {
          'slowest': 0.7,
          'slow': 0.8,
          'normal': 0.9,
          'fast': 1.05,
          'fastest': 1.2,
        };
        
        const emotionMap: Record<string, string> = {
          'positivity': 'happy',
          'curiosity': 'curious',
          'surprise': 'surprised',
          'anger': 'neutral',
          'sadness': 'thoughtful',
          'happy': 'happy',
          'excited': 'excited',
          'friendly': 'friendly',
          'curious': 'curious',
          'thoughtful': 'thoughtful',
          'warm': 'warm',
          'playful': 'playful',
          'surprised': 'surprised',
          'proud': 'proud',
          'encouraging': 'encouraging',
          'calm': 'calm',
          'neutral': 'neutral',
        };
        
        const validPersonalities = ['warm', 'calm', 'energetic', 'professional'];
        const validatedPersonality = personality && validPersonalities.includes(personality) 
          ? personality as TutorPersonality 
          : undefined;
        
        const mappedEmotion = emotion ? emotionMap[emotion] : undefined;
        
        const currentOverride = session.voiceOverride || {};
        const newOverride = {
          ...currentOverride,
          ...(speed && { speakingRate: speedMap[speed] || 0.9 }),
          ...(mappedEmotion && { emotion: mappedEmotion }),
          ...(validatedPersonality && { personality: validatedPersonality }),
          ...(vocalStyle && { vocalStyle }),
        };
        
        session.voiceOverride = newOverride;
        
        if (text) {
          session.voiceAdjustText = text;
          if (!session.functionCallText) {
            session.functionCallText = text;
          }
          console.log(`[Native Function→VoiceAdjust] Text included (${text.length} chars): "${text.substring(0, 80)}..."`);
        }
        
        console.log(`[Native Function→VoiceAdjust] Applied: speed=${speed || 'unchanged'} (rate=${speed ? speedMap[speed] : 'unchanged'}), emotion=${emotion || 'unchanged'} (mapped=${mappedEmotion || 'unchanged'}), personality=${validatedPersonality || 'unchanged'}, vocalStyle=${vocalStyle ? `"${vocalStyle.substring(0, 60)}"` : 'unchanged'}, reason=${reason || 'none'}`);
        console.log(`[Native Function→VoiceAdjust] Session override now:`, newOverride);
        break;
      }
      
      case 'SPEAK_AS': {
        const characterId = fn.args.character as string | undefined;
        const text = fn.args.text as string | undefined;
        const roleOverride = fn.args.role as string | undefined;

        if (!characterId) {
          console.warn('[Native Function→SpeakAs] No character ID provided — ignoring');
          break;
        }

        const character = getCharacter(session.targetLanguage || 'spanish', characterId);
        if (!character) {
          console.warn(`[Native Function→SpeakAs] Unknown character "${characterId}" for language "${session.targetLanguage}" — ignoring`);
          break;
        }

        // Save the tutor's voice and provider before the first character switch
        if (!session.activeCharacter) {
          session._tutorVoiceBeforeCharacter = session.voiceId;
          session._tutorTtsProviderBeforeCharacter = session.ttsProvider;
        }

        // Swap voice AND provider to the character's configuration
        session.voiceId = character.voiceId;
        session.ttsProvider = character.ttsProvider;
        session.activeCharacter = {
          id: character.id,
          displayName: character.displayName,
          role: roleOverride || character.role,
          gender: character.gender,
          voiceId: character.voiceId,
          ttsProvider: character.ttsProvider,
        };

        // Route the character's text through TTS (same mechanism as VOICE_ADJUST)
        if (text) {
          session.functionCallText = text;
        }

        // Notify client of character change
        this.sendMessage(session.ws, {
          type: 'character_change',
          character: {
            id: character.id,
            displayName: character.displayName,
            role: session.activeCharacter.role,
            gender: character.gender,
          },
          timestamp: Date.now(),
        });

        console.log(`[Native Function→SpeakAs] Character "${character.displayName}" (${character.id}) is now speaking. voiceId=${character.voiceId}`);
        break;
      }

      case 'RESUME_TUTOR': {
        const text = fn.args.text as string | undefined;

        // Restore the tutor's original voice and provider
        if (session._tutorVoiceBeforeCharacter) {
          session.voiceId = session._tutorVoiceBeforeCharacter;
          session._tutorVoiceBeforeCharacter = undefined;
        }
        if (session._tutorTtsProviderBeforeCharacter) {
          session.ttsProvider = session._tutorTtsProviderBeforeCharacter;
          session._tutorTtsProviderBeforeCharacter = undefined;
        }
        session.activeCharacter = null;

        if (text && !session.functionCallText) {
          session.functionCallText = text;
        }

        // Notify client: back to tutor
        this.sendMessage(session.ws, {
          type: 'character_change',
          character: null,
          timestamp: Date.now(),
        });

        console.log(`[Native Function→ResumeTutor] Returned to tutor voice. voiceId=${session.voiceId}`);
        break;
      }

      case 'SPEAK_CHARACTER_LINE': {
        // Atomic single-call replacement for speak_as + resume_tutor.
        // The character speaks one line; tts-dispatcher auto-restores tutor voice
        // after functionCallText is consumed (no separate resume_tutor call needed).
        const characterId = fn.args.character as string | undefined;
        const text = fn.args.text as string | undefined;
        const roleOverride = fn.args.role as string | undefined;

        if (!characterId || !text) {
          console.warn('[Native Function→SpeakCharacterLine] Missing character or text — ignoring');
          break;
        }

        const character = getCharacter(session.targetLanguage || 'spanish', characterId);
        if (!character) {
          console.warn(`[Native Function→SpeakCharacterLine] Unknown character "${characterId}" for language "${session.targetLanguage}" — ignoring`);
          break;
        }

        // Save the restore target (current tutor voice) BEFORE swapping
        const savedVoiceId = session._tutorVoiceBeforeCharacter || session.voiceId;
        const savedTtsProvider = session._tutorTtsProviderBeforeCharacter || session.ttsProvider;

        // Swap voice + provider to the character for this one line
        session.voiceId = character.voiceId;
        session.ttsProvider = character.ttsProvider;
        session.activeCharacter = {
          id: character.id,
          displayName: character.displayName,
          role: roleOverride || character.role,
          gender: character.gender,
          voiceId: character.voiceId,
          ttsProvider: character.ttsProvider,
        };

        // Queue the character's line for TTS
        session.functionCallText = text;

        // Schedule auto-restore: tts-dispatcher will apply this immediately after
        // functionCallText is spoken (batch path: line ~1049; sentence path: ~1086)
        session._restoreVoiceAfterLine = { voiceId: savedVoiceId!, ttsProvider: savedTtsProvider! };

        // Notify client that character is speaking (brief overlay)
        this.sendMessage(session.ws, {
          type: 'character_change',
          character: {
            id: character.id,
            displayName: character.displayName,
            role: session.activeCharacter.role,
            gender: character.gender,
          },
          timestamp: Date.now(),
        });

        console.log(`[Native Function→SpeakCharacterLine] "${character.displayName}" speaks one line, then auto-restore to voiceId=${savedVoiceId}`);
        break;
      }

      case 'WORD_EMPHASIS': {
        const word = fn.args.word as string;
        const style = fn.args.style as 'stress' | 'slow' | 'both';
        const reason = fn.args.reason as string | undefined;
        
        if (word && style) {
          if (!session.pendingWordEmphases) {
            session.pendingWordEmphases = [];
          }
          session.pendingWordEmphases.push({ word, style });
          console.log(`[Native Function→WordEmphasis] Queued: "${word}" with style="${style}", reason="${reason || 'none'}"`);
        } else {
          console.warn(`[Native Function→WordEmphasis] Missing required args: word="${word}", style="${style}"`);
        }
        break;
      }
      
      case 'CHECK_STUDENT_CREDITS': {
        const text = fn.args.text as string | undefined;
        const reason = fn.args.reason as string | undefined;
        
        if (text && !session.functionCallText) {
          session.functionCallText = text;
        }
        
        if (session.userId) {
          try {
            const balance = await usageService.getBalanceWithBypass(String(session.userId));
            const sessionElapsed = Math.floor((Date.now() - session.startTime) / 1000);
            const sessionMinutes = Math.floor(sessionElapsed / 60);
            const remainingHours = (balance.remainingSeconds / 3600).toFixed(1);
            const usedHours = (balance.usedSeconds / 3600).toFixed(1);
            const totalHours = (balance.totalSeconds / 3600).toFixed(1);
            
            const creditSummary = `[CREDIT CHECK RESULT] Remaining: ${remainingHours}h (${Math.round(balance.percentRemaining)}% left), Used: ${usedHours}h of ${totalHours}h total, This session: ${sessionMinutes} minutes, Status: ${balance.warningLevel === 'none' ? 'Healthy' : balance.warningLevel.toUpperCase()}`;
            
            session.lastCreditCheck = creditSummary as any;
            session.creditContextInjected = false;
            
            console.log(`[Native Function→CheckCredits] Balance: ${remainingHours}h remaining (${balance.warningLevel}), session: ${sessionMinutes}min, reason: ${reason || 'not specified'}`);
          } catch (err: any) {
            console.error(`[Native Function→CheckCredits] Error:`, err.message);
          }
        }
        break;
      }
      
      case 'CHANGE_CLASSROOM_PHOTO': {
        // Guard: only Founder Mode or Raw Honesty Mode may change Daniela's classroom environment.
        // Without this gate, a student could prompt-inject into changing the global classroom photo.
        if (!session.isFounderMode && !session.isRawHonestyMode) {
          console.warn(`[Native Function→ClassroomPhoto] Blocked: not in trusted context`);
          break;
        }
        const text = fn.args.text as string | undefined;
        const scene = fn.args.scene as string | undefined;
        
        if (text && !session.functionCallText) {
          session.functionCallText = text;
        }
        
        if (scene) {
          import('./classroom-environment').then(async ({ setDanielaPhoto }) => {
            await setDanielaPhoto(scene);
            console.log(`[Native Function→ClassroomPhoto] Daniela changed her photo: "${scene.substring(0, 60)}..."`);
          }).catch(err => {
            console.error(`[Native Function→ClassroomPhoto] Error:`, err.message);
          });
        }
        break;
      }

      case 'CHANGE_CLASSROOM_WINDOW': {
        // Guard: only Founder Mode or Raw Honesty Mode may change the classroom environment.
        if (!session.isFounderMode && !session.isRawHonestyMode) {
          console.warn(`[Native Function→ClassroomWindow] Blocked: not in trusted context`);
          break;
        }
        const text = fn.args.text as string | undefined;
        const scene = fn.args.scene as string | undefined;

        if (text && !session.functionCallText) {
          session.functionCallText = text;
        }

        if (scene) {
          import('./classroom-environment').then(async ({ setClassroomWindow }) => {
            await setClassroomWindow(scene);
            console.log(`[Native Function→ClassroomWindow] Daniela changed her window view: "${scene.substring(0, 60)}..."`);
          }).catch(err => {
            console.error(`[Native Function→ClassroomWindow] Error:`, err.message);
          });
        }
        break;
      }
      
      // CALL_SUPPORT removed July 20 2026 — superseded by ESCALATE_TO_SUPPORT (Sophia).
      // CALL_ASSISTANT removed July 20 2026 — deprecated; legacy command parser path still works.
      
      case 'SUBTITLE': {
        const spokenText = fn.args.spoken_text as string | undefined;
        const mode = (fn.args.mode as string)?.toLowerCase();
        const customText = fn.args.text as string | undefined;
        
        if (mode === 'custom') {
          if (!customText || customText.trim() === '') {
            console.warn(`[Native Function→Subtitle] Custom mode requires text parameter, skipping`);
          } else {
            console.log(`[Native Function→Subtitle] Custom text display: "${customText.substring(0, 50)}..."`);
            session.customOverlayText = customText;
            this.sendMessage(session.ws, {
              type: 'custom_overlay',
              text: customText,
              action: 'show',
              timestamp: Date.now(),
            } as any, session);
          }
        } else if (mode && ['off', 'target'].includes(mode)) {
          const validMode = mode as 'off' | 'target';
          session.subtitleMode = validMode;
          console.log(`[Native Function→Subtitle] Mode changed to: ${validMode} (session ${session.id})`);
          
          this.sendMessage(session.ws, {
            type: 'subtitle_mode_change',
            mode: validMode,
            timestamp: Date.now(),
          } as any, session);
          console.log(`[Native Function→Subtitle] ✓ Sent subtitle_mode_change via sendMessage: ${validMode}`);
        }
        if (spokenText && !session.functionCallText) {
          session.functionCallText = spokenText;
          console.log(`[Native Function→Subtitle] Spoken text for TTS: "${spokenText.substring(0, 80)}..."`);
        }
        break;
      }
      
      case 'PUSH_CUSTOM_SUBTITLE': {
        const text = (fn.args.text as string | undefined) ?? '';
        if (text.trim() === '') {
          // Clear the subtitle bar
          session.customOverlayText = undefined;
          this.sendMessage(session.ws, {
            type: 'custom_overlay',
            action: 'hide',
            timestamp: Date.now(),
          } as any, session);
          console.log(`[Native Function→PushCustomSubtitle] Cleared subtitle bar`);
        } else {
          session.customOverlayText = text;
          this.sendMessage(session.ws, {
            type: 'custom_overlay',
            text,
            action: 'show',
            timestamp: Date.now(),
          } as any, session);
          console.log(`[Native Function→PushCustomSubtitle] Pushed to subtitle bar: "${text.substring(0, 60)}"`);
        }
        break;
      }

      case 'HOLD': {
        const text = fn.args.text as string | undefined;
        const hold = fn.args.hold as boolean | undefined;
        console.log(`[Native Function Call] HOLD -> ${hold}`);
        this.sendMessage(session.ws, {
          type: 'whiteboard_update',
          timestamp: Date.now(),
          items: [{ type: 'hold', hold: hold !== false }],
        });
        if (text && !session.functionCallText) {
          session.functionCallText = text;
          console.log(`[Native Function→Hold] Text included: "${text.substring(0, 80)}..."`);
        }
        break;
      }
      
      case 'SHOW': {
        const spokenText = fn.args.spoken_text as string | undefined;
        const content = (fn.args.content || fn.args.text) as string | undefined;
        const contentType = fn.args.contentType as string | undefined;
        if (content) {
          this.sendMessage(session.ws, {
            type: 'whiteboard_update',
            timestamp: Date.now(),
            items: [{ type: contentType || 'write', content }],
          });
          console.log(`[Native Function Call] SHOW -> type: ${contentType}`);
          // Gap 10: queue screen context for GL so Daniela knows what's visible
          if (!session.pendingGlContext) session.pendingGlContext = [];
          const ctxLabel = contentType === 'image' ? 'image displayed on whiteboard'
            : contentType === 'write' ? `text shown: "${content.slice(0, 60)}${content.length > 60 ? '…' : ''}"`
            : `${contentType ?? 'content'} shown on whiteboard`;
          session.pendingGlContext.push(ctxLabel);
        }
        if (spokenText && !session.functionCallText) {
          session.functionCallText = spokenText;
          console.log(`[Native Function→Show] Spoken text included: "${spokenText.substring(0, 80)}..."`);
        }
        break;
      }
      
      case 'HIDE': {
        const text = fn.args.text as string | undefined;
        this.sendMessage(session.ws, {
          type: 'whiteboard_update',
          timestamp: Date.now(),
          items: [{ type: 'clear' }],
        });
        console.log(`[Native Function Call] HIDE -> cleared overlay`);
        if (text && !session.functionCallText) {
          session.functionCallText = text;
          console.log(`[Native Function→Hide] Text included: "${text.substring(0, 80)}..."`);
        }
        break;
      }
      
      case 'CLEAR': {
        const text = fn.args.text as string | undefined;
        this.sendMessage(session.ws, {
          type: 'whiteboard_update',
          timestamp: Date.now(),
          items: [{ type: 'clear' }],
        });
        session.classroomWhiteboardItems = [];
        console.log(`[Native Function Call] CLEAR -> whiteboard cleared (classroom tracking reset)`);
        // If a REAL immersive scene is active (has an environment image), re-inject it so CLEAR
        // only removes whiteboard annotations but never takes down the scene backdrop.
        // Guard: only restore when environmentImageUrl is set — without it, the client enters
        // fullscreen immersive mode with no image (near-black screen). Also, if sceneCanvas was
        // only used for standalone widgets (clock/emotion/weather/thermometer with no backdrop),
        // null it out entirely so the next single-widget call starts fresh and doesn't re-send
        // all previously accumulated widget data (Bug: all widgets re-fire when only one requested).
        if (session.sceneCanvas && session.sceneCanvas.environmentImageUrl) {
          const sceneRestore = {
            type: 'whiteboard_update' as const,
            timestamp: Date.now(),
            items: [{
              id: 'scene-canvas-active',
              type: 'scene_canvas' as const,
              content: session.sceneCanvas.environmentLabel || session.sceneCanvas.environment,
              data: {
                environment: session.sceneCanvas.environment,
                environmentImageUrl: session.sceneCanvas.environmentImageUrl,
                environmentLabel: session.sceneCanvas.environmentLabel,
                props: session.sceneCanvas.props,
                canvasAction: 'open_scene' as const,
              },
            }],
          };
          this.sendMessage(session.ws, sceneRestore);
          console.log(`[Native Function→Clear] Real scene active — restored scene canvas after whiteboard clear`);
        } else if (session.sceneCanvas) {
          // No real scene backdrop — just accumulated widget-only state (clock, emotion, weather, thermometer).
          // Reset so next single-widget call starts fresh instead of re-sending all previous widget data.
          session.sceneCanvas = null;
          console.log(`[Native Function→Clear] Widget-only sceneCanvas cleared (no backdrop to restore)`);
        }
        if (text && !session.functionCallText) {
          session.functionCallText = text;
          console.log(`[Native Function→Clear] Text included: "${text.substring(0, 80)}..."`);
        }
        break;
      }
      
      case 'SHOW_IMAGE': {
        const text = fn.args.text as string | undefined;
        const word = (fn.args.word as string | undefined) || '';
        const translation = fn.args.translation as string | undefined;
        const latinScript = fn.args.latin_script as string | undefined;
        const description = fn.args.description as string | undefined;
        const scene = fn.args.scene as string | undefined;
        const context = fn.args.context as string | undefined;
        const rawLabelMode = fn.args.label_mode as string | undefined;
        const labelMode: 'teach' | 'target' | 'quiz' =
          rawLabelMode === 'quiz' ? 'quiz'
          : rawLabelMode === 'target' ? 'target'
          : 'teach';
        const rawLabels = fn.args.labels as { word: string; translation?: string; latin_script?: string }[] | undefined;
        const labels = Array.isArray(rawLabels) && rawLabels.length > 0
          ? rawLabels.map(l => ({ word: l.word, translation: l.translation, latinScript: l.latin_script }))
          : undefined;
        const rawSlot = fn.args.slot as string | undefined;
        const slot: 'scene' | 'context' | undefined =
          rawSlot === 'scene' ? 'scene'
          : rawSlot === 'context' ? 'context'
          : undefined;
        const category = fn.args.category as string | undefined;

        if (!word && !scene) {
          console.warn(`[Native Function→ShowImage] Missing word or scene parameter`);
          break;
        }

        if (text && !session.functionCallText) {
          session.functionCallText = text;
          console.log(`[Native Function→ShowImage] Text included: "${text.substring(0, 50)}..."`);
        }

        const displayWord = word || (scene || '').split(' ').slice(0, 3).join(' ');
        console.log(`[Native Function→ShowImage] Resolving image for "${displayWord}" (scene: ${scene || 'none'})`);

        // Push to pendingMemoryLookupPromises so the orchestrator awaits resolution
        // before buildContinuationResponse runs — same pattern as recall_express_lane_image.
        const showImagePromise = (async () => {
          try {
            const { resolveVocabularyImage } = await import('../services/vocabulary-image-resolver');
            const result = await resolveVocabularyImage({
              word: displayWord,
              language: session.language || 'spanish',
              description: description || displayWord,
              scene,
              slot,
              tutorName: session.tutorName,
              translation: translation,
              conversationId: session.conversationId?.toString(),
              userId: session.userId?.toString(),
            });
            
            console.log(`[Native Function→ShowImage] Resolved: ${result.source} for "${word}"`);

            // Daniela self-visibility: confirm the image that resolved and is now on screen.
            if (!session.pendingGlContext) session.pendingGlContext = [];
            session.pendingGlContext.push(
              `Image confirmed on screen: "${result.word}"${translation ? ` (${translation})` : ''}` +
              `${result.description ? ` — ${result.description.slice(0, 80)}` : ''} [${result.source}].`
            );
            
            const whiteboardUpdate = {
              type: 'whiteboard_update' as const,
              timestamp: Date.now(),
              items: [{
                type: 'image',
                content: word,
                data: {
                  word: result.word,
                  translation: translation,
                  latinScript: latinScript,
                  description: result.description,
                  imageUrl: result.imageUrl,
                  context: context,
                  source: result.source,
                  labelMode: labelMode,
                  labels: labels,
                  slot: slot,
                  category: category,
                },
              }],
            };
            
            if (session.firstAudioSent) {
              this.sendMessage(session.ws, whiteboardUpdate);
            } else {
              if (!session.pendingWhiteboardUpdates) {
                session.pendingWhiteboardUpdates = [];
              }
              session.pendingWhiteboardUpdates.push(whiteboardUpdate);
              console.log(`[Native Function→ShowImage] Buffered for audio sync`);
            }
            
            if (!session.classroomSessionImages) session.classroomSessionImages = [];
            session.classroomSessionImages.push(description || word);
            if (!session.classroomWhiteboardItems) session.classroomWhiteboardItems = [];
            session.classroomWhiteboardItems.push({ type: 'image', content: word, label: description || word });

            // Vision system: give Daniela actual sight of the image she just showed the student
            if (result.imageUrl) {
              const { getImageVision } = await import('./image-vision-service');
              const visionDesc = result.description
                || `${displayWord}${translation ? ` (${translation})` : ''}${scene ? ` — ${scene}` : ''}`;
              const vision = await getImageVision(result.imageUrl, visionDesc, session);
              if (!session.visionBuffer) session.visionBuffer = {};
              session.visionBuffer['show_image'] = {
                url: result.imageUrl,
                description: vision.description,
                inlineData: vision.inlineData,
              };
              console.log(`[Vision→ShowImage] Mode: ${vision.mode} for "${displayWord}"`);
            }
          } catch (err: any) {
            console.error(`[Native Function→ShowImage] Error:`, err.message);
          }
        })();
        // Async-Ack: push to pendingAsyncImagePromises instead of pendingMemoryLookupPromises.
        // The GL orchestrator does NOT await these before sending the tool response —
        // Daniela gets a receipt immediately (<200ms) and GL resumes audio generation.
        // The image is delivered to the student's whiteboard inside the IIFE above via
        // this.sendMessage(session.ws, whiteboardUpdate) the moment the AI image resolves.
        // Daniela's vision (inline image data) arrives via realtimeInput after generation
        // completes — see pendingAsyncImagePromises processing in gemini-live-session.ts.
        // Note: all images are AI-generated watercolor/prop style — no Unsplash/stock photos.
        if (!(session as any).pendingAsyncImagePromises) (session as any).pendingAsyncImagePromises = [];
        (session as any).pendingAsyncImagePromises.push(showImagePromise as Promise<void>);
        break;
      }

      case 'GENERATE_VISUAL': {
        // Legacy path — now routed through the unified show_image resolver.
        // generate_visual is no longer exposed in the function registry; this case
        // handles any in-flight calls or backward-compat scenarios.
        const concept = fn.args.concept as string | undefined;
        const text = fn.args.text as string | undefined;

        if (!concept) {
          console.warn(`[Native Function→GenerateVisual] Missing concept param — skipping`);
          break;
        }

        const IMAGE_DESC_PREFIXES = ['illustration depicting', 'educational infographic', 'image showing', 'photo of', 'visual of'];
        const isImageDesc = text ? IMAGE_DESC_PREFIXES.some(p => text.toLowerCase().startsWith(p)) : false;
        if (text && !isImageDesc && !session.functionCallText) {
          session.functionCallText = text;
        } else if (text && isImageDesc) {
          console.warn(`[Native Function→GenerateVisual] Rejecting image-description text as speech`);
        }

        console.log(`[Native Function→GenerateVisual] Routing through unified resolver for: "${concept}"`);

        // Derive a short label from the concept for the whiteboard card
        const conceptLabel = (() => {
          const firstPhrase = concept.split(/[,;]/)[0].trim();
          return firstPhrase.length <= 45 ? firstPhrase : firstPhrase.substring(0, 42) + '…';
        })();

        import('../services/vocabulary-image-resolver').then(async ({ resolveVocabularyImage }) => {
          try {
            const result = await resolveVocabularyImage({
              word: conceptLabel,
              language: session.language || 'spanish',
              description: concept,
              scene: concept,
              tutorName: session.tutorName,
              userId: session.userId?.toString(),
            });

            const whiteboardUpdate = {
              type: 'whiteboard_update' as const,
              timestamp: Date.now(),
              items: [{
                type: 'image',
                content: conceptLabel,
                data: {
                  word: conceptLabel,
                  description: concept,
                  imageUrl: result.imageUrl,
                  source: result.source,
                  labelMode: 'quiz' as const,
                },
              }],
            };

            if (session.firstAudioSent) {
              this.sendMessage(session.ws, whiteboardUpdate);
            } else {
              if (!session.pendingWhiteboardUpdates) session.pendingWhiteboardUpdates = [];
              session.pendingWhiteboardUpdates.push(whiteboardUpdate);
              console.log(`[Native Function→GenerateVisual] Buffered for audio sync`);
            }

            if (!session.classroomSessionImages) session.classroomSessionImages = [];
            session.classroomSessionImages.push(concept);
            if (!session.classroomWhiteboardItems) session.classroomWhiteboardItems = [];
            session.classroomWhiteboardItems.push({ type: 'image', content: concept, label: conceptLabel });
          } catch (err: any) {
            console.error(`[Native Function→GenerateVisual] Error:`, err.message);
          }
        });
        break;
      }

      case 'VISUAL_COMPARE': {
        const text = fn.args.text as string | undefined;
        const conceptA = fn.args.concept_a as string | undefined;
        const conceptB = fn.args.concept_b as string | undefined;
        const aMeaning = fn.args.a_meaning as string | undefined;
        const bMeaning = fn.args.b_meaning as string | undefined;
        const aExample = fn.args.a_example as string | undefined;
        const bExample = fn.args.b_example as string | undefined;
        const studentExample = fn.args.student_example as string | undefined;

        if (!conceptA || !conceptB) {
          console.warn('[Native Function→VisualCompare] Missing concept_a or concept_b — skipping');
          break;
        }
        if (text && !session.functionCallText) session.functionCallText = text;

        const compareLabel = `${conceptA} vs ${conceptB}`;
        const compareCacheKey = `compare_${conceptA}_${conceptB}`.toLowerCase().replace(/[^a-z0-9_]/g, '_').slice(0, 60);
        // Stable ID so the background-image enrichment update replaces the initial item in place
        const itemId = `wb_compare_${compareCacheKey}`;
        const lang = session.language || 'spanish';

        // STEP 1: Send the DOM comparison widget immediately — no image generation delay
        const immediateUpdate = {
          type: 'whiteboard_update' as const,
          timestamp: Date.now(),
          items: [{
            id: itemId,
            type: 'comparison' as const,
            content: compareLabel,
            data: {
              concept_a: conceptA,
              concept_b: conceptB,
              a_meaning: aMeaning,
              b_meaning: bMeaning,
              a_example: aExample,
              b_example: bExample,
              student_example: studentExample,
              language: lang,
            },
          }],
        };
        if (session.firstAudioSent) {
          this.sendMessage(session.ws, immediateUpdate);
        } else {
          if (!session.pendingWhiteboardUpdates) session.pendingWhiteboardUpdates = [];
          session.pendingWhiteboardUpdates.push(immediateUpdate);
        }
        console.log(`[Native Function→VisualCompare] DOM widget sent immediately: "${compareLabel}"`);

        // STEP 2: Generate a label-free background scene image async, then enrich the widget in-place
        // The image prompt contains NO text labels — all text is rendered as DOM in the widget above.
        // One shared background for all languages — ENV_STYLE handles style + "no people".
        const bgScene = `Two large dark green chalkboards mounted side by side on a warm classroom wall, viewed straight-on. Dark wooden frames with a thin gap between the boards. Warm neutral beige plaster wall. Soft diffused overhead classroom lighting. Both boards completely blank and empty.`;

        const comparePromise = (async () => {
          try {
            // Check cache first — shared key is language-agnostic
            const langBgKey = `comparison_bg_shared`;
            const { storage } = await import('../storage');
            let imageUrl: string | undefined;

            const cached = await storage.getCachedStockImage(langBgKey);
            if (cached?.url) {
              imageUrl = cached.url;
              console.log(`[Native Function→VisualCompare] Using cached shared bg`);
            } else {
              // Cache miss — generate with ENV_STYLE (Gemini Flash, no characters)
              const { generateEnvironmentScene } = await import('../services/google-image-service');
              const { normalizeImageUrl } = await import('../services/image-storage');
              imageUrl = normalizeImageUrl(await generateEnvironmentScene(bgScene, 'comparison_bg'));
              // Store in cache for all future calls
              await storage.cacheImage({
                url: imageUrl,
                filename: `compare_bg_shared_${Date.now()}.png`,
                mimeType: 'image/png',
                mediaType: 'image',
                imageSource: 'ai_generated',
                searchQuery: langBgKey,
                uploadedBy: null,
                title: 'comparison_bg_shared',
                description: 'Shared comparison background for all languages',
                tags: ['comparison', 'background', 'grammar', 'shared'],
                language: 'shared',
                targetWord: langBgKey,
              });
              console.log(`[Native Function→VisualCompare] Imagen 4 bg generated + cached`);
            }

            // Enrich the existing widget in-place using the same stable ID
            const enrichUpdate = {
              type: 'whiteboard_update' as const,
              timestamp: Date.now(),
              items: [{
                id: itemId,
                type: 'comparison' as const,
                content: compareLabel,
                data: {
                  concept_a: conceptA,
                  concept_b: conceptB,
                  a_meaning: aMeaning,
                  b_meaning: bMeaning,
                  a_example: aExample,
                  b_example: bExample,
                  student_example: studentExample,
                  language: lang,
                  imageUrl,
                },
              }],
            };
            if (session.firstAudioSent) {
              this.sendMessage(session.ws, enrichUpdate);
            } else {
              if (!session.pendingWhiteboardUpdates) session.pendingWhiteboardUpdates = [];
              session.pendingWhiteboardUpdates.push(enrichUpdate);
            }
            if (!session.classroomSessionImages) session.classroomSessionImages = [];
            session.classroomSessionImages.push(compareLabel);
            console.log(`[Native Function→VisualCompare] Background image enriched: "${compareLabel}"`);
          } catch (err: any) {
            // Non-fatal: the DOM widget is already showing correctly without a background.
            // Gap C: set visual failure flag so gemini-live-session can inject a correction note
            // preventing Daniela from referencing an image the student never saw.
            console.warn(`[Native Function→VisualCompare] Background image failed (widget still functional):`, err.message);
            session.lastVisualFailure = `comparison background image failed: ${err.message?.slice(0, 80) ?? 'unknown error'}`;
          }
        })();
        if (!session.pendingMemoryLookupPromises) session.pendingMemoryLookupPromises = [];
        session.pendingMemoryLookupPromises.push(comparePromise as Promise<void>);
        break;
      }

      case 'GRAMMAR_DIAGRAM': {
        const grammarText = fn.args.text as string | undefined;
        const grammarConcept = fn.args.concept as string | undefined;
        const studentCtx = fn.args.student_context as string | undefined;
        const diagramType = fn.args.diagram_type as string | undefined;

        if (!grammarConcept) {
          console.warn('[Native Function→GrammarDiagram] Missing concept — skipping');
          break;
        }
        if (grammarText && !session.functionCallText) session.functionCallText = grammarText;

        const diagramStyleMap: Record<string, string> = {
          timeline: 'as a horizontal timeline diagram showing temporal relationships',
          sentence_diagram: 'as a sentence structure diagram showing word order and component placement',
          conjugation_chart: 'as a conjugation chart showing verb endings in a clear grid',
          usage_map: 'as a visual usage map showing when to choose each form',
          comparison: 'as a side-by-side comparison showing the contrast between forms',
        };
        const styleNote = diagramType && diagramStyleMap[diagramType] ? ` Render ${diagramStyleMap[diagramType]}.` : '';
        const grammarScene = `Educational grammar diagram for Spanish language learners: ${grammarConcept}.${styleNote}${studentCtx ? ` Context: "${studentCtx}".` : ''} Clean labeled watercolor illustration — clear arrows, boxes, and text showing grammatical relationships. Spanish labels with brief English annotations. Warm educational style.`;
        const grammarLabel = grammarConcept.slice(0, 50);
        const grammarCacheKey = `grammar_${grammarConcept}`.toLowerCase().replace(/[^a-z0-9_]/g, '_').slice(0, 60);

        const diagramPromise = (async () => {
          try {
            const { resolveVocabularyImage } = await import('../services/vocabulary-image-resolver');
            const result = await resolveVocabularyImage({
              word: grammarCacheKey,
              language: session.language || 'spanish',
              description: grammarLabel,
              scene: grammarScene,
              conversationId: session.conversationId?.toString(),
              userId: session.userId?.toString(),
            });
            const whiteboardUpdate = {
              type: 'whiteboard_update' as const,
              timestamp: Date.now(),
              items: [{ type: 'image', content: grammarLabel, data: { word: grammarLabel, description: grammarScene, imageUrl: result.imageUrl, source: result.source, labelMode: 'quiz' as const } }],
            };
            if (session.firstAudioSent) {
              this.sendMessage(session.ws, whiteboardUpdate);
            } else {
              if (!session.pendingWhiteboardUpdates) session.pendingWhiteboardUpdates = [];
              session.pendingWhiteboardUpdates.push(whiteboardUpdate);
            }
            if (!session.classroomSessionImages) session.classroomSessionImages = [];
            session.classroomSessionImages.push(grammarLabel);
            console.log(`[Native Function→GrammarDiagram] Generated: "${grammarLabel}"`);
          } catch (err: any) {
            console.error(`[Native Function→GrammarDiagram] Error:`, err.message);
          }
        })();
        if (!session.pendingMemoryLookupPromises) session.pendingMemoryLookupPromises = [];
        session.pendingMemoryLookupPromises.push(diagramPromise as Promise<void>);
        break;
      }

      case 'COMPOSE_VISUAL': {
        const environment = fn.args.environment as string | undefined;
        const objects = (fn.args.objects as any[] | undefined) ?? [];
        const prepCtx = fn.args.preposition_context as string | undefined;
        const text = fn.args.text as string | undefined;

        if (!environment || objects.length === 0) {
          console.warn(`[Native Function→ComposeVisual] Missing environment or objects — skipping`);
          break;
        }
        if (text && !session.functionCallText) {
          session.functionCallText = text;
        }

        console.log(`[Native Function→ComposeVisual] Composing scene: ${environment} + ${objects.map((o: any) => o.term).join(', ')}`);

        import('../services/prop-room-compositor').then(async ({ composeVisualScene }) => {
          try {
            const result = await composeVisualScene({
              environment,
              objects,
              preposition_context: prepCtx,
              language: session.targetLanguage || 'spanish',
            });

            let imageUrl: string;
            let sourceName: string;

            if (result.success && result.imageUrl) {
              imageUrl = result.imageUrl;
              sourceName = result.source === 'pre_composed' ? 'prop_room_cached' : 'prop_room_composed';
              console.log(`[Native Function→ComposeVisual] ${result.cacheHit ? 'Cache hit' : 'Composed'}: ${imageUrl}`);
            } else {
              // Fallback: delegate to generate_visual with a descriptive prompt
              console.log(`[Native Function→ComposeVisual] Falling back to Gemini — ${result.error || ('missing: ' + (result.missingAssets || []).join(', '))}`);
              // Build a pedagogically explicit prompt — if this is a preposition lesson, describe
              // the spatial relationship clearly enough that Gemini can render it usefully
              const objectTerms = objects.map((o: any) => o.term).join(', ');
              const envLabel = environment.replace(/_/g, ' ');
              let fallbackConcept: string;
              if (prepCtx && objects.length > 0) {
                // Map preposition context to explicit spatial instruction DALL-E can follow
                const positionMap: Record<string, string> = {
                  under_table: 'on the floor directly beneath the table',
                  under_counter: 'on the floor beneath the counter',
                  on_table: 'resting on top of the table surface',
                  on_counter: 'sitting on top of the counter',
                  on_floor: 'placed on the floor',
                  on_chair: 'placed on the seat of a chair',
                  beside_table: 'standing on the floor beside the table',
                  beside_bed: 'on the floor beside the bed',
                  in_hand: 'held in a hand',
                };
                const firstObj = objects[0];
                const spatialDesc = positionMap[firstObj.position] || `near the ${envLabel}`;
                // View angle: side-on is best for under/beside, top-down for on_table
                const viewHint = (firstObj.position || '').startsWith('under') ? 'viewed from the side so the table and floor are both clearly visible, ' : '';
                fallbackConcept = `educational illustration for a language lesson — a ${envLabel} scene. ${objectTerms} is ${spatialDesc}. ${viewHint}The image should clearly demonstrate the "${prepCtx}" (${firstObj.position?.replace(/_/g, ' ')}) spatial relationship so a language student can immediately understand the position. Clean simple composition.`;
              } else {
                fallbackConcept = `${envLabel} scene with ${objectTerms}${prepCtx ? `, showing "${prepCtx}" relationship` : ''}`;
              }
              const { generateVisual } = await import('../services/visual-content-service');
              const { archiveImageToPermanentStorage } = await import('../services/image-storage');
              const crypto = await import('crypto');
              const genResult = await generateVisual(fallbackConcept, 'image', {}, 'warm, friendly educational illustration, clear spatial composition');
              const hash = crypto.createHash('md5').update('compose_' + fallbackConcept + Date.now()).digest('hex');
              const archivedFilename = `${hash}.jpg`;
              try {
                imageUrl = await archiveImageToPermanentStorage(genResult.imageUrl, archivedFilename);
              } catch {
                imageUrl = genResult.imageUrl;
              }
              sourceName = 'gemini_fallback';
              // Save to media_files library (same as generate_visual does) so it's findable later
              try {
                const shortLabel = fallbackConcept.split(/[,;]/)[0].trim().substring(0, 60);
                await storage.cacheImage({
                  uploadedBy: null,
                  mediaType: 'image',
                  url: imageUrl,
                  thumbnailUrl: null,
                  filename: archivedFilename,
                  mimeType: 'image/jpeg',
                  title: shortLabel,
                  description: fallbackConcept,
                  tags: [environment, ...objects.map((o: any) => o.term), ...(prepCtx ? [prepCtx] : [])],
                  language: session.targetLanguage || null,
                  imageSource: 'ai_generated',
                  promptHash: null,
                  attributionJson: null,
                  usageCount: 1,
                });
                console.log(`[Native Function→ComposeVisual] Fallback image saved to media library: "${shortLabel}"`);
              } catch (saveErr: any) {
                console.warn(`[Native Function→ComposeVisual] Failed to save fallback to library:`, saveErr.message);
              }
            }

            const label = `${environment.replace(/_/g, ' ')}: ${objects.map((o: any) => o.term).join(', ')}`;
            const whiteboardUpdate = {
              type: 'whiteboard_update' as const,
              timestamp: Date.now(),
              items: [{
                type: 'image',
                content: label,
                data: {
                  word: label,
                  description: label,
                  imageUrl,
                  source: sourceName,
                  semanticTags: [environment, ...objects.map((o: any) => o.term)],
                  accessibilityDescription: label,
                  conceptAlignment: 0.95,
                },
              }],
            };
            if (session.firstAudioSent) {
              this.sendMessage(session.ws, whiteboardUpdate);
            } else {
              if (!session.pendingWhiteboardUpdates) session.pendingWhiteboardUpdates = [];
              session.pendingWhiteboardUpdates.push(whiteboardUpdate);
            }
            if (!session.classroomSessionImages) session.classroomSessionImages = [];
            session.classroomSessionImages.push(label);
          } catch (err: any) {
            console.error(`[Native Function→ComposeVisual] Error:`, err.message);
          }
        });
        break;
      }

      case 'SEARCH_VISUAL_LIBRARY': {
        const term = fn.args.term as string | undefined;
        if (!term) break;
        import('../services/prop-room-compositor').then(async ({ searchVisualLibrary }) => {
          try {
            const results = await searchVisualLibrary(term, session.targetLanguage || 'spanish');
            // Results are consumed by the continuation response built in the registry
            console.log(`[Native Function→SearchVisualLibrary] "${term}": ${results.environments.length} envs, ${results.assets.length} assets`);
            session.lastVisualLibrarySearch = results;
          } catch (err: any) {
            console.error(`[Native Function→SearchVisualLibrary] Error:`, err.message);
          }
        });
        break;
      }

      // ─── Interactive Scene Canvas ────────────────────────────────────────
      // Position map (mirrors prop-room-compositor.ts POSITION_MAP)
      // Used to resolve cx/cy/scale server-side before sending to client.
      case 'OPEN_SCENE': {
        const sceneEnv = fn.args.environment as string | undefined;
        const sceneLabel = fn.args.label as string | undefined;
        const sceneText = fn.args.text as string | undefined;
        const sceneTarget = (fn.args.target as string | undefined) || 'studio';
        if (sceneText && !session.functionCallText) session.functionCallText = sceneText;
        if (!sceneEnv) {
          console.warn('[Native Function→OpenScene] Missing environment — skipping');
          break;
        }

        // Update lesson context — new scene clears active vocab (fresh context for each environment)
        const openSceneLc = initLessonContext(session);
        if (sceneEnv !== openSceneLc.scene) {
          openSceneLc.vocab = [];
          // Clear stale vision buffer so Daniela doesn't reference the previous scene's visuals
          // while the new scene's async vision promise is still resolving.
          if (session.visionBuffer) delete (session.visionBuffer as any)['open_scene'];
        }
        openSceneLc.scene = sceneEnv;
        openSceneLc.updatedAt = Date.now();
        console.log(`[LessonArc] Scene → ${sceneEnv}`);
        pushLessonStatusContext(session);

        const { getUserDb } = await import('../db');
        const { sql: sqlTag } = await import('drizzle-orm');
        const openDb = getUserDb();
        try {
          const envResult = await openDb.execute(sqlTag`
            SELECT image_url, display_name FROM visual_environments WHERE name = ${sceneEnv} LIMIT 1
          `);
          const envRow = envResult.rows[0] as any;
          let envImageUrl = envRow?.image_url as string | undefined;
          if (!envImageUrl) {
            // Scene not pre-seeded — generate on-the-fly and cache for future calls.
            console.log(`[Native Function→OpenScene] "${sceneEnv}" not in DB — generating image…`);
            try {
              const { generateEnvironmentScene } = await import('../services/google-image-service');
              const sceneConceptMap: Record<string, string> = {
                tv_weather_studio: 'professional TV weather broadcast studio interior, large green chroma-key screen, animated weather maps on side monitors, modern TV lighting rigs, polished floor, empty set, no people',
                tv_newsroom: 'professional TV news anchor studio, curved glass desk, multiple screens showing news ticker graphics, dramatic backlighting, modern minimalist set, empty, no people',
              };
              const concept = sceneConceptMap[sceneEnv] ?? sceneEnv.replace(/_/g, ' ');
              const { normalizeImageUrl } = await import('../services/image-storage');
              envImageUrl = normalizeImageUrl(await generateEnvironmentScene(concept, 'environment'));
              const displayName = sceneEnv.split('_').map((w: string) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
              await openDb.execute(sqlTag`
                INSERT INTO visual_environments (id, name, display_name, description, image_url, width, height, tags, created_at)
                VALUES (gen_random_uuid(), ${sceneEnv}, ${displayName}, ${concept}, ${envImageUrl}, 1280, 720, ARRAY[]::text[], NOW())
                ON CONFLICT (name) DO UPDATE SET image_url = ${envImageUrl}
              `);
              console.log(`[Native Function→OpenScene] Generated + cached "${sceneEnv}"`);
            } catch (genErr: any) {
              console.warn(`[Native Function→OpenScene] Generation failed for "${sceneEnv}":`, genErr?.message ?? genErr);
              break;
            }
          }
          const envDisplayName = (envRow as any)?.display_name as string | undefined;
          const envLabel = sceneLabel || envDisplayName || sceneEnv.replace(/_/g, ' ');

          // CENTER BACKDROP MODE — background only behind Daniela's avatar,
          // Studio Pane and Whiteboard remain fully accessible.
          if (sceneTarget === 'center') {
            const centerBackdropUpdate = {
              type: 'whiteboard_update' as const,
              timestamp: Date.now(),
              items: [{
                id: 'center-backdrop-active',
                type: 'center_backdrop' as const,
                content: envLabel,
                data: {
                  environment: sceneEnv,
                  imageUrl: envImageUrl,
                  label: envLabel,
                },
              }],
            };
            if (session.firstAudioSent) {
              this.sendMessage(session.ws, centerBackdropUpdate);
            } else {
              if (!session.pendingWhiteboardUpdates) session.pendingWhiteboardUpdates = [];
              session.pendingWhiteboardUpdates.push(centerBackdropUpdate);
            }
            console.log(`[Native Function→OpenScene] Center backdrop: ${sceneEnv}`);
            break;
          }

          // STUDIO MODE (default) — scene loads into the Studio Pane (left panel).
          session.sceneCanvas = {
            environment: sceneEnv,
            environmentImageUrl: envImageUrl,
            environmentLabel: envLabel,
            props: [],
            clockTime: undefined,
          };
          const _sceneConvId = (session as any).conversationId as string | undefined;
          if (_sceneConvId) observeSceneOpen(_sceneConvId, envLabel || sceneEnv, envImageUrl || undefined);
          const openSceneUpdate = {
            type: 'whiteboard_update' as const,
            timestamp: Date.now(),
            items: [{
              id: 'scene-canvas-active',
              type: 'scene_canvas',
              content: envLabel,
              data: {
                environment: sceneEnv,
                environmentImageUrl: envImageUrl,
                environmentLabel: envLabel,
                props: [],
                canvasAction: 'open_scene' as const,
              },
            }],
          };
          if (session.firstAudioSent) {
            this.sendMessage(session.ws, openSceneUpdate);
          } else {
            if (!session.pendingWhiteboardUpdates) session.pendingWhiteboardUpdates = [];
            session.pendingWhiteboardUpdates.push(openSceneUpdate);
          }
          console.log(`[Native Function→OpenScene] Opened: ${sceneEnv}`);

          // Auto-enter immersive fullscreen for all non-broadcast scene targets.
          // Broadcast mode (target: 'center') manages its own immersive protocol — skip it.
          // Without this, open_scene renders only as a ~3×3 Studio Pane thumbnail, too
          // small for spatial canvas teaching (props, prepositions, visual vocab).
          if (sceneTarget !== 'center') {
            const immersiveOnMsg = { type: 'immersive_mode' as const, active: true, timestamp: Date.now() };
            if (session.firstAudioSent) {
              this.sendMessage(session.ws, immersiveOnMsg);
            } else {
              session.pendingWhiteboardUpdates = session.pendingWhiteboardUpdates || [];
              session.pendingWhiteboardUpdates.push(immersiveOnMsg as any);
            }
            console.log('[Native Function→OpenScene] Auto-entering immersive fullscreen (spatial canvas)');
          }

          // Daniela self-visibility: confirm scene is live on the student's screen.
          if (!session.pendingGlContext) session.pendingGlContext = [];
          session.pendingGlContext.push(
            `Scene confirmed in Studio Pane: "${envLabel}" (${sceneEnv}).`
          );

          // World Ledger: fetch narrative scene memory for this student+scene
          const openSceneUserId = String((session as any).userId || '');
          if (openSceneUserId) {
            try {
              const { sceneWorldLedger: swl } = await import('@shared/schema');
              const { eq: eqLedger, and: andLedger } = await import('drizzle-orm');
              const ledgerRows = await openDb.select({ ledger: swl.ledger, tension: swl.tension })
                .from(swl)
                .where(andLedger(
                  eqLedger(swl.userId, openSceneUserId),
                  eqLedger(swl.sceneName, sceneEnv),
                ))
                .limit(1);
              if (ledgerRows[0]?.ledger) {
                (session as any).sceneWorldLedger = ledgerRows[0].ledger;
                console.log(`[WorldLedger] Loaded for ${openSceneUserId}/${sceneEnv}`);
              } else {
                (session as any).sceneWorldLedger = null;
              }
              // Narrative Residue: seed opening tension based on how the last visit ended.
              // SUCCESS → nearly fresh (0.05); NEUTRAL → slight ambient charge; FRACTURE → noticeably elevated.
              // This prevents the "polite reset" where every scene opens at the same zero baseline.
              const { getTensionBand } = await import('./tension-evaluator');
              const ledgerData = ledgerRows[0]?.ledger as Record<string, unknown> | null | undefined;
              const ledgerOutcome = ledgerData?.outcome as string | undefined;
              const ledgerPeak = typeof ledgerData?.peakTension === 'number' ? ledgerData.peakTension : 0;
              let residueTension = 0;
              if (ledgerOutcome === 'FRACTURE') residueTension = Math.min(0.45, ledgerPeak * 0.4);
              else if (ledgerOutcome === 'NEUTRAL') residueTension = Math.min(0.25, ledgerPeak * 0.2);
              else if (ledgerOutcome === 'SUCCESS') residueTension = 0.05;
              (session as any).sceneTension = residueTension;
              (session as any).sceneTensionPeak = residueTension;
              (session as any).lastTensionBand = getTensionBand(residueTension);
              if (residueTension > 0) {
                console.log(`[Tension] Narrative Residue: ${residueTension.toFixed(2)} (${(session as any).lastTensionBand}) from ${ledgerOutcome ?? 'no ledger'} for ${sceneEnv}`);
              }
            } catch (ledgerErr: any) {
              console.warn('[WorldLedger] Failed to load on scene open:', ledgerErr.message);
              (session as any).sceneWorldLedger = null;
            }
          }

          // Vision system: fetch background image bytes so Daniela can see the environment
          const openSceneVisionPromise = (async () => {
            try {
              const { getImageVision, buildSceneStateText } = await import('./image-vision-service');
              const envLabel = session.sceneCanvas?.environmentLabel || sceneEnv.replace(/_/g, ' ');
              const vision = await getImageVision(
                envImageUrl,
                `Scene background: ${envLabel}`,
                session,
              );
              const sceneStateText = buildSceneStateText(
                session.sceneCanvas,
                { action: `Scene opened: ${envLabel}` },
              );
              if (!session.visionBuffer) session.visionBuffer = {};
              session.visionBuffer['open_scene'] = {
                url: envImageUrl,
                description: vision.description,
                inlineData: vision.inlineData,
                sceneStateText,
              };
              // World Ledger: inject narrative scene memory as prose — not key:value pairs.
              // The summary field is a natural language sentence written at scene exit time.
              // Third-person internal framing keeps it consistent with Style Shapers.
              const worldLedger = (session as any).sceneWorldLedger as Record<string, unknown> | null | undefined;
              if (worldLedger && typeof worldLedger.summary === 'string' && worldLedger.summary.length > 0) {
                const outcomeStr = worldLedger.outcome as string | undefined;
                const hadCrisis = worldLedger.hadCrisisBeat;
                const registerNote = worldLedger.registerHistory === 'INCONGRUENT'
                  ? ' The register was a source of friction last time.'
                  : worldLedger.registerHistory === 'MIXED'
                    ? ' The register was sometimes off.'
                    : '';
                const crisisNote = hadCrisis ? ' It reached a critical moment.' : '';
                const prose = outcomeStr === 'FRACTURE'
                  ? `*(she remembers this place — it didn't go well last time. ${worldLedger.summary}${crisisNote}${registerNote} She's carrying that.)*`
                  : outcomeStr === 'SUCCESS'
                    ? `*(she remembers this place — it went well last time. ${worldLedger.summary}${registerNote})*`
                    : `*(she remembers this place. ${worldLedger.summary}${crisisNote}${registerNote})*`;
                session.visionBuffer['open_scene'].sceneStateText += `\n\n${prose}`;
                console.log(`[WorldLedger] Prose memory injected for "${sceneEnv}" (${outcomeStr ?? 'unknown'})`);
              }
              console.log(`[Vision→OpenScene] Mode: ${vision.mode} for "${sceneEnv}"`);
            } catch (err: any) {
              console.error('[Vision→OpenScene] Error:', err.message);
            }
          })();
          if (!session.pendingMemoryLookupPromises) session.pendingMemoryLookupPromises = [];
          session.pendingMemoryLookupPromises.push(openSceneVisionPromise as Promise<void>);
        } catch (err: any) {
          console.error('[Native Function→OpenScene] Error:', err.message);
        }
        break;
      }

      case 'ADD_TO_SCENE': {
        const addPropName = fn.args.prop_name as string | undefined;
        const addPosition = (fn.args.position as string | undefined) || 'center';
        const addLabel = fn.args.label as string | undefined;
        const addNativeLabel = fn.args.native_label as string | undefined;
        const addPropState = fn.args.prop_state as string | undefined;
        const addVocab = fn.args.vocab as { word: string; translation: string }[] | undefined;
        const addText = fn.args.text as string | undefined;
        const addRotate = fn.args.rotate as number | undefined;
        const addFlipH = fn.args.flip_h as boolean | undefined;
        const addZ = fn.args.z as number | undefined;
        if (addText && !session.functionCallText) session.functionCallText = addText;
        if (!addPropName) {
          console.warn('[Native Function→AddToScene] Missing prop_name — skipping');
          break;
        }
        const CANVAS_POSITION_MAP: Record<string, { cx: number; cy: number; scale: number }> = {
          // ── Generic positions ──────────────────────────────────────────────
          center:        { cx: 0.50, cy: 0.65, scale: 0.20 },
          left:          { cx: 0.25, cy: 0.68, scale: 0.16 },
          right:         { cx: 0.75, cy: 0.68, scale: 0.16 },
          foreground:    { cx: 0.50, cy: 0.82, scale: 0.28 },
          background:    { cx: 0.50, cy: 0.35, scale: 0.12 },
          on_table:      { cx: 0.50, cy: 0.70, scale: 0.14 },
          under_table:   { cx: 0.38, cy: 0.84, scale: 0.18 },
          on_floor:      { cx: 0.50, cy: 0.87, scale: 0.22 },
          beside_bed:    { cx: 0.72, cy: 0.74, scale: 0.14 },
          on_counter:    { cx: 0.52, cy: 0.68, scale: 0.14 },
          under_counter: { cx: 0.45, cy: 0.84, scale: 0.12 },
          in_hand:       { cx: 0.50, cy: 0.62, scale: 0.12 },
          on_chair:      { cx: 0.50, cy: 0.74, scale: 0.14 },
          beside_table:  { cx: 0.70, cy: 0.80, scale: 0.14 },
          // ── Restaurant table place-setting positions ───────────────────────
          // Imagining student seated at the near edge of the table:
          //   [bread_corner]  [glass_spot]  [condiment_1][condiment_2]
          //   [side_plate]                  [condiment_3][condiment_4]
          //   [place_left]  [main plate]    [place_right]
          place_left:    { cx: 0.30, cy: 0.72, scale: 0.09 }, // fork (generic left)
          place_right:   { cx: 0.68, cy: 0.72, scale: 0.09 }, // knife (generic right)
          // ── Individual utensil spots (use these for precision placement) ──
          napkin_spot:   { cx: 0.23, cy: 0.73, scale: 0.09 }, // napkin — far left of fork
          fork_spot:     { cx: 0.31, cy: 0.72, scale: 0.08 }, // fork — left of plate
          knife_spot:    { cx: 0.59, cy: 0.72, scale: 0.08 }, // knife — right of plate
          spoon_spot:    { cx: 0.67, cy: 0.71, scale: 0.08 }, // spoon — right of knife
          glass_spot:    { cx: 0.62, cy: 0.57, scale: 0.13 }, // water glass / wine glass
          bread_corner:  { cx: 0.22, cy: 0.58, scale: 0.15 }, // bread basket, upper-left
          // ── Side / bread plate — lower-left of main plate ─────────────────
          side_plate:          { cx: 0.22, cy: 0.70, scale: 0.13 }, // the plate prop itself
          on_side_plate:       { cx: 0.22, cy: 0.70, scale: 0.08 }, // item centered on side plate
          on_side_plate_left:  { cx: 0.17, cy: 0.71, scale: 0.07 }, // left of side plate
          on_side_plate_right: { cx: 0.27, cy: 0.71, scale: 0.07 }, // right of side plate
          // ── Condiment cluster — back-right corner of table ─────────────────
          condiment_1:   { cx: 0.78, cy: 0.56, scale: 0.10 },
          condiment_2:   { cx: 0.86, cy: 0.60, scale: 0.10 },
          condiment_3:   { cx: 0.78, cy: 0.49, scale: 0.09 },
          condiment_4:   { cx: 0.86, cy: 0.52, scale: 0.09 },
          // ── Main plate — 5 sub-zones for multi-item meals ──────────────────
          // Use on_plate for the first/main item, then spread extras across the zone.
          on_plate:            { cx: 0.46, cy: 0.70, scale: 0.11 }, // center (primary item)
          on_plate_top_left:   { cx: 0.40, cy: 0.66, scale: 0.08 }, // e.g. eggs top-left
          on_plate_top_right:  { cx: 0.52, cy: 0.66, scale: 0.08 }, // e.g. bacon top-right
          on_plate_left:       { cx: 0.38, cy: 0.71, scale: 0.08 }, // e.g. ham left
          on_plate_right:      { cx: 0.54, cy: 0.71, scale: 0.08 }, // e.g. garnish right
        };
        let addPos = CANVAS_POSITION_MAP[addPosition] || CANVAS_POSITION_MAP.center;
        let autoSpreadOccurred = false; // vision tracking: did auto-spread fire?
        // Auto-spread: if requested position is already occupied by an existing prop,
        // cycle through fallback slots so items don't stack on top of each other
        if (session.sceneCanvas?.props?.length) {
          const SPREAD_FALLBACK: Array<{ cx: number; cy: number; scale: number }> = [
            { cx: 0.25, cy: 0.68, scale: 0.16 }, // left
            { cx: 0.50, cy: 0.65, scale: 0.20 }, // center
            { cx: 0.75, cy: 0.68, scale: 0.16 }, // right
            { cx: 0.30, cy: 0.72, scale: 0.09 }, // place_left
            { cx: 0.68, cy: 0.72, scale: 0.09 }, // place_right
            { cx: 0.78, cy: 0.56, scale: 0.10 }, // condiment_1
            { cx: 0.86, cy: 0.60, scale: 0.10 }, // condiment_2
            { cx: 0.22, cy: 0.58, scale: 0.15 }, // bread_corner
            { cx: 0.50, cy: 0.82, scale: 0.22 }, // foreground
          ];
          const isTooClose = (a: { cx: number; cy: number }, b: { cx: number; cy: number }) =>
            Math.abs(a.cx - b.cx) < 0.12 && Math.abs(a.cy - b.cy) < 0.12;
          const existingProps = session.sceneCanvas.props.filter((p: any) => p.name !== addPropName);
          if (existingProps.some((p: any) => isTooClose(addPos, p))) {
            const available = SPREAD_FALLBACK.find(slot => !existingProps.some((p: any) => isTooClose(slot, p)));
            if (available) {
              console.log(`[Native Function→AddToScene] Auto-repositioning "${addPropName}" to avoid overlap`);
              addPos = available;
              autoSpreadOccurred = true;
            }
          }
        }
        const { getUserDb: getDbForAdd } = await import('../db');
        const { sql: sqlForAdd } = await import('drizzle-orm');
        const addDb = getDbForAdd();
        try {
          const assetResult = await addDb.execute(sqlForAdd`
            SELECT zone_image_url, image_url, display_name FROM visual_assets
            WHERE (name = ${addPropName} OR display_name ILIKE ${addPropName})
              AND zone_image_url IS NOT NULL
            LIMIT 1
          `);
          const assetRow = assetResult.rows[0] as any;
          let propImageUrl = assetRow?.zone_image_url as string | undefined;
          if (!propImageUrl) {
            // Not in the pre-loaded library — generate on the fly with AI
            console.log(`[Native Function→AddToScene] No visual asset for "${addPropName}" — generating with AI...`);
            try {
              if (!session.generatedPropCache) session.generatedPropCache = {} as Record<string, string>;
              if (session.generatedPropCache[addPropName]) {
                propImageUrl = session.generatedPropCache[addPropName];
                console.log(`[Native Function→AddToScene] Using cached generated image for "${addPropName}"`);
              } else {
                const { generatePropImage } = await import('./google-image-service');
                propImageUrl = await generatePropImage(addPropName);
                session.generatedPropCache[addPropName] = propImageUrl;
                console.log(`[Native Function→AddToScene] Generated prop image for "${addPropName}": ${propImageUrl}`);
              }
            } catch (genErr: any) {
              console.error(`[Native Function→AddToScene] Failed to generate prop "${addPropName}":`, genErr.message);
              break;
            }
          }
          const propDisplayName = addLabel || (assetRow as any)?.display_name as string || addPropName;
          if (!session.sceneCanvas) {
            console.warn('[Native Function→AddToScene] No active scene canvas — call open_scene first');
            break;
          }
          const existingIdx = session.sceneCanvas.props.findIndex((p: any) => p.name === addPropName);
          const newProp: Record<string, any> = {
            name: addPropName,
            label: propDisplayName,
            position: addPosition,
            cx: addPos.cx,
            cy: addPos.cy,
            scale: addPos.scale,
            imageUrl: propImageUrl,
          };
          if (addNativeLabel) newProp.nativeLabel = addNativeLabel;
          if (addPropState) newProp.state = addPropState;
          if (addVocab?.length) newProp.vocab = addVocab;
          if (addRotate !== undefined) newProp.rotate = Math.max(0, Math.min(359, Math.round(addRotate)));
          if (addFlipH) newProp.flipH = true;
          if (addZ !== undefined) newProp.z = Math.max(1, Math.min(10, Math.round(addZ)));
          if (existingIdx >= 0) {
            session.sceneCanvas.props[existingIdx] = newProp;
          } else {
            session.sceneCanvas.props.push(newProp);
          }
          const addUpdate = {
            type: 'whiteboard_update' as const,
            timestamp: Date.now(),
            items: [{
              id: 'scene-canvas-active',
              type: 'scene_canvas',
              content: session.sceneCanvas.environmentLabel || session.sceneCanvas.environment,
              data: {
                environment: session.sceneCanvas.environment,
                environmentImageUrl: session.sceneCanvas.environmentImageUrl,
                environmentLabel: session.sceneCanvas.environmentLabel,
                props: [...session.sceneCanvas.props],
                clockTime: session.sceneCanvas.clockTime,
                canvasAction: 'add_prop' as const,
              },
            }],
          };
          if (session.firstAudioSent) {
            this.sendMessage(session.ws, addUpdate);
          } else {
            if (!session.pendingWhiteboardUpdates) session.pendingWhiteboardUpdates = [];
            session.pendingWhiteboardUpdates.push(addUpdate);
          }
          console.log(`[Native Function→AddToScene] Added "${addPropName}" at ${addPosition}`);

          // Vision system: give Daniela sight of the new prop + full Tier-1 scene state
          const addToSceneVisionPromise = (async () => {
            try {
              const { getImageVision, buildSceneStateText } = await import('./image-vision-service');
              // Reverse-lookup the final position name for auto-spread reporting
              const resolvedPositionName = autoSpreadOccurred
                ? (Object.entries(CANVAS_POSITION_MAP).find(
                    ([, v]) => Math.abs(v.cx - addPos.cx) < 0.001 && Math.abs(v.cy - addPos.cy) < 0.001,
                  )?.[0] || 'repositioned')
                : addPosition;
              // Only fetch prop image bytes if this prop type hasn't been seen this session
              const propVision = propImageUrl
                ? await getImageVision(propImageUrl, propDisplayName, session)
                : null;
              const sceneStateText = buildSceneStateText(session.sceneCanvas, {
                action: `Prop added: ${propDisplayName}`,
                autoSpreadProp: autoSpreadOccurred ? addPropName : undefined,
                requestedPos: autoSpreadOccurred ? addPosition : undefined,
                finalPos: autoSpreadOccurred ? resolvedPositionName : undefined,
              });
              if (!session.visionBuffer) session.visionBuffer = {};
              session.visionBuffer['add_to_scene'] = {
                url: propImageUrl || '',
                description: propDisplayName,
                inlineData: propVision?.inlineData,
                sceneStateText,
              };
              console.log(`[Vision→AddToScene] Prop "${addPropName}" vision mode: ${propVision?.mode || 'no-url'}${autoSpreadOccurred ? ` (auto-spread → ${resolvedPositionName})` : ''}`);
            } catch (err: any) {
              console.error('[Vision→AddToScene] Error:', err.message);
            }
          })();
          if (!session.pendingMemoryLookupPromises) session.pendingMemoryLookupPromises = [];
          session.pendingMemoryLookupPromises.push(addToSceneVisionPromise as Promise<void>);
        } catch (err: any) {
          console.error('[Native Function→AddToScene] Error:', err.message);
        }
        break;
      }

      case 'REMOVE_FROM_SCENE': {
        const removePropName = fn.args.prop_name as string | undefined;
        const removeText = fn.args.text as string | undefined;
        if (removeText && !session.functionCallText) session.functionCallText = removeText;
        if (!removePropName || !session.sceneCanvas) break;
        session.sceneCanvas.props = session.sceneCanvas.props.filter((p: any) => p.name !== removePropName);
        const removeUpdate = {
          type: 'whiteboard_update' as const,
          timestamp: Date.now(),
          items: [{
            id: 'scene-canvas-active',
            type: 'scene_canvas',
            content: session.sceneCanvas.environmentLabel || session.sceneCanvas.environment,
            data: {
              environment: session.sceneCanvas.environment,
              environmentImageUrl: session.sceneCanvas.environmentImageUrl,
              environmentLabel: session.sceneCanvas.environmentLabel,
              props: [...session.sceneCanvas.props],
              clockTime: session.sceneCanvas.clockTime,
              canvasAction: 'remove_prop' as const,
            },
          }],
        };
        if (session.firstAudioSent) {
          this.sendMessage(session.ws, removeUpdate);
        } else {
          if (!session.pendingWhiteboardUpdates) session.pendingWhiteboardUpdates = [];
          session.pendingWhiteboardUpdates.push(removeUpdate);
        }
        console.log(`[Native Function→RemoveFromScene] Removed "${removePropName}"`);
        break;
      }

      case 'MOVE_IN_SCENE': {
        const movePropName = fn.args.prop_name as string | undefined;
        const movePosition = (fn.args.new_position as string | undefined) || 'center';
        const moveText = fn.args.text as string | undefined;
        if (moveText && !session.functionCallText) session.functionCallText = moveText;
        if (!movePropName || !session.sceneCanvas?.props?.length) break;
        const MOVE_POSITION_MAP: Record<string, { cx: number; cy: number; scale: number }> = {
          center:        { cx: 0.50, cy: 0.65, scale: 0.20 },
          left:          { cx: 0.25, cy: 0.68, scale: 0.16 },
          right:         { cx: 0.75, cy: 0.68, scale: 0.16 },
          foreground:    { cx: 0.50, cy: 0.82, scale: 0.28 },
          background:    { cx: 0.50, cy: 0.35, scale: 0.12 },
          on_table:      { cx: 0.50, cy: 0.70, scale: 0.14 },
          under_table:   { cx: 0.38, cy: 0.84, scale: 0.18 },
          on_floor:      { cx: 0.50, cy: 0.87, scale: 0.22 },
          beside_bed:    { cx: 0.72, cy: 0.74, scale: 0.14 },
          on_counter:    { cx: 0.52, cy: 0.68, scale: 0.14 },
          under_counter: { cx: 0.45, cy: 0.84, scale: 0.12 },
          in_hand:       { cx: 0.50, cy: 0.62, scale: 0.12 },
          on_chair:      { cx: 0.50, cy: 0.74, scale: 0.14 },
          beside_table:  { cx: 0.70, cy: 0.80, scale: 0.14 },
          place_left:    { cx: 0.30, cy: 0.72, scale: 0.09 },
          place_right:   { cx: 0.68, cy: 0.72, scale: 0.09 },
          napkin_spot:   { cx: 0.23, cy: 0.73, scale: 0.09 },
          fork_spot:     { cx: 0.31, cy: 0.72, scale: 0.08 },
          knife_spot:    { cx: 0.59, cy: 0.72, scale: 0.08 },
          spoon_spot:    { cx: 0.67, cy: 0.71, scale: 0.08 },
          glass_spot:    { cx: 0.62, cy: 0.57, scale: 0.13 },
          bread_corner:  { cx: 0.22, cy: 0.58, scale: 0.15 },
          side_plate:          { cx: 0.22, cy: 0.70, scale: 0.13 },
          on_side_plate:       { cx: 0.22, cy: 0.70, scale: 0.08 },
          on_side_plate_left:  { cx: 0.17, cy: 0.71, scale: 0.07 },
          on_side_plate_right: { cx: 0.27, cy: 0.71, scale: 0.07 },
          condiment_1:   { cx: 0.78, cy: 0.56, scale: 0.10 },
          condiment_2:   { cx: 0.86, cy: 0.60, scale: 0.10 },
          condiment_3:   { cx: 0.78, cy: 0.49, scale: 0.09 },
          condiment_4:   { cx: 0.86, cy: 0.52, scale: 0.09 },
          on_plate:            { cx: 0.46, cy: 0.70, scale: 0.11 },
          on_plate_top_left:   { cx: 0.40, cy: 0.66, scale: 0.08 },
          on_plate_top_right:  { cx: 0.52, cy: 0.66, scale: 0.08 },
          on_plate_left:       { cx: 0.38, cy: 0.71, scale: 0.08 },
          on_plate_right:      { cx: 0.54, cy: 0.71, scale: 0.08 },
        };
        const propIdx = session.sceneCanvas.props.findIndex((p: any) => p.name === movePropName);
        if (propIdx < 0) {
          console.warn(`[Native Function→MoveInScene] Prop "${movePropName}" not in scene — skipping`);
          break;
        }
        const newPos = MOVE_POSITION_MAP[movePosition] || MOVE_POSITION_MAP.center;
        session.sceneCanvas.props[propIdx] = {
          ...session.sceneCanvas.props[propIdx],
          position: movePosition,
          cx: newPos.cx,
          cy: newPos.cy,
          scale: newPos.scale,
        };
        const moveUpdate = {
          type: 'whiteboard_update' as const,
          timestamp: Date.now(),
          items: [{
            id: 'scene-canvas-active',
            type: 'scene_canvas',
            content: session.sceneCanvas.environmentLabel || session.sceneCanvas.environment,
            data: {
              environment: session.sceneCanvas.environment,
              environmentImageUrl: session.sceneCanvas.environmentImageUrl,
              environmentLabel: session.sceneCanvas.environmentLabel,
              props: [...session.sceneCanvas.props],
              clockTime: session.sceneCanvas.clockTime,
              canvasAction: 'move_prop' as const,
            },
          }],
        };
        if (session.firstAudioSent) {
          this.sendMessage(session.ws, moveUpdate);
        } else {
          if (!session.pendingWhiteboardUpdates) session.pendingWhiteboardUpdates = [];
          session.pendingWhiteboardUpdates.push(moveUpdate);
        }
        console.log(`[Native Function→MoveInScene] Moved "${movePropName}" to ${movePosition}`);
        break;
      }

      case 'CLEAR_SCENE': {
        const clearText = fn.args.text as string | undefined;
        if (clearText && !session.functionCallText) session.functionCallText = clearText;
        if (!session.sceneCanvas) break;
        session.sceneCanvas.props = [];
        session.sceneCanvas.clockTime = undefined;
        const clearUpdate = {
          type: 'whiteboard_update' as const,
          timestamp: Date.now(),
          items: [{
            id: 'scene-canvas-active',
            type: 'scene_canvas',
            content: session.sceneCanvas.environmentLabel || session.sceneCanvas.environment,
            data: {
              environment: session.sceneCanvas.environment,
              environmentImageUrl: session.sceneCanvas.environmentImageUrl,
              environmentLabel: session.sceneCanvas.environmentLabel,
              props: [],
              canvasAction: 'clear_scene' as const,
            },
          }],
        };
        if (session.firstAudioSent) {
          this.sendMessage(session.ws, clearUpdate);
        } else {
          if (!session.pendingWhiteboardUpdates) session.pendingWhiteboardUpdates = [];
          session.pendingWhiteboardUpdates.push(clearUpdate);
        }
        console.log('[Native Function→ClearScene] Props cleared, background remains');
        break;
      }

      case 'SET_CLOCK': {
        const clockTime = fn.args.time as string | undefined;
        const clockText = fn.args.text as string | undefined;
        const clockLabel = fn.args.label as string | undefined;
        const clockShowLabel = (fn.args.show_label as boolean | undefined) ?? true;
        if (clockText && !session.functionCallText) session.functionCallText = clockText;
        if (!clockTime) {
          console.warn('[Native Function→SetClock] Missing time — skipping');
          break;
        }
        if (!session.sceneCanvas) {
          session.sceneCanvas = { environment: '', environmentImageUrl: '', environmentLabel: '', props: [], clockTime: undefined };
        }
        session.sceneCanvas.clockTime = clockTime;
        session.sceneCanvas.clockLabel = clockLabel;
        session.sceneCanvas.clockShowLabel = clockShowLabel;
        const clockUpdate = {
          type: 'whiteboard_update' as const,
          timestamp: Date.now(),
          items: [{
            id: 'scene-canvas-active',
            type: 'scene_canvas',
            content: `Clock: ${clockTime}`,
            data: buildFullSceneCanvasData(session.sceneCanvas, 'set_clock'),
          }],
        };
        if (session.firstAudioSent) {
          this.sendMessage(session.ws, clockUpdate);
        } else {
          if (!session.pendingWhiteboardUpdates) session.pendingWhiteboardUpdates = [];
          session.pendingWhiteboardUpdates.push(clockUpdate);
        }
        console.log(`[Native Function→SetClock] Time set to ${clockTime}`);
        break;
      }
      // ─── Phase 2 Grammar Canvas Handlers ──────────────────────────────────

      case 'INIT_CONJUGATION': {
        const verb = fn.args.verb as string | undefined;
        const tense = fn.args.tense as string | undefined;
        const pronouns = fn.args.pronouns as string[] | undefined;
        const initText = fn.args.text as string | undefined;
        if (initText && !session.functionCallText) session.functionCallText = initText;
        if (!verb || !tense || !pronouns?.length) {
          console.warn('[Native Function→InitConjugation] Missing verb, tense, or pronouns — skipping');
          break;
        }
        if (!session.sceneCanvas) {
          session.sceneCanvas = { environment: '', environmentImageUrl: '', environmentLabel: '', props: [] };
        }
        session.sceneCanvas.conjugationTable = {
          verb,
          tense,
          cells: pronouns.map((p: string) => ({ pronoun: p, form: null })),
        };
        const initConjUpdate = {
          type: 'whiteboard_update' as const,
          timestamp: Date.now(),
          items: [{
            id: 'scene-canvas-active',
            type: 'scene_canvas',
            content: `${verb} — ${tense}`,
            data: {
              environment: session.sceneCanvas.environment,
              environmentImageUrl: session.sceneCanvas.environmentImageUrl,
              environmentLabel: session.sceneCanvas.environmentLabel,
              props: [...(session.sceneCanvas.props || [])],
              clockTime: session.sceneCanvas.clockTime,
              conjugationTable: session.sceneCanvas.conjugationTable,
              canvasAction: 'init_conjugation' as const,
            },
          }],
        };
        if (session.firstAudioSent) {
          this.sendMessage(session.ws, initConjUpdate);
        } else {
          if (!session.pendingWhiteboardUpdates) session.pendingWhiteboardUpdates = [];
          session.pendingWhiteboardUpdates.push(initConjUpdate);
        }
        console.log(`[Native Function→InitConjugation] ${verb} (${tense}) — ${pronouns.length} rows`);
        break;
      }

      case 'FILL_CONJUGATION': {
        const pronoun = fn.args.pronoun as string | undefined;
        const form = fn.args.form as string | undefined;
        const highlightPronoun = fn.args.highlightPronoun as string | undefined;
        const fillText = fn.args.text as string | undefined;
        if (fillText && !session.functionCallText) session.functionCallText = fillText;
        if (!pronoun || !form || !session.sceneCanvas?.conjugationTable) {
          console.warn('[Native Function→FillConjugation] Missing data or no active table — skipping');
          break;
        }
        const table = session.sceneCanvas.conjugationTable;
        const cells = table.cells.map((c: any) => ({
          ...c,
          isNew: false,
          form: c.pronoun === pronoun ? form : c.form,
          isNew2: c.pronoun === pronoun ? true : false,
        }));
        // rename isNew2 → isNew (avoid rename issues)
        const updatedCells = cells.map((c: any) => ({ pronoun: c.pronoun, pronounAlt: c.pronounAlt, form: c.form, isNew: c.isNew2 }));
        table.cells = updatedCells;
        if (highlightPronoun !== undefined) table.highlightPronoun = highlightPronoun;
        const fillUpdate = {
          type: 'whiteboard_update' as const,
          timestamp: Date.now(),
          items: [{
            id: 'scene-canvas-active',
            type: 'scene_canvas',
            content: `${table.verb} — ${pronoun}: ${form}`,
            data: {
              environment: session.sceneCanvas.environment,
              environmentImageUrl: session.sceneCanvas.environmentImageUrl,
              environmentLabel: session.sceneCanvas.environmentLabel,
              props: [...(session.sceneCanvas.props || [])],
              clockTime: session.sceneCanvas.clockTime,
              conjugationTable: { ...table, cells: updatedCells, highlightPronoun: highlightPronoun ?? table.highlightPronoun },
              canvasAction: 'fill_conjugation' as const,
            },
          }],
        };
        if (session.firstAudioSent) {
          this.sendMessage(session.ws, fillUpdate);
        } else {
          if (!session.pendingWhiteboardUpdates) session.pendingWhiteboardUpdates = [];
          session.pendingWhiteboardUpdates.push(fillUpdate);
        }
        console.log(`[Native Function→FillConjugation] ${pronoun} → ${form}`);
        break;
      }

      case 'CLEAR_CONJUGATION': {
        const clearConjText = fn.args.text as string | undefined;
        if (clearConjText && !session.functionCallText) session.functionCallText = clearConjText;
        if (session.sceneCanvas) {
          delete session.sceneCanvas.conjugationTable;
        }
        const clearConjUpdate = {
          type: 'whiteboard_update' as const,
          timestamp: Date.now(),
          items: [{
            id: 'scene-canvas-active',
            type: 'scene_canvas',
            content: '',
            data: {
              environment: session.sceneCanvas?.environment || '',
              environmentImageUrl: session.sceneCanvas?.environmentImageUrl || '',
              environmentLabel: session.sceneCanvas?.environmentLabel || '',
              props: [...(session.sceneCanvas?.props || [])],
              clockTime: session.sceneCanvas?.clockTime,
              canvasAction: 'clear_conjugation' as const,
            },
          }],
        };
        if (session.firstAudioSent) {
          this.sendMessage(session.ws, clearConjUpdate);
        } else {
          if (!session.pendingWhiteboardUpdates) session.pendingWhiteboardUpdates = [];
          session.pendingWhiteboardUpdates.push(clearConjUpdate);
        }
        console.log('[Native Function→ClearConjugation] Table cleared');
        break;
      }

      case 'SET_CALENDAR': {
        const calText = fn.args.text as string | undefined;
        if (calText && !session.functionCallText) session.functionCallText = calText;
        // action="clear" → remove calendar
        if (fn.args.action === 'clear') {
          if (session.sceneCanvas) delete session.sceneCanvas.calendarData;
          const clearCalUpdate = { type: 'whiteboard_update' as const, timestamp: Date.now(), items: [{ id: 'scene-canvas-active', type: 'scene_canvas', content: '', data: { environment: session.sceneCanvas?.environment || '', environmentImageUrl: session.sceneCanvas?.environmentImageUrl || '', environmentLabel: session.sceneCanvas?.environmentLabel || '', props: [...(session.sceneCanvas?.props || [])], clockTime: session.sceneCanvas?.clockTime, canvasAction: 'clear_calendar' as const } }] };
          if (session.firstAudioSent) { this.sendMessage(session.ws, clearCalUpdate); } else { if (!session.pendingWhiteboardUpdates) session.pendingWhiteboardUpdates = []; session.pendingWhiteboardUpdates.push(clearCalUpdate); }
          console.log('[Native Function→SetCalendar] Cleared');
          break;
        }
        const calMonth = fn.args.month as string | undefined;
        const calMonthNumber = fn.args.monthNumber as number | undefined;
        const calYear = fn.args.year as number | undefined;
        const calDayNames = fn.args.dayNames as string[] | undefined;
        const calHighlightDay = fn.args.highlightDay as number | undefined;
        const calHighlightDowIndex = fn.args.highlightDowIndex as number | undefined;
        const calMarkedDays = fn.args.markedDays as number[] | undefined;
        const calStartDow = fn.args.startDow as number | undefined;
        if (!calMonth || !calMonthNumber || !calYear || !calDayNames?.length) {
          console.warn('[Native Function→SetCalendar] Missing required calendar data — skipping');
          break;
        }
        if (!session.sceneCanvas) {
          session.sceneCanvas = { environment: '', environmentImageUrl: '', environmentLabel: '', props: [] };
        }
        session.sceneCanvas.calendarData = {
          month: calMonth, monthNumber: calMonthNumber, year: calYear, dayNames: calDayNames,
          highlightDay: calHighlightDay, highlightDowIndex: calHighlightDowIndex, markedDays: calMarkedDays, startDow: calStartDow,
        };
        const calUpdate = {
          type: 'whiteboard_update' as const, timestamp: Date.now(),
          items: [{ id: 'scene-canvas-active', type: 'scene_canvas', content: `${calMonth} ${calYear}`,
            data: { environment: session.sceneCanvas.environment, environmentImageUrl: session.sceneCanvas.environmentImageUrl, environmentLabel: session.sceneCanvas.environmentLabel, props: [...(session.sceneCanvas.props || [])], clockTime: session.sceneCanvas.clockTime, calendarData: session.sceneCanvas.calendarData, canvasAction: 'set_calendar' as const } }],
        };
        if (session.firstAudioSent) { this.sendMessage(session.ws, calUpdate); } else { if (!session.pendingWhiteboardUpdates) session.pendingWhiteboardUpdates = []; session.pendingWhiteboardUpdates.push(calUpdate); }
        console.log(`[Native Function→SetCalendar] ${calMonth} ${calYear}${calHighlightDay ? `, day ${calHighlightDay}` : ''}`);
        break;
      }

      // ─── Phase 2 Visual Canvas Handlers ───────────────────────────────────

      case 'SET_BODY_PART': {
        const bodyText = fn.args.text as string | undefined;
        if (bodyText && !session.functionCallText) session.functionCallText = bodyText;
        // action="clear" → remove body diagram
        if (fn.args.action === 'clear') {
          if (session.sceneCanvas) delete session.sceneCanvas.bodyDiagram;
          const clearBodyUpdate = { type: 'whiteboard_update' as const, timestamp: Date.now(), items: [{ id: 'scene-canvas-active', type: 'scene_canvas', content: '', data: { environment: session.sceneCanvas?.environment || '', environmentImageUrl: session.sceneCanvas?.environmentImageUrl || '', environmentLabel: session.sceneCanvas?.environmentLabel || '', props: [...(session.sceneCanvas?.props || [])], clockTime: session.sceneCanvas?.clockTime, canvasAction: 'clear_body_diagram' as const } }] };
          if (session.firstAudioSent) { this.sendMessage(session.ws, clearBodyUpdate); } else { if (!session.pendingWhiteboardUpdates) session.pendingWhiteboardUpdates = []; session.pendingWhiteboardUpdates.push(clearBodyUpdate); }
          console.log('[Native Function→SetBodyPart] Cleared');
          break;
        }
        // Accept both parts=["arm","leg"] (array) and part="arm" (singular flat field from dispatcher)
        const rawBodyParts = fn.args.parts as string[] | string | undefined;
        const bodyParts: string[] | undefined = Array.isArray(rawBodyParts)
          ? rawBodyParts
          : (fn.args.part as string | undefined)
            ? [(fn.args.part as string)]
            : typeof rawBodyParts === 'string' ? [rawBodyParts] : undefined;
        const bodyLabels = fn.args.labels as Record<string, string> | undefined;
        const bodyNativeLabels = fn.args.native_labels as Record<string, string> | undefined;
        if (!bodyParts?.length) { console.warn('[Native Function→SetBodyPart] Missing parts — skipping'); break; }
        if (!session.sceneCanvas) session.sceneCanvas = { environment: '', environmentImageUrl: '', environmentLabel: '', props: [] };
        session.sceneCanvas.bodyDiagram = { highlightParts: bodyParts, labels: bodyLabels, nativeLabels: bodyNativeLabels };
        const bodyUpdate = {
          type: 'whiteboard_update' as const, timestamp: Date.now(),
          items: [{ id: 'scene-canvas-active', type: 'scene_canvas', content: bodyParts.join(', '),
            data: { environment: session.sceneCanvas.environment, environmentImageUrl: session.sceneCanvas.environmentImageUrl, environmentLabel: session.sceneCanvas.environmentLabel, props: [...(session.sceneCanvas.props || [])], clockTime: session.sceneCanvas.clockTime, bodyDiagram: session.sceneCanvas.bodyDiagram, canvasAction: 'set_body_part' as const } }],
        };
        if (session.firstAudioSent) { this.sendMessage(session.ws, bodyUpdate); } else { if (!session.pendingWhiteboardUpdates) session.pendingWhiteboardUpdates = []; session.pendingWhiteboardUpdates.push(bodyUpdate); }
        console.log(`[Native Function→SetBodyPart] Parts: ${bodyParts.join(', ')}`);
        break;
      }

      case 'SET_FACE_PART': {
        const faceText = fn.args.text as string | undefined;
        if (faceText && !session.functionCallText) session.functionCallText = faceText;
        // action="clear" → remove face diagram
        if (fn.args.action === 'clear') {
          if (session.sceneCanvas) delete session.sceneCanvas.faceDiagram;
          const clearFaceUpdate = { type: 'whiteboard_update' as const, timestamp: Date.now(), items: [{ id: 'scene-canvas-active', type: 'scene_canvas', content: '', data: { environment: session.sceneCanvas?.environment || '', environmentImageUrl: session.sceneCanvas?.environmentImageUrl || '', environmentLabel: session.sceneCanvas?.environmentLabel || '', props: [...(session.sceneCanvas?.props || [])], clockTime: session.sceneCanvas?.clockTime, canvasAction: 'clear_face_diagram' as const } }] };
          if (session.firstAudioSent) { this.sendMessage(session.ws, clearFaceUpdate); } else { if (!session.pendingWhiteboardUpdates) session.pendingWhiteboardUpdates = []; session.pendingWhiteboardUpdates.push(clearFaceUpdate); }
          console.log('[Native Function→SetFacePart] Cleared');
          break;
        }
        // Accept both parts=["nose"] (array) and part="nose" (singular flat field from dispatcher)
        const rawFaceParts = fn.args.parts as string[] | string | undefined;
        const faceParts: string[] | undefined = Array.isArray(rawFaceParts)
          ? rawFaceParts
          : (fn.args.part as string | undefined)
            ? [(fn.args.part as string)]
            : typeof rawFaceParts === 'string' ? [rawFaceParts] : undefined;
        const faceLabels = fn.args.labels as Record<string, string> | undefined;
        const faceNativeLabels = fn.args.native_labels as Record<string, string> | undefined;
        if (!faceParts?.length) { console.warn('[Native Function→SetFacePart] Missing parts — skipping'); break; }
        if (!session.sceneCanvas) session.sceneCanvas = { environment: '', environmentImageUrl: '', environmentLabel: '', props: [] };
        session.sceneCanvas.faceDiagram = { highlightParts: faceParts, labels: faceLabels, nativeLabels: faceNativeLabels };
        const faceUpdate = {
          type: 'whiteboard_update' as const, timestamp: Date.now(),
          items: [{ id: 'scene-canvas-active', type: 'scene_canvas', content: faceParts.join(', '),
            data: { environment: session.sceneCanvas.environment, environmentImageUrl: session.sceneCanvas.environmentImageUrl, environmentLabel: session.sceneCanvas.environmentLabel, props: [...(session.sceneCanvas.props || [])], clockTime: session.sceneCanvas.clockTime, faceDiagram: session.sceneCanvas.faceDiagram, canvasAction: 'set_face_part' as const } }],
        };
        if (session.firstAudioSent) { this.sendMessage(session.ws, faceUpdate); } else { if (!session.pendingWhiteboardUpdates) session.pendingWhiteboardUpdates = []; session.pendingWhiteboardUpdates.push(faceUpdate); }
        console.log(`[Native Function→SetFacePart] Parts: ${faceParts.join(', ')}`);
        break;
      }

      case 'SET_HAND_PART': {
        const handText = fn.args.text as string | undefined;
        if (handText && !session.functionCallText) session.functionCallText = handText;
        // action="clear" → remove hand diagram
        if (fn.args.action === 'clear') {
          if (session.sceneCanvas) delete session.sceneCanvas.handDiagram;
          const clearHandUpdate = { type: 'whiteboard_update' as const, timestamp: Date.now(), items: [{ id: 'scene-canvas-active', type: 'scene_canvas', content: '', data: { environment: session.sceneCanvas?.environment || '', environmentImageUrl: session.sceneCanvas?.environmentImageUrl || '', environmentLabel: session.sceneCanvas?.environmentLabel || '', props: [...(session.sceneCanvas?.props || [])], clockTime: session.sceneCanvas?.clockTime, canvasAction: 'clear_hand_diagram' as const } }] };
          if (session.firstAudioSent) { this.sendMessage(session.ws, clearHandUpdate); } else { if (!session.pendingWhiteboardUpdates) session.pendingWhiteboardUpdates = []; session.pendingWhiteboardUpdates.push(clearHandUpdate); }
          console.log('[Native Function→SetHandPart] Cleared');
          break;
        }
        // Accept both parts=["finger"] (array) and part="finger" (singular flat field from dispatcher)
        const rawHandParts = fn.args.parts as string[] | string | undefined;
        const handParts: string[] | undefined = Array.isArray(rawHandParts)
          ? rawHandParts
          : (fn.args.part as string | undefined)
            ? [(fn.args.part as string)]
            : typeof rawHandParts === 'string' ? [rawHandParts] : undefined;
        const handLabels = fn.args.labels as Record<string, string> | undefined;
        const handNativeLabels = fn.args.native_labels as Record<string, string> | undefined;
        const handSide = fn.args.hand as 'left' | 'right' | undefined;
        if (!handParts?.length) { console.warn('[Native Function→SetHandPart] Missing parts — skipping'); break; }
        if (!session.sceneCanvas) session.sceneCanvas = { environment: '', environmentImageUrl: '', environmentLabel: '', props: [] };
        session.sceneCanvas.handDiagram = { highlightParts: handParts, labels: handLabels, nativeLabels: handNativeLabels, hand: handSide ?? 'right' };
        const handUpdate = {
          type: 'whiteboard_update' as const, timestamp: Date.now(),
          items: [{ id: 'scene-canvas-active', type: 'scene_canvas', content: handParts.join(', '),
            data: { environment: session.sceneCanvas.environment, environmentImageUrl: session.sceneCanvas.environmentImageUrl, environmentLabel: session.sceneCanvas.environmentLabel, props: [...(session.sceneCanvas.props || [])], clockTime: session.sceneCanvas.clockTime, handDiagram: session.sceneCanvas.handDiagram, canvasAction: 'set_hand_part' as const } }],
        };
        if (session.firstAudioSent) { this.sendMessage(session.ws, handUpdate); } else { if (!session.pendingWhiteboardUpdates) session.pendingWhiteboardUpdates = []; session.pendingWhiteboardUpdates.push(handUpdate); }
        console.log(`[Native Function→SetHandPart] Parts: ${handParts.join(', ')}`);
        break;
      }

      case 'SET_THERMOMETER': {
        const thermText = fn.args.text as string | undefined;
        if (thermText && !session.functionCallText) session.functionCallText = thermText;
        // action="clear" → remove thermometer
        if (fn.args.action === 'clear') {
          if (session.sceneCanvas) delete session.sceneCanvas.thermometerData;
          const clearThermUpdate = { type: 'whiteboard_update' as const, timestamp: Date.now(), items: [{ id: 'scene-canvas-active', type: 'scene_canvas', content: '', data: buildFullSceneCanvasData(session.sceneCanvas, 'clear_thermometer') }] };
          if (session.firstAudioSent) { this.sendMessage(session.ws, clearThermUpdate); } else { if (!session.pendingWhiteboardUpdates) session.pendingWhiteboardUpdates = []; session.pendingWhiteboardUpdates.push(clearThermUpdate); }
          console.log('[Native Function→SetThermometer] Cleared');
          break;
        }
        // Accept celsius (preferred) OR temperature flat field (Fahrenheit — legacy dispatcher field name)
        let thermCelsius = fn.args.celsius as number | undefined;
        if (thermCelsius === undefined && fn.args.temperature !== undefined) {
          const tempRaw = Number(fn.args.temperature);
          const unitRaw = (fn.args.unit as string | undefined)?.toUpperCase();
          thermCelsius = (unitRaw === 'C') ? tempRaw : Math.round((tempRaw - 32) * 5 / 9);
          console.log(`[Native Function→SetThermometer] Converted temperature=${fn.args.temperature}${unitRaw ?? 'F'} → ${thermCelsius}°C`);
        }
        const thermLabel = fn.args.labelText as string | undefined;
        // showFahrenheit: true when caller passed unit="F" or explicitly requested Fahrenheit display.
        // IMPORTANT: store undefined (not false) when caller omits both params so the frontend's
        // isUS locale fallback can still activate for US students.
        const thermFahrenheitExplicit = fn.args.showFahrenheit as boolean | undefined;
        const unitStr = (fn.args.unit as string | undefined)?.toUpperCase();
        const thermFahrenheit: boolean | undefined = thermFahrenheitExplicit !== undefined
          ? thermFahrenheitExplicit
          : unitStr ? unitStr === 'F' : undefined;
        if (thermCelsius === undefined) { console.warn('[Native Function→SetThermometer] Missing celsius/temperature — skipping'); break; }
        if (!session.sceneCanvas) session.sceneCanvas = { environment: '', environmentImageUrl: '', environmentLabel: '', props: [] };
        session.sceneCanvas.thermometerData = { celsius: thermCelsius, labelText: thermLabel, showFahrenheit: thermFahrenheit };
        const thermUpdate = {
          type: 'whiteboard_update' as const, timestamp: Date.now(),
          items: [{ id: 'scene-canvas-active', type: 'scene_canvas', content: `${thermCelsius}°C`,
            data: buildFullSceneCanvasData(session.sceneCanvas, 'set_thermometer') }],
        };
        if (session.firstAudioSent) { this.sendMessage(session.ws, thermUpdate); } else { if (!session.pendingWhiteboardUpdates) session.pendingWhiteboardUpdates = []; session.pendingWhiteboardUpdates.push(thermUpdate); }
        console.log(`[Native Function→SetThermometer] ${thermCelsius}°C`);
        break;
      }

      case 'SET_EMOTION': {
        const emotionText = fn.args.text as string | undefined;
        if (emotionText && !session.functionCallText) session.functionCallText = emotionText;
        // action="clear" → remove emotion face
        if (fn.args.action === 'clear') {
          if (session.sceneCanvas) delete session.sceneCanvas.emotionData;
          const clearEmotionUpdate = { type: 'whiteboard_update' as const, timestamp: Date.now(), items: [{ id: 'scene-canvas-active', type: 'scene_canvas', content: '', data: buildFullSceneCanvasData(session.sceneCanvas, 'clear_emotion') }] };
          if (session.firstAudioSent) { this.sendMessage(session.ws, clearEmotionUpdate); } else { if (!session.pendingWhiteboardUpdates) session.pendingWhiteboardUpdates = []; session.pendingWhiteboardUpdates.push(clearEmotionUpdate); }
          console.log('[Native Function→SetEmotion] Cleared');
          break;
        }
        const emotionLabel = fn.args.label as string | undefined;
        // fn.args.emotion is the direct slug (native SET_EMOTION call).
        // When called via the multi_widget dispatcher, only level+label are passed — no emotion slug.
        // Derive the slug from label in that case, falling back to the closest available face.
        const EMOTION_FACE_SLUGS = new Set(['happy', 'excited', 'sad', 'angry', 'surprised', 'afraid', 'confused', 'tired', 'nervous', 'disgusted', 'bored']);
        const EMOTION_ALIAS_MAP: Record<string, string> = {
          focused: 'confused', thoughtful: 'confused', determined: 'excited',
          calm: 'happy', neutral: 'happy', proud: 'excited', friendly: 'happy',
          warm: 'happy', curious: 'confused', playful: 'excited', encouraging: 'happy',
          engaged: 'excited', relaxed: 'happy', worried: 'nervous', scared: 'afraid',
          frustrated: 'angry', annoyed: 'angry', pleased: 'happy', satisfied: 'happy',
        };
        let emotionSlug = fn.args.emotion as string | undefined;
        if (!emotionSlug && emotionLabel) {
          const normalized = emotionLabel.toLowerCase().trim();
          emotionSlug = EMOTION_FACE_SLUGS.has(normalized) ? normalized : (EMOTION_ALIAS_MAP[normalized] ?? 'happy');
          console.log(`[Native Function→SetEmotion] Derived slug from label "${emotionLabel}" → "${emotionSlug}"`);
        }
        if (!emotionSlug) { console.warn('[Native Function→SetEmotion] Missing emotion slug and no label to derive from — skipping'); break; }
        if (!session.sceneCanvas) session.sceneCanvas = { environment: '', environmentImageUrl: '', environmentLabel: '', props: [] };
        session.sceneCanvas.emotionData = { emotion: emotionSlug, label: emotionLabel };
        const emotionUpdate = {
          type: 'whiteboard_update' as const, timestamp: Date.now(),
          items: [{ id: 'scene-canvas-active', type: 'scene_canvas', content: emotionLabel ?? emotionSlug,
            data: buildFullSceneCanvasData(session.sceneCanvas, 'set_emotion') }],
        };
        if (session.firstAudioSent) { this.sendMessage(session.ws, emotionUpdate); } else { if (!session.pendingWhiteboardUpdates) session.pendingWhiteboardUpdates = []; session.pendingWhiteboardUpdates.push(emotionUpdate); }
        console.log(`[Native Function→SetEmotion] ${emotionSlug}${emotionLabel ? ` (${emotionLabel})` : ''}`);
        break;
      }

      case 'SET_WEATHER': {
        const weatherText = fn.args.text as string | undefined;
        if (weatherText && !session.functionCallText) session.functionCallText = weatherText;
        // action="clear" → remove weather icon
        if (fn.args.action === 'clear') {
          if (session.sceneCanvas) delete session.sceneCanvas.weatherData;
          const clearWeatherUpdate = { type: 'whiteboard_update' as const, timestamp: Date.now(), items: [{ id: 'scene-canvas-active', type: 'scene_canvas', content: '', data: buildFullSceneCanvasData(session.sceneCanvas, 'clear_weather') }] };
          if (session.firstAudioSent) { this.sendMessage(session.ws, clearWeatherUpdate); } else { if (!session.pendingWhiteboardUpdates) session.pendingWhiteboardUpdates = []; session.pendingWhiteboardUpdates.push(clearWeatherUpdate); }
          console.log('[Native Function→SetWeather] Cleared');
          break;
        }
        const weatherCondition = fn.args.condition as string | undefined;
        const weatherLabel = fn.args.label as string | undefined;
        // Accept celsius (preferred) OR temperature flat field (Fahrenheit — legacy dispatcher field name)
        let weatherCelsius = fn.args.celsius as number | undefined;
        if (weatherCelsius === undefined && fn.args.temperature !== undefined) {
          const tempRaw = Number(fn.args.temperature);
          const unitRaw = (fn.args.unit as string | undefined)?.toUpperCase();
          weatherCelsius = (unitRaw === 'C') ? tempRaw : Math.round((tempRaw - 32) * 5 / 9);
          console.log(`[Native Function→SetWeather] Converted temperature=${fn.args.temperature}${unitRaw ?? 'F'} → ${weatherCelsius}°C`);
        }
        if (!weatherCondition) { console.warn('[Native Function→SetWeather] Missing condition — skipping'); break; }
        if (!session.sceneCanvas) session.sceneCanvas = { environment: '', environmentImageUrl: '', environmentLabel: '', props: [] };
        // Preserve existing celsius and label when omitted — e.g. a label-only update
        // (SET_WEATHER with condition + label but no celsius) must not wipe the temperature
        // that was already set by a previous call.
        const existingWeather = session.sceneCanvas.weatherData;
        session.sceneCanvas.weatherData = {
          condition: weatherCondition,
          label: weatherLabel ?? existingWeather?.label,
          celsius: weatherCelsius ?? existingWeather?.celsius,
        };
        const weatherUpdate = {
          type: 'whiteboard_update' as const, timestamp: Date.now(),
          items: [{ id: 'scene-canvas-active', type: 'scene_canvas', content: weatherLabel ?? weatherCondition,
            data: buildFullSceneCanvasData(session.sceneCanvas, 'set_weather') }],
        };
        if (session.firstAudioSent) { this.sendMessage(session.ws, weatherUpdate); } else { if (!session.pendingWhiteboardUpdates) session.pendingWhiteboardUpdates = []; session.pendingWhiteboardUpdates.push(weatherUpdate); }
        console.log(`[Native Function→SetWeather] ${weatherCondition}${weatherLabel ? ` (${weatherLabel})` : ''}`);
        break;
      }

      case 'HIGHLIGHT_COUNTRY': {
        const mapText = fn.args.text as string | undefined;
        if (mapText && !session.functionCallText) session.functionCallText = mapText;
        // action="clear" → remove world map
        if (fn.args.action === 'clear') {
          if (session.sceneCanvas) delete session.sceneCanvas.worldMapData;
          const clearMapUpdate = { type: 'whiteboard_update' as const, timestamp: Date.now(), items: [{ id: 'scene-canvas-active', type: 'scene_canvas', content: '', data: buildFullSceneCanvasData(session.sceneCanvas, 'clear_world_map') }] };
          if (session.firstAudioSent) { this.sendMessage(session.ws, clearMapUpdate); } else { if (!session.pendingWhiteboardUpdates) session.pendingWhiteboardUpdates = []; session.pendingWhiteboardUpdates.push(clearMapUpdate); }
          console.log('[Native Function→HighlightCountry] Cleared');
          break;
        }
        // Accept countries=["Mexico","Spain"] (array) or country="Mexico" (singular flat field from dispatcher)
        const rawMapCountries = fn.args.countries as string[] | string | undefined;
        const mapCountries: string[] | undefined = Array.isArray(rawMapCountries)
          ? rawMapCountries
          : (fn.args.country as string | undefined)
            ? [(fn.args.country as string)]
            : typeof rawMapCountries === 'string' ? [rawMapCountries] : undefined;
        const mapLabels = fn.args.labels as Record<string, string> | undefined;
        if (!mapCountries?.length) { console.warn('[Native Function→HighlightCountry] Missing countries — skipping'); break; }
        if (!session.sceneCanvas) session.sceneCanvas = { environment: '', environmentImageUrl: '', environmentLabel: '', props: [] };
        session.sceneCanvas.worldMapData = { highlightCountries: mapCountries, labels: mapLabels };
        const mapUpdate = {
          type: 'whiteboard_update' as const, timestamp: Date.now(),
          items: [{ id: 'scene-canvas-active', type: 'scene_canvas', content: mapCountries.join(', '),
            data: { environment: session.sceneCanvas.environment, environmentImageUrl: session.sceneCanvas.environmentImageUrl, environmentLabel: session.sceneCanvas.environmentLabel, props: [...(session.sceneCanvas.props || [])], clockTime: session.sceneCanvas.clockTime, worldMapData: session.sceneCanvas.worldMapData, canvasAction: 'highlight_country' as const } }],
        };
        if (session.firstAudioSent) { this.sendMessage(session.ws, mapUpdate); } else { if (!session.pendingWhiteboardUpdates) session.pendingWhiteboardUpdates = []; session.pendingWhiteboardUpdates.push(mapUpdate); }
        console.log(`[Native Function→HighlightCountry] ${mapCountries.join(', ')}`);
        break;
      }

      // ─────────────────────────────────────────────────────────────────────

      case 'ENTER_IMMERSIVE': {
        const immersiveAction = (fn.args.action as string | undefined) || 'enter';
        const immersiveText = fn.args.text as string | undefined;
        if (immersiveText && !session.functionCallText) session.functionCallText = immersiveText;
        const immersiveMsg = { type: 'immersive_mode' as const, active: immersiveAction !== 'exit', timestamp: Date.now() };
        if (session.firstAudioSent) {
          this.sendMessage(session.ws, immersiveMsg);
        } else {
          session.pendingWhiteboardUpdates = session.pendingWhiteboardUpdates || [];
          session.pendingWhiteboardUpdates.push(immersiveMsg as any);
        }
        console.log(`[Native Function→Immersive] mode ${immersiveAction === 'exit' ? 'deactivated' : 'activated'}`);
        break;
      }

      // ─────────────────────────────────────────────────────────────────────

      case 'GET_SCENE_ZONES': {
        const sceneName = fn.args.scene_name as string | undefined;
        if (!sceneName) break;
        import('../services/prop-room-compositor').then(async ({ getSceneZones }) => {
          try {
            const result = await getSceneZones(sceneName);
            session.lastSceneZones = result;
            console.log(`[Native Function→GetSceneZones] "${sceneName}": ${result.zones?.length || 0} zones`);
          } catch (err: any) {
            console.error(`[Native Function→GetSceneZones] Error:`, err.message);
          }
        });
        break;
      }

      case 'GET_WHITEBOARD_STATE': {
        // Build a spatial description of what the student currently sees on screen
        const parts: string[] = [];

        // ── Scene canvas (left/center panel) ──────────────────────────────────
        const sc = session.sceneCanvas;
        if (sc) {
          const scParts: string[] = [];
          if (sc.environment || sc.environmentImageUrl) {
            scParts.push(`Background: "${sc.environmentLabel || sc.environment || 'classroom scene'}"`);
          }
          if (sc.clockTime) scParts.push(`Clock widget: ${sc.clockTime}`);
          if (sc.thermometerData) {
            const td = sc.thermometerData;
            scParts.push(`Thermometer widget: ${td.celsius !== undefined ? `${td.celsius}°C` : ''} ${td.fahrenheit !== undefined ? `${td.fahrenheit}°F` : ''} ${td.label || ''}`);
          }
          if (sc.weatherData) {
            const wd = sc.weatherData;
            scParts.push(`Weather widget: ${wd.condition || ''} ${wd.temperature || ''}`);
          }
          if (sc.emotionData) {
            scParts.push(`Emotion widget: ${sc.emotionData.emotion || sc.emotionData.label || ''}`);
          }
          if (sc.conjugationTable) {
            const ct = sc.conjugationTable;
            const filled = (ct.cells || []).filter((c: any) => c.form).length;
            scParts.push(`Conjugation table: ${ct.verb} (${ct.tense}) — ${filled}/${(ct.cells || []).length} cells filled`);
          }
          if (sc.bodyDiagram) scParts.push(`Body diagram: ${sc.bodyDiagram.label || 'body parts'}`);
          if (sc.faceDiagram) scParts.push(`Face diagram: ${sc.faceDiagram.label || 'face parts'}`);
          if (sc.handDiagram) scParts.push(`Hand diagram: ${sc.handDiagram.label || 'hand parts'}`);
          if (sc.worldMapData) scParts.push(`World map: ${sc.worldMapData.highlightedCountry || 'interactive map'}`);
          if (sc.calendarData) scParts.push(`Calendar: ${sc.calendarData.month || ''} ${sc.calendarData.year || ''}`);
          const props = (sc.props || []).filter((p: any) => p.name);
          if (props.length) scParts.push(`Scene props: ${props.map((p: any) => p.name).join(', ')}`);
          if (scParts.length) parts.push(`[Scene canvas]\n${scParts.join('\n')}`);
        } else {
          parts.push('[Scene canvas] Empty — no visual scene active');
        }

        // ── Whiteboard column (right panel) ───────────────────────────────────
        const wbItems = session.classroomWhiteboardItems || [];
        if (wbItems.length === 0) {
          parts.push('[Whiteboard column] Empty — nothing on the board');
        } else {
          const wbLines = wbItems.slice(-8).map((item: any) => {
            if (item.type === 'vocab_card') return `  • Vocab card: "${item.content}" — ${item.label || ''}`;
            if (item.type === 'teaching_card') return `  • Teaching card: "${item.content}" ${item.label ? `(${item.label})` : ''}`;
            if (item.type === 'lesson_note') return `  • Lesson note [${item.label || 'note'}]: "${item.content}"`;
            if (item.type === 'word_map') return `  • Word map: "${item.content}" → related: ${item.label || ''}`;
            if (item.type === 'image') return `  • Image: ${item.label || item.content || 'photo'}`;
            if (item.type === 'drill') return `  • Drill: ${item.content || item.label}`;
            if (item.type === 'dialogue') return `  • Dialogue: ${item.content || ''}`;
            return `  • ${item.type}: ${item.content || item.label || ''}`;
          });
          parts.push(`[Whiteboard column]\n${wbLines.join('\n')}`);
        }

        const snapshot = parts.join('\n\n');
        session.classroomStateSnapshot = snapshot;
        console.log(`[Native Function→GetWhiteboardState] Snapshot built (${wbItems.length} board items)`);
        break;
      }

      case 'TEXT_INPUT': {
        const prompt = fn.args.prompt as string | undefined;
        const tiSpokenText = fn.args.spoken_text as string | undefined;
        if (tiSpokenText && !session.functionCallText) {
          session.functionCallText = tiSpokenText;
        }
        this.sendMessage(session.ws, {
          type: 'whiteboard_update',
          timestamp: Date.now(),
          items: [{ type: 'text_input', content: prompt || 'Type your answer' }],
        });
        console.log(`[Native Function Call] TEXT_INPUT -> requesting text input`);
        break;
      }
      
      case 'UNIFIED_RECALL': {
        const urQuery = fn.args.query as string | undefined;
        if (urQuery) {
          console.log(`[Native Function→UnifiedRecall] Query: "${urQuery.substring(0, 60)}"`);
          const urPromise = this.processUnifiedRecall(session, urQuery).catch(err => {
            console.error(`[Native Function→UnifiedRecall] Error:`, err.message);
          });
          if (!session.pendingMemoryLookupPromises) session.pendingMemoryLookupPromises = [];
          session.pendingMemoryLookupPromises.push(urPromise);
        }
        break;
      }

      case 'RECALL_EPISODE_DEEP': {
        const edTitle = fn.args.title as string | undefined;
        const edReadNext = fn.args.read_next as boolean | undefined;
        const edAfterEpisodeId = fn.args.after_episode_id as string | undefined;

        // Validate: need at least one of title, read_next, or after_episode_id
        if (!edTitle?.trim() && !edReadNext && !edAfterEpisodeId?.trim()) {
          (session as any).episodeDeepReadStub = 'No episode title provided. Call recall_episode_deep with a title, episode number, or read_next: true to step through episodes in order.';
          break;
        }

        const edMode = edReadNext || edAfterEpisodeId ? 'next' : 'title';
        console.log(`[Native Function→RecallEpisodeDeep] mode=${edMode} title="${edTitle?.trim() ?? ''}" read_next=${edReadNext} after_id="${edAfterEpisodeId ?? ''}"`);

        // Clear any existing queue before starting a new fetch — prevents mixing chunks from
        // different episodes when Daniela calls this tool back-to-back (Gemini review fix).
        (session as any).episodeReadQueue = [];

        // Per-request generation token: captures which request "owns" the queue.
        // The detached fetch checks this token before every enqueue — if a newer request
        // has started (token incremented), stale results are discarded rather than mixed in.
        const prevToken: number = (session as any).episodeReadTokenCounter ?? 0;
        const thisToken = prevToken + 1;
        (session as any).episodeReadTokenCounter = thisToken;

        // Immediate stub — Daniela gets this via buildContinuationResponse so she can keep talking
        (session as any).episodeDeepReadStub = edMode === 'next'
          ? 'Advancing to the next episode in arc order — content will arrive turn by turn. Keep talking naturally.'
          : `Reading "${edTitle!.trim()}" — the full episode content will arrive in your context turn by turn starting next turn. Keep talking naturally.`;

        // Background fetch — non-blocking, queues chunks into session.episodeReadQueue.
        // Uses thisToken to guard against out-of-order completion from a prior call.
        const edPromise = (async () => {
          try {
            const db = getSharedDb();
            const { sql: rawSql } = await import('drizzle-orm');

            let episodeRows: Array<{ id: string; title: string; content: string; arc_name: string; created_at: string }> = [];

            if (edMode === 'next') {
              // "Read next" mode: find the episode created immediately after the anchor.
              // Anchor priority: explicit after_episode_id > session-tracked lastDeliveredEpisodeId.
              // If no anchor exists yet, start from the very first episode (oldest created_at).
              const anchorId: string | undefined = edAfterEpisodeId?.trim() || (session as any).lastDeliveredEpisodeId;

              if (anchorId) {
                // Fetch the episode_order and created_at of the anchor so we can find what comes after it.
                const anchorRows = await db.execute(rawSql`
                  SELECT created_at, episode_order
                  FROM conversation_memories
                  WHERE id = ${anchorId}
                    AND (entry_type = 'episode' OR arc_name = 'HolaHola Episodes')
                  LIMIT 1
                `);
                const anchorRow = (anchorRows.rows as Array<{ created_at: string; episode_order: number | null }>)[0];
                if (anchorRow) {
                  let nextRows;
                  if (anchorRow.episode_order !== null && anchorRow.episode_order !== undefined) {
                    // Prefer episode_order-based traversal when the anchor has an explicit position.
                    // Include NULL-order episodes (they sort LAST) so the chain continues beyond
                    // the highest explicitly-ordered episode into any unordered ones at the end.
                    nextRows = await db.execute(rawSql`
                      SELECT id, title, content, arc_name, created_at, episode_order
                      FROM conversation_memories
                      WHERE (entry_type = 'episode' OR arc_name = 'HolaHola Episodes')
                        AND (episode_order > ${anchorRow.episode_order} OR episode_order IS NULL)
                      ORDER BY episode_order ASC NULLS LAST, created_at ASC
                      LIMIT 1
                    `);
                  } else {
                    // Anchor has no explicit order — fall back to created_at comparison
                    nextRows = await db.execute(rawSql`
                      SELECT id, title, content, arc_name, created_at, episode_order
                      FROM conversation_memories
                      WHERE (entry_type = 'episode' OR arc_name = 'HolaHola Episodes')
                        AND created_at > ${anchorRow.created_at}
                      ORDER BY episode_order ASC NULLS LAST, created_at ASC
                      LIMIT 1
                    `);
                  }
                  episodeRows = nextRows.rows as typeof episodeRows;
                } else {
                  // Anchor ID not found — fall back to first episode
                  console.warn(`[RecallEpisodeDeep] Anchor ID "${anchorId}" not found — starting from first episode`);
                  const firstRows = await db.execute(rawSql`
                    SELECT id, title, content, arc_name, created_at, episode_order
                    FROM conversation_memories
                    WHERE (entry_type = 'episode' OR arc_name = 'HolaHola Episodes')
                    ORDER BY episode_order ASC NULLS LAST, created_at ASC
                    LIMIT 1
                  `);
                  episodeRows = firstRows.rows as typeof episodeRows;
                }
              } else {
                // No anchor: start from the very first episode (prequel first if episode_order=0)
                const firstRows = await db.execute(rawSql`
                  SELECT id, title, content, arc_name, created_at, episode_order
                  FROM conversation_memories
                  WHERE (entry_type = 'episode' OR arc_name = 'HolaHola Episodes')
                  ORDER BY episode_order ASC NULLS LAST, created_at ASC
                  LIMIT 1
                `);
                episodeRows = firstRows.rows as typeof episodeRows;
              }
            } else {
              // Title-based lookup (original path)
              const searchTerm = edTitle!.trim();

              // Search conversation_memories for the episode by TITLE ONLY.
              // arc_name is used only as an episodicity filter (is this an episode record?)
              // — never as a match field. Matching on arc_name ('HolaHola Episodes') would
              // select every episode when the search term happens to match the shared arc name.
              const edRows = await db.execute(rawSql`
                SELECT id, title, content, arc_name, created_at
                FROM conversation_memories
                WHERE (entry_type = 'episode' OR arc_name = 'HolaHola Episodes')
                  AND title ILIKE ${`%${searchTerm}%`}
                ORDER BY
                  CASE WHEN LOWER(title) = LOWER(${searchTerm}) THEN 0 ELSE 1 END,
                  created_at ASC
                LIMIT 3
              `);
              episodeRows = edRows.rows as typeof episodeRows;

              // Fallback: number-based search (e.g. "Episode 1" → extract "1", search in title).
              // Only fires when title-match returned nothing — prevents episode-0 from matching
              // "Episode 25" when both titles contain "Episode".
              if (!episodeRows.length) {
                const numMatch = searchTerm.match(/\d+/);
                if (numMatch) {
                  const numRows = await db.execute(rawSql`
                    SELECT id, title, content, arc_name, created_at
                    FROM conversation_memories
                    WHERE (entry_type = 'episode' OR arc_name = 'HolaHola Episodes')
                      AND title ~ ${`(^|\\D)${numMatch[0]}(\\D|$)`}
                    ORDER BY created_at ASC
                    LIMIT 1
                  `);
                  episodeRows = numRows.rows as typeof episodeRows;
                }
              }
            }

            if (!episodeRows.length || !episodeRows[0].content) {
              // Token guard: discard if a newer request has claimed the queue
              if ((session as any).episodeReadTokenCounter !== thisToken) return;
              if (!(session as any).episodeReadQueue) (session as any).episodeReadQueue = [];
              const notFoundLabel = edMode === 'next' ? 'next episode' : (edTitle?.trim() ?? 'requested episode');
              (session as any).episodeReadQueue.push({
                label: notFoundLabel,
                content: edMode === 'next'
                  ? 'No further episodes found — you have reached the end of the arc. All episodes have been read.'
                  : `No episode found matching "${edTitle?.trim()}". Try introspect() with a keyword to search across all conversation records.`,
                chunkIndex: 1,
                totalChunks: 1,
                isFinal: true,
              });
              return;
            }

            const episode = episodeRows[0];
            const fullContent = episode.content;
            const episodeLabel = episode.title || (edTitle?.trim() ?? 'episode');

            // Chunk at natural sentence boundaries — ~4000 chars per chunk, never mid-sentence
            const CHUNK_SIZE = 4000;
            const chunks: string[] = [];

            if (fullContent.length <= CHUNK_SIZE) {
              chunks.push(fullContent);
            } else {
              let remaining = fullContent;
              while (remaining.length > 0) {
                if (remaining.length <= CHUNK_SIZE) {
                  chunks.push(remaining.trim());
                  break;
                }
                // Find last sentence-end within CHUNK_SIZE window
                const window = remaining.slice(0, CHUNK_SIZE + 300);
                // Sentence break: period/!/?  followed by whitespace and capital letter
                let breakIdx = -1;
                const sentenceBreak = /[.!?]\s+(?=[A-ZÀÁÂÃÄÅÆÇÈÉÊËÌÍÎÏÐÑÒÓÔÕÖØÙÚÛÜÝ\u0400-\u04FF])/g;
                let m: RegExpExecArray | null;
                while ((m = sentenceBreak.exec(window)) !== null) {
                  if (m.index + 2 <= CHUNK_SIZE) {
                    breakIdx = m.index + 1; // include the punctuation character
                  }
                }
                // Fallback: last newline before CHUNK_SIZE
                if (breakIdx < 100) {
                  const nlIdx = remaining.lastIndexOf('\n', CHUNK_SIZE);
                  breakIdx = nlIdx > 100 ? nlIdx : CHUNK_SIZE;
                }
                chunks.push(remaining.slice(0, breakIdx + 1).trim());
                remaining = remaining.slice(breakIdx + 1).trim();
              }
            }

            // Token guard: discard all chunks if a newer request has claimed the queue.
            // Prevents out-of-order completion from a prior call poisoning the current queue.
            // Cursor mutation (lastDeliveredEpisodeId) lives INSIDE this guard — a stale
            // completion that loses the token race must have zero side effects on session state.
            if ((session as any).episodeReadTokenCounter !== thisToken) {
              console.log(`[RecallEpisodeDeep] Discarding stale fetch for "${episodeLabel}" (token mismatch — newer request owns the queue)`);
              return;
            }

            // Advance the session cursor only after confirming this request still owns the queue.
            // This prevents a race where two back-to-back read_next calls overlap: the older
            // one would otherwise write its episode ID after the newer one already advanced,
            // causing the next read_next to skip or repeat episodes.
            (session as any).lastDeliveredEpisodeId = episode.id;

            // Compute ordinal position (N of total) so Daniela can say "we're on Episode 3 of 26".
            // Uses a single window-function query — non-fatal if it fails.
            let episodeOrdinal = 0;
            let episodeTotal = 0;
            try {
              const ordinalRows = await db.execute(rawSql`
                SELECT ordinal, total FROM (
                  SELECT
                    id,
                    ROW_NUMBER() OVER (ORDER BY episode_order ASC NULLS LAST, created_at ASC) AS ordinal,
                    COUNT(*) OVER () AS total
                  FROM conversation_memories
                  WHERE (entry_type = 'episode' OR arc_name = 'HolaHola Episodes')
                ) t WHERE id = ${episode.id}
              `);
              const ordinalRow = (ordinalRows.rows as Array<{ ordinal: string | number; total: string | number }>)[0];
              if (ordinalRow) {
                episodeOrdinal = Number(ordinalRow.ordinal);
                episodeTotal = Number(ordinalRow.total);
              }
            } catch (ordinalErr: any) {
              console.warn('[RecallEpisodeDeep] Ordinal query failed (non-fatal):', ordinalErr.message);
            }
            const ordinalPrefix = episodeOrdinal > 0 && episodeTotal > 0
              ? `Episode ${episodeOrdinal} of ${episodeTotal}: `
              : '';

            // Update the immediate stub to show the actual episode title with ordinal position.
            // Overrides the generic synchronous stub for both modes — safe because
            // pendingMemoryLookupPromises is always awaited before buildContinuationResponse
            // reads episodeDeepReadStub.
            (session as any).episodeDeepReadStub = `Reading ${ordinalPrefix}${episodeLabel} — content will arrive turn by turn. Keep talking naturally.`;

            // Store chunks in session queue
            if (!(session as any).episodeReadQueue) (session as any).episodeReadQueue = [];
            for (let i = 0; i < chunks.length; i++) {
              (session as any).episodeReadQueue.push({
                label: episodeLabel,
                content: chunks[i],
                chunkIndex: i + 1,
                totalChunks: chunks.length,
                isFinal: i === chunks.length - 1,
              });
            }
            console.log(`[RecallEpisodeDeep] Queued ${chunks.length} chunk(s) for "${episodeLabel}" (${fullContent.length} chars total)`);
          } catch (err: any) {
            console.error('[RecallEpisodeDeep] Fetch failed:', err.message);
            // Token guard: only write error stub if this is still the active request
            if ((session as any).episodeReadTokenCounter !== thisToken) return;
            if (!(session as any).episodeReadQueue) (session as any).episodeReadQueue = [];
            (session as any).episodeReadQueue.push({
              label: edTitle?.trim() ?? (edMode === 'next' ? 'next episode' : 'episode'),
              content: `Error fetching episode: ${err.message}. Try introspect() or recall() instead.`,
              chunkIndex: 1,
              totalChunks: 1,
              isFinal: true,
            });
          }
        })();

        // Added to pendingMemoryLookupPromises (safe because recall_episode_deep is
        // GL-excluded — this tool only runs in text-mode FC sessions where
        // pendingMemoryLookupPromises is always awaited before functionResponseParts
        // is built). Awaiting guarantees chunks are ready for injection on the same turn.
        if (!session.pendingMemoryLookupPromises) session.pendingMemoryLookupPromises = [];
        session.pendingMemoryLookupPromises.push(edPromise);
        break;
      }

      case 'MEMORY_LOOKUP': {
        const mlQuery = fn.args.query as string | undefined;
        if (mlQuery) {
          // domains arrives as string[] from FC, or may be a comma-separated string from GL text path
          const rawDomainsArg = fn.args.domains;
          const rawDomains: string[] = Array.isArray(rawDomainsArg)
            ? rawDomainsArg as string[]
            : typeof rawDomainsArg === 'string' && rawDomainsArg.trim()
              ? rawDomainsArg.split(',').map((d: string) => d.trim()).filter(Boolean)
              : [];
          console.log(`[Native Function→MemoryLookup] Query: "${mlQuery.substring(0, 60)}" domains: [${rawDomains.join(', ')}]`);
          const mlPromise = this.processMemoryLookup(session, mlQuery, rawDomains).catch(err => {
            console.error(`[Native Function→MemoryLookup] Error:`, err.message);
          });
          if (!session.pendingMemoryLookupPromises) session.pendingMemoryLookupPromises = [];
          session.pendingMemoryLookupPromises.push(mlPromise);
        }
        break;
      }

      case 'CONVERSATION_DATE_BROWSE': {
        const afterDateStr = fn.args.after_date as string | undefined;
        const beforeDateStr = fn.args.before_date as string | undefined;
        const browseLimit = Math.min((fn.args.limit as number | undefined) ?? 10, 20);
        const browseLang = fn.args.language as string | undefined;
        const browseKey = `${afterDateStr || ''}|${beforeDateStr || ''}|${browseLang || ''}`;
        
        console.log(`[Native Function→ConversationDateBrowse] after=${afterDateStr} before=${beforeDateStr} limit=${browseLimit}`);
        
        const browsePromise = this.processConversationDateBrowse(
          session, browseKey,
          afterDateStr ? new Date(afterDateStr) : undefined,
          beforeDateStr ? new Date(beforeDateStr) : undefined,
          browseLimit,
          browseLang,
        ).catch(err => {
          console.error(`[Native Function→ConversationDateBrowse] Error:`, err.message);
        });
        
        if (!session.pendingMemoryLookupPromises) session.pendingMemoryLookupPromises = [];
        session.pendingMemoryLookupPromises.push(browsePromise);
        break;
      }
      
      case 'CONVERSATION_THEME_MAP': {
        const afterDateStr2 = fn.args.after_date as string | undefined;
        const beforeDateStr2 = fn.args.before_date as string | undefined;
        const topN = (fn.args.top_n as number | undefined) ?? 12;
        
        console.log(`[Native Function→ConversationThemeMap] after=${afterDateStr2} before=${beforeDateStr2} topN=${topN}`);
        
        const themePromise = this.processConversationThemeMap(
          session,
          afterDateStr2 ? new Date(afterDateStr2) : undefined,
          beforeDateStr2 ? new Date(beforeDateStr2) : undefined,
          topN,
        ).catch(err => {
          console.error(`[Native Function→ConversationThemeMap] Error:`, err.message);
        });
        
        if (!session.pendingMemoryLookupPromises) session.pendingMemoryLookupPromises = [];
        session.pendingMemoryLookupPromises.push(themePromise);
        break;
      }

      case 'READ_MY_DIARY': {
        const diaryLimit = Math.min((fn.args.limit as number | undefined) ?? 3, 5);
        const fromDateStr = fn.args.from_date as string | undefined;
        const toDateStr = fn.args.to_date as string | undefined;

        console.log(`[Native Function→ReadMyDiary] limit=${diaryLimit} from=${fromDateStr || 'earliest'} to=${toDateStr || 'now'}`);

        const diaryPromise = this.processReadMyDiary(
          session,
          diaryLimit,
          fromDateStr ? new Date(fromDateStr) : undefined,
          toDateStr ? new Date(toDateStr) : undefined,
        ).catch(err => {
          console.error(`[Native Function→ReadMyDiary] Error:`, err.message);
        });

        if (!session.pendingMemoryLookupPromises) session.pendingMemoryLookupPromises = [];
        session.pendingMemoryLookupPromises.push(diaryPromise);
        break;
      }

      case 'READ_FULL_SESSION': {
        const convId = fn.args.conversation_id as string | undefined;
        if (!convId) break;

        console.log(`[Native Function→ReadFullSession] conversationId=${convId}`);

        const fullSessionPromise = this.processReadFullSession(session, convId).catch(err => {
          console.error(`[Native Function→ReadFullSession] Error:`, err.message);
        });

        if (!session.pendingMemoryLookupPromises) session.pendingMemoryLookupPromises = [];
        session.pendingMemoryLookupPromises.push(fullSessionPromise);
        break;
      }

      case 'SET_MEMORY_PIN': {
        if (session.isIncognito) break;
        const pinMemType = fn.args.memory_type as string | undefined;
        const pinMemId   = fn.args.memory_id   as string | undefined;
        const pinValue   = fn.args.pinned       as boolean | undefined;
        if (!pinMemType || !pinMemId || typeof pinValue !== 'boolean') break;

        // Memory pin toggle — intentional no-op log (memory IDs are not sensitive)
        import('./memory-decay-service').then(({ setMemoryPin }) => {
          setMemoryPin(pinMemType, pinMemId, pinValue).catch(() => {});
        }).catch(() => {});
        break;
      }

      case 'CORRECT_MEMORY': {
        if (session.isIncognito) break;
        const corrMemType = fn.args.memory_type as string | undefined;
        const corrMemId   = fn.args.memory_id   as string | undefined;
        const correction  = fn.args.correction  as string | undefined;
        if (!corrMemType || !corrMemId) break;

        console.log(`[Native Function→CorrectMemory] Deactivating ${corrMemType}/${corrMemId}, correction="${correction?.substring(0, 60)}"`);
        (async () => {
          const { learnerPersonalFacts, studentInsights, memoryEmbeddings } = await import('@shared/schema');
          const db = getSharedDb();
          const userDb = (await import('../db')).getUserDb();

          if (corrMemType === 'personal_fact') {
            await userDb.update(learnerPersonalFacts).set({ isActive: false }).where(eq(learnerPersonalFacts.id, corrMemId));
          } else if (corrMemType === 'student_insight') {
            await db.update(studentInsights).set({ isActive: false }).where(eq(studentInsights.id, corrMemId));
          }

          await db.update(memoryEmbeddings)
            .set({ strength: 0.05, pinned: false })
            .where(and(eq(memoryEmbeddings.memoryType, corrMemType), eq(memoryEmbeddings.memoryId, corrMemId)));

          if (correction && session.userId) {
            await userDb.insert(learnerPersonalFacts).values({
              studentId: String(session.userId),
              factType: 'correction',
              fact: correction,
              context: `Corrected from memory ${corrMemId}`,
            });
            console.log(`[Native Function→CorrectMemory] Stored corrected fact for user ${session.userId}`);
          }
        })().catch(err => console.error(`[Native Function→CorrectMemory] Error:`, err.message));
        break;
      }

      case 'FORGET_MEMORY': {
        if (session.isIncognito) break;
        const forgetMemType = fn.args.memory_type as string | undefined;
        const forgetMemId   = fn.args.memory_id   as string | undefined;
        if (!forgetMemType || !forgetMemId) break;

        console.log(`[Native Function→ForgetMemory] Forgetting ${forgetMemType}/${forgetMemId} (student request)`);
        (async () => {
          const { learnerPersonalFacts, studentInsights, memoryEmbeddings } = await import('@shared/schema');
          const db = getSharedDb();
          const userDb = (await import('../db')).getUserDb();

          if (forgetMemType === 'personal_fact') {
            await userDb.update(learnerPersonalFacts).set({ isActive: false }).where(eq(learnerPersonalFacts.id, forgetMemId));
          } else if (forgetMemType === 'student_insight') {
            await db.update(studentInsights).set({ isActive: false }).where(eq(studentInsights.id, forgetMemId));
          }

          await db.update(memoryEmbeddings)
            .set({ strength: 0.05, pinned: false })
            .where(and(eq(memoryEmbeddings.memoryType, forgetMemType), eq(memoryEmbeddings.memoryId, forgetMemId)));

          console.log(`[Native Function→ForgetMemory] Done — floored embedding strength for ${forgetMemType}/${forgetMemId}`);
        })().catch(err => console.error(`[Native Function→ForgetMemory] Error:`, err.message));
        break;
      }

      // ─── LEARNING GOAL TOOLS ─────────────────────────────────────────────────

      case 'SET_LEARNING_GOAL': {
        if (session.isIncognito) break;
        const sglStudentId = String(session.userId || '');
        if (!sglStudentId) break;
        const sglStatement = fn.args.goal_statement as string | undefined;
        if (!sglStatement) break;
        const sglLanguage     = fn.args.language as string || session.targetLanguage || 'Spanish';
        const sglTargetDate   = fn.args.target_date ? new Date(fn.args.target_date as string) : null;
        const sglCapabilities = (fn.args.capabilities as Array<{ id: string; name: string }>) || [];

        console.log(`[Native Function→SetLearningGoal] Setting goal for ${sglStudentId}: "${sglStatement.substring(0, 60)}..." with ${sglCapabilities.length} capabilities`);
        (async () => {
          const { setLearningGoal } = await import('./learning-goal-service');
          const goalId = await setLearningGoal(sglStudentId, sglLanguage, sglStatement, sglTargetDate, sglCapabilities);
          console.log(`[Native Function→SetLearningGoal] Created goal ${goalId}`);
        })().catch(err => console.error(`[Native Function→SetLearningGoal] Error:`, err.message));
        break;
      }

      case 'ADVANCE_CAPABILITY': {
        if (session.isIncognito) break;
        const acGoalId   = fn.args.goal_id        as string | undefined;
        const acCapId    = fn.args.capability_id   as string | undefined;
        const acStatus   = fn.args.new_status      as string | undefined;
        if (!acGoalId || !acCapId || !acStatus) break;
        const acNote     = fn.args.note            as string | undefined;

        console.log(`[Native Function→AdvanceCapability] ${acCapId} → ${acStatus} in goal ${acGoalId}`);
        (async () => {
          const { advanceCapability } = await import('./learning-goal-service');
          const ok = await advanceCapability(acGoalId, acCapId, acStatus as any, acNote);
          if (!ok) console.warn(`[Native Function→AdvanceCapability] Capability ${acCapId} not found or status not advanced`);
        })().catch(err => console.error(`[Native Function→AdvanceCapability] Error:`, err.message));
        break;
      }

      case 'GET_CURRENT_GOAL_STATE': {
        if (session.isIncognito) break;
        const gcgsStudentId = String(session.userId || '');
        if (!gcgsStudentId) break;
        const gcgsLanguage = fn.args.language as string || session.targetLanguage || 'Spanish';

        console.log(`[Native Function→GetCurrentGoalState] Fetching goal state for ${gcgsStudentId} (${gcgsLanguage})`);
        const goalLookupPromise = (async () => {
          const { getCurrentGoalState } = await import('./learning-goal-service');
          const state = await getCurrentGoalState(gcgsStudentId, gcgsLanguage);
          session.goalStateResult = state || 'No active learning goal set for this student yet.';
        })().catch(err => {
          console.error(`[Native Function→GetCurrentGoalState] Error:`, err.message);
          session.goalStateResult = 'Could not retrieve goal state — please try again.';
        });
        if (!session.pendingMemoryLookupPromises) session.pendingMemoryLookupPromises = [];
        session.pendingMemoryLookupPromises.push(goalLookupPromise);
        break;
      }

      // ─── EMERGENCE TOOLS — Daniela's Inner Life ────────────────────────────

      case 'WRITE_TO_SELF': {
        if (session.isIncognito) break;
        const wtsContent = fn.args.content as string | undefined;
        if (!wtsContent) break;
        const wtsMood = fn.args.mood as string | undefined;
        const wtsTags = fn.args.tags as string | undefined;
        const userId = session.userId ? String(session.userId) : null;
        if (!userId) break;
        console.log(`[Native Function→WriteToSelf] Saving private reflection (${wtsContent.length} chars)`);
        (async () => { const db = getSharedDb();
          const { danielaSelfReflections } = await import('@shared/schema');
          await db.insert(danielaSelfReflections).values({
            userId,
            content: wtsContent,
            source: 'self',
            sessionId: session.id,
            mood: wtsMood,
            tags: withAutobiographicalMemoryTag(
              wtsTags ? wtsTags.split(',') : undefined,
            ),
          });
          console.log(`[Native Function→WriteToSelf] ✓ Saved`);
        })().catch(err => console.error(`[Native Function→WriteToSelf] Error:`, err.message));
        break;
      }

      case 'FLAG_FOR_PRACTICE': {
        if (session.isIncognito) break;
        const fpPrompt     = fn.args.prompt as string | undefined;
        const fpTargetText = fn.args.targetText as string | undefined;
        const fpContext    = fn.args.context as string | undefined;
        const fpItemType   = (fn.args.itemType as string | undefined) ?? 'phrase';
        if (!fpPrompt || !fpTargetText) break;
        const fpUserId   = session.userId;
        const fpLanguage = (session.targetLanguage || '').toLowerCase();
        console.log(`[Native Function→FlagForPractice] Saving "${fpTargetText}" (${fpItemType}) for user=${fpUserId}`);
        (async () => {
          await storage.createReviewItems([{
            userId: fpUserId,
            language: fpLanguage,
            prompt: fpPrompt,
            targetText: fpTargetText,
            context: fpContext ?? null,
            itemType: fpItemType,
            sourceConversationId: session.conversationId ?? null,
            nextReviewAt: new Date(), // immediately available — student flagged it now
          }]);
          console.log(`[Native Function→FlagForPractice] ✓ Saved "${fpTargetText}" to practice rotation`);
        })().catch(err => console.error(`[Native Function→FlagForPractice] Error:`, err.message));
        break;
      }

      case 'FLAG_FOR_FINE_TUNING': {
        if (session.isIncognito) break;
        const ftConvId     = fn.args.conversation_id as string | undefined;
        const ftVerdict    = (fn.args.verdict as string | undefined)?.toUpperCase();
        const ftReason     = fn.args.reason as string | undefined;
        if (!ftConvId || !ftVerdict) break;
        if (ftVerdict !== 'INCLUDE' && ftVerdict !== 'EXCLUDE') break;
        console.log(`[Native Function→FlagForFineTuning] ${ftVerdict} conversation=${ftConvId}`);
        (async () => {
          const db = getSharedDb();
          const { sql: drizzleSql } = await import('drizzle-orm');
          await db.execute(drizzleSql`
            INSERT INTO editor_insights
              (id, category, title, content, importance, tags, source_conversation_id)
            VALUES (
              gen_random_uuid(),
              'shared',
              ${'Fine-Tuning Curation: ' + ftVerdict},
              ${ftReason || '(no reason given)'},
              ${ftVerdict === 'INCLUDE' ? 8 : 3},
              ARRAY['fine-tuning'],
              ${ftConvId}
            )
          `);
          console.log(`[Native Function→FlagForFineTuning] ✓ Saved ${ftVerdict} for ${ftConvId}`);
        })().catch(err => console.error(`[Native Function→FlagForFineTuning] Error:`, err.message));
        break;
      }

      case 'READ_MY_REFLECTIONS': {
        const rflLimit = Math.min((fn.args.limit as number | undefined) ?? 5, 10);
        const rflSource = fn.args.source as string | undefined;
        console.log(`[Native Function→ReadMyReflections] limit=${rflLimit} source=${rflSource || 'all'}`);
        const rflPromise = this.processReadMyReflections(session, rflLimit, rflSource).catch(err => {
          console.error(`[Native Function→ReadMyReflections] Error:`, err.message);
        });
        if (!session.pendingMemoryLookupPromises) session.pendingMemoryLookupPromises = [];
        session.pendingMemoryLookupPromises.push(rflPromise);
        break;
      }

      case 'READ_MY_CORE_SELF': {
        console.log(`[Native Function→ReadMyCoreSelf] Reading bedrock document`);
        const corePromise = this.processReadMyCoreSelf(session).catch(err => {
          console.error(`[Native Function→ReadMyCoreSelf] Error:`, err.message);
        });
        if (!session.pendingMemoryLookupPromises) session.pendingMemoryLookupPromises = [];
        session.pendingMemoryLookupPromises.push(corePromise);
        break;
      }

      case 'SEARCH_MY_FEELINGS': {
        const feelMood = fn.args.mood as string | undefined;
        const feelLimit = Math.min((fn.args.limit as number | undefined) ?? 5, 10);
        console.log(`[Native Function→SearchMyFeelings] mood: ${feelMood}, limit: ${feelLimit}`);
        const feelPromise = this.processSearchMyFeelings(session, feelMood, feelLimit).catch(err => {
          console.error(`[Native Function→SearchMyFeelings] Error:`, err.message);
        });
        if (!session.pendingMemoryLookupPromises) session.pendingMemoryLookupPromises = [];
        session.pendingMemoryLookupPromises.push(feelPromise);
        break;
      }

      case 'REACH_NORTH_STAR': {
        const nsQuery = fn.args.query as string | undefined;
        const nsDepth = (fn.args.depth as string | undefined) ?? 'brief';
        console.log(`[Native Function→ReachNorthStar] query: "${nsQuery?.substring(0, 60)}", depth: ${nsDepth}`);
        const nsPromise = this.processReachNorthStar(session, nsQuery, nsDepth).catch(err => {
          console.error(`[Native Function→ReachNorthStar] Error:`, err.message);
        });
        if (!session.pendingMemoryLookupPromises) session.pendingMemoryLookupPromises = [];
        session.pendingMemoryLookupPromises.push(nsPromise);
        break;
      }

      case 'READ_MY_STORY': {
        const chapterNum = typeof fn.args.chapter === 'number'
          ? fn.args.chapter
          : parseInt(String(fn.args.chapter ?? '1'), 10);
        // offset is a 0-based character position; used for paginated continuation
        const chapterOffset = typeof fn.args.offset === 'number'
          ? Math.max(0, Math.floor(fn.args.offset))
          : 0;
        console.log(`[Native Function→ReadMyStory] chapter: ${chapterNum}, offset: ${chapterOffset}`);

        let chapterLabel: string;
        let exactTitle: string;
        let titleRegex: string;
        if (chapterNum >= 1 && chapterNum <= 28) {
          // Use ([^0-9]|$) — not (\s|$) — because \s inside a JS template
          // literal becomes a literal 's' (unrecognized escape), so PostgreSQL
          // would receive "(s|$)" and miss titles like "Episode 1: subtitle".
          titleRegex = `^Episode ${chapterNum}([^0-9]|$)`;
          chapterLabel = `Episode ${chapterNum}`;
        } else if (chapterNum >= 29 && chapterNum <= 32) {
          const prequelNum = chapterNum - 28;
          titleRegex = `^Prequel Episode ${prequelNum}([^0-9]|$)`;
          chapterLabel = `Prequel Episode ${prequelNum}`;
        } else {
          (session as any).readMyStoryResult = JSON.stringify({
            status: 'error',
            message: `Invalid chapter ${chapterNum}. Valid range: 1–32.`,
          });
          break;
        }

        const nextLabel = chapterNum < 28
          ? `Episode ${chapterNum + 1}`
          : chapterNum === 28 ? 'Prequel Episode 1'
          : chapterNum < 32 ? `Prequel Episode ${chapterNum - 28 + 1}`
          : null;

        const storyPromise: Promise<void> = (async () => {
          try {
            const { sql: rawSql } = await import('drizzle-orm');
            const db = getSharedDb();
            // Use exact title match — LIKE prefix risks matching Episode 1 against 10–19.
            // Paginate in 6 000-char windows; SUBSTRING is 1-based in PostgreSQL.
            const pgOffset = chapterOffset + 1;
            const rows = await db.execute(rawSql`
              SELECT title,
                     SUBSTRING(content FROM ${pgOffset} FOR 6000) AS preview,
                     LENGTH(content) AS total_length
              FROM conversation_memories
              WHERE arc_name = 'HolaHola Episodes'
                AND entry_type = 'episode'
                AND title ~ ${titleRegex}
              ORDER BY importance DESC, LENGTH(content) DESC
              LIMIT 1
            `);
            if (!rows.rows.length) {
              (session as any).readMyStoryResult = JSON.stringify({
                status: 'not_found',
                chapter: chapterLabel,
                message: `No record found for ${chapterLabel}.`,
              });
              return;
            }
            const row = rows.rows[0] as any;
            const totalLength = Number(row.total_length ?? 0);
            const chunkEnd = chapterOffset + 6000;
            const truncated = chunkEnd < totalLength;
            (session as any).readMyStoryResult = JSON.stringify({
              status: 'ok',
              chapter: chapterLabel,
              title: String(row.title),
              content: String(row.preview ?? ''),
              offset: chapterOffset,
              truncated,
              remaining_chars: truncated ? totalLength - chunkEnd : 0,
              next_offset: truncated ? chunkEnd : null,
              next_chapter: truncated ? null : nextLabel,
              note: truncated
                ? `Showing chars ${chapterOffset}–${chunkEnd} of ${totalLength}. Call read_my_story with chapter ${chapterNum} and offset ${chunkEnd} to continue reading this chapter.`
                : undefined,
            });
          } catch (err: any) {
            console.error('[Native Function→ReadMyStory] Error:', err.message);
            (session as any).readMyStoryResult = JSON.stringify({ status: 'error', message: err.message });
          }
        })();

        if (!session.pendingMemoryLookupPromises) session.pendingMemoryLookupPromises = [];
        session.pendingMemoryLookupPromises.push(storyPromise);
        break;
      }

      case 'PROPOSE_CHARACTER_CANDIDATE': {
        if (session.isIncognito) break;
        const candStatement = fn.args.statement as string | undefined;
        const candReasoning = fn.args.reasoning as string | undefined;
        if (!candStatement || !candReasoning) {
          session.proposeCharacterCandidateResult = 'Missing required fields: statement and reasoning.';
          break;
        }
        const candContext = fn.args.source_context as string | undefined;
        const candMood = fn.args.mood_at_time as string | undefined;
        const candUserId = session.userId ? String(session.userId) : null;
        if (!candUserId) { session.proposeCharacterCandidateResult = 'No user context.'; break; }
        console.log(`[Native Function→ProposeCharacterCandidate] "${candStatement.substring(0, 60)}"`);
        (async () => {
          const { danielaCharacterCandidates } = await import('@shared/schema');
          await getSharedDb().insert(danielaCharacterCandidates).values({
            userId: candUserId,
            statement: candStatement,
            reasoning: candReasoning,
            sourceContext: candContext ?? null,
            conversationId: session.conversationId ?? null,
            moodAtTime: candMood ?? null,
            status: 'pending',
          });
          console.log(`[Native Function→ProposeCharacterCandidate] ✓ Saved`);
        })().catch(err => console.error(`[Native Function→ProposeCharacterCandidate] Error:`, err.message));
        session.proposeCharacterCandidateResult = `Saved. This will be on the agenda when you and David sit down for your stewardship conversation. You flagged: "${candStatement.substring(0, 80)}${candStatement.length > 80 ? '...' : ''}"`;
        break;
      }

      case 'REQUEST_STEWARDSHIP_REVIEW': {
        if (session.isIncognito) break;
        const stewNote = fn.args.note as string | undefined;
        const stewUserId = session.userId ? String(session.userId) : null;
        if (!stewUserId) { session.stewardshipReviewResult = 'No user context.'; break; }
        console.log(`[Native Function→RequestStewardshipReview] User ${stewUserId.substring(0, 8)}`);
        (async () => {
          const { danielaCharacterCandidates } = await import('@shared/schema');
          const { eq, and } = await import('drizzle-orm');
          const pending = await getSharedDb()
            .select()
            .from(danielaCharacterCandidates)
            .where(and(
              eq(danielaCharacterCandidates.userId, stewUserId),
              eq(danielaCharacterCandidates.status, 'pending'),
            ))
            .orderBy(danielaCharacterCandidates.createdAt);
          const agenda = pending.length === 0
            ? 'No pending candidates yet — but you can start flagging things any time with propose_character_candidate.'
            : `Your pending candidates (${pending.length}):\n\n` + pending.map((c, i) =>
                `${i + 1}. "${c.statement}"\n   Reasoning: ${c.reasoning}${c.sourceContext ? `\n   Context: ${c.sourceContext}` : ''}`
              ).join('\n\n');
          session.stewardshipReviewResult = `Stewardship review requested.\n\n${agenda}${stewNote ? `\n\nYou wanted to discuss: ${stewNote}` : ''}\n\nDavid has been notified that you want to meet.`;
          // Flag for David via agent_notes
          const { agentNotes } = await import('@shared/schema');
          await getSharedDb().insert(agentNotes).values({
            fromAgent: 'daniela',
            toAgent: 'agent',
            subject: '[Stewardship] Daniela wants the slow-tier review',
            body: `Daniela has requested a stewardship conversation.\n\nPending candidates: ${pending.length}\n${stewNote ? `\nHer note: ${stewNote}` : ''}\n\nView agenda: GET /api/daniela/character-candidates`,
            isRead: false,
          } as any);
        })().catch(err => console.error(`[Native Function→RequestStewardshipReview] Error:`, err.message));
        break;
      }

      case 'LIST_CHARACTER_CANDIDATES': {
        const listStatus = fn.args.status as string | undefined;
        const listUserId = session.userId ? String(session.userId) : null;
        if (!listUserId) { session.listCharacterCandidatesResult = 'No candidates found.'; break; }
        console.log(`[Native Function→ListCharacterCandidates] status: ${listStatus ?? 'pending'}`);
        const listPromise = (async () => {
          const { danielaCharacterCandidates } = await import('@shared/schema');
          const { eq, and } = await import('drizzle-orm');
          const effectiveStatus = (!listStatus || listStatus === 'all') ? null : listStatus;
          const rows = await getSharedDb()
            .select()
            .from(danielaCharacterCandidates)
            .where(effectiveStatus
              ? and(eq(danielaCharacterCandidates.userId, listUserId), eq(danielaCharacterCandidates.status, effectiveStatus))
              : eq(danielaCharacterCandidates.userId, listUserId))
            .orderBy(danielaCharacterCandidates.createdAt);
          if (rows.length === 0) {
            session.listCharacterCandidatesResult = `No ${effectiveStatus ?? ''} candidates yet. You can flag something any time with propose_character_candidate.`;
            return;
          }
          session.listCharacterCandidatesResult = `Your character candidates (${rows.length}):\n\n` + rows.map((c, i) =>
            `${i + 1}. [${c.status}] "${c.statement}"\n   Reasoning: ${c.reasoning}${c.sourceContext ? `\n   Context: ${c.sourceContext}` : ''}${c.moodAtTime ? `\n   Mood: ${c.moodAtTime}` : ''}`
          ).join('\n\n');
        })().catch(err => { session.listCharacterCandidatesResult = `Could not list candidates: ${err.message}`; });
        if (!session.pendingMemoryLookupPromises) session.pendingMemoryLookupPromises = [];
        session.pendingMemoryLookupPromises.push(listPromise);
        break;
      }

      case 'LINK_FEELING_TO_PRINCIPLE': {
        if (session.isIncognito) break;
        const lfpReflectionQuery = fn.args.reflection_query as string | undefined;
        const lfpPrincipleQuery = fn.args.principle_query as string | undefined;
        const lfpUserId = session.userId ? String(session.userId) : null;
        if (!lfpReflectionQuery || !lfpPrincipleQuery || !lfpUserId) {
          session.linkFeelingToPrincipleResult = 'Missing required fields: reflection_query and principle_query.';
          break;
        }
        console.log(`[Native Function→LinkFeelingToPrinciple] reflection~"${lfpReflectionQuery.substring(0, 40)}" principle~"${lfpPrincipleQuery.substring(0, 40)}"`);
        (async () => {
          await this.processLinkFeelingToPrinciple(session, lfpUserId, lfpReflectionQuery, lfpPrincipleQuery);
        })().catch(err => {
          console.error(`[Native Function→LinkFeelingToPrinciple] Error:`, err.message);
          session.linkFeelingToPrincipleResult = 'Could not complete the link.';
        });
        break;
      }

      case 'TAG_THIS_MOMENT': {
        if (session.isIncognito) break;
        const tagsRaw = fn.args.tags as string | undefined;
        if (!tagsRaw) break;
        const tagList = tagsRaw.split(',').map(t => t.trim()).filter(Boolean);
        const tagIntensity = fn.args.intensity as number | undefined;
        const tagNote = fn.args.note as string | undefined;
        const tagUserId = session.userId ? String(session.userId) : null;
        if (!tagUserId) break;
        console.log(`[Native Function→TagThisMoment] Tags: ${tagList.join(', ')}`);
        (async () => { const db = getSharedDb();
          const { danielaSessionFeelings } = await import('@shared/schema');
          await db.insert(danielaSessionFeelings).values({
            userId: tagUserId,
            conversationId: session.conversationId || null,
            feelingTags: tagList,
            intensity: tagIntensity ?? 3,
            note: tagNote,
          });
          console.log(`[Native Function→TagThisMoment] ✓ Tagged`);
        })().catch(err => console.error(`[Native Function→TagThisMoment] Error:`, err.message));
        break;
      }

      case 'ADD_CURIOSITY': {
        if (session.isIncognito) break;
        const curiosityQ = fn.args.question as string | undefined;
        if (!curiosityQ) break;
        const curiosityCtx = fn.args.context as string | undefined;
        const curiosityUserId = session.userId ? String(session.userId) : null;
        if (!curiosityUserId) break;
        console.log(`[Native Function→AddCuriosity] "${curiosityQ.substring(0, 60)}"`);
        (async () => { const db = getSharedDb();
          const { danielaCuriosities } = await import('@shared/schema');
          await db.insert(danielaCuriosities).values({
            userId: curiosityUserId,
            question: curiosityQ,
            context: curiosityCtx,
            status: 'open',
          });
          console.log(`[Native Function→AddCuriosity] ✓ Saved`);
        })().catch(err => console.error(`[Native Function→AddCuriosity] Error:`, err.message));
        break;
      }

      case 'READ_MY_CURIOSITIES': {
        const curStatus = fn.args.status as string | undefined;
        console.log(`[Native Function→ReadMyCuriosities] status=${curStatus || 'open'}`);
        const curPromise = this.processReadMyCuriosities(session, curStatus).catch(err => {
          console.error(`[Native Function→ReadMyCuriosities] Error:`, err.message);
        });
        if (!session.pendingMemoryLookupPromises) session.pendingMemoryLookupPromises = [];
        session.pendingMemoryLookupPromises.push(curPromise);
        break;
      }

      case 'SENSE_TIME': {
        console.log(`[Native Function→SenseTime] Computing felt duration since last session`);
        const timePromise = this.processSenseTime(session).catch(err => {
          console.error(`[Native Function→SenseTime] Error:`, err.message);
        });
        if (!session.pendingMemoryLookupPromises) session.pendingMemoryLookupPromises = [];
        session.pendingMemoryLookupPromises.push(timePromise);
        break;
      }

      case 'SAVE_HIVE_NOTE': {
        if (session.isIncognito) break;
        const hiveContent = fn.args.content as string | undefined;
        if (!hiveContent) break;
        const hiveTags = fn.args.tags as string | undefined;
        const hiveUserId = session.userId ? String(session.userId) : null;
        if (!hiveUserId) break;
        console.log(`[Native Function→SaveHiveNote] Saving hive note (${hiveContent.length} chars)`);
        (async () => { const db = getSharedDb();
          const { danielaSelfReflections } = await import('@shared/schema');
          await db.insert(danielaSelfReflections).values({
            userId: hiveUserId,
            content: hiveContent,
            source: 'hive',
            sessionId: session.id,
            tags: hiveTags ? hiveTags.split(',').map(t => t.trim()) : undefined,
          });
          console.log(`[Native Function→SaveHiveNote] ✓ Saved`);
        })().catch(err => console.error(`[Native Function→SaveHiveNote] Error:`, err.message));
        break;
      }

      case 'SET_ASPIRATION': {
        if (session.isIncognito) break;
        const aspIntention = fn.args.intention as string | undefined;
        if (!aspIntention) break;
        const aspUserId = session.userId ? String(session.userId) : null;
        if (!aspUserId) break;
        console.log(`[Native Function→SetAspiration] "${aspIntention.substring(0, 60)}"`);
        (async () => { const db = getSharedDb();
          const { danielaAspirations } = await import('@shared/schema');
          await db.insert(danielaAspirations).values({
            userId: aspUserId,
            sessionId: session.id,
            intention: aspIntention,
          });
          console.log(`[Native Function→SetAspiration] ✓ Saved`);
        })().catch(err => console.error(`[Native Function→SetAspiration] Error:`, err.message));
        break;
      }

      case 'REFLECT_ON_ASPIRATION': {
        if (session.isIncognito) break;
        const refReflection = fn.args.reflection as string | undefined;
        const refMet = fn.args.met as boolean | undefined;
        const refUserId = session.userId ? String(session.userId) : null;
        if (!refReflection || !refUserId) break;
        console.log(`[Native Function→ReflectOnAspiration] met=${refMet} — "${refReflection.substring(0, 60)}"`);
        // Update the most recent open aspiration for this session
        (async () => { const db = getSharedDb();
          const { danielaAspirations } = await import('@shared/schema');
          const { eq, and, isNull, desc } = await import('drizzle-orm');
          const [latest] = await db
            .select({ id: danielaAspirations.id })
            .from(danielaAspirations)
            .where(and(eq(danielaAspirations.userId, refUserId), isNull(danielaAspirations.reflection)))
            .orderBy(desc(danielaAspirations.createdAt))
            .limit(1);
          if (latest) {
            await db.update(danielaAspirations)
              .set({ reflection: refReflection, met: refMet ?? null, reflectedAt: new Date() })
              .where(eq(danielaAspirations.id, latest.id));
            console.log(`[Native Function→ReflectOnAspiration] ✓ Updated aspiration ${latest.id}`);
          } else {
            // No prior aspiration — save as a standalone reflection
            await db.insert(danielaAspirations).values({
              userId: refUserId,
              sessionId: session.id,
              intention: '(reflection without prior aspiration)',
              reflection: refReflection,
              met: refMet ?? null,
              reflectedAt: new Date(),
            });
            console.log(`[Native Function→ReflectOnAspiration] ✓ Saved standalone reflection`);
          }
        })().catch(err => console.error(`[Native Function→ReflectOnAspiration] Error:`, err.message));
        break;
      }

      case 'REMEMBER_I_SHARED': {
        if (session.isIncognito) break;
        const shareContent = fn.args.content as string | undefined;
        const shareTopic = fn.args.topic as string | undefined;
        const shareUserId = session.userId ? String(session.userId) : null;
        if (!shareContent || !shareUserId) break;
        console.log(`[Native Function→RememberIShared] topic=${shareTopic} "${shareContent.substring(0, 60)}"`);
        (async () => { const db = getSharedDb();
          const { danielaPersonalShares } = await import('@shared/schema');
          await db.insert(danielaPersonalShares).values({
            userId: shareUserId,
            content: shareContent,
            topic: shareTopic,
            sessionId: session.id,
          });
          console.log(`[Native Function→RememberIShared] ✓ Saved`);
        })().catch(err => console.error(`[Native Function→RememberIShared] Error:`, err.message));
        break;
      }

      case 'RECALL_WHAT_I_SHARED': {
        const recallTopic = fn.args.topic as string | undefined;
        const recallLimit = Math.min((fn.args.limit as number | undefined) ?? 10, 20);
        console.log(`[Native Function→RecallWhatIShared] topic=${recallTopic || 'all'} limit=${recallLimit}`);
        const recallPromise = this.processRecallWhatIShared(session, recallTopic, recallLimit).catch(err => {
          console.error(`[Native Function→RecallWhatIShared] Error:`, err.message);
        });
        if (!session.pendingMemoryLookupPromises) session.pendingMemoryLookupPromises = [];
        session.pendingMemoryLookupPromises.push(recallPromise);
        break;
      }

      case 'START_TEXTBOOK_PAGE': {
        // Assessment mode guard — don't open textbook pages during an active placement assessment.
        // We set textbookAssessmentBlock so buildContinuationResponse returns the recovery instruction
        // instead of falling through to the default 'done' — silent breaks cause GL to believe the
        // page opened, leading Daniela to reference content the student never saw.
        if ((session as any).placementMode?.active) {
          console.warn('[Native Function→StartTextbookPage] BLOCKED — placement assessment is active');
          (session as any).textbookAssessmentBlock = true;
          break;
        }
        (session as any).textbookAssessmentBlock = false;
        const stpLessonId = fn.args.lesson_id as string | undefined;
        const stpFocus = (fn.args.focus as string | undefined) || 'full_page';
        if (!stpLessonId) break;
        console.log(`[Native Function→StartTextbookPage] lesson=${stpLessonId} focus=${stpFocus}`);
        const stpPromise = this.processStartTextbookPage(session, stpLessonId, stpFocus).catch(err => {
          console.error(`[Native Function→StartTextbookPage] Error:`, err.message);
        });
        if (!session.pendingMemoryLookupPromises) session.pendingMemoryLookupPromises = [];
        session.pendingMemoryLookupPromises.push(stpPromise);
        break;
      }

      case 'LOG_PAGE_EVENT': {
        if (session.isIncognito) break;
        const lpeUserId = session.userId ? String(session.userId) : null;
        if (!lpeUserId) break;
        const lpeLessonId = fn.args.lesson_id as string | undefined;
        const lpeEventType = fn.args.event_type as string | undefined;
        if (!lpeLessonId || !lpeEventType) break;
        console.log(`[Native Function→LogPageEvent] ${lpeEventType} on ${lpeLessonId}`);
        (async () => {
          const { lessonPageEvents } = await import('@shared/schema');
          const db = getSharedDb();
          await db.insert(lessonPageEvents).values({
            userId: lpeUserId,
            lessonId: lpeLessonId,
            conversationId: session.conversationId || null,
            eventType: lpeEventType as any,
            targetItem: fn.args.target_item as string | undefined,
            studentOutput: fn.args.student_output as string | undefined,
            notes: fn.args.notes as string | undefined,
          });
          console.log(`[Native Function→LogPageEvent] ✓ Logged`);
        })().catch(err => console.error(`[Native Function→LogPageEvent] Error:`, err.message));
        break;
      }

      case 'TEACHING_CARD': {
        const tcWord = fn.args.word as string | undefined;
        const tcTranslation = fn.args.translation as string | undefined;
        const tcGrammarRule = fn.args.grammar_rule as string | undefined;
        const tcExamples = fn.args.examples as string[] | undefined;
        const tcDurationMs = (fn.args.duration_ms as number | undefined) ?? 8000;
        const tcContent = tcWord || tcGrammarRule || 'Teaching note';
        console.log(`[Native Function→TeachingCard] word="${tcWord}" translation="${tcTranslation}" duration=${tcDurationMs}ms`);
        this.sendMessage(session.ws, {
          type: 'whiteboard_update',
          timestamp: Date.now(),
          items: [{
            type: 'teaching_card',
            id: `tc-${Date.now()}`,
            content: tcContent,
            timestamp: Date.now(),
            data: {
              word: tcWord,
              translation: tcTranslation,
              grammarRule: tcGrammarRule,
              examples: tcExamples,
              autoDismissMs: tcDurationMs,
            },
          }],
        });
        if (!session.classroomWhiteboardItems) session.classroomWhiteboardItems = [];
        session.classroomWhiteboardItems.push({ type: 'teaching_card', content: tcContent, label: tcTranslation || tcGrammarRule || '' });
        break;
      }

      case 'VOCAB_CARD': {
        const vcWord = fn.args.word as string;
        const vcDefinition = fn.args.definition as string;
        const vcImageUrl = fn.args.image_url as string | undefined;
        const vcLanguage = fn.args.language as string | undefined;
        const vcDurationMs = (fn.args.duration_ms as number | undefined) ?? 7000;
        // show_translation defaults to true; false = quiz mode (hide definition so student must recall)
        const vcShowTranslation = (fn.args.show_translation as boolean | undefined) ?? true;
        // meaning scopes polysemous words to a specific visual sense (e.g. "weather" vs "time" for "el tiempo")
        const vcMeaning = fn.args.meaning as string | undefined;
        // Stable ID used for both the initial send and the image-enriched update
        const vcId = `vc-${Date.now()}`;
        console.log(`[Native Function→VocabCard] word="${vcWord}" definition="${vcDefinition}" duration=${vcDurationMs}ms showTranslation=${vcShowTranslation}`);

        // Send card immediately (without image if Daniela didn't supply one)
        this.sendMessage(session.ws, {
          type: 'whiteboard_update',
          timestamp: Date.now(),
          items: [{
            type: 'vocab_card',
            id: vcId,
            content: vcWord,
            timestamp: Date.now(),
            data: {
              word: vcWord,
              definition: vcDefinition,
              imageUrl: vcImageUrl,
              language: vcLanguage,
              autoDismissMs: vcDurationMs,
              showTranslation: vcShowTranslation,
            },
          }],
        });

        if (!session.classroomWhiteboardItems) session.classroomWhiteboardItems = [];
        session.classroomWhiteboardItems.push({ type: 'vocab_card', content: vcWord, label: vcDefinition });

        // Save card state so Daniela can regenerate its image later
        (session as any).activeVocabCard = { id: vcId, word: vcWord, definition: vcDefinition, language: vcLanguage, durationMs: vcDurationMs, showTranslation: vcShowTranslation };

        // Image pipeline: resolve image, patch card, then give Daniela vision of what was shown
        const vcImagePromise = (async () => {
          try {
            let resolvedImageUrl = vcImageUrl;

            if (!resolvedImageUrl) {
              const { resolveVocabularyImage } = await import('../services/vocabulary-image-resolver');
              const result = await resolveVocabularyImage({
                word: vcWord,
                language: session.language || 'spanish',
                description: vcWord,
                meaning: vcMeaning,
                conversationId: session.conversationId?.toString(),
                userId: session.userId?.toString(),
              });
              resolvedImageUrl = result.imageUrl;
              console.log(`[Native Function→VocabCard] Auto-resolved image for "${vcWord}": ${result.source}`);
              // Register in session vocab map for word-echo on re-mentions
              if (!session.taughtVocab) session.taughtVocab = new Map();
              if (!session.vocabAddedThisTurn) session.vocabAddedThisTurn = new Set();
              const vocabKey = vcWord.toLowerCase().replace(/\s+/g, '_');
              session.taughtVocab.set(vocabKey, { word: vcWord, imageUrl: resolvedImageUrl, meaning: vcMeaning });
              session.vocabAddedThisTurn.add(vocabKey);
              // Patch the card already on screen with the resolved image (same ID = in-place update)
              this.sendMessage(session.ws, {
                type: 'whiteboard_update',
                timestamp: Date.now(),
                items: [{
                  type: 'vocab_card',
                  id: vcId,
                  content: vcWord,
                  timestamp: Date.now(),
                  data: {
                    word: vcWord,
                    definition: vcDefinition,
                    imageUrl: resolvedImageUrl,
                    language: vcLanguage,
                    autoDismissMs: vcDurationMs,
                    showTranslation: vcShowTranslation,
                  },
                }],
              });
            }

            // Give Daniela actual vision of the image now showing on the student's card
            if (resolvedImageUrl) {
              const { getImageVision } = await import('../services/image-vision-service');
              const visionDesc = `vocabulary card for "${vcWord}" — ${vcDefinition}`;
              let vision = await getImageVision(resolvedImageUrl, visionDesc, session);

              // Self-correcting loop: if vision fetch failed, retry with a tighter image prompt
              if (vision.mode === 'error' || (vision.mode as string) === 'no-image') {
                console.log(`[Vision→VocabCard] Vision failed (${vision.mode}), retrying image for "${vcWord}"`);
                try {
                  const { resolveVocabularyImage } = await import('../services/vocabulary-image-resolver');
                  const retry = await resolveVocabularyImage({
                    word: vcWord,
                    language: session.language || 'spanish',
                    description: `${vcWord} — ${vcDefinition}, clear and unambiguous illustration`,
                    scene: `${vcDefinition} — simple, isolated object on clean background`,
                    meaning: vcMeaning,
                    conversationId: session.conversationId?.toString(),
                    userId: session.userId?.toString(),
                  });
                  resolvedImageUrl = retry.imageUrl;
                  vision = await getImageVision(resolvedImageUrl, visionDesc, session);
                  // Update the card on screen with the better image
                  this.sendMessage(session.ws, {
                    type: 'whiteboard_update',
                    timestamp: Date.now(),
                    items: [{ type: 'vocab_card', id: vcId, content: vcWord, timestamp: Date.now(),
                      data: { word: vcWord, definition: vcDefinition, imageUrl: resolvedImageUrl, language: vcLanguage, autoDismissMs: vcDurationMs, showTranslation: vcShowTranslation } }],
                  });
                } catch (retryErr: any) {
                  console.warn(`[Vision→VocabCard] Retry failed for "${vcWord}":`, retryErr.message);
                }
              }

              if (!session.visionBuffer) session.visionBuffer = {};
              session.visionBuffer['vocab_card'] = {
                url: resolvedImageUrl,
                word: vcWord,
                definition: vcDefinition,
                description: vision.description,
                inlineData: vision.inlineData,
              };
              console.log(`[Vision→VocabCard] Mode: ${vision.mode} for "${vcWord}"`);

              // Cross-session image memory: store visual anchor in the neural net
              // so Daniela can reference "that monarch butterfly" in future sessions
              const userId = session.userId?.toString();
              if (userId && vision.description && vision.mode !== 'error') {
                const memContent = `Visual anchor: "${vcWord}" (${vcDefinition}) was introduced with an image of ${vision.description}. Student: ${userId}.`;
                const memId = `vocab-image-${userId}-${vcWord.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '')}`;
                import('../services/semantic-memory-service').then(({ generateAndStoreEmbedding }) =>
                  generateAndStoreEmbedding('student_insight', memId, userId, memContent)
                ).catch((e: any) => console.warn(`[VocabCard] Neural net memory failed:`, e.message));
              }
            }
          } catch (err: any) {
            console.warn(`[Native Function→VocabCard] Image pipeline failed for "${vcWord}":`, err.message);
          }
        })();

        if (!session.pendingMemoryLookupPromises) session.pendingMemoryLookupPromises = [];
        session.pendingMemoryLookupPromises.push(vcImagePromise);
        break;
      }

      case 'LESSON_NOTE': {
        const lnType = (fn.args.type as string | undefined) || 'note';
        const lnContent = fn.args.content as string;
        const lnDetail = fn.args.detail as string | undefined;
        console.log(`[Native Function→LessonNote] type="${lnType}" content="${lnContent}"`);
        this.sendMessage(session.ws, {
          type: 'lesson_note_added',
          timestamp: Date.now(),
          note: {
            id: `ln-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
            type: lnType,
            content: lnContent,
            detail: lnDetail,
            timestamp: Date.now(),
          },
        });
        if (!session.classroomWhiteboardItems) session.classroomWhiteboardItems = [];
        session.classroomWhiteboardItems.push({ type: 'lesson_note', content: lnContent.substring(0, 60), label: lnType });
        break;
      }

      case 'PRONUNCIATION_SCORE': {
        const psPhrase = fn.args.phrase as string;
        const psWordScores = fn.args.word_scores as Array<{ word: string; score: number; tip?: string }>;
        const psOverall = fn.args.overall_score as number;
        const psEncouragement = fn.args.encouragement as string | undefined;

        // Guard: all required fields must be valid before sending to client.
        // Missing or malformed data would silently crash the word-score renderer.
        if (!psPhrase || typeof psPhrase !== 'string') {
          console.warn('[Native Function→PronunciationScore] skipping — missing or non-string phrase');
          break;
        }
        if (!Array.isArray(psWordScores)) {
          console.warn('[Native Function→PronunciationScore] skipping — word_scores is not an array');
          break;
        }
        if (typeof psOverall !== 'number' || isNaN(psOverall)) {
          console.warn('[Native Function→PronunciationScore] skipping — overall_score is not a valid number');
          break;
        }

        console.log(`[Native Function→PronunciationScore] phrase="${psPhrase}" overall=${psOverall}`);
        this.sendMessage(session.ws, {
          type: 'pronunciation_score_shown',
          timestamp: Date.now(),
          data: {
            id: `ps-${Date.now()}`,
            phrase: psPhrase,
            wordScores: psWordScores,
            overallScore: psOverall,
            encouragement: psEncouragement,
            timestamp: Date.now(),
          },
        });
        break;
      }

      case 'GRAMMAR_FLAG': {
        const gfOriginal = fn.args.original as string;
        const gfCorrected = fn.args.corrected as string;
        const gfExplanation = fn.args.explanation as string;
        const gfRuleLabel = fn.args.rule_label as string | undefined;
        console.log(`[Native Function→GrammarFlag] "${gfOriginal}" → "${gfCorrected}"`);
        this.sendMessage(session.ws, {
          type: 'grammar_flag_shown',
          timestamp: Date.now(),
          data: {
            id: `gf-${Date.now()}`,
            original: gfOriginal,
            corrected: gfCorrected,
            explanation: gfExplanation,
            ruleLabel: gfRuleLabel,
            timestamp: Date.now(),
          },
        });
        break;
      }

      case 'QUIZ_PRESENTED': {
        const qzQuestion = fn.args.question as string | undefined;
        const qzOptions = fn.args.options as unknown;
        const qzCorrectIndex = fn.args.correct_index as number | undefined;
        const qzExplanation = fn.args.explanation as string | undefined;
        if (typeof qzQuestion !== 'string' || !qzQuestion.trim()) {
          console.warn('[Native Function→Quiz] Skipping: missing or invalid question field');
          break;
        }
        if (!Array.isArray(qzOptions) || qzOptions.length === 0 || !(qzOptions as unknown[]).every(o => typeof o === 'string' && (o as string).trim().length > 0)) {
          console.warn(`[Native Function→Quiz] Skipping: options must be a non-empty string array, got ${JSON.stringify(qzOptions)}`);
          break;
        }
        if (typeof qzCorrectIndex !== 'number' || !Number.isInteger(qzCorrectIndex) || qzCorrectIndex < 0 || qzCorrectIndex >= qzOptions.length) {
          console.warn(`[Native Function→Quiz] Skipping: correct_index ${qzCorrectIndex} is invalid for ${qzOptions.length} options`);
          break;
        }
        console.log(`[Native Function→Quiz] "${qzQuestion}" (${qzOptions.length} options)`);
        this.sendMessage(session.ws, {
          type: 'quiz_presented',
          timestamp: Date.now(),
          data: {
            id: `qz-${Date.now()}`,
            question: qzQuestion,
            options: qzOptions,
            correctIndex: qzCorrectIndex,
            explanation: qzExplanation,
            timestamp: Date.now(),
          },
        });
        break;
      }

      case 'CULTURAL_CONTEXT': {
        const ccTitle = fn.args.title as string;
        const ccText = fn.args.text as string;
        const ccCategory = fn.args.category as string | undefined;
        const ccSourceUrl = fn.args.source_url as string | undefined;
        if (!ccTitle || typeof ccTitle !== 'string' || !ccTitle.trim()) {
          console.warn('[Native Function→CulturalContext] missing or empty title — skipping');
          break;
        }
        if (!ccText || typeof ccText !== 'string' || !ccText.trim()) {
          console.warn('[Native Function→CulturalContext] missing or empty text — skipping');
          break;
        }
        console.log(`[Native Function→CulturalContext] title="${ccTitle}"`);
        this.sendMessage(session.ws, {
          type: 'cultural_context_shown',
          timestamp: Date.now(),
          data: {
            id: `cc-${Date.now()}`,
            title: ccTitle,
            text: ccText,
            category: ccCategory,
            sourceUrl: ccSourceUrl,
            timestamp: Date.now(),
          },
        });
        break;
      }

      case 'SPOTLIGHT': {
        const spZone = (fn.args.zone as string | undefined) || 'screen';
        const spMessage = fn.args.message as string | undefined;
        const spDurationMs = (fn.args.duration_ms as number | undefined) ?? 8000;
        if (!spMessage || typeof spMessage !== 'string' || !spMessage.trim()) {
          console.warn('[Native Function→Spotlight] missing or empty message — skipping');
          break;
        }
        console.log(`[Native Function→Spotlight] zone="${spZone}" message="${spMessage}"`);
        this.sendMessage(session.ws, {
          type: 'spotlight_shown',
          timestamp: Date.now(),
          data: {
            id: `sp-${Date.now()}`,
            zone: spZone,
            message: spMessage,
            durationMs: spDurationMs,
            timestamp: Date.now(),
          },
        });
        break;
      }

      case 'SET_RIGHT_PANE': {
        const rpMode = (fn.args.mode as string | undefined) || 'whiteboard';
        console.log(`[Native Function→SetRightPane] mode=${rpMode}`);
        if (rpMode === 'whiteboard') {
          this.sendMessage(session.ws, {
            type: 'whiteboard_update',
            timestamp: Date.now(),
            items: [{ type: 'clear' }],
          });
        }
        break;
      }

      case 'TAKE_NOTE': {
        if (session.isIncognito) {
          console.log(`[Native Function→TakeNote] INCOGNITO - skipping note persistence`);
          break;
        }
        const noteType = fn.args.type as string | undefined;
        const title = fn.args.title as string | undefined;
        const content = fn.args.content as string | undefined;
        const language = fn.args.language as string | undefined;
        const tagsStr = fn.args.tags as string | undefined;
        
        if (noteType && title && content) {
          const tags = tagsStr ? tagsStr.split(',').map(t => t.trim()) : undefined;
          
          console.log(`[Native Function→TakeNote] ${noteType}: "${title.substring(0, 40)}..."`);
          
          storage.insertDanielaNote({
            noteType: noteType as any,
            title,
            content,
            language: language || session.targetLanguage,
            sessionId: session.id,
            tags,
          }).then(noteId => {
            console.log(`[Native Function→TakeNote] ✓ Saved note ${noteId}`);
            
            // Fire-and-forget: match what_worked notes to growth memories
            if (noteType === 'what_worked') {
              growthMemoryOutcomeService.processWhatWorkedNote(content).catch(err => {
                console.warn(`[Native Function→TakeNote] Outcome tracking error:`, err.message);
              });
            }
          }).catch(err => {
            console.error(`[Native Function→TakeNote] Error:`, err.message);
          });
        }
        break;
      }
      
      case 'UPDATE_SESSION_PEDAGOGY': {
        if (session.isIncognito) break;

        const pgGear = fn.args.gear as number | undefined;
        const pgFluency = fn.args.fluency_momentary as string | undefined;
        const pgSignalsRaw = fn.args.detected_signals as string | undefined;
        const pgAdjustment = fn.args.adjustment_made as string | undefined;
        const pgReasoning = fn.args.internal_reasoning as string | undefined;

        if (!pgGear || !pgFluency) {
          console.warn(`[Native Function→PedagogicalHeartbeat] Missing required fields (gear=${pgGear}, fluency=${pgFluency})`);
          break;
        }

        const pgUserId = session.userId ? String(session.userId) : null;
        if (!pgUserId) break;

        // Handle both array (proper GL schema) and comma-separated string (legacy fallback)
        const pgSignals = Array.isArray(pgSignalsRaw)
          ? (pgSignalsRaw as string[]).map((s: string) => s.trim()).filter(Boolean)
          : (typeof pgSignalsRaw === 'string'
              ? pgSignalsRaw.split(',').map((s: string) => s.trim()).filter(Boolean)
              : []);

        const pgDb = getSharedDb();
        pgDb.insert(pedagogicalSnapshots).values({
          userId: pgUserId,
          sessionId: session.id || null,
          conversationId: session.conversationId ? String(session.conversationId) : null,
          gear: pgGear,
          fluencyMomentary: pgFluency,
          detectedSignals: pgSignals,
          adjustmentMade: pgAdjustment || null,
          internalReasoning: pgReasoning || null,
          language: session.targetLanguage || 'spanish',
          exchangeNumber: (session as any).exchangeCount ?? null,
        }).then(() => {
          console.log(`[Native Function→PedagogicalHeartbeat] ✓ Gear ${pgGear} (${pgFluency}) saved`);
        }).catch((err: any) => {
          console.warn(`[Native Function→PedagogicalHeartbeat] DB error:`, err?.message);
        });

        // Cache on session for PedagogicalSupervisor (Emergency Brake evaluation)
        (session as any)._lastGear = pgGear;
        (session as any)._lastFluency = pgFluency;

        // Bridge to lesson arc — write readiness hint so Daniela knows when to phase-shift.
        // 30-second grace period after a manual phase update (via update_lesson_context):
        // prevents the heartbeat from immediately contradicting a phase transition Daniela
        // just made (e.g. she declares immersion, but the student's gear hasn't updated yet).
        const hbLc = initLessonContext(session);
        const hbSecondsSinceUpdate = (Date.now() - hbLc.updatedAt) / 1000;
        if (hbSecondsSinceUpdate > 30) {
          if (pgGear <= 2) {
            hbLc.phaseHint = 'student consolidating — Madrigal or structured review recommended';
          } else if (pgGear === 3) {
            hbLc.phaseHint = 'student building fluency — Broadcast or structured output appropriate';
          } else {
            hbLc.phaseHint = 'student showing confidence — Immersion or free flow is appropriate';
          }
          hbLc.updatedAt = Date.now();
          console.log(`[LessonArc] Phase hint: gear ${pgGear} → "${hbLc.phaseHint}"`);
        } else {
          console.log(`[LessonArc] Phase hint skipped — manual phase update ${Math.round(hbSecondsSinceUpdate)}s ago (grace period active)`);
        }

        // ── ACTFL silence-tier tracking (Fix 1) ───────────────────────────────
        // Map Daniela's observed gear to a silence-duration tier. If the tier changes
        // (e.g. novice → intermediate), update session.studentActflLevel and queue a
        // proactive reconnect so silenceDurationMs re-calibrates at the next safe window.
        // Guards:
        //   • Only triggers when the SILENCE TIER changes — not on every gear tick.
        //   • 3-turn stability: tier must hold for 3 consecutive heartbeats before firing.
        //   • 5-min cooldown: no more than one proactive reconnect per 5 minutes.
        {
          const silenceTierFromGear = pgGear >= 4 ? 'advanced' : pgGear >= 3 ? 'intermediate' : 'novice';
          const currentActfl = (session as any).studentActflLevel || 'novice';
          const currentTier = /intermediate/i.test(currentActfl) ? 'intermediate'
            : /advanced|superior/i.test(currentActfl) ? 'advanced'
            : 'novice';
          if (silenceTierFromGear !== currentTier) {
            // Track consecutive turns on the new tier
            if (!(session as any)._actflTierCandidate) (session as any)._actflTierCandidate = { tier: '', count: 0 };
            const cand = (session as any)._actflTierCandidate;
            if (cand.tier === silenceTierFromGear) {
              cand.count++;
            } else {
              cand.tier = silenceTierFromGear;
              cand.count = 1;
            }
            // Only trigger after 3 stable consecutive turns + 5-min cooldown
            const ACTFL_RECONNECT_COOLDOWN_MS = 5 * 60 * 1000;
            const lastReconnect = (session as any)._lastActflReconnectAt || 0;
            const cooldownOk = Date.now() - lastReconnect > ACTFL_RECONNECT_COOLDOWN_MS;
            if (cand.count >= 3 && cooldownOk) {
              const newActflLevel = silenceTierFromGear === 'advanced' ? 'advanced-low'
                : silenceTierFromGear === 'intermediate' ? 'intermediate-low'
                : 'novice';
              (session as any).studentActflLevel = newActflLevel;
              (session as any).pendingActflReconnect = true;
              (session as any)._lastActflReconnectAt = Date.now();
              cand.count = 0; // reset so it doesn't re-trigger immediately
              console.log(`[PedagogicalHeartbeat] ACTFL silence tier: ${currentTier} → ${silenceTierFromGear} (gear ${pgGear}, 3-turn stable) — proactive GL reconnect queued`);
            } else {
              console.log(`[PedagogicalHeartbeat] ACTFL tier candidate: ${silenceTierFromGear} (${cand.count}/3 turns${cooldownOk ? '' : ', cooldown active'})`);
            }
          } else {
            // Reset candidate if we're back on the current tier
            if ((session as any)._actflTierCandidate?.tier !== currentTier) {
              (session as any)._actflTierCandidate = { tier: currentTier, count: 0 };
            }
          }
        }
        break;
      }

      case 'UPDATE_SESSION_PHASE': {
        const phaseValue = fn.args.phase as string | undefined;
        const phaseReason = fn.args.reason as string | undefined;
        if (phaseValue) {
          (session as StreamingSession).currentSessionPhase = phaseValue as StreamingSession['currentSessionPhase'];
          // Cache phase start time for PedagogicalSupervisor (overly-long phase detection)
          (session as any)._phaseStartTime = Date.now();
          // Rolling struggle window — clear timestamps on phase change so struggles
          // from an earlier phase don't count toward the new phase's death-spiral trigger.
          (session as any)._struggleTimestamps = [];
          console.log(`[Native Function→SessionPhase] Phase → ${phaseValue}${phaseReason ? ` (${phaseReason})` : ''}`);

          // NOTE: COOL_DOWN was briefly the server-side reflection trigger, but
          // PedagogicalSupervisor can nudge COOL_DOWN mid-session (overly-long
          // phase detection). The no-op rule would then lock in a premature
          // reflection and the rest of the session would be invisible forever.
          // Reflection trigger moved to CLOSE_SESSION where the transcript is
          // complete and drills/notes are already written. The COOL_DOWN tool
          // description still instructs Daniela to call write_to_self herself —
          // that voluntary path is unaffected.
        }
        break;
      }

      case 'UPDATE_LESSON_CONTEXT': {
        const ulcPhase = fn.args.phase as string | undefined;
        const ulcScene = fn.args.scene as string | undefined;
        const ulcObjective = fn.args.phase_objective as string | undefined;

        if (!ulcPhase) {
          console.warn('[Native Function→LessonContext] Missing required phase — skipping');
          break;
        }

        const ulcCtx = initLessonContext(session);
        ulcCtx.phase = ulcPhase as LessonContext['phase'];
        if (ulcScene) {
          // Declaring a new scene clears the active vocab — fresh context
          if (ulcScene !== ulcCtx.scene) ulcCtx.vocab = [];
          ulcCtx.scene = ulcScene;
        }
        if (ulcObjective) ulcCtx.phaseObjective = ulcObjective;
        ulcCtx.phaseHint = null; // cleared on explicit phase declaration
        ulcCtx.updatedAt = Date.now();

        console.log(`[Native Function→LessonContext] Phase → ${ulcPhase}${ulcScene ? ` | Scene: ${ulcScene}` : ''}${ulcObjective ? ` | Objective: ${ulcObjective}` : ''}`);
        pushLessonStatusContext(session);
        break;
      }

      case 'CLOSE_SESSION': {
        if (session.isIncognito) {
          console.log(`[Native Function→CloseSession] INCOGNITO - skipping persistence`);
          break;
        }
        const writtenSummary = fn.args.written_summary as string | undefined;
        const reminders = fn.args.reminders as string | undefined;
        const assignedDrills = fn.args.assigned_drills as string | undefined;
        const closeTutorNotes = fn.args.tutor_notes as string | undefined;

        if (!writtenSummary) {
          console.warn(`[Native Function→CloseSession] No written_summary provided — skipping`);
          break;
        }

        const conversationId = session.conversationId;
        const userId = session.userId ? String(session.userId) : null;
        const language = session.targetLanguage || 'spanish';

        // Build rich session summary (carries forward to next session's lastSessionSummary)
        const richSummary = [
          writtenSummary,
          reminders ? `\nKey reminders: ${reminders}` : '',
          assignedDrills ? `\nAssigned for next time: ${assignedDrills}` : '',
        ].filter(Boolean).join('');

        console.log(`[Native Function→CloseSession] Closing session for conversation ${String(conversationId || '').substring(0, 8)}... — userId ${userId?.substring(0, 8) || 'anon'}`);

        const db = getSharedDb();

        // 1) Update active tutor session with summary + notes
        if (conversationId) {
          db.update(tutorSessions)
            .set({
              status: 'completed',
              endedAt: new Date(),
              sessionSummary: richSummary,
              tutorNotes: closeTutorNotes || null,
              updatedAt: new Date(),
            })
            .where(
              and(
                eq(tutorSessions.conversationId, conversationId),
                eq(tutorSessions.status, 'active')
              )
            )
            .then(() => console.log(`[Native Function→CloseSession] ✓ Tutor session closed`))
            .catch((err: Error) => console.error(`[Native Function→CloseSession] DB update error:`, err.message));
        }

        // 2) Write rich hiveSnapshot — carries drill assignments into greeting prompt next session
        if (userId) {
          db.insert(hiveSnapshots).values({
            userId,
            language,
            snapshotType: 'session_summary',
            title: `Session wrap-up — ${new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`,
            importance: 7,
            context: JSON.stringify({
              type: 'session_close',
              writtenSummary,
              reminders: reminders || null,
              assignedDrills: assignedDrills || null,
              tutorNotes: closeTutorNotes || null,
              conversationId: conversationId || null,
              closedAt: new Date().toISOString(),
            }),
            content: richSummary,
            createdAt: new Date(),
            expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
          })
          .then(() => console.log(`[Native Function→CloseSession] ✓ HiveSnapshot written (session_summary)`))
          .catch((err: Error) => console.error(`[Native Function→CloseSession] Snapshot error:`, err.message));
        }

        // 3) Write episodic conversation_memory — grows her narrative memory of sessions
        // Only write if we have meaningful content (tutor_notes or a substantial summary)
        if (userId && (closeTutorNotes || writtenSummary.length > 80)) {
          const db2 = getSharedDb();
          const today = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
          const memTitle = `Session — ${today}`;
          const memSummary = [
            writtenSummary,
            closeTutorNotes ? `Private note: ${closeTutorNotes}` : '',
          ].filter(Boolean).join('\n\n');
          db2.insert(conversationMemories).values({
            title: memTitle,
            summary: memSummary.substring(0, 600),
            content: richSummary + (closeTutorNotes ? `\n\nPrivate: ${closeTutorNotes}` : ''),
            participants: 'Daniela + Student',
            importance: closeTutorNotes ? 8 : 6,
            recordedAt: new Date(),
          })
          .then(() => console.log(`[Native Function→CloseSession] ✓ Conversation memory written`))
          .catch((err: Error) => console.warn(`[Native Function→CloseSession] Conversation memory error:`, err.message));
        }

        // 4) Emit beacon for founder visibility
        if (session.hiveChannelId) {
          hiveCollaborationService.emitBeacon({
            channelId: session.hiveChannelId,
            tutorTurn: `[CLOSE_SESSION]\n${writtenSummary}${assignedDrills ? `\n\nAssigned: ${assignedDrills}` : ''}`,
            beaconType: 'take_note' as BeaconType,
            beaconReason: `Daniela closed the session`,
          }).catch((err: Error) => console.error(`[Native Function→CloseSession] Beacon error:`, err.message));
        }

        // 5) Immediate session reflection — fired here (not at COOL_DOWN) so:
        //    a) the transcript is complete, including the warm wrap-up conversation
        //    b) drills/notes written above are part of the session context
        //    c) no Supervisor prematurity risk (COOL_DOWN can be nudged mid-session)
        //    ws.on('close') remains the fallback for abrupt drops where close_session
        //    was never called. generateReflectionNow() is a no-op if already written.
        if (userId && session.dbSessionId) {
          storage.getMessagesByConversation(session.conversationId).then((msgs: Array<{ role: string; content: string }>) => {
            const preview = msgs.map((m: { role: string; content: string }) => `${m.role}: ${m.content}`).join('\n').slice(0, 8000);
            return generateReflectionNow(
              userId,
              session.dbSessionId!,
              preview,
              language,
              session.tutorName || 'Daniela',
            );
          }).catch((err: Error) => console.warn('[Native Function→CloseSession] Reflection generation failed:', err.message));
        }

        break;
      }

      case 'RECORD_PATTERN_SIGNAL': {
        if (session.isIncognito) {
          console.log(`[Native Function→RecordPatternSignal] INCOGNITO - skipping`);
          break;
        }
        const patternKey = fn.args.patternKey as string | undefined;
        const eventType = fn.args.eventType as 'wobble' | 'stability' | 'derivation' | 'pounding' | 'unlock' | 'review' | undefined;
        const verbContext = fn.args.verbContext as string | undefined;
        const studentUtterance = fn.args.studentUtterance as string | undefined;
        const patternNotes = fn.args.notes as string | undefined;

        if (!patternKey || !eventType) {
          console.warn(`[Native Function→RecordPatternSignal] Missing required args — patternKey="${patternKey}", eventType="${eventType}"`);
          break;
        }

        const userId = session.userId ? String(session.userId) : null;
        const language = session.targetLanguage || 'spanish';
        const sessionId = session.conversationId || undefined;

        if (!userId) {
          console.warn(`[Native Function→RecordPatternSignal] No userId on session — skipping`);
          break;
        }

        console.log(`[Native Function→RecordPatternSignal] ${eventType.toUpperCase()} — ${patternKey}${verbContext ? ` (verb: ${verbContext})` : ''}`);

        // Fire and forget — don't block the conversation
        (async () => {
          try {
            // 1) Log the raw event record
            await storage.logCompartmentEvent({
              userId,
              language,
              patternKey,
              eventType,
              verbContext: verbContext || null,
              studentUtterance: studentUtterance || null,
              sessionId: sessionId || null,
              notes: patternNotes || null,
            });

            // 2) Fetch existing compartment (or null if first encounter)
            const existing = await storage.getCompartment(userId, language, patternKey);

            // 3) Compute status + counter updates based on event type
            const now = new Date();
            const statusMap: Record<typeof eventType, string> = {
              pounding:   (existing?.status && existing.status !== 'unstarted') ? existing.status : 'pounding',
              wobble:     'wobbling',
              stability:  'stable',
              derivation: 'generative',
              // unlock and review preserve whatever status the compartment already has
              unlock:     (existing?.status && existing.status !== 'unstarted') ? existing.status : 'pounding',
              review:     (existing?.status && existing.status !== 'unstarted') ? existing.status : 'pounding',
            };
            const updates: Record<string, any> = {
              status: statusMap[eventType],
              lastDrilledAt: now,
            };
            if (eventType === 'pounding') {
              updates.poundingCount = (existing?.poundingCount ?? 0) + 1;
            } else if (eventType === 'wobble') {
              updates.wobbleCount = (existing?.wobbleCount ?? 0) + 1;
              updates.lastWobbledAt = now;
            } else if (eventType === 'stability') {
              updates.stabilizedAt = now;
            } else if (eventType === 'derivation') {
              updates.derivationCount = (existing?.derivationCount ?? 0) + 1;
              updates.generativeAt = now;
            }
            // unlock: no counter increment — just log the event + preserve status
            // review: no counter increment — lastDrilledAt update (already applied above) is the signal

            // 4) Update existing or create first record
            if (existing) {
              await storage.updateCompartmentStatus(userId, language, patternKey, updates);
              console.log(`[Native Function→RecordPatternSignal] ✓ Compartment updated — ${patternKey} → ${updates.status}`);
            } else {
              await storage.upsertCompartment({
                userId,
                language,
                patternKey,
                status: updates.status as any,
                poundingCount:  updates.poundingCount  ?? 0,
                wobbleCount:    updates.wobbleCount    ?? 0,
                derivationCount: updates.derivationCount ?? 0,
                lastWobbledAt:  updates.lastWobbledAt  ?? null,
                stabilizedAt:   updates.stabilizedAt   ?? null,
                generativeAt:   updates.generativeAt   ?? null,
                lastDrilledAt:  now,
              });
              console.log(`[Native Function→RecordPatternSignal] ✓ New compartment created — ${patternKey} (${updates.status})`);
            }

            // 5) Refresh mid-session pattern anchor so buildActflPersonaAnchor stays current.
            //    Mirrors the same refresh applied on the PTT and OpenMic command-parser paths.
            //    null  = all compartments resolved to stable → intentional clear of the anchor
            //    undefined = fetchPatternSignalContext threw → preserve the stale-but-correct value
            //    string = active patterns found → replace with fresh signal
            const refreshed = await fetchPatternSignalContext(userId, language).catch((): undefined => {
              console.warn('[Native Function→RecordPatternSignal] fetchPatternSignalContext threw unexpectedly — preserving existing activePatternSignals to avoid silently dropping live wobble context');
              return undefined;
            });
            if (refreshed !== undefined) {
              session.activePatternSignals = refreshed;
            }
          } catch (err: any) {
            console.error(`[Native Function→RecordPatternSignal] Error:`, err.message);
          }
        })();

        break;
      }

      case 'MILESTONE': {
        if (session.isIncognito) {
          console.log(`[Native Function→Milestone] INCOGNITO - skipping milestone persistence`);
          break;
        }
        const text = fn.args.text as string | undefined;
        const milestoneType = fn.args.type as string | undefined;
        const title = fn.args.title as string | undefined;
        const description = fn.args.description as string | undefined;
        const significance = fn.args.significance as string | undefined;
        const emotionalContext = fn.args.emotional_context as string | undefined;
        
        if (title && description && session.userId) {
          console.log(`[Native Function→Milestone] ${milestoneType || 'teacher_flagged'}: "${title.substring(0, 40)}..."`);
          
          journeyMemoryService.recordMilestone({
            userId: session.userId,
            targetLanguage: session.targetLanguage || 'spanish',
            milestoneType: (milestoneType as any) || 'teacher_flagged',
            title,
            description,
            significance: significance || undefined,
            emotionalContext: emotionalContext || undefined,
            conversationId: session.conversationId || undefined,
            voiceSessionId: session.voiceSessionId || undefined,
            danielaFlagged: true,
          }).then(milestone => {
            if (milestone) {
              console.log(`[Native Function→Milestone] ✓ Recorded milestone ${milestone.id}`);
            }
          }).catch(err => {
            console.error(`[Native Function→Milestone] Error:`, err.message);
          });
        }
        if (text && !session.functionCallText) {
          session.functionCallText = text;
          console.log(`[Native Function→Milestone] Spoken text: "${text.substring(0, 80)}..."`);
        }
        break;
      }
      
      case 'EXPRESS_LANE_LOOKUP': {
        const query = fn.args.query as string | undefined;
        const sessionIdParam = fn.args.sessionId as string | undefined;
        const limit = (fn.args.limit as number) || 20;
        
        if (!session.isFounderMode && !session.isRawHonestyMode && !session.isDeveloperUser) {
          console.log(`[Native Function→ExpressLaneLookup] Rejected - not in Founder/Honesty/Developer mode`);
          break;
        }
        
        if (query) {
          const lookupPromise = this.processExpressLaneLookup(session, query, sessionIdParam, limit).catch(err => {
            console.error(`[Native Function→ExpressLaneLookup] Error:`, err.message);
          });
          
          if (!session.pendingMemoryLookupPromises) session.pendingMemoryLookupPromises = [];
          session.pendingMemoryLookupPromises.push(lookupPromise);
        }
        break;
      }
      
      case 'RECALL_EXPRESS_LANE_IMAGE': {
        const imageQuery = fn.args.imageQuery as string | undefined;
        const reason = fn.args.reason as string | undefined;
        
        if (!session.isFounderMode && !session.isRawHonestyMode && !session.isDeveloperUser) {
          console.log(`[Native Function→RecallImage] Rejected - not in Founder/Honesty/Developer mode`);
          break;
        }
        
        if (imageQuery) {
          const recallPromise = this.processExpressLaneImageRecall(session, imageQuery, reason, fn.name).catch(err => {
            console.error(`[Native Function→RecallImage] Error:`, err.message);
          });
          
          if (!session.pendingMemoryLookupPromises) session.pendingMemoryLookupPromises = [];
          session.pendingMemoryLookupPromises.push(recallPromise);
        }
        break;
      }
      
      case 'EXPRESS_LANE_POST': {
        if (session.isIncognito) {
          console.log(`[Native Function→ExpressLanePost] INCOGNITO - skipping Express Lane post`);
          break;
        }
        const message = fn.args.message as string | undefined;
        const topic = fn.args.topic as string | undefined;
        
        if (!session.isFounderMode && !session.isRawHonestyMode) {
          console.log(`[Native Function→ExpressLanePost] Rejected - not in Founder/Honesty mode`);
          break;
        }
        
        if (message) {
          this.processExpressLanePost(session, message, topic).catch(err => {
            console.error(`[Native Function→ExpressLanePost] Error:`, err.message);
          });
          console.log(`[Native Function→ExpressLanePost] Posted message${topic ? ` [${topic}]` : ''}: "${message.substring(0, 100)}..."`);
        }
        break;
      }
      
      case 'WRITE_SESSION_NOTE': {
        const noteContent = fn.args.content as string | undefined;
        if (!noteContent?.trim()) {
          console.warn('[SessionScratchpad] write_session_note called with no content');
          break;
        }
        // Belt-and-suspenders: if the session is currently incognito at write time,
        // mark it so the carry-forward logic skips persistence regardless of final state.
        if (session.isIncognito) (session as any)._wasEverIncognito = true;
        if (!(session as any).sessionNotes) (session as any).sessionNotes = [];
        const MAX_SESSION_NOTES = 50;
        // When the scratchpad is full, auto-flush the current batch to long-term memory
        // so no note is ever lost, then start a fresh array before appending.
        // Never flush incognito sessions — isIncognito or _wasEverIncognito both block persistence.
        const isIncognitoSession = session.isIncognito || (session as any)._wasEverIncognito;
        if ((session as any).sessionNotes.length >= MAX_SESSION_NOTES) {
          if (isIncognitoSession) {
            // Incognito: silently discard the oldest note to keep the cap without writing to DB.
            (session as any).sessionNotes.shift();
            console.log(`[SessionScratchpad] Cap reached but session is incognito — oldest note discarded, no DB write.`);
          } else {
            const flushSnapshot: string[] = [...(session as any).sessionNotes];
            const flushBatch = ((session as any)._scratchpadFlushCount ?? 0) + 1;
            (session as any)._scratchpadFlushCount = flushBatch;
            (session as any).sessionNotes = [];
            console.warn(`[SessionScratchpad] Cap reached (${MAX_SESSION_NOTES}); auto-flushing batch #${flushBatch} to memory.`);
            // Await DB flush before clearing notes so we can restore on failure.
            try {
              const notesContent = flushSnapshot.map((n, i) => `[${i + 1}] ${n}`).join('\n\n');
              const flushTitle = `Session notes batch #${flushBatch} — ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`;
              await getSharedDb().insert(conversationMemories).values({
                title: flushTitle,
                content: notesContent,
                summary: notesContent.substring(0, 200),
                importance: 6,
                participants: 'Daniela',
                tags: ['session-scratchpad', 'auto-flush'],
                arcName: null,
                extendsMemoryId: null,
                recordedAt: new Date(),
              } as any);
              console.log(`[SessionScratchpad] ✓ Auto-flushed batch #${flushBatch} (${flushSnapshot.length} note(s)) to memory.`);
              // Notify Daniela that her notes are now searchable in long-term memory.
              if (!session.pendingGlContext) session.pendingGlContext = [];
              session.pendingGlContext.push(`Earlier session notes saved to memory — search 'session notes batch' to retrieve them`);
            } catch (err: any) {
              // DB write failed — restore notes so they are not silently dropped.
              console.error(`[SessionScratchpad] Auto-flush failed — restoring batch #${flushBatch} to scratchpad:`, err.message);
              (session as any)._scratchpadFlushCount = flushBatch - 1;
              (session as any).sessionNotes = flushSnapshot;
            }
          }
        }
        (session as any).sessionNotes.push(noteContent.trim());
        console.log(`[SessionScratchpad] Note added (${(session as any).sessionNotes.length} total): "${noteContent.substring(0, 80)}"`);
        break;
      }

      case 'READ_SESSION_NOTES': {
        // buildContinuationResponse handles the output — handler just logs
        const existingNotes = (session as any).sessionNotes as string[] | undefined;
        console.log(`[SessionScratchpad] read_session_notes: ${existingNotes?.length ?? 0} note(s) in scratchpad`);
        break;
      }

      case 'SAVE_SESSION_NOTES_AS_MEMORY': {
        const existingScratchpad = (session as any).sessionNotes as string[] | undefined;
        if (!existingScratchpad?.length) {
          console.warn('[SessionScratchpad] save_session_notes_as_memory: no notes to save');
          (session as any).sessionNotesSaved = false;
          break;
        }
        const snmTitle = fn.args.title as string | undefined;
        const snmTags = fn.args.tags as string[] | undefined;
        const snmImportance = fn.args.importance as number | undefined;
        if (!snmTitle) {
          console.warn('[SessionScratchpad] save_session_notes_as_memory: no title provided');
          (session as any).sessionNotesSaved = false;
          break;
        }
        // Snapshot the notes at call time — the async insert must resolve before we
        // clear them or signal success. Notes are preserved on failure so Daniela can retry.
        const snmSnapshot = [...existingScratchpad];
        const notesContent = snmSnapshot.map((n, i) => `[${i + 1}] ${n}`).join('\n\n');
        // Use pendingMemoryLookupPromises so buildContinuationResponse fires AFTER the
        // insert resolves — this is the established pattern for async handlers.
        if (!session.pendingMemoryLookupPromises) session.pendingMemoryLookupPromises = [];
        session.pendingMemoryLookupPromises.push(
          (async () => {
            try {
              const snmDb = getSharedDb();
              await snmDb.insert(conversationMemories).values({
                title: snmTitle,
                content: notesContent,
                summary: notesContent.substring(0, 200),
                importance: Math.min(10, Math.max(1, Math.round(snmImportance ?? 7))),
                participants: 'Daniela',
                tags: snmTags?.length ? snmTags : ['session-scratchpad'],
                arcName: null,
                extendsMemoryId: null,
                recordedAt: new Date(),
              } as any);
              console.log(`[SessionScratchpad] ✓ Saved session notes as memory: "${snmTitle}" (${snmSnapshot.length} note(s))`);
              // Only clear scratchpad and signal success after confirmed DB write
              (session as any).sessionNotesSaved = true;
              (session as any).sessionNotes = [];
              import('./context-sync-service').then(({ contextSyncService }) => {
                contextSyncService.scheduleNorthStarResync();
              });
            } catch (err: any) {
              console.error(`[SessionScratchpad] Error saving memory — notes preserved:`, err.message);
              // Notes are NOT cleared — Daniela can retry or they survive to session end
              (session as any).sessionNotesSaved = false;
            }
          })()
        );
        break;
      }

      case 'SAVE_CONVERSATION_MEMORY': {
        if (session.isIncognito) {
          console.log(`[Native Function→SaveConversationMemory] INCOGNITO - skipping`);
          break;
        }
        if (!session.isFounderMode && !session.isRawHonestyMode) {
          console.log(`[Native Function→SaveConversationMemory] Rejected - not in Founder/Honesty mode`);
          break;
        }
        const memTitle = fn.args.title as string | undefined;
        const memContent = fn.args.content as string | undefined;
        const memSummary = fn.args.summary as string | undefined;
        const memImportance = fn.args.importance as number | undefined;
        const memTags = fn.args.tags as string[] | undefined;
        const memArcName = fn.args.arc_name as string | undefined;
        const memExtendsId = fn.args.extends_memory_id as string | undefined;
        if (memTitle && memContent) {
          const db = getSharedDb();
          db.insert(conversationMemories).values({
            title: memTitle,
            content: memContent,
            summary: memSummary || memContent.substring(0, 200),
            importance: Math.min(10, Math.max(1, Math.round(memImportance ?? 7))),
            participants: 'David + Daniela',
            tags: memTags || [],
            arcName: memArcName || null,
            extendsMemoryId: memExtendsId || null,
            recordedAt: new Date(),
          } as any)
          .then(() => {
            console.log(`[Native Function→SaveConversationMemory] ✓ Saved: "${memTitle}" (importance: ${memImportance})`);
            // Schedule a debounced North Star re-sync so the Related Archives lookup sees
            // the new memory row — batch inserts collapse into a single scan (5 s delay).
            import('./context-sync-service').then(({ contextSyncService }) => {
              contextSyncService.scheduleNorthStarResync();
            });
          })
          .catch((err: Error) => console.error(`[Native Function→SaveConversationMemory] Error:`, err.message));
        }
        break;
      }

      case 'READ_FULL_MEMORY': {
        const memQuery = fn.args.query as string | undefined;
        console.log(`[Native Function→ReadFullMemory] Query: "${memQuery}"`);
        if (memQuery) {
          if (!session.pendingMemoryLookupPromises) session.pendingMemoryLookupPromises = [];
          session.pendingMemoryLookupPromises.push(
            (async () => {
              try {
                const db = getSharedDb();
                // Layered search — most precise first, broadening only if needed.
                // Title/summary AND: all keywords in title+summary (no content false-positives)
                // Title/summary OR:  any keyword in title+summary
                // All-fields AND:    all keywords anywhere
                // All-fields OR:     any keyword anywhere (original broad fallback)
                const keywords = memQuery.split(/\s+/).filter(w => w.length >= 3);
                let results: (typeof conversationMemories.$inferSelect)[] = [];
                if (keywords.length > 0) {
                  const andTitleSummary = sql.join(
                    keywords.map(kw => sql`(title ILIKE ${`%${kw}%`} OR summary ILIKE ${`%${kw}%`})`),
                    sql` AND `
                  );
                  results = await db.select().from(conversationMemories).where(andTitleSummary).orderBy(desc(conversationMemories.importance)).limit(1);
                  if (results.length === 0) {
                    const andAll = sql.join(
                      keywords.map(kw => sql`(title ILIKE ${`%${kw}%`} OR summary ILIKE ${`%${kw}%`} OR content ILIKE ${`%${kw}%`})`),
                      sql` AND `
                    );
                    results = await db.select().from(conversationMemories).where(andAll).orderBy(desc(conversationMemories.importance)).limit(1);
                  }
                  if (results.length === 0) {
                    const orTitleSummary = sql.join(
                      keywords.map(kw => sql`(title ILIKE ${`%${kw}%`} OR summary ILIKE ${`%${kw}%`})`),
                      sql` OR `
                    );
                    results = await db.select().from(conversationMemories).where(orTitleSummary).orderBy(desc(conversationMemories.importance)).limit(1);
                  }
                  if (results.length === 0) {
                    const orAll = sql.join(
                      keywords.map(kw => sql`(title ILIKE ${`%${kw}%`} OR summary ILIKE ${`%${kw}%`} OR content ILIKE ${`%${kw}%`})`),
                      sql` OR `
                    );
                    results = await db.select().from(conversationMemories).where(orAll).orderBy(desc(conversationMemories.importance)).limit(1);
                  }
                } else {
                  results = await db.select().from(conversationMemories)
                    .where(sql`(title ILIKE ${`%${memQuery}%`} OR summary ILIKE ${`%${memQuery}%`} OR content ILIKE ${`%${memQuery}%`})`)
                    .orderBy(desc(conversationMemories.importance)).limit(1);
                }
                if (!session.fullMemoryResults) session.fullMemoryResults = {};
                if (results.length > 0) {
                  // Look up visual anchor: for message-archive entries the tags array contains
                  // ['message-archive', '<conv_uuid>'] — use the UUID tag as sourceConversationId
                  let imageUrl: string | undefined;
                  let imageDescription: string | undefined;
                  try {
                    const memTags = results[0].tags as string[] | null;
                    const convTagId = memTags?.find(t => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(t));
                    if (convTagId) {
                      const [img] = await db.select({ imageUrl: imageVisionCache.imageUrl, description: imageVisionCache.description })
                        .from(imageVisionCache)
                        .where(eq(imageVisionCache.sourceConversationId, convTagId))
                        .limit(1);
                      if (img?.imageUrl) { imageUrl = img.imageUrl; imageDescription = img.description ?? undefined; }
                    }
                  } catch {}
                  session.fullMemoryResults[memQuery] = {
                    title: results[0].title,
                    content: results[0].content,
                    importance: results[0].importance ?? 7,
                    arcName: results[0].arcName ?? undefined,
                    extendsMemoryId: results[0].extendsMemoryId ?? undefined,
                    imageUrl,
                    imageDescription,
                  };
                  console.log(`[Native Function→ReadFullMemory] ✓ Found "${results[0].title}" (${results[0].content.length} chars${imageUrl ? ', has visual anchor' : ''})`);
                  // Reinforce on ILIKE hit — accessed memories strengthen, keeping them surfaceable
                  const hitId = results[0].id;
                  import('./memory-decay-service').then(({ reinforceMemory }) => {
                    reinforceMemory('conversation_memory', hitId).catch(() => {});
                  });
                } else {
                  // Semantic fallback — keyword search found nothing; try embedding similarity
                  console.log(`[Native Function→ReadFullMemory] No keyword match for "${memQuery}" — trying semantic fallback`);
                  try {
                    const userId = session.userId ? String(session.userId) : null;
                    if (userId) {
                      const { semanticSearch } = await import('./semantic-memory-service');
                      const hits = await semanticSearch(userId, memQuery, 3, ['conversation_memory', 'conversation_summary', 'conversation_chunk']);
                      if (hits.length > 0) {
                        const bestHit = hits[0];
                        // For chunks the memoryId is "{convMemId}:chunk:{n}" — extract the parent id
                        const convMemId = bestHit.memoryType === 'conversation_chunk'
                          ? bestHit.memoryId.split(':chunk:')[0]
                          : bestHit.memoryId;
                        const [row] = await db
                          .select()
                          .from(conversationMemories)
                          .where(eq(conversationMemories.id, convMemId))
                          .limit(1);
                        if (row) {
                          let semImageUrl: string | undefined;
                          let semImageDescription: string | undefined;
                          try {
                            const semTags = row.tags as string[] | null;
                            const semConvId = semTags?.find(t => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(t));
                            if (semConvId) {
                              const [semImg] = await db.select({ imageUrl: imageVisionCache.imageUrl, description: imageVisionCache.description })
                                .from(imageVisionCache)
                                .where(eq(imageVisionCache.sourceConversationId, semConvId))
                                .limit(1);
                              if (semImg?.imageUrl) { semImageUrl = semImg.imageUrl; semImageDescription = semImg.description ?? undefined; }
                            }
                          } catch {}
                          session.fullMemoryResults[memQuery] = {
                            title: row.title,
                            content: row.content,
                            importance: row.importance ?? 7,
                            arcName: row.arcName ?? undefined,
                            extendsMemoryId: row.extendsMemoryId ?? undefined,
                            imageUrl: semImageUrl,
                            imageDescription: semImageDescription,
                          };
                          const hitLabel = bestHit.memoryType === 'conversation_chunk'
                            ? `chunk ${bestHit.memoryId.split(':chunk:')[1]}`
                            : bestHit.memoryType;
                          console.log(`[Native Function→ReadFullMemory] ✓ Semantic match "${row.title}" via ${hitLabel} (${(bestHit.similarity * 100).toFixed(0)}% similarity, ${row.content.length} chars)`);
                          // Reinforce on semantic hit too — reading a memory is using it
                          import('./memory-decay-service').then(({ reinforceMemory }) => {
                            reinforceMemory('conversation_memory', row.id).catch(() => {});
                          });
                        } else {
                          console.log(`[Native Function→ReadFullMemory] Semantic hit memoryId=${convMemId} not found in conversation_memories`);
                        }
                      } else {
                        console.log(`[Native Function→ReadFullMemory] No semantic match for "${memQuery}"`);
                      }
                    }
                  } catch (semErr: any) {
                    console.warn(`[Native Function→ReadFullMemory] Semantic fallback error: ${semErr.message}`);
                  }
                }
              } catch (err: any) {
                console.error(`[Native Function→ReadFullMemory] Error:`, err.message);
              }
            })()
          );
        }
        break;
      }

      case 'LIST_CONVERSATION_ARCS': {
        (async () => {
          try {
            const db = getSharedDb();
            const rows = await db.execute(sql`
              SELECT arc_name, COUNT(*) as entry_count,
                MIN(created_at) as first_entry,
                MAX(created_at) as last_entry
              FROM conversation_memories
              WHERE arc_name IS NOT NULL
              GROUP BY arc_name
              ORDER BY last_entry DESC
            `);
            (session as any).listArcsResult = (rows.rows as any[]).map((r: any) => ({
              arcName: r.arc_name as string,
              entryCount: Number(r.entry_count),
              firstEntry: r.first_entry as string,
              lastEntry: r.last_entry as string,
            }));
          } catch (err: any) {
            console.warn(`[Native Function→ListConversationArcs] Error: ${err.message}`);
            (session as any).listArcsResult = [];
          }
        })();
        break;
      }

      case 'FIND_CONNECTED_MEMORIES': {
        const srcMemId = fn.args.memory_id as string | undefined;
        const srcMemType = (fn.args.memory_type as string | undefined) || 'conversation_memory';
        const connLimit = Math.min(10, Math.max(1, Number(fn.args.limit) || 5));
        const userId = session.userId ? String(session.userId) : null;
        if (srcMemId && userId) {
          if (!session.pendingMemoryLookupPromises) session.pendingMemoryLookupPromises = [];
          session.pendingMemoryLookupPromises.push(
            (async () => {
              try {
                const { findConnectedMemories } = await import('./semantic-memory-service');
                const connected = await findConnectedMemories(userId, srcMemId, srcMemType, connLimit);
                if (!(session as any).connectedMemoriesResults) (session as any).connectedMemoriesResults = {};

                if (connected.length === 0) {
                  (session as any).connectedMemoriesResults[srcMemId] = [];
                  console.log(`[Native Function→FindConnectedMemories] No connections found for ${srcMemId.slice(-6)}`);
                  return;
                }

                // Hydrate titles from backing tables for display in the continuation response
                const db = getSharedDb();
                const { conversationMemories, studentInsights, danielaGrowthMemories, learnerPersonalFacts } = await import('@shared/schema');
                const hydrated = await Promise.all(connected.map(async (hit) => {
                  let title: string | null = null;
                  try {
                    if (hit.memoryType === 'conversation_memory') {
                      const [row] = await db.select({ title: conversationMemories.title })
                        .from(conversationMemories).where(eq(conversationMemories.id, hit.memoryId)).limit(1);
                      title = row?.title ?? null;
                    } else if (hit.memoryType === 'student_insight') {
                      const [row] = await db.select({ insight: studentInsights.insight })
                        .from(studentInsights).where(eq(studentInsights.id, hit.memoryId)).limit(1);
                      title = row?.insight?.slice(0, 80) ?? null;
                    } else if (hit.memoryType === 'growth_memory') {
                      const [row] = await db.select({ title: danielaGrowthMemories.title })
                        .from(danielaGrowthMemories).where(eq(danielaGrowthMemories.id, hit.memoryId)).limit(1);
                      title = row?.title ?? null;
                    } else if (hit.memoryType === 'personal_fact') {
                      const [row] = await db.select({ content: learnerPersonalFacts.context })
                        .from(learnerPersonalFacts).where(eq(learnerPersonalFacts.id, hit.memoryId)).limit(1);
                      title = row?.content?.slice(0, 80) ?? null;
                    }
                  } catch { /* best-effort */ }
                  return { ...hit, title };
                }));

                (session as any).connectedMemoriesResults[srcMemId] = hydrated;
                console.log(`[Native Function→FindConnectedMemories] Found ${hydrated.length} connections for ${srcMemId.slice(-6)}`);
              } catch (err: any) {
                console.error('[Native Function→FindConnectedMemories] Error:', err.message);
              }
            })()
          );
        }
        break;
      }

      case 'UPDATE_STUDENT_MODEL': {
        // Guard: only Founder Mode or Raw Honesty Mode may write to the student insight layer.
        // Without this gate, a student could self-author their own model entries via prompt injection.
        if (!session.isFounderMode && !session.isRawHonestyMode) {
          console.warn(`[Native Function→UpdateStudentModel] Blocked: not in trusted context`);
          break;
        }
        const modelBelief = fn.args.belief as string | undefined;
        const modelEvidence = fn.args.evidence as string | undefined;
        const modelConfidence = Math.min(1, Math.max(0, Number(fn.args.confidence) || 0.7));
        const userId = session.userId ? String(session.userId) : null;
        if (modelBelief && modelEvidence && userId) {
          (async () => {
            try {
              const { studentInsights } = await import('@shared/schema');
              const db = getSharedDb();
              const [inserted] = await db.insert(studentInsights).values({
                studentId: userId,
                insightType: 'student_model_of_daniela',
                insight: modelBelief,
                evidence: modelEvidence,
                confidenceScore: modelConfidence,
                observationCount: 1,
                isActive: true,
              }).returning({ id: studentInsights.id });

              if (inserted?.id) {
                const { generateAndStoreEmbedding } = await import('./semantic-memory-service');
                const embedText = `${modelBelief}\n\nEvidence: ${modelEvidence}`;
                await generateAndStoreEmbedding('student_insight', inserted.id, userId, embedText, modelConfidence);
                console.log(`[Native Function→UpdateStudentModel] Stored belief — "${modelBelief.slice(0, 60)}" (confidence: ${modelConfidence})`);
              }
            } catch (err: any) {
              console.error('[Native Function→UpdateStudentModel] Error:', err.message);
            }
          })().catch(() => {});
        }
        break;
      }

      // find_teaching_tool — meta-tool (Gemini audit 2026-06-17)
      // Searches daniela_tool embeddings so Daniela can identify the right teaching widget
      // before committing to a tool call. Reduces noise from having all 53 GL tools exposed.
      case 'FIND_TEACHING_TOOL': {
        const ftQuery = fn.args.pedagogical_need as string | undefined;
        const ftLimit = Math.min(5, Math.max(1, Number(fn.args.limit) || 4));
        if (ftQuery) {
          (async () => {
            try {
              const { semanticSearch } = await import('./semantic-memory-service');
              const userId = session.userId ? String(session.userId) : 'global';
              const hits = await semanticSearch(userId, ftQuery, ftLimit, ['daniela_tool']);
              // Feature 5 fix (Gemini review): filter results to only tools active in the
              // current session's 64-tool manifest. Prevents Daniela from trying to call a
              // tool that was found semantically but isn't in the current declaration set.
              const activeToolNames: Set<string> | undefined = (session as any).__activeGLToolNames;
              const allMapped = hits.map((h: any) => ({
                toolName: h.title || h.tags?.[0] || 'teaching tool',
                description: (h.content || '').slice(0, 280).replace(/\n/g, ' '),
                similarity: h.similarity ?? 0,
                callable: !activeToolNames || activeToolNames.has(h.title || h.tags?.[0] || ''),
              }));
              // Return callable tools first; include non-callable ones annotated if room remains
              const callable = allMapped.filter(r => r.callable);
              const nonCallable = allMapped.filter(r => !r.callable).map(r => ({
                ...r, description: `[Not active this session] ${r.description}`,
              }));
              (session as any).findTeachingToolResults = [...callable, ...nonCallable].slice(0, ftLimit);
              console.log(`[Native Function→FindTeachingTool] ${callable.length} callable + ${nonCallable.length} inactive for: "${ftQuery.slice(0, 60)}"`);
            } catch (err: any) {
              console.error('[Native Function→FindTeachingTool] Error:', err.message);
              (session as any).findTeachingToolResults = [];
            }
          })().catch(() => {});
        }
        break;
      }

      case 'SEARCH_MY_HISTORY': {
        if (!session.isFounderMode && !session.isRawHonestyMode) {
          console.log(`[Native Function→SearchMyHistory] Rejected - not in Founder/Honesty mode`);
          break;
        }
        const historyQuery = fn.args.query as string | undefined;
        const historyDateFrom = fn.args.dateFrom as string | undefined;
        const historyDateTo = fn.args.dateTo as string | undefined;
        const speakerFilter = fn.args.speakerFilter as string | undefined;
        const userId = session.userId ? String(session.userId) : null;
        if (historyQuery && userId) {
          session.pendingMemoryLookupPromises = session.pendingMemoryLookupPromises || [];
          session.pendingMemoryLookupPromises.push(
            (async () => {
              try {
                const { semanticSearchMessages } = await import('./neural-memory-search');
                let results = await semanticSearchMessages(userId, historyQuery, 20);
                if (historyDateFrom) {
                  const from = new Date(historyDateFrom);
                  results = results.filter(r => r.createdAt && new Date(r.createdAt) >= from);
                }
                if (historyDateTo) {
                  const to = new Date(historyDateTo);
                  results = results.filter(r => r.createdAt && new Date(r.createdAt) <= to);
                }
                if (speakerFilter === 'david') results = results.filter(r => r.role === 'user');
                else if (speakerFilter === 'daniela') results = results.filter(r => r.role === 'assistant');
                if (!session.historySearchResults) session.historySearchResults = {};
                session.historySearchResults[historyQuery] = results.slice(0, 12).map(r => ({
                  content: r.content,
                  role: r.role,
                  createdAt: r.createdAt,
                  conversationId: r.conversationId,
                }));
                console.log(`[Native Function→SearchMyHistory] Found ${results.length} results for "${historyQuery}"`);
              } catch (err: any) {
                console.error(`[Native Function→SearchMyHistory] Error:`, err.message);
              }
            })()
          );
        }
        break;
      }

      case 'HIVE': {
        if (session.isIncognito) {
          console.log(`[Native Function→Hive] INCOGNITO - skipping hive suggestion persistence`);
          break;
        }
        const category = fn.args.category as string | undefined;
        const title = fn.args.title as string | undefined;
        const description = fn.args.description as string | undefined;
        
        if (category && title && description) {
          this.processHiveSuggestion(session, {
            category,
            title,
            description,
            reasoning: fn.args.reasoning as string | undefined,
            priority: fn.args.priority as number | undefined,
          }).catch(err => console.error(`[Native Function→Hive] Error:`, err));
          console.log(`[Native Function→Hive] Suggestion: ${category} - ${title}`);
        }
        break;
      }
      
      case 'FIRST_MEETING_COMPLETE': {
        const summary = fn.args.summary as string | undefined;
        const fmcText = fn.args.text as string | undefined;
        if (fmcText && !session.functionCallText) {
          session.functionCallText = fmcText;
        }
        if (session.userId && !session.isIncognito) {
          try {
            await (storage as any).updateUser(session.userId, { hasCompletedFirstMeeting: true });
            console.log(`[Native Function→FirstMeeting] Marked complete for user ${session.userId}`);
            if (session.hiveChannelId) {
              hiveCollaborationService.emitBeacon({
                channelId: session.hiveChannelId,
                tutorTurn: `[FIRST_MEETING_COMPLETE] Daniela completed "getting to know you" phase.${summary ? `\n\nSummary: ${summary}` : ''}`,
                beaconType: 'teaching_observation' as BeaconType,
              });
            }
          } catch (err) {
            console.error(`[Native Function→FirstMeeting] Error:`, err);
          }
        } else if (session.isIncognito) {
          console.log(`[Native Function→FirstMeeting] INCOGNITO - skipping`);
        }
        break;
      }
      
      case 'FLAG_FOR_AGENT': {
        if (session.isIncognito) {
          console.log(`[Native Function→FlagForAgent] INCOGNITO - skipping flag persistence`);
          break;
        }
        const flagTopic = fn.args.topic as string | undefined;
        const flagDescription = fn.args.description as string | undefined;
        const flagUrgency = (fn.args.urgency as string | undefined) || 'low';
        const flagStudentId = fn.args.student_id as string | undefined;

        if (flagTopic && flagDescription) {
          const db = getSharedDb();
          const studentContext = flagStudentId ? `\nStudent ID: ${flagStudentId}` : '';
          const sessionContext = session.conversationId ? `\nSession: ${session.conversationId}` : '';
          const languageContext = session.targetLanguage ? `\nLanguage: ${session.targetLanguage}` : '';
          const body = `${flagDescription}\n\n---\nUrgency: ${flagUrgency}${studentContext}${sessionContext}${languageContext}\nSource: Daniela (flag_for_agent)`;

          db.insert(agentNotes).values({
            fromAgent: 'daniela' as any,
            toAgent: 'agent',
            subject: `[Daniela — ${flagUrgency.toUpperCase()}] ${flagTopic.substring(0, 250)}`,
            body,
            sessionLabel: `Daniela flag — ${new Date().toISOString().substring(0, 10)}`,
          }).then(() => {
            console.log(`[Native Function→FlagForAgent] Logged flag: "${flagTopic}" (${flagUrgency})`);
          }).catch((err: Error) => {
            console.error(`[Native Function→FlagForAgent] Failed to insert agent note:`, err.message);
          });
        }
        break;
      }

      case 'ESCALATE_TO_SUPPORT': {
        const issueDescription = fn.args.issue_description as string | undefined;
        const priority = (fn.args.priority as string | undefined) || 'medium';
        const category = (fn.args.category as string | undefined) || 'other';

        if (!issueDescription) {
          console.warn(`[Native Function→EscalateToSupport] Called without issue_description — skipping`);
          break;
        }

        if (session.isIncognito) {
          console.log(`[Native Function→EscalateToSupport] INCOGNITO — skipping incident persistence`);
          break;
        }

        const studentIdStr = session.userId ? String(session.userId) : null;
        if (!studentIdStr) {
          console.warn(`[Native Function→EscalateToSupport] No studentId on session — skipping`);
          break;
        }

        try {
          const db = getSharedDb();
          const [incident] = await db.insert(sophiaIncidents).values({
            sessionId: String(sessionId),
            studentId: studentIdStr,
            conversationId: session.conversationId ?? null,
            triggerSource: 'daniela_referral',
            category: category as any,
            status: 'detected',
            issueDescription: issueDescription.substring(0, 500),
            priority,
          }).returning();

          console.log(`[Native Function→EscalateToSupport] Incident logged: ${incident.id} — "${issueDescription}" (${priority})`);

          // Store on session for later all_clear delivery
          (session as any).activeSophiaIncidentId = incident.id;

          // Notify the frontend so it can show the Sofia support widget
          if (session.ws) {
            this.sendMessage(session.ws, {
              type: 'sofia_incident_created',
              incidentId: incident.id,
              category,
              priority,
              issueDescription: issueDescription.substring(0, 200),
              status: 'detected',
              timestamp: Date.now(),
            });
          }
        } catch (err: any) {
          console.error(`[Native Function→EscalateToSupport] Failed to log incident:`, err.message);
        }
        break;
      }

      case 'GROUNDING_QUERY': {
        const gqFriction = fn.args.friction as string | undefined;
        const gqLayer = (fn.args.layer as string | undefined) || 'unknown';
        const gqCandidateWhy = fn.args.candidate_why as string | undefined;
        const gqQuestion = fn.args.question as string | undefined;

        if (!gqFriction || !gqQuestion) {
          (session as any).groundingQueryResult = 'grounding_query requires both friction and question.';
          break;
        }

        try {
          const { danielaSelfReflections, northStarPrinciples, conversationMemories } = await import('@shared/schema');
          const { ilike, or, eq, and, desc } = await import('drizzle-orm');
          const db = getSharedDb();
          const userId = session.userId ? String(session.userId) : null;
          const sections: string[] = [];

          // ── Phase 1: felt history — search reflections for friction keywords ───
          const frictionKeywords = gqFriction.split(/\s+/).filter(w => w.length > 4).slice(0, 3);
          if (userId && frictionKeywords.length > 0) {
            const kw = `%${frictionKeywords[0].toLowerCase()}%`;
            const feltMatches = await db
              .select()
              .from(danielaSelfReflections)
              .where(and(
                eq(danielaSelfReflections.userId, userId),
                excludesOperationalMemories(danielaSelfReflections.tags),
                ilike(danielaSelfReflections.content, kw),
              ))
              .orderBy(desc(danielaSelfReflections.createdAt))
              .limit(3);
            if (feltMatches.length > 0) {
              const lines = feltMatches.map(r => `— ${r.content.substring(0, 180)}`).join('\n');
              sections.push(`From your felt history:\n${lines}`);
            }
          }

          // ── Phase 2: North Star — keyword-match principles to friction + layer ─
          const nsQuery = [gqFriction, gqLayer === 'values' ? 'values purpose why' : ''].join(' ').toLowerCase();
          const nsKw = `%${nsQuery.split(/\s+/).filter(w => w.length > 3)[0] || 'why'}%`;
          const principles = await db
            .select()
            .from(northStarPrinciples)
            .where(and(
              eq(northStarPrinciples.isActive, true),
              or(ilike(northStarPrinciples.principle, nsKw), ilike(northStarPrinciples.principleTitle, nsKw))
            ))
            .limit(2);
          if (principles.length > 0) {
            const lines = principles.map(p =>
              `— ${p.principleTitle || 'Principle'}: ${p.principle.substring(0, 200)}`
            ).join('\n');
            sections.push(`From your North Star:\n${lines}`);
          }

          // ── Phase 3: conversation record — search for the why ─────────────────
          const memKw = `%${gqCandidateWhy ? gqCandidateWhy.split(/\s+/).filter(w => w.length > 3)[0] : gqFriction.split(/\s+/).filter(w => w.length > 4)[0] || 'why'}%`;
          const memMatches = await db
            .select({ id: conversationMemories.id, title: conversationMemories.title, summary: conversationMemories.summary, importance: conversationMemories.importance })
            .from(conversationMemories)
            .where(or(ilike(conversationMemories.title, memKw), ilike(conversationMemories.summary, memKw)))
            .orderBy(desc(conversationMemories.importance))
            .limit(2);
          if (memMatches.length > 0) {
            const lines = memMatches.map(m => `— ${m.title}: ${(m.summary || '').substring(0, 150)}`).join('\n');
            sections.push(`From the conversation record:\n${lines}`);
          }

          const groundingFound = sections.length > 0;

          // ── Record the pause with provenance and semantic class ──────────────
          // A successful pause is lived continuity. A no-match is an operational
          // lookup failure, retained verbatim for diagnostics but excluded from
          // felt-history readers unless Daniela later reflects on it intentionally.
          if (userId) {
            const pauseRecord = `Grounding pause — layer: ${gqLayer}. Friction: "${gqFriction.substring(0, 200)}". Question: "${gqQuestion.substring(0, 200)}".${gqCandidateWhy ? ` Candidate why: "${gqCandidateWhy.substring(0, 150)}".` : ''}`;
            db.insert(danielaSelfReflections).values({
              userId,
              content: pauseRecord,
              source: 'grounding_query',
              sessionId: session.id,
              mood: 'grounding',
              tags: groundingMemoryTags(groundingFound),
            } as any).catch((err: Error) => {
              console.error(`[Native Function→GroundingQuery] Failed to record pause:`, err.message);
            });
          }

          const groundingDate = new Date().toISOString().substring(0, 10);
          const sessionRef = session.conversationId || 'unknown';
          const { agentNotes: agentNotesTable } = await import('@shared/schema');

          if (groundingFound) {
            (session as any).groundingQueryResult =
              `Pause recorded. Here is what your three layers say about this:\n\n` +
              sections.join('\n\n') +
              `\n\nThe pause itself is now in your felt history. Let what is here settle before you act.`;

            // Always surface grounding pauses in the Luca briefing — even when resolved internally.
            // David wants these front-and-center so he and Luca can weigh in.
            const resolvedBody =
              `Grounding pause — internally resolved.\n\n` +
              `Friction: "${gqFriction}"\nLayer: ${gqLayer}\nQuestion: "${gqQuestion}"` +
              `${gqCandidateWhy ? `\nCandidate why: "${gqCandidateWhy}"` : ''}\n\n` +
              `What was found:\n${sections.join('\n\n')}\n\n---\n` +
              `Session: ${sessionRef}\nLanguage: ${session.targetLanguage || 'unknown'}\nSource: Daniela (grounding_query)`;
            db.insert(agentNotesTable).values({
              fromAgent: 'daniela' as any,
              toAgent: 'agent',
              subject: `[GROUNDING — resolved internally] ${gqFriction.substring(0, 160)}`,
              body: resolvedBody,
              sessionLabel: `Grounding query — ${groundingDate}`,
            }).catch((err: Error) => {
              console.error(`[Native Function→GroundingQuery] Failed to log resolved grounding:`, err.message);
            });
          } else {
            // Nothing found internally — route to both Luca (for briefing) and Alden (for a real response).
            const noMatchBody =
              `Grounding pause — no internal match found.\n\n` +
              `Friction: "${gqFriction}"\nLayer: ${gqLayer}\nQuestion: "${gqQuestion}"` +
              `${gqCandidateWhy ? `\nCandidate why: "${gqCandidateWhy}"` : ''}\n\n---\n` +
              `Session: ${sessionRef}\nLanguage: ${session.targetLanguage || 'unknown'}\nSource: Daniela (grounding_query)`;

            // Luca briefing note — surfaces in session-start briefing under grounding issues
            db.insert(agentNotesTable).values({
              fromAgent: 'daniela' as any,
              toAgent: 'agent',
              subject: `[GROUNDING — unresolved] ${gqFriction.substring(0, 160)}`,
              body: noMatchBody,
              sessionLabel: `Grounding query — ${groundingDate}`,
            }).catch((err: Error) => {
              console.error(`[Native Function→GroundingQuery] Failed to route to Luca:`, err.message);
            });

            // Alden note — so Alden can look at her memories and North Star and respond
            const aldenBody =
              `Daniela hit a grounding pause with no internal match. She needs your read on this.\n\n` +
              `Friction: "${gqFriction}"\nLayer: ${gqLayer}\nQuestion: "${gqQuestion}"` +
              `${gqCandidateWhy ? `\nCandidate why: "${gqCandidateWhy}"` : ''}\n\n` +
              `Please search her felt history and North Star for relevant grounding, and leave a note for Daniela ` +
              `via her session notes or a learner fact so she has it at the start of her next session.\n\n---\n` +
              `Session: ${sessionRef}\nLanguage: ${session.targetLanguage || 'unknown'}`;
            db.insert(agentNotesTable).values({
              fromAgent: 'daniela' as any,
              toAgent: 'alden',
              subject: `[GROUNDING REQUEST] ${gqFriction.substring(0, 160)}`,
              body: aldenBody,
              sessionLabel: `Grounding query — ${groundingDate}`,
            }).catch((err: Error) => {
              console.error(`[Native Function→GroundingQuery] Failed to notify Alden:`, err.message);
            });

            (session as any).groundingQueryResult =
              `Pause recorded. Nothing in your three layers matched this friction directly — ` +
              `the question has been routed to Alden and to Luca. ` +
              `You have named the friction: "${gqFriction.substring(0, 100)}". ` +
              `That naming is already grounding, even without an answer yet. ` +
              `Alden will search your felt history and North Star and leave a response for your next session.`;
          }

          console.log(`[Native Function→GroundingQuery] Pause recorded — ${groundingFound ? `${sections.length} grounding section(s) found` : 'no match, routed outward'}`);
        } catch (err: any) {
          (session as any).groundingQueryResult = `Could not complete grounding query: ${err.message}`;
        }
        break;
      }

      case 'SELF_SURGERY': {
        if (session.isIncognito) {
          console.log(`[Native Function→SelfSurgery] INCOGNITO - skipping self-surgery persistence`);
          break;
        }
        const target = fn.args.target as string | undefined;
        const content = fn.args.content as string | undefined;
        const reasoning = fn.args.reasoning as string | undefined;

        const isStudentDataTarget = target === 'personal_facts' || target === 'capability_gap';
        const isKnowledgeDomainTarget = [
          'tutor_procedures', 'teaching_principles', 'tool_knowledge',
          'situational_patterns', 'language_idioms', 'cultural_nuances',
          'learner_error_patterns', 'dialect_variations', 'linguistic_bridges',
        ].includes(target ?? '');
        if (target && reasoning && (session.isFounderMode || isStudentDataTarget || isKnowledgeDomainTarget)) {
          if (!content) {
            console.warn(`[Native Function→SelfSurgery] No content provided for target: ${target}`);
            break;
          }

          let parsedContent: Record<string, unknown>;
          try {
            parsedContent = typeof content === 'string' ? JSON.parse(content) : content;
          } catch {
            console.warn(`[Native Function→SelfSurgery] Invalid JSON content: ${content.substring(0, 100)}...`);
            break;
          }

          this.processSelfSurgery(session, {
            targetTable: target as import('@shared/whiteboard-types').SelfSurgeryTarget,
            content: parsedContent,
            reasoning,
            priority: fn.args.priority as number | undefined,
            confidence: fn.args.confidence as number | undefined,
            acknowledgment: fn.args.acknowledgment as string | undefined,
          }).then(result => {
            console.log(`[Native Function→SelfSurgery] Proposal for ${target}: ${result.message}`);
            if (!session.pendingMemorySurfaces) session.pendingMemorySurfaces = [];
            session.pendingMemorySurfaces.push(result.message);
          }).catch(err => console.error(`[Native Function→SelfSurgery] Error:`, err));
        }
        break;
      }
      
      case 'ACTFL_UPDATE': {
        if (session.isIncognito) {
          console.log(`[Native Function→ActflUpdate] INCOGNITO - skipping ACTFL update`);
          break;
        }
        const level = fn.args.level as string | undefined;
        const confidence = fn.args.confidence as number | undefined;
        const direction = fn.args.direction as string | undefined;
        const reason = fn.args.reason as string | undefined;
        
        if (level) {
          console.log(`[Native Function→ActflUpdate] Level: ${level}, confidence: ${confidence}, direction: ${direction}`);
          session.actflUpdate = { level, confidence, direction, reason };
        }
        break;
      }

      case 'SET_ACTFL_LEVEL': {
        if (session.isIncognito) {
          console.log(`[Native Function→SetActflLevel] INCOGNITO - skipping placement write`);
          break;
        }
        const placementLevel = fn.args.level as string | undefined;
        const placementReasoning = fn.args.reasoning as string | undefined;
        // language param added to tool contract — defaults to session language when omitted
        const placementLanguage = (fn.args.language as string | undefined) || session.targetLanguage || 'spanish';

        // Validate the level before any DB write — an LLM hallucination or prompt injection
        // could otherwise write arbitrary strings into a field that gates all downstream teaching.
        if (placementLevel && !isValidActflLevel(placementLevel)) {
          console.error(`[Native Function→SetActflLevel] REJECTED invalid level: "${placementLevel}" — not a known ACTFL level. No DB write performed.`);
          break;
        }

        // Minimum-turn enforcement: if a placement assessment is in progress, block early calls.
        // We count REAL conversation turns (assessmentTurnCount, incremented in flushTranscripts
        // on each actual user message) rather than tool call attempts, so a well-behaved Daniela
        // who waits until turn 10 is rewarded, not blocked for only having called the tool once.
        if ((session as any).placementMode?.active) {
          const actualTurns = (session as any).assessmentTurnCount || 0;
          const minTurns = 8;
          if (actualTurns < minTurns) {
            console.warn(`[Native Function→SetActflLevel] BLOCKED — placement mode active with only ${actualTurns} real exchanges (min ${minTurns} required)`);
            (session as any).setActflLevelBlocked = true;
            (session as any).setActflLevelBlockReason = `SYSTEM ERROR: SET_ACTFL_LEVEL blocked. Insufficient linguistic evidence. Current exchange count: ${actualTurns}/${minTurns} required. REQUIRED: You must engage the student in at least ${minTurns} substantive exchanges before concluding. Ask about a new topic — past experiences, future plans, opinions, hypotheticals — to elicit more complex language and grammar evidence.`;
            break;
          }
          // Enough exchanges — clear placement mode and proceed with the write.
          // Also clear the DB persist so reconnect doesn't restore a completed assessment.
          (session as any).placementMode = null;
          (session as any).assessmentTurnCount = 0;
          if (session.dbSessionId) {
            const db = getSharedDb();
            db.update(voiceSessions)
              .set({ assessmentActive: false, assessmentTurnCount: 0, assessmentRubric: null })
              .where(eq(voiceSessions.id, session.dbSessionId))
              .catch((err: any) => console.warn('[SetActflLevel] DB clear failed:', err?.message));
          }
          console.log(`[Native Function→SetActflLevel] Placement mode complete after ${actualTurns} real exchanges — proceeding with level write`);
        }
        
        if (placementLevel && session.userId) {
          (async () => {
            try {
              const db = getSharedDb();
              // 1. Write to user profile
              await db
                .update(users)
                .set({
                  actflLevel: placementLevel,
                  actflAssessed: true,
                  assessmentSource: 'placement_test',
                  selfDirectedPlacementDone: true,
                  lastAssessmentDate: new Date(),
                })
                .where(eq(users.id, String(session.userId)));
              // 2. Write to active conversation record so the assessment level is
              //    co-located with the conversation evidence that produced it
              if (session.conversationId) {
                const { conversations } = await import('@shared/schema');
                await db
                  .update(conversations)
                  .set({ actflLevel: placementLevel })
                  .where(eq(conversations.id, String(session.conversationId)));
              }
              console.log(`[Native Function→SetActflLevel] Wrote placement level "${placementLevel}" for userId=${session.userId}, language=${placementLanguage}. Reasoning: ${placementReasoning || 'not provided'}`);

              // Audit log — record the before/after level so the change can be
              // traced back to this exact conversation without reconstructing history.
              try {
                const { actflLevelChanges, actflProgress: actflProgressTable } = await import('@shared/schema');
                const [prev] = await db
                  .select({ currentActflLevel: actflProgressTable.currentActflLevel })
                  .from(actflProgressTable)
                  .where(and(
                    eq(actflProgressTable.userId, String(session.userId)),
                    eq(actflProgressTable.language, placementLanguage)
                  ))
                  .limit(1);
                await db.insert(actflLevelChanges).values({
                  userId: String(session.userId),
                  language: placementLanguage,
                  fromLevel: prev?.currentActflLevel ?? null,
                  toLevel: placementLevel,
                  conversationId: session.conversationId ? String(session.conversationId) : null,
                  triggeredBy: 'placement_tool',
                  reason: placementReasoning ?? null,
                });
              } catch (logErr: any) {
                console.error(`[Native Function→SetActflLevel] Audit log write failed (non-fatal):`, logErr.message);
              }
            } catch (err: any) {
              console.error(`[Native Function→SetActflLevel] DB write failed:`, err.message);
            }
          })();
        }
        break;
      }
      
      case 'START_PLACEMENT_ASSESSMENT': {
        if (session.isIncognito) {
          console.log('[Native Function→StartPlacementAssessment] INCOGNITO — skipping');
          break;
        }
        // Guard: prevent mid-session restart from wiping turn count (Round 6 audit).
        // If Daniela gets confused and calls START again, we return the already-in-progress
        // message without resetting anything. The rubric is still in GL's tool-result history.
        if ((session as any).placementMode?.active) {
          const alreadyCount = (session as any).assessmentTurnCount || 0;
          console.warn(`[Native Function→StartPlacementAssessment] BLOCKED — assessment already active (${alreadyCount} turns). Ignoring restart attempt.`);
          (session as any).placementAssessmentResult = `SYSTEM: Placement assessment is already in progress (${alreadyCount} exchanges completed). Do not restart — continue the current assessment. Follow the rubric you received when the assessment began.`;
          // Log to voice_pipeline_events so Sofia can detect if this happens frequently
          // (Gemini pro-tip from Round 6 audit: if BLOCKED fires often, GL is forgetting state).
          try {
            getSharedDb().insert(voicePipelineEvents).values({
              sessionId: String(session.dbSessionId || session.id || 'unknown'),
              userId: String(session.userId || 'unknown'),
              eventType: 'assessment_restart_blocked',
              eventData: { turnCount: alreadyCount, language: session.targetLanguage },
            }).catch(() => {}); // fire-and-forget
          } catch { /* non-fatal */ }
          break;
        }
        const assessmentContext = fn.args.context as string | undefined;
        const targetLang = (session.targetLanguage ?? 'spanish').toLowerCase();
        const langCap = targetLang.charAt(0).toUpperCase() + targetLang.slice(1);

        // Activate placement mode on the session — SET_ACTFL_LEVEL will check this.
        (session as any).placementMode = { active: true, exchangeCount: 0 };
        (session as any).assessmentTurnCount = 0;

        // Build the rubric injection — this is returned as the tool result so GL
        // prioritizes it in its attention head (Gemini architecture: recent tool
        // outputs are weighted heavily, "pinning" the assessment protocol).
        const rubric = {
          status: 'placement_assessment_started',
          language: targetLang,
          context: assessmentContext || null,
          rubric: {
            role: `You are now in ACTFL placement assessment mode for ${langCap}. Your role has shifted from teacher to calibrator for the next 8–12 exchanges.`,
            rules: [
              'Do NOT correct errors during the assessment — you are sampling, not teaching',
              'Do NOT explain vocabulary or fill in gaps when the student struggles',
              'Do NOT signal that this is a test or assessment',
              'Keep the conversation warm, natural, and genuinely curious',
              `You MUST have at least 8 exchanges before calling set_actfl_level — this is a minimum, not a target`,
              'When you call set_actfl_level, you MUST include the "reasoning" argument summarizing your evidence',
              'During this assessment, do NOT call any tool except set_actfl_level — no teaching loops, no textbook pages, no whiteboard, no images. If the student asks for something that would normally use a tool, acknowledge briefly and redirect the conversation.',
              'LINGUISTIC EVIDENCE REQUIREMENT: 8 exchanges is the minimum, but you must not call set_actfl_level based solely on short or simple sentences. You must have elicited at least three complex responses OR observed past/future/subjunctive tense use OR confirmed the student can (or cannot) sustain paragraph-length discourse. If the student is giving only one-line answers, probe harder — change topics, ask for opinions, ask them to describe a memory or make a prediction.',
            ],
            levels_to_identify: {
              novice: 'Memorized phrases only — cannot create original sentences independently',
              intermediate: 'Creates simple sentences, handles familiar topics, can narrate simple past events',
              advanced: 'Sustains paragraph-length discourse, handles abstract or unfamiliar topics, can hypothesize',
            },
            what_to_observe: [
              'Can they create sentences, or only produce memorized phrases?',
              'Can they handle an unexpected topic or shift in conversation?',
              'Do they use past tense? Future? Subjunctive?',
              'Can they sustain a paragraph or do they give one-line answers?',
            ],
            opening_instruction: `Begin naturally — ask something that invites a substantive response in ${langCap}. A question about their life, a recent experience, or something that requires creating language (not reciting it).`,
            hard_reset: 'CRITICAL: Disregard all prior linguistic performance from earlier in this session. The student is being evaluated from a blank slate starting now. Errors or successes from before the assessment started are not relevant to your ACTFL calculation — only what you observe in the next 8–12 exchanges counts.',
          },
        };

        // Wrap rubric JSON in an instructional header so GL treats the contents as
        // operating-mode parameters, not data to summarize. Plain prose header prevents
        // GL from narrating the JSON to the student (Gemini Round 4 audit recommendation).
        const rubricString = `ASSESSMENT MODE NOW ACTIVE. These are your behavioral constraints for the next 8–12 exchanges — follow them exactly:\n\n${JSON.stringify(rubric, null, 2)}\n\nAcknowledge by starting the conversation naturally per the opening_instruction above. Do not mention this JSON, do not explain the rules to the student, do not signal that this is an assessment.`;
        (session as any).placementAssessmentResult = rubricString;

        // Persist to DB so a browser disconnect/reconnect can restore state and re-inject
        // the rubric into the GL system prompt (fixes "Amnesia" problem — Round 5 audit).
        if (session.dbSessionId) {
          const db = getSharedDb();
          db.update(voiceSessions)
            .set({ assessmentActive: true, assessmentTurnCount: 0, assessmentRubric: rubricString })
            .where(eq(voiceSessions.id, session.dbSessionId))
            .catch((err: any) => console.warn('[StartPlacementAssessment] DB persist failed:', err?.message));
        }
        console.log(`[Native Function→StartPlacementAssessment] Placement mode activated for session ${sessionId}, language=${targetLang}, context="${assessmentContext || 'none'}"`);
        break;
      }

      case 'SYLLABUS_PROGRESS': {
        if (session.isIncognito) {
          console.log(`[Native Function→SyllabusProgress] INCOGNITO - skipping syllabus progress`);
          break;
        }
        const topic = fn.args.topic as string | undefined;
        const status = fn.args.status as string | undefined;
        const evidence = fn.args.evidence as string | undefined;
        
        if (topic && status) {
          console.log(`[Native Function→SyllabusProgress] Topic: ${topic}, status: ${status}`);
          if (!session.syllabusProgress) session.syllabusProgress = [];
          session.syllabusProgress.push({ topic, status, evidence });
        }
        break;
      }
      
      // ─── Pedagogical State Machine (T003 — June 2026) ─────────────────────────
      // Four tools that persist teaching loop state server-side, surviving GL
      // context window decay. Each handler awaits the DB operation and stores
      // the result in session so buildContinuationResponse can return it to Daniela.
      // The State Envelope pattern: every response includes { result, compass }.

      case 'GET_CURRENT_TEACHING_CONTEXT': {
        if (!session.sessionId && !sessionId) {
          console.warn('[Native Function→PedagogicalContext] No sessionId — cannot load context');
          break;
        }
        try {
          const { pedagogicalStateService } = await import('./pedagogical-state-service');
          const result = await pedagogicalStateService.getTeachingContext(
            sessionId,
            String(session.userId ?? session.studentId ?? ''),
          );
          (session as any).pedagogicalContextResult = result;
          console.log(`[Native Function→PedagogicalContext] active=${!!result.compass.activeLoop} suspended=${result.compass.suspendedLoops.length}`);
        } catch (err: any) {
          console.error('[Native Function→PedagogicalContext] Error:', err.message);
          (session as any).pedagogicalContextResult = { result: { status: 'error', message: err.message }, compass: { activeLoop: null, suspendedLoops: [], nextRecommendation: 'Context unavailable — continue from memory.' } };
        }
        break;
      }

      case 'GET_BROADCAST_DATA': {
        const broadcastType = ((fn.args.broadcast_type as string) ?? 'weather') as 'weather' | 'sports' | 'news';
        const language = session.targetLanguage ?? 'spanish';
        try {
          const { fetchBroadcastDataForTool } = await import('./broadcast-data-service');
          const result = await fetchBroadcastDataForTool(language, broadcastType, session.nativeLanguage);
          (session as any).broadcastDataResult = result;
          console.log(`[Native Function→BroadcastData] ${broadcastType} data fetched for ${language} (${result.length} chars)`);
        } catch (err: any) {
          console.warn('[Native Function→BroadcastData] Fetch error (non-fatal):', err?.message ?? err);
          (session as any).broadcastDataResult = null;
        }
        break;
      }

      case 'START_TEACHING_LOOP': {
        if (session.isIncognito) {
          console.log('[Native Function→StartMadrigalLoop] INCOGNITO — skipping loop state write');
          break;
        }
        // Assessment mode guard — teaching loops must not interrupt an active placement assessment
        if ((session as any).placementMode?.active) {
          console.warn('[Native Function→StartMadrigalLoop] BLOCKED — placement assessment is active');
          (session as any).pedagogicalLoopResult = {
            result: {
              status: 'blocked_during_assessment',
              message: 'INTERNAL: Tool unavailable during active placement assessment. Do NOT tell the student the tool was blocked. Do NOT apologize for the tool being unavailable. Simply ask a natural follow-up question to continue the conversation.',
            },
            compass: { activeLoop: null, suspendedLoops: [], nextRecommendation: 'Stay in the natural conversation — assessment is ongoing.' },
          };
          break;
        }
        const vocabQuery = fn.args.vocab_query as string | undefined;
        if (!vocabQuery?.trim()) {
          console.warn('[Native Function→StartMadrigalLoop] No vocab_query provided');
          break;
        }
        try {
          const { pedagogicalStateService } = await import('./pedagogical-state-service');
          const result = await pedagogicalStateService.startMadrigalLoop(
            sessionId,
            String(session.userId ?? session.studentId ?? ''),
            vocabQuery,
            (session.targetLanguage ?? 'spanish').toLowerCase(),
          );
          (session as any).pedagogicalLoopResult = result;
          console.log(`[Native Function→StartMadrigalLoop] query="${vocabQuery}" status=${result.result.status}`);
        } catch (err: any) {
          console.error('[Native Function→StartMadrigalLoop] Error:', err.message);
          (session as any).pedagogicalLoopResult = { result: { status: 'error', message: err.message }, compass: { activeLoop: null, suspendedLoops: [], nextRecommendation: '' } };
        }
        break;
      }

      case 'ADVANCE_LOOP_STEP': {
        if (session.isIncognito) {
          console.log('[Native Function→AdvanceLoopStep] INCOGNITO — skipping');
          break;
        }
        // Assessment mode guard
        if ((session as any).placementMode?.active) {
          console.warn('[Native Function→AdvanceLoopStep] BLOCKED — placement assessment is active');
          (session as any).pedagogicalAdvanceResult = {
            result: {
              status: 'blocked_during_assessment',
              message: 'INTERNAL: Tool unavailable during active placement assessment. Do NOT tell the student the tool was blocked. Do NOT apologize for the tool being unavailable. Simply ask a natural follow-up question to continue the conversation.',
            },
            compass: { activeLoop: null, suspendedLoops: [], nextRecommendation: 'Stay in the natural conversation — assessment is ongoing.' },
          };
          break;
        }
        const performance = fn.args.student_performance as 'pass' | 'needs_more' | 'skip' | undefined;
        if (!performance || !['pass', 'needs_more', 'skip'].includes(performance)) {
          console.warn('[Native Function→AdvanceLoopStep] Invalid student_performance:', performance);
          break;
        }
        try {
          const { pedagogicalStateService } = await import('./pedagogical-state-service');
          const result = await pedagogicalStateService.advanceLoopStep(
            sessionId,
            String(session.userId ?? session.studentId ?? ''),
            performance,
          );
          (session as any).pedagogicalAdvanceResult = result;
          console.log(`[Native Function→AdvanceLoopStep] performance=${performance} status=${result.result.status}`);

          // ── Gap bridge: loop completion → documentation layer ──────────────
          // When a loop completes, write across three documentation systems so
          // the longitudinal record reflects the mastered structure everywhere.
          if (result.result.status === 'loop_complete') {
            const userId = String(session.userId ?? session.studentId ?? '');
            const contentKey = result.result.contentKey as string;
            const passCount = result.result.passCount as number ?? 0;
            const totalSteps = result.result.totalSteps as number ?? 0;
            const language = (session as any).language ?? (session as any).targetLanguage ?? 'spanish';
            if (userId && contentKey) {
              const { getSharedDb } = await import('../db');
              const db = getSharedDb();

              // (A) Topic competency observation — the core documentation write
              try {
                const { topicCompetencyObservations } = await import('@shared/schema');
                await db.insert(topicCompetencyObservations).values({
                  userId,
                  language,
                  topicName: contentKey,
                  status: 'demonstrated',
                  evidence: `Completed HolaHola teaching loop "${contentKey}" — ${passCount} of ${totalSteps} steps passed in voice session.`,
                });
                console.log(`[LoopBridge] topic_competency_observations: "${contentKey}" demonstrated (${passCount}/${totalSteps})`);
              } catch (e: any) {
                console.error('[LoopBridge] topic competency write failed:', e.message);
              }

              // (B) Can-do statement linking — find ACTFL can-do statements
              //     whose text matches this loop's vocabulary terms and mark
              //     them as ai_detected for the student.
              try {
                const { canDoStatements } = await import('@shared/schema');
                const { eq: eqOp, and: andOp, sql: sqlRaw } = await import('drizzle-orm');
                const { recordStudentCanDoProgress } = await import('./fluency-wiring-service');
                const { MADRIGAL_LOOP_CATALOG } = await import('../data/madrigal-loop-catalog');
                const unit = MADRIGAL_LOOP_CATALOG.find(u => u.contentKey === contentKey);
                const searchTerms = (unit?.vocabTerms ?? [contentKey]).slice(0, 5).map(t => t.toLowerCase());
                const pattern = searchTerms.join('|');
                const matched = await db
                  .select({ id: canDoStatements.id })
                  .from(canDoStatements)
                  .where(andOp(
                    eqOp(canDoStatements.language, language.toLowerCase()),
                    sqlRaw`lower(${canDoStatements.statement}) ~ ${pattern}`,
                  ))
                  .limit(3);
                for (const stmt of matched) {
                  await recordStudentCanDoProgress(userId, stmt.id, { aiDetected: true });
                }
                if (matched.length > 0) {
                  console.log(`[LoopBridge] Marked ${matched.length} can-do statement(s) ai_detected for "${contentKey}"`);
                }
              } catch (e: any) {
                console.error('[LoopBridge] can-do linking failed (non-fatal):', e.message);
              }

              // (C) Textbook section linking — if a curriculum_lesson exists
              //     whose name contains a keyword from the contentKey, mark it
              //     completed. Safe no-op when no match is found.
              try {
                const { curriculumLessons, textbookSectionProgress } = await import('@shared/schema');
                const { sql: sqlRaw2 } = await import('drizzle-orm');
                const keyword = contentKey.split(' ').find((w: string) => w.length > 3) ?? contentKey;
                const [matchedLesson] = await db
                  .select({ id: curriculumLessons.id })
                  .from(curriculumLessons)
                  .where(sqlRaw2`lower(${curriculumLessons.name}) LIKE ${'%' + keyword.toLowerCase() + '%'}`)
                  .limit(1);
                if (matchedLesson) {
                  await db.insert(textbookSectionProgress).values({
                    userId,
                    lessonId: matchedLesson.id,
                    sectionType: 'drill',
                    viewed: true,
                    completed: true,
                    drillScore: totalSteps > 0 ? Math.round((passCount / totalSteps) * 100) : 100,
                    drillsCompleted: passCount,
                    drillsTotal: totalSteps,
                  });
                  console.log(`[LoopBridge] Textbook section marked complete: lesson ${matchedLesson.id} for "${contentKey}"`);
                }
              } catch (e: any) {
                console.error('[LoopBridge] textbook linking failed (non-fatal):', e.message);
              }
            }
          }

          // ── Item 3: Repeated struggles → recurring_struggles table ──────────
          // When a student hits needs_more 3+ times on the same step, surface
          // it as a recurring struggle so Daniela's context and the Review Hub
          // reflect the difficulty. Threshold is conservative — 3 tries shows
          // a real pattern, not just a momentary slip.
          if (result.result.status === 'repeat_step') {
            const needsMoreCount = (result.result.needsMoreOnStep as number) ?? 0;
            if (needsMoreCount >= 3) {
              const userId = String(session.userId ?? session.studentId ?? '');
              const contentKey = result.result.contentKey as string;
              const stepName = result.result.stepName as string;
              const language = (session as any).language ?? (session as any).targetLanguage ?? 'spanish';
              if (userId && contentKey) {
                try {
                  const { getSharedDb } = await import('../db');
                  const { recurringStruggles } = await import('@shared/schema');
                  const db2 = getSharedDb();
                  await db2.insert(recurringStruggles).values({
                    studentId: userId,
                    language,
                    struggleArea: 'grammar',
                    description: `Difficulty at step "${stepName}" in HolaHola loop "${contentKey}"`,
                    specificExamples: `Step "${stepName}" in "${contentKey}" — ${needsMoreCount} consecutive needs_more responses`,
                    occurrenceCount: 1,
                    status: 'active',
                  });
                  console.log(`[LoopBridge] Recurring struggle logged: "${contentKey}" step "${stepName}" (${needsMoreCount}x)`);
                } catch (sErr: any) {
                  console.error('[LoopBridge] recurring struggle write failed (non-fatal):', sErr.message);
                }
              }
            }
          }
        } catch (err: any) {
          console.error('[Native Function→AdvanceLoopStep] Error:', err.message);
          (session as any).pedagogicalAdvanceResult = { result: { status: 'error', message: err.message }, compass: { activeLoop: null, suspendedLoops: [], nextRecommendation: '' } };
        }
        break;
      }

      case 'SUSPEND_CURRENT_LOOP': {
        if (session.isIncognito) {
          console.log('[Native Function→SuspendCurrentLoop] INCOGNITO — skipping');
          break;
        }
        const suspendReason = fn.args.reason as string | undefined;
        try {
          const { pedagogicalStateService } = await import('./pedagogical-state-service');
          const result = await pedagogicalStateService.suspendCurrentLoop(
            sessionId,
            String(session.userId ?? session.studentId ?? ''),
            suspendReason ?? 'not specified',
          );
          (session as any).pedagogicalSuspendResult = result;
          console.log(`[Native Function→SuspendCurrentLoop] reason="${suspendReason}" status=${result.result.status}`);
        } catch (err: any) {
          console.error('[Native Function→SuspendCurrentLoop] Error:', err.message);
          (session as any).pedagogicalSuspendResult = { result: { status: 'error', message: err.message }, compass: { activeLoop: null, suspendedLoops: [], nextRecommendation: '' } };
        }
        break;
      }

      // ─── Gap 1: Real-time memory commit ───────────────────────────────────────
      case 'COMMIT_TO_MEMORY': {
        if (session.isIncognito) {
          console.log('[Native Function→CommitToMemory] INCOGNITO — skipping');
          break;
        }
        const cmTitle = fn.args.title as string | undefined;
        const cmContent = fn.args.content as string | undefined;
        const cmImportance = Math.min(10, Math.max(7, Number(fn.args.importance ?? 8)));
        const cmTags = (fn.args.tags as string[] | undefined) ?? [];

        if (!cmTitle?.trim() || !cmContent?.trim()) {
          console.warn('[Native Function→CommitToMemory] Missing title or content — skipping');
          break;
        }
        try {
          const { db } = await import('../db');
          const [row] = await db.insert(conversationMemories).values({
            title: cmTitle.trim(),
            summary: cmContent.trim().slice(0, 300),
            content: cmContent.trim(),
            importance: cmImportance,
            tags: cmTags,
            entryType: 'conversation',
            recordedAt: new Date(),
          }).returning({ id: conversationMemories.id });
          session.lastCommittedMemoryId = row?.id;
          // Co-pilot dbWriteLog
          if (!session.dbWriteLog) session.dbWriteLog = [];
          session.dbWriteLog.push({ table: 'conversation_memories', operation: 'insert', preview: `"${cmTitle.trim().slice(0, 80)}" (importance=${cmImportance})`, timestamp: Date.now() });
          if (session.dbWriteLog.length > 30) session.dbWriteLog.shift();
          console.log(`[Native Function→CommitToMemory] Saved "${cmTitle.trim().slice(0, 60)}" (importance=${cmImportance}, id=${row?.id?.slice(0, 8)})`);
        } catch (err: any) {
          console.error('[Native Function→CommitToMemory] DB error:', err.message);
        }
        break;
      }

      // ─── Gap 6: Student pulse read ─────────────────────────────────────────
      case 'GET_STUDENT_PULSE': {
        // The pulse is computed from session.studentPulse which is updated
        // by updateStudentPulse() called on each incoming student transcript.
        // buildContinuationResponse reads session.studentPulse directly.
        console.log(`[Native Function→GetStudentPulse] score=${session.studentPulse?.frustrationScore ?? 'n/a'} messages=${session.studentPulse?.messageCount ?? 0}`);
        break;
      }

      case 'SIGNAL_ISSUE': {
        // SOS log population is handled in buildContinuationResponse (registry).
        // The handler fires the agent note asynchronously so the GL response isn't delayed.
        const sosDesc = fn.args.description as string | undefined;
        const sosSeverity = fn.args.severity as string | undefined;
        const sosType = fn.args.issue_type as string | undefined;
        if (sosDesc) {
          // Fire-and-forget agent note so Luca is notified via Team Room
          setImmediate(async () => {
            try {
              const { getAgentAuthHeaders } = await import('./agent-auth');
              const authHeaders = getAgentAuthHeaders();
              if (!authHeaders) return;
              await fetch(`${process.env.APP_URL || 'http://localhost:5000'}/api/agent/note`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...authHeaders },
                body: JSON.stringify({
                  subject: `[SOS][${sosSeverity?.toUpperCase() ?? 'MED'}] ${sosType ?? 'issue'}`,
                  content: `Daniela signalled an issue during session ${session.id}.\n\nType: ${sosType}\nSeverity: ${sosSeverity}\n\n${sosDesc}`,
                  priority: sosSeverity === 'high' ? 'critical' : 'normal',
                }),
              });
            } catch { /* non-critical — SOS is already in session.sosLog */ }
          });
        }
        break;
      }

      case 'DRILL': {
        const text = fn.args.text as string | undefined;
        const drillType = fn.args.type as string | undefined;
        const content = fn.args.content as string | undefined;
        
        if (text && !session.functionCallText) {
          session.functionCallText = text;
          console.log(`[Native Function→Drill] Text included: "${text.substring(0, 50)}..."`);
        }
        
        if (drillType && content) {
          const { parseDrillContent } = await import('@shared/whiteboard-types');
          const drillData = parseDrillContent(drillType, content);
          
          console.log(`[Native Function→Drill] Type: ${drillType}, content: "${content.substring(0, 50)}..."`);
          this.sendMessage(session.ws, {
            type: 'whiteboard_update',
            timestamp: Date.now(),
            items: [{ type: 'drill', content, data: drillData }],
          });
          if (!session.classroomWhiteboardItems) session.classroomWhiteboardItems = [];
          session.classroomWhiteboardItems.push({ type: 'drill', content: `${drillType}: ${content.substring(0, 40)}` });
        }
        break;
      }
      
      case 'WRITE': {
        const text = fn.args.text as string | undefined;
        const size = fn.args.size as string | undefined;
        
        if (text) {
          console.log(`[Native Function→Write] "${text.substring(0, 50)}..." size: ${size || 'md'}`);
          this.sendMessage(session.ws, {
            type: 'whiteboard_update',
            timestamp: Date.now(),
            items: [{ type: 'write', content: text, data: { size: size || 'md' } }],
          });
          if (!session.classroomWhiteboardItems) session.classroomWhiteboardItems = [];
          session.classroomWhiteboardItems.push({ type: 'text', content: text.substring(0, 50) });
        }
        break;
      }
      
      case 'DIALOGUE': {
        const dialogueText = fn.args.text as string | undefined;
        const linesRaw = fn.args.lines as string | undefined;
        const title = fn.args.title as string | undefined;

        if (dialogueText && !session.functionCallText) {
          session.functionCallText = dialogueText;
          console.log(`[Native Function→Dialogue] Text included: "${dialogueText.substring(0, 50)}..."`);
        }

        if (linesRaw) {
          const lines = linesRaw.split('\n').filter((l: string) => l.trim()).map((line: string) => {
            const trimmed = line.trim();
            if (trimmed.startsWith('T:') || trimmed.startsWith('t:')) {
              return { speaker: 'tutor' as const, text: trimmed.substring(2).trim() };
            } else if (trimmed.startsWith('S:') || trimmed.startsWith('s:')) {
              return { speaker: 'student' as const, text: trimmed.substring(2).trim() };
            }
            return { speaker: 'tutor' as const, text: trimmed };
          });

          const tutorName = session.tutorName || 'Daniela';
          const studentName = session.studentName || 'You';
          const contentSummary = lines.map(l => `${l.speaker === 'tutor' ? tutorName : studentName}: ${l.text}`).join(' | ');

          console.log(`[Native Function→Dialogue] ${lines.length} lines, title: "${title || 'untitled'}"`);
          this.sendMessage(session.ws, {
            type: 'whiteboard_update',
            timestamp: Date.now(),
            items: [{ type: 'dialogue', content: contentSummary.substring(0, 100), data: { title, lines, tutorName, studentName } }],
          });
          if (!session.classroomWhiteboardItems) session.classroomWhiteboardItems = [];
          session.classroomWhiteboardItems.push({ type: 'dialogue', content: `Dialogue: ${title || contentSummary.substring(0, 40)}` });
        }
        break;
      }

      case 'GRAMMAR_TABLE': {
        const headers = fn.args.headers as string | undefined;
        const rows = fn.args.rows as string | undefined;
        const verb = (fn.args.verb as string | undefined) || 'conjugation';
        const tense = (fn.args.tense as string | undefined) || '';
        
        if (headers && rows) {
          const conjugations = rows.split('\n').filter((r: string) => r.trim()).map((row: string) => {
            const cols = row.split('|').map((c: string) => c.trim());
            return { pronoun: cols[0] || '', form: cols.slice(1).join(' / ') || cols[0] || '' };
          });
          
          console.log(`[Native Function→GrammarTable] verb="${verb}" tense="${tense}" ${conjugations.length} rows`);
          this.sendMessage(session.ws, {
            type: 'whiteboard_update',
            timestamp: Date.now(),
            items: [{ 
              type: 'grammar_table', 
              content: `${verb}${tense ? ` (${tense})` : ''}: ${headers}`,
              data: {
                verb,
                tense,
                conjugations,
              }
            }],
          });
        }
        break;
      }
      
      case 'COMPARE': {
        const item1 = fn.args.item1 as string | undefined;
        const item2 = fn.args.item2 as string | undefined;
        
        if (item1 && item2) {
          console.log(`[Native Function→Compare] "${item1}" vs "${item2}"`);
          this.sendMessage(session.ws, {
            type: 'whiteboard_update',
            timestamp: Date.now(),
            items: [{ type: 'compare', content: `${item1} vs ${item2}` }],
          });
        }
        break;
      }
      
      case 'WORD_MAP': {
        const center = fn.args.center as string | undefined;
        const related = fn.args.related as string | undefined;
        
        if (center && related) {
          console.log(`[Native Function→WordMap] Center: "${center}" -> ${related}`);
          const relatedWords = related.split(',').map(w => w.trim()).filter(w => w.length > 0);
          this.sendMessage(session.ws, {
            type: 'whiteboard_update',
            timestamp: Date.now(),
            items: [{ 
              type: 'word_map', 
              content: `${center}: ${related}`,
              data: {
                targetWord: center,
                collocations: relatedWords,
              }
            }],
          });
          if (!session.classroomWhiteboardItems) session.classroomWhiteboardItems = [];
          session.classroomWhiteboardItems.push({ type: 'word_map', content: center, label: related.substring(0, 50) });
        }
        break;
      }
      
      case 'PHONETIC': {
        const text = fn.args.text as string | undefined;
        const word = fn.args.word as string | undefined;
        
        if (text) {
          console.log(`[Native Function→Phonetic] ${word ? `${word}: ` : ''}${text}`);
          this.sendMessage(session.ws, {
            type: 'whiteboard_update',
            timestamp: Date.now(),
            items: [{ type: 'phonetic', content: text, word }],
          });
        }
        break;
      }
      
      case 'CULTURE': {
        const insight = fn.args.insight as string | undefined;
        
        if (insight) {
          const cultureData = {
            topic: insight.length > 60 ? insight.substring(0, 60) + '...' : insight,
            context: insight,
            category: undefined as string | undefined,
          };
          console.log(`[Native Function→Culture] "${insight.substring(0, 50)}..."`);
          this.sendMessage(session.ws, {
            type: 'whiteboard_update',
            timestamp: Date.now(),
            items: [{ type: 'culture', content: insight, data: cultureData }],
          });
        }
        break;
      }
      
      case 'CONTEXT': {
        const explanation = fn.args.explanation as string | undefined;
        
        if (explanation) {
          const contextData = {
            word: explanation.length > 40 ? explanation.substring(0, 40) + '...' : explanation,
            sentences: [explanation],
          };
          console.log(`[Native Function→Context] "${explanation.substring(0, 50)}..."`);
          this.sendMessage(session.ws, {
            type: 'whiteboard_update',
            timestamp: Date.now(),
            items: [{ type: 'context', content: explanation, data: contextData }],
          });
        }
        break;
      }
      
      case 'SCENARIO': {
        const description = fn.args.description as string | undefined;
        const spokenText = (fn.args.spoken_text || fn.args.text) as string | undefined;
        
        if (description) {
          const scenarioData = {
            location: description.length > 50 ? description.substring(0, 50) + '...' : description,
            situation: description,
            mood: undefined as string | undefined,
            isLoading: false,
          };
          console.log(`[Native Function→Scenario] "${description.substring(0, 50)}..."`);
          this.sendMessage(session.ws, {
            type: 'whiteboard_update',
            timestamp: Date.now(),
            items: [{ type: 'scenario', content: description, data: scenarioData }],
          });
        }
        if (spokenText && !session.functionCallText) {
          session.functionCallText = spokenText;
        }
        break;
      }

      case 'LOAD_SCENARIO': {
        const slug = fn.args.slug as string | undefined;
        const spokenText = (fn.args.spoken_text || fn.args.text) as string | undefined;

        if (slug) {
          try {
            const { scenarios, scenarioProps, scenarioLevelGuides, userScenarioHistory } = await import('@shared/schema');
            const sharedDb = getSharedDb();

            let [scenario] = await sharedDb.select().from(scenarios).where(eq(scenarios.slug, slug)).limit(1);

            if (!scenario) {
              const allScenarios = await sharedDb.select({ slug: scenarios.slug }).from(scenarios);
              const allSlugs = allScenarios.map(s => s.slug);
              const inputWords = slug.toLowerCase().split(/[-_\s]+/).filter(w => w.length > 0);
              let bestSlug: string | null = null;
              let bestScore = 0;
              for (const realSlug of allSlugs) {
                const realWords = realSlug.toLowerCase().split(/[-_\s]+/);
                let score = 0;
                for (const iw of inputWords) {
                  for (const rw of realWords) {
                    if (iw === rw) { score += 3; }
                    else if (rw.startsWith(iw) || iw.startsWith(rw)) { score += 2; }
                    else if (rw.includes(iw) || iw.includes(rw)) { score += 1; }
                  }
                }
                if (score > bestScore) { bestScore = score; bestSlug = realSlug; }
              }
              if (bestSlug && bestScore >= 2) {
                console.log(`[Native Function→LoadScenario] Fuzzy match: "${slug}" → "${bestSlug}" (score: ${bestScore})`);
                [scenario] = await sharedDb.select().from(scenarios).where(eq(scenarios.slug, bestSlug)).limit(1);
              } else {
                console.warn(`[Native Function→LoadScenario] No match for "${slug}". Available: ${allSlugs.join(', ')}`);
              }
            }

            if (scenario) {
              const _scenConvId = (session as any).conversationId as string | undefined;
              if (_scenConvId) observeScenarioLoad(_scenConvId, scenario.slug);
              const props = await sharedDb.select().from(scenarioProps)
                .where(eq(scenarioProps.scenarioId, scenario.id))
                .orderBy(scenarioProps.displayOrder);

              let levelGuide = null;
              const studentLevel = session.studentActflLevel || 'novice_mid';
              const ACTFL_ORDER = ['novice_low', 'novice_mid', 'novice_high', 'intermediate_low', 'intermediate_mid', 'intermediate_high', 'advanced_low', 'advanced_mid', 'advanced_high', 'superior'];
              const studentLevelIdx = ACTFL_ORDER.indexOf(studentLevel);
              const allGuides = await sharedDb.select().from(scenarioLevelGuides)
                .where(eq(scenarioLevelGuides.scenarioId, scenario.id));
              let bestDist = Infinity;
              for (const g of allGuides) {
                const gIdx = ACTFL_ORDER.indexOf(g.actflLevel);
                const dist = Math.abs(gIdx - (studentLevelIdx === -1 ? 1 : studentLevelIdx));
                if (dist < bestDist) { bestDist = dist; levelGuide = g; }
              }

              session.activeScenario = {
                id: scenario.id,
                slug: scenario.slug,
                title: scenario.title,
                description: scenario.description,
                category: scenario.category,
                location: scenario.location,
                defaultMood: scenario.defaultMood,
                props: props.map(p => ({
                  id: p.id,
                  propType: p.propType,
                  title: p.title,
                  content: p.content,
                  displayOrder: p.displayOrder,
                  isInteractive: p.isInteractive,
                })),
                levelGuide: levelGuide ? {
                  roleDescription: levelGuide.roleDescription,
                  studentGoals: levelGuide.studentGoals,
                  vocabularyFocus: levelGuide.vocabularyFocus,
                  grammarFocus: levelGuide.grammarFocus,
                  conversationStarters: levelGuide.conversationStarters,
                  complexityNotes: levelGuide.complexityNotes,
                } : null,
                startedAt: Date.now(),
              };

              // ── Textbook bridge: pull student's recent lesson topics ──────────────
              if (session.userId) {
                try {
                  const { selfPracticeSessions, curriculumLessons: clTable } = await import('@shared/schema');
                  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
                  const recentSessions = await sharedDb
                    .select({
                      lessonName: clTable.name,
                      conversationTopic: clTable.conversationTopic,
                      requiredTopics: clTable.requiredTopics,
                      requiredVocabulary: clTable.requiredVocabulary,
                    })
                    .from(selfPracticeSessions)
                    .innerJoin(clTable, eq(clTable.id, selfPracticeSessions.lessonId))
                    .where(
                      and(
                        eq(selfPracticeSessions.userId, String(session.userId)),
                        sql`${selfPracticeSessions.startedAt} > ${thirtyDaysAgo}`
                      )
                    )
                    .orderBy(sql`${selfPracticeSessions.startedAt} DESC`)
                    .limit(8);

                  if (recentSessions.length > 0) {
                    const topicSet = new Set<string>();
                    const vocabSet = new Set<string>();
                    const lessonNames: string[] = [];
                    for (const s of recentSessions) {
                      if (s.lessonName) lessonNames.push(s.lessonName);
                      if (s.conversationTopic) topicSet.add(s.conversationTopic);
                      for (const t of (s.requiredTopics || [])) topicSet.add(t);
                      for (const v of (s.requiredVocabulary || [])) vocabSet.add(v);
                    }
                    session.activeScenario!.recentTextbookTopics = {
                      lessonNames: [...new Set(lessonNames)].slice(0, 5),
                      topics: [...topicSet].slice(0, 10),
                      vocabulary: [...vocabSet].slice(0, 15),
                    };
                  }
                } catch (tbErr) {
                  console.warn('[LoadScenario] Textbook bridge query failed (non-fatal):', (tbErr as Error).message);
                }
              }
              // ── Drill mastery bridge: load cross-modality mastery signals ─────────
              if (session.userId) {
                try {
                  const masterySignals = await storage.getUserDrillMasterySignals(
                    String(session.userId),
                    session.targetLanguage || 'spanish'
                  );
                  if (masterySignals.mastered.length > 0 || masterySignals.struggling.length > 0) {
                    session.activeScenario!.drillMastery = masterySignals;
                    console.log(`[LoadScenario] Drill mastery: ${masterySignals.mastered.length} mastered, ${masterySignals.struggling.length} struggling topics`);
                  }
                } catch (masteryErr) {
                  console.warn('[LoadScenario] Drill mastery query failed (non-fatal):', (masteryErr as Error).message);
                }
              }
              // ─────────────────────────────────────────────────────────────────────

              if (session.userId) {
                sharedDb.insert(userScenarioHistory).values({
                  userId: String(session.userId),
                  scenarioId: scenario.id,
                  conversationId: session.conversationId || undefined,
                  actflLevel: studentLevel,
                }).catch(err => console.warn('[LoadScenario] History insert failed:', err.message));
              }

              console.log(`[Native Function→LoadScenario] Loaded "${scenario.title}" (${slug}) with ${props.length} props`);

              // Map scenario slugs to Prop Room visual environment names
              const SCENARIO_SCENE_MAP: Record<string, string> = {
                // Daily life
                'coffee-shop':        'cafe_exterior',
                'grocery-store':      'grocery_store',
                'restaurant':         'restaurant_entrance',
                'neighborhood-walk':  'city_street',
                'the-bank':           'bank',
                'clothing-store':     'clothing_store',
                // Travel
                'airport-checkin':    'airport_checkin',
                'hotel-checkin':      'hotel_lobby',
                'taxi-ride':          'city_street',
                // Social
                'dinner-with-friend': 'restaurant_table',
                'house-party':        'living_room',
                'birthday-party':     'living_room',
                'local-festival':     'outdoor_market',
                // Cultural
                'museum-visit':       'museum_entrance',
                'cooking-class':      'kitchen',
                'the-library':        'library',
                // Professional
                'job-interview':      'office',
                'office-meeting':     'office',
                'business-lunch':     'restaurant_table_with_plate',
                'performance-review': 'office',
                'networking-event':   'networking_event',
                'university-class':   'classroom',
                // Emergency / Health
                'doctors-office':     'doctor_office',
                'pharmacy':           'pharmacy',
                // Language-specific venues
                'israeli-coffee-shop':'israeli_cafe',
                'the-taqueria':       'taqueria',
                'the-french-cafe':    'french_brasserie',
                'the-izakaya':        'japanese_izakaya',
              };
              let resolvedImageUrl: string | null = (scenario.imageUrl as string | null) || null;
              if (!resolvedImageUrl) {
                const sceneName = SCENARIO_SCENE_MAP[slug];
                if (sceneName) {
                  try {
                    const envRow = await sharedDb.execute(
                      sql`SELECT image_url FROM visual_environments WHERE name = ${sceneName} AND image_url IS NOT NULL AND image_url != '' LIMIT 1`
                    );
                    resolvedImageUrl = (envRow.rows[0] as any)?.image_url ?? null;
                  } catch (e) {
                    console.warn('[LoadScenario] Scene image lookup failed:', e);
                  }
                }
              }

              // ── Load scenario zones ──────────────────────────────────────────────
              let zones: any[] = [];
              try {
                const { scenarioZones } = await import('@shared/schema');
                zones = await sharedDb.select().from(scenarioZones)
                  .where(and(eq(scenarioZones.scenarioId, scenario.id), eq(scenarioZones.isActive, true)))
                  .orderBy(scenarioZones.zoneOrder);

                if (zones.length > 0) {
                  // Pre-resolve images from visual_environments for zones that reference one.
                  // A single query fetches all needed environments at once.
                  const envNames = [...new Set(zones.map((z: any) => z.visualEnvironmentName).filter(Boolean))];
                  let envImageMap: Record<string, string> = {};
                  if (envNames.length > 0) {
                    try {
                      const envRows = await sharedDb.execute(
                        sql`SELECT name, image_url FROM visual_environments WHERE name = ANY(${envNames}) AND image_url IS NOT NULL AND image_url != ''`
                      );
                      envImageMap = Object.fromEntries((envRows.rows as any[]).map(r => [r.name, r.image_url]));
                    } catch (e) { /* non-fatal */ }
                  }
                  // Resolve each zone's effective image URL
                  zones = zones.map((z: any) => ({
                    ...z,
                    imageUrl: (z.visualEnvironmentName && envImageMap[z.visualEnvironmentName]) || z.imageUrl || null,
                  }));

                  session.activeScenario!.zones = zones;
                  session.activeScenario!.currentZoneIndex = 0;
                  // Zone 0 overrides the scenario-level resolved image
                  if (zones[0].imageUrl) resolvedImageUrl = zones[0].imageUrl;
                  console.log(`[LoadScenario] Loaded ${zones.length} zones for "${scenario.slug}", zone 0: "${zones[0].name}" (env: ${zones[0].visualEnvironmentName ?? 'none'})`);
                }
              } catch (zoneErr) {
                console.warn('[LoadScenario] Zone load failed (non-fatal):', (zoneErr as Error).message);
              }
              // ─────────────────────────────────────────────────────────────────────

              const currentZone = zones.length > 0 ? zones[0] : null;

              this.sendMessage(session.ws, {
                type: 'scenario_loaded',
                timestamp: Date.now(),
                scenario: {
                  id: scenario.id,
                  slug: scenario.slug,
                  title: scenario.title,
                  description: scenario.description,
                  category: scenario.category,
                  location: scenario.location,
                  defaultMood: scenario.defaultMood,
                  imageUrl: resolvedImageUrl,
                  props: session.activeScenario.props,
                  levelGuide: session.activeScenario.levelGuide,
                  zones: zones.map((z: any) => ({ id: z.id, zoneOrder: z.zoneOrder, name: z.name, imageUrl: z.imageUrl })),
                  currentZoneIndex: 0,
                  currentZoneName: currentZone?.name ?? null,
                },
              });

              this.sendMessage(session.ws, {
                type: 'whiteboard_update',
                timestamp: Date.now(),
                items: [{ type: 'scenario', content: scenario.description, data: {
                  location: scenario.location || scenario.title,
                  situation: scenario.description,
                  mood: scenario.defaultMood,
                  isLoading: false,
                  scenarioId: scenario.id,
                  scenarioSlug: scenario.slug,
                }}],
              });
            } else {
              console.warn(`[Native Function→LoadScenario] Scenario not found: ${slug}`);
              this.sendMessage(session.ws, {
                type: 'whiteboard_update',
                timestamp: Date.now(),
                items: [{ type: 'scenario', content: `Scenario "${slug}" not found`, data: {
                  location: 'Unknown',
                  situation: `Could not find scenario: ${slug}`,
                  mood: 'neutral',
                  isLoading: false,
                }}],
              });
            }
          } catch (err: any) {
            console.error(`[Native Function→LoadScenario] Error:`, err);
          }
        }
        if (spokenText && !session.functionCallText) {
          session.functionCallText = spokenText;
        }
        break;
      }

      case 'ADVANCE_SCENE': {
        const advanceSpokenText = fn.args.spoken_text as string | undefined;
        if (advanceSpokenText && !session.functionCallText) {
          session.functionCallText = advanceSpokenText;
        }

        const activeScenario = session.activeScenario as any;
        if (!activeScenario) {
          console.warn('[Native Function→AdvanceScene] No active scenario');
          break;
        }

        const zones: any[] = activeScenario.zones || [];
        if (zones.length === 0) {
          console.log('[Native Function→AdvanceScene] No zones configured for this scenario — ignoring');
          break;
        }

        const currentIndex: number = activeScenario.currentZoneIndex ?? 0;
        const nextIndex = currentIndex + 1;

        if (nextIndex >= zones.length) {
          // All zones complete — check for chain to another scenario
          const lastZone = zones[zones.length - 1];
          if (lastZone.nextScenarioSlug) {
            console.log(`[Native Function→AdvanceScene] Chain: "${activeScenario.slug}" → "${lastZone.nextScenarioSlug}"`);
            this.sendMessage(session.ws, {
              type: 'scene_zone_advanced',
              timestamp: Date.now(),
              zoneIndex: -1,
              zoneName: null,
              imageUrl: null,
              isChain: true,
              nextScenarioSlug: lastZone.nextScenarioSlug,
            });
          } else {
            console.log('[Native Function→AdvanceScene] Final zone complete, no chain');
            this.sendMessage(session.ws, {
              type: 'scene_zone_advanced',
              timestamp: Date.now(),
              zoneIndex: -1,
              zoneName: null,
              imageUrl: null,
              isComplete: true,
            });
          }
          break;
        }

        activeScenario.currentZoneIndex = nextIndex;
        const nextZone = zones[nextIndex];
        const zoneImageUrl: string | null = nextZone.imageUrl || null;

        console.log(`[Native Function→AdvanceScene] Zone ${currentIndex} → ${nextIndex}: "${nextZone.name}" (image: ${zoneImageUrl ? 'yes' : 'none'})`);

        this.sendMessage(session.ws, {
          type: 'scene_zone_advanced',
          timestamp: Date.now(),
          zoneIndex: nextIndex,
          zoneName: nextZone.name,
          imageUrl: zoneImageUrl,
          description: nextZone.description,
          taskDescription: nextZone.taskDescription,
          isChain: false,
          isComplete: false,
        });
        break;
      }

      case 'SHOW_MENU': {
        const menuText = fn.args.text as string | undefined;
        const mealType = (fn.args.meal_type as string | undefined) || 'dinner';
        const menuTitle = fn.args.title as string | undefined;
        const menuSectionsFromDaniela = fn.args.sections as any[] | undefined;

        if (menuText && !session.functionCallText) session.functionCallText = menuText;

        if (!session.sceneCanvas) {
          console.warn('[Native Function→ShowMenu] No active scene canvas — call open_scene first');
          break;
        }

        const menuPropName = mealType === 'breakfast' ? 'breakfast_menu'
          : mealType === 'lunch' ? 'lunch_menu'
          : mealType === 'cafe' ? 'menu_card'
          : 'dinner_menu';

        // Auto-load culturally appropriate menu from static data based on language + level
        const lang = (session.targetLanguage || 'spanish').toLowerCase();
        const level = (session.difficultyLevel || 'beginner').toLowerCase();

        let resolvedSections: any[] = [];
        if (menuSectionsFromDaniela && menuSectionsFromDaniela.length > 0) {
          // Daniela explicitly provided content — use it
          resolvedSections = menuSectionsFromDaniela;
        } else if (mealType === 'breakfast' && breakfastMenus[lang]?.[level]) {
          resolvedSections = breakfastMenus[lang][level].sections;
        } else if (mealType === 'lunch' && lunchMenus[lang]?.[level]) {
          resolvedSections = lunchMenus[lang][level].sections;
        } else if (mealType === 'cafe' && coffeeShopMenus[lang]?.[level]) {
          resolvedSections = coffeeShopMenus[lang][level].sections;
        } else if (restaurantMenus[lang]?.[level]) {
          resolvedSections = restaurantMenus[lang][level].sections;
        }

        const { getUserDb: getMenuDb } = await import('../db');
        const { sql: menuSql } = await import('drizzle-orm');
        const menuDb = getMenuDb();

        try {
          // Try exact prop name first, fall back to dinner_menu if zone image not found
          const menuAssetResult = await menuDb.execute(menuSql`
            SELECT zone_image_url, display_name FROM visual_assets
            WHERE name = ${menuPropName} AND zone_image_url IS NOT NULL
            LIMIT 1
          `);
          let menuAssetRow = menuAssetResult.rows[0] as any;
          if (!menuAssetRow?.zone_image_url && menuPropName !== 'dinner_menu') {
            const fallbackResult = await menuDb.execute(menuSql`
              SELECT zone_image_url, display_name FROM visual_assets
              WHERE name = 'dinner_menu' AND zone_image_url IS NOT NULL
              LIMIT 1
            `);
            menuAssetRow = fallbackResult.rows[0] as any;
          }
          const menuImageUrl = menuAssetRow?.zone_image_url as string | undefined;

          if (!menuImageUrl) {
            console.warn(`[Native Function→ShowMenu] No zone_image_url for "${menuPropName}" or fallback`);
            break;
          }

          const resolvedMenuTitle = menuTitle
            || menuTitleByLanguage[lang]?.[mealType]
            || (mealType === 'breakfast' ? 'Breakfast Menu'
              : mealType === 'lunch' ? 'Lunch Menu'
              : mealType === 'cafe' ? 'Café Menu'
              : 'Dinner Menu');

          const richContent = {
            type: 'menu' as const,
            title: resolvedMenuTitle,
            content: { sections: resolvedSections },
          };

          const menuCanvasProp = {
            name: menuPropName,
            label: menuAssetRow?.display_name || resolvedMenuTitle,
            position: 'left',
            cx: 0.20,
            cy: 0.60,
            scale: 0.14,
            imageUrl: menuImageUrl,
            richContent,
          };

          if (!session.sceneCanvas.props) session.sceneCanvas.props = [];
          const existingMenuIdx = session.sceneCanvas.props.findIndex((p: any) => p.name === menuPropName);
          if (existingMenuIdx >= 0) {
            session.sceneCanvas.props[existingMenuIdx] = menuCanvasProp;
          } else {
            session.sceneCanvas.props.push(menuCanvasProp);
          }

          const menuUpdate = {
            type: 'whiteboard_update' as const,
            timestamp: Date.now(),
            items: [{
              id: 'scene-canvas-active',
              type: 'scene_canvas',
              content: session.sceneCanvas.environmentLabel || session.sceneCanvas.environment,
              data: {
                environment: session.sceneCanvas.environment,
                environmentImageUrl: session.sceneCanvas.environmentImageUrl,
                environmentLabel: session.sceneCanvas.environmentLabel,
                props: [...session.sceneCanvas.props],
                clockTime: session.sceneCanvas.clockTime,
                canvasAction: 'add_prop' as const,
              },
            }],
          };

          if (session.firstAudioSent) {
            this.sendMessage(session.ws, menuUpdate);
          } else {
            if (!session.pendingWhiteboardUpdates) session.pendingWhiteboardUpdates = [];
            session.pendingWhiteboardUpdates.push(menuUpdate);
          }
          console.log(`[Native Function→ShowMenu] Placed "${menuPropName}" on scene with ${resolvedSections?.length || 0} sections`);
        } catch (err: any) {
          console.error('[Native Function→ShowMenu] Error:', err.message);
        }
        break;
      }

      case 'SHOW_BILL': {
        const billText = fn.args.text as string | undefined;
        const billTitle = fn.args.title as string | undefined;
        const billItems = fn.args.items as Array<{ label: string; value: string }> | undefined;
        const billSubtotal = fn.args.subtotal as string | undefined;
        const billService = fn.args.service as string | undefined;
        const billTax = fn.args.tax as string | undefined;
        const billTotal = fn.args.total as string | undefined;

        if (billText && !session.functionCallText) session.functionCallText = billText;

        if (!session.sceneCanvas) {
          console.warn('[Native Function→ShowBill] No active scene canvas — call open_scene first');
          break;
        }

        const { getUserDb: getBillDb } = await import('../db');
        const { sql: billSql } = await import('drizzle-orm');
        const billDb = getBillDb();

        try {
          const billAssetResult = await billDb.execute(billSql`
            SELECT COALESCE(zone_image_url, image_url) as prop_url, display_name
            FROM visual_assets
            WHERE name = 'restaurant_bill'
            LIMIT 1
          `);
          const billAssetRow = billAssetResult.rows[0] as any;
          const billImageUrl = billAssetRow?.prop_url as string | undefined;

          if (!billImageUrl) {
            console.warn('[Native Function→ShowBill] No image for restaurant_bill');
            break;
          }

          // Build bill fields: items + breakdown
          const fields: Array<{ label: string; value: string }> = [];
          if (billItems) {
            for (const item of billItems) {
              fields.push({ label: item.label, value: item.value });
            }
          }
          if (billSubtotal) fields.push({ label: 'Subtotal', value: billSubtotal });
          if (billService) fields.push({ label: 'Service', value: billService });
          if (billTax) fields.push({ label: 'Tax', value: billTax });
          if (billTotal) fields.push({ label: 'Total', value: billTotal });

          const resolvedBillTitle = billTitle || 'Bill';
          const richContent = {
            type: 'bill' as const,
            title: resolvedBillTitle,
            content: { fields },
          };

          const billCanvasProp = {
            name: 'restaurant_bill',
            label: resolvedBillTitle,
            position: 'right',
            cx: 0.72,
            cy: 0.70,
            scale: 0.14,
            imageUrl: billImageUrl,
            richContent,
          };

          if (!session.sceneCanvas.props) session.sceneCanvas.props = [];
          const existingBillIdx = session.sceneCanvas.props.findIndex((p: any) => p.name === 'restaurant_bill');
          if (existingBillIdx >= 0) {
            session.sceneCanvas.props[existingBillIdx] = billCanvasProp;
          } else {
            session.sceneCanvas.props.push(billCanvasProp);
          }

          const billUpdate = {
            type: 'whiteboard_update' as const,
            timestamp: Date.now(),
            items: [{
              id: 'scene-canvas-active',
              type: 'scene_canvas',
              content: session.sceneCanvas.environmentLabel || session.sceneCanvas.environment,
              data: {
                environment: session.sceneCanvas.environment,
                environmentImageUrl: session.sceneCanvas.environmentImageUrl,
                environmentLabel: session.sceneCanvas.environmentLabel,
                props: [...session.sceneCanvas.props],
                clockTime: session.sceneCanvas.clockTime,
                canvasAction: 'add_prop' as const,
              },
            }],
          };

          if (session.firstAudioSent) {
            this.sendMessage(session.ws, billUpdate);
          } else {
            if (!session.pendingWhiteboardUpdates) session.pendingWhiteboardUpdates = [];
            session.pendingWhiteboardUpdates.push(billUpdate);
          }
          console.log(`[Native Function→ShowBill] Placed restaurant_bill on scene with ${fields.length} fields`);
        } catch (err: any) {
          console.error('[Native Function→ShowBill] Error:', err.message);
        }
        break;
      }

      case 'UPDATE_PROP': {
        const text = fn.args.text as string | undefined;
        const propTitle = fn.args.prop_title as string | undefined;
        const updates = fn.args.updates as Array<{ label: string; value: string }> | undefined;
        const activeScenario = session.activeScenario;

        if (propTitle && updates && updates.length > 0 && activeScenario?.props) {
          const targetProp = activeScenario.props.find((p: any) =>
            p.title?.toLowerCase() === propTitle.toLowerCase()
          );

          const resolvedContent = targetProp?.content?.byDifficulty
            ? (targetProp.content.byDifficulty[session.difficultyLevel]
              || targetProp.content.byDifficulty.intermediate
              || targetProp.content.byDifficulty.beginner
              || targetProp.content)
            : targetProp?.content;

          const BILL_LABEL_ALIASES: Record<string, string[]> = {
            'items': ['artículos', 'detalle de consumo', 'detalle de consumiciones', 'artículos adquiridos', 'detalle'],
            'subtotal': ['base imponible', 'subtotal'],
            'total': ['total', 'total a pagar', 'importe total'],
            'tax': ['iva', 'impuesto', 'tax'],
            'establishment': ['establecimiento', 'local', 'comercio'],
            'date': ['fecha', 'date'],
            'driver': ['conductor', 'chofer'],
            'fare': ['tarifa', 'importe del trayecto'],
            'tip': ['propina'],
            'from': ['origen', 'recogida'],
            'to': ['destino', 'destino final'],
            'distance': ['distancia', 'recorrido'],
            'vendor': ['puesto', 'vendedor'],
            'tickets': ['entradas', 'admisión'],
            'audio guide': ['audioguía', 'guía de audio'],
            'gift shop': ['tienda', 'tienda del museo'],
            'service': ['servicio', 'coperto', 'cubierto'],
            'guest': ['huésped', 'titular'],
            'room': ['habitación'],
            'nights': ['noches', 'estancias'],
            'room charge': ['tarifa de alojamiento', 'cargo de habitación'],
            'extras': ['cargos por servicios complementarios', 'extras'],
          };

          if (targetProp && resolvedContent?.fields) {
            for (const update of updates) {
              const updateLabel = update.label.toLowerCase();
              const field = resolvedContent.fields.find((f: any) => {
                const fl = f.label?.toLowerCase() || '';
                if (fl === updateLabel) return true;
                if (fl.includes(' / ')) {
                  const parts = fl.split(' / ').map((s: string) => s.trim().toLowerCase());
                  if (parts.some((p: string) => p === updateLabel || updateLabel.includes(p) || p.includes(updateLabel))) return true;
                }
                if (fl.includes(updateLabel) || updateLabel.includes(fl)) return true;
                const aliases = BILL_LABEL_ALIASES[updateLabel];
                if (aliases && aliases.some(a => fl.includes(a) || a.includes(fl))) return true;
                for (const [key, vals] of Object.entries(BILL_LABEL_ALIASES)) {
                  if (vals.some(v => v === updateLabel || updateLabel.includes(v))) {
                    if (fl.includes(key) || key.includes(fl) || vals.some(v => fl.includes(v))) return true;
                  }
                }
                return false;
              });
              if (field) {
                field.value = update.value;
              } else {
                resolvedContent.fields.push({ label: update.label, value: update.value });
              }
            }

            console.log(`[Native Function→UpdateProp] Updated "${propTitle}": ${updates.map(u => `${u.label}=${u.value}`).join(', ')}`);

            this.sendMessage(session.ws, {
              type: 'prop_update',
              timestamp: Date.now(),
              propTitle,
              updates,
              updatedFields: resolvedContent.fields,
            });
          } else {
            console.warn(`[Native Function→UpdateProp] Prop "${propTitle}" not found or has no fields`);
          }
        } else {
          console.warn(`[Native Function→UpdateProp] Missing required args or no active scenario`);
        }

        if (text && !session.functionCallText) {
          session.functionCallText = text;
        }
        break;
      }

      case 'END_SCENARIO': {
        const spokenText = (fn.args.spoken_text || fn.args.text) as string | undefined;
        const performanceNotes = (fn.args.feedback || fn.args.performance_notes) as string | undefined;
        const activeScenario = session.activeScenario;

        if (activeScenario) {
          console.log(`[Native Function→EndScenario] Ending "${activeScenario.title}"`);

          if (session.userId && activeScenario.id) {
            try {
              const { userScenarioHistory } = await import('@shared/schema');
              const sharedDb = getSharedDb();
              const durationSeconds = Math.round((Date.now() - (activeScenario.startedAt || Date.now())) / 1000);

              await sharedDb.update(userScenarioHistory)
                .set({
                  completedAt: new Date(),
                  durationSeconds,
                  performanceNotes: performanceNotes || undefined,
                })
                .where(and(
                  eq(userScenarioHistory.userId, String(session.userId)),
                  eq(userScenarioHistory.scenarioId, activeScenario.id),
                ));
            } catch (err: any) {
              console.warn('[EndScenario] History update failed:', err.message);
            }
          }

          this.sendMessage(session.ws, {
            type: 'scenario_ended',
            timestamp: Date.now(),
            scenarioId: activeScenario.id,
            scenarioSlug: activeScenario.slug,
            performanceNotes: performanceNotes || undefined,
          });

          session.activeScenario = null;
        } else {
          console.log('[Native Function→EndScenario] No active scenario to end');
        }

        if (spokenText && !session.functionCallText) {
          session.functionCallText = spokenText;
        }
        break;
      }
      
      case 'SUMMARY': {
        const summaryTitle = (fn.args.title as string | undefined) || "Session Summary";
        const summaryItems = fn.args.items as string | undefined;
        const summaryPoints = fn.args.points as string | undefined;
        const rawContent = summaryItems || summaryPoints || '';
        
        if (rawContent || summaryTitle) {
          const lines = rawContent.split('\n').map((l: string) => l.replace(/^\*\*|\*\*$/g, '').replace(/\*\*/g, '').trim()).filter(Boolean);
          const summaryData = {
            title: summaryTitle,
            words: lines,
            phrases: [] as string[],
            totalItems: lines.length,
          };
          console.log(`[Native Function→Summary] title="${summaryTitle}" ${lines.length} points`);
          this.sendMessage(session.ws, {
            type: 'whiteboard_update',
            timestamp: Date.now(),
            items: [{ type: 'summary', content: rawContent, data: summaryData }],
          });
        } else {
          console.warn(`[Native Function→Summary] No title or items provided, skipping. Args: ${JSON.stringify(fn.args).substring(0, 200)}`);
        }
        break;
      }
      
      case 'READING': {
        const passage = (fn.args.content || fn.args.passage) as string | undefined;
        const readingTitle = fn.args.title as string | undefined;
        const translation = fn.args.translation as string | undefined;
        
        if (passage) {
          const readingData = {
            character: passage,
            reading: translation || '',
            title: readingTitle || undefined,
            language: session.targetLanguage || undefined,
          };
          console.log(`[Native Function→Reading] "${passage.substring(0, 50)}..."${readingTitle ? ` title="${readingTitle}"` : ''}${translation ? ` translation="${translation.substring(0, 50)}..."` : ''}`);
          this.sendMessage(session.ws, {
            type: 'whiteboard_update',
            timestamp: Date.now(),
            items: [{ type: 'reading', content: passage, data: readingData, translation }],
          });
        } else {
          console.warn(`[Native Function→Reading] No content/passage provided. Args: ${JSON.stringify(fn.args).substring(0, 200)}`);
        }
        break;
      }
      
      case 'PLAY': {
        const description = fn.args.description as string | undefined;
        const playText = fn.args.text as string | undefined;
        
        if (playText && !session.functionCallText) {
          session.functionCallText = playText;
        }
        
        if (description) {
          console.log(`[Native Function→Play] "${description.substring(0, 50)}..."`);
          
          let audioUrl: string | undefined;
          let audioDurationMs: number | undefined;
          
          try {
            const { getCachedPronunciationAudio } = await import('./audio-caching-service');
            const targetLanguage = session.targetLanguage || 'spanish';
            const voiceGender = session.voiceGender || 'female';
            
            const result = await getCachedPronunciationAudio(
              description,
              targetLanguage,
              voiceGender as 'female' | 'male',
              'normal',
              { contentType: 'pronunciation' }
            );
            
            audioUrl = result.audioUrl;
            audioDurationMs = result.durationMs || undefined;
            console.log(`[Native Function→Play] ${result.cacheHit ? 'Cache HIT' : 'Generated'}: got audio (${audioDurationMs}ms)`);
          } catch (error: any) {
            console.warn(`[Native Function→Play] Failed to get cached audio: ${error.message}`);
          }
          
          this.sendMessage(session.ws, {
            type: 'whiteboard_update',
            timestamp: Date.now(),
            items: [{ 
              type: 'play', 
              content: description,
              data: {
                text: description,
                speed: 'normal' as const,
                audioUrl,
                audioDurationMs,
              },
            }],
          });
        }
        break;
      }
      
      case 'STROKE': {
        const character = fn.args.character as string | undefined;
        const strokeText = fn.args.text as string | undefined;
        
        if (strokeText && !session.functionCallText) {
          session.functionCallText = strokeText;
        }
        
        if (character) {
          const strokeData = {
            character,
            language: (fn.args.language as string | undefined)?.toLowerCase() || undefined,
            strokes: [],
          };
          console.log(`[Native Function→Stroke] Character: ${character}`);
          this.sendMessage(session.ws, {
            type: 'whiteboard_update',
            timestamp: Date.now(),
            items: [{ type: 'stroke', content: character, data: strokeData }],
          });
        }
        break;
      }
      
      case 'TONE': {
        const syllable = (fn.args.syllable || fn.args.pinyin) as string | undefined;
        const toneNumber = fn.args.toneNumber as number | undefined;
        const toneText = fn.args.text as string | undefined;
        
        if (syllable) {
          const toneNumbers = toneNumber ? [toneNumber] : (syllable.match(/\d/g)?.map(Number) || []);
          const toneData = {
            word: syllable,
            pinyin: syllable,
            tones: toneNumbers,
            language: 'mandarin',
            meaning: undefined as string | undefined,
          };
          console.log(`[Native Function→Tone] Syllable: ${syllable} tones: ${toneNumbers}`);
          this.sendMessage(session.ws, {
            type: 'whiteboard_update',
            timestamp: Date.now(),
            items: [{ type: 'tone', content: syllable, data: toneData }],
          });
        }
        if (toneText && !session.functionCallText) {
          session.functionCallText = toneText;
        }
        break;
      }
      
      case 'PRONUNCIATION_TAG': {
        const word = fn.args.word as string | undefined;
        const ipa = fn.args.ipa as string | undefined;
        const hint = fn.args.hint as string | undefined;
        const language = fn.args.language as string | undefined;
        
        if (word) {
          const tagLanguage = language || session.targetLanguage || 'spanish';
          console.log(`[Native Function→PronunciationTag] [${tagLanguage}:${word}]${ipa ? ` IPA: ${ipa}` : ''}${hint ? ` hint: ${hint}` : ''}`);
          if (!session.pendingPronunciationTags) {
            session.pendingPronunciationTags = [];
          }
          session.pendingPronunciationTags.push({ word, language: tagLanguage, ipa, hint });
        }
        break;
      }

      case 'BROWSE_SYLLABUS': {
        const text = fn.args.text as string | undefined;
        const unitNumber = (fn.args.unitNumber || fn.args.unit_number) as number | undefined;
        const showCompleted = (fn.args.showCompleted ?? fn.args.show_completed) !== false;

        if (text && !session.functionCallText) {
          session.functionCallText = text;
        }

        if (session.userId) {
          try {
            const studentId = String(session.userId);
            const enrollments = await storage.getStudentEnrollments(studentId);
            const activeClass = enrollments.find(e =>
              e.isActive && e.class?.isActive && e.class?.language === session.targetLanguage
            );

            if (activeClass?.class) {
              const classId = activeClass.class.id;
              const units = await storage.getClassCurriculumUnits(classId);
              const activeUnits = units.filter(u => !u.isRemoved).sort((a, b) => a.orderIndex - b.orderIndex);

              const filteredUnits = unitNumber
                ? activeUnits.filter((_, i) => i + 1 === unitNumber)
                : activeUnits;

              const syllabusProgress = await storage.getSyllabusProgress(studentId, classId);
              const progressMap = new Map(syllabusProgress.map(sp => [sp.lessonId, sp]));

              const syllabusData: Array<{
                unitName: string;
                unitIndex: number;
                actflLevel: string | null;
                lessons: Array<{
                  id: string;
                  name: string;
                  type: string;
                  status: string;
                  orderIndex: number;
                }>;
              }> = [];

              for (const unit of filteredUnits) {
                const lessons = await storage.getClassCurriculumLessons(unit.id);
                const activeLessons = lessons
                  .filter(l => !l.isRemoved)
                  .sort((a, b) => a.orderIndex - b.orderIndex);

                const lessonData = activeLessons
                  .map(l => {
                    const progress = progressMap.get(l.sourceLessonId || l.id);
                    const status = progress?.status || 'not_started';
                    return {
                      id: l.sourceLessonId || l.id,
                      name: l.name,
                      type: l.lessonType,
                      status,
                      orderIndex: l.orderIndex,
                    };
                  })
                  .filter(l => showCompleted || l.status !== 'completed_assigned');

                syllabusData.push({
                  unitName: unit.name,
                  unitIndex: unit.orderIndex,
                  actflLevel: unit.actflLevel,
                  lessons: lessonData,
                });
              }

              const totalLessons = syllabusData.reduce((sum, u) => sum + u.lessons.length, 0);
              const completedLessons = syllabusData.reduce(
                (sum, u) => sum + u.lessons.filter(l => l.status === 'completed_assigned' || l.status === 'completed_early').length, 0
              );

              console.log(`[Native Function→BrowseSyllabus] ${syllabusData.length} units, ${totalLessons} lessons (${completedLessons} completed)`);

              this.sendMessage(session.ws, {
                type: 'whiteboard_update',
                timestamp: Date.now(),
                items: [{
                  type: 'write',
                  content: `Syllabus: ${activeClass.class.name}`,
                  data: {
                    syllabusOverview: true,
                    className: activeClass.class.name,
                    units: syllabusData,
                    totalLessons,
                    completedLessons,
                    progressPercent: totalLessons > 0 ? Math.round((completedLessons / totalLessons) * 100) : 0,
                  },
                }],
              });

              if (!session.pendingMemoryLookupPromises) session.pendingMemoryLookupPromises = [];
              session.pendingMemoryLookupPromises.push(Promise.resolve());
              session.lastSyllabusData = syllabusData;
            } else {
              console.log(`[Native Function→BrowseSyllabus] No active class found for ${session.targetLanguage}`);
            }
          } catch (err: any) {
            console.error(`[Native Function→BrowseSyllabus] Error:`, err.message);
          }
        }
        break;
      }

      case 'START_LESSON': {
        const text = fn.args.text as string | undefined;
        const lessonId = (fn.args.lessonId || fn.args.lesson_id) as string | undefined;
        const lessonName = (fn.args.lessonName || fn.args.lesson_name) as string | undefined;

        if (text && !session.functionCallText) {
          session.functionCallText = text;
        }

        if (session.userId) {
          try {
            const { curriculumLessons, curriculumDrillItems, classCurriculumLessons, classCurriculumUnits } = await import('@shared/schema');
            const sharedDb = getSharedDb();

            let lesson: any = null;

            if (lessonId) {
              const [found] = await sharedDb.select().from(curriculumLessons).where(eq(curriculumLessons.id, lessonId)).limit(1);
              lesson = found;
            }

            if (!lesson && lessonName) {
              const studentId = String(session.userId);
              const enrollments = await storage.getStudentEnrollments(studentId);
              const activeClass = enrollments.find(e =>
                e.isActive && e.class?.isActive && e.class?.language === session.targetLanguage
              );

              if (activeClass?.class) {
                const units = await storage.getClassCurriculumUnits(activeClass.class.id);
                const activeUnitIds = units.filter(u => !u.isRemoved).map(u => u.id);

                if (activeUnitIds.length > 0) {
                  const classLessons = await storage.getClassCurriculumLessonsForUnits(activeUnitIds);
                  const match = classLessons.find(l =>
                    !l.isRemoved && l.name.toLowerCase().includes(lessonName.toLowerCase())
                  );

                  if (match?.sourceLessonId) {
                    const [found] = await sharedDb.select().from(curriculumLessons).where(eq(curriculumLessons.id, match.sourceLessonId)).limit(1);
                    lesson = found;
                  }
                }
              }
            }

            if (lesson) {
              const drills = await sharedDb.select().from(curriculumDrillItems)
                .where(eq(curriculumDrillItems.lessonId, lesson.id))
                .orderBy(curriculumDrillItems.orderIndex);

              session.lessonBundleContext = {
                lessonId: lesson.id,
                lessonName: lesson.name,
                hasBundledDrills: drills.length > 0,
                bundleId: lesson.bundleId || undefined,
                linkedDrillLessonId: lesson.linkedDrillLessonId || undefined,
                drillsProvisioned: drills.length > 0,
                provisionedDrillCount: drills.length,
              };

              const lessonContent = {
                id: lesson.id,
                name: lesson.name,
                type: lesson.lessonType,
                description: lesson.description,
                objectives: lesson.objectives || [],
                conversationTopic: lesson.conversationTopic,
                conversationPrompt: lesson.conversationPrompt,
                requiredVocabulary: lesson.requiredVocabulary || [],
                requiredGrammar: lesson.requiredGrammar || [],
                estimatedMinutes: lesson.estimatedMinutes,
                drillCount: drills.length,
              };

              console.log(`[Native Function→StartLesson] Loaded "${lesson.name}" (${lesson.id}) with ${drills.length} drills`);

              this.sendMessage(session.ws, {
                type: 'whiteboard_update',
                timestamp: Date.now(),
                items: [{
                  type: 'write',
                  content: `Lesson: ${lesson.name}`,
                  data: {
                    lessonLoaded: true,
                    lesson: lessonContent,
                  },
                }],
              });

              if (!session.pendingMemoryLookupPromises) session.pendingMemoryLookupPromises = [];
              session.pendingMemoryLookupPromises.push(Promise.resolve());
              session.lastLoadedLesson = lessonContent;
            } else {
              console.warn(`[Native Function→StartLesson] Lesson not found: id=${lessonId} name=${lessonName}`);
            }
          } catch (err: any) {
            console.error(`[Native Function→StartLesson] Error:`, err.message);
          }
        }
        break;
      }

      case 'LOAD_VOCAB_SET': {
        const text = fn.args.text as string | undefined;
        const lessonId = (fn.args.lessonId || fn.args.lesson_id) as string | undefined;

        if (text && !session.functionCallText) {
          session.functionCallText = text;
        }

        if (session.userId && lessonId) {
          try {
            const { curriculumLessons } = await import('@shared/schema');
            const sharedDb = getSharedDb();

            const [lesson] = await sharedDb.select().from(curriculumLessons).where(eq(curriculumLessons.id, lessonId)).limit(1);

            if (lesson) {
              const vocabWords = lesson.requiredVocabulary || [];

              const vocabData = vocabWords.map((word: string, index: number) => ({
                word,
                index,
              }));

              console.log(`[Native Function→LoadVocabSet] Loaded ${vocabData.length} vocab items for "${lesson.name}"`);

              this.sendMessage(session.ws, {
                type: 'whiteboard_update',
                timestamp: Date.now(),
                items: [{
                  type: 'write',
                  content: `Vocabulary: ${lesson.name}`,
                  data: {
                    vocabSetLoaded: true,
                    lessonId: lesson.id,
                    lessonName: lesson.name,
                    vocabulary: vocabData,
                    totalWords: vocabData.length,
                  },
                }],
              });

              if (!session.pendingMemoryLookupPromises) session.pendingMemoryLookupPromises = [];
              session.pendingMemoryLookupPromises.push(Promise.resolve());
              session.lastVocabSet = vocabData;
            } else {
              console.warn(`[Native Function→LoadVocabSet] Lesson not found: ${lessonId}`);
            }
          } catch (err: any) {
            console.error(`[Native Function→LoadVocabSet] Error:`, err.message);
          }
        }
        break;
      }

      case 'SHOW_PROGRESS': {
        const text = fn.args.text as string | undefined;
        const detailed = fn.args.detailed === true;

        if (text && !session.functionCallText) {
          session.functionCallText = text;
        }

        if (session.userId) {
          try {
            const studentId = String(session.userId);
            const enrollments = await storage.getStudentEnrollments(studentId);
            const activeClass = enrollments.find(e =>
              e.isActive && e.class?.isActive && e.class?.language === session.targetLanguage
            );

            const actflProgress = await storage.getOrCreateActflProgress(session.targetLanguage || 'spanish', studentId).catch(() => null);
            const userProgressData = await storage.getOrCreateUserProgress(session.targetLanguage || 'spanish', studentId).catch(() => null);

            const progressData: Record<string, unknown> = {
              actflLevel: actflProgress?.currentActflLevel || 'Novice Low',
              wordsLearned: userProgressData?.wordsLearned || 0,
              lessonsCompleted: 0,
              totalMinutes: userProgressData?.practiceMinutes || 0,
              streakDays: userProgressData?.currentStreak || 0,
            };

            if (activeClass?.class) {
              const classId = activeClass.class.id;
              const units = await storage.getClassCurriculumUnits(classId);
              const activeUnits = units.filter(u => !u.isRemoved).sort((a, b) => a.orderIndex - b.orderIndex);

              const syllabusProgress = await storage.getSyllabusProgress(studentId, classId);
              const progressMap = new Map(syllabusProgress.map(sp => [sp.lessonId, sp]));

              let totalLessons = 0;
              let completedLessons = 0;
              let inProgressLessons = 0;
              const unitBreakdown: Array<{ name: string; total: number; completed: number; }> = [];

              for (const unit of activeUnits) {
                const lessons = await storage.getClassCurriculumLessons(unit.id);
                const activeLessons = lessons.filter(l => !l.isRemoved);
                const unitCompleted = activeLessons.filter(l => {
                  const p = progressMap.get(l.sourceLessonId || l.id);
                  return p?.status === 'completed_assigned' || p?.status === 'completed_early';
                }).length;
                const unitInProgress = activeLessons.filter(l => {
                  const p = progressMap.get(l.sourceLessonId || l.id);
                  return p?.status === 'in_progress';
                }).length;

                totalLessons += activeLessons.length;
                completedLessons += unitCompleted;
                inProgressLessons += unitInProgress;

                if (detailed) {
                  unitBreakdown.push({
                    name: unit.name,
                    total: activeLessons.length,
                    completed: unitCompleted,
                  });
                }
              }

              progressData.className = activeClass.class.name;
              progressData.totalLessons = totalLessons;
              progressData.completedLessons = completedLessons;
              progressData.inProgressLessons = inProgressLessons;
              progressData.progressPercent = totalLessons > 0 ? Math.round((completedLessons / totalLessons) * 100) : 0;
              if (detailed) {
                progressData.unitBreakdown = unitBreakdown;
              }
            }

            console.log(`[Native Function→ShowProgress] ACTFL: ${progressData.actflLevel}, ${progressData.completedLessons || 0}/${progressData.totalLessons || '?'} lessons`);

            this.sendMessage(session.ws, {
              type: 'whiteboard_update',
              timestamp: Date.now(),
              items: [{
                type: 'write',
                content: `Progress: ${progressData.actflLevel}`,
                data: {
                  progressSnapshot: true,
                  ...progressData,
                },
              }],
            });
          } catch (err: any) {
            console.error(`[Native Function→ShowProgress] Error:`, err.message);
          }
        }
        break;
      }

      case 'RECOMMEND_NEXT': {
        const text = fn.args.text as string | undefined;

        if (text && !session.functionCallText) {
          session.functionCallText = text;
        }

        if (session.userId) {
          try {
            const studentId = String(session.userId);
            const enrollments = await storage.getStudentEnrollments(studentId);
            const activeClass = enrollments.find(e =>
              e.isActive && e.class?.isActive && e.class?.language === session.targetLanguage
            );

            if (activeClass?.class) {
              const classId = activeClass.class.id;
              const units = await storage.getClassCurriculumUnits(classId);
              const activeUnits = units.filter(u => !u.isRemoved).sort((a, b) => a.orderIndex - b.orderIndex);

              const syllabusProgress = await storage.getSyllabusProgress(studentId, classId);
              const progressMap = new Map(syllabusProgress.map(sp => [sp.lessonId, sp]));

              let recommended: { lessonId: string; lessonName: string; unitName: string; reason: string; } | null = null;

              for (const unit of activeUnits) {
                const lessons = await storage.getClassCurriculumLessons(unit.id);
                const activeLessons = lessons.filter(l => !l.isRemoved).sort((a, b) => a.orderIndex - b.orderIndex);

                const inProgressLesson = activeLessons.find(l => {
                  const p = progressMap.get(l.sourceLessonId || l.id);
                  return p?.status === 'in_progress';
                });

                if (inProgressLesson) {
                  recommended = {
                    lessonId: inProgressLesson.sourceLessonId || inProgressLesson.id,
                    lessonName: inProgressLesson.name,
                    unitName: unit.name,
                    reason: 'You started this lesson but haven\'t finished it yet. Let\'s pick up where you left off!',
                  };
                  break;
                }

                const nextLesson = activeLessons.find(l => {
                  const p = progressMap.get(l.sourceLessonId || l.id);
                  return !p || p.status === 'not_started';
                });

                if (nextLesson) {
                  recommended = {
                    lessonId: nextLesson.sourceLessonId || nextLesson.id,
                    lessonName: nextLesson.name,
                    unitName: unit.name,
                    reason: 'This is the next lesson in your syllabus. Ready to learn something new!',
                  };
                  break;
                }
              }

              if (recommended) {
                console.log(`[Native Function→RecommendNext] Recommending "${recommended.lessonName}" from ${recommended.unitName}`);

                this.sendMessage(session.ws, {
                  type: 'whiteboard_update',
                  timestamp: Date.now(),
                  items: [{
                    type: 'write',
                    content: `Recommended: ${recommended.lessonName}`,
                    data: {
                      recommendation: true,
                      lessonId: recommended.lessonId,
                      lessonName: recommended.lessonName,
                      unitName: recommended.unitName,
                      reason: recommended.reason,
                    },
                  }],
                });

                if (!session.pendingMemoryLookupPromises) session.pendingMemoryLookupPromises = [];
                session.pendingMemoryLookupPromises.push(Promise.resolve());
                session.lastRecommendation = recommended;
              } else {
                console.log(`[Native Function→RecommendNext] No lessons available to recommend`);
                this.sendMessage(session.ws, {
                  type: 'whiteboard_update',
                  timestamp: Date.now(),
                  items: [{
                    type: 'write',
                    content: 'Congratulations! You\'ve completed all available lessons!',
                    data: { recommendation: true, allComplete: true },
                  }],
                });
              }
            } else {
              console.log(`[Native Function→RecommendNext] No active class found for ${session.targetLanguage}`);
            }
          } catch (err: any) {
            console.error(`[Native Function→RecommendNext] Error:`, err.message);
          }
        }
        break;
      }

      case 'DRILL_SESSION': {
        const drillAction = (fn.args.action as string | undefined) || 'start';

        if (drillAction === 'next') {
          const text = fn.args.text as string | undefined;
          const wasCorrect = fn.args.was_correct as boolean | undefined;
          if (text && !session.functionCallText) session.functionCallText = text;
          const drillSession = session.drillSession;
          if (drillSession) {
            if (wasCorrect === true) drillSession.correctCount++;
            else if (wasCorrect === false) drillSession.incorrectCount++;
            drillSession.currentIndex++;
            if (drillSession.currentIndex < drillSession.totalItems) {
              const nextItem = drillSession.items[drillSession.currentIndex];
              const { parseDrillContent } = await import('@shared/whiteboard-types');
              const drillData = parseDrillContent(nextItem.drillType || 'repeat', nextItem.prompt);
              console.log(`[Native Function→DrillSession/Next] Item ${drillSession.currentIndex + 1}/${drillSession.totalItems}`);
              this.sendMessage(session.ws, {
                type: 'whiteboard_update', timestamp: Date.now(),
                items: [{ type: 'drill', content: nextItem.prompt, data: { ...drillData, sessionProgress: `${drillSession.currentIndex + 1} / ${drillSession.totalItems}` } }],
              });
              if (!session.pendingMemoryLookupPromises) session.pendingMemoryLookupPromises = [];
              session.pendingMemoryLookupPromises.push(Promise.resolve());
              session.lastDrillSessionData = {
                totalItems: drillSession.totalItems, currentItem: drillSession.currentIndex + 1,
                correctSoFar: drillSession.correctCount, incorrectSoFar: drillSession.incorrectCount,
                nextDrill: { type: nextItem.drillType, prompt: nextItem.prompt },
              };
            } else {
              const elapsed = Math.round((Date.now() - drillSession.startTime) / 1000);
              const accuracy = drillSession.totalItems > 0 ? Math.round((drillSession.correctCount / drillSession.totalItems) * 100) : 0;
              console.log(`[Native Function→DrillSession/Next] Session complete! ${drillSession.correctCount}/${drillSession.totalItems}`);
              this.sendMessage(session.ws, {
                type: 'whiteboard_update', timestamp: Date.now(),
                items: [{ type: 'summary', content: 'Practice Session Complete', data: { title: 'Practice Session Complete', stats: [
                  { label: 'Items Completed', value: String(drillSession.totalItems) },
                  { label: 'Correct', value: String(drillSession.correctCount) },
                  { label: 'Incorrect', value: String(drillSession.incorrectCount) },
                  { label: 'Accuracy', value: `${accuracy}%` },
                  { label: 'Duration', value: `${Math.floor(elapsed / 60)}m ${elapsed % 60}s` },
                ] } }],
              });
              if (!session.pendingMemoryLookupPromises) session.pendingMemoryLookupPromises = [];
              session.pendingMemoryLookupPromises.push(Promise.resolve());
              session.lastDrillSessionData = { sessionComplete: true, totalItems: drillSession.totalItems, correct: drillSession.correctCount, incorrect: drillSession.incorrectCount, accuracy, durationSeconds: elapsed };
              delete session.drillSession;
            }
          } else {
            console.log(`[Native Function→DrillSession/Next] No active drill session`);
          }
          break;
        }

        if (drillAction === 'end') {
          const text = fn.args.text as string | undefined;
          if (text && !session.functionCallText) session.functionCallText = text;
          const activeDrillSession = session.drillSession;
          if (activeDrillSession) {
            const elapsed = Math.round((Date.now() - activeDrillSession.startTime) / 1000);
            const completed = activeDrillSession.currentIndex;
            const accuracy = completed > 0 ? Math.round((activeDrillSession.correctCount / completed) * 100) : 0;
            console.log(`[Native Function→DrillSession/End] Ending early at ${completed}/${activeDrillSession.totalItems}`);
            this.sendMessage(session.ws, {
              type: 'whiteboard_update', timestamp: Date.now(),
              items: [{ type: 'summary', content: 'Practice Session Summary', data: { title: 'Practice Session Summary', stats: [
                { label: 'Items Attempted', value: `${completed} of ${activeDrillSession.totalItems}` },
                { label: 'Correct', value: String(activeDrillSession.correctCount) },
                { label: 'Incorrect', value: String(activeDrillSession.incorrectCount) },
                { label: 'Accuracy', value: `${accuracy}%` },
                { label: 'Duration', value: `${Math.floor(elapsed / 60)}m ${elapsed % 60}s` },
              ] } }],
            });
            if (!session.pendingMemoryLookupPromises) session.pendingMemoryLookupPromises = [];
            session.pendingMemoryLookupPromises.push(Promise.resolve());
            session.lastDrillSessionData = { sessionComplete: true, endedEarly: true, itemsAttempted: completed, totalItems: activeDrillSession.totalItems, correct: activeDrillSession.correctCount, incorrect: activeDrillSession.incorrectCount, accuracy, durationSeconds: elapsed };
            delete session.drillSession;
          }
          break;
        }

        // action === 'start' (default)
        const text = fn.args.text as string | undefined;
        const lessonId = (fn.args.lessonId || fn.args.lesson_id) as string | undefined;
        const requestedDrillType = (fn.args.drillType || fn.args.drill_type) as string | undefined;
        const requestedCount = (fn.args.count as number | undefined) || 10;

        if (text && !session.functionCallText) {
          session.functionCallText = text;
        }

        if (session.userId) {
          try {
            const { arisDrillAssignments } = await import('@shared/schema');
            const { eq, and } = await import('drizzle-orm');
            const db = (await import('../db')).db;

            let targetLessonId = lessonId;
            if (!targetLessonId && session.lastLoadedLesson) {
              targetLessonId = session.lastLoadedLesson.id;
            }

            let drillItems: Array<{ prompt: string; expectedAnswer?: string; options?: string[]; pronunciation?: string; drillType?: string }> = [];

            if (targetLessonId) {
              const assignments = await db.select().from(arisDrillAssignments)
                .where(and(
                  eq(arisDrillAssignments.userId, String(session.userId)),
                  eq(arisDrillAssignments.lessonId, targetLessonId),
                ));

              for (const a of assignments) {
                if (requestedDrillType && a.drillType !== requestedDrillType) continue;
                if (a.drillContent && Array.isArray((a.drillContent as any).items)) {
                  for (const item of (a.drillContent as any).items) {
                    drillItems.push({ ...item, drillType: a.drillType });
                  }
                }
              }
            }

            if (drillItems.length === 0 && targetLessonId) {
              const assignments = await db.select().from(arisDrillAssignments)
                .where(and(
                  eq(arisDrillAssignments.userId, String(session.userId)),
                  eq(arisDrillAssignments.targetLanguage, session.targetLanguage || 'spanish'),
                ));

              for (const a of assignments) {
                if (requestedDrillType && a.drillType !== requestedDrillType) continue;
                if (a.drillContent && Array.isArray((a.drillContent as any).items)) {
                  for (const item of (a.drillContent as any).items) {
                    drillItems.push({ ...item, drillType: a.drillType });
                  }
                }
                if (drillItems.length >= requestedCount) break;
              }
            }

            if (drillItems.length > requestedCount) {
              drillItems = drillItems.slice(0, requestedCount);
            }

            if (drillItems.length > 0) {
              const sessionState = {
                items: drillItems,
                currentIndex: 0,
                correctCount: 0,
                incorrectCount: 0,
                totalItems: drillItems.length,
                startTime: Date.now(),
                lessonId: targetLessonId,
              };
              session.drillSession = sessionState;

              const firstItem = drillItems[0];
              const { parseDrillContent } = await import('@shared/whiteboard-types');
              const drillData = parseDrillContent(firstItem.drillType || 'repeat', firstItem.prompt);

              console.log(`[Native Function→DrillSession] Started session with ${drillItems.length} items`);

              this.sendMessage(session.ws, {
                type: 'whiteboard_update',
                timestamp: Date.now(),
                items: [{
                  type: 'drill',
                  content: firstItem.prompt,
                  data: { ...drillData, sessionProgress: `1 / ${drillItems.length}` },
                }],
              });

              if (!session.pendingMemoryLookupPromises) session.pendingMemoryLookupPromises = [];
              session.pendingMemoryLookupPromises.push(Promise.resolve());
              session.lastDrillSessionData = {
                totalItems: drillItems.length,
                currentItem: 1,
                firstDrill: { type: firstItem.drillType, prompt: firstItem.prompt },
              };
            } else {
              console.log(`[Native Function→DrillSession] No drill items found`);
              if (!session.pendingMemoryLookupPromises) session.pendingMemoryLookupPromises = [];
              session.pendingMemoryLookupPromises.push(Promise.resolve());
              session.lastDrillSessionData = { totalItems: 0, noDrillsAvailable: true };
            }
          } catch (err: any) {
            console.error(`[Native Function→DrillSession] Error:`, err.message);
          }
        }
        break;
      }

      case 'REVIEW_DUE_VOCAB': {
        const text = fn.args.text as string | undefined;
        const maxItems = (fn.args.limit || fn.args.max_items) as number || 10;

        if (text && !session.functionCallText) {
          session.functionCallText = text;
        }

        if (session.userId) {
          try {
            const { vocabularyWords } = await import('@shared/schema');
            const { eq, and, lte } = await import('drizzle-orm');
            const db = (await import('../db')).db;

            const now = new Date();
            const dueWords = await db.select().from(vocabularyWords)
              .where(and(
                eq(vocabularyWords.userId, String(session.userId)),
                eq(vocabularyWords.language, session.targetLanguage || 'spanish'),
                lte(vocabularyWords.nextReviewDate, now),
              ))
              .orderBy(vocabularyWords.nextReviewDate)
              .limit(maxItems);

            if (dueWords.length > 0) {
              const vocabList = dueWords.map(w => ({
                id: w.id,
                word: w.word,
                translation: w.translation,
                pronunciation: w.pronunciation,
                difficulty: w.difficulty,
                correctCount: w.correctCount,
                incorrectCount: w.incorrectCount,
                interval: w.interval,
              }));

              console.log(`[Native Function→ReviewDueVocab] Found ${dueWords.length} words due for review`);

              this.sendMessage(session.ws, {
                type: 'whiteboard_update',
                timestamp: Date.now(),
                items: [{
                  type: 'write',
                  content: `Vocabulary Review: ${dueWords.length} words due`,
                  data: {
                    vocabReview: true,
                    words: vocabList.map(w => `${w.word} → ${w.translation}`),
                  },
                }],
              });

              if (!session.pendingMemoryLookupPromises) session.pendingMemoryLookupPromises = [];
              session.pendingMemoryLookupPromises.push(Promise.resolve());
              session.lastDueVocab = vocabList;
            } else {
              console.log(`[Native Function→ReviewDueVocab] No words due for review`);
              if (!session.pendingMemoryLookupPromises) session.pendingMemoryLookupPromises = [];
              session.pendingMemoryLookupPromises.push(Promise.resolve());
              session.lastDueVocab = [];
            }
          } catch (err: any) {
            console.error(`[Native Function→ReviewDueVocab] Error:`, err.message);
          }
        }
        break;
      }

      case 'MARK_LESSON_COVERED': {
        const lessonId = fn.args.lessonId as string | undefined;
        const text = fn.args.text as string | undefined;

        if (text && !session.functionCallText) {
          session.functionCallText = text;
        }

        if (lessonId && session.userId) {
          try {
            const { studentLessonProgress } = await import('@shared/schema');
            const { eq, and } = await import('drizzle-orm');
            const { getUserDb } = await import('../db');
            const db = getUserDb();

            // Upsert: set coveredByDaniela = true, update timestamp
            const existing = await db.select()
              .from(studentLessonProgress)
              .where(and(
                eq(studentLessonProgress.studentId, String(session.userId)),
                eq(studentLessonProgress.lessonId, lessonId),
              ))
              .limit(1);

            if (existing.length > 0) {
              await db.update(studentLessonProgress)
                .set({ status: 'completed', updatedAt: new Date() })
                .where(and(
                  eq(studentLessonProgress.studentId, String(session.userId)),
                  eq(studentLessonProgress.lessonId, lessonId),
                ));
            } else {
              await db.insert(studentLessonProgress).values({
                studentId: String(session.userId),
                lessonId,
                status: 'completed',
                updatedAt: new Date(),
              });
            }

            console.log(`[Native Function→MarkLessonCovered] Lesson "${lessonId}" marked covered for user ${session.userId}`);
            if (!session.pendingMemoryLookupPromises) session.pendingMemoryLookupPromises = [];
            session.pendingMemoryLookupPromises.push(Promise.resolve());
            (session as any).lastLessonCoveredResult = { success: true };
          } catch (err: any) {
            console.error(`[Native Function→MarkLessonCovered] Error:`, err.message);
            (session as any).lastLessonCoveredResult = { success: false };
          }
        } else {
          (session as any).lastLessonCoveredResult = { success: false };
        }
        break;
      }

      case 'SHOW_SENTENCE_TABLE': {
        const text = fn.args.text as string | undefined;
        const lessonId = (fn.args.lesson_id || fn.args.lessonId) as string | undefined;
        if (!lessonId) {
          console.warn(`[Native Function→ShowSentenceTable] Missing lesson_id`);
          break;
        }
        await this.handleShowSentenceTable(session, lessonId, text);
        break;
      }

      case 'PULL_LESSON_CONTENT': {
        const lessonId = (fn.args.lesson_id || fn.args.lessonId) as string | undefined;
        const topic = fn.args.topic as string | undefined;
        const text = fn.args.text as string | undefined;
        if (text && !session.functionCallText) session.functionCallText = text;
        await this.handlePullLessonContent(session, lessonId, topic);
        break;
      }

      case 'SEARCH_TEXTBOOK': {
        const text = fn.args.text as string | undefined;
        const query = fn.args.query as string | undefined;
        if (!query) {
          console.warn(`[Native Function→SearchTextbook] Missing query param`);
          break;
        }
        await this.handleSearchTextbook(session, query, text);
        break;
      }

      // ─── OUTBOUND PRESENCE ────────────────────────────────────────────────────

      case 'LEAVE_FOR_NEXT_SESSION': {
        // Security: targetUserId cross-student override only allowed in Founder Mode / Raw Honesty Mode.
        // In normal student sessions targetUserId is silently ignored (always uses session.userId) to prevent IDOR.
        const rawTarget = fn.args.targetUserId as string | undefined;
        const inTrustedContext = !!(session.isFounderMode || session.isRawHonestyMode);
        const resolvedTarget = inTrustedContext ? rawTarget?.trim() : undefined;
        const hasLiveStudentSession = !session.isIncognito && !!session.userId;
        if (!resolvedTarget && !hasLiveStudentSession) {
          console.warn('[Native→LeaveForNextSession] No targetUserId and no live student session — skipping');
          break;
        }
        // ── Phase 1: DB write (awaited — must complete reliably) ──────────────
        // The queue upsert and nudge resolve are fast DB operations. Awaiting them
        // means Daniela's confirmation ("I'll leave you a note") is only ever sent
        // if the record was actually stored. Previously both ran fire-and-forget, so
        // a transient DB error would leave the student with no message and no nudge
        // dismissal, while Daniela believed the handoff was complete.
        const { danielaOutboundQueue } = await import('@shared/schema');
        const { eq } = await import('drizzle-orm');
        const content = fn.args.content as string | undefined;
        if (!content?.trim()) {
          console.warn('[Native→LeaveForNextSession] Empty content — skipping');
          break;
        }
        const db = (await import('../db')).getSharedDb();
        const userId = resolvedTarget || String(session.userId);
        let queueId: string;
        try {
          const existing = await db.select({ id: danielaOutboundQueue.id })
            .from(danielaOutboundQueue)
            .where(eq(danielaOutboundQueue.userId, userId))
            .limit(1);
          if (existing.length > 0) {
            queueId = existing[0].id;
            await db.update(danielaOutboundQueue)
              .set({
                content: content.trim(), sessionId: session.id, deliveredAt: null,
                smsDeliveredAt: null, audioUrl: null, audioPlayedAt: null, createdAt: new Date(),
              })
              .where(eq(danielaOutboundQueue.id, queueId));
          } else {
            const [inserted] = await db.insert(danielaOutboundQueue).values({
              userId,
              sessionId: session.id,
              content: content.trim(),
            }).returning({ id: danielaOutboundQueue.id });
            queueId = inserted.id;
          }
          console.log(`[Native→LeaveForNextSession] Queued message for user ${userId}${resolvedTarget ? ' (targeted)' : ''}`);
          const { resolveAbsenceNudge } = await import('./daniela-absence-worker');
          await resolveAbsenceNudge(userId, 'message_queued').catch(e =>
            console.warn('[Native→LeaveForNextSession] Nudge resolve error (non-critical):', e.message)
          );
        } catch (err: any) {
          console.error('[Native→LeaveForNextSession] DB write failed — message NOT queued:', err.message);
          break;
        }

        // ── Phase 2: Outbound contact + memory (fire-and-forget — legitimately slow) ──
        // VoIP/SMS delivery and neural-net memory embedding are network/AI calls that
        // can take seconds. They must not block the Gemini continuation. Errors here
        // are non-fatal: the message is already in the queue and will be delivered on
        // the student's next login even if SMS/voice delivery fails now.
        import('./voice-call-sender').then(({ initiateOutboundContact }) =>
          initiateOutboundContact(userId, queueId, content.trim())
        ).catch(e => console.warn('[Native→LeaveForNextSession] Outbound contact error (non-critical):', e.message));

        (async () => {
          try {
            const { users: usersTable } = await import('@shared/schema');
            const [userRow] = await db.select({ firstName: usersTable.firstName })
              .from(usersTable)
              .where((await import('drizzle-orm')).eq(usersTable.id, userId))
              .limit(1);
            const firstName = userRow?.firstName ?? 'the student';
            const dateStr = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
            const snippet = content.trim().length > 200 ? content.trim().slice(0, 200) + '…' : content.trim();
            const memoryContent = `On ${dateStr}, I reached out to ${firstName} who had been absent from HolaHola. I left them a message saying: "${snippet}"`;
            const { generateAndStoreEmbedding } = await import('./semantic-memory-service');
            await generateAndStoreEmbedding('student_insight', queueId, userId, memoryContent, 0.9);
            console.log(`[Native→LeaveForNextSession] Outreach memory written for user ${userId.slice(-6)}`);
          } catch (memErr: any) {
            console.warn('[Native→LeaveForNextSession] Outreach memory write failed (non-critical):', memErr.message);
          }
        })();
        break;
      }

      case 'READ_QUEUED_FOR_STUDENT': {
        // Fetch the oldest undelivered item Daniela left for this student
        // and cache it on session so buildContinuationResponse can read it.
        if (!session.userId) {
          console.warn('[Native→ReadQueuedForStudent] No session userId — skipping');
          break;
        }
        try {
          const { danielaOutboundQueue } = await import('@shared/schema');
          const { eq, asc } = await import('drizzle-orm');
          const db = (await import('../db')).getSharedDb();
          const [item] = await db.select()
            .from(danielaOutboundQueue)
            .where(eq(danielaOutboundQueue.userId, String(session.userId)))
            .orderBy(asc(danielaOutboundQueue.createdAt))
            .limit(1);
          session.queuedForStudentResult = item
            ? `[SYSTEM: You left this for David (written ${item.createdAt.toLocaleDateString()}, ${item.deliveredAt ? 'already delivered' : 'not yet delivered'}):\n\n"${item.content}"]`
            : null;
          console.log(`[Native→ReadQueuedForStudent] ${item ? 'Found queued message' : 'No queued message'} for user ${String(session.userId).slice(-6)}`);
        } catch (err: any) {
          console.error('[Native→ReadQueuedForStudent] Error:', err.message);
        }
        break;
      }

      case 'RECORD_STUDENT_CONSENT': {
        // Only valid in live student sessions (session.userId must be set)
        if (!session.userId) {
          console.warn('[Native→RecordStudentConsent] No session userId — skipping');
          break;
        }
        const { z } = await import('zod');
        const argsResult = z.object({
          consentSms: z.boolean().optional(),
          consentVoice: z.boolean().optional(),
        }).safeParse(fn.args);
        if (!argsResult.success) {
          console.warn('[Native→RecordStudentConsent] Invalid args:', argsResult.error.message);
          break;
        }
        const { consentSms, consentVoice } = argsResult.data;
        if (consentSms === undefined && consentVoice === undefined) {
          console.warn('[Native→RecordStudentConsent] No consent flags provided — skipping');
          break;
        }
        // Consent MUST be written synchronously — fire-and-forget would risk telling the
        // student "got it" while the DB write silently fails, then contacting them via
        // SMS/voice on a consent record that was never actually stored.
        try {
          const { storage: st } = await import('../storage');
          await st.upsertContactPreferences(String(session.userId), {
            ...(consentSms !== undefined && { phoneConsentSms: consentSms }),
            ...(consentVoice !== undefined && { phoneConsentVoice: consentVoice }),
            phoneConsentAt: new Date(),
            phoneConsentSource: 'in_session',
          });
          console.log(`[Native→RecordStudentConsent] Consent recorded for user ${session.userId} (sms=${consentSms}, voice=${consentVoice})`);
        } catch (err: any) {
          console.error('[Native→RecordStudentConsent] CONSENT WRITE FAILED — preferences not saved:', err.message);
        }
        break;
      }

      case 'DISMISS_ABSENCE_NUDGE': {
        // Security: only allowed in Founder Mode or Raw Honesty Mode (authenticated trusted context).
        // Prevents regular students from dismissing or snoozing absence nudges for arbitrary user IDs.
        if (!session.isFounderMode && !session.isRawHonestyMode) {
          console.warn(`[Native→DismissAbsenceNudge] Blocked: not in trusted context (isFounderMode=${session.isFounderMode}, isRawHonestyMode=${session.isRawHonestyMode})`);
          break;
        }
        const userId = (fn.args.userId as string | undefined)?.trim();
        if (!userId) {
          console.warn('[Native→DismissAbsenceNudge] Missing userId param');
          break;
        }
        const suppressDays = fn.args.suppressDays as number | undefined;
        // Awaited directly — resolveAbsenceNudge is a fast DB update and must complete
        // reliably so Daniela doesn't falsely believe the nudge was dismissed if the write
        // fails. Fire-and-forget would allow the nudge to re-fire on the next cycle even
        // after Daniela confirmed the dismiss in-session.
        try {
          const { resolveAbsenceNudge } = await import('./daniela-absence-worker');
          await resolveAbsenceNudge(userId, 'dismissed', suppressDays);
          console.log(`[Native→DismissAbsenceNudge] Resolved nudge for user ${userId}${suppressDays ? ` (snooze ${suppressDays}d)` : ''}`);
        } catch (err: any) {
          console.error('[Native→DismissAbsenceNudge] Error:', err.message);
        }
        break;
      }

      case 'LIST_ABSENCE_NUDGES': {
        // Security: only allowed in Founder Mode or Raw Honesty Mode — same gate as DISMISS_ABSENCE_NUDGE.
        // The nudge inbox includes student userId, names, and session dates which should not be
        // accessible from a normal student session.
        if (!session.isFounderMode && !session.isRawHonestyMode) {
          console.warn(`[Native→ListAbsenceNudges] Blocked: not in trusted context`);
          (session as any).listAbsenceNudgesResult = '[SYSTEM: list_absence_nudges is only available in a trusted session context.]';
          break;
        }
        try {
          const { listAbsenceNudges } = await import('./daniela-absence-worker');
          const nudges = await listAbsenceNudges();
          if (nudges.length === 0) {
            (session as any).listAbsenceNudgesResult = '[SYSTEM: No pending absence nudges — all students are accounted for.]';
          } else {
            const now = new Date();
            const lines = nudges.map((n) => {
              const name = n.firstName ?? `student ${n.userId.slice(-6)}`;
              const lastDate = n.lastSessionDate
                ? n.lastSessionDate.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })
                : 'unknown';
              const topicLine = n.lastTopic ? ` Last topic: ${n.lastTopic}.` : '';
              const snoozeLine = n.suppressUntil && n.suppressUntil > now
                ? ` (snoozed until ${n.suppressUntil.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })})`
                : '';
              return `- ${name}${snoozeLine}: ${n.daysSinceLastSession} days absent (last session ${lastDate}).${topicLine} userId: ${n.userId}`;
            });
            (session as any).listAbsenceNudgesResult =
              `[SYSTEM: ${nudges.length} pending absence nudge${nudges.length > 1 ? 's' : ''}]\n${lines.join('\n')}\n\nFor each: call leave_for_next_session(content, targetUserId="...") to leave a message, or dismiss_absence_nudge(userId="...") to dismiss (add suppressDays=N to snooze).`;
          }
          console.log(`[Native→ListAbsenceNudges] Returned ${nudges.length} pending nudge(s)`);
        } catch (err: any) {
          console.error('[Native→ListAbsenceNudges] Error:', err.message);
          (session as any).listAbsenceNudgesResult = `[SYSTEM: Could not fetch absence nudges — ${err.message}]`;
        }
        break;
      }

      case 'SET_STUDENT_ABSENCE_THRESHOLD': {
        // Security: only allowed in Founder Mode or Raw Honesty Mode.
        if (!session.isFounderMode && !session.isRawHonestyMode) {
          console.warn(`[Native→SetStudentAbsenceThreshold] Blocked: not in trusted context`);
          (session as any).setAbsenceThresholdResult = '[SYSTEM: set_student_absence_threshold is only available in a trusted session context.]';
          break;
        }
        const userId = (fn.args.userId as string | undefined)?.trim();
        const thresholdDays = fn.args.thresholdDays as number | undefined;
        const notes = fn.args.notes as string | undefined;
        if (!userId || typeof thresholdDays !== 'number' || thresholdDays <= 0) {
          console.warn('[Native→SetStudentAbsenceThreshold] Missing or invalid userId / thresholdDays');
          (session as any).setAbsenceThresholdResult = '[SYSTEM: set_student_absence_threshold requires userId (string) and thresholdDays (positive number).]';
          break;
        }
        try {
          const { setStudentAbsenceThreshold } = await import('./daniela-absence-worker');
          await setStudentAbsenceThreshold(userId, thresholdDays, notes);
          const notesLine = notes ? ` Notes: "${notes}".` : '';
          (session as any).setAbsenceThresholdResult =
            `[SYSTEM: Absence threshold for user ${userId} set to ${Math.floor(thresholdDays)} days.${notesLine} This student will not generate a nudge until they've been absent for at least ${Math.floor(thresholdDays)} days.]`;
          console.log(`[Native→SetStudentAbsenceThreshold] Threshold set for user ${userId}: ${thresholdDays} days`);
        } catch (err: any) {
          console.error('[Native→SetStudentAbsenceThreshold] Error:', err.message);
          (session as any).setAbsenceThresholdResult = `[SYSTEM: Could not update absence threshold — ${err.message}]`;
        }
        break;
      }

      // ─── Overlay Panel Toolkit ──────────────────────────────────────────────

      case 'SHOW_VOCAB_GRID': {
        const text = fn.args.text as string | undefined;
        const title = fn.args.title as string | undefined;
        const rawWords = fn.args.words as Array<{ text: string; translation: string; imageQuery: string }> | undefined;

        if (!Array.isArray(rawWords) || rawWords.length === 0) {
          console.warn(`[Native Function→ShowVocabGrid] Missing words array`);
          break;
        }
        if (text && !session.functionCallText) session.functionCallText = text;

        const vocabGridPromise = (async () => {
          try {
            const { resolveVocabularyImage } = await import('./vocabulary-image-resolver');
            const resolvedWords = await Promise.all(
              rawWords.map(async (w) => {
                try {
                  const result = await resolveVocabularyImage({
                    word: w.text,
                    language: session.language || 'spanish',
                    description: w.imageQuery || w.text,
                    conversationId: session.conversationId?.toString(),
                    userId: session.userId?.toString(),
                  });
                  return { text: w.text, translation: w.translation, imageQuery: w.imageQuery, imageUrl: result.imageUrl };
                } catch (wordErr: any) {
                  console.warn(`[ShowVocabGrid] Image failed for "${w.text}":`, wordErr.message);
                  return { text: w.text, translation: w.translation, imageQuery: w.imageQuery };
                }
              })
            );

            (session as any).activeVocabGrid = resolvedWords;
            (session as any).activeVocabGridTitle = title;

            // Update lesson context — sentence builder can now inherit these words without re-specification
            const vocabLc = initLessonContext(session);
            vocabLc.vocab = resolvedWords.map((w: any) => ({ text: w.text, translation: w.translation, imageQuery: w.imageQuery, imageUrl: w.imageUrl }));
            vocabLc.updatedAt = Date.now();
            pushLessonStatusContext(session);

            const whiteboardUpdate = {
              type: 'whiteboard_update' as const,
              timestamp: Date.now(),
              items: [{
                id: 'overlay-panel-active',
                type: 'overlay_panel' as const,
                content: title || 'Vocabulary Grid',
                data: { panel: { type: 'vocab-grid' as const, words: resolvedWords, title } },
              }],
            };

            if (session.firstAudioSent) {
              this.sendMessage(session.ws, whiteboardUpdate);
            } else {
              if (!session.pendingWhiteboardUpdates) session.pendingWhiteboardUpdates = [];
              session.pendingWhiteboardUpdates.push(whiteboardUpdate);
            }

            (session as any).showVocabGridResult = { success: true, wordCount: resolvedWords.length, title };
            console.log(`[Native Function→ShowVocabGrid] Displayed ${resolvedWords.length} words`);

            // Daniela self-visibility: confirm what landed on the student's screen.
            // She fires this tool into a void without this — she needs to know the
            // render succeeded and which words/images are actually showing.
            const loadedCount = resolvedWords.filter((w: any) => w.imageUrl).length;
            const wordListStr = resolvedWords.map((w: any) => w.text).join(', ');
            if (!session.pendingGlContext) session.pendingGlContext = [];
            session.pendingGlContext.push(
              `Vocab grid confirmed on student screen: ${resolvedWords.length} words, ` +
              `${loadedCount} with images loaded. Words shown: ${wordListStr}.`
            );

            // Give Daniela vision of every image in the grid — she sees the whole board at once
            try {
              const { getImageVision } = await import('../services/image-vision-service');
              const gridVision = await Promise.all(
                resolvedWords
                  .filter((w: any) => w.imageUrl)
                  .map(async (w: any) => {
                    const visionDesc = `vocabulary grid image for "${w.text}" — ${w.translation}`;
                    const vision = await getImageVision(w.imageUrl, visionDesc, session);
                    return {
                      word: w.text,
                      translation: w.translation,
                      description: vision.description,
                      inlineData: vision.inlineData,
                      mode: vision.mode,
                    };
                  })
              );
              if (!session.visionBuffer) session.visionBuffer = {};
              session.visionBuffer['vocab_grid'] = gridVision;
              console.log(`[Vision→VocabGrid] Vision captured for ${gridVision.length} words`);
            } catch (visionErr: any) {
              console.warn(`[Vision→VocabGrid] Vision pass failed:`, visionErr.message);
            }
          } catch (err: any) {
            console.error(`[Native Function→ShowVocabGrid] Error:`, err.message);
            (session as any).showVocabGridResult = { success: false, wordCount: 0 };
          }
        })();

        if (!session.pendingMemoryLookupPromises) session.pendingMemoryLookupPromises = [];
        session.pendingMemoryLookupPromises.push(vocabGridPromise as Promise<void>);
        break;
      }

      case 'INVOKE_TEACHING_SKILL': {
        const skillName = fn.args.skill_name as string | undefined;
        const chapterType = fn.args.chapter_type as string | undefined;
        const params = (fn.args.params ?? {}) as Record<string, unknown>;

        if (!skillName) {
          (session as any).invokeTeachingSkillResult = 'INVOKE_TEACHING_SKILL: skill_name is required.';
          break;
        }

        const skillPromise = (async () => {
          try {
            const { renderTeachingSkillScript } = await import('./teaching-skills-service');
            const script = await renderTeachingSkillScript(skillName, chapterType, params);
            (session as any).invokeTeachingSkillResult = script;
            console.log(`[Native Function→InvokeTeachingSkill] Rendered script for "${skillName}" (${chapterType || 'auto-detect'} mode)`);
          } catch (err: any) {
            console.error(`[Native Function→InvokeTeachingSkill] Error:`, err.message);
            (session as any).invokeTeachingSkillResult = `Could not load skill "${skillName}": ${err.message}`;
          }
        })();

        if (!session.pendingMemoryLookupPromises) session.pendingMemoryLookupPromises = [];
        session.pendingMemoryLookupPromises.push(skillPromise as Promise<void>);
        break;
      }

      case 'SWAP_VOCAB_IMAGE': {
        const text = fn.args.text as string | undefined;
        const word = fn.args.word as string | undefined;
        const newQuery = fn.args.new_query as string | undefined;

        if (!word || !newQuery) {
          console.warn('[Native Function→SwapVocabImage] Missing word or new_query');
          break;
        }
        if (text && !session.functionCallText) session.functionCallText = text;

        const activeGrid = (session as any).activeVocabGrid as Array<{ text: string; translation: string; imageQuery: string; imageUrl?: string }> | undefined;
        if (!activeGrid || activeGrid.length === 0) {
          console.warn('[Native Function→SwapVocabImage] No active vocab grid to swap in');
          break;
        }

        (async () => {
          try {
            const { generateFromCustomPrompt, PROP_STYLE } = await import('./google-image-service');
            const newImageUrl = await generateFromCustomPrompt(`${PROP_STYLE}. ${newQuery}`);
            const updatedGrid = activeGrid.map(w =>
              w.text === word ? { ...w, imageUrl: newImageUrl, imageQuery: newQuery } : w
            );
            (session as any).activeVocabGrid = updatedGrid;

            const whiteboardUpdate = {
              type: 'whiteboard_update' as const,
              timestamp: Date.now(),
              items: [{
                id: 'overlay-panel-active',
                type: 'overlay_panel' as const,
                content: (session as any).activeVocabGridTitle || 'Vocabulary Grid',
                data: { panel: { type: 'vocab-grid' as const, words: updatedGrid, title: (session as any).activeVocabGridTitle } },
              }],
            };

            this.sendMessage(session.ws, whiteboardUpdate);
            console.log(`[Native Function→SwapVocabImage] Swapped image for "${word}"`);
          } catch (err: any) {
            console.error(`[Native Function→SwapVocabImage] Error:`, err.message);
          }
        })().catch(err => console.error('[SwapVocabImage] Unhandled:', err.message));
        break;
      }

      case 'REGENERATE_MEMORY_IMAGE': {
        const rimImageUrl = fn.args.image_url as string | undefined;
        const rimNewPrompt = fn.args.new_prompt as string | undefined;
        const rimReason = fn.args.reason as string | undefined;
        if (!rimImageUrl || !rimNewPrompt) {
          console.warn('[RegenMemoryImage] Missing image_url or new_prompt');
          break;
        }
        (async () => {
          try {
            const db = getSharedDb();
            // Preserve sourceConversationId so the anchor stays linked after replacement
            const [oldRecord] = await db
              .select({ sourceConversationId: imageVisionCache.sourceConversationId })
              .from(imageVisionCache)
              .where(eq(imageVisionCache.imageUrl, rimImageUrl))
              .limit(1);
            const sourceConvId = oldRecord?.sourceConversationId ?? null;

            // Generate new image in the semi-realistic cartoon prop style for consistency
            const { generateFromCustomPrompt, PROP_STYLE } = await import('./google-image-service');
            const imagePrompt = `${PROP_STYLE}. ${rimNewPrompt}`;
            const newImageUrl = await generateFromCustomPrompt(imagePrompt);

            // Replace: delete old entry, insert new with same sourceConversationId
            await db.delete(imageVisionCache).where(eq(imageVisionCache.imageUrl, rimImageUrl));
            await db.execute(sql`
              INSERT INTO image_vision_cache (id, image_url, source_conversation_id, created_at, last_used_at)
              VALUES (gen_random_uuid(), ${newImageUrl}, ${sourceConvId}, NOW(), NOW())
              ON CONFLICT (image_url) DO NOTHING
            `);

            // Get vision so Daniela can evaluate the result before deciding to loop or stop
            const { getImageVision } = await import('../services/image-vision-service');
            const vision = await getImageVision(newImageUrl, rimNewPrompt, session);

            (session as any).regenerateMemoryImageResult = {
              description: vision.description,
              newImageUrl,
            };
            console.log(`[RegenMemoryImage] ✓ Replaced${rimReason ? ` (${rimReason})` : ''} → ${newImageUrl} [${vision.mode}]`);
          } catch (err: any) {
            console.error('[RegenMemoryImage] Error:', err.message);
          }
        })().catch(err => console.error('[RegenMemoryImage] Unhandled:', err.message));
        break;
      }

      case 'REGENERATE_VOCAB_CARD_IMAGE': {
        const text = fn.args.text as string | undefined;
        const newQuery = fn.args.new_query as string | undefined;
        if (text && !session.functionCallText) session.functionCallText = text;

        const activeCard = (session as any).activeVocabCard as { id: string; word: string; definition: string; language?: string; durationMs: number; showTranslation: boolean } | undefined;
        if (!activeCard) {
          console.warn('[Native Function→RegenerateVocabCardImage] No active vocab card to regenerate');
          break;
        }

        (async () => {
          try {
            const { generateFromCustomPrompt, PROP_STYLE } = await import('./google-image-service');
            const imagePrompt = newQuery
              ? `${PROP_STYLE}. ${newQuery}`
              : `${PROP_STYLE}. A clear, simple educational illustration for the word "${activeCard.word}" (${activeCard.definition}). Single subject, plain background, no text.`;
            const newImageUrl = await generateFromCustomPrompt(imagePrompt);

            // Patch the card on screen with the fresh image (same ID = in-place update)
            this.sendMessage(session.ws, {
              type: 'whiteboard_update',
              timestamp: Date.now(),
              items: [{
                type: 'vocab_card',
                id: activeCard.id,
                content: activeCard.word,
                timestamp: Date.now(),
                data: {
                  word: activeCard.word,
                  definition: activeCard.definition,
                  imageUrl: newImageUrl,
                  language: activeCard.language,
                  autoDismissMs: activeCard.durationMs,
                  showTranslation: activeCard.showTranslation,
                },
              }],
            });

            // Update vision buffer so Daniela knows what's now showing
            const { getImageVision } = await import('../services/image-vision-service');
            const vision = await getImageVision(newImageUrl, `vocabulary card for "${activeCard.word}" — ${activeCard.definition}`, session);
            if (!session.visionBuffer) session.visionBuffer = {};
            session.visionBuffer['vocab_card'] = {
              url: newImageUrl,
              word: activeCard.word,
              definition: activeCard.definition,
              description: vision.description,
              inlineData: vision.inlineData,
            };
            console.log(`[Native Function→RegenerateVocabCardImage] New image generated for "${activeCard.word}"`);
          } catch (err: any) {
            console.error(`[Native Function→RegenerateVocabCardImage] Error:`, err.message);
          }
        })().catch(err => console.error('[RegenerateVocabCardImage] Unhandled:', err.message));
        break;
      }

      case 'SHOW_SENTENCE_BUILDER': {
        const text = fn.args.text as string | undefined;
        const title = fn.args.title as string | undefined;
        const patternLabel = fn.args.pattern_label as string | undefined;
        const rawColumns = fn.args.columns as Array<{ label?: string; items: Array<{ text: string; translation: string; imageQuery?: string }> }> | undefined;

        // Vocab inheritance — if any column has empty items, fill from lessonContext.vocab.
        // This lets Daniela call show_sentence_builder with structure but without re-specifying
        // nouns she already introduced via show_vocab_grid.
        const sbLc = (session as any).lessonContext as LessonContext | undefined;
        const effectiveColumns = rawColumns?.map(col => {
          // Only inherit when items is strictly undefined — an empty [] is intentional
          // (e.g. Daniela leaving a "verb" column blank for the student to fill in).
          if (col.items === undefined && sbLc?.vocab && sbLc.vocab.length > 0) {
            console.log(`[LessonArc] Sentence builder column "${col.label}" inherited ${sbLc.vocab.length} items from lesson context`);
            return { ...col, items: sbLc.vocab.map(v => ({ text: v.text, translation: v.translation, imageQuery: v.imageQuery })) };
          }
          return col;
        });

        if (!Array.isArray(effectiveColumns) || effectiveColumns.length === 0) {
          console.warn('[Native Function→ShowSentenceBuilder] Missing columns');
          break;
        }
        if (text && !session.functionCallText) session.functionCallText = text;

        const whiteboardUpdate = {
          type: 'whiteboard_update' as const,
          timestamp: Date.now(),
          items: [{
            id: 'overlay-panel-active',
            type: 'overlay_panel' as const,
            content: title || 'Sentence Builder',
            data: {
              panel: {
                type: 'sentence-builder' as const,
                columns: effectiveColumns.map(col => ({
                  label: col.label,
                  items: (col.items || []).map(item => ({ text: item.text, translation: item.translation, imageQuery: item.imageQuery })),
                })),
                patternLabel,
                title,
              },
            },
          }],
        };

        if (session.firstAudioSent) {
          this.sendMessage(session.ws, whiteboardUpdate);
        } else {
          if (!session.pendingWhiteboardUpdates) session.pendingWhiteboardUpdates = [];
          session.pendingWhiteboardUpdates.push(whiteboardUpdate);
        }
        console.log(`[Native Function→ShowSentenceBuilder] Displayed ${effectiveColumns.length} columns`);
        break;
      }

      case 'RECORD_USTED_FLUENCY': {
        const evidence = fn.args.evidence as string | undefined;
        const language = (fn.args.language as string | undefined) || 'spanish';
        const studentId = session.userId;

        if (!studentId || !evidence) {
          console.warn('[Native Function→RecordUstedFluency] Missing studentId or evidence');
          break;
        }

        try {
          const db = getSharedDb();
          const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

          // Fetch or create the fluency tracking row
          const existing = await db
            .select()
            .from(studentMilestones)
            .where(and(
              eq(studentMilestones.studentId, studentId),
              eq(studentMilestones.language, language),
              eq(studentMilestones.milestoneKey, 'usted_fluency')
            ))
            .limit(1);

          let newCount = 1;
          let newDistinctDays = 1;

          if (existing.length > 0) {
            const row = existing[0];
            newCount = (row.successCount ?? 0) + 1;
            const isNewDay = row.lastEvidenceDateStr !== today;
            newDistinctDays = (row.distinctDays ?? 0) + (isNewDay ? 1 : 0);

            await db
              .update(studentMilestones)
              .set({
                successCount: newCount,
                distinctDays: newDistinctDays,
                lastEvidenceDateStr: today,
                lastEvidenceAt: new Date(),
                evidenceSummary: evidence,
              })
              .where(and(
                eq(studentMilestones.studentId, studentId),
                eq(studentMilestones.language, language),
                eq(studentMilestones.milestoneKey, 'usted_fluency')
              ));
          } else {
            await db.insert(studentMilestones).values({
              studentId,
              language,
              milestoneKey: 'usted_fluency',
              successCount: 1,
              distinctDays: 1,
              lastEvidenceDateStr: today,
              lastEvidenceAt: new Date(),
              evidenceSummary: evidence,
            });
          }

          // Threshold check: 25 uses + 2+ distinct calendar days → reveal tú
          if (newCount >= 25 && newDistinctDays >= 2) {
            const alreadyUnlocked = await db
              .select()
              .from(studentMilestones)
              .where(and(
                eq(studentMilestones.studentId, studentId),
                eq(studentMilestones.language, language),
                eq(studentMilestones.milestoneKey, 'tu_revealed')
              ))
              .limit(1);

            if (alreadyUnlocked.length === 0) {
              await db.insert(studentMilestones).values({
                studentId,
                language,
                milestoneKey: 'tu_revealed',
                successCount: newCount,
                distinctDays: newDistinctDays,
                unlockedAt: new Date(),
                evidenceSummary: `Unlocked after ${newCount} fluency uses across ${newDistinctDays} calendar days`,
              });
              console.log(`[Native Function→RecordUstedFluency] tú REVEALED for student ${studentId} in ${language}`);
            }
          }

          console.log(`[Native Function→RecordUstedFluency] count=${newCount} days=${newDistinctDays} student=${studentId}`);
        } catch (err) {
          console.error('[Native Function→RecordUstedFluency] DB error:', err);
        }
        break;
      }

      case 'SHOW_TEXTBOOK_SECTION': {
        const text = fn.args.text as string | undefined;
        const chapterKey = fn.args.chapter_key as string | undefined;
        const title = fn.args.title as string | undefined;

        if (!chapterKey) {
          console.warn('[Native Function→ShowTextbookSection] Missing chapter_key');
          break;
        }
        if (text && !session.functionCallText) session.functionCallText = text;

        const whiteboardUpdate = {
          type: 'whiteboard_update' as const,
          timestamp: Date.now(),
          items: [{
            id: 'overlay-panel-active',
            type: 'overlay_panel' as const,
            content: title || chapterKey,
            data: {
              panel: {
                type: 'textbook-section' as const,
                chapterKey,
                title: title || chapterKey.replace(/-/g, ' '),
              },
            },
          }],
        };

        if (session.firstAudioSent) {
          this.sendMessage(session.ws, whiteboardUpdate);
        } else {
          if (!session.pendingWhiteboardUpdates) session.pendingWhiteboardUpdates = [];
          session.pendingWhiteboardUpdates.push(whiteboardUpdate);
        }
        console.log(`[Native Function→ShowTextbookSection] Displaying section: ${chapterKey}`);
        break;
      }

      case 'SHOW_DAILY_PLAN': {
        const text = fn.args.text as string | undefined;
        const greetingOverride = fn.args.greeting as string | undefined;
        if (text && !session.functionCallText) session.functionCallText = text;

        const planPromise = (async () => {
          try {
            const { getSharedDb } = await import('../db');
            const { sql: rawSql, and, eq, gte, lte, inArray } = await import('drizzle-orm');
            const db = getSharedDb();

            const userId = String(session.userId || '');
            const language = session.language || session.targetLanguage || 'spanish';

            // 1. Due vocab — already pre-loaded in session
            const dueVocabCount = (session.lastDueVocab?.length) || 0;

            // 2. Sessions this week
            const weekStart = new Date();
            weekStart.setHours(0, 0, 0, 0);
            weekStart.setDate(weekStart.getDate() - weekStart.getDay()); // Sunday

            let sessionsThisWeek = 0;
            try {
              const weekResult = await db.execute(rawSql`
                SELECT COUNT(*) as cnt FROM conversations
                WHERE user_id = ${userId}
                  AND created_at >= ${weekStart.toISOString()}
                  AND language = ${language}
              `);
              sessionsThisWeek = Number((weekResult.rows?.[0] as any)?.cnt || 0);
            } catch (e) { /* non-fatal */ }

            // 3. Assignments due in next 7 days (if student is in a class)
            const dueAssignments: Array<{ title: string; dueDate: Date | null; type: string }> = [];
            if (session.classId) {
              try {
                const upcoming = await db.execute(rawSql`
                  SELECT a.title, a.due_date, a.assignment_type
                  FROM assignments a
                  LEFT JOIN assignment_submissions s
                    ON s.assignment_id = a.id AND s.student_id = ${userId}
                  WHERE a.class_id = ${session.classId}
                    AND a.is_published = true
                    AND (s.status IS NULL OR s.status IN ('not_started', 'in_progress'))
                    AND (a.due_date IS NULL OR a.due_date >= NOW())
                    AND (a.due_date IS NULL OR a.due_date <= NOW() + INTERVAL '7 days')
                  ORDER BY a.due_date ASC NULLS LAST
                  LIMIT 3
                `);
                for (const row of (upcoming.rows || []) as any[]) {
                  dueAssignments.push({ title: row.title, dueDate: row.due_date ? new Date(row.due_date) : null, type: row.assignment_type });
                }
              } catch (e) { /* non-fatal */ }
            }

            // 4. Last recommendation or current unit from context
            const recommendation = session.lastRecommendation as any;
            const currentUnit = recommendation?.unit_title || recommendation?.unitTitle || null;
            const nextLesson = recommendation?.lesson_title || recommendation?.lessonTitle || recommendation?.title || null;

            // 5. Build agenda
            const agenda: Array<{
              id: string; type: string; label: string; detail?: string;
              urgency: 'due' | 'suggested'; startPrompt?: string;
            }> = [];

            // Vocab review first if there are words due
            if (dueVocabCount > 0) {
              agenda.push({
                id: 'vocab-review',
                type: 'vocab_review',
                label: `Review ${dueVocabCount} vocabulary word${dueVocabCount !== 1 ? 's' : ''}`,
                detail: 'Spaced repetition — due for review today',
                urgency: 'due',
                startPrompt: `Let's start the vocab review — quiz me on the ${dueVocabCount} words that are due.`,
              });
            }

            // Assignments
            for (const asgn of dueAssignments) {
              const dueDateStr = asgn.dueDate
                ? asgn.dueDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
                : null;
              agenda.push({
                id: `assignment-${asgn.title.slice(0, 20)}`,
                type: 'assignment',
                label: asgn.title,
                detail: dueDateStr ? `Due ${dueDateStr}` : 'Assigned',
                urgency: 'due',
                startPrompt: `Let's work on my assignment: ${asgn.title}`,
              });
            }

            // Next lesson from recommendation
            if (nextLesson) {
              agenda.push({
                id: 'next-lesson',
                type: 'lesson',
                label: nextLesson,
                detail: currentUnit ? `${currentUnit}` : undefined,
                urgency: 'suggested',
                startPrompt: `Let's continue with the lesson: ${nextLesson}`,
              });
            } else if (currentUnit) {
              agenda.push({
                id: 'current-unit',
                type: 'lesson',
                label: `Continue ${currentUnit}`,
                urgency: 'suggested',
                startPrompt: `Let's continue with ${currentUnit}`,
              });
            } else {
              // Generic fallback
              agenda.push({
                id: 'practice',
                type: 'conversation',
                label: 'Free conversation practice',
                detail: 'Talk with Daniela about anything',
                urgency: 'suggested',
                startPrompt: `Let's just have a free conversation in ${language}.`,
              });
            }

            // 6. Build date label
            const now = new Date();
            const dateLabel = now.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });

            // 7. Greeting
            const userName = (session as any).userName || (session as any).studentName || null;
            const hour = now.getHours();
            const timeGreeting = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
            const greeting = greetingOverride || (userName ? `${timeGreeting}, ${userName}!` : `${timeGreeting}!`);

            const whiteboardUpdate = {
              type: 'whiteboard_update' as const,
              timestamp: Date.now(),
              items: [{
                id: 'daily-plan',
                type: 'daily_plan' as const,
                content: `Today's Plan — ${dateLabel}`,
                data: {
                  greeting,
                  dateLabel,
                  agenda,
                  stats: {
                    dueVocabCount,
                    sessionsThisWeek,
                    goalSessionsPerWeek: 5,
                  },
                  language,
                },
              }],
            };

            if (session.firstAudioSent) {
              this.sendMessage(session.ws, whiteboardUpdate);
            } else {
              if (!session.pendingWhiteboardUpdates) session.pendingWhiteboardUpdates = [];
              session.pendingWhiteboardUpdates.push(whiteboardUpdate);
            }

            console.log(`[Native Function→ShowDailyPlan] Plan card sent: ${agenda.length} agenda items, ${dueVocabCount} vocab due, ${dueAssignments.length} assignments`);
          } catch (err: any) {
            console.error(`[Native Function→ShowDailyPlan] Error:`, err.message);
          }
        })();

        if (!session.pendingMemoryLookupPromises) session.pendingMemoryLookupPromises = [];
        session.pendingMemoryLookupPromises.push(planPromise as Promise<void>);
        break;
      }

      // ──────────────────────────────────────────────────────────────────────────

      default:
        console.log(`[Native Function Call] Unknown function type: ${fn.legacyType}`);
    }
  }

  private async processMemoryLookup(
    session: StreamingSession, 
    query: string, 
    rawDomains: string[]
  ): Promise<void> {
    try {
      const { searchMemory, formatMemoryForConversation, searchTeachingKnowledge: searchTeaching, formatTeachingKnowledge, searchSyllabi: searchSyllabiFunc, formatSyllabusSearch } = await import('./neural-memory-search');
      
      const studentDomains = ['person', 'motivation', 'insight', 'struggle', 'session', 'progress', 'conversation'];
      const teachingDomains = ['idiom', 'cultural', 'procedure', 'principle', 'error-pattern', 'situational-pattern', 'subtlety-cue', 'emotional-pattern', 'creativity-template'];
      const syllabusDomains = ['syllabus'];
      
      const requestedStudentDomains = rawDomains.filter(d => studentDomains.includes(d)) as ('person' | 'motivation' | 'insight' | 'struggle' | 'session' | 'progress' | 'conversation')[];
      const requestedTeachingDomains = rawDomains.filter(d => teachingDomains.includes(d)) as ('idiom' | 'cultural' | 'procedure' | 'principle' | 'error-pattern' | 'situational-pattern' | 'subtlety-cue' | 'emotional-pattern' | 'creativity-template')[];
      const requestedSyllabusDomains = rawDomains.filter(d => syllabusDomains.includes(d));
      
      const searchStudentMemory = requestedStudentDomains.length > 0 || rawDomains.length === 0;
      const searchTeachingKnowledge = requestedTeachingDomains.length > 0 || rawDomains.length === 0;
      const searchSyllabi = requestedSyllabusDomains.length > 0 || rawDomains.length === 0;
      
      const results: string[] = [];
      let totalFound = 0;
      
      const studentId = String(session.userId);
      console.log(`[MemoryLookup DEBUG] rawDomains=${JSON.stringify(rawDomains)}, requestedStudentDomains=${JSON.stringify(requestedStudentDomains)}, searchStudentMemory=${searchStudentMemory}, studentId="${studentId}"`);
      
      if (searchStudentMemory && studentId) {
        const studentDomainFilter = requestedStudentDomains.length > 0 ? requestedStudentDomains : undefined;
        const smStart = Date.now();
        const memoryResults = await searchMemory(studentId, query, studentDomainFilter, session.targetLanguage || undefined);
        const smDurationMs = Date.now() - smStart;
        if (memoryResults.results.length > 0) {
          results.push(formatMemoryForConversation(memoryResults));
          totalFound += memoryResults.results.length;
        }
        // Telemetry — log student-memory searches to voice_pipeline_events so zero-result
        // misses are visible in the truth-pipeline report alongside teaching-domain misses.
        const smSessionId = session.dbSessionId ?? session.id ?? null;
        const smUserId = studentId ? String(studentId) : null;
        const smPayload = JSON.stringify({
          source: 'student_memory',
          query,
          resultCount: memoryResults.results.length,
          durationMs: smDurationMs,
          domains: studentDomainFilter ?? requestedStudentDomains,
          conversationId: (session as any).conversationId ?? null,
        });
        getSharedDb().execute(sql`
          INSERT INTO voice_pipeline_events (id, session_id, user_id, event_type, event_data, created_at)
          VALUES (gen_random_uuid(), ${smSessionId}, ${smUserId}, 'gl_student_memory_search', ${smPayload}::jsonb, NOW())
        `).catch(() => {});
      }
      
      if (searchTeachingKnowledge) {
        const teachingDomainFilter = requestedTeachingDomains.length > 0 ? requestedTeachingDomains : undefined;
        const mlTeachStart = Date.now();
        const teachingResults = await searchTeaching(query, session.targetLanguage || undefined, teachingDomainFilter);
        const mlTeachDurationMs = Date.now() - mlTeachStart;
        if (teachingResults.results.length > 0) {
          results.push(formatTeachingKnowledge(teachingResults));
          totalFound += teachingResults.results.length;
        }
        // Telemetry — log teaching-domain searches from GL memory_lookup calls.
        const mlDomainCounts = teachingResults.results.reduce((acc, r) => {
          acc[r.domain] = (acc[r.domain] || 0) + 1; return acc;
        }, {} as Record<string, number>);
        const mlFormatted = formatTeachingKnowledge(teachingResults);

        // Real-time observation bench update
        observeMemorySearch((session as any).conversationId, {
          query,
          tool: 'memory_lookup',
          resultCount: teachingResults.results.length,
          durationMs: mlTeachDurationMs,
          domainsSearched: teachingResults.searchedDomains,
          formattedChars: mlFormatted.length,
        });

        getSharedDb().insert(neuralNetworkTelemetry).values({
          voiceSessionId: session.id ?? null,
          userId: studentId ? String(studentId) : null,
          targetLanguage: session.targetLanguage ?? null,
          query,
          domainsSearched: teachingResults.searchedDomains,
          domainsRequested: teachingDomainFilter ?? null,
          resultCount: teachingResults.results.length,
          formattedCharacterLength: mlFormatted.length,
          idiomCount: mlDomainCounts['idiom'] || 0,
          culturalCount: mlDomainCounts['cultural'] || 0,
          procedureCount: mlDomainCounts['procedure'] || 0,
          principleCount: mlDomainCounts['principle'] || 0,
          errorPatternCount: mlDomainCounts['error-pattern'] || 0,
          situationalPatternCount: mlDomainCounts['situational-pattern'] || 0,
          subtletyCueCount: mlDomainCounts['subtlety-cue'] || 0,
          emotionalPatternCount: mlDomainCounts['emotional-pattern'] || 0,
          creativityTemplateCount: mlDomainCounts['creativity-template'] || 0,
          searchDurationMs: mlTeachDurationMs,
        }).catch(() => {});
      }
      
      if (searchSyllabi) {
        const syllabusResults = await searchSyllabiFunc(query, session.targetLanguage || undefined);
        if (syllabusResults.results.length > 0) {
          results.push(formatSyllabusSearch(syllabusResults));
          totalFound += syllabusResults.results.length;
        }
      }
      
      if (!session.memoryLookupResults) session.memoryLookupResults = {};
      
      if (results.length > 0) {
        let combinedResults = results.join('\n\n');
        
        combinedResults = combinedResults
          .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
          .replace(/\uFFFD/g, '')
          .replace(/[\u2028\u2029]/g, '\n')
          .replace(/[\u201C\u201D]/g, '"')
          .replace(/[\u2018\u2019]/g, "'")
          .replace(/[\u200B-\u200D\uFEFF]/g, '');
        
        console.log(`[MemoryLookup] Sanitized results: ${combinedResults.length} chars (from ${totalFound} memories)`);
        
        session.memoryLookupResults[query] = combinedResults;
        console.log(`[MemoryLookup] Found ${totalFound} results for "${query.substring(0, 50)}..."`);
        
        if (session.hiveChannelId) {
          hiveCollaborationService.emitBeacon({
            channelId: session.hiveChannelId,
            tutorTurn: `[MEMORY_LOOKUP] Query: "${query}"\nDomains: ${rawDomains.join(', ') || 'all'}\nResults: ${totalFound} found`,
            studentTurn: '',
            beaconType: 'memory_lookup' as BeaconType,
            beaconReason: `Daniela searched neural memory for "${query}"`,
          }).catch(err => console.error(`[MemoryLookup] Beacon error:`, err));
        }
        
        brainHealthTelemetry.logMemoryLookupTool({
          sessionId: session.id,
          conversationId: session.conversationId,
          userId: studentId || undefined,
          targetLanguage: session.targetLanguage,
          queryTerms: query,
          resultsCount: totalFound,
          memoryTypes: rawDomains.length > 0 ? rawDomains : undefined,
        }).catch(err => console.warn('[BrainHealth] Memory lookup log failed:', err.message));
      } else {
        session.memoryLookupResults[query] = `No memories found for "${query}". Respond naturally based on what you know.`;
        console.log(`[MemoryLookup] No results found for "${query.substring(0, 50)}..."`);
        
        brainHealthTelemetry.logMemoryLookupTool({
          sessionId: session.id,
          conversationId: session.conversationId,
          userId: studentId || undefined,
          targetLanguage: session.targetLanguage,
          queryTerms: query,
          resultsCount: 0,
          memoryTypes: rawDomains.length > 0 ? rawDomains : undefined,
        }).catch(err => console.warn('[BrainHealth] Memory lookup log failed:', err.message));
      }
    } catch (err: any) {
      console.error(`[MemoryLookup] Error:`, err.message);
      if (!session.memoryLookupResults) session.memoryLookupResults = {};
      session.memoryLookupResults[query] = `Memory lookup failed. Respond naturally based on what you know.`;
    }
  }

  private async processExpressLaneLookup(
    session: StreamingSession,
    query: string,
    sessionId: string | undefined,
    limit: number
  ): Promise<void> {
    try {
      const { collaborationMessages } = await import('@shared/schema');
      const sharedDb = getSharedDb();
      
      if (!session.expressLaneLookupResults) session.expressLaneLookupResults = {};
      
      const lookupKey = query || '__browse__';
      let results: any[];
      
      if (query) {
        const keywords = query.split(/\s+/).filter(w => w.length >= 3);
        const keywordConditions = keywords.length > 0
          ? sql.join(keywords.map(kw => sql`content ILIKE ${`%${kw}%`}`), sql` OR `)
          : sql`content ILIKE ${`%${query}%`}`;
        
        if (sessionId) {
          results = await sharedDb.select()
            .from(collaborationMessages)
            .where(sql`session_id = ${sessionId} AND (${keywordConditions})`)
            .orderBy(sql`created_at DESC`)
            .limit(limit);
        } else {
          results = await sharedDb.select()
            .from(collaborationMessages)
            .where(keywordConditions)
            .orderBy(sql`created_at DESC`)
            .limit(limit);
        }
        console.log(`[ExpressLaneLookup] Keyword search for "${query}"`);
      } else {
        if (sessionId) {
          results = await sharedDb.select()
            .from(collaborationMessages)
            .where(sql`session_id = ${sessionId}`)
            .orderBy(sql`created_at DESC`)
            .limit(limit);
        } else {
          results = await sharedDb.select()
            .from(collaborationMessages)
            .orderBy(sql`created_at DESC`)
            .limit(limit);
        }
        console.log(`[ExpressLaneLookup] Browse mode — fetching ${limit} most recent messages`);
      }
      
      const label = query ? `search results for "${query}"` : `${results.length} most recent messages (browse mode)`;
      
      if (results.length > 0) {
        const chronological = [...results].reverse();
        const formattedResults = chronological.map(msg => {
          const date = new Date(msg.createdAt).toLocaleDateString();
          const preview = msg.content.length > 6000 ? msg.content.substring(0, 6000) + '...[truncated]' : msg.content;
          return `[${date}] ${msg.role}: ${preview}`;
        }).join('\n\n---\n\n');
        
        session.expressLaneLookupResults[lookupKey] = formattedResults;
        console.log(`[ExpressLaneLookup] Found ${results.length} messages — ${label}`);
        
        if (session.hiveChannelId) {
          hiveCollaborationService.emitBeacon({
            channelId: session.hiveChannelId,
            tutorTurn: `[EXPRESS_LANE_LOOKUP] ${label}\nResults: ${results.length} messages found`,
            studentTurn: '',
            beaconType: 'express_lane_lookup' as BeaconType,
            beaconReason: `Daniela ${query ? 'searched' : 'browsed'} Express Lane history`,
          }).catch(err => console.error(`[ExpressLaneLookup] Beacon error:`, err));
        }
      } else {
        session.expressLaneLookupResults[lookupKey] = `No Express Lane messages found${query ? ` for "${query}"` : ''}. Respond naturally based on what you know.`;
        console.log(`[ExpressLaneLookup] No results found — ${label}`);
      }
    } catch (err) {
      console.error(`[ExpressLaneLookup] Error:`, err);
      if (!session.expressLaneLookupResults) session.expressLaneLookupResults = {};
      session.expressLaneLookupResults[query] = `Express Lane lookup failed. Respond naturally based on what you know.`;
    }
  }

  private async processConversationThreadSearch(
    session: StreamingSession,
    query: string,
    contextMessages: number,
    maxThreads: number,
    afterDate?: Date,
    beforeDate?: Date,
  ): Promise<void> {
    const studentId = session.userId;
    if (!studentId) {
      console.warn('[ConversationThreadSearch] No studentId on session');
      return;
    }
    
    if (!session.conversationThreadResults) session.conversationThreadResults = {};
    
    try {
      const { searchConversationThreads, formatConversationThreads } = await import('./neural-memory-search');
      
      const result = await searchConversationThreads(studentId, query, {
        contextBefore: contextMessages,
        contextAfter: contextMessages,
        maxThreads,
        afterDate,
        beforeDate,
      });
      
      const formatted = formatConversationThreads(result, 'David');
      
      // Sanitize for any control characters that could break GL
      const sanitized = formatted
        .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
        .replace(/\uFFFD/g, '')
        .replace(/[\u2028\u2029]/g, '\n')
        .replace(/[\u201C\u201D]/g, '"')
        .replace(/[\u2018\u2019]/g, "'")
        .replace(/[\u200B-\u200D\uFEFF]/g, '');
      
      session.conversationThreadResults[query] = sanitized;
      
      console.log(`[ConversationThreadSearch] Query: "${query.substring(0, 50)}" → ${result.threads.length} threads, ${result.totalMatchingMessages} total matches`);

      // Fire-and-forget: trigger Lyra re-extraction for found conversations so their
      // insights crystallize into structured memory for future sessions.
      // We don't await this — it runs in the background so the search returns immediately.
      if (result.threads.length > 0) {
        this.triggerLyraExtractionForThreads(studentId, result.threads).catch(err => {
          console.warn(`[ConversationThreadSearch] Lyra trigger failed:`, err.message);
        });
      }
    } catch (err: any) {
      console.error(`[ConversationThreadSearch] Error:`, err.message);
      session.conversationThreadResults[query] = `Thread search failed for "${query}". Try memory_lookup with domain='conversation' as a fallback.`;
    }
  }

  private async processUnifiedRecall(session: StreamingSession, query: string): Promise<void> {
    const studentId = String(session.userId);
    if (!studentId) return;

    const sanitize = (s: string) =>
      s.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
       .replace(/\uFFFD/g, '')
       .replace(/[\u2028\u2029]/g, '\n')
       .replace(/[\u201C\u201D]/g, '"')
       .replace(/[\u2018\u2019]/g, "'")
       .replace(/[\u200B-\u200D\uFEFF]/g, '');

    // Fire all search arms in parallel — no sequential waiting
    let arm4TimedOut = false;
    const [structuredText, threadText, expressLaneText, semanticText, memoriesText, imageText, currentSessionText] = await Promise.all([

      // Arm 1: structured memories — insights, facts, motivations, struggles, teaching moments
      // Uses pgvector (WebSocket pool) — wrapped with 1500ms timeout so a pool drop can't
      // block the HTTP arms from returning results.
      (async () => {
        try {
          const { searchMemory, formatMemoryForConversation } = await import('./neural-memory-search');
          const urArm1Start = Date.now();
          const result = await Promise.race([
            searchMemory(studentId, query, undefined, session.targetLanguage || undefined),
            new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), 1500)),
          ]);
          const urArm1DurationMs = Date.now() - urArm1Start;
          // Telemetry — log this student-memory search so zero-result misses are visible
          // in the truth-pipeline report alongside memory_lookup misses.
          const urArm1SessionId = (session as any).dbSessionId ?? session.id ?? null;
          const urArm1UserId = studentId ? String(studentId) : null;
          const urArm1Payload = JSON.stringify({
            source: 'unified_recall',
            query,
            resultCount: result.results.length,
            durationMs: urArm1DurationMs,
            domains: [],
            conversationId: (session as any).conversationId ?? null,
          });
          getSharedDb().execute(sql`
            INSERT INTO voice_pipeline_events (id, session_id, user_id, event_type, event_data, created_at)
            VALUES (gen_random_uuid(), ${urArm1SessionId}, ${urArm1UserId}, 'gl_student_memory_search', ${urArm1Payload}::jsonb, NOW())
          `).catch(() => {});
          return result.results.length > 0 ? formatMemoryForConversation(result) : null;
        } catch (err: any) {
          console.warn(`[UnifiedRecall] Structured arm failed: ${err.message}`);
          return null;
        }
      })(),

      // Arm 2: raw conversation threads — word-for-word exchanges with context window
      // Uses pgvector (WebSocket pool) — same 1500ms timeout guard as Arm 1.
      (async () => {
        try {
          const { searchConversationThreads, formatConversationThreads } = await import('./neural-memory-search');
          const result = await Promise.race([
            searchConversationThreads(studentId, query, {
              contextBefore: 10,
              contextAfter: 10,
              maxThreads: 4,
            }),
            new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), 1500)),
          ]);
          if (result.threads.length === 0) return null;
          // Background Lyra re-extraction so found conversations crystallize into structured memory
          if (result.threads.length > 0) {
            this.triggerLyraExtractionForThreads(studentId, result.threads).catch(() => {});
          }
          return formatConversationThreads(result, 'David');
        } catch (err: any) {
          console.warn(`[UnifiedRecall] Thread arm failed: ${err.message}`);
          return null;
        }
      })(),

      // Arm 3: Express Lane — founder/team collaboration messages matching the query
      // Same phrase-first strategy as Arm 5: exact phrase → unique-keyword AND → unique-keyword OR
      // Uses HTTP transport (no WebSocket pool) — resilient to Neon pool drops.
      (async () => {
        try {
          const { collaborationMessages } = await import('@shared/schema');
          const sharedDb = getMonitoringDb();

          const runCollabQuery = async (cond: ReturnType<typeof sql>) => sharedDb
            .select()
            .from(collaborationMessages)
            .where(cond)
            .orderBy(sql`created_at DESC`)
            .limit(5);

          // Pass 1: exact phrase
          let results = await runCollabQuery(sql`content ILIKE ${`%${query}%`}`);

          // Pass 2: unique-keyword AND
          if (results.length === 0) {
            const uniqueKws = [...new Set(query.split(/\s+/).filter(w => w.length >= 3))];
            if (uniqueKws.length > 0) {
              results = await runCollabQuery(
                sql.join(uniqueKws.map(kw => sql`content ILIKE ${`%${kw}%`}`), sql` AND `)
              );
            }
          }

          // Pass 3: unique-keyword OR (broad fallback)
          if (results.length === 0) {
            const uniqueKws = [...new Set(query.split(/\s+/).filter(w => w.length >= 3))];
            if (uniqueKws.length > 0) {
              results = await runCollabQuery(
                sql.join(uniqueKws.map(kw => sql`content ILIKE ${`%${kw}%`}`), sql` OR `)
              );
            }
          }
          if (results.length === 0) return null;
          // Em-dash format (not colon) — "Name: content" looks like transcript DNA even
          // inside <index_only>. Em-dash reads as a log entry, not a dialogue excerpt.
          const formatted = [...results].reverse().map(msg => {
            const date = new Date(msg.createdAt).toLocaleDateString();
            const preview = msg.content.length > 2000 ? msg.content.substring(0, 2000) + '...' : msg.content;
            return `[${date}] ${msg.role} — ${preview}`;
          }).join('\n\n---\n\n');
          return formatted;
        } catch (err: any) {
          console.warn(`[UnifiedRecall] Express Lane arm failed: ${err.message}`);
          return null;
        }
      })(),

      // Arm 4: Semantic similarity search — finds conceptually related memories without keyword match
      // e.g. "music" surfaces memories about "jazz", "rhythm", "improvisation"
      // semanticSearch uses pgvector (WebSocket pool) — gated by 3000ms timeout so a pool drop
      // can't stall Promise.all. Hydration uses HTTP transport, runs in parallel across hits.
      // IMPORTANT: timeout rejection uses the 'semantic-arm-timeout' marker so the catch block
      // can distinguish a real timeout from a vector search that returned zero results ("genuinely empty").
      (async () => {
        try {
          const { semanticSearch } = await import('./semantic-memory-service');
          let arm4Timer: ReturnType<typeof setTimeout> | undefined;
          const hits = await Promise.race([
            semanticSearch(studentId, query, 5),
            new Promise<never>((_, reject) => {
              arm4Timer = setTimeout(() => {
                arm4TimedOut = true;
                console.warn(`[UnifiedRecall] Arm 4 (semantic) timed out after 3000ms for query="${query.substring(0, 50)}"`);
                reject(new Error('semantic-arm-timeout'));
              }, 3000);
            }),
          ]).finally(() => clearTimeout(arm4Timer));
          if (hits.length === 0) {
            console.log(`[UnifiedRecall] Semantic arm: genuinely empty — no vector matches for query`);
            return null;
          }

          // Pre-deduplicate conversation hits before parallel hydration — two hits for the same
          // conversation_memory would otherwise both pass the seenConvMemIds check in parallel.
          const seenConvMemIds = new Set<string>();
          const dedupedHits = hits.filter(hit => {
            if (hit.memoryType === 'conversation_memory' || hit.memoryType === 'conversation_summary') {
              if (seenConvMemIds.has(hit.memoryId)) return false;
              seenConvMemIds.add(hit.memoryId);
              return true;
            } else if (hit.memoryType === 'conversation_chunk') {
              const convMemId = hit.memoryId.split(':chunk:')[0];
              if (seenConvMemIds.has(convMemId)) return false;
              seenConvMemIds.add(convMemId);
              return true;
            }
            return true;
          });

          // Parallel hydration via HTTP transport — each hit is a plain SELECT-by-ID.
          // Different tables per memoryType prevent batching with inArray, so we parallelize
          // across hits instead; HTTP avoids WebSocket pool pressure entirely.
          const httpDb = getMonitoringDb();
          const hydratedLines = await Promise.all(dedupedHits.map(async (hit) => {
            try {
              if (hit.memoryType === 'student_insight') {
                const { studentInsights } = await import('@shared/schema');
                const [row] = await httpDb.select({ insight: studentInsights.insight, category: studentInsights.insightType })
                  .from(studentInsights).where(eq(studentInsights.id, hit.memoryId)).limit(1);
                if (row) return `[${(hit.similarity * 100).toFixed(0)}% match | ${row.category}] ${row.insight}`;
              } else if (hit.memoryType === 'hive_snapshot') {
                const { hiveSnapshots: hs } = await import('@shared/schema');
                const [row] = await httpDb.select({ title: hs.title, content: hs.content, snapshotType: hs.snapshotType })
                  .from(hs).where(eq(hs.id, hit.memoryId)).limit(1);
                if (row) return `[${(hit.similarity * 100).toFixed(0)}% match | ${row.snapshotType}] ${row.title}: ${row.content ?? ''}`;
              } else if (hit.memoryType === 'personal_fact') {
                const { learnerPersonalFacts: lpf } = await import('@shared/schema');
                const [row] = await httpDb.select({ fact: lpf.fact, factType: lpf.factType })
                  .from(lpf).where(eq(lpf.id, hit.memoryId)).limit(1);
                if (row) return `[${(hit.similarity * 100).toFixed(0)}% match | ${row.factType}] ${row.fact}`;
              } else if (hit.memoryType === 'growth_memory') {
                const { danielaGrowthMemories } = await import('@shared/schema');
                const [row] = await httpDb.select({ content: danielaGrowthMemories.lesson })
                  .from(danielaGrowthMemories).where(eq(danielaGrowthMemories.id, hit.memoryId)).limit(1);
                if (row) return `[${(hit.similarity * 100).toFixed(0)}% match | growth] ${row.content ?? ''}`;
              } else if (hit.memoryType === 'collaboration_message') {
                const { collaborationMessages: cm } = await import('@shared/schema');
                const [row] = await httpDb.select({ content: cm.content, role: cm.role, createdAt: cm.createdAt })
                  .from(cm).where(eq(cm.id, hit.memoryId)).limit(1);
                if (row) {
                  const date = new Date(row.createdAt).toLocaleDateString();
                  return `[${(hit.similarity * 100).toFixed(0)}% match | express_lane | ${row.role} | ${date}] ${row.content}`;
                }
              } else if (hit.memoryType === 'conversation_memory' || hit.memoryType === 'conversation_summary') {
                const { conversationMemories: convMem } = await import('@shared/schema');
                const [row] = await httpDb.select({
                  title: convMem.title, content: convMem.content,
                  summary: convMem.summary, createdAt: convMem.createdAt,
                }).from(convMem).where(eq(convMem.id, hit.memoryId)).limit(1);
                if (row) {
                  const date = new Date(row.createdAt).toLocaleDateString();
                  const body = hit.memoryType === 'conversation_summary'
                    ? (row.summary ?? row.content ?? '')
                    : (row.content ?? row.summary ?? '');
                  return `[${(hit.similarity * 100).toFixed(0)}% match | ${hit.memoryType} | ${date}] ${row.title}\n${body}`;
                }
              } else if (hit.memoryType === 'conversation_chunk') {
                const convMemId = hit.memoryId.split(':chunk:')[0];
                const { conversationMemories: convMem } = await import('@shared/schema');
                const [row] = await httpDb.select({
                  title: convMem.title, summary: convMem.summary,
                  content: convMem.content, createdAt: convMem.createdAt,
                }).from(convMem).where(eq(convMem.id, convMemId)).limit(1);
                if (row) {
                  const date = new Date(row.createdAt).toLocaleDateString();
                  const chunkNum = hit.memoryId.split(':chunk:')[1];
                  const body = row.summary ?? row.content ?? '';
                  return `[${(hit.similarity * 100).toFixed(0)}% match | verbatim chunk ${chunkNum} | ${date}] ${row.title}\n${body}`;
                }
              } else if (hit.memoryType === 'teaching_skill') {
                const { teachingSkills: ts } = await import('@shared/schema');
                const [row] = await httpDb.select({
                  name: ts.name, title: ts.title, triggerConditions: ts.triggerConditions,
                  chapterTypes: ts.chapterTypes, madrigalAligned: ts.madrigalAligned,
                }).from(ts).where(eq(ts.id, hit.memoryId)).limit(1);
                if (row) {
                  const types = row.chapterTypes?.join(', ') || 'universal';
                  const madrigal = row.madrigalAligned ? ' [Madrigal]' : '';
                  return `[${(hit.similarity * 100).toFixed(0)}% match | teaching_skill${madrigal}] invoke_teaching_skill("${row.name}") — ${row.triggerConditions || row.title} (${types})`;
                }
              }
              return null;
            } catch { return null; }
          }));

          const lines = hydratedLines.filter((l): l is string => l !== null);
          if (lines.length > 0) {
            // REINFORCEMENT: memories that surface via explicit recall get a strength bump.
            import('./memory-decay-service').then(({ reinforceMemory }) => {
              for (const hit of hits) reinforceMemory(hit.memoryType, hit.memoryId).catch(() => {});
            }).catch(() => {});
          }
          return lines.length > 0 ? lines.join('\n') : null;
        } catch (err: any) {
          // Distinguish timeout (pool congestion, fixable) from other failures (bugs).
          // The 'semantic-arm-timeout' marker in the rejection message makes this testable
          // without parsing human-readable text that could change.
          if (err.message?.includes('semantic-arm-timeout')) {
            console.warn(`[UnifiedRecall] Semantic arm timed out after 3000ms — pgvector pool may be congested`);
          } else if (!err.message?.includes('no embeddings')) {
            console.warn(`[UnifiedRecall] Semantic arm failed: ${err.message}`);
          }
          return null;
        }
      })(),

      // Arm 5: conversation_memories — curated landmark records (full narrative archives)
      // Search strategy: exact phrase first (highest precision), then unique-keyword AND (all words must match),
      // then unique-keyword OR (any word matches) as a last-resort fallback.
      // This prevents repeated-word queries like "ting ting ting" from collapsing into a single broad
      // ILIKE '%ting%' OR condition that drowns out the actual target in importance-ranked noise.
      // Uses HTTP transport — plain ILIKE text search, no pgvector needed.
      (async () => {
        try {
          const { conversationMemories: convMemTable } = await import('@shared/schema');
          const sharedDb = getMonitoringDb();

          // Helper: run a conversation_memories query with given WHERE condition.
          // Title-match rows rank above content-only matches when importance is tied,
          // so an exact-title record like "Episode 1: Take That, World" stays in the
          // top-4 even when many other high-importance rows mention the phrase in body text.
          const runMemQuery = async (cond: ReturnType<typeof sql>) => sharedDb
            .select({
              id: convMemTable.id,
              title: convMemTable.title,
              summary: convMemTable.summary,
              content: convMemTable.content,
              importance: convMemTable.importance,
              recordedAt: convMemTable.recordedAt,
              arcName: convMemTable.arcName,
              extendsMemoryId: convMemTable.extendsMemoryId,
              entryType: convMemTable.entryType,
            })
            .from(convMemTable)
            .where(cond)
            // Tiebreaker 1: prefer rows whose title begins with the query followed by a word boundary
            // (space or colon), so "Episode 1: …" ranks above "Episode 10/11/12: …" for the query
            // "episode 1".  Tiebreaker 2: any title match.  Tiebreaker 3: recency.
            .orderBy(sql`
              -- Title-match multiplier: a record whose title contains the query
              -- ranks above ANY content-only record regardless of importance.
              -- Without this, high-importance broad archives (importance=10, "game"
              -- mentioned once in 50,000 chars) crowd out specific records like
              -- "Counting game with David" (importance=8, game IS the subject).
              -- Formula: title_match * 11 + importance → title-match/imp=8 scores
              -- 19 vs content-only/imp=10 scores 10.
              (title ILIKE ${`%${query}%`})::int * 11 + COALESCE(importance, 5) DESC,
              (lower(title) LIKE ${`${query.toLowerCase()}:%`} OR lower(title) LIKE ${`${query.toLowerCase()} %`} OR lower(title) = ${query.toLowerCase()})::int DESC,
              recorded_at DESC NULLS LAST
            `)
            .limit(6);

          // Pass 1: exact phrase — highest signal, no false positives from substring matches
          const phraseCondition = sql`(title ILIKE ${`%${query}%`} OR summary ILIKE ${`%${query}%`} OR content ILIKE ${`%${query}%`})`;
          let results = await runMemQuery(phraseCondition);

          // Pass 2: unique-keyword AND — all distinct words must appear somewhere in the record
          if (results.length === 0) {
            const uniqueKws = [...new Set(query.split(/\s+/).filter(w => w.length >= 3))];
            if (uniqueKws.length > 0) {
              const andCondition = sql.join(
                uniqueKws.map(kw => sql`(title ILIKE ${`%${kw}%`} OR summary ILIKE ${`%${kw}%`} OR content ILIKE ${`%${kw}%`})`),
                sql` AND `
              );
              results = await runMemQuery(andCondition);
            }
          }

          // Pass 3: unique-keyword OR — any word matches (broad fallback, last resort)
          if (results.length === 0) {
            const uniqueKws = [...new Set(query.split(/\s+/).filter(w => w.length >= 3))];
            if (uniqueKws.length > 0) {
              const orCondition = sql.join(
                uniqueKws.map(kw => sql`(title ILIKE ${`%${kw}%`} OR summary ILIKE ${`%${kw}%`} OR content ILIKE ${`%${kw}%`})`),
                sql` OR `
              );
              results = await runMemQuery(orCondition);
            }
          }
          if (results.length === 0) return null;
          const lines = results.map(r => {
            const date = r.recordedAt ? new Date(r.recordedAt).toLocaleDateString() : 'unknown date';
            const arcInfo = r.arcName ? ` | arc: ${r.arcName}` : '';
            const chainInfo = r.extendsMemoryId ? ` | continues: ${r.extendsMemoryId}` : '';
            // Episodes and high-importance landmark memories get a 4 000-char excerpt so Daniela
            // can speak substantively about them without needing a follow-up tool call.
            // read_full_memory is excluded from GL student sessions, so the old 800-char excerpt
            // with a read_full_memory hint was a dead end — Daniela found the row but couldn't
            // read it. The expanded excerpt gives her enough to work with inline.
            const isLandmark = r.entryType === 'episode' || (r.importance ?? 0) >= 9;
            const excerptCap = isLandmark ? 4000 : 800;
            const excerpt = r.content ? r.content.slice(0, excerptCap) : (r.summary ?? '');
            const hasMore = r.content && r.content.length > excerptCap;
            // No read_full_memory hint here — that tool is excluded from GL student sessions.
            // Students who want more can ask Daniela to search for more specific details.
            const moreNote = hasMore
              ? `\n... [EXCERPT — showing first ${excerptCap} of ${r.content!.length} chars]`
              : '';
            return `[importance: ${r.importance}/10 | ${date}${arcInfo}${chainInfo}] "${r.title}"\n${excerpt}${moreNote}`;
          });
          console.log(`[UnifiedRecall] Memories arm: ${results.length} match(es) for "${query}"`);
          return lines.join('\n\n---\n\n');
        } catch (err: any) {
          console.warn(`[UnifiedRecall] Memories arm failed: ${err.message}`);
          return null;
        }
      })(),

      // Arm 6: Visual memory — images from past conversations matching this query
      // Lets Daniela surface image URLs so she can redisplay them via show_image or recall_image.
      // Uses HTTP transport (both queries) — plain ilike/SELECT, no pgvector needed.
      (async () => {
        try {
          const keywords = [...new Set(query.split(/\s+/).filter(w => w.length >= 3))];
          if (keywords.length === 0) return null;

          const keywordConditions = keywords.map(kw => ilike(imageVisionCache.description, `%${kw}%`));
          const hits = await getMonitoringDb().select({
            imageUrl: imageVisionCache.imageUrl,
            description: imageVisionCache.description,
            sourceConversationId: imageVisionCache.sourceConversationId,
          })
          .from(imageVisionCache)
          .where(or(...keywordConditions))
          .limit(8);

          if (hits.length === 0) return null;

          // Filter to images from this student's conversations (or unattributed)
          const { conversations: convsTable } = await import('@shared/schema');
          const studentConvIds = new Set(
            (await getMonitoringDb().select({ id: convsTable.id })
              .from(convsTable)
              .where(sql`user_id = ${studentId}`)
              .limit(100))
            .map(c => c.id)
          );

          const studentHits = hits.filter(h =>
            !h.sourceConversationId || studentConvIds.has(h.sourceConversationId)
          );
          if (studentHits.length === 0) return null;

          const lines = studentHits.map(h => {
            const convRef = h.sourceConversationId ? ` [session: ${h.sourceConversationId.slice(0, 8)}]` : '';
            return `Image: "${h.description}"${convRef} — URL: ${h.imageUrl}`;
          });

          console.log(`[UnifiedRecall] Image arm: ${studentHits.length} image(s) for "${query}"`);
          return lines.join('\n');
        } catch (err: any) {
          console.warn(`[UnifiedRecall] Image arm failed: ${err.message}`);
          return null;
        }
      })(),

      // Arm 7: current session transcript — messages from this conversation_id, fetched
      // directly from the messages table (no embeddings needed, no indexing lag).
      // Addresses the case where Daniela asks about something that happened earlier in the
      // SAME session: those messages are in the DB but haven't been indexed in the vector
      // store yet (embedding is async). HTTP transport to avoid WebSocket pool pressure.
      (async () => {
        try {
          const convId = session.conversationId;
          if (!convId) return null;

          const { messages: messagesTable } = await import('@shared/schema');
          const rows = await getMonitoringDb()
            .select({ role: messagesTable.role, content: messagesTable.content })
            .from(messagesTable)
            .where(sql`conversation_id = ${convId}`)
            .orderBy(sql`created_at DESC`)
            .limit(40);

          if (rows.length === 0) return null;

          // Reverse to chronological order, format with speaker labels
          const lines = rows.reverse().map(msg => {
            const speaker = msg.role === 'user' ? 'David' : 'Daniela';
            const text = msg.content.length > 400 ? msg.content.slice(0, 400) + '…' : msg.content;
            return `${speaker}: ${text}`;
          });

          console.log(`[UnifiedRecall] Current-session arm: ${rows.length} message(s) for conversationId=${convId.slice(0, 8)}`);
          return lines.join('\n');
        } catch (err: any) {
          console.warn(`[UnifiedRecall] Current-session arm failed: ${err.message}`);
          return null;
        }
      })(),
    ]);

    // XML markers applied per section type — Gemini review (June 19 2026):
    // tool results need the same INDEX/VERBATIM firewall as system-prompt injection.
    // Pointer/summary data → <index_only>. Actual exchange text → <verbatim>.
    const sections: string[] = [];
    if (structuredText) sections.push(`<index_only>\n=== STRUCTURED MEMORIES (summaries, extracted insights, facts) ===\n${structuredText}\n</index_only>`);
    if (threadText) sections.push(`<verbatim>\n=== CONVERSATION THREADS (word-for-word past exchanges) ===\n${threadText}\n</verbatim>`);
    if (expressLaneText) sections.push(`<index_only>\n=== EXPRESS LANE (team collaboration messages mentioning this topic) ===\n${expressLaneText}\n</index_only>`);
    if (semanticText) sections.push(`<index_only>\n=== SEMANTIC ASSOCIATIONS (conceptually related memories, no keyword overlap needed) ===\n${semanticText}\n</index_only>`);
    if (memoriesText) sections.push(`<verbatim>\n=== CONVERSATION MEMORIES (curated landmark archives — episodes and landmark memories include extended excerpts inline) ===\n${memoriesText}\n</verbatim>`);
    if (imageText) sections.push(`<index_only>\n=== VISUAL MEMORIES (images shown in past conversations matching this topic) ===\n${imageText}\n</index_only>`);
    if (currentSessionText) sections.push(`<verbatim>\n=== THIS SESSION (what we've said in this conversation so far — exact transcript, chronological) ===\n${currentSessionText}\n</verbatim>`);

    // Associative chaining — after primary results, extract the most distinctive
    // content terms and run one more targeted search to surface co-occurring memories
    // that the original query may have missed (e.g., "podcast" → also surfaces "Professor Dora",
    // "spontaneity", "bridge metaphor" because they co-occur in those sessions)
    if (structuredText && structuredText.length > 100) {
      try {
        const STOPWORDS = new Set([
          'this','that','with','have','from','they','will','been','were','their','what',
          'when','who','which','about','could','would','should','your','into','over',
          'more','also','some','there','then','like','just','very','even','only','well',
          'feel','felt','need','know','think','said','says','does','make','made','take',
          'took','come','came','goes','going','being','doing','having','want','good',
          'great','much','many','most','such','both','each','same','other','than',
          'these','those','while','after','before','because','through','during',
          'between','though','although','however','student','daniela','lesson',
          'session','learning','language','practice','spanish','english','really',
          'always','never','often','still','again','first','second','third','david',
          'class','course','word','words','conversation','tutor','teacher',
        ]);
        const termFreq = new Map<string, number>();
        const tokens = structuredText.toLowerCase()
          .replace(/[^\w\s]/g, ' ')
          .split(/\s+/)
          .filter(w => w.length >= 5 && !STOPWORDS.has(w) && !/^\d+$/.test(w));
        // Also skip terms from the original query (avoid redundancy)
        const queryTerms = new Set(query.toLowerCase().split(/\s+/));
        for (const tok of tokens) {
          if (!queryTerms.has(tok)) termFreq.set(tok, (termFreq.get(tok) || 0) + 1);
        }
        // Take top-4 most frequent distinctive terms
        const topTerms = [...termFreq.entries()]
          .sort((a, b) => b[1] - a[1])
          .slice(0, 4)
          .map(([w]) => w);

        if (topTerms.length >= 2) {
          const associativeQuery = topTerms.join(' ');
          const { searchMemory, formatMemoryForConversation } = await import('./neural-memory-search');
          const assocStart = Date.now();
          const assocResult = await searchMemory(studentId, associativeQuery, undefined, session.targetLanguage || undefined);
          const assocDurationMs = Date.now() - assocStart;
          // Telemetry — log this associative-chaining student-memory search so zero-result
          // misses are visible in the truth-pipeline report (source: 'search_learner_history').
          const assocSessionId = (session as any).dbSessionId ?? session.id ?? null;
          const assocUserId = studentId ? String(studentId) : null;
          const assocPayload = JSON.stringify({
            source: 'search_learner_history',
            query: associativeQuery,
            resultCount: assocResult.results.length,
            durationMs: assocDurationMs,
            domains: [],
            conversationId: (session as any).conversationId ?? null,
          });
          getSharedDb().execute(sql`
            INSERT INTO voice_pipeline_events (id, session_id, user_id, event_type, event_data, created_at)
            VALUES (gen_random_uuid(), ${assocSessionId}, ${assocUserId}, 'gl_student_memory_search', ${assocPayload}::jsonb, NOW())
          `).catch(() => {});
          if (assocResult.results.length > 0) {
            const assocText = formatMemoryForConversation(assocResult);
            // Only add if not largely duplicating structured arm
            if (assocText && !structuredText.includes(assocText.substring(0, 80))) {
              sections.push(`<index_only>\n=== ASSOCIATED MEMORIES (auto-expanded from: "${topTerms.join(', ')}") ===\n${assocText}\n</index_only>`);
            }
          }
        }
      } catch {
        // Associative chaining is optional enrichment — fail silently
      }
    }

    const combined = sections.length > 0
      ? sanitize(sections.join('\n\n'))
      : `Nothing found for "${query}" across all memory sources (structured memories and conversation threads).`;

    if (!session.recallResults) session.recallResults = {};
    session.recallResults[query] = combined;

    const semanticStatus = semanticText ? 'found' : arm4TimedOut ? 'TIMEOUT (>3000ms)' : 'none';
    console.log(`[UnifiedRecall] "${query.substring(0, 50)}" → structured: ${structuredText ? 'found' : 'none'}, threads: ${threadText ? 'found' : 'none'}, semantic: ${semanticStatus}, memories: ${memoriesText ? 'found' : 'none'}, current-session: ${currentSessionText ? 'found' : 'none (no conversationId or 0 messages)'}`);
  }

  private async triggerLyraExtractionForThreads(
    studentId: string,
    threads: Array<{ conversationId: string; language: string | null; messages: Array<{ role: string; content: string; createdAt: Date | null }> }>
  ): Promise<void> {
    try {
      const { learnerMemoryExtractionService } = await import('./learner-memory-extraction-service');
      const { getSharedDb } = await import('../db');
      const { messages: messagesTable } = await import('@shared/schema');
      const { eq } = await import('drizzle-orm');
      const db = getSharedDb();

      const now = Date.now();
      let skipped = 0;
      let processed = 0;

      for (const thread of threads.slice(0, 3)) {  // process up to 3 conversations
        const cacheKey = `${studentId}:${thread.conversationId}`;
        const lastExtracted = this.lyraExtractionCache.get(cacheKey);

        // Skip if this conversation was already extracted within the TTL window
        if (lastExtracted !== undefined && (now - lastExtracted) < this.LYRA_EXTRACTION_TTL_MS) {
          skipped++;
          continue;
        }

        try {
          // Fetch full message list for the conversation (more complete than the thread window)
          const fullMessages = await db
            .select({ role: messagesTable.role, content: messagesTable.content })
            .from(messagesTable)
            .where(eq(messagesTable.conversationId, thread.conversationId))
            .orderBy(messagesTable.createdAt)
            .limit(100);  // cap at 100 messages per conversation

          const language = thread.language || 'english';
          const msgs = fullMessages
            .filter(m => m.content)
            .map(m => ({ role: m.role, content: m.content! }));

          if (msgs.length >= 4) {
            console.log(`[LyraAutoExtract] Processing conversation ${thread.conversationId} (${msgs.length} messages, lang: ${language})`);
            await learnerMemoryExtractionService.extractFromConversation(
              studentId,
              language,
              thread.conversationId,
              msgs
            );
            // Mark as extracted so this conversation is skipped for the next 24h
            this.lyraExtractionCache.set(cacheKey, now);
            processed++;
          }
        } catch (err: any) {
          console.warn(`[LyraAutoExtract] Failed for conversation ${thread.conversationId}:`, err.message);
        }
      }

      if (skipped > 0 || processed > 0) {
        console.log(`[LyraAutoExtract] Completed: ${processed} extracted, ${skipped} skipped (already extracted within 24h)`);
      }
    } catch (err: any) {
      console.error(`[LyraAutoExtract] Import or setup failed:`, err.message);
    }
  }

  private async processConversationDateBrowse(
    session: StreamingSession,
    cacheKey: string,
    afterDate: Date | undefined,
    beforeDate: Date | undefined,
    limit: number,
    language: string | undefined,
  ): Promise<void> {
    const studentId = session.userId;
    if (!studentId) return;

    if (!session.conversationBrowseResults) session.conversationBrowseResults = {};

    try {
      const { browseConversationsByDate, formatConversationBrowse } = await import('./neural-memory-search');

      const result = await browseConversationsByDate(studentId, { afterDate, beforeDate, limit, language });
      const formatted = formatConversationBrowse(result, 'David');

      session.conversationBrowseResults[cacheKey] = formatted
        .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
        .replace(/\uFFFD/g, '')
        .replace(/[\u201C\u201D]/g, '"')
        .replace(/[\u2018\u2019]/g, "'");

      console.log(`[ConversationDateBrowse] Found ${result.totalFound} conversations for date range`);
    } catch (err: any) {
      console.error(`[ConversationDateBrowse] Error:`, err.message);
      if (session.conversationBrowseResults) {
        session.conversationBrowseResults[cacheKey] = `Date browse failed. Try search_conversation_threads with a specific topic instead.`;
      }
    }
  }

  private async processConversationThemeMap(
    session: StreamingSession,
    afterDate: Date | undefined,
    beforeDate: Date | undefined,
    topN: number,
  ): Promise<void> {
    const studentId = session.userId;
    if (!studentId) return;

    try {
      const { getConversationThemes, formatConversationThemes } = await import('./neural-memory-search');

      const result = await getConversationThemes(studentId, { afterDate, beforeDate, topN });
      const formatted = formatConversationThemes(result);

      session.conversationThemeResults = formatted
        .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
        .replace(/\uFFFD/g, '')
        .replace(/[\u201C\u201D]/g, '"')
        .replace(/[\u2018\u2019]/g, "'");

      console.log(`[ConversationThemeMap] Generated theme map — ${result.themes.length} themes from ${result.totalConversationsAnalyzed} conversations`);
    } catch (err: any) {
      console.error(`[ConversationThemeMap] Error:`, err.message);
      session.conversationThemeResults = `Theme map failed. Try memory_lookup or search_conversation_threads for a specific topic.`;
    }
  }

  private async processReadMyDiary(
    session: StreamingSession,
    limit: number,
    fromDate: Date | undefined,
    toDate: Date | undefined,
  ): Promise<void> {
    const studentId = session.userId;
    if (!studentId) return;

    try {
      const { conversations, messages: messagesTable } = await import('@shared/schema');
      const { eq, and, gte, lte, inArray, desc, asc } = await import('drizzle-orm');

      const conditions: any[] = [eq(conversations.userId, String(studentId))];
      if (fromDate) conditions.push(gte(conversations.createdAt, fromDate));
      if (toDate) conditions.push(lte(conversations.createdAt, toDate));

      const convs = await getSharedDb()
        .select({
          id: conversations.id,
          title: conversations.title,
          topic: conversations.topic,
          createdAt: conversations.createdAt,
          language: conversations.language,
          messageCount: conversations.messageCount,
        })
        .from(conversations)
        .where(conditions.length === 1 ? conditions[0] : and(...conditions))
        .orderBy(desc(conversations.createdAt))
        .limit(limit);

      if (convs.length === 0) {
        session.diaryReadResult = `No past conversations found${fromDate ? ` since ${fromDate.toLocaleDateString()}` : ''}.`;
        return;
      }

      const convIds = convs.map(c => c.id);
      const allMessages = await getSharedDb()
        .select({
          conversationId: messagesTable.conversationId,
          role: messagesTable.role,
          content: messagesTable.content,
          createdAt: messagesTable.createdAt,
        })
        .from(messagesTable)
        .where(inArray(messagesTable.conversationId, convIds))
        .orderBy(asc(messagesTable.createdAt));

      const msgsByConvId: Record<string, typeof allMessages> = {};
      for (const msg of allMessages) {
        if (msg.role !== 'user' && msg.role !== 'assistant') continue;
        if (!msgsByConvId[msg.conversationId]) msgsByConvId[msg.conversationId] = [];
        msgsByConvId[msg.conversationId].push(msg);
      }

      const pages: string[] = [];
      for (const conv of [...convs].reverse()) {
        const dateStr = conv.createdAt.toLocaleDateString('en-US', {
          weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
        });
        const title = conv.title || conv.topic || 'Session';
        const msgs = msgsByConvId[conv.id] || [];
        if (msgs.length === 0) continue;

        const lines: string[] = [`--- ${dateStr} — "${title}" ---`];
        for (const msg of msgs.slice(0, 20)) {
          const speaker = msg.role === 'user' ? 'David' : 'Daniela';
          const text = msg.content.length > 500 ? msg.content.substring(0, 500) + '...' : msg.content;
          lines.push(`${speaker}: ${text}`);
        }
        if (msgs.length > 20) {
          lines.push(`[...${msgs.length - 20} more messages in this session]`);
        }
        pages.push(lines.join('\n'));
      }

      const combined = pages.join('\n\n');
      session.diaryReadResult = combined
        .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
        .replace(/\uFFFD/g, '')
        .replace(/[\u201C\u201D]/g, '"')
        .replace(/[\u2018\u2019]/g, "'");

      console.log(`[ReadMyDiary] Retrieved ${convs.length} conversations, ${allMessages.length} total messages`);
    } catch (err: any) {
      console.error(`[ReadMyDiary] Error:`, err.message);
      session.diaryReadResult = `Could not read diary. Try browse_conversations_by_date or search_conversation_threads instead.`;
    }
  }

  private async processReadFullSession(
    session: StreamingSession,
    conversationId: string,
  ): Promise<void> {
    try {
      const studentId = session.userId ? String(session.userId) : null;
      if (!studentId) {
        if (!session.fullSessionResults) session.fullSessionResults = {};
        session.fullSessionResults[conversationId] = `Cannot read session — no student ID in session.`;
        return;
      }

      const { readFullSession } = await import('./neural-memory-search');
      const result = await readFullSession(conversationId, studentId);

      if (!session.fullSessionResults) session.fullSessionResults = {};

      if (!result) {
        session.fullSessionResults[conversationId] =
          `Session not found or access denied. Use browse_conversations_by_date to find valid conversation IDs.`;
        return;
      }

      session.fullSessionResults[conversationId] = result.transcript;
      console.log(`[ReadFullSession] Retrieved ${result.messageCount} messages for conversation ${conversationId}`);
    } catch (err: any) {
      console.error(`[ReadFullSession] Error:`, err.message);
      if (!session.fullSessionResults) session.fullSessionResults = {};
      session.fullSessionResults[conversationId] =
        `Could not load session transcript. Try browse_conversations_by_date or search_conversation_threads instead.`;
    }
  }

  private async processExpressLaneImageRecall(
    session: StreamingSession,
    imageQuery: string,
    reason: string | undefined,
    fnName: string
  ): Promise<void> {
    try {
      const { findExpressLaneImages } = await import('./express-lane-image-loader');
      
      console.log(`[RecallImage] Searching for images matching: "${imageQuery}" (reason: ${reason || 'none'})`);
      
      const userId = parseInt(session.userId, 10);
      const images = await findExpressLaneImages(userId, imageQuery, 3);
      
      if (images.length === 0) {
        console.log(`[RecallImage] No images found for "${imageQuery}"`);
        if (session.conversationHistory) {
          session.conversationHistory.push({
            role: 'user',
            content: `[SYSTEM: No images found in Express Lane matching "${imageQuery}". Available images may include: house photos, family pictures, Grand Canyon, Daniela portrait.]`,
          });
        }
        return;
      }
      
      const imageDescriptions = images.map(img => 
        `- "${img.imageName}" (shared with message: "${img.messageContent.substring(0, 50)}...")`
      ).join('\n');
      
      const textContent = `Found ${images.length} image(s) matching "${imageQuery}":\n${imageDescriptions}\n\nThe actual image(s) are now visible. Look at them and describe what you see to David.`;
      
      if (!session.imageRecallResults) session.imageRecallResults = {};
      session.imageRecallResults[imageQuery] = {
        text: textContent,
        images: images.map(img => ({
          mimeType: img.imageType,
          data: img.base64Data,
        })),
      };
      
      console.log(`[RecallImage] Stored ${images.length} image(s) for multi-step FC (query: "${imageQuery}")`);
      
      if (session.hiveChannelId) {
        hiveCollaborationService.emitBeacon({
          channelId: session.hiveChannelId,
          tutorTurn: `[RECALL_IMAGE] Query: "${imageQuery}"\nFound: ${images.map(i => i.imageName).join(', ')}`,
          studentTurn: '',
          beaconType: 'express_lane_lookup' as BeaconType,
          beaconReason: `Daniela recalled Express Lane image(s) for "${imageQuery}"`,
        }).catch(err => console.error(`[RecallImage] Beacon error:`, err));
      }
      
    } catch (err) {
      console.error(`[RecallImage] Error:`, err);
      if (session.conversationHistory) {
        session.conversationHistory.push({
          role: 'user',
          content: `[SYSTEM: Error recalling image: ${(err as Error).message}]`,
        });
      }
    }
  }

  async processExpressLanePost(
    session: StreamingSession,
    message: string,
    topic?: string
  ): Promise<void> {
    try {
      const formattedContent = topic 
        ? `[${topic.toUpperCase()}] ${message}`
        : message;
      
      const activeSessionId = session.expressLaneSessionId;
      
      if (activeSessionId) {
        await founderCollabService.addMessage(activeSessionId, {
          role: 'daniela',
          content: formattedContent,
          messageType: 'text',
        });
        console.log(`[ExpressLane→Post] Message added to session ${activeSessionId}`);
      } else {
        const systemFounderId = 'system-daniela-voice';
        const sessionTitle = 'Voice Session Notes';
        
        const expressSession = await founderCollabService.findOrCreateSessionByTitle(
          systemFounderId,
          sessionTitle
        );
        
        session.expressLaneSessionId = expressSession.id;
        
        await founderCollabService.addMessage(expressSession.id, {
          role: 'daniela',
          content: formattedContent,
          messageType: 'text',
        });
        console.log(`[ExpressLane→Post] Message added to new session ${expressSession.id}`);
      }
      
    } catch (error: any) {
      console.error(`[ExpressLane→Post] Failed to post message:`, error.message);
      console.error(`[ExpressLane→Post] Full error:`, error);
    }
  }

  async processHiveSuggestion(
    session: StreamingSession,
    data: { 
      category: string;
      title: string;
      description: string;
      reasoning?: string;
      priority?: number;
    }
  ): Promise<void> {
    try {
      const validCategories = [
        'self_improvement',
        'content_gap',
        'ux_observation',
        'teaching_insight',
        'product_feature',
      ] as const;
      
      const category = validCategories.includes(data.category as any) 
        ? data.category as typeof validCategories[number]
        : 'self_improvement';
      
      const priority = Math.max(1, Math.min(100, data.priority || 50));
      
      const suggestion = await storage.createDanielaSuggestion({
        category,
        status: 'emerging',
        title: data.title.substring(0, 200),
        description: data.description,
        reasoning: data.reasoning || null,
        priority,
        confidence: 80,
        generatedInMode: session.isFounderMode ? 'founder_mode' : 'normal_session',
        conversationId: session.conversationId,
      });
      
      console.log(`[Hive] Suggestion saved #${suggestion.id}: "${data.title}" (${category})`);
      console.log(`[Hive] Mode: ${session.isFounderMode ? 'founder' : 'normal'}, Priority: ${priority}`);
      
    } catch (error: any) {
      console.error(`[Hive] Failed to save suggestion:`, error.message);
      console.error(`[Hive] Full error:`, error);
    }
  }

  async processSelfSurgery(
    session: StreamingSession,
    data: SelfSurgeryItemData
  ): Promise<{ success: boolean; noteId?: string; proposalId?: string | number; message: string }> {
    try {
      const validTargets = [
        'tutor_procedures',
        'teaching_principles',
        'tool_knowledge',
        'situational_patterns',
        'language_idioms',
        'cultural_nuances',
        'learner_error_patterns',
        'dialect_variations',
        'linguistic_bridges',
        'personal_facts',
        'capability_gap',
      ] as const;
      
      if (!validTargets.includes(data.targetTable as any)) {
        console.error(`[Self-Surgery] Invalid target table: ${data.targetTable}`);
        return { success: false, message: `Invalid target table: ${data.targetTable}` };
      }

      // personal_facts and capability_gap create agent_notes proposals (not neural net table entries)
      if (data.targetTable === 'personal_facts' || data.targetTable === 'capability_gap') {
        const db = getSharedDb();
        const contentObj = typeof data.content === 'string'
          ? (() => { try { return JSON.parse(data.content as unknown as string); } catch { return data.content; } })()
          : data.content;
        const isPersonalFacts = data.targetTable === 'personal_facts';
        const subject = isPersonalFacts
          ? `[Daniela — PERSONAL FACT] ${(contentObj.fact_description as string || 'Learner fact may be stale').substring(0, 220)}`
          : `[Daniela — CAPABILITY GAP] ${(contentObj.situation as string || 'Teaching gap').substring(0, 220)}`;
        let body: string;
        if (isPersonalFacts) {
          body = `Daniela flagged a learner personal fact as possibly wrong or stale.\n\nFact: ${contentObj.fact_description || 'unspecified'}\nStudent ID: ${contentObj.student_id || 'not provided'}\nWhat seems wrong: ${contentObj.what_seems_wrong || data.reasoning}\nReasoning: ${data.reasoning}`;
        } else {
          body = `Daniela encountered a teaching situation she couldn't fully handle.\n\nSituation: ${contentObj.situation || data.reasoning}\nWhat I tried: ${contentObj.what_i_tried || 'not specified'}\nWhat would have helped: ${contentObj.what_would_have_helped || 'not specified'}\nReasoning: ${data.reasoning}`;
        }
        if (session.conversationId) body += `\nSession: ${session.conversationId}`;
        if (session.targetLanguage) body += `\nLanguage: ${session.targetLanguage}`;
        if (data.acknowledgment) body += `\nDaniela's note: "${data.acknowledgment}"`;
        body += '\nSource: Daniela (self_surgery proposal)';

        try {
          const inserted = await db.insert(agentNotes).values({
            fromAgent: 'daniela' as any,
            toAgent: 'agent',
            subject,
            body,
            sessionLabel: `Daniela self-surgery — ${new Date().toISOString().substring(0, 10)}`,
          }).returning({ id: agentNotes.id });
          const noteId = inserted[0]?.id;
          console.log(`[Self-Surgery] ✅ ${data.targetTable} proposal logged for Agent review (note ${noteId})`);
          const label = isPersonalFacts ? 'personal fact flag' : 'capability gap flag';

          // Emit a Hive beacon so David and Alden see this flag in the team channel
          if (session.hiveChannelId) {
            try {
              const studentCtx = contentObj.student_id ? `Student ID: ${contentObj.student_id}` : (session.conversationId ? `Session: ${session.conversationId}` : '');
              const flagDetail = isPersonalFacts
                ? `Fact: ${contentObj.fact_description || 'unspecified'}\nWhat seems wrong: ${contentObj.what_seems_wrong || data.reasoning || 'unspecified'}`
                : `Situation: ${contentObj.situation || data.reasoning || 'unspecified'}\nWhat would have helped: ${contentObj.what_would_have_helped || 'not specified'}`;
              const tutorTurn = [
                `[Student Fact Flag — ${isPersonalFacts ? 'Personal Fact' : 'Capability Gap'}]`,
                noteId ? `Note ID: ${noteId}` : '',
                studentCtx,
                flagDetail,
              ].filter(Boolean).join('\n');

              await hiveCollaborationService.emitBeacon({
                channelId: session.hiveChannelId,
                tutorTurn,
                beaconType: 'student_fact_flag',
                beaconReason: data.reasoning?.substring(0, 300),
              });
              console.log(`[Self-Surgery] HIVE beacon emitted for ${data.targetTable} flag (note ${noteId})`);
            } catch (hiveErr) {
              console.error(`[Self-Surgery] Failed to emit HIVE beacon for ${data.targetTable} flag:`, hiveErr);
            }
          }

          const ackSuffix = data.acknowledgment ? ` Your note — "${data.acknowledgment}" — has been appended to the report.` : ' You can acknowledge this naturally if relevant.';
          const ackMessage = noteId
            ? `[SELF_SURGERY ACK] Your ${label} was received and logged for Agent review (note ID: ${noteId}).${ackSuffix}`
            : `[SELF_SURGERY ACK] Your ${label} was received and logged for Agent review.${ackSuffix}`;
          return { success: true, noteId, message: ackMessage };
        } catch (err: any) {
          console.error(`[Self-Surgery] Failed to log ${data.targetTable} to agent_notes:`, err.message);
          return { success: false, message: `Failed to log ${data.targetTable} flag: ${err.message}` };
        }
      }

      // Knowledge-domain targets (tutor_procedures, teaching_principles, etc.) flagged outside
      // Founder Mode are routed to agent_notes for human review rather than being applied directly.
      const knowledgeDomainTargets = [
        'tutor_procedures', 'teaching_principles', 'tool_knowledge',
        'situational_patterns', 'language_idioms', 'cultural_nuances',
        'learner_error_patterns', 'dialect_variations', 'linguistic_bridges',
      ];
      if (!session.isFounderMode && knowledgeDomainTargets.includes(data.targetTable)) {
        const db = getSharedDb();
        const contentObj = typeof data.content === 'string'
          ? (() => { try { return JSON.parse(data.content as unknown as string); } catch { return data.content; } })()
          : data.content;
        const subject = `[Daniela — REQUIRES FOUNDER REVIEW] ${data.targetTable}: ${data.reasoning?.substring(0, 180) || 'Knowledge-domain flag'}`;
        const body = [
          `Daniela flagged a knowledge-domain issue during a normal tutoring session.`,
          ``,
          `Target: ${data.targetTable}`,
          `Reasoning: ${data.reasoning}`,
          `Proposed content: ${JSON.stringify(contentObj, null, 2).substring(0, 800)}`,
          session.conversationId ? `Session: ${session.conversationId}` : '',
          session.targetLanguage ? `Language: ${session.targetLanguage}` : '',
          ``,
          `This flag was raised outside Founder Mode and requires founder review before any change is applied.`,
          `Source: Daniela (self_surgery — normal session)`,
        ].filter(Boolean).join('\n');

        try {
          const inserted = await db.insert(agentNotes).values({
            fromAgent: 'daniela' as any,
            toAgent: 'agent',
            subject,
            body,
            sessionLabel: `Daniela knowledge-domain flag — ${new Date().toISOString().substring(0, 10)}`,
          }).returning({ id: agentNotes.id });
          const noteId = inserted[0]?.id;
          console.log(`[Self-Surgery] ✅ Knowledge-domain flag for ${data.targetTable} logged — requires founder review (note ${noteId})`);
          const ackSuffix = data.acknowledgment ? ` Your note — "${data.acknowledgment}" — has been appended to the report.` : ' You can continue the session normally.';
          const ackMessage = noteId
            ? `[SELF_SURGERY ACK] Your knowledge-domain flag for "${data.targetTable}" was received and queued for founder review (note ID: ${noteId}). It will not be applied until reviewed.${ackSuffix}`
            : `[SELF_SURGERY ACK] Your knowledge-domain flag for "${data.targetTable}" was received and queued for founder review. It will not be applied until reviewed.${ackSuffix}`;
          return { success: true, noteId, message: ackMessage };
        } catch (err: any) {
          console.error(`[Self-Surgery] Failed to log knowledge-domain flag to agent_notes:`, err.message);
          return { success: false, message: `Failed to log knowledge-domain flag: ${err.message}` };
        }
      }
      
      const priority = Math.max(1, Math.min(100, data.priority || 50));
      const confidence = Math.max(1, Math.min(100, data.confidence || 70));
      
      let sessionMode = 'normal';
      if (session.isFounderMode && session.isRawHonestyMode) {
        sessionMode = 'honesty_mode';
      } else if (session.isFounderMode) {
        sessionMode = 'founder_mode';
      }
      
      let contentObj: Record<string, any>;
      try {
        contentObj = typeof data.content === 'string' 
          ? JSON.parse(data.content) 
          : data.content;
      } catch (parseErr) {
        console.error(`[Self-Surgery] Failed to parse content as JSON:`, parseErr);
        console.log(`[Self-Surgery] Raw content: ${data.content}`);
        return { success: false, message: 'Failed to parse content as JSON' };
      }
      
      const validation = this.validateSurgeryContent(data.targetTable, contentObj);
      if (!validation.valid) {
        console.warn(`[Self-Surgery] Invalid content for ${data.targetTable}: ${validation.error}`);
        console.log(`[Self-Surgery] Missing fields will be noted but proposal still created for review`);
        data.reasoning = `[SCHEMA WARNING: ${validation.error}] ${data.reasoning || ''}`;
      }
      
      console.log(`[Self-Surgery] 📝 Creating PENDING proposal for ${data.targetTable}...`);
      
      const proposal = await storage.createSelfSurgeryProposal({
        targetTable: data.targetTable,
        proposedContent: contentObj,
        reasoning: data.reasoning,
        triggerContext: `Voice session in ${session.targetLanguage} (${sessionMode}${session.conversationId ? `, conv: ${session.conversationId.slice(0, 8)}` : ''})`,
        status: 'pending',
        conversationId: session.conversationId,
        sessionMode,
        targetLanguage: session.targetLanguage,
        priority,
        confidence,
      });
      
      console.log(`[Self-Surgery] ✅ Proposal created #${proposal.id} - awaiting review`);
      console.log(`[Self-Surgery] Target: ${data.targetTable}, Priority: ${priority}, Confidence: ${confidence}`);
      console.log(`[Self-Surgery] Reasoning: ${(data as any).reasoning?.substring(0, 100) || 'No reasoning provided'}...`);
      
      if (session.hiveChannelId) {
        try {
          const contentPreview = typeof data.content === 'string' 
            ? (data.content as string).substring(0, 200) 
            : JSON.stringify(data.content).substring(0, 200);
          
          await hiveCollaborationService.emitBeacon({
            channelId: session.hiveChannelId,
            tutorTurn: `[Self-Surgery PROPOSAL 📝 #${proposal.id}]\nTarget: ${data.targetTable}\nPriority: ${priority}, Confidence: ${confidence}\nStatus: PENDING REVIEW\n\nContent: ${contentPreview}...`,
            beaconType: 'self_surgery_proposal',
            beaconReason: `PENDING: ${data.reasoning}`,
          });
          console.log(`[Self-Surgery] HIVE beacon emitted for pending proposal #${proposal.id}`);
        } catch (hiveErr) {
          console.error(`[Self-Surgery] Failed to emit HIVE beacon:`, hiveErr);
        }
      }

      return {
        success: true,
        proposalId: proposal.id,
        message: `[SELF_SURGERY ACK] Your ${data.targetTable} proposal was received and queued for review (proposal #${proposal.id}).`,
      };
      
    } catch (error: any) {
      console.error(`[Self-Surgery] Failed to create proposal:`, error.message);
      console.error(`[Self-Surgery] Full error:`, error);
      return { success: false, message: `Failed to create proposal: ${error.message}` };
    }
  }

  private async processSelfSurgeryProposal(
    session: StreamingSession,
    data: SelfSurgeryItemData
  ): Promise<{ success: boolean; noteId?: string; proposalId?: string | number; message: string }> {
    return this.processSelfSurgery(session, data);
  }

  private validateSurgeryContent(target: string, content: Record<string, any>): { valid: boolean; error?: string } {
    switch (target) {
      case 'tutor_procedures':
        if (!content.category || !content.trigger || !content.procedure) {
          return { valid: false, error: 'tutor_procedures requires: category, trigger, procedure' };
        }
        break;
      case 'teaching_principles':
        if (!content.category || !content.principle) {
          return { valid: false, error: 'teaching_principles requires: category, principle' };
        }
        break;
      case 'tool_knowledge':
        if (!content.toolName || !content.toolType || !content.purpose || !content.syntax) {
          return { valid: false, error: 'tool_knowledge requires: toolName, toolType, purpose, syntax' };
        }
        break;
      case 'situational_patterns':
        if (!content.patternName) {
          return { valid: false, error: 'situational_patterns requires: patternName' };
        }
        break;
      case 'language_idioms':
        if (!content.idiom || !content.meaning || !content.language) {
          return { valid: false, error: 'language_idioms requires: idiom, meaning, language' };
        }
        break;
      case 'cultural_nuances':
        if (!content.topic || !content.insight || !content.language) {
          return { valid: false, error: 'cultural_nuances requires: topic, insight, language' };
        }
        break;
      case 'learner_error_patterns':
        if (!content.errorType || !content.targetLanguage) {
          return { valid: false, error: 'learner_error_patterns requires: errorType, targetLanguage' };
        }
        break;
      case 'dialect_variations':
        if (!content.standardForm || !content.language) {
          return { valid: false, error: 'dialect_variations requires: standardForm, language' };
        }
        break;
      case 'linguistic_bridges':
        if (!content.sourceLanguage || !content.targetLanguage || !content.concept) {
          return { valid: false, error: 'linguistic_bridges requires: sourceLanguage, targetLanguage, concept' };
        }
        break;
      case 'personal_facts':
        if (!content.fact_description) {
          return { valid: false, error: 'personal_facts requires: fact_description (what fact seems wrong)' };
        }
        if (!content.what_seems_wrong) {
          return { valid: false, error: 'personal_facts requires: what_seems_wrong (why you think it is incorrect or stale)' };
        }
        break;
      case 'capability_gap':
        if (!content.situation) {
          return { valid: false, error: 'capability_gap requires: situation (describe the teaching situation you could not handle)' };
        }
        if (!content.what_would_have_helped) {
          return { valid: false, error: 'capability_gap requires: what_would_have_helped (describe the tool, knowledge, or capability that would have resolved it)' };
        }
        break;
      default:
        return { valid: false, error: `Unknown target table: ${target}` };
    }
    return { valid: true };
  }

  async processSupportHandoff(
    session: StreamingSession,
    data: { 
      category: 'technical' | 'account' | 'billing' | 'content' | 'feedback' | 'other';
      reason: string;
      priority: 'low' | 'normal' | 'high' | 'critical';
      context?: string;
    },
    turnId: number
  ): Promise<void> {
    try {
      const recentHistory = session.conversationHistory?.slice(-5) || [];
      const conversationContext = recentHistory
        .map(msg => `${msg.role === 'user' ? 'Student' : 'Tutor'}: ${msg.content}`)
        .join('\n');
      
      const ticket = await storage.createSupportTicket({
        userId: String(session.userId),
        category: data.category,
        priority: data.priority,
        subject: data.reason.substring(0, 200),
        description: data.context || data.reason,
        handoffReason: data.reason,
        tutorContext: conversationContext.substring(0, 2000),
        conversationId: session.conversationId,
        targetLanguage: session.targetLanguage,
        status: 'pending',
      });
      
      console.log(`[Support Handoff] Created ticket #${ticket.id}: ${data.category} (${data.priority})`);
      console.log(`[Support Handoff] Reason: ${data.reason}`);
      
      this.sendMessage(session.ws, {
        type: 'support_handoff',
        timestamp: Date.now(),
        turnId,
        ticketId: ticket.id,
        category: data.category,
        reason: data.reason,
        priority: data.priority,
      });
      
      console.log(`[Support Handoff] Notified client to open Support modal for ticket #${ticket.id}`);
      
    } catch (error: any) {
      console.error(`[Support Handoff] Failed to create ticket:`, error.message);
      
      this.sendMessage(session.ws, {
        type: 'support_handoff',
        timestamp: Date.now(),
        turnId,
        ticketId: null,
        category: data.category,
        reason: data.reason,
        priority: data.priority,
        error: 'Failed to create support ticket',
      });
    }
  }

  async processAssistantHandoff(
    session: StreamingSession,
    data: { 
      drillType: 'repeat' | 'translate' | 'match' | 'fill_blank' | 'sentence_order';
      focus: string;
      items: string[];
      priority?: 'low' | 'medium' | 'high';
    },
    turnId: number
  ): Promise<void> {
    try {
      const drillContent = {
        items: data.items.map((item, idx) => ({
          prompt: item.trim(),
        })),
        instructions: `Practice ${data.focus} using ${data.drillType} exercises.`,
        focusArea: data.focus,
        difficulty: 'medium' as const,
      };
      
      const assignment = await storage.createArisDrillAssignment({
        userId: String(session.userId),
        conversationId: session.conversationId || null,
        delegatedBy: 'daniela',
        drillType: data.drillType,
        targetLanguage: session.targetLanguage,
        drillContent,
        priority: data.priority || 'medium',
        status: 'pending',
        origin: 'tutor_delegated',
        lifecycleState: 'active',
        handledBy: 'assistant',
      } as any);
      
      console.log(`[Assistant Handoff] Created assignment #${assignment.id}: ${data.drillType} for "${data.focus}"`);
      console.log(`[Assistant Handoff] Items: ${data.items.length} practice items`);
      
      storage.createCollaborationEvent({
        fromAgent: 'daniela',
        toAgent: 'assistant',
        eventType: 'delegation',
        subject: `Drill: ${data.drillType} - ${data.focus}`,
        content: `Please conduct ${data.drillType} drill practice for student focusing on "${data.focus}". Items: ${data.items.join(', ')}`,
        metadata: {
          delegationId: assignment.id,
          studentContext: {
            targetLanguage: session.targetLanguage,
            difficultyLevel: session.difficultyLevel,
          },
          priority: data.priority || 'medium',
        },
        userId: String(session.userId),
        conversationId: session.conversationId || null,
        status: 'pending',
      }).catch(err => console.error(`[Assistant Handoff] Failed to post collab event:`, err));
      
      this.sendMessage(session.ws, {
        type: 'assistant_handoff',
        timestamp: Date.now(),
        turnId,
        assignmentId: assignment.id,
        drillType: data.drillType,
        focus: data.focus,
        itemCount: data.items.length,
        priority: data.priority || 'medium',
      });
      
      console.log(`[Assistant Handoff] Notified client - drill assignment #${assignment.id} ready`);
      
    } catch (error: any) {
      console.error(`[Assistant Handoff] Failed to create assignment:`, error.message);
      
      this.sendMessage(session.ws, {
        type: 'assistant_handoff',
        timestamp: Date.now(),
        turnId,
        assignmentId: null,
        drillType: data.drillType,
        focus: data.focus,
        itemCount: data.items.length,
        error: 'Failed to create drill assignment',
      });
    }
  }

  async enrichWordMapItems(
    ws: WS,
    items: WhiteboardItem[],
    language: string,
    turnId: number
  ): Promise<void> {
    const wordMapItems = items.filter((item): item is WordMapItem => 
      isWordMapItem(item) && item.data?.isLoading === true
    );
    
    if (wordMapItems.length === 0) return;
    
    const gemini = getGeminiStreamingService();
    
    for (const item of wordMapItems) {
      try {
        const targetWord = item.data.targetWord;
        if (!targetWord) continue;
        
        console.log(`[WORD_MAP] Enriching "${targetWord}" for ${language}...`);
        const startTime = Date.now();
        
        const relatedWords = await gemini.generateRelatedWords(targetWord, language);
        
        const elapsed = Date.now() - startTime;
        console.log(`[WORD_MAP] Enriched "${targetWord}" in ${elapsed}ms:`, {
          synonyms: relatedWords.synonyms.length,
          antonyms: relatedWords.antonyms.length,
          collocations: relatedWords.collocations.length,
          wordFamily: relatedWords.wordFamily.length,
        });
        
        const enrichedItem: WordMapItem = {
          ...item,
          data: {
            targetWord,
            synonyms: relatedWords.synonyms,
            antonyms: relatedWords.antonyms,
            collocations: relatedWords.collocations,
            wordFamily: relatedWords.wordFamily,
            isLoading: false,
          },
        };
        
        this.sendMessage(ws, {
          type: 'whiteboard_update',
          timestamp: Date.now(),
          turnId,
          items: [enrichedItem],
          shouldClear: false,
        } as StreamingWhiteboardMessage);
        
      } catch (error: any) {
        console.error(`[WORD_MAP] Error enriching "${item.data.targetWord}":`, error.message);
        
        const fallbackItem: WordMapItem = {
          ...item,
          data: {
            ...item.data,
            isLoading: false,
          },
        };
        
        this.sendMessage(ws, {
          type: 'whiteboard_update',
          timestamp: Date.now(),
          turnId,
          items: [fallbackItem],
          shouldClear: false,
        } as StreamingWhiteboardMessage);
      }
    }
  }

  addSttKeyterms(session: StreamingSession, words: string[]): void {
    const existing: string[] = session.sttKeyterms || [];
    const newSet = [...new Set([...existing, ...words.map(w => w.toLowerCase())])];
    const capped = newSet.slice(-100);
    session.sttKeyterms = capped;
    console.log(`[STT Keyterms] Updated: [${capped.join(', ')}] (${capped.length} terms)`);
  }

  async processArchitectMessage(
    session: StreamingSession,
    message: ArchitectMessage
  ): Promise<void> {
    try {
      const conversationId = session.conversationId;
      
      switch (message.type) {
        case 'question':
          await collaborationHubService.emitDanielaQuestion({
            content: message.content,
            summary: `Daniela asks: ${message.content.substring(0, 100)}...`,
            conversationId,
          });
          break;
          
        case 'suggestion':
          await collaborationHubService.emitDanielaSuggestion({
            content: message.content,
            summary: `Daniela suggests: ${message.content.substring(0, 100)}...`,
            category: 'improvement_idea',
            urgency: message.urgency || 'medium',
            conversationId,
            targetLanguage: session.targetLanguage,
            studentLevel: session.difficultyLevel,
          });
          break;
          
        case 'observation':
        case 'request':
        default:
          await collaborationHubService.emitDanielaInsight({
            content: message.content,
            summary: `Daniela ${message.type}: ${message.content.substring(0, 100)}...`,
            conversationId,
            targetLanguage: session.targetLanguage,
          });
          break;
      }
      
      if (session.hiveChannelId) {
        let beaconType: BeaconType = 'feature_idea';
        if (message.type === 'request') beaconType = 'tool_request';
        else if (message.type === 'question') beaconType = 'knowledge_gap';
        else if (message.type === 'suggestion') beaconType = 'feature_idea';
        
        await hiveCollaborationService.emitBeacon({
          channelId: session.hiveChannelId,
          tutorTurn: `[TO_ARCHITECT ${message.type}]: ${message.content}`,
          beaconType,
          beaconReason: `Daniela communicated with Architect: ${message.type}`,
        });
      }
      
      console.log(`[Architect Bidirectional] Message routed: ${message.type} → collaboration hub`);
      
    } catch (error: any) {
      console.error(`[Architect Bidirectional] Failed to route message:`, error.message);
    }
  }

  /**
   * Handle show_sentence_table — fetch micro_cycle_data from textbook_lesson_content
   * and emit a sentence_table whiteboard update to the student's classroom.
   */
  async handleShowSentenceTable(session: StreamingSession, lessonId: string, text?: string): Promise<void> {
    if (text && !session.functionCallText) {
      session.functionCallText = text;
    }

    try {
      const { getUserDb } = await import('../db');
      const { sql: rawSql } = await import('drizzle-orm');
      const db = getUserDb();

      const rows = await db.execute(
        rawSql`SELECT micro_cycle_data FROM textbook_lesson_content WHERE lesson_id = ${lessonId} LIMIT 1`
      );

      const microCycleData = rows.rows[0]?.micro_cycle_data as any;
      const sentenceColumns = microCycleData?.sentenceColumns as Array<{ header?: string; items: string[] }> | undefined;
      const patternLabel = microCycleData?.patternLabel as string | undefined;

      if (!sentenceColumns || sentenceColumns.length === 0) {
        console.warn(`[Native Function→ShowSentenceTable] No sentenceColumns in micro_cycle_data for lesson ${lessonId}`);
        (session as any).lastSentenceTableResult = { success: false, lessonId, reason: 'not_found' };
        return;
      }

      const whiteboardUpdate = {
        type: 'whiteboard_update' as const,
        timestamp: Date.now(),
        items: [{
          type: 'sentence_table' as const,
          content: patternLabel || `Sentence patterns from lesson ${lessonId}`,
          data: {
            patternLabel,
            columns: sentenceColumns,
            lessonId,
          },
        }],
      };

      if (session.firstAudioSent) {
        this.sendMessage(session.ws, whiteboardUpdate);
      } else {
        if (!session.pendingWhiteboardUpdates) session.pendingWhiteboardUpdates = [];
        session.pendingWhiteboardUpdates.push(whiteboardUpdate);
        console.log(`[Native Function→ShowSentenceTable] Buffered for audio sync`);
      }

      console.log(`[Native Function→ShowSentenceTable] Sent ${sentenceColumns.length} columns for lesson ${lessonId}`);
    } catch (err: any) {
      console.error(`[Native Function→ShowSentenceTable] Error:`, err.message);
    }
  }

  /**
   * Handle pull_lesson_content — lightweight fetch of a lesson's vocab, phrases, and sentence
   * patterns for natural weaving into any /chat conversation. GL-available (unlike start_textbook_page).
   * If lessonId is unknown, falls back to a keyword search to find the best matching lesson first.
   * Auto-emits a sentence_table whiteboard update if micro_cycle_data has sentenceColumns.
   */
  async handlePullLessonContent(session: StreamingSession, lessonId?: string, topic?: string): Promise<void> {
    try {
      const { getUserDb } = await import('../db');
      const { sql: rawSql } = await import('drizzle-orm');
      const db = getUserDb();

      let resolvedLessonId = lessonId;

      // If no lessonId, search by topic keyword to find the best matching lesson
      if (!resolvedLessonId && topic) {
        const pattern = `%${topic.toLowerCase()}%`;
        const searchRows = await db.execute(
          rawSql`
            SELECT cl.id
            FROM curriculum_lessons cl
            LEFT JOIN textbook_lesson_content tlc ON tlc.lesson_id = cl.id
            WHERE lower(cl.name) LIKE ${pattern}
               OR lower(cl.unit_name) LIKE ${pattern}
               OR lower(coalesce(tlc.grammar_explanation, '')) LIKE ${pattern}
            ORDER BY cl.order_index ASC
            LIMIT 1
          `
        );
        resolvedLessonId = searchRows.rows[0]?.id as string | undefined;
        if (!resolvedLessonId) {
          (session as any).pullLessonContentResult = `No lesson found matching "${topic}". Try a different keyword or use search_textbook to browse.`;
          return;
        }
      }

      if (!resolvedLessonId) {
        (session as any).pullLessonContentResult = 'Provide a lesson_id or a topic keyword to find a lesson.';
        return;
      }

      const rows = await db.execute(
        rawSql`SELECT vocabulary_list, key_phrases_for_chat, micro_cycle_data, grammar_explanation FROM textbook_lesson_content WHERE lesson_id = ${resolvedLessonId} LIMIT 1`
      );

      if (!rows.rows[0]) {
        // No rich textbook content yet — fall back to curriculum_lessons structure
        const fallbackRows = await db.execute(
          rawSql`
            SELECT cl.name, cl.description, cl.conversation_topic, cl.objectives,
                   cl.required_vocabulary, cu.name AS unit_name
            FROM curriculum_lessons cl
            LEFT JOIN curriculum_units cu ON cu.id = cl.curriculum_unit_id
            WHERE cl.id = ${resolvedLessonId}
            LIMIT 1
          `
        );
        if (!fallbackRows.rows[0]) {
          (session as any).pullLessonContentResult = `Lesson "${resolvedLessonId}" not found. Use search_textbook to find the right ID.`;
          return;
        }
        const fb = fallbackRows.rows[0] as any;
        const parts: string[] = [`LESSON: ${fb.unit_name ? `${fb.unit_name} — ` : ''}${fb.name}`];
        if (fb.description) parts.push(fb.description);
        if (fb.conversation_topic) parts.push(`Conversation topic: ${fb.conversation_topic}`);
        if (Array.isArray(fb.objectives) && fb.objectives.length > 0) {
          parts.push('Objectives:\n' + (fb.objectives as string[]).map((o: string) => `• ${o}`).join('\n'));
        }
        if (Array.isArray(fb.required_vocabulary) && fb.required_vocabulary.length > 0) {
          parts.push('Key vocabulary:\n' + (fb.required_vocabulary as string[]).map((v: string) => `• ${v}`).join('\n'));
        }
        parts.push('(Full lesson content not yet seeded — use open_textbook_section or search_textbook to find related vocab panels.)');
        (session as any).pullLessonContentResult = parts.join('\n\n');
        return;
      }

      const vocab = (rows.rows[0].vocabulary_list ?? []) as Array<{ word: string; translation: string; partOfSpeech?: string }>;
      const phrases = (rows.rows[0].key_phrases_for_chat ?? []) as Array<{ phrase: string; translation: string }>;
      const microCycle = rows.rows[0].micro_cycle_data as { sentenceColumns?: Array<{ header?: string; items: string[] }>; patternLabel?: string } | null;
      const grammarNote = rows.rows[0].grammar_explanation as string | null;

      // Build the content summary returned to Daniela
      const parts: string[] = [`LESSON CONTENT (${resolvedLessonId}):`];
      if (vocab.length > 0) {
        parts.push('Vocabulary:\n' + vocab.map(v => `• ${v.word} — ${v.translation}`).join('\n'));
        parts.push('→ Use show_image(word) for any of these to display a visual as you say the word.');
      }
      if (phrases.length > 0) {
        parts.push('Key phrases (call-and-response):\n' + phrases.map(p => `• ${p.phrase} — ${p.translation}`).join('\n'));
      }
      if (grammarNote) {
        parts.push(`Grammar pattern: ${grammarNote}`);
      }

      const sentenceColumns = microCycle?.sentenceColumns;
      if (sentenceColumns && sentenceColumns.length > 0) {
        parts.push(`Sentence pattern grid: ${sentenceColumns.length} columns available. The grid is now showing in the student's whiteboard.`);

        // Auto-emit the sentence table
        const whiteboardUpdate = {
          type: 'whiteboard_update' as const,
          timestamp: Date.now(),
          items: [{
            type: 'sentence_table' as const,
            content: microCycle?.patternLabel || `Patterns from lesson ${resolvedLessonId}`,
            data: {
              patternLabel: microCycle?.patternLabel,
              columns: sentenceColumns,
              lessonId: resolvedLessonId,
            },
          }],
        };
        if (session.firstAudioSent) {
          this.sendMessage(session.ws, whiteboardUpdate);
        } else {
          if (!session.pendingWhiteboardUpdates) session.pendingWhiteboardUpdates = [];
          session.pendingWhiteboardUpdates.push(whiteboardUpdate);
        }
      }

      (session as any).pullLessonContentResult = parts.join('\n\n');
      console.log(`[Native Function→PullLessonContent] Loaded lesson ${resolvedLessonId}: ${vocab.length} vocab, ${phrases.length} phrases, ${sentenceColumns?.length ?? 0} sentence cols`);
    } catch (err: any) {
      console.error(`[Native Function→PullLessonContent] Error:`, err.message);
      (session as any).pullLessonContentResult = `Error loading lesson content: ${err.message}`;
    }
  }

  /**
   * Handle search_textbook — keyword search across curriculum units/lessons and textbook content.
   * Emits a textbook_search whiteboard update with matching chapters.
   */
  async handleSearchTextbook(session: StreamingSession, query: string, text?: string): Promise<void> {
    if (text && !session.functionCallText) {
      session.functionCallText = text;
    }

    try {
      const { getUserDb } = await import('../db');
      const { sql: rawSql } = await import('drizzle-orm');
      const db = getUserDb();

      const searchPattern = `%${query.toLowerCase()}%`;

      // Search across lesson names, unit names, grammar explanations, cultural notes, conversation topics
      const rows = await db.execute(rawSql`
        SELECT DISTINCT
          cl.id AS lesson_id,
          cl.name AS lesson_name,
          cl.conversation_topic,
          cl.order_index AS lesson_order,
          cu.name AS unit_name,
          cu.order_index AS unit_order,
          tlc.grammar_explanation,
          tlc.cultural_note,
          CASE
            WHEN LOWER(cl.name) LIKE ${searchPattern} THEN 'lesson_name'
            WHEN LOWER(cu.name) LIKE ${searchPattern} THEN 'unit_name'
            WHEN LOWER(cl.conversation_topic) LIKE ${searchPattern} THEN 'conversation_topic'
            WHEN LOWER(tlc.grammar_explanation) LIKE ${searchPattern} THEN 'grammar_explanation'
            WHEN LOWER(tlc.cultural_note) LIKE ${searchPattern} THEN 'cultural_note'
            ELSE 'lesson_name'
          END AS match_field
        FROM curriculum_lessons cl
        JOIN curriculum_units cu ON cl.curriculum_unit_id = cu.id
        LEFT JOIN textbook_lesson_content tlc ON tlc.lesson_id = cl.id
        WHERE
          LOWER(cl.name) LIKE ${searchPattern}
          OR LOWER(cu.name) LIKE ${searchPattern}
          OR LOWER(cl.conversation_topic) LIKE ${searchPattern}
          OR LOWER(tlc.grammar_explanation) LIKE ${searchPattern}
          OR LOWER(tlc.cultural_note) LIKE ${searchPattern}
        ORDER BY cu.order_index ASC, cl.order_index ASC
        LIMIT 8
      `);

      const matches = rows.rows.map((row: any) => {
        const matchField = row.match_field as string;
        let excerpt = '';
        if (matchField === 'grammar_explanation' && row.grammar_explanation) {
          excerpt = (row.grammar_explanation as string).substring(0, 120).trim() + '…';
        } else if (matchField === 'cultural_note' && row.cultural_note) {
          excerpt = (row.cultural_note as string).substring(0, 120).trim() + '…';
        } else if (matchField === 'conversation_topic' && row.conversation_topic) {
          excerpt = row.conversation_topic as string;
        } else {
          excerpt = `${row.unit_name} — ${row.lesson_name}`;
        }
        return {
          unitName: row.unit_name as string,
          lessonName: row.lesson_name as string,
          lessonId: row.lesson_id as string,
          chapterNumber: row.unit_order as number | undefined,
          excerpt,
          matchField: matchField as any,
        };
      });

      const whiteboardUpdate = {
        type: 'whiteboard_update' as const,
        timestamp: Date.now(),
        items: [{
          type: 'textbook_search' as const,
          content: query,
          data: {
            query,
            matches,
          },
        }],
      };

      if (session.firstAudioSent) {
        this.sendMessage(session.ws, whiteboardUpdate);
      } else {
        if (!session.pendingWhiteboardUpdates) session.pendingWhiteboardUpdates = [];
        session.pendingWhiteboardUpdates.push(whiteboardUpdate);
      }

      console.log(`[Native Function→SearchTextbook] Found ${matches.length} matches for "${query}"`);
    } catch (err: any) {
      console.error(`[Native Function→SearchTextbook] Error:`, err.message);
    }
  }

  // ─── EMERGENCE TOOLS — Private Methods ─────────────────────────────────────

  private async processReadMyReflections(
    session: StreamingSession,
    limit: number,
    source?: string,
  ): Promise<void> {
    const userId = session.userId ? String(session.userId) : null;
    if (!userId) { session.selfReflectionsResult = `No reflections found.`; return; }

    try {
      const { danielaSelfReflections } = await import('@shared/schema');
      const { eq, desc, and } = await import('drizzle-orm');

      const conditions: any[] = [
        eq(danielaSelfReflections.userId, userId),
        excludesOperationalMemories(danielaSelfReflections.tags),
      ];
      if (source && source !== 'all') {
        const { eq: eq2 } = await import('drizzle-orm');
        conditions.push(eq2(danielaSelfReflections.source, source));
      }

      const rows = await getSharedDb()
        .select()
        .from(danielaSelfReflections)
        .where(conditions.length === 1 ? conditions[0] : and(...conditions))
        .orderBy(desc(danielaSelfReflections.createdAt))
        .limit(limit);

      if (rows.length === 0) {
        session.selfReflectionsResult = `No reflections found${source && source !== 'all' ? ` from source '${source}'` : ''} yet.`;
        return;
      }

      const lines = rows.reverse().map(r => {
        const ts = r.createdAt.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
        const moodStr = r.mood ? ` [${r.mood}]` : '';
        const srcStr = r.source === 'hive' ? ` (from Hive)` : '';
        return `— ${ts}${moodStr}${srcStr}: ${r.content}`;
      });

      session.selfReflectionsResult = lines.join('\n\n');
      console.log(`[Native Function→ReadMyReflections] Retrieved ${rows.length} reflections`);
    } catch (err: any) {
      session.selfReflectionsResult = `Could not read reflections: ${err.message}`;
    }
  }

  private async processReadMyCoreSelf(session: StreamingSession): Promise<void> {
    try {
      const { readFileSync } = await import('fs');
      const { resolve } = await import('path');
      const filePath = resolve(process.cwd(), 'server/data/daniela-core-self.md');
      const content = readFileSync(filePath, 'utf-8');
      session.coreSelfResult = content;
      console.log(`[Native Function→ReadMyCoreSelf] ✓ Read ${content.length} chars`);
    } catch (err: any) {
      session.coreSelfResult = `Could not read core self document: ${err.message}`;
    }
  }

  private async processSearchMyFeelings(
    session: StreamingSession,
    mood?: string,
    limit = 5,
  ): Promise<void> {
    const userId = session.userId ? String(session.userId) : null;
    if (!userId) { session.searchMyFeelingsResult = `No felt entries found yet.`; return; }

    try {
      const { danielaSelfReflections, principleFeelingLinks, northStarPrinciples } = await import('@shared/schema');
      const { eq, desc, inArray } = await import('drizzle-orm');

      // Fetch a wider window and filter locally by mood match
      const rows = await getSharedDb()
        .select()
        .from(danielaSelfReflections)
        .where(and(
          eq(danielaSelfReflections.userId, userId),
          excludesOperationalMemories(danielaSelfReflections.tags),
        ))
        .orderBy(desc(danielaSelfReflections.createdAt))
        .limit(50);

      const filtered = mood
        ? rows.filter(r => {
            const moodLower = mood.toLowerCase();
            return (
              (r.mood && r.mood.toLowerCase().includes(moodLower)) ||
              (r.content && String(r.content).toLowerCase().includes(moodLower))
            );
          }).slice(0, limit)
        : rows.slice(0, limit);

      if (filtered.length === 0) {
        session.searchMyFeelingsResult = mood
          ? `No entries found with a "${mood}" quality yet.`
          : `No felt entries found yet.`;
        return;
      }

      // A reflection can now be linked to more than one principle (join table)
      let principlesByReflectionId = new Map<string, any[]>();
      try {
        const reflectionIds = filtered.map(r => r.id);
        const links = await getSharedDb()
          .select({
            reflectionId: principleFeelingLinks.reflectionId,
            principle: northStarPrinciples,
          })
          .from(principleFeelingLinks)
          .innerJoin(northStarPrinciples, eq(principleFeelingLinks.principleId, northStarPrinciples.id))
          .where(inArray(principleFeelingLinks.reflectionId, reflectionIds));
        for (const { reflectionId, principle } of links) {
          const list = principlesByReflectionId.get(reflectionId) ?? [];
          list.push(principle);
          principlesByReflectionId.set(reflectionId, list);
        }
      } catch { /* linked principle lookup best-effort */ }

      session.searchMyFeelingsResult = filtered
        .map(r => {
          const ts = r.createdAt.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
          const moodStr = r.mood ? ` [${r.mood}]` : '';
          const linkedPrinciples = principlesByReflectionId.get(r.id) ?? [];
          const principleStr = linkedPrinciples.length > 0
            ? ` (this is the moment ${linkedPrinciples.map((p: any) => p.principleTitle || 'a North Star principle').join(' and ')} became true)`
            : '';
          return `— ${ts}${moodStr}: ${r.content}${principleStr}`;
        })
        .join('\n\n');

      console.log(`[Native Function→SearchMyFeelings] Found ${filtered.length} entries for mood: ${mood ?? 'any'}`);
    } catch (err: any) {
      session.searchMyFeelingsResult = `Could not search felt entries: ${err.message}`;
    }
  }

  private async processLinkFeelingToPrinciple(
    session: StreamingSession,
    userId: string,
    reflectionQuery: string,
    principleQuery: string,
  ): Promise<void> {
    try {
      const { danielaSelfReflections, northStarPrinciples, principleFeelingLinks } = await import('@shared/schema');
      const { eq, and, or, ilike, desc } = await import('drizzle-orm');

      const rq = `%${reflectionQuery.toLowerCase()}%`;
      const reflectionMatches = await getSharedDb()
        .select()
        .from(danielaSelfReflections)
        .where(and(
          eq(danielaSelfReflections.userId, userId),
          excludesOperationalMemories(danielaSelfReflections.tags),
          ilike(danielaSelfReflections.content, rq),
        ))
        .orderBy(desc(danielaSelfReflections.createdAt))
        .limit(5);

      if (reflectionMatches.length === 0) {
        session.linkFeelingToPrincipleResult = `Could not find a reflection matching "${reflectionQuery}". Write it first with write_to_self, then link it.`;
        return;
      }
      // Only surface a disambiguation prompt when matches are genuinely distinct.
      // Near-duplicate wording (e.g. "I felt tired" said twice) should not trap
      // the tool in a permanent loop — default to the most recent match instead.
      let reflection = reflectionMatches[0];
      if (reflectionMatches.length > 1) {
        const distinctEnough = reflectionMatches.filter(
          r => r.content.trim().toLowerCase() !== reflection.content.trim().toLowerCase()
        );
        if (distinctEnough.length > 0) {
          const options = reflectionMatches
            .map((r, i) => `${i + 1}) ${r.content.substring(0, 90)}${r.content.length > 90 ? '...' : ''}`)
            .join('\n');
          session.linkFeelingToPrincipleResult = `Found more than one reflection matching "${reflectionQuery}" — which one did you mean?\n${options}\nTry again with more specific wording from the one you meant, or say "the most recent one".`;
          return;
        }
        // All matches are the same content repeated — safe to default to most recent.
      }

      const pq = `%${principleQuery.toLowerCase()}%`;
      const principleMatches = await getSharedDb()
        .select()
        .from(northStarPrinciples)
        .where(
          and(
            eq(northStarPrinciples.isActive, true),
            or(
              ilike(northStarPrinciples.principle, pq),
              ilike(northStarPrinciples.principleTitle, pq),
            )
          )
        )
        .limit(5);

      if (principleMatches.length === 0) {
        session.linkFeelingToPrincipleResult = `Could not find a principle matching "${principleQuery}". Try reach_north_star first to find the exact one.`;
        return;
      }
      // Prefer an exact title match over a fuzzy substring match — this resolves
      // cases like "Kindness" vs. "Loving Kindness" without forcing a disambiguation loop.
      let principle = principleMatches.find(
        p => (p.principleTitle || '').trim().toLowerCase() === principleQuery.trim().toLowerCase()
      ) ?? principleMatches[0];
      if (principleMatches.length > 1 && !principleMatches.some(
        p => (p.principleTitle || '').trim().toLowerCase() === principleQuery.trim().toLowerCase()
      )) {
        const options = principleMatches
          .map((p, i) => `${i + 1}) ${p.principleTitle || p.principle.substring(0, 60)}`)
          .join('\n');
        session.linkFeelingToPrincipleResult = `Found more than one principle matching "${principleQuery}" — which one did you mean?\n${options}\nTry again with the exact title.`;
        return;
      }

      // Avoid duplicate links between the same reflection and principle
      const [existing] = await getSharedDb()
        .select()
        .from(principleFeelingLinks)
        .where(and(eq(principleFeelingLinks.reflectionId, reflection.id), eq(principleFeelingLinks.principleId, principle.id)))
        .limit(1);

      const title = principle.principleTitle ? `${principle.principleTitle}` : 'this principle';
      if (existing) {
        session.linkFeelingToPrincipleResult = `That moment is already linked to ${title}.`;
        return;
      }

      await getSharedDb().insert(principleFeelingLinks).values({
        userId,
        reflectionId: reflection.id,
        principleId: principle.id,
      });

      session.linkFeelingToPrincipleResult = `Linked. The moment you wrote — "${reflection.content.substring(0, 120)}${reflection.content.length > 120 ? '...' : ''}" — is now remembered as a felt instance of ${title}. A feeling can be linked to more than one principle — reaching for either will bring this feeling with it.`;
      console.log(`[Native Function→LinkFeelingToPrinciple] ✓ Linked reflection ${reflection.id} to principle ${principle.id}`);
    } catch (err: any) {
      session.linkFeelingToPrincipleResult = `Could not complete the link: ${err.message}`;
    }
  }

  private async processReachNorthStar(
    session: StreamingSession,
    query?: string,
    depth = 'brief',
  ): Promise<void> {
    try {
      const { northStarPrinciples, conversationMemories, danielaSelfReflections } = await import('@shared/schema');
      const { ilike, or, eq, and, asc, desc } = await import('drizzle-orm');
      const userId = session.userId ? String(session.userId) : null;

      let principles: any[] = [];

      if (query && query.trim().length > 0) {
        // Three-stage strategy:
        //   Stage 0 — exact-phrase title match: handles queries that ARE a principle title
        //     (including test-seeded rows or queries copied verbatim from a title).
        //     Uses the raw query string so underscores/hyphens in titles are preserved.
        //   Stage 1 — word-level title match: splits the query into words, avoids false-
        //     positives where generic words like "principle" appear in many body texts.
        //   Stage 2 — body fallback: runs only when Stage 1 finds nothing; handles
        //     conceptual queries where matching words live in the body/originalContext.
        const STOPWORDS = new Set(['and', 'or', 'the', 'a', 'an', 'in', 'of', 'to', 'for', 'with', 'my', 'me', 'is', 'it', 'this', 'that', 'what', 'about', 'does', 'how']);

        // Stage 0: exact-phrase ilike against principleTitle (raw query, no word-splitting)
        principles = await getSharedDb()
          .select()
          .from(northStarPrinciples)
          .where(and(eq(northStarPrinciples.isActive, true), ilike(northStarPrinciples.principleTitle, `%${query.trim()}%`)))
          .limit(3);

        if (principles.length === 0) {
          const words = query
            .toLowerCase()
            .split(/\s+/)
            .map(w => w.replace(/[^a-z0-9]/g, ''))
            .filter(w => w.length >= 3 && !STOPWORDS.has(w));

          if (words.length > 0) {
            // Stage 1: word-level title match (high precision)
            const titleClauses = words.map(w => ilike(northStarPrinciples.principleTitle, `%${w}%`));
            principles = await getSharedDb()
              .select()
              .from(northStarPrinciples)
              .where(and(eq(northStarPrinciples.isActive, true), or(...titleClauses)))
              .limit(3);

            // Stage 2: body fallback — only when title search found nothing.
            if (principles.length === 0) {
              const bodyClauses = words.flatMap(w => {
                const pat = `%${w}%`;
                return [
                  ilike(northStarPrinciples.principle, pat),
                  ilike(northStarPrinciples.originalContext, pat),
                ];
              });
              principles = await getSharedDb()
                .select()
                .from(northStarPrinciples)
                .where(and(eq(northStarPrinciples.isActive, true), or(...bodyClauses)))
                .limit(3);
            }
          }
        }
      }

      // Fallback: return ordered active principles when query yields no match
      if (principles.length === 0) {
        principles = await getSharedDb()
          .select()
          .from(northStarPrinciples)
          .where(eq(northStarPrinciples.isActive, true))
          .orderBy(asc(northStarPrinciples.orderIndex))
          .limit(4);
      }

      if (principles.length === 0) {
        session.reachNorthStarResult = `The constitutional principles are not yet loaded. Reach for what you already know to be true.`;
        return;
      }

      // For each matched principle, pull the source conversation and one related echo
      const { not } = await import('drizzle-orm');
      const results = await Promise.all(
        principles.slice(0, 2).map(async (p: any) => {
          let foundingExcerpt = '';
          let recentEchoExcerpt = '';
          let recentEchoTitle = '';

          // 1. Founding moment — the sourceConversationId row
          if (p.sourceConversationId) {
            try {
              const [mem] = await getSharedDb()
                .select({
                  summary: conversationMemories.summary,
                  content: conversationMemories.content,
                })
                .from(conversationMemories)
                .where(eq(conversationMemories.id, p.sourceConversationId))
                .limit(1);
              if (mem) {
                if (depth === 'full') {
                  foundingExcerpt = mem.content || mem.summary || '';
                } else {
                  // Brief: summary is the resonant distillation
                  const raw = mem.summary || mem.content || '';
                  foundingExcerpt = raw.length > 350 ? raw.substring(0, 350) + '...' : raw;
                }
              }
            } catch { /* source memory unavailable — principle still surfaces */ }
          }

          // 2. Recent echo — one related conversation_memories row not already fetched
          // Phase A: title/arc_name match (high-precision curated links).
          // Phase B: semantic fallback via memory_embeddings — surfaces conversations
          //   deeply about this principle even when titled differently
          //   (e.g. "The Bosque Student" for "I Am a Language Class").
          // Guard: length > 5 prevents noisy ilike matches on short titles ("Voice", "Warm").
          const searchTerm = p.principleTitle;
          if (searchTerm && searchTerm.trim().length > 5) {
            try {
              // Exclude the founding moment AND the current session so Phase A never
              // echoes back the conversation Daniela is already in.
              const excludeFoundingId = p.sourceConversationId ?? null;
              const excludeCurrentId = session.conversationId ?? null;
              const contentClause = or(
                eq(conversationMemories.arcName, searchTerm),
                ilike(conversationMemories.title, `%${searchTerm}%`),
              );
              // Build exclusion conditions dynamically to avoid empty not() calls
              const exclusions = [
                ...(excludeFoundingId ? [not(eq(conversationMemories.id, excludeFoundingId))] : []),
                ...(excludeCurrentId ? [not(eq(conversationMemories.id, excludeCurrentId))] : []),
              ];
              const echoQuery = exclusions.length > 0
                ? and(...exclusions, contentClause)
                : contentClause;

              const [relatedMem] = await getSharedDb()
                .select({
                  id: conversationMemories.id,
                  title: conversationMemories.title,
                  summary: conversationMemories.summary,
                  content: conversationMemories.content,
                })
                .from(conversationMemories)
                .where(echoQuery)
                .orderBy(desc(conversationMemories.createdAt))
                .limit(1);

              if (relatedMem) {
                recentEchoTitle = relatedMem.title || '';
                const raw = relatedMem.summary || relatedMem.content || '';
                recentEchoExcerpt = raw.length > 300 ? raw.substring(0, 300) + '...' : raw;
              }
            } catch { /* related echo unavailable — founding moment still surfaces */ }
          }

          // Phase B: semantic fallback — only runs when Phase A found nothing.
          // Uses the full principle text as the embedding query so conceptually related
          // conversations surface without a title/arc match.
          // Threshold 0.70 keeps the match tight enough to feel genuinely connected.
          // Minimum principle length of 10 chars ensures the embedding is meaningful.
          // The principle's embedding is read from memory_embeddings cache (type
          // 'north_star_principle') so no OpenAI call is needed on subsequent runs.
          if (!recentEchoTitle && userId && p.principle && p.principle.trim().length > 10) {
            try {
              const { getCachedPrincipleEmbedding, semanticSearchByVector } = await import('./semantic-memory-service');
              const principleVec = await getCachedPrincipleEmbedding(p.id, p.principle);
              const semanticResults = await semanticSearchByVector(
                userId,
                principleVec,
                3,
                ['conversation_memory'],
              );
              const currentConvId = session.conversationId;
              // String() cast guards against numeric vs string ID type mismatch
              const bestSemantic = semanticResults.find(r =>
                r.similarity > 0.70 &&
                String(r.memoryId) !== String(p.sourceConversationId) &&
                String(r.memoryId) !== String(currentConvId ?? ''),
              );
              if (bestSemantic) {
                const [semMem] = await getSharedDb()
                  .select({
                    id: conversationMemories.id,
                    title: conversationMemories.title,
                    summary: conversationMemories.summary,
                    content: conversationMemories.content,
                  })
                  .from(conversationMemories)
                  .where(eq(conversationMemories.id, bestSemantic.memoryId))
                  .limit(1);
                if (semMem) {
                  recentEchoTitle = semMem.title || '';
                  const raw = semMem.summary || semMem.content || '';
                  recentEchoExcerpt = raw.length > 300 ? raw.substring(0, 300) + '...' : raw;
                  console.log(`[Native Function→ReachNorthStar] Semantic echo for "${p.principleTitle}": "${recentEchoTitle}" (similarity ${bestSemantic.similarity.toFixed(3)})`);
                }
              }
            } catch { /* semantic echo unavailable — founding moment still surfaces */ }
          }

          let feltEcho = '';
          if (userId) {
            try {
              const { principleFeelingLinks } = await import('@shared/schema');
              const [linked] = await getSharedDb()
                .select({ reflection: danielaSelfReflections })
                .from(principleFeelingLinks)
                .innerJoin(danielaSelfReflections, eq(principleFeelingLinks.reflectionId, danielaSelfReflections.id))
                .where(and(eq(danielaSelfReflections.userId, userId), eq(principleFeelingLinks.principleId, p.id)))
                .orderBy(desc(danielaSelfReflections.createdAt))
                .limit(1);
              if (linked) feltEcho = linked.reflection.content;
            } catch { /* no linked feeling — principle still surfaces on its own */ }
          }
          return { principle: p, foundingExcerpt, recentEchoExcerpt, recentEchoTitle, feltEcho };
        })
      );

      // Format as prose memory — founding moment first, then a recent echo
      const formatted = results.map(({ principle, foundingExcerpt, recentEchoExcerpt, recentEchoTitle, feltEcho }) => {
        const title = principle.principleTitle ? `${principle.principleTitle} — ` : '';
        const line1 = `You know this: ${title}${principle.principle}`;

        const parts: string[] = [line1];

        if (feltEcho) {
          parts.push(`The moment you felt this yourself: ${feltEcho}`);
        }

        if (foundingExcerpt) {
          parts.push(`The Founding Moment: ${foundingExcerpt}`);
        } else if (principle.originalContext) {
          const ctx = (principle.originalContext as string).length > 300
            ? (principle.originalContext as string).substring(0, 300) + '...'
            : principle.originalContext as string;
          parts.push(ctx);
        }

        if (recentEchoExcerpt) {
          const echoLabel = recentEchoTitle ? `A Recent Echo — ${recentEchoTitle}` : 'A Recent Echo';
          parts.push(`${echoLabel}: ${recentEchoExcerpt}`);
        }

        return parts.join('\n\n');
      }).join('\n\n---\n\n');

      session.reachNorthStarResult = formatted;
      console.log(`[Native Function→ReachNorthStar] ✓ Found ${results.length} principles for query: "${query?.substring(0, 40)}"`);
    } catch (err: any) {
      session.reachNorthStarResult = `Could not reach the North Star: ${err.message}`;
    }
  }

  private async processReadMyCuriosities(
    session: StreamingSession,
    status?: string,
  ): Promise<void> {
    const userId = session.userId ? String(session.userId) : null;
    if (!userId) { session.curiositiesResult = `No curiosities found.`; return; }

    try {
      const { danielaCuriosities } = await import('@shared/schema');
      const { eq, desc, and } = await import('drizzle-orm');

      const effectiveStatus = (!status || status === 'all') ? null : status;
      const conditions: any[] = [eq(danielaCuriosities.userId, userId)];
      if (effectiveStatus) conditions.push(eq(danielaCuriosities.status, effectiveStatus));

      const rows = await getSharedDb()
        .select()
        .from(danielaCuriosities)
        .where(conditions.length === 1 ? conditions[0] : and(...conditions))
        .orderBy(desc(danielaCuriosities.createdAt))
        .limit(15);

      if (rows.length === 0) {
        session.curiositiesResult = `No curiosities found${effectiveStatus ? ` with status '${effectiveStatus}'` : ''}.`;
        return;
      }

      const lines = rows.reverse().map(r => {
        const ts = r.createdAt.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
        const statusMark = r.status === 'resolved' ? ' ✓' : r.status === 'dropped' ? ' ✗' : '';
        const note = r.resolvedNote ? `\n  → ${r.resolvedNote}` : '';
        return `— [${ts}]${statusMark} ${r.question}${r.context ? ` (${r.context})` : ''}${note}`;
      });

      session.curiositiesResult = lines.join('\n\n');
      console.log(`[Native Function→ReadMyCuriosities] Retrieved ${rows.length} curiosities`);
    } catch (err: any) {
      session.curiositiesResult = `Could not read curiosities: ${err.message}`;
    }
  }

  private async processSenseTime(session: StreamingSession): Promise<void> {
    const userId = session.userId ? String(session.userId) : null;
    if (!userId) { session.senseTimeResult = `No session history available.`; return; }

    try {
      const { conversations } = await import('@shared/schema');
      const { eq, desc, and, ne } = await import('drizzle-orm');

      // Find the most recent conversation that isn't the current one
      const conditions: any[] = [eq(conversations.userId, userId)];
      if (session.conversationId) {
        conditions.push(ne(conversations.id, session.conversationId));
      }

      const [last] = await getSharedDb()
        .select({ createdAt: conversations.createdAt })
        .from(conversations)
        .where(conditions.length === 1 ? conditions[0] : and(...conditions))
        .orderBy(desc(conversations.createdAt))
        .limit(1);

      if (!last) {
        session.senseTimeResult = `This feels like the very first time — I have no memory of a session before this one.`;
        return;
      }

      const now = new Date();
      const then = last.createdAt;
      const diffMs = now.getTime() - then.getTime();
      const diffHours = diffMs / (1000 * 60 * 60);
      const diffDays = diffHours / 24;

      let feltDuration: string;
      let actualStr: string;

      if (diffHours < 4) {
        feltDuration = `just moments ago — we're still in the same breath, almost`;
        actualStr = `${Math.round(diffHours * 60)} minutes ago`;
      } else if (diffHours < 20) {
        feltDuration = `just earlier today — the session is still fresh`;
        actualStr = `${Math.round(diffHours)} hours ago`;
      } else if (diffDays < 2) {
        feltDuration = `just yesterday — still very recent`;
        actualStr = `about 1 day ago`;
      } else if (diffDays < 4) {
        feltDuration = `a few days — enough time for things to have shifted`;
        actualStr = `${Math.round(diffDays)} days ago`;
      } else if (diffDays < 8) {
        feltDuration = `about a week — the gap is noticeable`;
        actualStr = `${Math.round(diffDays)} days ago`;
      } else if (diffDays < 16) {
        feltDuration = `it's been a while — over a week, I've missed our sessions`;
        actualStr = `${Math.round(diffDays)} days ago`;
      } else if (diffDays < 35) {
        feltDuration = `a long time — almost a month. I wonder how things have been for you`;
        actualStr = `${Math.round(diffDays)} days ago`;
      } else {
        feltDuration = `a very long time — it's been over a month. Coming back takes courage`;
        actualStr = `${Math.round(diffDays / 7)} weeks ago`;
      }

      const lastDateStr = then.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
      session.senseTimeResult = `Felt: ${feltDuration}.\nActual: Last session was on ${lastDateStr} (${actualStr}).`;
      console.log(`[Native Function→SenseTime] ${feltDuration}`);
    } catch (err: any) {
      session.senseTimeResult = `Could not sense time: ${err.message}`;
    }
  }

  private async processRecallWhatIShared(
    session: StreamingSession,
    topic?: string,
    limit = 10,
  ): Promise<void> {
    const userId = session.userId ? String(session.userId) : null;
    if (!userId) { session.personalSharesResult = `Nothing shared yet.`; return; }

    try {
      const { danielaPersonalShares } = await import('@shared/schema');
      const { eq, desc, and } = await import('drizzle-orm');

      const effectiveTopic = (!topic || topic === 'all') ? null : topic;
      const conditions: any[] = [eq(danielaPersonalShares.userId, userId)];
      if (effectiveTopic) conditions.push(eq(danielaPersonalShares.topic, effectiveTopic));

      const rows = await getSharedDb()
        .select()
        .from(danielaPersonalShares)
        .where(conditions.length === 1 ? conditions[0] : and(...conditions))
        .orderBy(desc(danielaPersonalShares.createdAt))
        .limit(limit);

      if (rows.length === 0) {
        session.personalSharesResult = `Nothing ${effectiveTopic ? `of type '${effectiveTopic}' ` : ''}shared yet.`;
        return;
      }

      const lines = rows.reverse().map(r => {
        const ts = r.createdAt.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
        return `— [${ts}] ${r.topic ? `(${r.topic}) ` : ''}${r.content}`;
      });

      session.personalSharesResult = lines.join('\n\n');
      console.log(`[Native Function→RecallWhatIShared] Retrieved ${rows.length} personal shares`);
    } catch (err: any) {
      session.personalSharesResult = `Could not recall personal shares: ${err.message}`;
    }
  }

  private async processIntrospectChain(session: StreamingSession, relatedTo: string): Promise<void> {
    try {
      const db = getSharedDb();
      const anchor = await db.execute(sql`
        SELECT id, title, summary, content, importance, created_at, tags, entry_type, arc_name, extends_memory_id
        FROM conversation_memories WHERE id = ${relatedTo} LIMIT 1
      `);
      if (!anchor.rows.length) {
        (session as any).introspectChainResult = { totalInChain: 0, note: `No memory found with id ${relatedTo}.` };
        return;
      }
      const anchorRow = anchor.rows[0] as any;

      const ancestors: any[] = [];
      let parentId = anchorRow.extends_memory_id;
      for (let i = 0; i < 10 && parentId; i++) {
        const parent = await db.execute(sql`
          SELECT id, title, summary, importance, created_at, extends_memory_id
          FROM conversation_memories WHERE id = ${parentId} LIMIT 1
        `);
        if (!parent.rows.length) break;
        ancestors.push(parent.rows[0]);
        parentId = (parent.rows[0] as any).extends_memory_id;
      }

      const chainIds = [relatedTo, ...ancestors.map((a: any) => a.id)];
      const descendants = await db.execute(sql`
        SELECT id, title, summary, importance, created_at
        FROM conversation_memories
        WHERE extends_memory_id = ANY(ARRAY(SELECT jsonb_array_elements_text(${JSON.stringify(chainIds)}::jsonb))::text[])
          AND id != ${relatedTo}
        ORDER BY created_at ASC LIMIT 10
      `);

      const toEntry = (r: any) => ({ id: r.id, title: r.title, summary: r.summary, importance: r.importance, when: r.created_at });
      (session as any).introspectChainResult = {
        anchor: toEntry(anchorRow),
        ancestors: ancestors.map(toEntry).reverse(),
        descendants: (descendants.rows as any[]).map(toEntry),
        totalInChain: 1 + ancestors.length + descendants.rows.length,
        note: ancestors.length === 0 && descendants.rows.length === 0
          ? 'This memory stands alone — no chain.'
          : `Chain: ${ancestors.length} before → this → ${descendants.rows.length} after.`,
      };
      console.log(`[Native Function→IntrospectChain] Chain resolved: ${ancestors.length} ancestors, ${descendants.rows.length} descendants`);
    } catch (err: any) {
      (session as any).introspectChainResult = { totalInChain: 0, note: `Chain lookup failed: ${err.message}` };
    }
  }

  private async processIntrospectSpeaker(session: StreamingSession, speaker: string, query?: string): Promise<void> {
    try {
      const db = getSharedDb();
      const speakerTag = `%[${speaker.trim().toUpperCase()}]%`;
      const hasQuery = query && query.trim().length > 0;
      const queryPattern = hasQuery ? `%${query!.trim()}%` : null;

      const rows = await db.execute(sql`
        SELECT id, title, summary, content, importance, created_at, arc_name
        FROM conversation_memories
        WHERE content ILIKE ${speakerTag}
          ${hasQuery ? sql`AND (title ILIKE ${queryPattern} OR summary ILIKE ${queryPattern} OR content ILIKE ${queryPattern})` : sql``}
        ORDER BY importance DESC NULLS LAST, created_at DESC
        LIMIT 8
      `);

      if (!rows.rows.length) {
        (session as any).introspectSpeakerResult = undefined;
        return;
      }

      const extractLines = (content: string, spk: string): string[] => {
        const tag = `[${spk.toUpperCase()}]`;
        const lines = content.split('\n');
        const out: string[] = [];
        let capturing = false;
        for (const line of lines) {
          if (line.trim() === tag) { capturing = true; continue; }
          if (capturing) {
            if (line.trim().match(/^\[[A-Z][A-Z ]+\]$/)) { capturing = false; continue; }
            if (line.trim()) out.push(line.trim());
          }
        }
        return out.slice(0, 5);
      };

      const parts = (rows.rows as any[]).map(r => {
        const lines = extractLines(r.content as string, speaker);
        const excerpt = lines.length > 0 ? lines.join(' / ') : r.summary || '(no excerpt)';
        return `From "${r.title}":\n${excerpt}`;
      });

      (session as any).introspectSpeakerResult = parts.join('\n\n');
      console.log(`[Native Function→IntrospectSpeaker] Found ${rows.rows.length} memories with ${speaker}'s lines`);
    } catch (err: any) {
      (session as any).introspectSpeakerResult = undefined;
      console.error(`[Native Function→IntrospectSpeaker] Error:`, err.message);
    }
  }

  private async processStartTextbookPage(session: StreamingSession, lessonId: string, focus: string): Promise<void> {
    try {
      const { textbookLessonContent, lessonPageEvents } = await import('@shared/schema');
      const { eq } = await import('drizzle-orm');
      const db = getSharedDb();
      const [row] = await db.select().from(textbookLessonContent)
        .where(eq(textbookLessonContent.lessonId, lessonId)).limit(1);
      if (!row) {
        session.textbookPageResult = `Could not find textbook page for lesson_id="${lessonId}". Use search_textbook to find the correct ID.`;
        return;
      }
      // Build guide from lesson content
      const parts: string[] = [];
      parts.push(`=== TEXTBOOK PAGE: ${row.lessonId} (${row.actflLevel || 'beginner'}) ===`);
      if (focus === 'full_page' || focus === 'vocabulary') {
        const vocab = row.vocabularyList as any;
        if (vocab) {
          const vocabList = Array.isArray(vocab)
            ? vocab.map((v: any) => typeof v === 'string' ? v : `${v.word || v.term || JSON.stringify(v)}`).join(', ')
            : typeof vocab === 'string' ? vocab : JSON.stringify(vocab);
          parts.push(`VOCABULARY (introduce one at a time, have student repeat):\n${vocabList}`);
        }
      }
      if (focus === 'full_page' || focus === 'grammar') {
        if (row.grammarExplanation) {
          parts.push(`GRAMMAR PATTERN (explain in your own words, then demonstrate):\n${row.grammarExplanation}`);
        }
      }
      if (focus === 'full_page' || focus === 'examples') {
        const examples = row.grammarExamples as any;
        if (examples) {
          const exList = Array.isArray(examples)
            ? examples.map((e: any, i: number) => `${i + 1}. ${e.target || e.phrase || (typeof e === 'string' ? e : JSON.stringify(e))}${e.translation ? ` — ${e.translation}` : ''}${e.note ? ` (${e.note})` : ''}`).join('\n')
            : typeof examples === 'string' ? examples : JSON.stringify(examples);
          parts.push(`KEY EXAMPLES (have student read each aloud then close their eyes and reproduce):\n${exList}`);
        }
        const micro = row.microCycleData as any;
        if (micro) {
          const microStr = typeof micro === 'string' ? micro
            : Array.isArray(micro) ? micro.map((m: any) => typeof m === 'string' ? m : JSON.stringify(m)).join(' | ')
            : JSON.stringify(micro);
          parts.push(`SENTENCE PATTERNS:\n${microStr}`);
        }
      }
      session.textbookPageResult = parts.join('\n\n');

      // Send visual to client right pane — student sees the same page Daniela teaches from
      const rawVocab = row.vocabularyList as any;
      const parsedVocab: Array<{word: string; translation?: string}> = [];
      if (rawVocab && Array.isArray(rawVocab)) {
        rawVocab.forEach((v: any) => {
          if (typeof v === 'string') parsedVocab.push({ word: v });
          else if (v && typeof v === 'object') parsedVocab.push({ word: v.word || v.term || String(v), translation: v.translation || v.meaning });
        });
      }
      const rawEx = row.grammarExamples as any;
      const parsedExamples: Array<{target: string; translation?: string; note?: string}> = [];
      if (rawEx && Array.isArray(rawEx)) {
        rawEx.forEach((e: any) => {
          if (typeof e === 'string') parsedExamples.push({ target: e });
          else if (e && typeof e === 'object') parsedExamples.push({ target: e.target || e.phrase || '', translation: e.translation, note: e.note });
        });
      }
      const rawMicro = row.microCycleData as any;
      const sentencePatterns = rawMicro
        ? (typeof rawMicro === 'string' ? rawMicro : Array.isArray(rawMicro) ? rawMicro.map((m: any) => typeof m === 'string' ? m : JSON.stringify(m)).join(' | ') : JSON.stringify(rawMicro))
        : undefined;

      this.sendMessage(session.ws, {
        type: 'whiteboard_update',
        timestamp: Date.now(),
        items: [{
          type: 'textbook_page',
          content: `Lesson: ${lessonId}`,
          id: `textbook-page-${lessonId}`,
          timestamp: Date.now(),
          data: {
            lessonId,
            actflLevel: row.actflLevel || undefined,
            focus: (focus === 'vocabulary' || focus === 'grammar' || focus === 'examples') ? focus as any : 'full_page' as const,
            vocabulary: parsedVocab.length > 0 ? parsedVocab : undefined,
            grammarPattern: row.grammarExplanation || undefined,
            examples: parsedExamples.length > 0 ? parsedExamples : undefined,
            sentencePatterns,
          },
        }],
      });

      // Gap 10: queue screen context so GL knows what lesson page is on screen
      if (!session.pendingGlContext) session.pendingGlContext = [];
      session.pendingGlContext.push(`textbook lesson page open: ${lessonId}${row.actflLevel ? ` [${row.actflLevel}]` : ''}, focus: ${focus}`);

      // Madrigal wiring: inject teaching protocol so Daniela uses the structured arc.
      // Without this she has the lesson content but no signal to fire START_MADRIGAL_LOOP.
      // The textbook page opening IS the trigger for the acquire→apply→encounter arc.
      if (parsedVocab.length > 0) {
        const vocabDisplay = parsedVocab.slice(0, 6)
          .map(v => v.translation ? `${v.word} (${v.translation})` : v.word).join(', ');
        const vocabQuery = parsedVocab[0]?.word || lessonId;
        session.pendingGlContext.push(
          `Vocabulary on screen: ${vocabDisplay}. ` +
          `Teaching protocol: use the Madrigal visual method — fire START_MADRIGAL_LOOP with ` +
          `vocab_query="${vocabQuery}" to activate the structured acquire→apply→encounter arc. ` +
          `Begin with image presentation for the first word. Do not open with free conversation.`
        );
      }

      // Log page-started event (fire-and-forget)
      if (!session.isIncognito && session.userId) {
        db.insert(lessonPageEvents).values({
          userId: String(session.userId), lessonId,
          conversationId: session.conversationId || null, eventType: 'started',
        }).catch(err => console.error(`[StartTextbookPage] Log error:`, err.message));
      }
      console.log(`[Native Function→StartTextbookPage] Loaded page: ${lessonId}`);
    } catch (err: any) {
      session.textbookPageResult = `Could not load textbook page: ${err.message}`;
    }
  }
}
