import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import {
  beginCanonicalCaptureWorkerStartup,
  evaluateCanonicalCaptureHealth,
  evaluateCanonicalEpisodeProjectionHealth,
  getCanonicalCaptureWorkerReadiness,
  isCanonicalCaptureAvailable,
  markCanonicalCaptureWorkerArmed,
  resetCanonicalCaptureWorkerReadinessForTest,
} from '../services/canonical-capture-worker-readiness';

resetCanonicalCaptureWorkerReadinessForTest();

const stopped = getCanonicalCaptureWorkerReadiness();
assert.equal(stopped.phase, 'stopped');
assert.equal(stopped.armed, false);
assert.deepEqual(
  evaluateCanonicalCaptureHealth(true, stopped),
  { status: 503, ok: false },
  'capture health route contract must return 503 while the worker is stopped',
);
assert.equal(
  isCanonicalCaptureAvailable(true, stopped),
  false,
  'a writable workspace must not claim capture availability before the worker starts',
);

assert.equal(beginCanonicalCaptureWorkerStartup(100), true);
const arming = getCanonicalCaptureWorkerReadiness();
assert.equal(arming.phase, 'arming');
assert.equal(arming.armed, false);
assert.deepEqual(
  evaluateCanonicalCaptureHealth(true, arming),
  { status: 503, ok: false },
  'capture health route contract must return 503 while the worker is arming',
);
assert.equal(
  isCanonicalCaptureAvailable(true, arming),
  false,
  'capture readiness must remain unavailable while the worker is arming',
);
assert.equal(beginCanonicalCaptureWorkerStartup(150), false, 'worker startup must be idempotent');

markCanonicalCaptureWorkerArmed(200);
const armed = getCanonicalCaptureWorkerReadiness();
assert.equal(armed.phase, 'armed');
assert.equal(armed.armed, true);
assert.equal(armed.startedAt, 100);
assert.equal(armed.armedAt, 200);
assert.deepEqual(
  evaluateCanonicalCaptureHealth(true, armed),
  { status: 200, ok: true },
  'capture health route contract must return 200 once the worker and workspace are ready',
);
assert.deepEqual(
  evaluateCanonicalCaptureHealth(false, armed),
  { status: 503, ok: false },
  'capture health route contract must return 503 when the workspace is unavailable',
);
assert.equal(isCanonicalCaptureAvailable(true, armed), true);
assert.equal(isCanonicalCaptureAvailable(false, armed), false);

console.log('PASS: capture route returns 503 until the canonical recorder is armed, then 200 only with a writable workspace.');

const enabled = {
  liveModeRequested: true,
  episodeWritesEnabled: true,
  routingValidated: true,
};
assert.equal(evaluateCanonicalEpisodeProjectionHealth(enabled, 0).state, 'unverified');
assert.equal(evaluateCanonicalEpisodeProjectionHealth(enabled, 1).state, 'pending');
const disabled = evaluateCanonicalEpisodeProjectionHealth(
  { ...enabled, liveModeRequested: false }, 0,
);
assert.equal(disabled.state, 'disabled');
assert.ok(disabled.reasons.includes('live-mode-not-requested'));
assert.equal(evaluateCanonicalEpisodeProjectionHealth(
  { ...enabled, episodeWritesEnabled: false }, 0,
).state, 'disabled');
assert.equal(evaluateCanonicalEpisodeProjectionHealth(
  { ...enabled, routingValidated: false }, 0,
).state, 'blocked');
for (const count of [null, -1, NaN, Infinity, 0.5]) {
  const result = evaluateCanonicalEpisodeProjectionHealth(enabled, count);
  assert.equal(result.state, 'blocked');
  assert.deepEqual(result.queue, {
    available: false, pendingMirrors: null, directoryPresent: null,
  });
  assert.ok(result.reasons.includes('mirror-queue-unavailable'));
}
for (const liveModeRequested of [false, true]) {
  for (const episodeWritesEnabled of [false, true]) {
    for (const routingValidated of [false, true]) {
      for (const count of [null, 0, 1]) {
        const gates = { liveModeRequested, episodeWritesEnabled, routingValidated };
        const result = evaluateCanonicalEpisodeProjectionHealth(gates, count);
        assert.equal(result.episodeCompletionProven, false);
        assert.equal(result.evidenceScope, 'runtime-gates-and-queue-only');
        assert.deepEqual(result.gates, gates);
      }
    }
  }
}
console.log('PASS: projection diagnostics distinguish disabled, blocked and pending; an empty queue never proves episode completion.');

const target = {
  resolution: 'resolved' as const,
  filename: 'episode-35.md',
  pinnedTargetSet: true,
  misrouteAlertActive: false,
};
for (const outboxDirectoryPresent of [false, true]) {
  const snapshot = evaluateCanonicalEpisodeProjectionHealth(enabled, 0, {
    outboxDirectoryPresent, target,
  });
  assert.equal(snapshot.queue.directoryPresent, outboxDirectoryPresent);
  assert.equal(snapshot.queue.pendingMirrors, 0);
  assert.deepEqual(snapshot.target, target);
  assert.equal(snapshot.state, 'unverified');
  assert.equal(snapshot.episodeCompletionProven, false);
}
const blockedTarget = evaluateCanonicalEpisodeProjectionHealth(
  { ...enabled, routingValidated: false }, 0, {
    outboxDirectoryPresent: false,
    target: { ...target, resolution: 'blocked', filename: null, misrouteAlertActive: true },
  },
);
assert.equal(blockedTarget.state, 'blocked');
assert.equal(blockedTarget.target?.filename, null);
assert.equal(blockedTarget.target?.misrouteAlertActive, true);
console.log('PASS: absent versus empty outbox, target, pinned override and misroute signals remain distinguishable.');

// Execute the actual route closure without importing the application, opening
// database connections or starting workers. Inspect the AST, not a comment-
// blind substring, to retain the route's authentication middleware contract.
const routeSource = ts.createSourceFile(
  'routes.ts', readFileSync(new URL('../routes.ts', import.meta.url), 'utf8'),
  ts.ScriptTarget.Latest, true,
);
let routeCall: ts.CallExpression | undefined;
function findHealthRoute(node: ts.Node): void {
  if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) &&
      node.expression.expression.getText(routeSource) === 'app' &&
      node.expression.name.text === 'get' && ts.isStringLiteral(node.arguments[0]) &&
      node.arguments[0].text === '/api/internal/canonical-conversation-health') {
    assert.equal(routeCall, undefined, 'health route must be registered exactly once');
    routeCall = node;
  }
  ts.forEachChild(node, findHealthRoute);
}
findHealthRoute(routeSource);
assert.ok(routeCall, 'actual health route must exist');
assert.equal(routeCall.arguments.length, 3);
assert.equal(routeCall.arguments[1].getText(routeSource), 'requireCoordinationAuth');
const compiled = ts.transpileModule(
  `module.exports = (${routeCall.arguments[2].getText(routeSource)});`,
  { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } },
).outputText;

async function exerciseRoute(options: {
  actor?: string; armed?: boolean; directoryPresent?: boolean; unreadableQueue?: boolean;
  pending?: number; liveModeRequested?: boolean; routingValidated?: boolean;
} = {}) {
  const armed = options.armed ?? true;
  const imports: string[] = [];
  const gates = { ...enabled,
    liveModeRequested: options.liveModeRequested ?? true,
    routingValidated: options.routingValidated ?? true,
  };
  const modules: Record<string, unknown> = {
    './services/transcript-parser': {
      CHAT_CAPTURE_PATH: 'capture', CHAT_CAPTURE_CURSOR_PATH: 'cursor',
      CHAT_CAPTURE_ACK_CURSOR_PATH: 'ack',
      loadChatCaptureCursor: () => ({ byteOffset: 50 }),
    },
    './services/workspace-root': { inspectCaptureWorkspace: () => ({
      rootSource: 'fixture', localDirectoryPresent: true, localDirectoryWritable: true,
    }) },
    './services/canonical-capture-worker-readiness': {
      evaluateCanonicalCaptureHealth, evaluateCanonicalEpisodeProjectionHealth,
      getCanonicalCaptureWorkerReadiness: () => ({ ...stopped, armed }),
    },
    fs: {
      existsSync: (path: string) => path !== 'outbox' || (options.directoryPresent ?? true),
      statSync: () => ({ size: 50 }),
    },
    './services/historical-attribution-status': {
      historicalAttributionCaptureHealth: (health: object) => ({
        ...health, historicalRecovery: { paused: false },
      }),
    },
    './services/agent-session-autosave': {
      getCanonicalEpisodeProjectionGates: () => gates,
      getCanonicalEpisodeProjectionTarget: async () => ({
        ...target,
        resolution: gates.routingValidated ? 'resolved' : 'blocked',
        filename: gates.routingValidated ? target.filename : null,
      }),
    },
    './services/episode-mirror-outbox': {
      EPISODE_MIRROR_OUTBOX_PATH: 'outbox',
      listEpisodeMirrorOutbox: () => {
        if (options.unreadableQueue) throw new Error('PRIVATE-FIXTURE-PATH-AND-CONTENT');
        return Array.from({ length: options.pending ?? 0 }, () => ({}));
      },
    },
  };
  const module = { exports: undefined as any };
  runInNewContext(compiled, {
    module, console: { error() {} },
    require: (name: string) => {
      imports.push(name);
      assert.ok(Object.hasOwn(modules, name), `unexpected runtime import: ${name}`);
      return modules[name];
    },
  });
  let status = 200;
  let body: any;
  const response = {
    status(code: number) { status = code; return response; },
    json(value: unknown) { body = value; return response; },
  };
  await module.exports({ coordinationActor: options.actor ?? 'luca-replit' }, response);
  return { status, body, imports };
}
const denied = await exerciseRoute({ actor: 'alden' });
assert.equal(denied.status, 403);
assert.equal(denied.imports.length, 0);
const notInspected = await exerciseRoute({ armed: false });
assert.equal(notInspected.status, 503);
assert.equal(notInspected.body.capture.projection.state, 'not-inspected');
assert.ok(!notInspected.imports.includes('./services/agent-session-autosave'));
for (const options of [
  {}, { directoryPresent: false }, { liveModeRequested: false },
  { pending: 2 }, { unreadableQueue: true }, { routingValidated: false },
]) {
  const result = await exerciseRoute(options);
  assert.equal(result.status, 200, 'source-health compatibility must be preserved');
  const projection = result.body.capture.projection;
  assert.equal(projection.episodeCompletionProven, false);
  assert.ok(!JSON.stringify(result.body).includes('PRIVATE-FIXTURE'));
  if ('directoryPresent' in options) assert.equal(projection.queue.directoryPresent, false);
  if ('liveModeRequested' in options) assert.equal(projection.state, 'disabled');
  if ('pending' in options) assert.equal(projection.state, 'pending');
  if ('unreadableQueue' in options || 'routingValidated' in options) {
    assert.equal(projection.state, 'blocked');
  }
}
console.log('PASS: actual authenticated health route preserves source status, skips stopped-worker imports, and redacts queue failures.');
