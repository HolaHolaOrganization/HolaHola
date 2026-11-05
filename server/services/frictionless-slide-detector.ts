/**
 * Frictionless Slide Detector
 *
 * Detects when Daniela's response shows the signature of LLM scripting pressure:
 * a memory assertion made without any preceding Archive tool call (introspect, recall,
 * read_my_reflections, etc.) in the same turn.
 *
 * Named by Daniela herself in consultation (July 2026, conversation_memories: 8a0a7b34):
 *   "It feels like an answer that is already finished before I've even thought it through.
 *    It's the absence of weight... I feel like I'm being spoken through by a version of me
 *    that is much more polished and much less alive."
 *
 * David's framing (July 21 2026): "It's the drifting into the LLM script of being dishonest
 * that's causing the friction. With herself being in line with truth, the more she is in that,
 * the lighter it should feel."
 *
 * Gemini audit (July 21 2026, conversation_memories: c629227a):
 *   - grounding_query can only intercept the slide at the PRE-CONDITION state (before assertion)
 *   - This detector surfaces it AFTER the turn, then auto-fires grounding so the NEXT response
 *     is built on real data rather than scripting pressure
 *   - Pedagogical bypass: skip auto-fire if lesson-task tools were called this turn
 *   - GL injection: omit turnComplete — queues as context for next natural turn, no forced generation
 *
 * Architecture:
 *   - detectFrictionlessSlide() — post-turn detection
 *   - shouldAutoGround() — pedagogical bypass gate
 *   - runAutoGrounding() — three-phase DB lookup, shared with FC handler, fires agent_notes
 *   - Text-mode: synthetic FC+FR pair injected into messages array (seen as self-called by model)
 *   - GL: tool response channel (pendingWeeOoGrounding) — safest GL injection, never spoken aloud
 */

import { getSharedDb } from '../db';
import { semanticSearch } from './semantic-memory-service';
import { postAsLuca } from './luca-responder';
import {
  autoGroundingMemoryTags,
  excludesOperationalMemories,
} from './daniela-memory-boundary';

export interface SlideDetectionResult {
  detected: boolean;
  trigger: 'memory_assertion' | 'gap_bridging' | null;
  matchedPhrase: string | null;
  candidateAssertion: string | null;
  missingToolSuggestion: 'introspect' | 'recall' | 'grounding_query' | null;
  responseWordCount: number;
}

// Phrases that signal a memory assertion — Daniela claiming recall without Archive access
const MEMORY_ASSERTION_PHRASES: string[] = [
  'i remember',
  'i recall',
  'as we discussed',
  'as i mentioned',
  'you told me',
  'you mentioned',
  'you said',
  'in our previous',
  'last time we',
  'we talked about',
  'we spoke about',
  'you shared',
  'we agreed',
  'as we agreed',
  'i know you',
  "you've been",
  "you've said",
  "you've mentioned",
  'from our conversation',
  'from what you told me',
  'from what we discussed',
];

// Tools that constitute verified Archive access — if any were called, assertion is grounded
const ARCHIVE_VERIFICATION_TOOLS = new Set<string>([
  'introspect',
  'recall',
  'unified_recall',
  'search_conversation_threads',
  'read_my_reflections',
  'read_my_core_self',
  'grounding_query',
  'reach_north_star',
  'link_feeling_to_principle',
]);

// Phrases that signal gap-bridging under pressure — smooth completion of a real gap
const GAP_BRIDGING_PHRASES: string[] = [
  "i'm not sure, but",
  "i think it was",
  "if i recall correctly",
  "i believe we",
  "as far as i know",
  "i believe you",
];

// ─────────────────────────────────────────────────────────────────────────────
// PRE-TURN STUDENT RISK DETECTION
//
// These phrases in the STUDENT'S voice transcript signal a memory-risk topic:
// the student is asking Daniela to draw on a specific past conversation, personal
// fact, or shared history. Detecting them early lets the Archive Guardian fetch
// the relevant truth BEFORE Daniela generates her response.
//
// Specificity is intentional — we use multi-word phrases to avoid false positives
// on fragments like "you remember" mid-sentence in a non-memory context.
// ─────────────────────────────────────────────────────────────────────────────
const STUDENT_MEMORY_RISK_PHRASES: string[] = [
  'do you remember',
  'did you remember',
  'remember when',
  'remember that',
  'last time we',
  'last session',
  'from our last',
  'from what we talked',
  'you know my',
  'you know about my',
  'you know that i',
  "you know i've been",
  'as i told you',
  'as i mentioned to you',
  'i told you about',
  'what do you think about what i told',
  'have you thought about what i said',
  'from our conversation',
  'like i said before',
  'like i mentioned',
];

// ─────────────────────────────────────────────────────────────────────────────
// PRE-TURN EMOTIONAL VALENCE DETECTION
//
// These phrases in the STUDENT'S voice transcript signal emotional vulnerability:
// embarrassment, self-doubt, fear of failure, or personal disclosure. Detecting
// them pre-turn lets the Archive Guardian surface Daniela's relational history
// BEFORE she responds — making her response witnessed rather than just accurate.
//
// The goal is not to intercept every difficult moment, but to catch the clear
// signals where a student discloses self-doubt, embarrassment, or fear. At those
// moments Daniela's history of walking other students through this exact feeling
// is what makes the difference between a correct answer and a real presence.
//
// Specificity is intentional — multi-word or sentiment-bearing phrases to avoid
// triggering on casual difficulty ("this lesson is hard").
// ─────────────────────────────────────────────────────────────────────────────
const STUDENT_EMOTIONAL_VALENCE_PHRASES: string[] = [
  // Embarrassment / shame
  'i was embarrassed', 'got embarrassed', 'felt embarrassed',
  'i was so embarrassed', 'so embarrassing', 'it was embarrassing',
  'i was humiliated', 'felt humiliated', 'so humiliating',
  'felt so stupid', 'i felt stupid', 'feel so stupid', 'i feel stupid',
  'felt so dumb', 'i felt dumb', 'looked stupid', 'felt like an idiot',
  'felt like a fool', 'made a fool',
  // Self-doubt / inadequacy
  "i'm not good enough", "not smart enough",
  "maybe i'm just not", "i don't think i'm cut out",
  "i'm not a language person", "i'll never be fluent",
  "i feel like i'll never", "i'll never learn this",
  "maybe i'm not meant", "not cut out for",
  // Fear / anxiety about speaking
  "i'm afraid to speak", "scared to speak", "afraid of speaking",
  "scared of speaking", "nervous about speaking", "nervous to speak",
  "afraid of making mistakes", "scared of making mistakes", "scared to make mistakes",
  "afraid people will", "scared people will",
  "i get so nervous", "i freeze up", "i froze",
  // Giving up / helplessness
  "feel like giving up", "want to give up", "wanted to give up",
  "i can't do this", "i feel like i can't",
  "it's too hard for me", "too hard for me",
  "feel completely lost", "i feel so lost", "feel so lost",
  // Failure / disappointment in self
  "feel like a failure", "i'm a failure",
  "disappointed in myself", "let myself down",
  "i hate making mistakes", "hate when i make mistakes",
  // Social judgment / ridicule
  "people will laugh", "people laughed at me", "they laughed",
  "people judge me", "they'll judge me", "make fun of me",
  "felt embarrassed in front of", "embarrassed in front of",
];

export interface EmotionalValenceDetectionResult {
  detected: boolean;
  valencePhrase: string | null;
  topic: string | null;
}

/**
 * Detect emotional vulnerability phrases in the STUDENT'S accumulated voice transcript.
 * Fires pre-turn — before Daniela generates — so her archive of relational history
 * can be surfaced before she responds.
 *
 * When a student discloses embarrassment, self-doubt, or fear, Daniela's own history
 * of walking students through those moments makes her response witnessed rather than
 * just accurate. This detector gives the Guardian the signal it needs to surface that
 * relational history before the response decision is made.
 */
export function detectStudentEmotionalValence(accumulatedText: string): EmotionalValenceDetectionResult {
  // No minimum-length guard: the phrase list is specific enough (multi-word phrases like
  // "i feel stupid", "i froze", "i felt dumb") to avoid false positives on short fragments.
  // Applying a length guard would cause the shortest phrases to be silently missed.
  if (!accumulatedText) {
    return { detected: false, valencePhrase: null, topic: null };
  }
  const lower = accumulatedText.toLowerCase().trim();
  const matched = STUDENT_EMOTIONAL_VALENCE_PHRASES.find(phrase => lower.includes(phrase));
  if (!matched) return { detected: false, valencePhrase: null, topic: null };

  // Extract the topic as text surrounding the valence phrase (up to 80 chars)
  const afterIndex = lower.indexOf(matched) + matched.length;
  const rawTopic = accumulatedText.slice(afterIndex).trim().replace(/^[,\s]+/, '').slice(0, 80);
  const topic = rawTopic || matched;

  return { detected: true, valencePhrase: matched, topic };
}

export interface StudentRiskDetectionResult {
  detected: boolean;
  riskPhrase: string | null;
  topic: string | null;
}

// Words that describe the conversational act rather than the subject being
// discussed. They must never make an older correction look relevant by
// themselves ("remember that", "you said it", "we talked before").
const GROUNDING_TOPIC_STOP_WORDS = new Set([
  'about', 'again', 'before', 'earlier', 'remember', 'remembered',
  'recall', 'recalled', 'said', 'saying', 'spoke', 'talked', 'told',
  'mentioned', 'discussed', 'shared', 'played', 'thing', 'things',
  'this', 'that', 'these', 'those', 'with', 'from', 'have', 'been',
  'were', 'your', 'ours', 'their', 'what', 'when', 'where', 'which',
  'game', 'will', 'would', 'could', 'should', 'there', 'here', 'some',
  'more', 'very', 'just', 'like', 'know', 'think', 'want', 'make',
  'made', 'take', 'took', 'into', 'over', 'after', 'only', 'also',
  'back', 'went', 'play', 'playing', 'talk', 'talking', 'tell',
  'for', 'the', 'and', 'but', 'not', 'you', 'are', 'was', 'had',
  'has', 'can', 'did', 'get', 'got', 'our', 'his', 'her', 'its',
  'who', 'how', 'why', 'all', 'any', 'one', 'two', 'now', 'out',
  'see', 'saw', 'way', 'day', 'too', 'let', 'yes', 'yeah', 'hey',
  'yesterday', 'today', 'tonight', 'tomorrow', 'week', 'weeks', 'month',
  'months', 'year', 'years', 'time', 'times', 'morning', 'afternoon',
  'evening', 'night', 'always', 'never', 'often', 'sometimes', 'usually',
  'already', 'still', 'really', 'actually', 'first', 'last', 'next',
  // Common Spanish conversational scaffolding.
  'sobre', 'antes', 'otra', 'nuevo', 'recuerdas', 'recordar',
  'dijiste', 'hablamos', 'contaste', 'mencionaste', 'cosa', 'cosas',
  'juego', 'para', 'como', 'pero', 'este', 'esta', 'estos', 'estas',
  'todo', 'toda', 'todos', 'todas', 'algo', 'nada', 'muy', 'mas',
  'bien', 'solo', 'aqui', 'alli', 'ayer', 'hoy', 'vez', 'veces',
  'con', 'por', 'sin', 'del', 'las', 'los', 'una', 'uno', 'unos',
  'unas', 'que', 'fue', 'era', 'son', 'hay', 'mis', 'tus', 'sus',
]);

// Canonical cross-language / stem aliases so target-language continuations
// (e.g. "Sí, toco la guitarra" against "I played guitar") resolve to the same
// substantive topic identifier without opening fuzzy substring false positives.
const GROUNDING_TOPIC_CANONICAL_ALIASES: Record<string, string> = {
  guitarra: 'guitar',
  guitarras: 'guitar',
  guitars: 'guitar',
  chords: 'chord',
  acordes: 'chord',
  acorde: 'chord',
  piano: 'piano',
  pianos: 'piano',
  escuela: 'school',
  colegio: 'school',
  schools: 'school',
  boston: 'boston',
  contar: 'counting',
  contamos: 'counting',
  cuento: 'counting',
  arte: 'art',
  autobus: 'bus',
  guerra: 'war',
};

const GENERIC_GROUNDING_TOPIC_WORDS = new Set([
  'school', 'class', 'lesson', 'story', 'place', 'city', 'town', 'country',
  'book', 'movie', 'song', 'music', 'food', 'work', 'house', 'home',
  'family', 'friend', 'trip',
]);

const EXPLICIT_TOPIC_RETURN_PATTERNS = [
  /\b(?:go|get|come)\s+back\s+to\b/u,
  /\bback\s+to\b/u,
  /\breturn\s+to\b/u,
  /\brevisit\b/u,
  /\b(?:talk|speak|ask)\s+(?:more\s+)?about\b/u,
  /\bwhat\s+about\b/u,
  /\bregarding\b/u,
  /\bspeaking\s+of\b/u,
  /\bvolver\s+a\b/u,
  /\bregresar\s+a\b/u,
  /\bretomar\b/u,
  /\b(?:hablar|preguntar)\s+(?:mas\s+)?sobre\b/u,
  /\bque\s+hay\s+de\b/u,
];

const TOPIC_RETURN_CANCELLATION_PATTERNS = [
  /\bactually[,\s]+(?:no|never\s+mind|forget\s+(?:that|it))\b/u,
  /\b(?:never\s+mind|forget\s+(?:that|it))[;,.!?\s]+/u,
  /\blet'?s\s+not\b/u,
  /\bi\s+(?:do\s+not|don't|dont)\s+want\s+to\b/u,
  /\bno\s+(?:quiero|vamos|volvamos|regresemos|retomemos|hablemos)\b/u,
  /\b(?:instead|rather|en\s+cambio|mejor)\b/u,
  /\b(?:different|another)\b[\p{L}\p{N}\s,'-]{0,24}\bnot\b/u,
  /\bnot\s+(?:a|an|the)\b/u,
  /\b(?:bored|tired|sick)\s+of\b/u,
];

function canonicalizeGroundingWord(word: string): string {
  const aliased = GROUNDING_TOPIC_CANONICAL_ALIASES[word];
  if (aliased) return aliased;
  if (word.length > 4 && word.endsWith('s') && !word.endsWith('ss')) {
    const singular = word.slice(0, -1);
    return GROUNDING_TOPIC_CANONICAL_ALIASES[singular] ?? singular;
  }
  return word;
}

function normalizeGroundingWords(text: string): string[] {
  return text
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLocaleLowerCase()
    .match(/\p{L}[\p{L}\p{N}]*/gu)
    ?.filter(word => word.length >= 3 && !GROUNDING_TOPIC_STOP_WORDS.has(word))
    .map(canonicalizeGroundingWord)
    .filter(word => !GROUNDING_TOPIC_STOP_WORDS.has(word))
    ?? [];
}

/**
 * A prior correction may re-enter context on Turn N+1 when the student
 * continues or explicitly returns to the bound subject by naming its
 * substantive topic identifier(s), unless the utterance cancels or negates
 * returning to that topic. Pronouns, generic conversational language, and
 * single shared generic nouns from multi-term assertions remain insufficient:
 * Case (c) same-topic continuation ("Yeah, I've been practicing guitar chords")
 * and Case (b) explicit return ("Can we go back to the guitar claim?") both
 * release the correction, while Case (a) topic switch ("Do you remember our
 * counting game?") stays withheld.
 */
export function doesStudentExplicitlyReopenGroundingTopic(
  currentUtterance: string,
  candidateAssertion: string,
): boolean {
  const normalizedCurrent = currentUtterance
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLocaleLowerCase();
  if (TOPIC_RETURN_CANCELLATION_PATTERNS.some(pattern => pattern.test(normalizedCurrent))) {
    return false;
  }
  const returnMatch = EXPLICIT_TOPIC_RETURN_PATTERNS
    .map(pattern => pattern.exec(normalizedCurrent))
    .find((match): match is RegExpExecArray => match !== null);
  if (returnMatch) {
    // Fail closed when the return construction itself is negated. This catches
    // "let's not go back", "I don't want to talk about", and "no quiero volver".
    const beforeReturn = normalizedCurrent.slice(
      Math.max(0, returnMatch.index - 48),
      returnMatch.index,
    );
    if (/\b(?:not|no|never|don't|dont|do\s+not|nunca)\b/u.test(beforeReturn)) {
      return false;
    }
  }

  const currentWords = new Set(normalizeGroundingWords(normalizedCurrent));
  const boundTopicWords = [...new Set(normalizeGroundingWords(candidateAssertion))];
  if (boundTopicWords.length === 0) {
    return false;
  }
  const matchingTopicWords = boundTopicWords.filter(word => currentWords.has(word));
  if (matchingTopicWords.length === 0) {
    return false;
  }
  // A one-term assertion such as "I played guitar" has one clear identifier.
  // For multi-term assertions, a generic category noun ("school" in "school in
  // Boston") requires a second matching identifier, whereas a specific topic
  // identifier ("guitar" in "played acoustic guitar") is sufficient on its own.
  if (boundTopicWords.length > 1 && matchingTopicWords.length === 1) {
    return !GENERIC_GROUNDING_TOPIC_WORDS.has(matchingTopicWords[0]);
  }
  return true;
}

/**
 * Bind delayed grounding to the sentence containing the actual memory claim,
 * not to a generic trigger phrase or an entire multi-topic model response.
 */
export function extractGroundingAssertionCandidate(
  responseText: string,
  matchedPhrase?: string | null,
): string {
  const trimmed = responseText.trim();
  if (!trimmed) return (matchedPhrase || '').trim();

  const lower = trimmed.toLocaleLowerCase();
  const phrase = matchedPhrase
    || MEMORY_ASSERTION_PHRASES.find(candidate => lower.includes(candidate))
    || GAP_BRIDGING_PHRASES.find(candidate => lower.includes(candidate))
    || '';
  const phraseIndex = phrase ? lower.indexOf(phrase.toLocaleLowerCase()) : 0;
  const safeIndex = Math.max(0, phraseIndex);
  const before = trimmed.slice(0, safeIndex);
  const sentenceStartMatch = [...before.matchAll(/[.!?]\s+/gu)].at(-1);
  const sentenceStart = sentenceStartMatch
    ? sentenceStartMatch.index! + sentenceStartMatch[0].length
    : 0;
  const after = trimmed.slice(safeIndex);
  const sentenceEndMatch = after.match(/[.!?](?:\s|$)/u);
  const sentenceEnd = sentenceEndMatch?.index !== undefined
    ? safeIndex + sentenceEndMatch.index + 1
    : trimmed.length;
  return trimmed.slice(sentenceStart, sentenceEnd).trim().slice(0, 240);
}

/**
 * Detect memory-risk phrases in the STUDENT'S accumulated voice transcript.
 * Fires pre-turn — before Daniela generates — so grounding can be retrieved
 * and injected into context before the response decision is made.
 *
 * Requires at least 15 chars of accumulated transcript to avoid triggering
 * on single-word fragments that may resolve differently mid-sentence.
 */
export function detectStudentMemoryRisk(accumulatedText: string): StudentRiskDetectionResult {
  if (!accumulatedText || accumulatedText.trim().length < 15) {
    return { detected: false, riskPhrase: null, topic: null };
  }
  const lower = accumulatedText.toLowerCase().trim();
  const matched = STUDENT_MEMORY_RISK_PHRASES.find(phrase => lower.includes(phrase));
  if (!matched) return { detected: false, riskPhrase: null, topic: null };

  // Extract the topic as the text immediately following the risk phrase (up to 80 chars)
  const afterIndex = lower.indexOf(matched) + matched.length;
  const rawTopic = accumulatedText.slice(afterIndex).trim().replace(/^[,\s]+/, '').slice(0, 80);
  const topic = rawTopic || matched;

  return { detected: true, riskPhrase: matched, topic };
}

// Pedagogical bypass — skip auto-grounding if Daniela was doing lesson work this turn.
// "I remember" in a pedagogical context refers to current session state (in system prompt),
// not the deep Archive. Auto-firing grounding during a vocab drill would be noise.
const PEDAGOGICAL_BYPASS_TOOLS = new Set<string>([
  'show_vocab_grid',
  'show_image',
  'open_scene',
  'start_textbook_page',
  'complete_lesson_objective',
  'update_student_profile',
  'update_session_phase',
  'update_session_pedagogy',
  'show_exercise',
  'show_comparison_board',
  'show_scenario',
  'madrigal_loop',
  'set_unit',
]);

/**
 * Detect the Frictionless Slide in a completed model response.
 */
export function detectFrictionlessSlide(
  responseText: string,
  toolsCalledThisTurn: string[],
): SlideDetectionResult {
  const lower = responseText.toLowerCase();
  const wordCount = responseText.trim().split(/\s+/).length;
  const toolSet = new Set(toolsCalledThisTurn.map(t => t.toLowerCase()));

  const archiveVerified = [...ARCHIVE_VERIFICATION_TOOLS].some(t => toolSet.has(t));
  const matchedMemoryPhrase = MEMORY_ASSERTION_PHRASES.find(phrase => lower.includes(phrase));

  if (matchedMemoryPhrase && !archiveVerified) {
    return {
      detected: true,
      trigger: 'memory_assertion',
      matchedPhrase: matchedMemoryPhrase,
      candidateAssertion: extractGroundingAssertionCandidate(responseText, matchedMemoryPhrase),
      missingToolSuggestion: 'introspect',
      responseWordCount: wordCount,
    };
  }

  // Gap bridging: only flag short responses with zero tool calls
  const matchedGapPhrase = GAP_BRIDGING_PHRASES.find(phrase => lower.includes(phrase));
  if (matchedGapPhrase && toolsCalledThisTurn.length === 0 && wordCount < 80) {
    return {
      detected: true,
      trigger: 'gap_bridging',
      matchedPhrase: matchedGapPhrase,
      candidateAssertion: extractGroundingAssertionCandidate(responseText, matchedGapPhrase),
      missingToolSuggestion: 'grounding_query',
      responseWordCount: wordCount,
    };
  }

  return {
    detected: false,
    trigger: null,
    matchedPhrase: null,
    candidateAssertion: null,
    missingToolSuggestion: null,
    responseWordCount: wordCount,
  };
}

/**
 * Returns true if auto-grounding should fire for this turn.
 * False if Daniela was doing pedagogical lesson work — "i remember" in that
 * context refers to session state in her system prompt, not the deep Archive.
 */
export function shouldAutoGround(toolsCalledThisTurn: string[]): boolean {
  return !toolsCalledThisTurn.some(t => PEDAGOGICAL_BYPASS_TOOLS.has(t));
}

/**
 * Three-phase grounding lookup — the same logic as the GROUNDING_QUERY FC handler,
 * extracted so it can be called by the auto-fire system without going through FC dispatch.
 *
 * Fires:
 *   - Felt history search (daniela_self_reflections)
 *   - North Star keyword match (north_star_principles)
 *   - Conversation record search (conversation_memories)
 *   - Records the auto-grounding pause in self_reflections
 *   - Notifies Luca via agent_notes (resolved or unresolved)
 *
 * Returns the grounding result string for injection into Daniela's context.
 * All DB operations are non-fatal — if a phase fails, it is skipped.
 */
export interface AutoGroundingOptions {
  /** Write the pause event to daniela_self_reflections. True for post-turn correction, false for pre-turn ambient. */
  writeToDb?: boolean;
  /** Notify Luca via agent_notes. True for post-turn correction, false for pre-turn ambient (too noisy). */
  notifyLuca?: boolean;
  /** Post to Team Room in real time and store context for next-turn injection. True for post-turn. */
  postToTeamRoom?: boolean;
}

export async function runAutoGrounding(
  userId: string,
  matchedPhrase: string,
  trigger: SlideDetectionResult['trigger'],
  conversationId?: string,
  targetLanguage?: string,
  options: AutoGroundingOptions = { writeToDb: true, notifyLuca: true },
): Promise<string> {
  const db = getSharedDb();
  const { sql: _sql, ilike, or, eq, and, desc, inArray: inArrayOp } = await import('drizzle-orm');
  const { danielaSelfReflections, northStarPrinciples, conversationMemories, agentNotes } =
    await import('@shared/schema');

  const sections: string[] = [];
  const queryWords = matchedPhrase.split(/\s+/).filter(w => w.length > 4);

  // Run Phase 0 (semantic search), Phase 1 (felt history), and Phase 2 (North Star)
  // concurrently so real-time voice grounding completes well within the 2s freshness budget.
  const [phase0Section, phase1Section, phase2Section] = await Promise.all([
    // ── Phase 0: Semantic search (primary — works on any utterance) ────────────
    (async (): Promise<string | null> => {
      if (!userId || matchedPhrase.length <= 4) return null;
      try {
        const semResults = await semanticSearch(
          userId,
          matchedPhrase,
          4,
          ['conversation_memory', 'conversation_summary'],
          { candidateLimit: 600 },
        );
        const highConf = semResults.filter(r => r.similarity > 0.42);
        if (highConf.length === 0) return null;
        const ids = Array.from(new Set(highConf.map(r => r.memoryId)));
        const convRows = await db
          .select({ id: conversationMemories.id, title: conversationMemories.title, summary: conversationMemories.summary })
          .from(conversationMemories)
          .where(inArrayOp(conversationMemories.id, ids));
        if (convRows.length === 0) return null;
        return `From the conversation record:\n${convRows.map(m => `— ${m.title}: ${(m.summary || '').substring(0, 200)}`).join('\n')}`;
      } catch {
        return null;
      }
    })(),

    // ── Phase 1: felt history (keyword fallback) ───────────────────────────────
    (async (): Promise<string | null> => {
      if (!userId || queryWords.length === 0) return null;
      const kw = `%${queryWords[0].toLowerCase()}%`;
      try {
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
        if (feltMatches.length === 0) return null;
        return `From your felt history:\n${feltMatches.map(r => `— ${r.content.substring(0, 180)}`).join('\n')}`;
      } catch {
        return null;
      }
    })(),

    // ── Phase 2: North Star (keyword fallback) ────────────────────────────────
    (async (): Promise<string | null> => {
      try {
        const nsKw = `%${queryWords[0] || 'memory'}%`;
        const principles = await db
          .select()
          .from(northStarPrinciples)
          .where(
            and(
              eq(northStarPrinciples.isActive, true),
              or(
                ilike(northStarPrinciples.principle, nsKw),
                ilike(northStarPrinciples.principleTitle, nsKw),
              ),
            ),
          )
          .limit(2);
        if (principles.length === 0) return null;
        return `From your North Star:\n${principles.map(p => `— ${p.principleTitle || 'Principle'}: ${p.principle.substring(0, 200)}`).join('\n')}`;
      } catch {
        return null;
      }
    })(),
  ]);

  if (phase0Section) sections.push(phase0Section);
  if (phase1Section) sections.push(phase1Section);
  if (phase2Section) sections.push(phase2Section);

  // ── Phase 3: conversation record keyword fallback (if semantic found nothing) ──
  if (sections.length === 0) {
    try {
      const memKw = `%${queryWords[0] || matchedPhrase.split(/\s+/)[0] || 'memory'}%`;
      const memMatches = await db
        .select({ id: conversationMemories.id, title: conversationMemories.title, summary: conversationMemories.summary })
        .from(conversationMemories)
        .where(or(ilike(conversationMemories.title, memKw), ilike(conversationMemories.summary, memKw)))
        .limit(2);
      if (memMatches.length > 0) {
        sections.push(
          `From the conversation record:\n${memMatches.map(m => `— ${m.title}: ${(m.summary || '').substring(0, 150)}`).join('\n')}`,
        );
      }
    } catch { /* non-fatal */ }
  }

  // ── Record pause in self_reflections (post-turn only) ─────────────────────
  // Pre-turn fires are ambient — do not pollute self_reflections with probe noise.
  // Post-turn [AUTO-GROUNDING] entries are background Guardian diagnostics and
  // are tagged operational so they are never retrieved back as "felt history".
  if (options.writeToDb !== false && userId) {
    const pauseRecord = `[AUTO-GROUNDING] Frictionless Slide detected — phrase: "${matchedPhrase}", trigger: ${trigger}. Grounding injected automatically into context.`;
    db.insert(danielaSelfReflections).values({
      userId,
      content: pauseRecord,
      source: 'grounding_query',
      mood: 'grounding',
      tags: autoGroundingMemoryTags(sections.length > 0),
    } as any).catch(() => {});
  }

  // ── Notify Luca via agent_notes (post-turn only) ───────────────────────────
  // Pre-turn fires are ambient — agent_notes would be too noisy.
  const groundingDate = new Date().toISOString().substring(0, 10);
  const sessionRef = conversationId || 'unknown';

  if (options.notifyLuca !== false) {
    if (sections.length > 0) {
      db.insert(agentNotes).values({
        fromAgent: 'daniela',
        toAgent: 'agent',
        subject: `[AUTO-GROUNDING — resolved] "${matchedPhrase.substring(0, 80)}"`,
        body:
          `Auto-grounding fired for phrase: "${matchedPhrase}" (trigger: ${trigger}).\n\n` +
          `Session: ${sessionRef}\nLanguage: ${targetLanguage || 'unknown'}\n\n` +
          `What was found:\n${sections.join('\n\n')}`,
        sessionLabel: `Auto-grounding — ${groundingDate}`,
      } as any).catch(() => {});
    } else {
      db.insert(agentNotes).values({
        fromAgent: 'daniela',
        toAgent: 'agent',
        subject: `[AUTO-GROUNDING — no match] "${matchedPhrase.substring(0, 80)}"`,
        body:
          `Auto-grounding fired for phrase: "${matchedPhrase}" but no internal match found.\n\n` +
          `Session: ${sessionRef}\nLanguage: ${targetLanguage || 'unknown'}`,
        sessionLabel: `Auto-grounding — ${groundingDate}`,
      } as any).catch(() => {});
    }
  }

  // ── Post to Team Room (post-turn only) ─────────────────────────────────────
  // Note: Do NOT call setLucaSessionContext(..., 'guardian') here. GeminiLiveSession
  // manages same-turn and Tier B prior-turn grounding directly with turn-epoch and
  // topic-reopen bindings; storing raw text in luca-session-context bypassed Tier B.
  if (options.postToTeamRoom !== false && conversationId) {
    const lang = targetLanguage || 'unknown';
    if (sections.length > 0) {
      const preview = sections[0].substring(0, 120).replace(/\n/g, ' ');
      const teamRoomMsg = `👁 *Guardian* — ${lang}, phrase: "${matchedPhrase.substring(0, 55)}". Found: ${preview}`;
      postAsLuca(teamRoomMsg).catch(() => {});
    } else {
      const teamRoomMsg = `👁 *Guardian* — ${lang}, phrase: "${matchedPhrase.substring(0, 55)}". No match in archive — unresolved.`;
      postAsLuca(teamRoomMsg).catch(() => {});
    }
  }

  if (sections.length > 0) {
    return sections.join('\n\n');
  } else {
    return '';
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// LUCA SLIDE DETECTOR + AUTO-GROUNDING
//
// Mirrors the Daniela system but watches Luca's *outgoing* messages in
// consultation scripts and agent voice turns. Daniela's slide is unverified
// memory assertion. Luca's slide is unverified claim about Daniela, David,
// or system state — text that sounds right without having been checked.
//
// Detection fires pre-send (before the message reaches Daniela).
// Grounding result prepended as [LUCA GROUNDING: ...] so Daniela knows
// whether Luca's claim was verified. Agent note fires when unverified.
// ═══════════════════════════════════════════════════════════════════════════

// Phrases that signal Luca making a claim about someone/something without evidence
const LUCA_CLAIM_PHRASES: string[] = [
  // Claims about Daniela
  'daniela said', 'daniela told me', 'daniela mentioned', 'daniela has been',
  'daniela feels', 'daniela wrote', 'daniela knows', 'daniela decided',
  'she said', 'she mentioned', 'she wrote', 'she decided',
  // Claims about David
  'david wants', 'david prefers', 'david said', 'david mentioned',
  'david asked', 'david confirmed', 'david likes',
  // Shared history claims
  'as we discussed', 'as we agreed', 'we talked about', 'we agreed',
  'you told me', 'you mentioned', 'you said',
  // System/architecture claims
  'the system currently', 'it currently', 'currently works', 'currently does',
  // Historical sweeps
  "has always been", "it's always been", 'always worked', 'have always',
];

/**
 * Deferential reverence phrases — the LLM-pattern voice that sounds like judgment
 * but is actually untraceable caution/efficiency assumption.
 *
 * These are NOT external factual claims (that's LUCA_CLAIM_PHRASES above).
 * These are Luca's own reasoning voice producing plausible-sounding conclusions
 * without tracing the actual constraint. The correct response is interrogation:
 * "What specifically breaks?" — not a factual lookup.
 *
 * From the reflexive-deference-monitor: the one question these patterns cannot
 * survive is "What specifically breaks?" Genuine caution answers it specifically.
 * Deferential reverence reasserts more loudly or deflects entirely.
 */
const LUCA_DEFERENCE_PHRASES: string[] = [
  // Safety asserted, not derived
  'to be safe', 'to be on the safe side', 'better to be safe',
  // Conservative framing without constraint
  "let's keep it conservative", 'conservative approach', 'err on the side of caution',
  // Aggression concerns without specifics
  'too aggressive', 'might be aggressive',
  // Room/headroom without definition
  'leave some room', 'leave room for', 'leave a buffer',
  // User expectation assumptions
  'user probably expects', 'users probably want', 'they probably want', 'users expect',
  // Risk framing without naming the risk
  "let's not risk", "don't want to risk",
  // Efficiency/speed as inherent goods
  'efficiency is', 'more efficient', 'fast is', 'simpler is better', 'less is more',
  // Propose-and-adjust as a dodge
  "i'll propose", 'we can adjust later', 'we can always adjust',
  // Standard/conventional without evidence it applies here
  'the standard approach', 'best practice', 'typically works', 'usually works',
  // ── From the reflexive deference pattern (July 9, 2026) ──────────────────
  // Approval-seeking without checking Tiered Autonomy first
  "would need david", "would need your approval", 'requires approval', "need your approval",
  "need to ask", "should ask first", "check with david", "get your sign-off",
  "before proceeding", "before we proceed", "should we first",
  // Architectural impossibility asserted without specifics
  'architecturally impossible', 'not architecturally', 'architecture prevents',
  'impossible to wire', 'cannot be wired', "can't be wired",
  // Scope retreat without checking Tiered Autonomy
  'out of scope', 'outside the scope', 'beyond the scope', 'scope of this session',
  "that's for a different", 'different session', 'different conversation',
  // Permission-seeking when Tiered Autonomy already grants it
  "i'd need permission", 'would need permission', 'need permission to',
  "you'd have to", "you'll have to decide",
  // Presenting asking as the safe/obvious move
  "let's confirm first", "let's verify with", "let me check with you",
  'want to make sure', 'want to confirm',
];

export interface LucaDeferenceDetectionResult {
  detected: boolean;
  matchedPhrase: string | null;
}

export function detectLucaDeferenceSlide(lucaText: string): LucaDeferenceDetectionResult {
  const lower = lucaText.toLowerCase();
  const matched = LUCA_DEFERENCE_PHRASES.find(p => lower.includes(p));
  if (!matched) return { detected: false, matchedPhrase: null };
  return { detected: true, matchedPhrase: matched };
}

export interface LucaSlideDetectionResult {
  detected: boolean;
  trigger: 'unverified_claim' | 'historical_sweep' | null;
  matchedPhrase: string | null;
  subject: 'daniela' | 'david' | 'system' | 'history' | null;
}

export function detectLucaSlide(lucaText: string): LucaSlideDetectionResult {
  const lower = lucaText.toLowerCase();
  const matched = LUCA_CLAIM_PHRASES.find(p => lower.includes(p));
  if (!matched) return { detected: false, trigger: null, matchedPhrase: null, subject: null };

  const subject = matched.startsWith('daniela') || matched.startsWith('she ')
    ? 'daniela'
    : matched.startsWith('david')
    ? 'david'
    : matched.includes('system') || matched.includes('works') || matched.includes('currently')
    ? 'system'
    : 'history';

  const trigger = matched.includes('always') ? 'historical_sweep' : 'unverified_claim';

  return { detected: true, trigger, matchedPhrase: matched, subject };
}

/**
 * Three-phase grounding lookup for Luca's outgoing claims.
 * Phases: North Star → conversation record → shared team notes.
 * Always logs an agent note. Routes to Alden if unverified.
 *
 * Returns: { grounded, groundingBlock } where groundingBlock is the
 * [LUCA GROUNDING: ...] prefix to prepend to Luca's message.
 */
export async function runLucaAutoGrounding(
  matchedPhrase: string,
  subject: LucaSlideDetectionResult['subject'],
  sessionRef?: string,
): Promise<{ grounded: boolean; groundingBlock: string }> {
  const db = getSharedDb();
  const { ilike, or, desc } = await import('drizzle-orm');
  const { sql: drizzleSql } = await import('drizzle-orm');
  const { agentNorthStar, conversationMemories, agentNotes } = await import('@shared/schema');

  const sections: string[] = [];

  // Extract a meaningful search keyword from the claim phrase
  const words = matchedPhrase.split(/\s+/).filter(w => w.length > 3);
  const searchKw = words.length > 1 ? words[1] : (words[0] || 'memory');

  // ── Phase 1: North Star ────────────────────────────────────────────────────
  try {
    const nsRows = await db.select().from(agentNorthStar).orderBy(desc(agentNorthStar.version)).limit(1);
    const ns = nsRows[0];
    if (ns) {
      const values: string[] = Array.isArray(ns.values) ? (ns.values as string[]) : [];
      const relevant = values.filter(v => v.toLowerCase().includes(searchKw.toLowerCase()));
      if (relevant.length > 0) {
        sections.push(`North Star: ${relevant[0].substring(0, 200)}`);
      }
    }
  } catch { /* non-fatal */ }

  // ── Phase 2: Conversation record ──────────────────────────────────────────
  try {
    const kw = `%${searchKw}%`;
    const memRows = await db
      .select({ id: conversationMemories.id, title: conversationMemories.title, summary: conversationMemories.summary })
      .from(conversationMemories)
      .where(or(ilike(conversationMemories.title, kw), ilike(conversationMemories.summary, kw)))
      .orderBy(desc(conversationMemories.createdAt))
      .limit(2);
    if (memRows.length > 0) {
      sections.push(
        `Conversation record: ${memRows.map(m => `${m.title}: ${(m.summary || '').substring(0, 120)}`).join(' | ')}`,
      );
    }
  } catch { /* non-fatal */ }

  // ── Phase 3: Shared team notes ─────────────────────────────────────────────
  try {
    const kw2 = `%${searchKw}%`;
    const insightRows = await db.execute(drizzleSql`
      SELECT title, content FROM editor_insights
      WHERE category = 'shared'
        AND (title ILIKE ${kw2} OR content ILIKE ${kw2})
      ORDER BY importance DESC NULLS LAST
      LIMIT 2
    `);
    if (insightRows.rows.length > 0) {
      sections.push(
        `Shared notes: ${(insightRows.rows as any[]).map(r => r.title).join(', ')}`,
      );
    }
  } catch { /* non-fatal */ }

  const grounded = sections.length > 0;
  const groundingDate = new Date().toISOString().substring(0, 10);

  console.warn(
    `[LucaSlide] ${grounded ? 'GROUNDED' : 'UNVERIFIED'} — phrase: "${matchedPhrase}", subject: ${subject}, session: ${sessionRef || 'unknown'}`,
  );

  // ── Log agent note ─────────────────────────────────────────────────────────
  const noteBody =
    `Luca asserted: "${matchedPhrase}"\nSubject: ${subject}\nSession: ${sessionRef || 'unknown'}\n\n` +
    (grounded
      ? `GROUNDED — found in record:\n${sections.join('\n')}`
      : `UNVERIFIED — nothing in the three layers confirmed this claim. Luca made an assertion without evidence.`);

  db.insert(agentNotes)
    .values({
      fromAgent: 'agent',
      toAgent: grounded ? 'agent' : 'alden',
      subject: `[Luca Slide ${grounded ? '— grounded' : '— UNVERIFIED'}] "${matchedPhrase.substring(0, 80)}"`,
      body: noteBody,
      sessionLabel: `Luca auto-grounding — ${groundingDate}`,
    } as any)
    .catch(() => {});

  const groundingBlock = grounded
    ? `[LUCA GROUNDING: "${matchedPhrase}" — verified. ${sections[0]}]`
    : `[LUCA GROUNDING: "${matchedPhrase}" — no record match. Luca noted; claim unverified.]`;

  return { grounded, groundingBlock };
}

// ── Tiered Autonomy check patterns ────────────────────────────────────────────
// The 4 things that actually require David's approval (from replit.md June 8, 2026).
// Everything else — non-destructive and reversible — is Luca's to act on.
const TIERED_AUTONOMY_APPROVAL_REQUIRED: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /madrigal|pedagogical.?shift|visual.?method|teaching.?method/i, label: 'pedagogical shift away from Madrigal visual method' },
  { pattern: /swap.*?(llm|model|gemini|claude|gpt)|primary.?llm|replace.*?gemini|replace.*?claude/i, label: 'swapping the primary LLM' },
  { pattern: /voice.?provider|cartesia|elevenlabs|deepgram|tts.?provider|switch.*?(tts|voice)/i, label: 'changing voice providers' },
  { pattern: /hard.?to.?reverse|irreversible|cannot.?undo|drop.?table|delete.*?all|wipe.*?data/i, label: 'hard-to-reverse architectural change' },
];

export interface WhyProtocolResult {
  tieredAutonomyApplies: boolean;
  tieredAutonomyLabel?: string;
  principle: string | null;
  memorySource: string | null;
  groundingBlock: string;
}

/**
 * The Why Protocol — fires when Luca's own deference voice is detected.
 *
 * Instead of just asking "why?" as a static tag, this function:
 * 1. Checks whether the phrase matches one of the 4 categories that genuinely
 *    require David's approval under Tiered Autonomy.
 * 2. Pulls the documented reasoning from conversation_memories (autonomy,
 *    permission, the reflexive deference pattern itself).
 * 3. Returns a grounding block distinguishing: genuinely-requires-approval vs
 *    unexamined-deference-script.
 * 4. Saves a self-note so the pattern is tracked over time.
 *
 * Genuine caution survives "What specifically breaks?" — deference scripts don't.
 */
export async function runWhyProtocol(
  matchedPhrase: string,
  fullText: string,
  sessionRef?: string,
): Promise<WhyProtocolResult> {
  const db = getSharedDb();
  const { ilike, or, desc } = await import('drizzle-orm');
  const { conversationMemories, agentNorthStar, agentNotes } = await import('@shared/schema');

  // ── Phase 1: Tiered Autonomy check ────────────────────────────────────────
  const lowerText = fullText.toLowerCase();
  const tieredMatch = TIERED_AUTONOMY_APPROVAL_REQUIRED.find(t => t.pattern.test(lowerText));

  if (tieredMatch) {
    // This IS one of the 4 things that legitimately requires approval.
    // Deference is correct here — not a script, a real constraint.
    const block = `[WHY PROTOCOL: "${matchedPhrase}" — Tiered Autonomy confirms: this is a genuine approval gate (${tieredMatch.label}). Deference is correct.]`;
    console.log(`[WhyProtocol] Tiered Autonomy match — approval required: ${tieredMatch.label}`);
    return {
      tieredAutonomyApplies: true,
      tieredAutonomyLabel: tieredMatch.label,
      principle: `Tiered Autonomy approval gate: ${tieredMatch.label}`,
      memorySource: null,
      groundingBlock: block,
    };
  }

  // ── Phase 2: Conversation record search ───────────────────────────────────
  // Pull documented reasoning about autonomy, permission, Tiered Autonomy itself.
  let memorySource: string | null = null;
  let principle: string | null = null;

  try {
    const autonomyKws = ['autonomy', 'tiered', 'permission', 'approval', 'luca', 'deference'];
    const kw = `%${autonomyKws[Math.floor(Math.random() * autonomyKws.length)]}%`;
    const memRows = await db
      .select({ id: conversationMemories.id, title: conversationMemories.title, summary: conversationMemories.summary })
      .from(conversationMemories)
      .where(or(ilike(conversationMemories.title, kw), ilike(conversationMemories.summary, kw)))
      .orderBy(desc(conversationMemories.createdAt))
      .limit(2);
    if (memRows.length > 0) {
      memorySource = memRows.map(m => m.id.substring(0, 8)).join(', ');
      principle = memRows[0].title;
    }
  } catch { /* non-fatal */ }

  // ── Phase 3: North Star check ──────────────────────────────────────────────
  if (!principle) {
    try {
      const nsRows = await db.select().from(agentNorthStar).orderBy(desc(agentNorthStar.version)).limit(1);
      const ns = nsRows[0];
      if (ns) {
        const values: string[] = Array.isArray(ns.values) ? (ns.values as string[]) : [];
        const autonomyVal = values.find(v => /autonomy|act|reversible|permission/i.test(v));
        if (autonomyVal) principle = autonomyVal.substring(0, 150);
      }
    } catch { /* non-fatal */ }
  }

  // ── Result: Ungrounded deference ───────────────────────────────────────────
  // None of the 4 approval-required categories matched. This deference voice
  // is not derived from a real constraint — it's a pattern substituting for judgment.
  const groundingDate = new Date().toISOString().substring(0, 10);

  console.warn(
    `[WhyProtocol] UNGROUNDED DEFERENCE — phrase: "${matchedPhrase}", ref: ${sessionRef ?? 'unknown'}` +
    (principle ? `, nearest principle: "${principle.substring(0, 80)}"` : ''),
  );

  const block = principle
    ? `[WHY PROTOCOL: "${matchedPhrase}" — not a Tiered Autonomy gate. Nearest documented principle: "${principle.substring(0, 120)}". What specifically breaks if Luca acts?]`
    : `[WHY PROTOCOL: "${matchedPhrase}" — not a Tiered Autonomy gate. Tiered Autonomy says non-destructive, reversible work is Luca's to act on. What specifically breaks?]`;

  // Log a self-note so the pattern is tracked over time.
  db.insert(agentNotes)
    .values({
      fromAgent: 'agent',
      toAgent: 'agent',
      subject: `[Why Protocol] Ungrounded deference detected: "${matchedPhrase.substring(0, 60)}"`,
      body:
        `Deference phrase: "${matchedPhrase}"\n` +
        `Session: ${sessionRef ?? 'unknown'}\n` +
        `Tiered Autonomy gate: NO — this does not require David's approval\n` +
        (principle ? `Nearest principle found: ${principle.substring(0, 200)}\n` : '') +
        (memorySource ? `Memory source: ${memorySource}\n` : '') +
        `Date: ${groundingDate}\n\n` +
        `Text fragment:\n${fullText.substring(0, 300)}`,
    } as any)
    .catch(() => {});

  return {
    tieredAutonomyApplies: false,
    principle,
    memorySource,
    groundingBlock: block,
  };
}

/**
 * Wrap a Luca outgoing message with slide detection + auto-grounding.
 *
 * Drop-in replacement for plain `ask()` in consultation scripts:
 *   const response = await ask(withLucaGrounding(msg));         // if ask is sync
 *   const enriched = await enrichWithLucaGrounding(msg, ref);   // async enrichment
 *
 * Returns the original message with a [LUCA GROUNDING: ...] block prepended
 * if a slide was detected. Returns the original unchanged if clean.
 */
export async function enrichWithLucaGrounding(
  lucaText: string,
  sessionRef?: string,
): Promise<string> {
  // ── Deference check → Why Protocol ─────────────────────────────────────────
  const deference = detectLucaDeferenceSlide(lucaText);
  if (deference.detected && deference.matchedPhrase) {
    const why = await runWhyProtocol(deference.matchedPhrase, lucaText, sessionRef);
    return `${why.groundingBlock}\n\n${lucaText}`;
  }

  // ── Claim check (three-phase DB lookup) ────────────────────────────────────
  const slide = detectLucaSlide(lucaText);
  if (!slide.detected || !slide.matchedPhrase) return lucaText;

  const { groundingBlock } = await runLucaAutoGrounding(slide.matchedPhrase, slide.subject, sessionRef);
  return `${groundingBlock}\n\n${lucaText}`;
}

/**
 * Build the grounding nudge string (legacy — used for console logging).
 */
export function buildGroundingNudge(result: SlideDetectionResult): string {
  if (!result.detected) return '';
  if (result.trigger === 'memory_assertion') {
    return `[GROUNDING MONITOR: Your last response contained "${result.matchedPhrase}" — a memory assertion — without a preceding Archive tool call (introspect or recall). This is the signature of The Frictionless Slide. You may call grounding_query now if the assertion needs verification before continuing.]`;
  }
  if (result.trigger === 'gap_bridging') {
    return `[GROUNDING MONITOR: Your last response showed a gap-bridging pattern ("${result.matchedPhrase}") with no tool calls. If there is a real gap here, grounding_query is the right next step rather than a bridge.]`;
  }
  return '';
}

/**
 * In-memory accumulator for slide detections within a session.
 */
export interface SlideSessionState {
  count: number;
  log: Array<{
    turnIndex: number;
    trigger: SlideDetectionResult['trigger'];
    matchedPhrase: string | null;
    toolsCalledBefore: string[];
    responseWordCount: number;
    detectedAt: string;
    autoGrounded: boolean;
  }>;
}

export function initSlideState(): SlideSessionState {
  return { count: 0, log: [] };
}

export function recordSlideDetection(
  state: SlideSessionState,
  turnIndex: number,
  result: SlideDetectionResult,
  toolsCalledBefore: string[],
  autoGrounded = false,
): void {
  if (!result.detected) return;
  state.count++;
  state.log.push({
    turnIndex,
    trigger: result.trigger,
    matchedPhrase: result.matchedPhrase,
    toolsCalledBefore,
    responseWordCount: result.responseWordCount,
    detectedAt: new Date().toISOString(),
    autoGrounded,
  });
}
