import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { chmod, cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import {
  APPROVED_HASHES, FIXTURE_ROOT, REPOSITORY_ROOT, MANIFEST_SHA256,
  assertApprovedOutput, assertLauncherPins, assertRelativePath, buildHistoricalArtifact,
  loadHistoricalSnapshot, resolveFrozenImport, sha256,
} from './lib/gate3-historical-integrity.mjs';

const require = createRequire(import.meta.url);
const compiler = require('gate3-historical-esbuild');
const fixtureFile = (root, relative) => path.join(root, 'inputs', `${relative}.source`);

// No installed package, shared bin, live source, or environment is modified.
// Each child gets a fresh module cache and only an allowlisted environment.
async function isolatedCompilerSelection(run) {
  const root = await mkdtemp(path.join(tmpdir(), 'gate3-compiler-selection-'));
  try {
    for (const directory of ['server/scripts/lib', 'scripts', 'node_modules/esbuild', 'node_modules/.bin', 'scratch']) {
      await mkdir(path.join(root, directory), { recursive: true });
    }
    const helper = path.join(root, 'server/scripts/lib/gate3-historical-integrity.mjs');
    const appBuilder = path.join(root, 'scripts/build-app-server.mjs');
    await cp(path.join(REPOSITORY_ROOT, 'server/scripts/lib/gate3-historical-integrity.mjs'), helper);
    await cp(path.join(REPOSITORY_ROOT, 'scripts/build-app-server.mjs'), appBuilder);
    await cp(FIXTURE_ROOT, path.join(root, 'server/scripts/fixtures/gate3-approved-origin'), { recursive: true });
    await cp(path.join(REPOSITORY_ROOT, 'scripts/antigravity-gate3.ps1'), path.join(root, 'scripts/antigravity-gate3.ps1'));
    await writeFile(path.join(root, 'package.json'), '{"type":"module"}');
    await writeFile(path.join(root, 'node_modules/esbuild/package.json'), '{"name":"esbuild","main":"index.cjs"}');
    await symlink(path.dirname(require.resolve('gate3-historical-esbuild/package.json')),
      path.join(root, 'node_modules/gate3-historical-esbuild'), process.platform === 'win32' ? 'junction' : 'dir');
    const cliMarker = path.join(root, 'cli-used');
    const appMarker = path.join(root, 'app-api-used');
    const sharedCli = path.join(root, 'node_modules/.bin/esbuild');
    await writeFile(`${sharedCli}.cjs`, `
require('node:fs').writeFileSync(${JSON.stringify(cliMarker)}, 'shared-cli');
console.error('gate3_test_shared_cli_selected');
process.exit(86);
`);
    if (process.platform === 'win32') {
      await writeFile(`${sharedCli}.cmd`, `@"${process.execPath}" "%~dp0esbuild.cjs" %*\r\n`);
    } else {
      await writeFile(sharedCli, `#!${process.execPath}\nrequire('./esbuild.cjs');\n`);
      await chmod(sharedCli, 0o755);
    }
    // Windows .cmd files must go through cmd.exe. Use its absolute path, while
    // PATH still resolves only our shadow CLI, never an installed shared bin.
    const invokeCli = (args) => process.platform === 'win32'
      ? `execFileSync(process.env.ComSpec, ['/d', '/s', '/c', ${JSON.stringify(`esbuild ${args.join(' ')}`)}], { stdio: 'inherit' });`
      : `execFileSync('esbuild', ${JSON.stringify(args)}, { stdio: 'inherit' });`;
    const setAppCompiler = async (poisoned) => writeFile(path.join(root, 'node_modules/esbuild/index.cjs'), `
const fs = require('node:fs');
exports.version = '0.25.9';
exports.build = async function(options) {
  fs.writeFileSync(${JSON.stringify(appMarker)}, JSON.stringify(options));
  ${poisoned
    ? "throw new Error('gate3_test_app_api_poisoned');"
    : `return require(${JSON.stringify(require.resolve('esbuild'))}).build(options);`}
};
`);
    const child = (source) => spawnSync(process.execPath, ['--input-type=module', '--eval', source], {
      cwd: root,
      env: {
        PATH: path.join(root, 'node_modules/.bin'), HOME: root, TMPDIR: path.join(root, 'scratch'),
        ...(process.platform === 'win32' ? {
          SystemRoot: process.env.SystemRoot,
          ComSpec: path.join(process.env.SystemRoot, 'System32/cmd.exe'),
          PATHEXT: '.COM;.EXE;.BAT;.CMD',
          TEMP: path.join(root, 'scratch'), TMP: path.join(root, 'scratch'),
        } : {}),
      },
      encoding: 'utf8',
      timeout: 60_000,
      maxBuffer: 1024 * 1024,
    });
    const historicalSource = `
import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
import { loadHistoricalSnapshot, buildHistoricalArtifact } from ${JSON.stringify(pathToFileURL(helper).href)};
const snapshot = await loadHistoricalSnapshot();
for (const [name, hash] of ${JSON.stringify(Object.entries(APPROVED_HASHES))}) {
  // Exercise DEFAULT selection: no compiler option is supplied.
  const result = await buildHistoricalArtifact(snapshot, name, { temporaryParent: ${JSON.stringify(path.join(root, 'scratch'))} });
  assert.equal(result.sha256, hash);
}
assert.deepEqual(await readdir(${JSON.stringify(path.join(root, 'scratch'))}), []);
console.log('both-original-hashes-rebuilt');
`;
    await run({ root, helper, appBuilder, appMarker, cliMarker, setAppCompiler, child, historicalSource, invokeCli });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function successfulChild(result) {
  assert.ifError(result.error);
  assert.equal(result.signal, null, result.stderr);
  assert.equal(result.status, 0, result.stderr);
}

function failedChild(result, message) {
  assert.ifError(result.error);
  assert.equal(result.signal, null, result.stderr);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, message);
}

test('DEFAULT historical alias rebuilds both original hashes with a poisoned same-version app API and shadowed CLI', async () => {
  await isolatedCompilerSelection(async ({ root, helper, appMarker, cliMarker, setAppCompiler, child, historicalSource, invokeCli }) => {
    await setAppCompiler(true);
    // First prove the poison is active in this child's actual resolution scope.
    const probe = child("import { build } from 'esbuild'; await build({});");
    failedChild(probe, /gate3_test_app_api_poisoned/);
    await unlink(appMarker);
    const result = child(historicalSource);
    successfulChild(result);
    assert.match(result.stdout, /both-original-hashes-rebuilt/);
    await assert.rejects(readFile(appMarker), { code: 'ENOENT' });
    await assert.rejects(readFile(cliMarker), { code: 'ENOENT' });

    const original = await readFile(helper, 'utf8');
    const swapped = original.replace("compiler = require('gate3-historical-esbuild')", "compiler = require('esbuild')");
    assert.notEqual(swapped, original, 'default compiler mutation must actually apply');
    await writeFile(helper, swapped);
    failedChild(child(historicalSource), /gate3_test_app_api_poisoned/);
    assert.ok(await readFile(appMarker, 'utf8'));
    assert.deepEqual(await readdir(path.join(root, 'scratch')), [], 'failed builds clean their temporary roots');

    // Mutate the default selection to a CLI-backed compiler, not an injected
    // compiler option. The real shadow executable must run and reject it.
    const cliDefault = `compiler = { version: '0.25.9', async build() {
      const { execFileSync } = await import('node:child_process');
      ${invokeCli(['--version'])}
      throw new Error('shared CLI unexpectedly succeeded');
    } }`;
    const cliSwapped = original.replace("compiler = require('gate3-historical-esbuild')", cliDefault);
    assert.notEqual(cliSwapped, original, 'CLI default mutation must actually apply');
    await writeFile(helper, cliSwapped);
    failedChild(child(historicalSource), /gate3_test_shared_cli_selected/);
    assert.equal(await readFile(cliMarker, 'utf8'), 'shared-cli');
    assert.deepEqual(await readdir(path.join(root, 'scratch')), []);
  });
});

test('application builder uses the normal API despite a shadowed shared CLI; real alias and CLI swaps fail the proof', async () => {
  await isolatedCompilerSelection(async ({ root, appBuilder, appMarker, cliMarker, setAppCompiler, child, invokeCli }) => {
    await setAppCompiler(false);
    // A tiny app proves real bundling without loading the live application or
    // executing generated code. Executing this input would fail immediately.
    await writeFile(path.join(root, 'server/index.ts'), "throw new Error('gate3_test_output_must_never_execute');\n");
    const source = `
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
await import(${JSON.stringify(pathToFileURL(appBuilder).href)});
const options = JSON.parse(await readFile(${JSON.stringify(appMarker)}, 'utf8'));
assert.deepEqual(options, {
  entryPoints: ['server/index.ts'], platform: 'node', packages: 'external',
  bundle: true, format: 'esm', outdir: 'dist',
});
assert.match(await readFile('dist/index.js', 'utf8'), /gate3_test_output_must_never_execute/);
console.log('normal-app-api-built');
`;
    const result = child(source);
    successfulChild(result);
    assert.match(result.stdout, /normal-app-api-built/);
    await assert.rejects(readFile(cliMarker), { code: 'ENOENT' });
    await unlink(appMarker);
    await rm(path.join(root, 'dist'), { recursive: true, force: true });

    const original = await readFile(appBuilder, 'utf8');
    const swapped = original.replace("from 'esbuild'", "from 'gate3-historical-esbuild'");
    assert.notEqual(swapped, original, 'application alias mutation must actually apply');
    await writeFile(appBuilder, swapped);
    // Same-version historical alias can compile, but cannot satisfy API-use proof.
    failedChild(child(source), /ENOENT.*app-api-used/);
    assert.match(await readFile(path.join(root, 'dist/index.js'), 'utf8'), /gate3_test_output_must_never_execute/);
    await rm(path.join(root, 'dist'), { recursive: true, force: true });

    await writeFile(appBuilder, `
import { execFileSync } from 'node:child_process';
${invokeCli(['server/index.ts', '--platform=node', '--packages=external', '--bundle', '--format=esm', '--outdir=dist'])}
`);
    failedChild(child(source), /gate3_test_shared_cli_selected/);
    assert.equal(await readFile(cliMarker, 'utf8'), 'shared-cli');
    await assert.rejects(readFile(appMarker), { code: 'ENOENT' });
    await assert.rejects(readFile(path.join(root, 'dist/index.js')), { code: 'ENOENT' });
  });
});

async function isolatedFixture(run) {
  const parent = await mkdtemp(path.join(tmpdir(), 'gate3-historical-control-'));
  const fixtureRoot = path.join(parent, 'fixture');
  await cp(FIXTURE_ROOT, fixtureRoot, { recursive: true });
  const originalManifest = await readFile(path.join(FIXTURE_ROOT, 'manifest.json'));
  try { return await run(fixtureRoot, parent); }
  finally {
    await rm(parent, { recursive: true, force: true });
    assert.deepEqual(await readFile(path.join(FIXTURE_ROOT, 'manifest.json')), originalManifest);
  }
}

test('historical run and preparation rebuild from frozen sources to ORIGINAL approved hashes, without execution', async () => {
  const snapshot = await loadHistoricalSnapshot();
  for (const name of ['run', 'prepare']) {
    const result = await buildHistoricalArtifact(snapshot, name);
    assert.equal(result.sha256, APPROVED_HASHES[name]);
    assert.deepEqual(result.inputs, snapshot.manifest.artifacts[name].inputs);
  }
  assert.equal(snapshot.manifest.artifacts.run.inputs.length, 6);
  assert.equal(snapshot.manifest.artifacts.prepare.inputs.length, 5);
});

test('historical compiler is an isolated exact-pinned dev alias in both manifest and lock', async () => {
  const pkg = JSON.parse(await readFile(path.join(REPOSITORY_ROOT, 'package.json'), 'utf8'));
  const lock = JSON.parse(await readFile(path.join(REPOSITORY_ROOT, 'package-lock.json'), 'utf8'));
  assert.equal(pkg.devDependencies['gate3-historical-esbuild'], 'npm:esbuild@0.25.9');
  assert.equal(pkg.dependencies?.['gate3-historical-esbuild'], undefined);
  assert.equal(lock.packages[''].devDependencies['gate3-historical-esbuild'], 'npm:esbuild@0.25.9');
  assert.equal(lock.packages['node_modules/gate3-historical-esbuild'].version, '0.25.9');
  assert.equal(lock.packages['node_modules/gate3-historical-esbuild'].name, 'esbuild');
  assert.equal(compiler.version, '0.25.9');
  // Aliased npm packages expose the same underlying CLI bin name. Application
  // builds must resolve their own compiler API instead of that ambiguous bin.
  assert.match(pkg.scripts?.build ?? '', /node scripts\/build-app-server\.mjs/);
  const appBuilder = await readFile(path.join(REPOSITORY_ROOT, 'scripts/build-app-server.mjs'), 'utf8');
  assert.match(appBuilder, /import \{ build \} from 'esbuild'/);
  assert.doesNotMatch(appBuilder, /from 'gate3-historical-esbuild'/);
});

test('frozen manifest, LF bytes and Git blob identities are verified, including compiler configuration and archive identity', async () => {
  const snapshot = await loadHistoricalSnapshot();
  assert.equal(sha256(snapshot.manifestBytes), MANIFEST_SHA256);
  assert.ok(snapshot.manifest.files.some((file) => file.path === 'tsconfig.json'));
  assert.ok(snapshot.manifest.files.every((file) => /^[a-f0-9]{40}$/.test(file.gitBlob)));
  assert.match(snapshot.manifest.archive.documentId, /^[a-f0-9-]{36}$/);
  assert.match(snapshot.manifest.archive.revisionId, /^[a-f0-9-]{36}$/);
  assert.match(snapshot.manifest.archive.contentHash, /^[a-f0-9]{64}$/);
});

for (const [label, relative, mutation] of [
  ['source', 'server/services/task-ownership-client.ts', (b) => Buffer.concat([b, Buffer.from('\n// changed\n')])],
  ['tsconfig', 'tsconfig.json', (b) => Buffer.from(b.toString().replace('ES2019', 'ES2022'))],
  ['CRLF checkout conversion', 'server/services/coordination-runtime.ts', (b) => Buffer.from(b.toString().replace(/\n/g, '\r\n'))],
]) {
  test(`historical guard rejects a real ${label} mutation`, async () => {
    await isolatedFixture(async (fixtureRoot) => {
      const file = fixtureFile(fixtureRoot, relative);
      const before = await readFile(file);
      const after = mutation(before);
      assert.notDeepEqual(after, before);
      await writeFile(file, after);
      await assert.rejects(loadHistoricalSnapshot({ fixtureRoot }), /gate3_historical_source_identity/);
    });
  });
}

for (const relative of ['tsconfig.json', 'server/scripts/antigravity-provisioning-bundle-entry.ts']) {
  test(`historical guard rejects missing ${relative}`, async () => {
    await isolatedFixture(async (fixtureRoot) => {
      await unlink(fixtureFile(fixtureRoot, relative));
      await assert.rejects(loadHistoricalSnapshot({ fixtureRoot }), /ENOENT/);
    });
  });
}

for (const field of ['expected artifact hash', 'archive identity', 'recipe option', 'source metadata']) {
  test(`historical guard rejects a changed manifest ${field}`, async () => {
    await isolatedFixture(async (fixtureRoot) => {
      const file = path.join(fixtureRoot, 'manifest.json');
      const data = JSON.parse(await readFile(file, 'utf8'));
      if (field === 'expected artifact hash') data.artifacts.run.sha256 = '0'.repeat(64);
      if (field === 'archive identity') data.archive.contentHash = '0'.repeat(64);
      if (field === 'recipe option') data.recipe.minify = true;
      if (field === 'source metadata') data.files[0].path = '../live-service.ts';
      await writeFile(file, JSON.stringify(data, null, 2) + '\n');
      await assert.rejects(loadHistoricalSnapshot({ fixtureRoot }), /gate3_historical_manifest_identity/);
    });
  });
}

test('historical guard rejects a changed LIVE launcher pin, even if a comment retains the approved hash', async () => {
  const source = await readFile(path.join(REPOSITORY_ROOT, 'scripts/antigravity-gate3.ps1'), 'utf8');
  for (const name of ['run', 'prepare']) {
    const altered = source.replace(APPROVED_HASHES[name], '0'.repeat(64)) + `\n# ${APPROVED_HASHES[name]}\n`;
    assert.throws(() => assertLauncherPins(altered), new RegExp(`launcher_pin_${name}`));
    await isolatedFixture(async (fixtureRoot, parent) => {
      const launcherPath = path.join(parent, 'launcher.ps1');
      await writeFile(launcherPath, altered);
      await assert.rejects(loadHistoricalSnapshot({ fixtureRoot, launcherPath }), new RegExp(`launcher_pin_${name}`));
    });
  }
});

test('historical guard rejects a wrong compiler before any build call', async () => {
  const snapshot = await loadHistoricalSnapshot();
  let called = false;
  await assert.rejects(buildHistoricalArtifact(snapshot, 'run', {
    compiler: { version: '0.25.10', build() { called = true; throw Error('must not run'); } },
  }), /compiler_version/);
  assert.equal(called, false);
});

test('real resolver refuses path escape, bare external packages and unlisted live-source imports', async () => {
  const snapshot = await loadHistoricalSnapshot();
  const artifact = snapshot.manifest.artifacts.run;
  const importer = 'server/scripts/coordination-runtime-antigravity.ts';
  for (const specifier of ['../../../outside.ts', '/tmp/outside.ts', 'C:\\outside.ts',
    '..\\..\\outside.ts', '@shared/schema', 'esbuild', '../services/live-only-service', 'node:http']) {
    assert.throws(() => resolveFrozenImport(specifier, importer, artifact.inputs, artifact.externals), /gate3_historical_/);
  }
  assert.deepEqual(resolveFrozenImport('../services/task-ownership-client', importer, artifact.inputs, artifact.externals),
    { external: false, path: 'server/services/task-ownership-client.ts' });
  assert.deepEqual(resolveFrozenImport('node:crypto', importer, artifact.inputs, artifact.externals),
    { external: true, path: 'node:crypto' });
  for (const bad of ['../escape', 'C:\\escape', '/escape', 'a/../b', 'a//b']) {
    assert.throws(() => assertRelativePath(bad), /unsafe_path/);
  }
});

test('independent output checks reject changed bytes and refreshed expected hashes', async () => {
  const snapshot = await loadHistoricalSnapshot();
  const artifact = snapshot.manifest.artifacts.run;
  const corrupted = Buffer.alloc(artifact.bytes, 0);
  assert.throws(() => assertApprovedOutput('run', corrupted, artifact), /artifact_digest_run/);
  assert.throws(() => assertApprovedOutput('run', corrupted, { ...artifact, sha256: sha256(corrupted) }), /artifact_digest_run/);
});

test('actual build guard catches ignored tsconfig and changed build flags; temporary roots are cleaned on failure', async () => {
  const snapshot = await loadHistoricalSnapshot();
  const parent = await mkdtemp(path.join(tmpdir(), 'gate3-build-controls-'));
  try {
    for (const overrides of [{ tsconfig: undefined, tsconfigRaw: {} }, { minify: true }]) {
      const mutantCompiler = { version: compiler.version, build(options) { return compiler.build({ ...options, ...overrides }); } };
      await assert.rejects(buildHistoricalArtifact(snapshot, 'run', { compiler: mutantCompiler, temporaryParent: parent }),
        /artifact_digest_run/);
      assert.deepEqual(await readdir(parent), []);
    }
    await buildHistoricalArtifact(snapshot, 'run', { temporaryParent: parent });
    assert.deepEqual(await readdir(parent), []);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test('frozen build does not need Git history, live service files, shared-spec or an application environment', async () => {
  await isolatedFixture(async (fixtureRoot, parent) => {
    const snapshot = await loadHistoricalSnapshot({ fixtureRoot });
    // The build plugin can see only the verified byte map. No checkout, node_modules,
    // Git object lookup, source fallback, or archive HTTP request occurs in its root.
    const result = await buildHistoricalArtifact(snapshot, 'run', { temporaryParent: parent });
    assert.equal(result.sha256, APPROVED_HASHES.run);
    assert.deepEqual((await readdir(parent)).sort(), ['fixture']);
  });
});
