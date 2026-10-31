/**
 * founderPresent is the server's only marker that David is in an Alden
 * conversation (wake design r12). It unlocks the chat-only tools, so it must
 * be set in exactly one place, the founder-only /api/alden/message route, and
 * never be taken from a request.
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import test from 'node:test';

const SERVER = join(process.cwd(), 'server');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === 'node_modules' ? [] : sourceFiles(path);
    return /\.(ts|mts|js|mjs)$/.test(name) && !/\.test\.(ts|mts|js|mjs)$/.test(name) ? [path] : [];
  });
}

const files = sourceFiles(SERVER).map((path) => ({ path: relative(process.cwd(), path).split(sep).join('/'), text: readFileSync(path, 'utf8') }));

test('founderPresent is set to true in exactly one place: the founder chat route', () => {
  const setters = files.flatMap(({ path, text }) => [...text.matchAll(/founderPresent:\s*true/g)].map((match) => ({ path, index: match.index! })));
  assert.equal(setters.length, 1, JSON.stringify(setters.map((s) => s.path)));
  const [{ path, index }] = setters;
  assert.equal(path, 'server/routes.ts');
  const routes = files.find((file) => file.path === 'server/routes.ts')!.text;
  const route = routes.lastIndexOf('app.post(', index);
  assert.match(routes.slice(route, routes.indexOf('\n', route)), /^app\.post\("\/api\/alden\/message", isAuthenticated, loadAuthenticatedUser\(storage\), requireFounder,/);
  assert.equal(routes.indexOf('app.post(', route + 1) > index || routes.indexOf('app.post(', route + 1) === -1, true, 'the setter is inside that handler');
});

test('founderPresent is never read from a request or passed through from one', () => {
  for (const { path, text } of files) {
    assert.doesNotMatch(text, /req(uest)?\.(body|query|params|headers)\??\.founderPresent/, path);
    // An internal pass-through (founderPresent: params.founderPresent) is fine; a request-derived value is not.
    assert.doesNotMatch(text, /founderPresent:\s*(req|request|body|args|input)\b/, path);
    assert.doesNotMatch(text, /\{[^}]*\bfounderPresent\b[^}]*\}\s*=\s*(req|request)\.(body|query)/, path);
  }
});
