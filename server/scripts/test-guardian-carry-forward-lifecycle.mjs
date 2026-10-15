/**
 * Offline regression gate. Optional historical baseline characterizes the old bug.
 *
 * node --test server/scripts/test-guardian-carry-forward-lifecycle.mjs
 * GUARDIAN_REPRO_BASELINE=<reviewed commit> node --test <this file>
 * GUARDIAN_REPRO_ASSERT_CORRECT=1 also demands correctness of a historical baseline.
 * Real method bodies are projected with TypeScript AST, never reimplemented.
 * No server imports, constructor, model, network, database, or real timer runs.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import test from 'node:test';
import ts from 'typescript';

const root = fileURLToPath(new URL('../..', import.meta.url));
const sessionPath = 'server/services/gemini-live-session.ts';
const tracePath = 'server/services/guardian-attempt-trace.ts';
const baseline = process.env.GUARDIAN_REPRO_BASELINE;
if (baseline && !/^[a-f0-9]{40}$/.test(baseline)) throw Error('baseline_requires_full_commit');
const sources = [
  { label: 'workspace', session: readFileSync(`${root}/${sessionPath}`, 'utf8'),
    trace: readFileSync(`${root}/${tracePath}`, 'utf8') },
  ...(baseline ? [{ label: `baseline:${baseline}`,
    session: execFileSync('git', ['show', `${baseline}:${sessionPath}`], { cwd: root, encoding: 'utf8' }),
    trace: execFileSync('git', ['show', `${baseline}:${tracePath}`], { cwd: root, encoding: 'utf8' }) }] : []),
];

const methodNames = [
  'handleServerMessage', '_startGuardianAttempt', '_traceGuardianAttempt',
  '_persistGuardianTrace', '_finalizeGuardianAttemptsForTurn', '_replacePendingWeeOoGrounding',
];
const bindingNames = ['createGroundingTurnBinding', 'isGroundingBindingCurrent'];
const sha = text => createHash('sha256').update(text).digest('hex');

function project(source, mutation = null) {
  const ast = ts.createSourceFile(sessionPath, source, ts.ScriptTarget.Latest, true);
  const cls = ast.statements.find(n => ts.isClassDeclaration(n) && n.name?.text === 'GeminiLiveSession');
  assert(cls, 'real GeminiLiveSession class must exist');
  const methods = methodNames.map(name => {
    const member = cls.members.find(n => ts.isMethodDeclaration(n) && n.name.getText(ast) === name);
    assert(member, `real method ${name} must exist`);
    let text = member.getText(ast);
    if (mutation && name === '_traceGuardianAttempt') {
      const needle = mutation === 'restore-old-freeze'
        ? 'if (attempt.terminalOutcome && !closesDeferred) return;'
        : 'if (!attempt || attempt.terminalOutcome) return;';
      assert(text.includes(needle), 'mutation must touch the actual finalization guard');
      text = text.replace(needle, mutation === 'restore-old-freeze'
        ? 'if (attempt.terminalOutcome) return;' : 'if (!attempt) return;');
    }
    return text;
  });
  const helpers = bindingNames.map(name => {
    const fn = ast.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === name);
    assert(fn, `real binding helper ${name} must exist`);
    return fn.getText(ast).replace(/^export\s+/, '');
  });
  // Preserve literal field defaults (especially rolling metric arrays). Reject
  // every initializer that could call a helper, instantiate anything, or do I/O.
  function literal(n) {
    return ts.isStringLiteral(n) || ts.isNumericLiteral(n)
      || [ts.SyntaxKind.NullKeyword, ts.SyntaxKind.TrueKeyword, ts.SyntaxKind.FalseKeyword].includes(n.kind)
      || (ts.isArrayLiteralExpression(n) && n.elements.every(literal))
      || (ts.isPrefixUnaryExpression(n) && ts.isNumericLiteral(n.operand));
  }
  const defaults = cls.members.filter(n => ts.isPropertyDeclaration(n)
    && n.initializer && literal(n.initializer));
  const instanceDefaults = defaults.filter(n => !n.modifiers?.some(m => m.kind === ts.SyntaxKind.StaticKeyword));
  const staticDefaults = defaults.filter(n => n.modifiers?.some(m => m.kind === ts.SyntaxKind.StaticKeyword));
  // No constructor or class initializers are projected. The original handler
  // itself still drives late lookup, generation completion, and next utterance.
  const text = `${helpers.join('\n')}\nclass GeminiLiveSession {\n${methods.join('\n')}\n}\n`
    + `globalThis.initialState = {${instanceDefaults.map(n => `${n.name.getText(ast)}:${n.initializer.getText(ast)}`).join(',')}};\n`
    + staticDefaults.map(n => `GeminiLiveSession.${n.name.getText(ast)}=${n.initializer.getText(ast)};`).join('\n')
    + '\nglobalThis.Subject = GeminiLiveSession;';
  return { code: ts.transpileModule(text, { compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None,
  } }).outputText, hashes: Object.fromEntries(methodNames.map((name, i) => [name, sha(methods[i])])) };
}

function harness(source, mutation = null) {
  let now = 1_000_000;
  let nextId = 0;
  const timers = new Map();
  const telemetry = [];
  const deliveries = [];
  const warnings = [];
  const lookups = [];
  const blocked = label => () => { throw Error(`forbidden_side_effect:${label}`); };
  class ClockDate extends Date {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
  }
  const context = vm.createContext({
    Date: ClockDate, Buffer, Map, Set,
    console: { log() {}, warn: (...args) => warnings.push(args.join(' ')), error: blocked('console.error') },
    process: { env: Object.freeze({}) },
    fetch: blocked('network'), WebSocket: blocked('socket'),
    getSharedDb: blocked('database'), sql: blocked('sql'),
    setTimeout(fn, delay) {
      assert(Number.isFinite(delay), 'explicit timer delay required');
      const id = ++nextId;
      timers.set(id, { at: now + delay, fn, delay });
      return id;
    },
    clearTimeout: id => timers.delete(id),
    setInterval: blocked('interval'),
    _globalPreTurnFallbackMode: 'carry-forward',
    NAMED_RECORD_PHRASES: [], // synthetic fixture is not a named-record request
    detectStudentEmotionalValence: () => ({ detected: false }),
    detectStudentMemoryRisk: () => ({ detected: false }),
    detectFrictionlessSlide: () => ({ detected: false }),
    observeTurnComplete() {}, // in-memory observation sink, no shared store
    consumeLucaSessionContext: () => null,
    runAutoGrounding(...args) {
      // All writes and notifications must be disabled by the actual caller.
      const { traceAttemptId, ...policy } = args[5];
      assert.deepEqual(JSON.parse(JSON.stringify(policy)),
        { writeToDb: false, notifyLuca: false, postToTeamRoom: false });
      if (traceAttemptId !== undefined) {
        assert.equal(traceAttemptId, s.guardianAttempts.at(-1).attemptId);
      }
      let resolve;
      const promise = new Promise(r => { resolve = r; });
      lookups.push({ args, resolve, promise });
      return promise;
    },
    voiceTelemetry: { log: (...args) => telemetry.push(JSON.parse(JSON.stringify(args))) },
  });
  // Only the pure trace module is evaluated. Its sole value import is crypto.
  const traceJs = ts.transpileModule(source.trace, { compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS,
  } }).outputText;
  const exports = {};
  context.exports = exports;
  context.require = name => {
    assert.equal(name, 'crypto', 'trace helper must not import any server module');
    return { randomUUID: () => `fixture-attempt-${++nextId}` };
  };
  vm.runInContext(traceJs, context, { timeout: 1000 });
  Object.assign(context, exports);
  delete context.require;
  delete context.exports;
  const projection = project(source.session, mutation);
  vm.runInContext(projection.code, context, { timeout: 1000 });
  const s = Object.create(context.Subject.prototype);
  Object.assign(s, context.initialState);
  Object.assign(s, {
    session: { id: 'synthetic-session', dbSessionId: 'synthetic-session', userId: 'synthetic-user',
      conversationId: 'synthetic-conversation', targetLanguage: 'english', ws: {} },
    guardianAttempts: [], guardianFireLog: [], currentTurnId: 6,
    activeStudentTurnEpoch: 2, activeStudentUtterance: '', pendingInputTranscript: '',
    pendingOutputTranscript: '', pendingInputSaved: false,
    pendingCarryForwardGrounding: null, pendingCarryForwardGroundingBinding: null,
    pendingCarryForwardGroundingAttemptId: null, pendingWeeOoGrounding: null,
    preTurnGroundingFired: false, preTurnGroundingIsEmotional: false,
    preTurnGroundingResult: null, preTurnGroundingBinding: null, preTurnGroundingAttemptId: null,
    studentSpeakingStartTime: null, currentTurnFirstInputMs: 0, studentTurnStartMs: 0,
    currentTurnInputWords: 0, lastInputChunkMs: 0, currentTurnMidPauses: 0,
    recentPreSpeechPauses: [], processingPendingSentThisTurn: false,
    firstAudioSentThisTurn: false, generationStartedThisTurn: false, isStopped: false,
    liveSession: { sendClientContent: (...args) => deliveries.push(args),
      sendToolResponse: (...args) => deliveries.push(args) },
    _getContextLineageRecorder: () => null,
    _recordFactualStreamCallback: () => null, _recordContextLineage: () => null,
    _linkContextLineage: blocked('unexpected_lineage_link'),
    _observeGuardian() {},
    sendWsMessage() {},
    getBoundedWhisper: () => null,
    greetingPhaseActive: false, isTutorGeneratingAudio: false,
    hadAudioInCurrentSubturn: false, tutorSpeakingStartTime: null,
    recentAffirmationPhrases: [], recentToolCalls: [], recentTurnSummaries: [],
    recentFrictionScores: [], pendingStudentTranscripts: [],
    generationCompleteWatchdogTimer: null, transcriptClosed: false,
    audioChunks: [], audioChunkBuffer: [], currentTurnChunks: [],
    lastAudioSendTime: 0, pendingAudioBytes: 0, currentTurnAudioChunks: 0,
    pendingTurnUsage: null, turnStartTime: now, lastResponseTime: now,
    _flushTranscripts: async () => {},
    flushPendingTranscripts: async () => {},
    flushTranscripts: async () => {},
    sealAudioSubturn() {},
    sealCurrentAudioSubturn() {}, // audio sink; fixture has no audio frames
    recordCompletedExchangeAtGenerationBoundary() { return false; }, // unrelated accounting sink
  });
  async function drain() {
    for (let i = 0; i < 8; i++) await Promise.resolve();
  }
  async function advance(ms) {
    now += ms;
    for (;;) {
      const entry = [...timers].filter(([, t]) => t.at <= now).sort((a, b) => a[1].at - b[1].at)[0];
      if (!entry) break;
      timers.delete(entry[0]);
      await entry[1].fn();
      await drain();
    }
  }
  return { s, telemetry, deliveries, warnings, lookups, timers, projection,
    input: text => s.handleServerMessage({ serverContent: { inputTranscription: { text } } }),
    complete: () => s.handleServerMessage({ serverContent: { generationComplete: true } }),
    advance, drain };
}

async function runOrdering(source, completeFirst, mutation = null) {
  const h = harness(source, mutation);
  await h.input('Synthetic first utterance with a memory question.');
  assert.equal(h.s.activeStudentTurnEpoch, 3);
  assert.equal(h.lookups.length, 1);
  h.s.processingPendingSentThisTurn = true;
  h.s.generationStartedThisTurn = true;
  await h.advance(2659);
  h.lookups[0].resolve('Synthetic Archive result, bound to the first utterance.');
  await h.drain();
  assert([...h.timers.values()].some(t => t.delay === 150), 'real late fallback timer must be scheduled');
  await h.advance(150);
  assert.equal(h.s.pendingCarryForwardGrounding, 'Synthetic Archive result, bound to the first utterance.');
  const attempt = h.s.guardianAttempts[0];
  assert(attempt.events.some(e => e.detail === 'Late lookup result moved to carry-forward buffer.'));
  if (completeFirst) await h.complete();
  // Production persists/reset transcripts at generation boundaries; give the
  // next incoming message the same real "new utterance" predicate in either order.
  h.s.pendingInputTranscript = '';
  h.s.preTurnGroundingFired = true; // isolate existing payload, no second lookup
  await h.input('Synthetic next utterance on a different topic.');
  if (!completeFirst) await h.complete();
  // Resolve any unrelated audio-seal debounce generated by the real handler.
  await h.advance(1000);
  await h.drain();
  assert.equal(h.s.activeStudentTurnEpoch, 4);
  assert.equal(h.s.pendingCarryForwardGrounding, null, 'stale carry buffer must be removed');
  assert.equal(h.s.pendingWeeOoGrounding, null, 'stale payload must not be staged for model delivery');
  assert.equal(h.deliveries.length, 0, 'no old grounding may reach the new utterance');
  assert.equal(h.lookups.length, 1, 'no second lookup or retry');
  assert.equal(h.timers.size, 0, 'all permitted fake timers must be exhausted');
  assert(h.warnings.some(w => w.includes('Discarding stale carry-forward')), 'real discard branch must execute');
  return { h, attempt, discardRecorded: attempt.events.some(e => e.type === 'stale_discarded') };
}

for (const source of sources) {
  const historical = source.label.startsWith('baseline:');
  test(`${source.label}: late discard after completion is visible without stale delivery`, async () => {
    const result = await runOrdering(source, true);
    assert.equal(result.attempt.terminalOutcome, historical ? 'queued_unconsumed' : 'stale_discarded');
    assert.equal(result.discardRecorded, !historical);
    assert.equal(result.h.telemetry.some(row => row.at(-1)?.event?.type === 'stale_discarded'), !historical);
    console.log(JSON.stringify({ source: source.label, oldDefectReproduced: historical,
      ordering: 'lookup → late buffer → generation complete → next utterance',
      safety: 'old payload discarded, no model delivery',
      outcome: result.attempt.terminalOutcome, discardRecorded: result.discardRecorded,
      methodSha256: result.h.projection.hashes }));
    if (process.env.GUARDIAN_REPRO_ASSERT_CORRECT === '1') {
      assert.equal(result.discardRecorded, true, 'correctness gate: every actual discard must remain observable');
    }
  });
  test(`${source.label}: next utterance before finalization records the same discard`, async () => {
    const result = await runOrdering(source, false);
    assert.equal(result.discardRecorded, true);
    assert.equal(result.attempt.terminalOutcome, 'stale_discarded');
    assert(result.h.telemetry.some(row => row.at(-1)?.event?.type === 'stale_discarded'));
  });
  test(`${source.label}: VM-only mutation proves the finalization guard controls the missing record`, async () => {
    const result = await runOrdering(source, true, historical ? 'allow-later-trace' : 'restore-old-freeze');
    assert.equal(result.discardRecorded, historical);
    assert.equal(result.attempt.terminalOutcome, historical ? 'stale_discarded' : 'queued_unconsumed');
    // Mutations never touch source files, delivery guards, or context bindings.
    assert.equal(result.h.deliveries.length, 0);
  });
  test(`${source.label}: hard-terminal outcomes stay sealed`, () => {
    const h = harness(source);
    for (const outcome of ['lookup_failed', 'stale_discarded', 'superseded',
      'injected_delivery_unknown', 'injected_with_related_archive_call', 'delivery_unknown']) {
      const id = h.s._startGuardianAttempt('pre-turn', {
        studentTurnEpoch: 3, studentUtterance: 'Synthetic text', candidateAssertion: 'Synthetic text',
      });
      const attempt = h.s.guardianAttempts.at(-1);
      attempt.terminalOutcome = outcome;
      const before = attempt.events.length;
      for (const type of ['stale_discarded', 'superseded', 'tool_response_sent', 'archive_call_linked']) {
        h.s._traceGuardianAttempt(id, { type, channel: 'send-client-content' });
      }
      assert.equal(attempt.events.length, before);
      assert.equal(attempt.terminalOutcome, outcome);
    }
  });
  test(`${source.label}: deferred closure permits only discard or supersession`, () => {
    const h = harness(source);
    for (const closesAs of ['stale_discarded', 'superseded']) {
      const id = h.s._startGuardianAttempt('pre-turn', {
        studentTurnEpoch: 3, studentUtterance: 'Synthetic text', candidateAssertion: 'Synthetic text',
      });
      const attempt = h.s.guardianAttempts.at(-1);
      attempt.terminalOutcome = 'queued_unconsumed';
      const before = attempt.events.length;
      for (const type of ['tool_response_sent', 'injected', 'archive_call_linked', 'lookup_failed']) {
        h.s._traceGuardianAttempt(id, { type });
      }
      assert.equal(attempt.events.length, before, 'deferred outcome never reopens for delivery/attribution');
      h.s._traceGuardianAttempt(id, { type: closesAs });
      assert.equal(attempt.terminalOutcome, historical ? 'queued_unconsumed' : closesAs);
      assert.equal(attempt.events.length, before + (historical ? 0 : 1));
    }
  });
}
