// Run personally, not through a testing agent. Every API request is intercepted.
// Authentication and decisions are synthetic; this does NOT prove real sign-in.
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

const base = process.argv[2] ?? 'http://127.0.0.1:5000';
const founderSource = await readFile('client/src/pages/admin/CommandCenter.tsx', 'utf8');
const founderId = /const FOUNDER_USER_ID = '([^']+)'/.exec(founderSource)?.[1];
assert.ok(founderId, 'Fixture must follow the actual founder-only UI gate.');
const artifact = 'f'.repeat(64), digest = 'e'.repeat(64);
const descriptor = { purpose: 'cross-tool-promote', repository: 'github:davidwmcintosh/holahola', branch: 'fixture/review', candidateCommit: 'a'.repeat(40) };
const contextDigest = createHash('sha256').update(JSON.stringify(Object.fromEntries(Object.entries(descriptor).sort(([a], [b]) => a.localeCompare(b))))).digest('hex');
const verified = { status: 'verified', contextDigest, computedDigest: contextDigest, descriptor };
const definition = {
  title: 'Synthetic ownership browser fixture', purpose: 'Review the selected fixture document.',
  scope: ['Inspect the fixture task.'], exclusions: ['No production writes.'],
  creatorActor: 'luca-replit', sourceThread: 'a0000000-0000-4000-8000-000000000001',
  sourceKind: 'hat', repositoryIdentity: 'github:fixture/project', startingCommit: 'b'.repeat(40),
};
const scope = { status: 'verified', taskRef: '123', submittedArtifactSha256: artifact, registeredArtifactSha256: artifact, definition };
const id = n => `a0000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const fixture = (n, extra = {}) => ({
  id: id(n), taskRef: String(120 + n), intendedActor: 'luca-replit',
  artifactSha256: artifact, keyFingerprint: digest, status: 'pending',
  createdAt: new Date(Date.now() - 60000).toISOString(),
  expiresAt: new Date(Date.now() + 600000).toISOString(),
  scopeContext: scope, receipt: null, ...extra,
});
let records = [
  fixture(1, { contextDigest, promotionContext: verified }),
  fixture(2, { contextDigest, promotionContext: { status: 'descriptor_missing', contextDigest } }),
  fixture(3, { contextDigest, promotionContext: { status: 'storage_unavailable', contextDigest } }),
  fixture(4, { contextDigest, promotionContext: { status: 'hash_mismatch', contextDigest } }),
  fixture(5, { scopeContext: { ...scope, status: 'hash_mismatch', definition: undefined } }),
  fixture(6, { scopeContext: { ...scope, status: 'registry_unavailable', definition: undefined } }),
  fixture(7, { scopeContext: { ...scope, status: 'unregistered_bootstrap', definition: undefined } }),
  fixture(8, { expiresAt: new Date(Date.now() - 60000).toISOString() }),
  fixture(9, { status: 'approved', receipt: { id: id(109), status: 'active', expiresAt: new Date(Date.now() + 600000).toISOString() } }),
  fixture(10, { status: 'approved', receipt: { id: id(110), status: 'revoked', revokedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 600000).toISOString() } }),
  fixture(11, { status: 'rejected' }),
  fixture(12),
];
const decisions = [], blockedWrites = [], errors = [], checks = [];
let fetchCount = 0, listMode = 'normal', failDecision = false;
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const page = await context.newPage();
await context.route('**/socket.io/**', route => route.abort());
await context.routeWebSocket('**/*', socket => socket.close());
page.on('pageerror', error => errors.push(error.message));
await context.route('**/api/**', async route => {
  const request = route.request(), path = new URL(request.url()).pathname;
  const fulfill = (data, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(data) });
  if (path === '/api/auth/user' && request.method() === 'GET') return fulfill({ id: founderId, role: 'admin', firstName: 'Fixture', lastName: 'User', email: 'fixture@example.invalid', tosAcceptedAt: new Date().toISOString() });
  if (path === '/api/task-ownership/challenges' && request.method() === 'GET') {
    fetchCount++;
    if (listMode === 'error') return fulfill({ error: 'Synthetic unavailable response' }, 503);
    return fulfill(listMode === 'empty' ? [] : records);
  }
  const action = /^\/api\/task-ownership\/(?:challenges|receipts)\/([^/]+)\/(approve|reject|revoke)$/.exec(path);
  if (action && request.method() === 'POST') {
    const row = records.find(item => item.id === action[1] || item.receipt?.id === action[1]);
    assert.ok(row, 'Only synthetic fixture IDs may be decided.');
    decisions.push({ action: action[2], id: action[1], body: request.postDataJSON() });
    if (failDecision) return fulfill({ error: 'Synthetic stale challenge refusal' }, 409);
    if (action[2] === 'revoke') row.receipt = { ...row.receipt, status: 'revoked', revokedAt: new Date().toISOString() };
    else {
      row.status = action[2] === 'approve' ? 'approved' : 'rejected';
      row.decidedAt = new Date().toISOString();
    }
    return fulfill({ status: row.status });
  }
  if (!['GET', 'HEAD'].includes(request.method())) blockedWrites.push({ method: request.method(), path });
  // NEVER continue an API route to the actual server, even an unrecognized GET.
  return fulfill({ error: 'Unmocked API blocked by fixture boundary' }, 503);
});
const card = n => page.getByTestId(`task-ownership-challenge-${id(n)}`);
const button = (action, n) => page.getByTestId(`button-${action}-${id(n)}`);
const visible = async locator => { await locator.waitFor({ state: 'visible' }); assert.equal(await locator.isVisible(), true); };
const disabled = async (action, n, expected = true) => assert.equal(await button(action, n).isDisabled(), expected);
const checked = label => checks.push(label);
try {
  await page.goto(`${base}/admin`);
  await visible(page.getByText('System', { exact: true }));
  await page.getByRole('tab', { name: 'Ownership', exact: true }).click();
  await visible(card(1));
  assert.match(await card(1).innerText(), /Included scope|Exclusions/);
  assert.match(await card(1).innerText(), /fixture\/review/);
  assert.match(await card(1).innerText(), new RegExp(descriptor.candidateCommit));
  assert.match(await card(1).innerText(), /Task starting commit/);
  checked('Founder-fixture System → Ownership navigation, exact task scope and candidate fields');
  for (const n of [2, 3, 4]) await disabled('approve', n);
  for (const n of [2, 3, 4]) await disabled('reject', n, false);
  checked('Missing, unavailable and mismatched promotion metadata blocks approve but not reject');
  for (const n of [5, 6, 7]) {
    await disabled('approve', n, false); // Registry projection remains informative, not a new grant/gate.
    assert.match(await card(n).innerText(), /not grant|not independently|unavailable|Bootstrap/i);
  }
  checked('Registry mismatch/unavailable/bootstrap warnings retain existing context-free decision semantics');
  await disabled('approve', 8); await disabled('reject', 8);
  await disabled('approve', 9); await disabled('revoke', 9, false);
  await disabled('revoke', 10); await disabled('approve', 11); await disabled('reject', 11);
  checked('Expired, approved, rejected and revoked action states');
  await button('approve', 1).click();
  const dialog = page.getByTestId('task-ownership-confirmation');
  await visible(dialog);
  assert.match(await dialog.innerText(), /fixture\/review/);
  assert.match(await dialog.innerText(), /No production writes/);
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  assert.equal(decisions.length, 0);
  checked('Confirmation repeats exact scope/candidate; cancel sends no decision');
  await button('approve', 1).click();
  await page.getByRole('button', { name: /^Confirm / }).click();
  await dialog.waitFor({ state: 'hidden' });
  assert.equal(decisions.at(-1).action, 'approve');
  await disabled('approve', 1);
  checked('Fixture approval updates/refetches the card');
  await button('reject', 2).click();
  await page.getByRole('button', { name: /^Confirm / }).click();
  await dialog.waitFor({ state: 'hidden' });
  assert.equal(decisions.at(-1).action, 'reject');
  await button('revoke', 9).click();
  await page.getByRole('button', { name: /^Confirm / }).click();
  await dialog.waitFor({ state: 'hidden' });
  await disabled('revoke', 9);
  checked('Fixture rejection and receipt revocation update/refetch');
  failDecision = true;
  await button('approve', 12).click();
  await page.getByRole('button', { name: /^Confirm / }).click();
  await visible(dialog.getByText('Decision failed'));
  assert.equal(await dialog.isVisible(), true);
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  failDecision = false;
  checked('Server refusal remains visible inside the confirmation');
  await button('approve', 12).click();
  await page.clock.setFixedTime(new Date(Date.now() + 700000));
  const beforeExpiry = decisions.length;
  await page.getByRole('button', { name: /^Confirm / }).click();
  assert.equal(decisions.length, beforeExpiry);
  await dialog.waitFor({ state: 'hidden' });
  checked('Expiry after opening the dialog blocks submission');
  listMode = 'empty';
  await page.getByRole('button', { name: /Refresh/ }).click();
  await visible(page.getByTestId('task-ownership-empty'));
  checked('Refresh and empty state');
  listMode = 'error';
  await page.getByRole('button', { name: /Refresh/ }).click();
  await visible(page.getByTestId('task-ownership-error'));
  checked('Unavailable list error state');
  listMode = 'normal';
  await page.getByRole('button', { name: /Refresh/ }).click();
  await visible(card(1));
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 2), 'Mobile layout must not overflow horizontally.');
  checked('390px mobile layout');
  await mkdir('generated-artifacts/ownership-ui', { recursive: true });
  await page.screenshot({ path: 'generated-artifacts/ownership-ui/mobile.png' });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.screenshot({ path: 'generated-artifacts/ownership-ui/desktop.png' });
  assert.deepEqual(errors, [], 'No uncaught browser errors.');
  await writeFile('generated-artifacts/ownership-ui/result.json', JSON.stringify({ fixtureAuthentication: true, realSignInVerified: false, realAPICalls: 0, decisions, blockedWrites, fetchCount, checks }, null, 2));
  console.log(JSON.stringify({ passed: checks.length, realAPICalls: 0, fixtureDecisions: decisions.length, blockedUnmockedWrites: blockedWrites.length }));
} catch (error) {
  console.error(JSON.stringify({ failed: String(error.message), url: page.url(), title: await page.title(), visibleText: (await page.locator('body').innerText()).slice(0, 2500), errors, checks }, null, 2));
  throw error;
} finally { await browser.close(); }
