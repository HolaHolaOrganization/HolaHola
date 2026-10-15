#!/usr/bin/env npx tsx
/**
 * test-alden-dual-engine-self-report.ts
 *
 * Regression guard for the dual-engine self-misreport bug (task #1631): when
 * Alden was consulted with engines: 'both', the Anthropic-labeled branch
 * opened its response with "I am currently running as Gemini." Root cause:
 * the get_current_engine tool (server/services/alden-functions.ts) read the
 * global alden_config DB row unconditionally and reported that as "your
 * conversational engine" -- ignoring which engine was actually answering
 * THIS specific call. Both engines share the same tool declaration, so
 * whichever branch of a dual-engine call happened to invoke
 * get_current_engine could be told it was running as the OTHER engine
 * whenever the saved global default didn't match its own engineOverride.
 *
 * The fix threads the actual per-call engine into executeAldenTool's
 * context ({ engine: 'anthropic' | 'gemini' }), hardcoded at each call site
 * to the literal engine that call site is known to run on --
 * generateAldenResponseAnthropic always passes 'anthropic',
 * generateAldenResponseGemini always passes 'gemini', and the
 * Anthropic-only watch worker always passes 'anthropic'. get_current_engine
 * now reports context?.engine as authoritative for "engine", falling back
 * to the DB's configuredDefault only when no override context is given
 * (the normal single-engine chat path, out of scope for this fix).
 *
 * Three layers:
 *   1. Behavioral -- calls executeAldenTool('get_current_engine', ...)
 *      in-process with each engine context (read-only; never writes
 *      alden_config) and confirms the reported 'engine' field always
 *      matches the requested context, never collapsing both branches to
 *      the same value.
 *   2. Static source guards -- confirm each real call site (Anthropic
 *      persona branch, Gemini persona branch, both watch-worker call
 *      sites) hardcodes its own literal engine into executeAldenTool's
 *      context, and that get_current_engine's handler actually consults it.
 *   3. --self-check -- reintroduces the exact historical bug (engine
 *      resolved purely from the DB default, ignoring context) into
 *      alden-functions.ts, proves both the static guard and a fresh
 *      spawned process's behavior flip as expected, then restores the file
 *      byte-for-byte.
 *
 * Usage:
 *   npx tsx server/scripts/test-alden-dual-engine-self-report.ts
 *   npx tsx server/scripts/test-alden-dual-engine-self-report.ts --self-check
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';
import { executeAldenTool } from '../services/alden-functions';

const root = resolve(import.meta.dirname, '../..');
const aldenFunctionsPath = resolve(root, 'server/services/alden-functions.ts');
const personaServicePath = resolve(root, 'server/services/alden-persona-service.ts');
const watchWorkerPath = resolve(root, 'server/services/alden-watch-worker.ts');
const driverPath = resolve(root, 'server/scripts/test-alden-dual-engine-self-report-driver.ts');

const CANONICAL_ENGINE_LINE = 'const engine = context?.engine ?? configuredDefault;';
const MUTANT_ENGINE_LINE = 'const engine = configuredDefault;';

// Inspect live syntax, not formatting or comments. Unrelated context fields
// (such as reviewReadSession) must not invalidate the engine contract.
function parseSource(source: string): ts.SourceFile {
  return ts.createSourceFile('engine-guard.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

function assertContextEngineType(source: string): void {
  const file = parseSource(source);
  const declaration = file.statements.find((node): node is ts.FunctionDeclaration =>
    ts.isFunctionDeclaration(node) && node.name?.text === 'executeAldenTool');
  const context = declaration?.parameters.find(node => node.name.getText(file) === 'context');
  assert.ok(context?.questionToken && context.type && ts.isTypeLiteralNode(context.type),
    'executeAldenTool must declare its optional context object');
  const engines = context.type.members.filter((node): node is ts.PropertySignature =>
    ts.isPropertySignature(node) && node.name.getText(file) === 'engine');
  assert.equal(engines.length, 1, 'context must declare exactly one engine field');
  const engine = engines[0];
  assert.ok(engine.questionToken && engine.type && ts.isUnionTypeNode(engine.type),
    'context must accept an optional engine union');
  assert.deepEqual(engine.type.types.map(node => {
    assert.ok(ts.isLiteralTypeNode(node) && ts.isStringLiteral(node.literal),
      'context engine types must be string literals');
    return node.literal.text;
  }).sort(), ['anthropic', 'gemini'], 'context must accept precisely the two conversational engines');
}

function assertCallEngines(source: string, expected: 'anthropic' | 'gemini', functionName?: string): void {
  const file = parseSource(source);
  const scope = functionName
    ? file.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === functionName)
    : file;
  assert.ok(scope, `missing engine branch ${functionName}`);
  let count = 0;
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) &&
        node.expression.text === 'executeAldenTool') {
      count++;
      const context = node.arguments[2];
      assert.ok(context && ts.isObjectLiteralExpression(context),
        'each tool call must pass an explicit context object');
      assert.ok(!context.properties.some(ts.isSpreadAssignment),
        'tool context spreads could override the literal engine');
      assert.ok(context.properties.every(node =>
        (ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node)) &&
        !ts.isComputedPropertyName(node.name)),
      'tool context keys must be explicit; computed keys or accessors could replace the engine');
      const engines = context.properties.filter(node =>
        ts.isPropertyAssignment(node) &&
        ((ts.isIdentifier(node.name) || ts.isStringLiteral(node.name)) && node.name.text === 'engine'));
      assert.equal(engines.length, 1, 'each tool call must pin exactly one engine');
      const engine = engines[0];
      assert.ok(ts.isPropertyAssignment(engine) && ts.isStringLiteral(engine.initializer),
        'tool engine must be a literal, not a shared/default lookup');
      assert.equal(engine.initializer.text, expected, 'tool engine must match its calling branch');
    }
    ts.forEachChild(node, visit);
  };
  visit(scope);
  assert.ok(count > 0, `no guarded tool calls found in ${functionName ?? 'watch worker'}`);
}

function assertStructuralGuardControls(): void {
  const signature = "export async function executeAldenTool(context?: { conversationId?: string; engine?: 'anthropic' | 'gemini'; reviewReadSession?: unknown }) {}";
  assertContextEngineType(signature);
  for (const mutant of [
    signature.replace("engine?: 'anthropic' | 'gemini';", ''),
    signature.replace("'gemini'", "'other'"),
    signature.replace('engine?:', 'engine:'),
  ]) assert.throws(() => assertContextEngineType(`// ${signature}\n${mutant}`));
  const call = "function branch() { executeAldenTool('tool', {}, { conversationId, engine: 'anthropic', reviewReadSession }); }";
  assertCallEngines(call, 'anthropic', 'branch');
  for (const mutant of [
    call.replace("engine: 'anthropic',", ''),
    call.replace("engine: 'anthropic'", "engine: 'gemini'"),
    call.replace("engine: 'anthropic'", 'engine: configuredDefault'),
    call.replace("engine: 'anthropic'", "engine: 'anthropic', ...override"),
    call.replace("engine: 'anthropic'", "engine: 'anthropic', ['engine']: 'gemini'"),
  ]) assert.throws(() => assertCallEngines(`// ${call}\n${mutant}`, 'anthropic', 'branch'));
  assert.throws(() => assertCallEngines(call.replace("reviewReadSession });",
    "reviewReadSession }); executeAldenTool('second', {}, {});"), 'anthropic', 'branch'));
  console.log('  ✓ structural negative controls reject missing/wrong/default engines, overrides and misleading comments');
}

// ── Layer 1: behavioral — in-process, read-only (get_current_engine never
// writes alden_config, so this is safe against the live shared database) ───

async function assertBehavioralIsolation(): Promise<void> {
  const anthropicResult = await executeAldenTool('get_current_engine', {}, { engine: 'anthropic' });
  const geminiResult = await executeAldenTool('get_current_engine', {}, { engine: 'gemini' });
  const noOverrideResult = await executeAldenTool('get_current_engine', {});

  assert.equal(
    anthropicResult.data.engine,
    'anthropic',
    `get_current_engine must report 'anthropic' when called with { engine: 'anthropic' } context, got: ${JSON.stringify(anthropicResult.data)}`,
  );
  assert.equal(
    geminiResult.data.engine,
    'gemini',
    `get_current_engine must report 'gemini' when called with { engine: 'gemini' } context, got: ${JSON.stringify(geminiResult.data)}`,
  );
  assert.notEqual(
    anthropicResult.data.engine,
    geminiResult.data.engine,
    'the two engine-context calls must not collapse to the same reported engine -- this is exactly the cross-labeling bug from task #1631',
  );
  assert.equal(
    typeof anthropicResult.data.configuredDefault,
    'string',
    'get_current_engine must still surface the DB configured default under its own (distinct) field',
  );
  assert.equal(
    anthropicResult.data.configuredDefault,
    geminiResult.data.configuredDefault,
    'the shared DB default must read identically regardless of which engine override was requested -- get_current_engine must never mutate alden_config',
  );
  assert.equal(
    noOverrideResult.data.engine,
    noOverrideResult.data.configuredDefault,
    'without an engine override (normal single-engine chat, out of scope for this fix), the reported engine must still mirror the saved default',
  );

  console.log("  ✓ get_current_engine reports the per-call engine override, never the shared DB default");
}

// ── Layer 2: static source guards ───────────────────────────────────────────

function assertEngineResolutionGuard(source: string, { expectFixed }: { expectFixed: boolean }): void {
  if (expectFixed) {
    assert.ok(
      source.includes(CANONICAL_ENGINE_LINE),
      "alden-functions.ts must resolve get_current_engine's reported engine as `context?.engine ?? configuredDefault`",
    );
  } else {
    assert.ok(
      !source.includes(CANONICAL_ENGINE_LINE),
      'expected the reintroduced mutant line to remove the canonical context-aware resolution -- update this self-check if the mutation shape changed',
    );
    assert.ok(
      source.includes(MUTANT_ENGINE_LINE),
      'expected the mutant source to contain the reintroduced DB-only resolution line',
    );
  }
}

function assertStaticGuards(aldenFunctionsSource: string): void {
  assertEngineResolutionGuard(aldenFunctionsSource, { expectFixed: true });
  assertContextEngineType(aldenFunctionsSource);

  const personaSource = readFileSync(personaServicePath, 'utf8');
  assertCallEngines(personaSource, 'anthropic', 'generateAldenResponseAnthropic');
  assertCallEngines(personaSource, 'gemini', 'generateAldenResponseGemini');

  const watchWorkerSource = readFileSync(watchWorkerPath, 'utf8');
  assertCallEngines(watchWorkerSource, 'anthropic');
  assertStructuralGuardControls();

  console.log("  ✓ each real call site hardcodes its own literal engine into executeAldenTool's context");
}

// ── Layer 3: --self-check ────────────────────────────────────────────────────

interface DriverRun {
  exitCode: number | null;
  output: string;
  data: Record<string, any> | null;
}

function runDriver(engine: 'anthropic' | 'gemini'): DriverRun {
  const run = spawnSync('npx', ['tsx', driverPath, engine], {
    cwd: root,
    env: { ...process.env },
    encoding: 'utf8',
    timeout: 120_000,
  });
  const output = `${run.stdout ?? ''}${run.stderr ?? ''}`;
  const match = /RESULTS:(\{.*\})/.exec(output);
  return {
    exitCode: run.status,
    output,
    data: match ? JSON.parse(match[1]) : null,
  };
}

async function assertRegressionGuard(): Promise<void> {
  console.log('\n[alden-dual-engine-self-report] Static + behavioral guards against the current (fixed) source:\n');
  const aldenFunctionsSource = readFileSync(aldenFunctionsPath, 'utf8');
  assertStaticGuards(aldenFunctionsSource);
  await assertBehavioralIsolation();
  console.log(
    '\n[alden-dual-engine-self-report] PASS: get_current_engine reports the per-call engine override; ' +
    'both persona branches and the watch worker hardcode their own literal engine.\n',
  );
}

async function selfCheck(): Promise<void> {
  console.log("\n[self-check] Proving this guard catches the historical dual-engine self-report bug...\n");

  const originalBytes = readFileSync(aldenFunctionsPath);
  const originalSource = originalBytes.toString('utf8');

  assert.equal(
    originalSource.split(CANONICAL_ENGINE_LINE).length - 1,
    1,
    'Expected exactly one canonical engine-resolution line to mutate -- update this self-check if get_current_engine was intentionally restructured',
  );

  const mutantSource = originalSource.replace(CANONICAL_ENGINE_LINE, MUTANT_ENGINE_LINE);
  assert.notEqual(mutantSource, originalSource, 'Mutation did not change alden-functions.ts');

  // Prove the static guard's own pattern flips correctly on the mutant
  // before touching disk -- if this fails, the guard itself is broken.
  assertEngineResolutionGuard(mutantSource, { expectFixed: false });

  try {
    writeFileSync(aldenFunctionsPath, mutantSource);

    // Behavioral proof: fresh processes loading the mutated file must now
    // collapse BOTH distinct engine requests to the same DB-default value --
    // exactly the historical cross-labeling bug. Comparing the two driver
    // runs against each other (rather than asserting a specific engine
    // string) keeps this deterministic regardless of whatever the live
    // alden_config default currently happens to be.
    const runAnthropic = runDriver('anthropic');
    const runGemini = runDriver('gemini');

    assert.equal(runAnthropic.exitCode, 0, `driver failed (engine=anthropic) against the mutated source -- output:\n${runAnthropic.output}`);
    assert.equal(runGemini.exitCode, 0, `driver failed (engine=gemini) against the mutated source -- output:\n${runGemini.output}`);
    assert.ok(runAnthropic.data, `anthropic driver run produced no RESULTS line -- output:\n${runAnthropic.output}`);
    assert.ok(runGemini.data, `gemini driver run produced no RESULTS line -- output:\n${runGemini.output}`);

    assert.equal(
      runAnthropic.data!.engine,
      runGemini.data!.engine,
      'expected the mutated get_current_engine to collapse both distinct engine requests to the same ' +
      `DB-default value, but got anthropic=${JSON.stringify(runAnthropic.data)} gemini=${JSON.stringify(runGemini.data)} -- ` +
      'the mutation may not have reproduced the historical bug shape',
    );

    console.log(
      '\n[alden-dual-engine-self-report] SELF-CHECK PASS: reintroducing the historical bug (engine ' +
      'resolved purely from the DB default, ignoring the per-call context) is caught by both the ' +
      'static guard and a live behavioral check against two fresh spawned processes.\n',
    );
  } finally {
    writeFileSync(aldenFunctionsPath, originalBytes);
    assert.deepEqual(
      readFileSync(aldenFunctionsPath),
      originalBytes,
      'Failed to restore alden-functions.ts byte-for-byte after mutation',
    );
  }
}

const isSelfCheck = process.argv.includes('--self-check');
// Importing alden-functions.ts opens a DB pool (server/db.ts) at import time
// whose idle timer/socket is never unref'd, so the event loop would
// otherwise hang until that idle timeout fires even after every assertion
// has already passed -- exit explicitly on both branches (see
// .agents/memory/pg-pool-idle-timeout-ci-hang.md).
(isSelfCheck ? selfCheck() : assertRegressionGuard())
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
