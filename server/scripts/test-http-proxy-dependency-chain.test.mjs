import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import test from 'node:test';

const require = createRequire(import.meta.url);
const lock = JSON.parse(await readFile(new URL('../../package-lock.json', import.meta.url)));

test('both Express dependency paths resolve the patched proxy-addr without an app major upgrade', () => {
  assert.match(require('express/package.json').version, /^4\./);
  const parents = Object.entries(lock.packages)
    .filter(([, entry]) => entry.dependencies?.['proxy-addr']);
  assert.equal(parents.length, 2);
  for (const [parent] of parents) {
    const fromParent = createRequire(new URL(`../../${parent}/package.json`, import.meta.url));
    assert.equal(fromParent('proxy-addr/package.json').version, '2.0.8');
  }
  for (const [name, entry] of Object.entries(lock.packages)) {
    if (name.endsWith('/proxy-addr')) assert.equal(entry.version, '2.0.8');
  }
});

for (const [label, parent] of [
  ['application Express 4', '../../package.json'],
  ['MCP SDK Express 5', '../../node_modules/@modelcontextprotocol/sdk/package.json'],
]) {
  test(`${label}: HTTP routing, JSON, query parsing and trusted proxy boundaries`, async () => {
    // Resolve by package location: the SDK exports map hides its dependencies.
    const factory = createRequire(new URL(parent, import.meta.url))('express');
    const app = factory();
    app.set('trust proxy', 'loopback');
    app.use(factory.json());
    app.post('/echo/:id', (req, res) => {
      res.json({
        id: req.params.id, query: req.query, body: req.body,
        ip: req.ip, ips: req.ips, protocol: req.protocol,
      });
    });
    app.use((error, req, res, next) => res.status(error.status || 500).json({ error: error.type }));
    const server = createServer(app);
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    try {
      const response = await fetch(`http://127.0.0.1:${server.address().port}/echo/123?q=ok`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-forwarded-for': '198.51.100.7, 203.0.113.9',
          'x-forwarded-proto': 'https',
        },
        body: JSON.stringify({ hello: 'world' }),
      });
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), {
        id: '123', query: { q: 'ok' }, body: { hello: 'world' },
        ip: '203.0.113.9', ips: ['203.0.113.9'], protocol: 'https',
      });
      const invalid = await fetch(`http://127.0.0.1:${server.address().port}/echo/123`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: '{',
      });
      assert.equal(invalid.status, 400);
      const missing = await fetch(`http://127.0.0.1:${server.address().port}/missing`);
      assert.equal(missing.status, 404);
    } finally {
      server.closeAllConnections();
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
}
