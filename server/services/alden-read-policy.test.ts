// Read confinement for Alden's file tools (gated-fixes design e4f8e988, P2),
// exercised through executeAldenTool against a throwaway fixture workspace.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { classifyAldenReadPath, resolveAldenReadPath, secretContentReason, secretPathReason } from './alden-read-policy';

const MARK = 'MARKER_ZQX_READ_POLICY';
// Built at runtime so this file never contains a token-shaped literal.
const FAKE_GITHUB_TOKEN = 'ghp_' + 'A'.repeat(36);

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'alden-read-policy-'));
const root = path.join(base, 'ws');
const outside = path.join(base, 'outside');

const READABLE = [
  'server/a.ts', 'docs/n.md', 'broker/b.ts', 'config/c.ts', 'client/x.tsx', 'shared/s.ts',
  '.agents/memory/m.md', '.agents/skills/k.md', '.github/workflows/ci.yml', 'render.yaml',
  'server/services/credential-broker.ts', 'docs/secret-management.md',
];
const REFUSED = [
  '.env', '.env.local', 'server/.env', '.local/x.md', 'server/key.pem', 'server/id_rsa',
  'server/config/credentials.json', 'config/service-account.json', 'node_modules/m/index.js', 'dist/x.js',
  'attached_assets/a.md', 'uploads/u.md', 'public/p.md', 'test-openai-key.ts', 'test-neon-connection.ts',
  'test-both-models.ts', 'test-new-model.ts', 'test-realtime-api.ts', 'run-migration-temp.ts',
  'fine-tuning-export-1.jsonl', 'fine-tuning-export-1.jsonl.gz', '.agents/other/x.md', '.github/x.md', '.git/config',
];

function write(rel: string, content: string): void {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

let executeAldenTool: typeof import('./alden-functions').executeAldenTool;
let setRg: typeof import('./alden-functions').__setRgAvailableOverrideForTesting;
let symlinkMade = false;

before(async () => {
  for (const rel of ['package.json', 'drizzle.config.ts', 'shared/schema.ts']) write(rel, '// workspace marker\n');
  for (const rel of [...READABLE, ...REFUSED]) write(rel, `${MARK} ${rel}\n`);
  write('server/leak.ts', `${MARK} const t = "${FAKE_GITHUB_TOKEN}";\n`);
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(outside, 'secret.md'), `${MARK} outside\n`);
  try {
    fs.symlinkSync(outside, path.join(root, 'server', 'out'), process.platform === 'win32' ? 'junction' : 'dir');
    symlinkMade = true;
  } catch { /* symlinks unavailable here; the symlink cases are skipped */ }
  process.env.HOLAHOLA_WORKSPACE_ROOT = root;
  ({ executeAldenTool, __setRgAvailableOverrideForTesting: setRg } = await import('./alden-functions'));
});

after(() => fs.rmSync(base, { recursive: true, force: true }));

describe('the policy itself', () => {
  test('allowed root, read-only directories and exact top-level files', () => {
    assert.equal(classifyAldenReadPath('server/x.ts'), 'dir');
    assert.equal(classifyAldenReadPath('.agents/memory/m.md'), 'dir');
    assert.equal(classifyAldenReadPath('.agents'), 'ancestor');
    assert.equal(classifyAldenReadPath('render.yaml'), 'file');
    assert.equal(classifyAldenReadPath(''), 'root');
    for (const rel of ['attached_assets/a.md', 'uploads/u.md', 'public/p.md', 'test-openai-key.ts', 'fine-tuning-export-1.jsonl', '.agents/other/x.md']) {
      assert.equal(classifyAldenReadPath(rel), null, rel);
    }
  });

  test('secret paths and contents', () => {
    for (const rel of ['.env', 'server/.env.production', '.local/a', 'a/.git/config', 'node_modules/x', 'dist/a.js', 'x.pem', 'x.key', 'x.p12', 'id_ed25519', 'credentials.json', 'secrets.yaml', 'keystore']) {
      assert.ok(secretPathReason(rel), rel);
    }
    for (const rel of ['server/services/credential-broker.ts', 'docs/secret-management.md', 'server/env.ts']) {
      assert.equal(secretPathReason(rel), null, rel);
    }
    assert.equal(secretContentReason(`const t = "${FAKE_GITHUB_TOKEN}";`), 'GitHub token');
    assert.equal(secretContentReason('-----BEGIN PRIVATE KEY-----'), 'private key');
    assert.equal(secretContentReason("DEEPGRAM_API_KEY: ci-placeholder-not-a-real-key"), null);
  });

  test('resolution refuses absolute paths, escapes and symlinks out', (t) => {
    for (const input of ['/etc/passwd', path.join(root, 'server/a.ts'), 'C:\\Windows\\win.ini', '\\server\\a.ts', '../outside/secret.md', 'server/../../outside/secret.md']) {
      assert.equal(resolveAldenReadPath(input, root).ok, false, input);
    }
    if (!symlinkMade) return t.skip('symlinks unavailable');
    assert.equal(resolveAldenReadPath('server/out/secret.md', root).ok, false);
    assert.equal(resolveAldenReadPath('server/out', root).ok, false);
  });
});

describe('read_file', () => {
  test('reads every allowed file', async () => {
    for (const rel of READABLE) {
      const result = await executeAldenTool('read_file', { path: rel });
      assert.match(String(result.data.content), new RegExp(MARK), rel);
    }
  });

  test('refuses every excluded path, escape and secret content', async (t) => {
    const inputs = [...REFUSED, '/etc/passwd', path.join(root, 'server/a.ts'), '../outside/secret.md', 'server/../../outside/secret.md', 'server/leak.ts'];
    if (symlinkMade) inputs.push('server/out/secret.md');
    for (const input of inputs) {
      const result = await executeAldenTool('read_file', { path: input });
      assert.equal(result.data.content, undefined, input);
      assert.ok(result.data.refused === 'read_path_refused' || result.data.refused === 'secret_content', `${input}: ${JSON.stringify(result.data)}`);
    }
    if (!symlinkMade) t.diagnostic('symlink case skipped: symlinks unavailable');
  });
});

describe('list_directory', () => {
  test('the workspace lists only the readable root', async () => {
    const result = await executeAldenTool('list_directory', { path: '.' });
    assert.deepEqual(result.data.directories, ['.agents/', '.github/', 'broker/', 'client/', 'config/', 'docs/', 'server/', 'shared/']);
    assert.deepEqual(result.data.files, ['drizzle.config.ts', 'package.json', 'render.yaml']);
  });

  test('ancestors show only their readable children; entries are filtered; symlinks are not listed', async () => {
    assert.deepEqual((await executeAldenTool('list_directory', { path: '.agents' })).data.directories, ['memory/', 'skills/']);
    assert.deepEqual((await executeAldenTool('list_directory', { path: '.github' })).data.files, []);
    const server = (await executeAldenTool('list_directory', { path: 'server' })).data;
    assert.ok(!server.files.includes('.env') && !server.files.includes('key.pem') && !server.files.includes('id_rsa'));
    assert.ok(!server.directories.includes('out/'), 'symlink not listed');
    const config = (await executeAldenTool('list_directory', { path: 'server/config' })).data;
    assert.deepEqual(config.files, []);
  });

  test('refuses excluded directories and escapes', async () => {
    for (const input of ['.local', 'node_modules', 'attached_assets', '../outside', '/']) {
      assert.equal((await executeAldenTool('list_directory', { path: input })).data.refused, 'read_path_refused', input);
    }
  });
});

describe('search_code and search_multi', () => {
  const EXPECTED = READABLE.slice().sort();

  async function searchedFiles(args: Record<string, unknown>): Promise<{ files: string[]; note?: string }> {
    const result = await executeAldenTool('search_code', { pattern: MARK, ...args });
    assert.equal(result.data.error, undefined, JSON.stringify(result.data));
    const raw: string[] = result.data.matches
      ? result.data.matches.map((m: any) => m.file)
      : String(result.data.results ?? '').split('\n').filter((l) => /:\d+:/.test(l)).map((l) => l.split(/:\d+:/)[0]);
    return { files: [...new Set(raw)].sort(), note: result.data.note };
  }

  for (const mode of ['rg', 'fallback'] as const) {
    test(`${mode}: every result path passes the policy, in both output modes`, async (t) => {
      setRg(mode === 'fallback' ? false : null);
      try {
        const plain = await searchedFiles({});
        if (mode === 'rg' && /fallback/.test(plain.note ?? '')) {
          if (process.env.CI) assert.fail('CI installs ripgrep, so the rg path must run there');
          return t.skip('rg not installed here');
        }
        assert.deepEqual(plain.files, EXPECTED);
        const context = await searchedFiles({ context_lines: 1 });
        assert.deepEqual(context.files, plain.files);
      } finally {
        setRg(null);
      }
    });
  }

  test('the search directory is resolved under the policy', async (t) => {
    setRg(false);
    try {
      assert.deepEqual((await searchedFiles({ directory: '.agents' })).files, ['.agents/memory/m.md', '.agents/skills/k.md']);
      for (const directory of ['../outside', '.local', 'attached_assets', '/']) {
        const result = await executeAldenTool('search_code', { pattern: MARK, directory });
        assert.match(String(result.data.error), /^Search refused: /, directory);
      }
      if (symlinkMade) assert.match(String((await executeAldenTool('search_code', { pattern: MARK, directory: 'server/out' })).data.error), /^Search refused: /);
      else t.diagnostic('symlink case skipped');
      const multi = await executeAldenTool('search_multi', { searches: [{ pattern: MARK }, { pattern: MARK, directory: '../outside' }] });
      const files = multi.data.results[0].matches.map((m: any) => m.file);
      assert.ok(!files.includes('server/leak.ts') && !files.some((f: string) => f.includes('.env')), JSON.stringify(files));
      assert.match(String(multi.data.results[1].error), /^Search refused: /);
    } finally {
      setRg(null);
    }
  });
});
