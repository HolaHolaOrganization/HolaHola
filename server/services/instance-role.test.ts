import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  BACKGROUND_TASKS,
  INSTANCE_ROLE_ENV,
  createBackgroundTaskGate,
  isBackgroundTaskAllowed,
  resolveInstanceRole,
  type BackgroundTaskId,
} from './instance-role';
import { assertFounderEmbeddingScopesClean } from './founder-embedding-scope-check';
import { auditBootTimers } from '../scripts/audit-boot-timers';

const TASK_IDS = Object.keys(BACKGROUND_TASKS) as BackgroundTaskId[];
const INDEX_SOURCE = readFileSync(new URL('../index.ts', import.meta.url), 'utf8');
const ROUTES_SOURCE = readFileSync(new URL('../routes.ts', import.meta.url), 'utf8');
const INDEXER_SOURCE = readFileSync(new URL('./memory-embedding-indexer.ts', import.meta.url), 'utf8');

// ── Role resolution and the gate ─────────────────────────────────────────────

test('resolveInstanceRole accepts exactly production and dev', () => {
  assert.equal(resolveInstanceRole({ [INSTANCE_ROLE_ENV]: 'production' }), 'production');
  assert.equal(resolveInstanceRole({ [INSTANCE_ROLE_ENV]: 'dev' }), 'dev');
});

test('resolveInstanceRole refuses a missing, empty or unknown role', () => {
  assert.throws(() => resolveInstanceRole({}), /HOLAHOLA_INSTANCE_ROLE is required/);
  assert.throws(() => resolveInstanceRole({ [INSTANCE_ROLE_ENV]: '' }), /is required/);
  for (const bad of ['Production', 'prod', 'development', 'staging', ' production', 'dev ']) {
    assert.throws(() => resolveInstanceRole({ [INSTANCE_ROLE_ENV]: bad }), /unsupported value/, bad);
  }
});

test('default-deny: no background task is allowed on dev today', () => {
  // Allowing a task on dev is a deliberate, reviewed change: update this list with it.
  assert.deepEqual(TASK_IDS.filter((id) => isBackgroundTaskAllowed('dev', id)), []);
});

test('production keeps every registered background task', () => {
  for (const id of TASK_IDS) assert.equal(isBackgroundTaskAllowed('production', id), true, id);
});

test('the gate runs nothing on dev and records every skip', () => {
  const lines: string[] = [];
  const gate = createBackgroundTaskGate('dev', (line) => lines.push(line));
  let ran = 0;
  for (const id of TASK_IDS) gate.run(id, () => { ran++; });
  assert.equal(ran, 0);
  assert.equal(gate.claim('session-monitor'), false);
  const summary = gate.summary();
  assert.equal(summary.started.length, 0);
  assert.equal(summary.skipped.length, TASK_IDS.length + 1);
  assert.ok(lines.every((line) => line.startsWith('[InstanceRole] dev: not starting background task')));
});

test('the gate runs every task on production, synchronously and in call order', () => {
  const gate = createBackgroundTaskGate('production', () => {});
  const order: string[] = [];
  for (const id of TASK_IDS) gate.run(id, () => { order.push(id); });
  assert.deepEqual(order, TASK_IDS);
  assert.equal(gate.claim('session-monitor'), true);
  assert.equal(gate.summary().skipped.length, 0);
});

// ── Founder embedding scope: production repairs, dev checks read-only (R1) ──

test('dev founder-embedding check: clean state passes and performs no write', async () => {
  let calls = 0;
  await assertFounderEmbeddingScopesClean(async () => { calls++; return 0; });
  assert.equal(calls, 1);
});

test('dev founder-embedding check: dirty or invalid state refuses to serve', async () => {
  await assert.rejects(assertFounderEmbeddingScopesClean(async () => 3), /3 founder-tagged conversation memories have null-scoped embeddings/);
  await assert.rejects(assertFounderEmbeddingScopesClean(async () => 1), /1 founder-tagged conversation memory has/);
  await assert.rejects(assertFounderEmbeddingScopesClean(async () => Number.NaN), /invalid count/);
  await assert.rejects(assertFounderEmbeddingScopesClean(async () => { throw new Error('db down'); }), /db down/);
});

test('the dev count query is SELECT-only and uses the repair predicate', () => {
  const start = INDEXER_SOURCE.indexOf('export async function countUnscopedFounderEmbeddings');
  const end = INDEXER_SOURCE.indexOf('export async function correctFounderEmbeddingScopes');
  assert.ok(start > 0 && end > start);
  const body = INDEXER_SOURCE.slice(start, end);
  assert.doesNotMatch(body, /\b(UPDATE|DELETE|INSERT|ALTER|DROP|TRUNCATE)\b/);
  assert.match(body, /SELECT COUNT\(DISTINCT cm\.id\)/);
  assert.match(body, /me\.user_id IS NULL/);
});

test('index.ts repairs only under the claim and otherwise runs the read-only check', () => {
  const at = INDEX_SOURCE.indexOf("backgroundTasks.claim('founder-embedding-scope-repair')");
  const section = INDEX_SOURCE.slice(at, INDEX_SOURCE.indexOf('// Attach all socket transports', at));
  const repair = section.indexOf('await correctFounderEmbeddingScopes()');
  const elseBranch = section.indexOf('} else {');
  const check = section.indexOf('await assertFounderEmbeddingScopesClean(countUnscopedFounderEmbeddings)');
  assert.ok(repair > 0 && elseBranch > repair && check > elseBranch, 'repair in the claimed try, read-only check in else');
  assert.equal(INDEX_SOURCE.split('correctFounderEmbeddingScopes()').length - 1, 1, 'repair is called exactly once');
});

// ── registerRoutes voice transcript auto-save (R2) ───────────────────────────

test('registerRoutes claims the transcript auto-save and keeps expiry role-independent', () => {
  const claim = ROUTES_SOURCE.indexOf("getProcessBackgroundTasks().claim('agent-voice-transcript-autosave')");
  assert.ok(claim > 0);
  const loop = ROUTES_SOURCE.slice(claim, ROUTES_SOURCE.indexOf('}, 10 * 60 * 1000);', claim));
  assert.match(loop, /if \(autoSaveExpiredVoiceTranscripts && s\.conversationTranscript\.length > 0\)/);
  assert.ok(loop.indexOf('INSERT INTO conversation_memories') > loop.indexOf('autoSaveExpiredVoiceTranscripts && '));
  assert.match(loop, /agentVoiceSessions\.delete\(id\);/);
});

// ── Structural guard over server/index.ts (and its regression tests, R3) ────

/** Replaces comments and string/template contents with spaces, keeping offsets. */
function maskCode(src: string): string {
  const out = src.split('');
  let i = 0;
  const blank = (from: number, to: number) => {
    for (let k = from; k < to; k++) if (out[k] !== '\n') out[k] = ' ';
  };
  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];
    if (c === '/' && n === '/') {
      const end = src.indexOf('\n', i);
      const stop = end === -1 ? src.length : end;
      blank(i, stop);
      i = stop;
    } else if (c === '/' && n === '*') {
      const end = src.indexOf('*/', i + 2) + 2;
      blank(i, end);
      i = end;
    } else if (c === "'" || c === '"' || c === '`') {
      let j = i + 1;
      while (j < src.length && src[j] !== c) j += src[j] === '\\' ? 2 : 1;
      blank(i + 1, j);
      i = j + 1;
    } else {
      i++;
    }
  }
  return out.join('');
}

function matchClose(code: string, openIndex: number): number {
  const open = code[openIndex];
  const close = open === '(' ? ')' : '}';
  let depth = 0;
  for (let k = openIndex; k < code.length; k++) {
    if (code[k] === open) depth++;
    else if (code[k] === close && --depth === 0) return k;
  }
  throw new Error(`unbalanced ${open} at ${openIndex}`);
}

/**
 * Byte ranges that only execute when the gate allows them.
 * - backgroundTasks.run(id, fn): the call itself.
 * - if (backgroundTasks.claim(id)) { ... } or ... try { ... } catch { ... }: that block.
 * - if (!backgroundTasks.claim(id)) { <assignments>; return; }: the rest of the
 *   enclosing block, ONLY when the guarded block provably always returns
 *   (simple assignments followed by a final return). Anything else throws.
 */
function gatedRanges(code: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  for (const m of code.matchAll(/backgroundTasks\.run\(/g)) {
    const open = m.index! + m[0].length - 1;
    ranges.push([m.index!, matchClose(code, open)]);
  }
  for (const m of code.matchAll(/(!?)backgroundTasks\.claim\(/g)) {
    const callEnd = matchClose(code, m.index! + m[0].length - 1);
    const after = code.slice(callEnd + 1).match(/^\s*\)\s*(try\s*)?\{/);
    if (!after) throw new Error(`claim at offset ${m.index} must be followed by a guarded block`);
    const blockOpen = callEnd + 1 + after[0].length - 1;
    const blockClose = matchClose(code, blockOpen);
    if (m[1] === '!') {
      const body = code.slice(blockOpen + 1, blockClose);
      if (after[1] || !/^(\s*[\w.]+\s*=\s*[^;{}]+;)*\s*return\s*;\s*$/.test(body)) {
        throw new Error(`negated claim at offset ${m.index} must guard a block that always returns (simple assignments, then return;)`);
      }
      let depth = 0;
      let k = blockClose + 1;
      for (; k < code.length; k++) {
        if (code[k] === '{') depth++;
        else if (code[k] === '}' && --depth < 0) break;
      }
      ranges.push([m.index!, k]);
      continue;
    }
    let end = blockClose;
    const catchMatch = code.slice(end + 1).match(/^\s*catch\s*(\([^)]*\))?\s*\{/);
    if (after[1] && catchMatch) end = matchClose(code, end + 1 + catchMatch[0].length - 1);
    ranges.push([m.index!, end]);
  }
  return ranges;
}

const STARTER = /\b(setTimeout|setInterval|setImmediate|start[A-Z]\w*|schedule[A-Z]\w*|run[A-Z]\w*|seed[A-Z]\w*|generate[A-Z]\w*|reap[A-Z]\w*|index[A-Z]\w*|bulk[A-Z]\w*|ensure[A-Z]\w*|populate[A-Z]\w*|connect[A-Z]\w*|sync[A-Z]\w*|correct[A-Z]\w*|repair[A-Z]\w*|purge[A-Z]\w*|backfill[A-Z]\w*|cleanup[A-Z]\w*|migrate[A-Z]\w*)\s*\(|\.start(?:[A-Z]\w*)?\s*\(/g;
// Request-path or read-only calls that are intentionally role-independent.
const ALLOWED_UNGATED = [
  /voiceTelemetry\.start\(/, // batches telemetry from requests this instance serves
  /runProxyStartupChecks\(/, // read-only reachability log
  /setTimeout\(resolve/, // shutdown / fatal-path drain waits
];

function findUngatedStarters(source: string): string[] {
  const code = maskCode(source);
  const ranges = gatedRanges(code);
  const inGate = (at: number) => ranges.some(([a, b]) => at >= a && at <= b);
  const offenders: string[] = [];
  for (const m of code.matchAll(STARTER)) {
    if (inGate(m.index!)) continue;
    const line = source.slice(source.lastIndexOf('\n', m.index!) + 1, source.indexOf('\n', m.index!));
    if (ALLOWED_UNGATED.some((re) => re.test(line))) continue;
    offenders.push(`server/index.ts:${source.slice(0, m.index!).split('\n').length}: ${line.trim()}`);
  }
  return offenders;
}

test('every registered task is gated exactly once across index.ts and routes.ts', () => {
  const sources = INDEX_SOURCE + '\n' + ROUTES_SOURCE;
  for (const id of TASK_IDS) {
    const uses = sources.split(`.run('${id}'`).length - 1 + sources.split(`.claim('${id}'`).length - 1;
    assert.equal(uses, 1, `${id} must be gated exactly once (found ${uses})`);
  }
  const ids = [...sources.matchAll(/(?:backgroundTasks|getProcessBackgroundTasks\(\))\.(?:run|claim)\('([^']+)'/g)].map((m) => m[1]);
  for (const id of ids) assert.ok(id in BACKGROUND_TASKS, `unregistered task id ${id}`);
});

test('the instance role is resolved before any startup work begins', () => {
  const resolved = INDEX_SOURCE.indexOf('instanceRole = resolveInstanceRole()');
  assert.ok(resolved > 0);
  for (const marker of ['initStripe', 'server.listen(', 'registerRoutes(app)']) {
    assert.ok(resolved < INDEX_SOURCE.indexOf(marker), `role must resolve before ${marker}`);
  }
});

test('no timer or worker starter in server/index.ts runs outside the gate', () => {
  assert.deepEqual(findUngatedStarters(INDEX_SOURCE), [], 'register these in BACKGROUND_TASKS and gate them');
});

test('guard regression: removing the return from a negated claim is rejected', () => {
  const guarded = "  if (!backgroundTasks.claim('boot-stripe-sync-and-seeds')) {\n    stripeReady = false;\n    return;\n  }";
  assert.ok(INDEX_SOURCE.includes(guarded), 'fixture anchor moved; update this test');
  const mutated = INDEX_SOURCE.replace(guarded, guarded.replace('    return;\n', ''));
  assert.throws(() => findUngatedStarters(mutated), /must guard a block that always returns/);
  const conditional = INDEX_SOURCE.replace(guarded, guarded.replace('    return;', '    if (stripeReady) return;'));
  assert.throws(() => findUngatedStarters(conditional), /must guard a block that always returns/);
});

test('guard regression: un-gating a starter or a repair is reported', () => {
  const hive = INDEX_SOURCE.replace(
    "backgroundTasks.run('hive-sync', () => hiveConsciousnessService.startListening());",
    'hiveConsciousnessService.startListening();');
  assert.match(findUngatedStarters(hive).join('\n'), /hiveConsciousnessService\.startListening\(\)/);
  const repair = INDEX_SOURCE.replace(
    "if (backgroundTasks.claim('founder-embedding-scope-repair')) try {",
    'if (true) try {');
  assert.match(findUngatedStarters(repair).join('\n'), /correctFounderEmbeddingScopes/);
});

// ── Process-wide boot-time timer inventory (R2) ─────────────────────────────
// Every timer that starts at module import or in a named top-level function
// anywhere in server/ must be classified here. A new one fails CI until a
// reviewer decides how the instance role applies to it.

type TimerClass =
  | 'gated-starter' // a start function only invoked from a gated index.ts task (verified below)
  | 'worker-internal' // a helper used only inside a gated worker's own file
  | 'gated-in-registration' // registerRoutes: claimed per-role at registration
  | 'housekeeping' // in-memory cache/map/nonce pruning; no shared-data writes
  | 'on-demand' // started by a request, session or founder action, not at boot
  | 'unused'; // no caller in server/

const BOOT_TIMER_INVENTORY: Record<string, TimerClass> = {
  'server/db.ts::getDb::setInterval': 'on-demand', // pool keepalive SELECT 1, created with the pool
  'server/middleware/sync-auth.ts::module::setInterval': 'housekeeping',
  'server/routes.ts::module::setInterval': 'housekeeping', // sofiaDiagThrottle map
  'server/routes.ts::registerRoutes::setInterval': 'gated-in-registration', // agent voice expiry; INSERT claimed
  'server/services/agent-daniela-dialogue-worker.ts::startDanielaDialogueWorker::setTimeout': 'gated-starter',
  'server/services/agent-proactive-sweep-worker.ts::startAgentSweepWorker::setTimeout': 'gated-starter',
  'server/services/agent-session-autosave.ts::scheduleEpisodeSync::setTimeout': 'worker-internal',
  'server/services/agent-session-autosave.ts::schedulePrequelEpisodeSync::setTimeout': 'worker-internal',
  'server/services/agent-session-autosave.ts::startAgentSessionAutosave::setInterval': 'gated-starter',
  'server/services/alden-digest-worker.ts::startAldenDigestWorker::setTimeout': 'gated-starter',
  'server/services/alden-digest-worker.ts::startAldenDigestWorker::setInterval': 'gated-starter',
  'server/services/alden-watch-worker.ts::runWatchCycle::setTimeout': 'worker-internal',
  'server/services/alden-watch-worker.ts::scheduleNextCycle::setTimeout': 'worker-internal',
  'server/services/alden-watch-worker.ts::startAldenWatchWorker::setTimeout': 'gated-starter',
  'server/services/alden-watch-worker.ts::startAldenWatchWorker::setInterval': 'gated-starter',
  'server/services/board-meeting-service.ts::scheduleMondayBrief::setTimeout': 'worker-internal',
  'server/services/brain-health-aggregator.ts::startBrainHealthAggregator::setInterval': 'gated-starter',
  'server/services/context-health-monitor.ts::startContextHealthMonitor::setTimeout': 'gated-starter',
  'server/services/context-health-monitor.ts::startContextHealthMonitor::setInterval': 'gated-starter',
  'server/services/coordination-delivery-worker.ts::startCoordinationDeliveryWorker::setInterval': 'gated-starter',
  'server/services/coordination-gemini-provider-worker.ts::startGeminiProviderWorker::setInterval': 'gated-starter',
  'server/services/coordination-lifecycle-reaper-worker.ts::startCoordinationLifecycleReaperWorker::setInterval': 'gated-starter',
  'server/services/daniela-absence-worker.ts::startDanielaAbsenceWorker::setTimeout': 'gated-starter',
  'server/services/daniela-consult-autosave.ts::startDanielaConsultAutosave::setInterval': 'gated-starter',
  'server/services/daniela-consult-autosave.ts::startDanielaConsultAutosave::setTimeout': 'gated-starter',
  'server/services/daniela-presence-worker.ts::startDanielaPresenceWorker::setTimeout': 'gated-starter',
  'server/services/daniela-presence-worker.ts::startDanielaPresenceWorker::setInterval': 'gated-starter',
  'server/services/drill-orchestrator.ts::completeDrill::setTimeout': 'on-demand',
  'server/services/drill-orchestrator.ts::module::setInterval': 'housekeeping', // activeDrills map
  'server/services/editor-background-worker.ts::startEditorWorker::setInterval': 'on-demand', // founder-triggered route
  'server/services/editor-realtime-dispatcher.ts::startRealtimeDispatcher::setInterval': 'unused',
  'server/services/fact-confidence-decay-worker.ts::startFactConfidenceDecayWorker::setInterval': 'gated-starter',
  'server/services/founder-chat-sync.ts::notifyConversationUpdated::setTimeout': 'on-demand', // message-save debounce (request path)
  'server/services/founder-chat-sync.ts::startFounderChatSyncWorker::setTimeout': 'gated-starter',
  'server/services/history-backfill-service.ts::startConversationCurator::setTimeout': 'gated-starter',
  'server/services/history-backfill-service.ts::startConversationCurator::setInterval': 'gated-starter',
  'server/services/luca-observer.ts::startLucaObserver::setInterval': 'gated-starter',
  'server/services/luca-presence.ts::scheduleRoomSyncRetry::setTimeout': 'worker-internal',
  'server/services/lyra-analytics-worker.ts::startLyraAnalyticsWorker::setTimeout': 'gated-starter',
  'server/services/lyra-analytics-worker.ts::startLyraAnalyticsWorker::setInterval': 'gated-starter',
  'server/services/madrigal-embedding-indexer.ts::scheduleMadrigalIndexing::setTimeout': 'gated-starter',
  'server/services/memory-consolidation-worker.ts::startConsolidationWorker::setInterval': 'gated-starter',
  'server/services/memory-consolidator.ts::startMemoryConsolidator::setTimeout': 'gated-starter',
  'server/services/memory-consolidator.ts::startMemoryConsolidator::setInterval': 'gated-starter',
  'server/services/memory-embedding-indexer.ts::scheduleStartupLivenessCheck::setTimeout': 'worker-internal',
  'server/services/memory-embedding-indexer.ts::startMemoryEmbeddingIndexer::setInterval': 'gated-starter',
  'server/services/placement-chat-service.ts::module::setInterval': 'housekeeping', // sessions map
  'server/services/production-telemetry.ts::module::setInterval': 'housekeeping', // activeSessions map; logs only
  'server/services/proxy-startup-check.ts::isBaseUrlReachable::setTimeout': 'on-demand', // fetch timeout, read-only
  'server/services/scenario-image-generator.ts::startScenarioImageWorker::setTimeout': 'gated-starter',
  'server/services/session-compass-service.ts::module::setInterval': 'housekeeping', // cache TTL
  'server/services/session-monitor.ts::startSessionMonitor::setInterval': 'gated-starter',
  'server/services/shadow-auditor.ts::runShadowAudit::setTimeout': 'on-demand', // per live session
  'server/services/shared-lobe-snapshot.ts::startSharedLobeWatcher::setInterval': 'gated-starter',
  'server/services/sofia-issue-cleanup-worker.ts::startSofiaCleanupWorker::setTimeout': 'gated-starter',
  'server/services/sofia-issue-cleanup-worker.ts::startSofiaCleanupWorker::setInterval': 'gated-starter',
  'server/services/sophia-worker.ts::processDetectedIncidents::setTimeout': 'worker-internal',
  'server/services/sophia-worker.ts::startSophiaWorker::setInterval': 'gated-starter',
  'server/services/source-control-service.ts::resolveRenderReleaseEvidenceFromHealth::setTimeout': 'on-demand',
  'server/services/team-room-agent-worker.ts::scheduleNextPoll::setTimeout': 'worker-internal',
  'server/services/team-room-alden-service.ts::startTeamRoomAutoSaveWorker::setTimeout': 'gated-starter',
  'server/services/team-room-alden-service.ts::startTeamRoomAutoSaveWorker::setInterval': 'gated-starter',
  'server/services/voice-health-monitor.ts::startVoiceHealthMonitor::setTimeout': 'gated-starter',
  'server/services/voice-health-monitor.ts::startVoiceHealthMonitor::setInterval': 'gated-starter',
  'server/services/wren-security-audit-worker.ts::startSecurityAuditWorker::setTimeout': 'gated-starter',
  'server/services/wren-security-audit-worker.ts::startSecurityAuditWorker::setInterval': 'gated-starter',
  'server/unified-ws-handler.ts::armReconnectTimer::setTimeout': 'on-demand',
  'server/unified-ws-handler.ts::handleStreamingVoiceConnectionWithAdapter::setImmediate': 'on-demand',
  'server/ws-gateway.ts::handleStreamingVoiceConnection::setImmediate': 'on-demand',
};

test('every boot-time timer in server/ is classified, and the inventory has no stale entries', () => {
  const found = new Set(auditBootTimers().map((t) => `${t.file}::${t.scope}::${t.call}`));
  const unclassified = [...found].filter((key) => !(key in BOOT_TIMER_INVENTORY));
  const stale = Object.keys(BOOT_TIMER_INVENTORY).filter((key) => !found.has(key));
  assert.deepEqual(unclassified, [], 'classify these timers (and gate them if they start work at boot)');
  assert.deepEqual(stale, [], 'remove inventory entries whose timer no longer exists');
});

test('every gated-starter is only ever called from a gated region of index.ts', () => {
  const code = maskCode(INDEX_SOURCE);
  const ranges = gatedRanges(code);
  const starters = new Set(Object.entries(BOOT_TIMER_INVENTORY)
    .filter(([, cls]) => cls === 'gated-starter')
    .map(([key]) => key.split('::')[1]));
  for (const name of starters) {
    const calls = [...code.matchAll(new RegExp(`\\b${name}\\s*\\(`, 'g'))];
    assert.ok(calls.length > 0, `${name} is classified gated-starter but index.ts never calls it`);
    for (const call of calls) {
      assert.ok(ranges.some(([a, b]) => call.index! >= a && call.index! <= b), `${name} is called outside the gate`);
    }
  }
});
