/** brief_new_actor briefing text: catalog operations and registered capabilities stay separate facts. Synthetic only. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { activeRegistrationsFor, buildActorBriefing } from '../services/alden-actor-briefing';

const operations = [
  { id: 'coordination.feed', title: 'Read Coordination Feed', purpose: 'Read ledger events.' },
  { id: 'production.readiness', title: 'Check Production Readiness', purpose: 'Check startup gates.' },
];
const registration = (runtimeId: string, over: Partial<{ actor: string; enabled: boolean; revokedAt: string | null; capabilities: string[] }> = {}) => ({
  runtimeId, actor: 'luca-antigravity', capabilities: ['coordination:write', 'coordination:read'], enabled: true, revokedAt: null, ...over,
});

test('only enabled, unrevoked registrations of the same actor are listed, in runtime-id order', () => {
  const all = [
    registration('b-live'),
    registration('a-live'),
    registration('disabled', { enabled: false }),
    registration('revoked', { revokedAt: '2026-10-26T00:00:00.000Z' }),
    registration('other-actor', { actor: 'luca-gemini' }),
  ];
  assert.deepEqual(activeRegistrationsFor('luca-antigravity', all).map((r) => r.runtimeId), ['a-live', 'b-live']);
});

test('the briefing lists catalog operations and registered capabilities under separate headings', () => {
  const text = buildActorBriefing(operations, [registration('rt-1', { capabilities: ['observation:read', 'coordination:inbox:ack'] })]);
  const catalog = text.indexOf('verified against the shared operations catalog');
  const registered = text.indexOf('Registered runtime capabilities');
  assert.ok(catalog >= 0 && registered > catalog);
  assert.match(text.slice(catalog, registered), /Read Coordination Feed \(coordination\.feed\)/);
  assert.match(text.slice(registered), /- rt-1: coordination:inbox:ack, observation:read/);
  assert.doesNotMatch(text.slice(catalog, registered), /inbox:ack/, 'registration facts are not mixed into the catalog list');
  assert.match(text, /coordination-new-actor-onboarding\.md/);
});

test('an actor with no active registration is told plainly that it cannot authenticate yet', () => {
  assert.match(buildActorBriefing(operations, []), /- None\. This actor has no enabled, unrevoked runtime registration/);
});

test('the briefing carries no registration secrets or bootstrap material', () => {
  const withExtras = { ...registration('rt-1'), bootstrapHash: 'deadbeef'.repeat(8), displayName: 'secret-looking' };
  const text = buildActorBriefing(operations, activeRegistrationsFor('luca-antigravity', [withExtras]));
  assert.doesNotMatch(text, /deadbeef|bootstrap/i);
});
