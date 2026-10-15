/**
 * Build-only verification of retired Gate 3 approvals.
 * Never imports or executes a historical source file or generated bundle.
 */
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { lstat, mkdtemp, readFile, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
export const REPOSITORY_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
export const FIXTURE_ROOT = path.join(REPOSITORY_ROOT, 'server/scripts/fixtures/gate3-approved-origin');
export const MANIFEST_SHA256 = '7c90980271effd65fa5af14599b3e63afdf6e6a79b1702c968728a665a963978';
export const APPROVED_HASHES = Object.freeze({
  run: '5e620f6bc4cc5fb2dcf869efbfbbecc79a995178439e30191ada5b19d273363e',
  prepare: '06ce0e36c270bb3796e5b528ceee0200bc334991c0bd512b64ac80d0ddd475ab',
});
export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const fail = (reason) => { throw new Error(`gate3_historical_${reason}`); };
const portable = (value) => value.split(path.sep).join('/');

export function assertRelativePath(value) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_./-]+$/.test(value) ||
      value.startsWith('/') || value.split('/').some((part) => !part || part === '.' || part === '..')) {
    fail('unsafe_path');
  }
  return value;
}

async function regularFile(root, relative) {
  assertRelativePath(relative);
  let current = root;
  const rootStat = await lstat(current);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) fail('fixture_root');
  for (const [index, part] of relative.split('/').entries()) {
    current = path.join(current, part);
    const stat = await lstat(current);
    if (stat.isSymbolicLink()) fail('symlink');
    if (index === relative.split('/').length - 1 ? !stat.isFile() : !stat.isDirectory()) {
      fail('fixture_file_type');
    }
  }
  return readFile(current);
}

export function assertApprovedOutput(name, bytes, artifact) {
  if (!Object.hasOwn(APPROVED_HASHES, name) ||
      artifact.sha256 !== APPROVED_HASHES[name] ||
      bytes.length !== artifact.bytes || sha256(bytes) !== APPROVED_HASHES[name]) {
    fail(`artifact_digest_${name}`);
  }
}

export function assertLauncherPins(launcher) {
  for (const [name, label] of [['run', 'Run'], ['prepare', 'Prepare']]) {
    const matches = [...launcher.matchAll(new RegExp(`^\\$${label}BundleSha256 = '([a-f0-9]{64})'\\r?$`, 'gm'))];
    if (matches.length !== 1 || matches[0][1] !== APPROVED_HASHES[name]) fail(`launcher_pin_${name}`);
  }
}

function assertBytes(file, bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length !== file.bytes || bytes.includes(13) ||
      sha256(bytes) !== file.sha256 ||
      createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex') !== file.gitBlob) {
    fail(`source_identity:${file.path}`);
  }
}

function assertSnapshot(snapshot) {
  if (sha256(snapshot.manifestBytes) !== MANIFEST_SHA256 ||
      JSON.stringify(JSON.parse(snapshot.manifestBytes.toString('utf8'))) !== JSON.stringify(snapshot.manifest)) {
    fail('manifest_identity');
  }
  if (snapshot.sources.size !== snapshot.manifest.files.length) fail('source_count');
  for (const file of snapshot.manifest.files) assertBytes(file, snapshot.sources.get(file.path));
}

export async function loadHistoricalSnapshot({
  fixtureRoot = FIXTURE_ROOT,
} = {}) {
  const manifestBytes = await regularFile(fixtureRoot, 'manifest.json');
  if (sha256(manifestBytes) !== MANIFEST_SHA256) fail('manifest_identity');
  const manifest = JSON.parse(manifestBytes.toString('utf8'));
  const sources = new Map();
  for (const file of manifest.files) {
    assertRelativePath(file.path);
    const bytes = await regularFile(fixtureRoot, `inputs/${file.path}.source`);
    assertBytes(file, bytes);
    sources.set(file.path, bytes);
  }
  // Historical approval belongs to the verified archived launcher, not the
  // independently evolving live launcher. Never accept caller-selected pins.
  assertLauncherPins(sources.get('scripts/antigravity-gate3.ps1').toString('utf8'));
  const snapshot = { manifestBytes, manifest, sources };
  assertSnapshot(snapshot);
  return snapshot;
}

/** Used directly by the real build plugin, so resolver controls exercise production verification code. */
export function resolveFrozenImport(specifier, importer, allowedSources, allowedExternals) {
  if (allowedExternals.includes(specifier) && specifier.startsWith('node:')) {
    return { external: true, path: specifier };
  }
  if (typeof specifier !== 'string' || /[\\?#\0]/.test(specifier) ||
      /^(?:\/|[a-z]:)/i.test(specifier)) fail('import_escape');
  let resolved;
  if (!importer) {
    // esbuild prefixes relative entrypoints with "./" before plugin resolution.
    resolved = path.posix.normalize(specifier);
  } else {
    if (!specifier.startsWith('.')) fail('external_import');
    assertRelativePath(importer);
    resolved = path.posix.normalize(path.posix.join(path.posix.dirname(importer), specifier));
  }
  assertRelativePath(resolved);
  const selected = [resolved, `${resolved}.ts`, `${resolved}/index.ts`].find((candidate) => allowedSources.includes(candidate));
  if (!selected) fail('unlisted_import');
  return { external: false, path: selected };
}

/**
 * compiler injection is solely for hermetic failure controls; the default is
 * the dedicated exact-pinned alias, never the application's evolving esbuild.
 */
export async function buildHistoricalArtifact(snapshot, name, {
  compiler = require('gate3-historical-esbuild'),
  temporaryParent = tmpdir(),
} = {}) {
  assertSnapshot(snapshot);
  const { manifest, sources } = snapshot;
  if (compiler.version !== '0.25.9' || compiler.version !== manifest.compiler.version) fail('compiler_version');
  if (!Object.hasOwn(APPROVED_HASHES, name)) fail('artifact_name');
  const artifact = manifest.artifacts[name];
  const root = await mkdtemp(path.join(temporaryParent, 'gate3-frozen-build-'));
  try {
    for (const [relative, bytes] of sources) {
      const destination = path.join(root, assertRelativePath(relative));
      await mkdir(path.dirname(destination), { recursive: true });
      await writeFile(destination, bytes);
    }
    const result = await compiler.build({
      ...manifest.recipe,
      absWorkingDir: root,
      tsconfig: path.join(root, manifest.recipe.tsconfig),
      entryPoints: [artifact.entry],
      write: false,
      metafile: true,
      logLevel: 'silent',
      plugins: [{
        name: 'closed-historical-source-graph',
        setup(build) {
          build.onResolve({ filter: /.*/ }, (args) => {
            const importer = args.importer ? portable(path.relative(root, args.importer)) : '';
            const resolved = resolveFrozenImport(args.path, importer, artifact.inputs, artifact.externals);
            return resolved.external
              // Match esbuild's native Node-built-in resolution metadata.
              // A plugin's default "unknown" side effects retains unused imports
              // and changes otherwise identical historical bytes.
              ? { ...resolved, sideEffects: false }
              : { path: path.join(root, resolved.path), namespace: 'file' };
          });
          build.onLoad({ filter: /.*/, namespace: 'file' }, (args) => {
            const relative = portable(path.relative(root, args.path));
            if (!artifact.inputs.includes(relative)) fail('unlisted_load');
            const contents = sources.get(relative);
            if (!contents) fail('missing_load');
            return { contents, loader: 'ts', resolveDir: path.dirname(args.path) };
          });
        },
      }],
    });
    const actualInputs = Object.keys(result.metafile.inputs).map(portable).sort();
    if (JSON.stringify(actualInputs) !== JSON.stringify(artifact.inputs)) fail('input_closure');
    const externals = [...new Set(Object.values(result.metafile.inputs)
      .flatMap((input) => input.imports.filter((item) => item.external).map((item) => item.path)))].sort();
    if (JSON.stringify(externals) !== JSON.stringify(artifact.externals)) fail('external_closure');
    if (result.outputFiles.length !== 1) fail('output_count');
    const bytes = Buffer.from(result.outputFiles[0].contents);
    assertApprovedOutput(name, bytes, artifact);
    return { name, sha256: sha256(bytes), bytes: bytes.length, inputs: actualInputs };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
