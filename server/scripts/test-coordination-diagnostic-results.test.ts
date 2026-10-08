import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, copyFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

const engine = process.platform === 'win32' ? 'powershell.exe' : 'pwsh';
const available = spawnSync(engine, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', 'exit 0'],
  { timeout: 10_000 }).status === 0;
const fixture = resolve('scripts/test-hola-coordinator-recovery-diagnostics.ps1');
const bootstrap = "$PSModuleAutoLoadingPreference = 'None'; " +
  "foreach ($m in @('Utility','Management')) { Import-Module ([IO.Path]::Combine($PSHOME,'Modules'," +
  "'Microsoft.PowerShell.'+$m,'Microsoft.PowerShell.'+$m+'.psd1')) }; ";
const prefix = '[coordinator-v2] diagnostic-result ';
type Result = { case: string; status: string; passedCases?: number;
  checks?: Array<{ name: string; status: string } | string> };

function run(path: string, skip: boolean) {
  const command = bootstrap + "& '" + path.replaceAll("'", "''") + "'" +
    (skip ? ' -SkipMutationChecks' : '');
  const root = mkdtempSync(join(tmpdir(), 'hola-diagnostic-env-'));
  // No credentials or real runtime cache in the synthetic child's environment.
  const env: NodeJS.ProcessEnv = { LOCALAPPDATA: join(root, 'local-app-data') };
  for (const key of ['PATH', 'HOME', 'USERPROFILE', 'SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT',
    'TEMP', 'TMP', 'TMPDIR', 'LANG', 'LC_ALL'])
    if (process.env[key] !== undefined) env[key] = process.env[key];
  try {
    const child = spawnSync(engine, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand',
      Buffer.from(command, 'utf16le').toString('base64')],
    { timeout: 120_000, encoding: 'utf8', maxBuffer: 2_000_000, env });
    assert.ifError(child.error);
    const output = child.stdout + child.stderr;
    assert.doesNotMatch(output, /SYNTHETIC_SECRET_NEVER_REPORT_75319|CHILD_ERROR_CANARY/);
    const results = child.stdout.split(/\r?\n/).filter(line => line.startsWith(prefix))
      .map(line => JSON.parse(line.slice(prefix.length)) as Result);
    assert.ok(results.length, 'fixture stopped before emitting any diagnostic results');
    return { status: child.status, results };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function expectedBaseline() {
  const ids: string[] = [];
  const captures = ['error-details', 'legacy-stream'];
  for (const name of ['generation-conflict', 'pending-conflict', 'enrollment-revoked', 'founder-required',
    'database-unavailable', 'unknown-code', 'lowercase-code', 'numeric-code', 'null-code', 'null-error',
    'null-root', 'empty-array', 'root-array', 'malformed-json', 'html', 'oversized']) {
    for (const mode of captures) ids.push(`recovery/${name}/${mode}`);
  }
  for (const name of ['string', 'negative', 'success', 'out-of-range', 'null', 'boolean', 'sentinel'])
    ids.push(`recovery/invalid-http/${name}`);
  ids.push('recovery/broken-stream', 'recovery/unknown-guidance');
  for (const name of ['Timeout', 'ConnectFailure', 'TrustFailure']) ids.push(`recovery/transport/${name}`);
  const codes = ['BOOTSTRAP_REQUIRED', 'BOOTSTRAP_DENIED', 'BOOTSTRAP_UNAVAILABLE', 'BOOTSTRAP_CONSUMED',
    'FOUNDER_REQUIRED', 'IDEMPOTENCY_CONFLICT', 'REQUEST_NOT_FOUND', 'REQUEST_EXPIRED', 'REQUEST_TERMINAL',
    'CHALLENGE_INVALID', 'CHALLENGE_EXPIRED', 'PROOF_INVALID', 'INVALID_REQUEST', 'PROTOCOL_MISMATCH',
    'SOURCE_PROMOTION_REQUIRED', 'DATABASE_UNAVAILABLE'].map(code => `V2_HOST_${code}`);
  for (const code of codes) {
    ids.push(`enrollment/ordinal-guidance/${code}`);
    for (const casing of ['exact', 'lowercase', 'mixed-case'])
      for (const mode of captures) ids.push(`enrollment/${code}/${casing}/${mode}`);
  }
  for (const name of ['recovery-generation-code', 'recovery-pending-code', 'suffixed-code', 'unknown-code',
    'numeric-code', 'array-code', 'object-code', 'null-code', 'null-error', 'array-error', 'empty-object',
    'null-root', 'empty-array', 'root-array', 'string-root', 'malformed-json', 'html', 'empty-body',
    'oversized', 'body-boundary-4096', 'body-boundary-4097'])
    for (const mode of captures) ids.push(`enrollment/${name}/${mode}`);
  for (const status of [403, 400, 599]) ids.push(`enrollment/typed-http/${status}`);
  for (const name of ['string', 'negative', 'success', 'out-of-range', 'null', 'boolean', 'floating-point', 'sentinel'])
    ids.push(`enrollment/invalid-http/${name}`);
  for (const name of ['Timeout', 'NameResolutionFailure', 'ConnectFailure', 'TrustFailure',
    'SecureChannelFailure', 'UnknownError']) ids.push(`enrollment/transport/${name}`);
  for (const name of ['missing', 'exception-only', 'object-body']) ids.push(`enrollment/malformed-metadata/${name}`);
  ids.push('enrollment/broken-stream', 'enrollment/unknown-guidance', 'enrollment/recovery-guidance-exclusion',
    'local/recognized-failure', 'local/unexpected-failure', 'local/transport-failure');
  return ids.sort();
}

test('diagnostic output identifies every baseline, timeout, mutation and control without raw values',
  { skip: !available }, () => {
    const { status, results } = run(fixture, false);
    assert.equal(status, 0);
    assert.equal(new Set(results.map(r => r.case)).size, results.length, 'duplicate result IDs');
    const expected = expectedBaseline();
    const baseline = results.filter(r => expected.includes(r.case));
    assert.deepEqual(baseline.map(r => r.case).sort(), expected);
    assert.equal(baseline.length, 224);
    let assertions = 0;
    for (const result of baseline) {
      assert.equal(result.status, 'PASS');
      assert.ok(result.checks?.length);
      const names = new Set<string>();
      for (const check of result.checks!) {
        assert.equal(typeof check, 'object');
        if (typeof check === 'string') throw new Error('baseline assertion lacks outcome');
        assert.equal(check.status, 'PASS');
        assert.match(check.name, /^[a-z0-9-]+$/);
        assert.ok(!names.has(check.name), 'duplicate assertion ID');
        names.add(check.name);
        assertions++;
      }
    }
    assert.equal(assertions, 935);
    assert.equal(results.find(r => r.case === 'baseline-suite')?.passedCases, expected.length);
    for (const id of ['timeout/owned-child', 'timeout/owned-temp-cleanup', 'timeout/source-preservation',
      'mutation/owned-temp-cleanup', 'mutation/source-preservation', 'mutation-suite', 'complete-suite'])
      assert.equal(results.find(r => r.case === id)?.status, 'PASS', id);
    for (const name of ['raw-response', 'raw-exception', 'case-insensitive-guidance', 'root-array', 'unmodified']) {
      const modes = ['native-parser'];
      if (name === 'root-array' || name === 'unmodified') modes.push('preserved-array-parser');
      for (const mode of modes)
        assert.equal(results.find(r => r.case === `mutation/${name}/${mode}`)?.status, 'PASS');
    }
    assert.equal(results.filter(r => r.status === 'FAIL').length, 0);
    assert.deepEqual(results.filter(r => r.status === 'SKIP').map(r => r.case), ['timeout/mutation-suite']);
  });

test('explicitly skipped mutations never acquire a complete-suite PASS', { skip: !available }, () => {
  const { status, results } = run(fixture, true);
  assert.equal(status, 0);
  assert.equal(results.find(r => r.case === 'mutation-suite')?.status, 'SKIP');
  assert.ok(!results.some(r => r.case === 'complete-suite'));
  assert.ok(!results.some(r => r.case.startsWith('mutation/') || r.case.startsWith('timeout/')));
});

test('a failed assertion names its case and check without claiming later checks or overall success',
  { skip: !available }, () => {
    const root = mkdtempSync(join(tmpdir(), 'hola-diagnostic-report-'));
    try {
      copyFileSync(resolve('scripts/hola-coordinator.ps1'), join(root, 'hola-coordinator.ps1'));
      const text = readFileSync(fixture, 'utf8');
      const needle = "Assert-Diagnostic ($detail -match ('reason=' + $case.reason + ';'))";
      assert.equal(text.split(needle).length, 2, 'fault injection must target exactly one assertion');
      const changed = join(root, 'test-hola-coordinator-recovery-diagnostics.ps1');
      writeFileSync(changed, text.replace(needle, 'Assert-Diagnostic $false'));
      const { status, results } = run(changed, true);
      assert.notEqual(status, 0);
      assert.deepEqual(results, [{
        case: 'recovery/generation-conflict/error-details', status: 'FAIL',
        checks: [{ name: 'reason-allowlist', status: 'FAIL' }],
      }]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
