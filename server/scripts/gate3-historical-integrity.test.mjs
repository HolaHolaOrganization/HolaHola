import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { cp, mkdtemp, readFile, readdir, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  APPROVED_HASHES, FIXTURE_ROOT, REPOSITORY_ROOT, MANIFEST_SHA256,
  assertApprovedOutput, assertLauncherPins, assertRelativePath, buildHistoricalArtifact,
  loadHistoricalSnapshot, resolveFrozenImport, sha256,
} from './lib/gate3-historical-integrity.mjs';

const require = createRequire(import.meta.url);
const compiler = require('gate3-historical-esbuild');
const fixtureFile = (root, relative) => path.join(root, 'inputs', `${relative}.source`);

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

test('historical guard verifies the archived launcher, including real pin mutations with misleading comments', async () => {
  const source = await readFile(fixtureFile(FIXTURE_ROOT, 'scripts/antigravity-gate3.ps1'), 'utf8');
  for (const name of ['run', 'prepare']) {
    const altered = source.replace(APPROVED_HASHES[name], '0'.repeat(64)) + `\n# ${APPROVED_HASHES[name]}\n`;
    assert.throws(() => assertLauncherPins(altered), new RegExp(`launcher_pin_${name}`));
    await isolatedFixture(async (fixtureRoot) => {
      await writeFile(fixtureFile(fixtureRoot, 'scripts/antigravity-gate3.ps1'), altered);
      await assert.rejects(loadHistoricalSnapshot({ fixtureRoot }), /gate3_historical_source_identity/);
    });
  }
});

test('historical evidence is independent of a caller-selected live launcher', async () => {
  await isolatedFixture(async (fixtureRoot, parent) => {
    const launcherPath = path.join(parent, 'unrelated-live-launcher.ps1');
    await writeFile(launcherPath, "$RunBundleSha256 = '" + '0'.repeat(64) + "'\n");
    const snapshot = await loadHistoricalSnapshot({ fixtureRoot, launcherPath });
    assert.equal(snapshot.manifest.artifacts.run.sha256, APPROVED_HASHES.run);
    // The old option must not create an alternative approval authority.
    await unlink(launcherPath);
    await loadHistoricalSnapshot({ fixtureRoot, launcherPath });
  });
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
