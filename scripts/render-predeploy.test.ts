import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolveDirectUrl, toDirectNeonUrl } from './render-predeploy';

const POOLED = 'postgresql://user:p%40ss@ep-cool-name-123456-pooler.us-east-2.aws.neon.tech/neondb?sslmode=require&channel_binding=require';
const DIRECT = 'postgresql://user:p%40ss@ep-cool-name-123456.us-east-2.aws.neon.tech/neondb?sslmode=require&channel_binding=require';

test('drops the -pooler suffix and keeps credentials, database and query', () => {
  assert.deepEqual(toDirectNeonUrl(POOLED), { url: DIRECT, changed: true });
});

test('leaves an already-direct URL unchanged', () => {
  assert.deepEqual(toDirectNeonUrl(DIRECT), { url: DIRECT, changed: false });
});

test('only the first host label is considered', () => {
  const url = 'postgres://u:p@ep-a.pooler-region.example.com/db';
  assert.deepEqual(toDirectNeonUrl(url), { url, changed: false });
});

test('rejects non-postgres and malformed URLs without echoing them', () => {
  assert.throws(() => toDirectNeonUrl('https://secret-host/x'), (err: Error) => !err.message.includes('secret-host'));
  assert.throws(() => toDirectNeonUrl('not a url secret'), (err: Error) => !err.message.includes('secret'));
});

test('resolution order: explicit direct URL, then derived from pooled, else fail', () => {
  assert.deepEqual(resolveDirectUrl({ NEON_DIRECT_DATABASE_URL: DIRECT, NEON_SHARED_DATABASE_URL: POOLED }),
    { url: DIRECT, source: 'NEON_DIRECT_DATABASE_URL' });
  assert.deepEqual(resolveDirectUrl({ NEON_SHARED_DATABASE_URL: POOLED }), { url: DIRECT, source: 'derived-from-pooled' });
  assert.deepEqual(resolveDirectUrl({ NEON_SHARED_DATABASE_URL: DIRECT }), { url: DIRECT, source: 'already-direct' });
  assert.throws(() => resolveDirectUrl({}), /NEON_SHARED_DATABASE_URL is required/);
  assert.throws(() => resolveDirectUrl({ NEON_SHARED_DATABASE_URL: '   ' }), /NEON_SHARED_DATABASE_URL is required/);
});

test('render.yaml wires this script as the pre-deploy command', () => {
  const blueprint = readFileSync(new URL('../render.yaml', import.meta.url), 'utf8');
  assert.match(blueprint, /^\s+preDeployCommand: npx tsx scripts\/render-predeploy\.ts\s*$/m);
});
