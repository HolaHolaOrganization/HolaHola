import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import './gate3-historical-integrity.test.mjs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { test } from 'node:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { build } from 'esbuild';
import { createHash } from 'node:crypto';

const launcherPath = 'scripts/antigravity-gate3.ps1';
const runbookPath = 'docs/antigravity-gate3-runbook.md';

const read = (path: string) => readFile(path, 'utf8');
function assertLiveBundlePin(launcher: string, variable: string, actual: string) {
  const pins = [...launcher.matchAll(new RegExp(`^\\$${variable}BundleSha256 = '([a-f0-9]{64})'\\r?$`, 'gm'))];
  assert.equal(pins.length, 1, `${variable} must have exactly one live pin assignment`);
  assert.equal(actual, pins[0][1], `${variable} current source must match its live launcher pin`);
}
const execFile = promisify(execFileCallback);
type CurrentBundleResult = { code: number | undefined; stderr: string };
const currentBundleEnvironment = (parent: NodeJS.ProcessEnv = process.env) => Object.fromEntries(
  ['PATH', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP'].flatMap((key) =>
    parent[key] === undefined ? [] : [[key, parent[key]!]]),
);

function assertCurrentFailure(name: 'prepare' | 'run', result: CurrentBundleResult) {
  assert.equal(result.code, 1, `${name} CURRENT-source entrypoint must fail closed with exit 1`);
  assert.match(result.stderr, name === 'prepare'
    ? /^antigravity_provisioning_failed\r?$/m : /^antigravity_runtime_failed\r?$/m);
}

async function executeCurrentBundle(name: 'prepare' | 'run', output: string): Promise<CurrentBundleResult> {
  return execFile(process.execPath, [
    output, ...(name === 'prepare' ? ['--starting-commit', 'a'.repeat(40)] : []),
  ], {
    // Never forward real bootstrap, ownership, server or application secrets
    // into the CURRENT-source smoke check. Archived bundles are not executed.
    env: currentBundleEnvironment(),
    timeout: 10_000,
  }).then(
    (result) => ({ code: 0, stderr: result.stderr }),
    (error: NodeJS.ErrnoException & { code?: number; stderr?: string }) => ({
      code: error.code, stderr: error.stderr ?? '',
    }),
  );
}

test('CURRENT-source smoke child environment excludes credentials, loader injection and host stores', () => {
  assert.deepEqual(currentBundleEnvironment({
    PATH: '/safe/bin', SystemRoot: 'C:\\Windows', TEMP: '/safe/tmp',
    COORDINATION_RUNTIME_BOOTSTRAP_TOKEN: 'synthetic-not-a-credential',
    COORDINATION_API_BASE_URL: 'https://must-not-be-contacted.invalid',
    NODE_OPTIONS: '--require=untrusted-loader.cjs',
    HOME: '/must-not-open-host-store', APPDATA: 'C:\\must-not-open-host-store',
    NEON_SHARED_DATABASE_URL: 'synthetic-not-a-connection',
  }), { PATH: '/safe/bin', SystemRoot: 'C:\\Windows', TEMP: '/safe/tmp' });
});

test('Windows DPAPI launcher has a fixed action and command boundary', async () => {
  const source = await read(launcherPath);

  assert.match(source, /ValidateSet\('initialize', 'prepare', 'run', 'status'\)/);
  assert.match(source, /\$ApprovedWorktree = 'C:\\Users\\David\\HolaHola-antigravity'/);
  assert.match(source, /\$startInfo\.FileName = \$script:ApprovedNodePath/);
  assert.match(source, /Get-AuthenticodeSignature -LiteralPath \$nodePath/);
  assert.match(source, /\$version\.ProductName -ne 'Node\.js'/);
  assert.match(source, /Assert-ApprovedNode -ExpectedPath/);
  assert.doesNotMatch(source, /\$startInfo\.FileName = ['"](?:node|npx)(?:\.exe|\.cmd)?['"]/i);
  assert.doesNotMatch(source, /node_modules\/tsx\/dist\/cli\.mjs/);
  assert.doesNotMatch(source, /Invoke-Expression|iex\b|Start-Job|ScriptBlock|EncodedCommand/i);
  assert.doesNotMatch(source, /\[(?:string|object)\]\s*\$(?:Command|Executable|ChildCommand|ArgumentsFromUser)\b/i);
});

test('Windows runtime loads System.Security before resolving ProtectedData', async () => {
  const source = await read(launcherPath);
  const start = source.indexOf('function Assert-WindowsRuntime');
  const end = source.indexOf('function Assert-NoFixedActorTokens', start);
  assert.ok(start >= 0 && end > start, 'Assert-WindowsRuntime must have a bounded source section');
  const runtimeGuard = source.slice(start, end);

  const assemblyLoadAt = runtimeGuard.indexOf('Add-Type -AssemblyName System.Security -ErrorAction Stop');
  const protectedDataCheckAt = runtimeGuard.indexOf(
    "'System.Security.Cryptography.ProtectedData' -as [type]",
  );
  assert.ok(assemblyLoadAt >= 0, 'must explicitly load the exact System.Security assembly');
  assert.ok(protectedDataCheckAt > assemblyLoadAt, 'assembly load must precede the ProtectedData type check');
  assert.match(
    runtimeGuard,
    /if \(\$PSVersionTable\.PSVersion\.Major -eq 5\)\s*\{\s*try\s*\{\s*Add-Type -AssemblyName System\.Security -ErrorAction Stop\s*\}\s*catch\s*\{\s*Fail 'dpapi_unavailable'\s*\}\s*\}/,
  );
});

test('source guard requires CurrentUser-protected ciphertext outside the repository', async () => {
  const source = await read(launcherPath);

  assert.match(source, /SpecialFolder\]::LocalApplicationData/);
  assert.match(source, /antigravity-bootstrap\.dpapi/);
  assert.match(source, /DataProtectionScope\]::CurrentUser/g);
  assert.match(source, /ProtectedData\]::Protect/);
  assert.match(source, /ProtectedData\]::Unprotect/);
  assert.match(source, /SetAccessRuleProtection\(\$true, \$false\)/);
  assert.match(source, /Get-CurrentUserSid/);
  assert.match(source, /ReparsePoint/);
  assert.match(source, /function Assert-NoReparseChain/);
  assert.doesNotMatch(source, /['"]\.env|WriteAllText\([^,]+,\s*\$bootstrap|Set-Clipboard/i);
});

test('source guard requires active ciphertext consumption before launch with no restore path', async () => {
  const source = await read(launcherPath);
  const run = source.slice(source.indexOf('function Run-BoundedDriver'));

  const moveAt = run.indexOf('[System.IO.File]::Move($ActiveStore, $InFlightStore)');
  const launchAt = run.indexOf('Start-ApprovedChild');
  const deleteAt = run.indexOf('[System.IO.File]::Delete($InFlightStore)');
  assert.ok(moveAt >= 0 && launchAt > moveAt, 'active ciphertext must move before child launch');
  assert.ok(deleteAt > launchAt, 'in-flight ciphertext must be deleted after the launch attempt');
  assert.doesNotMatch(run, /Move\(\$InFlightStore,\s*\$ActiveStore\)/);
});

test('live entry-point bundles rebuild to the hashes selected by the live launcher', async () => {
  const launcher = await read(launcherPath);
  for (const item of [
    { variable: 'Run', source: 'server/scripts/antigravity-runtime-bundle-entry.ts' },
    { variable: 'Prepare', source: 'server/scripts/antigravity-provisioning-bundle-entry.ts' },
  ]) {
    const result = await build({
      entryPoints: [item.source], bundle: true, platform: 'node', format: 'esm',
      packages: 'bundle', write: false, logLevel: 'silent',
    });
    const actual = createHash('sha256').update(result.outputFiles![0].contents).digest('hex');
    assertLiveBundlePin(launcher, item.variable, actual);
    const mutant = launcher.replace(
      `$${item.variable}BundleSha256 = '${actual}'`,
      `$${item.variable}BundleSha256 = '${'0'.repeat(64)}'`,
    ) + `\n# ${actual}\n`;
    assert.notEqual(mutant, launcher);
    assert.throws(() => assertLiveBundlePin(mutant, item.variable, actual), /current source must match/);
  }
});

test('CURRENT entrypoints retain credential-free failure behavior without claiming historical approval', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gate3-dpapi-bundles-'));
  try {
    for (const item of [
      {
        name: 'prepare' as const,
        source: 'server/scripts/antigravity-provisioning-bundle-entry.ts',
      },
      {
        name: 'run' as const,
        source: 'server/scripts/antigravity-runtime-bundle-entry.ts',
      },
    ]) {
      const output = join(directory, `${item.name}.mjs`);
      // Resolve the application's API explicitly, never the alias's shared CLI bin.
      await build({
        entryPoints: [item.source], outfile: output, bundle: true,
        platform: 'node', format: 'esm', packages: 'bundle', logLevel: 'silent',
      });
      assertCurrentFailure(item.name, await executeCurrentBundle(item.name, output));

      // Real current-source mutation control, compiled in isolation. It must fail
      // CURRENT behavior checks; no historical hash comparison is substituted.
      const original = await read(item.source);
      const marker = item.name === 'prepare' ? 'antigravity_provisioning_failed' : 'antigravity_runtime_failed';
      const altered = original.replace(marker, 'deliberately_wrong_current_failure_marker');
      assert.notEqual(altered, original);
      const mutant = join(directory, `${item.name}-mutant.mjs`);
      await build({
        stdin: {
          contents: altered, loader: 'ts', sourcefile: item.source,
          resolveDir: join(process.cwd(), 'server/scripts'),
        },
        outfile: mutant, bundle: true, platform: 'node', format: 'esm',
        packages: 'bundle', logLevel: 'silent',
      });
      assert.throws(() => assertCurrentFailure(item.name, {
        code: 0, stderr: `${marker}\n`,
      }), /must fail closed/);
      const mutatedResult = await executeCurrentBundle(item.name, mutant);
      assert.equal(mutatedResult.code, 1);
      assert.match(mutatedResult.stderr, /deliberately_wrong_current_failure_marker/);
      assert.throws(() => assertCurrentFailure(item.name, mutatedResult), /did not match/);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('source guard requires a rebuilt child environment and bootstrap removal', async () => {
  const source = await read(launcherPath);

  assert.match(source, /EnvironmentVariables\.Clear\(\)/);
  assert.match(source, /EnvironmentVariables\['COORDINATION_RUNTIME_BOOTSTRAP_TOKEN'\] = \$Bootstrap/);
  assert.match(source, /EnvironmentVariables\.Remove\('COORDINATION_RUNTIME_BOOTSTRAP_TOKEN'\)/g);
  assert.match(source, /function Assert-NoFixedActorTokens/);
  assert.match(source, /Assert-NoFixedActorTokens\s*\n\s*switch \(\$Action\)/);
  for (const forbidden of [
    'COORDINATION_LUCA_GEMINI_CODE_TOKEN',
    'REPLIT_AGENT_TOKEN',
    'GITHUB_ACTIONS_DISPATCH_TOKEN',
    'NEON_SHARED_DATABASE_URL',
    'AI_INTEGRATIONS_GEMINI_API_KEY',
  ]) {
    assert.doesNotMatch(source, new RegExp(`EnvironmentVariables\\[['"]${forbidden}['"]\\]`));
  }
});

test('every real child process is detached from the launcher console with no output piped through the parent', async () => {
  const source = await read(launcherPath);
  const bounded = (startMarker: string, endMarker: string) => {
    const start = source.indexOf(startMarker);
    const end = source.indexOf(endMarker, start);
    assert.ok(start >= 0 && end > start, `${startMarker} must have a bounded source section`);
    return source.slice(start, end);
  };
  const newChild = bounded('function New-ApprovedChild', 'function Add-RequiredRunEnvironment');
  const plainChild = bounded('function Start-PlainChild', 'function Install-ApprovedBundle');

  for (const [name, section] of [['New-ApprovedChild', newChild], ['Start-PlainChild', plainChild]] as const) {
    assert.match(section, /\$startInfo\.UseShellExecute = \$false/, `${name} must not use shell execution`);
    assert.match(
      section,
      /\$startInfo\.CreateNoWindow = \$true/,
      `${name}'s child must not inherit the launcher console, or closing/reusing the hosting terminal window kills it with no trace`,
    );
    assert.doesNotMatch(section, /\$startInfo\.CreateNoWindow = \$false/, `${name} must not revert to console inheritance`);
  }

  // A killed launcher closes its own managed pipe handles; redirecting a
  // detached child's stdout/stderr through those pipes would silently
  // reintroduce the exact parent-lifetime coupling this detachment removes.
  assert.doesNotMatch(source, /RedirectStandardOutput\s*=\s*\$true/);
  assert.doesNotMatch(source, /RedirectStandardError\s*=\s*\$true/);
});

test('source guard permits only fixed non-secret output statements', async () => {
  const source = await read(launcherPath);
  const outputLines = source.match(/Write-(?:Output|Host|Verbose|Information|Warning|Error)[^\r\n]*/g) ?? [];
  assert.equal(outputLines.length, 4);
  for (const line of outputLines) {
    assert.doesNotMatch(line, /bootstrap|cipher|plainBytes|token|environment/i);
  }
  assert.doesNotMatch(source, /\b(?:echo|Out-Host|Out-String|Tee-Object)\b|\[Console\]::Write/i);
  assert.doesNotMatch(source, /Write-(?:Output|Host|Verbose|Information|Warning|Error)\s+\$(?:bootstrap|cipherBytes|plainBytes|raw|envelope)/i);
});

test('runbook selects Coordinator V2 and keeps historical Gate 3 non-authorizing', async () => {
  const runbook = await read(runbookPath);

  assert.match(runbook, /Invoke-HolaCoordinator -TaskRef <task reference>/);
  assert.match(runbook, /Do not begin a current run with the legacy Gate 3 Phase A\/Phase B procedure/);
  assert.match(runbook, /scripts\/antigravity-gate3\.ps1/);
  assert.match(runbook, /They are not current authority/);
  assert.match(runbook, /cannot:\s*[\s\S]*launch, resume, retry, or fall back a V2 session/i);
  assert.match(runbook, /Windows PowerShell 5\.1/);
  assert.match(runbook, /cannot\s+prove real DPAPI execution/i);
  assert.doesNotMatch(runbook, /op run|op:\/\/|1Password item/i);
});