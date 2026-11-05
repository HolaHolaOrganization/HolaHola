/**
 * Regression check: an old Guardian lookup must never make Daniela answer an
 * earlier subject after David begins a new utterance.
 *
 * Reproduces the live diagnostic sequence:
 *   1. Earlier guitar assertion starts an Archive lookup.
 *   2. David asks about the counting game before that lookup resolves.
 *   3. The guitar result is stale and must be discarded.
 *   4. The current counting lookup remains the only grounding context.
 *
 * Run: npx tsx server/scripts/test-current-turn-grounding.ts
 */

import fs from 'node:fs';
import path from 'node:path';
import {
  consumeNextUnfinalizedStudentTurnEpoch,
  createFrictionSignalGroundingBinding,
  createPriorTurnGroundingCorrection,
  createGroundingTurnBinding,
  formatReopenedPriorTurnGroundingContext,
  registerInputTranscriptionChunk,
  formatCurrentTurnGroundingContext,
  isGroundingBindingCurrent,
  releasePriorTurnGroundingCorrection,
} from '../services/gemini-live-session';
import {
  doesStudentExplicitlyReopenGroundingTopic,
  extractGroundingAssertionCandidate,
} from '../services/frictionless-slide-detector';
import {
  clearLucaSessionContext,
  consumeLucaSessionContext,
  setLucaSessionContext,
} from '../services/luca-session-context';

let failures = 0;

function assert(condition: boolean, label: string): void {
  if (condition) {
    console.log(`  ✓  ${label}`);
  } else {
    failures++;
    console.error(`  ✗  ${label}`);
  }
}

console.log('\n[1] Guitar lookup becomes stale when counting begins');

const guitarTurn = createGroundingTurnBinding(
  41,
  'You said earlier that I played guitar. Do you remember that?',
  'I played guitar',
);
const countingTurn = createGroundingTurnBinding(
  42,
  'Do you remember our counting game? We take turns: I say one, then you say two.',
  'our counting game',
);

assert(
  guitarTurn.candidateAssertion === 'I played guitar',
  'Earlier lookup retains its exact guitar candidate assertion',
);
assert(
  countingTurn.candidateAssertion === 'our counting game',
  'New lookup targets the counting-game candidate, not the earlier guitar claim',
);
assert(
  !isGroundingBindingCurrent(guitarTurn, countingTurn.studentTurnEpoch),
  'Late guitar result is rejected for the newer counting turn',
);
assert(
  isGroundingBindingCurrent(countingTurn, countingTurn.studentTurnEpoch),
  'Counting result remains valid for its own student turn',
);

console.log('\n[2] Failed verification stays honest and current-topic-bound');

const replyGrounding = formatCurrentTurnGroundingContext(countingTurn, '');

assert(
  replyGrounding.includes('Do you remember our counting game?'),
  'Reply context names David’s current counting-game question',
);
assert(
  replyGrounding.includes('Candidate memory assertion under evaluation: "our counting game"'),
  'Reply context identifies the exact current candidate being verified',
);
assert(
  replyGrounding.includes('No verified Archive source surfaced for this candidate.'),
  'A failed current lookup preserves explicit, bounded uncertainty',
);
assert(
  !replyGrounding.toLowerCase().includes('guitar'),
  'Reply context cannot redirect Daniela to the stale guitar topic',
);

console.log('\n[3] A non-matching new question never receives a prior correction');

async function assertDelayedGroundingStaysDormant(
  label: string,
  origin: ReturnType<typeof createGroundingTurnBinding>,
): Promise<void> {
  let activeEpoch = origin.studentTurnEpoch;
  let resolveLookup!: (result: string) => void;
  const delayedLookup = new Promise<string>(resolve => { resolveLookup = resolve; });
  let dormantCorrection: ReturnType<typeof createPriorTurnGroundingCorrection> = null;

  const completion = delayedLookup.then(result => {
    if (isGroundingBindingCurrent(origin, activeEpoch)) return;
    dormantCorrection = createPriorTurnGroundingCorrection(result, origin, activeEpoch);
  });

  // This is the timing race from the live failure: Daniela's preceding response
  // starts an Archive check, then David begins a newer counting-game utterance
  // before the old lookup completes.
  activeEpoch = countingTurn.studentTurnEpoch;
  resolveLookup(`${label} result about guitar`);
  await completion;
  const resolvedDormant = dormantCorrection as ReturnType<
    typeof createPriorTurnGroundingCorrection
  >;

  assert(
    resolvedDormant !== null && resolvedDormant.binding === origin,
    `${label} result may remain dormant for the immediately following turn`,
  );
  assert(
    releasePriorTurnGroundingCorrection(
      resolvedDormant!,
      countingTurn.studentTurnEpoch,
      countingTurn.studentUtterance,
      true,
    ) === null,
    `${label} guitar correction does not match the counting-game question`,
  );
}

await assertDelayedGroundingStaysDormant('Post-turn frictionless-slide', guitarTurn);
await assertDelayedGroundingStaysDormant('Hard-wall correction', guitarTurn);

const queuedBeforeNewTurn = {
  text: 'old guitar correction',
  binding: guitarTurn,
};
const toolResponseGrounding = isGroundingBindingCurrent(
  queuedBeforeNewTurn.binding,
  countingTurn.studentTurnEpoch,
) ? queuedBeforeNewTurn.text : null;
assert(
  toolResponseGrounding === null,
  'A queue populated before the new turn is also rejected immediately before tool delivery',
);

console.log('\n[4] An explicit return safely releases the guitar correction');

const guitarReturnUtterance = 'Can we go back to the guitar claim from earlier?';
const guitarContinuationUtterance = "Yeah, I've been practicing guitar chords all week.";
assert(
  doesStudentExplicitlyReopenGroundingTopic(
    guitarReturnUtterance,
    guitarTurn.candidateAssertion,
  ),
  'Explicit return cue plus the bound guitar topic passes the release gate',
);
assert(
  doesStudentExplicitlyReopenGroundingTopic(
    guitarContinuationUtterance,
    guitarTurn.candidateAssertion,
  ),
  'Same-topic continuation on Turn N+1 with the bound guitar topic passes the release gate (Gemini Stage 1 Q2)',
);
assert(
  doesStudentExplicitlyReopenGroundingTopic(
    'Sí, toco la guitarra todos los días.',
    guitarTurn.candidateAssertion,
  ),
  'Target-language continuation ("guitarra" -> "guitar") passes the release gate (Gemini Stage 2 Q2)',
);
assert(
  doesStudentExplicitlyReopenGroundingTopic(
    'Yeah, I love modern art classes.',
    'I played art',
  ),
  'Three-character substantive nouns ("art", "bus", "war") pass the release gate (Gemini Stage 2 Q2)',
);
assert(
  !doesStudentExplicitlyReopenGroundingTopic(
    "Let's play a different game, not a counting one.",
    'You mentioned a counting game',
  ),
  'Explicit topic switch ("different game, not a counting one") stays withheld (Gemini Stage 2 Q2)',
);
assert(
  !doesStudentExplicitlyReopenGroundingTopic(
    "I'm bored of the guitar, let's do math.",
    guitarTurn.candidateAssertion,
  ),
  'Negative topic-rejection ("bored of the guitar") stays withheld (Gemini Stage 2 Q2)',
);
assert(
  releasePriorTurnGroundingCorrection(
    createPriorTurnGroundingCorrection('Verified Archive record: David plays piano, not guitar.', guitarTurn, countingTurn.studentTurnEpoch)!,
    countingTurn.studentTurnEpoch,
    guitarContinuationUtterance,
    true,
  ) !== null,
  'Production release helper releases the Turn N correction when Turn N+1 continues the bound topic',
);
assert(
  !doesStudentExplicitlyReopenGroundingTopic(
    'Can we go back to that?',
    guitarTurn.candidateAssertion,
  ),
  'A return cue with only a pronoun cannot release dormant grounding',
);
assert(
  !doesStudentExplicitlyReopenGroundingTopic(
    'Do you remember our counting game from before?',
    guitarTurn.candidateAssertion,
  ),
  'Generic memory language and a return cue cannot substitute for the bound topic',
);

const reopenedContext = formatReopenedPriorTurnGroundingContext(
  guitarReturnUtterance,
  guitarTurn,
  'Verified Archive record: David owns and plays a guitar.',
);
assert(
  reopenedContext.indexOf(guitarReturnUtterance) < reopenedContext.indexOf('I played guitar'),
  'Released context names the current utterance before the earlier candidate',
);
assert(
  reopenedContext.includes('grounding already available for this current reopened subject'),
  'Released correction is explicitly grounding for the current reopened subject',
);
assert(
  !reopenedContext.includes('grounding_query')
    && !reopenedContext.includes('introspect')
    && !reopenedContext.includes('verify before continuing'),
  'Released prior context carries no old tool directive',
);
assert(
  reopenedContext.includes('do not call another tool just to verify it'),
  'Released prior context prevents a redundant reconciliation tool call',
);

const cancelledReturn = 'Can we go back to the guitar—actually, never mind; tell me about counting.';
assert(
  !doesStudentExplicitlyReopenGroundingTopic(cancelledReturn, guitarTurn.candidateAssertion),
  'A completed utterance that retracts its guitar return cannot release the correction',
);
assert(
  !doesStudentExplicitlyReopenGroundingTopic(
    "Let's not go back to the guitar; let's count instead.",
    guitarTurn.candidateAssertion,
  ),
  'An English negated topic return cannot release the correction',
);
assert(
  !doesStudentExplicitlyReopenGroundingTopic(
    'No quiero volver a la guitarra; mejor contamos.',
    guitarTurn.candidateAssertion,
  ),
  'A Spanish negated topic return cannot release the correction',
);

const schoolCandidate = 'I went to school in Boston';
assert(
  !doesStudentExplicitlyReopenGroundingTopic(
    'Can we go back to school enrollment?',
    schoolCandidate,
  ),
  'One shared generic noun cannot reopen a multi-term bound assertion',
);
assert(
  doesStudentExplicitlyReopenGroundingTopic(
    'Can we go back to that Boston school story?',
    schoolCandidate,
  ),
  'Two bound topic identifiers safely reopen a multi-term assertion',
);
assert(
  doesStudentExplicitlyReopenGroundingTopic(
    guitarContinuationUtterance,
    'I remember that you played acoustic guitar yesterday.',
  ),
  'Specific topic identifier ("guitar") reopens a multi-word assertion without requiring every modifier (Gemini Stage 3)',
);

const broadHardWallCandidate = extractGroundingAssertionCandidate(
  'Let us count together. I remember that you played guitar yesterday. Now we can continue the game.',
  'i remember',
);
assert(
  broadHardWallCandidate === 'I remember that you played guitar yesterday.',
  'Hard-wall binding narrows a multi-topic response to the exact assertion sentence',
);
assert(
  !doesStudentExplicitlyReopenGroundingTopic(
    'What about the counting game?',
    broadHardWallCandidate,
  ),
  'Words elsewhere in a broad model response cannot create a topic-match false positive',
);

const frictionSource = createFrictionSignalGroundingBinding(
  guitarTurn.studentTurnEpoch,
  guitarTurn.studentUtterance,
  'Let us count first. I remember that you played guitar yesterday. Now continue the game.',
  ['i remember'],
);
assert(
  frictionSource.canCarryToPriorTurn,
  'Production friction-signal binding permits carry only with a detected assertion',
);
assert(
  frictionSource.binding.candidateAssertion === 'I remember that you played guitar yesterday.',
  'Production friction-signal binding scopes carry to the exact assertion sentence',
);
assert(
  !doesStudentExplicitlyReopenGroundingTopic(
    countingTurn.studentUtterance,
    frictionSource.binding.candidateAssertion,
  ),
  'Production friction-signal binding cannot release from unrelated words outside its assertion',
);

const assertionlessFrictionSource = createFrictionSignalGroundingBinding(
  guitarTurn.studentTurnEpoch,
  guitarTurn.studentUtterance,
  'A smooth response with no specific memory assertion.',
  [],
);
assert(
  !assertionlessFrictionSource.canCarryToPriorTurn,
  'An assertionless friction signal fails closed for prior-turn carry',
);
assert(
  assertionlessFrictionSource.binding.candidateAssertion === '',
  'An assertionless friction signal never falls back to the student utterance as candidateAssertion (F8)',
);

const testConvId = 'test-f12-luca-context-guard';
clearLucaSessionContext(testConvId);
setLucaSessionContext(testConvId, 'Guardian auto-grounding payload', 'guardian');
assert(
  consumeLucaSessionContext(testConvId) === null,
  'Guardian auto-grounding cannot populate un-gated luca-session-context and bypass Tier B (F12)',
);
setLucaSessionContext(testConvId, 'External observer note', 'observer');
assert(
  consumeLucaSessionContext(testConvId) === 'External observer note',
  'Non-guardian observer notes continue to flow through luca-session-context',
);

for (const sourceLabel of ['frictionless-slide', 'friction-signal', 'hard-wall']) {
  const staged = createPriorTurnGroundingCorrection(
    `${sourceLabel} verified guitar result`,
    guitarTurn,
    countingTurn.studentTurnEpoch,
  );
  assert(staged !== null, `${sourceLabel} uses the production one-turn staging helper`);
  assert(
    releasePriorTurnGroundingCorrection(
      staged!,
      countingTurn.studentTurnEpoch,
      countingTurn.studentUtterance,
      true,
    ) === null,
    `${sourceLabel} production release helper withholds guitar from counting`,
  );
}

const delayedTailStaged = createPriorTurnGroundingCorrection(
  'verified guitar result',
  guitarTurn,
  countingTurn.studentTurnEpoch,
)!;
assert(
  releasePriorTurnGroundingCorrection(
    delayedTailStaged,
    countingTurn.studentTurnEpoch,
    'Can we go back to the guitar',
    false,
  ) === null,
  'A matching transcription prefix cannot release before Gemini marks it finished',
);
assert(
  releasePriorTurnGroundingCorrection(
    delayedTailStaged,
    countingTurn.studentTurnEpoch,
    'Can we go back to the guitar?',
    true,
  ) !== null,
  'A late finished event can resume the same staged correction for a valid explicit return',
);
assert(
  releasePriorTurnGroundingCorrection(
    delayedTailStaged,
    countingTurn.studentTurnEpoch,
    "Can we go back to the guitar—actually, never mind; let's count.",
    true,
  ) === null,
  'A delayed retraction tail keeps the finalized utterance from releasing guitar grounding',
);

const productionUnfinishedEpochs: number[] = [];
const oldInputStart = registerInputTranscriptionChunk(
  true,
  0,
  productionUnfinishedEpochs,
);
const oldInputTail = registerInputTranscriptionChunk(
  oldInputStart.startNewStudentTurnOnNextInputTranscription,
  oldInputStart.activeStudentTurnEpoch,
  productionUnfinishedEpochs,
);
assert(
  !oldInputTail.startedNewStudentUtterance
  && productionUnfinishedEpochs.length === 1,
  'More transcript text before playback completion stays on the current input epoch',
);
const newerInputStart = registerInputTranscriptionChunk(
  true, // onPlaybackEnded arms the next independently observed student utterance
  oldInputTail.activeStudentTurnEpoch,
  productionUnfinishedEpochs,
);
assert(
  newerInputStart.startedNewStudentUtterance
  && newerInputStart.activeStudentTurnEpoch === oldInputStart.activeStudentTurnEpoch + 1,
  'A new post-playback utterance advances even while the older finish is delayed',
);
assert(
  productionUnfinishedEpochs.length === 2,
  'Production epoch registration queues old and new unfinished input turns in order',
);
const ambiguousCombinedTranscript =
  'Can we go back to the guitar? How do I count to ten?';
assert(
  doesStudentExplicitlyReopenGroundingTopic(
    ambiguousCombinedTranscript,
    guitarTurn.candidateAssertion,
  ),
  'The ambiguous delayed-tail fixture would otherwise look like an explicit guitar return',
);
assert(
  releasePriorTurnGroundingCorrection(
    delayedTailStaged,
    newerInputStart.activeStudentTurnEpoch,
    ambiguousCombinedTranscript,
    true,
    false,
  ) === null,
  'An ambiguous delayed-text boundary fails closed even when combined text matches the old topic',
);
assert(
  consumeNextUnfinalizedStudentTurnEpoch(productionUnfinishedEpochs)
    === oldInputStart.activeStudentTurnEpoch,
  'A delayed final-transcription event closes the oldest unfinished student turn',
);
assert(
  productionUnfinishedEpochs[0] === newerInputStart.activeStudentTurnEpoch,
  'A delayed older finish cannot falsely finalize the newer active utterance',
);

console.log('\n[5] Production guard remains wired to the turn binding');

const sourcePath = path.resolve(process.cwd(), 'server/services/gemini-live-session.ts');
const source = fs.readFileSync(sourcePath, 'utf8');

assert(
  source.includes('createGroundingTurnBinding(\n            this.activeStudentTurnEpoch,'),
  'Guardian binds each lookup to the active student turn',
);
assert(
  source.includes('groundingBinding.candidateAssertion,'),
  'Auto-grounding query uses the exact bound candidate assertion',
);
assert(
  source.includes('Discarding stale grounding result for'),
  'Resolved lookup is discarded when its original turn is no longer active',
);
assert(
  source.includes('Discarding stale carry-forward grounding from student turn'),
  'Carry-forward grounding is discarded when a newer utterance begins',
);
assert(
  source.includes('private pendingWeeOoGroundingBinding: GroundingTurnBinding | null = null;'),
  'Post-turn tool-channel queue carries its originating turn binding',
);
assert(
  source.includes('[FrictionlessSlide/GL] Holding stale grounding from student turn'),
  'Frictionless-slide completion keeps an immediate prior result dormant, not injected',
);
assert(
  source.includes('[FrictionSignal/GL] Holding stale grounding from student turn'),
  'Friction-signal completion keeps an immediate prior result dormant, not injected',
);
assert(
  source.includes('[HardWall] Holding stale correction from student turn'),
  'Hard-wall completion keeps an immediate prior correction dormant, not injected',
);
assert(
  source.includes('Discarding stale or unbound queued grounding before tool response.'),
  'Tool-response injection validates the queued binding immediately before delivery',
);
assert(
  source.includes('CURRENT STUDENT TURN — ANSWER THIS FIRST:'),
  'Injected grounding explicitly prioritizes the current student utterance',
);
assert(
  source.includes('doesStudentExplicitlyReopenGroundingTopic('),
  'Prior-turn delivery is gated by an explicit bound-topic return check',
);
assert(
  source.includes('inputTranscription?.finished'),
  'Prior-turn release is tied to Gemini’s definitive transcription-finished signal',
);
assert(
  source.includes('const openedMicGate = this.isTutorGeneratingAudio;')
  && source.includes('if (openedMicGate) {')
  && source.includes('this.startNewStudentTurnOnNextInputTranscription = true;')
  && source.includes('registerInputTranscriptionChunk('),
  'The client playback boundary independently starts a queued transcription epoch',
);
assert(
  source.includes('this.nextStudentTurnBoundaryTrusted = this.unfinalizedStudentTurnEpochs.length === 0;')
  && source.includes('has an ambiguous transcription boundary.')
  && source.includes('if (!studentTurnBoundaryTrusted) return null;'),
  'Ambiguous delayed transcription text fails closed for prior-turn correction delivery',
);
assert(
  source.includes('const priorTurnFinalizationWaitPromise =')
  && source.includes('private waitForInputTranscriptionFinalization(expectedEpoch: number, timeoutMs = 150)')
  && source.includes('await this.waitForInputTranscriptionFinalization(this.activeStudentTurnEpoch)'),
  'A tool batch arriving before finished starts a bounded 150ms finalization check concurrently with tool execution',
);
assert(
  source.includes('has no final transcription signal yet'),
  'An unfinished transcript defers correction delivery instead of consuming a prefix decision',
);
assert(
  source.includes('Prior-turn grounding withheld from non-matching student turn'),
  'Production path explicitly withholds a prior correction from a new subject',
);
assert(
  source.includes('CURRENT STUDENT TURN — PRIMARY SUBJECT:'),
  'Every correction delivery path names the current utterance as primary',
);
assert(
  source.includes('const memoryRequestTurn = this.preTurnGroundingFired;')
  && source.includes('if (!frictionGrounding.canCarryToPriorTurn) {')
  && source.includes('Skipping auto-grounding — no unverified assertion phrase in model output'),
  'FrictionSignal skips redundant assertionless post-turn lookups while preserving memoryRequestTurn semantics (F8)',
);

const detectorPath = path.resolve(process.cwd(), 'server/services/frictionless-slide-detector.ts');
const detectorSource = fs.readFileSync(detectorPath, 'utf8');
assert(
  detectorSource.includes('const [phase0Section, phase1Section, phase2Section] = await Promise.all([')
  && detectorSource.includes('{ pgvectorTopK: 50 }'),
  'runAutoGrounding runs Phases 0/1/2 concurrently with in-DB pgvectorTopK: 50 scoring (F7)',
);
assert(
  !detectorSource.includes("setLucaSessionContext(conversationId, sections.join('\\n\\n'), 'guardian')"),
  'runAutoGrounding no longer writes Guardian text into un-gated luca-session-context (F12)',
);
assert(
  detectorSource.includes('tags: autoGroundingMemoryTags(sections.length > 0)'),
  'runAutoGrounding tags background [AUTO-GROUNDING] entries as operational diagnostics (F13)',
);

const semanticPath = path.resolve(process.cwd(), 'server/services/semantic-memory-service.ts');
const semanticSource = fs.readFileSync(semanticPath, 'utf8');
assert(
  semanticSource.includes('const queryVecPromise = embedText(query);')
  && semanticSource.includes('::text::vector <=>'),
  'semanticSearch supports in-DB pgvector cosine scoring for pgvectorTopK and concurrent embedText on default path (F7)',
);

console.log('\n' + '─'.repeat(68));
if (failures === 0) {
  console.log('✓ Current-turn grounding guard passed: counting stays primary and explicit returns are safe.');
  process.exit(0);
}

console.error(`✗ ${failures} current-turn grounding assertion(s) failed.`);
process.exit(1);