import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import vm from 'node:vm';
import ts from 'typescript';
import { test, mock } from 'node:test';
import { assertPackageEditMatches, validatePackageCandidate, writeValidatedSourceFile } from './validated-source-write';

const original = JSON.stringify({ name: 'fixture', overrides: { existing: '1.0.0' } });
const candidate = JSON.stringify({ name: 'fixture', overrides: { existing: '1.0.0', added: '2.0.0' } });
test('line-based manifest plans must still match their expected text', () => {
  assert.throws(() => assertPackageEditMatches('package.json', '"pkg":"1"', '"pkg":"2"'), /stale/);
  assert.doesNotThrow(() => assertPackageEditMatches('package.json', '"pkg":"1"', '"pkg":"1"'));
});
function fixture(t: any) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'package-write-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const target = path.join(dir, 'package.json');
  fs.writeFileSync(target, original);
  return { dir, target };
}

for (const [file, name] of [
  ['alden-code-review-service.ts', 'applyPatch'],
  ['alden-build-service.ts', 'applyChange'],
  ['wren-auto-patch-service.ts', 'applyPatch'],
]) {
  test(`${file}: actual applier rejects malformed package edits before replacement`, t => {
    const { target } = fixture(t);
    const source = fs.readFileSync(new URL(file, import.meta.url), 'utf8');
    const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
    const declaration = tree.statements.find((node): node is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(node) && node.name?.text === name);
    assert.ok(declaration, 'applier must remain identifiable');
    const compiled = ts.transpile(declaration.getText(tree), { target: ts.ScriptTarget.ES2022 });
    // Execute the real applier body, without importing database/LLM services.
    const apply = vm.runInNewContext(`${compiled}\n${name}`, {
      fs, path, assertPackageEditMatches, writeValidatedSourceFile,
      readFileSafe: (p: string) => fs.readFileSync(p, 'utf8'),
      console: { log() {}, error() {} },
    });
    const invalid = '{"overrides":{}}, "@grpc/grpc-js":"1"}}';
    const result = name === 'applyChange'
      ? apply({ filePath: target, changeType: 'edit', lineStart: 1, lineEnd: 1, beforeCode: original, afterCode: invalid })
      : apply(target, 1, 1, invalid, original);
    assert.equal(typeof result === 'boolean' ? result : result.success, false);
    assert.equal(fs.readFileSync(target, 'utf8'), original);
    if (file === 'alden-code-review-service.ts') {
      assert.equal(apply(target, 1, 1, candidate, 'stale expected text'), false);
      assert.equal(fs.readFileSync(target, 'utf8'), original);
      assert.equal(apply(target, 1, 1, candidate, original), true);
      assert.equal(fs.readFileSync(target, 'utf8'), candidate);
    }
  });
}

for (const invalid of [
  '{"overrides":{"existing":"1"}},"@xmldom/xmldom":"^0.8.10" "@grpc/grpc-js":"^1.9.1"}}',
  '[]', 'null', '{"overrides":[]}', '{"overrides":{"pkg":null}}',
  '{"overrides":{"pkg":false}}', '{"overrides":{"pkg":42}}',
]) {
  test(`reject malformed complete manifest without touching live files: ${invalid}`, t => {
    const { dir, target } = fixture(t);
    assert.throws(() => writeValidatedSourceFile(target, invalid, original), /Refusing package.json update/);
    assert.equal(fs.readFileSync(target, 'utf8'), original);
    assert.deepEqual(fs.readdirSync(dir), ['package.json']);
  });
}

test('valid nested npm overrides remain supported', () => {
  assert.doesNotThrow(() => validatePackageCandidate('package.json',
    JSON.stringify({ overrides: { pkg: { '.': '$pkg', child: '^2.0.0' } } })));
});

test('valid update atomically preserves existing override entries and permissions', t => {
  const { dir, target } = fixture(t);
  const mode = fs.statSync(target).mode & 0o777;
  writeValidatedSourceFile(target, candidate, original);
  assert.equal(fs.readFileSync(target, 'utf8'), candidate);
  assert.equal(fs.statSync(target).mode & 0o777, mode);
  assert.deepEqual(fs.readdirSync(dir), ['package.json']);
});

test('stale plans preserve the newer content', t => {
  const { dir, target } = fixture(t);
  fs.writeFileSync(target, candidate);
  assert.throws(() => writeValidatedSourceFile(target, original, original), /stale/);
  assert.equal(fs.readFileSync(target, 'utf8'), candidate);
  assert.deepEqual(fs.readdirSync(dir), ['package.json']);
});

test('lock contention refuses writes without deleting another writer lock', t => {
  const { target } = fixture(t);
  fs.writeFileSync(`${target}.alden-write.lock`, 'other writer');
  assert.throws(() => writeValidatedSourceFile(target, candidate, original), /EEXIST/);
  assert.equal(fs.readFileSync(target, 'utf8'), original);
  assert.equal(fs.readFileSync(`${target}.alden-write.lock`, 'utf8'), 'other writer');
});

test('an edit during staging is preserved and temporary files are removed', t => {
  const { dir, target } = fixture(t);
  const write = fs.writeFileSync;
  mock.method(fs, 'writeFileSync', (file: any, data: any, options: any) => {
    write(file, data, options);
    if (typeof file === 'number') write(target, '{"name":"concurrent edit"}');
  });
  syncBuiltinESMExports();
  try {
    assert.throws(() => writeValidatedSourceFile(target, candidate, original), /stale/);
    assert.equal(fs.readFileSync(target, 'utf8'), '{"name":"concurrent edit"}');
    assert.deepEqual(fs.readdirSync(dir), ['package.json']);
  } finally {
    mock.restoreAll();
    syncBuiltinESMExports();
  }
});

test('rename failure leaves the original intact and cleans staged files and lock', t => {
  const { dir, target } = fixture(t);
  mock.method(fs, 'renameSync', () => { throw new Error('synthetic rename failure'); });
  syncBuiltinESMExports();
  try {
    assert.throws(() => writeValidatedSourceFile(target, candidate, original), /synthetic rename failure/);
    assert.equal(fs.readFileSync(target, 'utf8'), original);
    assert.deepEqual(fs.readdirSync(dir), ['package.json']);
  } finally {
    mock.restoreAll();
    syncBuiltinESMExports();
  }
});

test('creation refuses to replace an existing file and supports a genuinely new manifest', t => {
  const { target } = fixture(t);
  assert.throws(() => writeValidatedSourceFile(target, candidate, null), /stale/);
  fs.unlinkSync(target);
  writeValidatedSourceFile(target, candidate, null);
  assert.equal(fs.readFileSync(target, 'utf8'), candidate);
});

test('non-manifest source files retain ordinary text-write behavior', t => {
  const { dir } = fixture(t);
  const target = path.join(dir, 'fixture.ts');
  writeValidatedSourceFile(target, 'not JSON', null);
  assert.equal(fs.readFileSync(target, 'utf8'), 'not JSON');
});
