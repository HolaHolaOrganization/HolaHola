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
  const url = 'postgres://u:p@ep-a.pooler-region.aws.neon.tech/db';
  assert.deepEqual(toDirectNeonUrl(url), { url, changed: false });
});

test('a -pooler host outside neon.tech is never rewritten', () => {
  const url = 'postgres://u:p@db-pooler.example.com/db';
  assert.deepEqual(toDirectNeonUrl(url), { url, changed: false });
  const lookalike = 'postgres://u:p@ep-a-pooler.neon.tech.evil.example/db';
  assert.deepEqual(toDirectNeonUrl(lookalike), { url: lookalike, changed: false });
});

test('the derived target keeps the app database identity: same port, database, credentials', () => {
  const pooled = 'postgresql://app:pw@ep-x-1-pooler.eu-central-1.aws.neon.tech:5432/appdb?sslmode=require';
  const direct = new URL(toDirectNeonUrl(pooled).url);
  const app = new URL(pooled);
  assert.equal(direct.hostname, 'ep-x-1.eu-central-1.aws.neon.tech');
  assert.equal(direct.port, app.port);
  assert.equal(direct.pathname, app.pathname);
  assert.equal(direct.username, app.username);
  assert.equal(direct.password, app.password);
  assert.equal(direct.search, app.search);
});

test('rejects non-postgres and malformed URLs without echoing them', () => {
  assert.throws(() => toDirectNeonUrl('https://secret-host/x'), (err: Error) => !err.message.includes('secret-host'));
  assert.throws(() => toDirectNeonUrl('not a url secret'), (err: Error) => !err.message.includes('secret'));
});

test('the migration target comes only from the app URL; a separate override is ignored', () => {
  const unrelated = 'postgresql://fixture:unused@ep-unrelated.us-east-2.aws.neon.tech/otherdb';
  const resolved = resolveDirectUrl({ NEON_SHARED_DATABASE_URL: POOLED, NEON_DIRECT_DATABASE_URL: unrelated });
  assert.deepEqual(resolved, { url: DIRECT, source: 'derived-from-pooled' });
  assert.throws(() => resolveDirectUrl({ NEON_DIRECT_DATABASE_URL: unrelated }), /NEON_SHARED_DATABASE_URL is required/);
});

test('resolution: derived from pooled, already direct, else fail', () => {
  assert.deepEqual(resolveDirectUrl({ NEON_SHARED_DATABASE_URL: POOLED }), { url: DIRECT, source: 'derived-from-pooled' });
  assert.deepEqual(resolveDirectUrl({ NEON_SHARED_DATABASE_URL: DIRECT }), { url: DIRECT, source: 'already-direct' });
  assert.throws(() => resolveDirectUrl({}), /NEON_SHARED_DATABASE_URL is required/);
  assert.throws(() => resolveDirectUrl({ NEON_SHARED_DATABASE_URL: '   ' }), /NEON_SHARED_DATABASE_URL is required/);
});

test('the script source has no second database-URL input', () => {
  const source = readFileSync(new URL('./render-predeploy.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /env\.NEON_DIRECT_DATABASE_URL/);
});

test('render.yaml wires this script as the pre-deploy command', () => {
  const blueprint = readFileSync(new URL('../render.yaml', import.meta.url), 'utf8');
  assert.match(blueprint, /^\s+preDeployCommand: npx tsx scripts\/render-predeploy\.ts\s*$/m);
});
