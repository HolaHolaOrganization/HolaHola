import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { decide } from '../src/authorize.ts';
import { gitBlobSha, parsePolicy, PolicyLoader, REPOSITORY_ID } from '../src/policy.ts';

// The committed broker/policy.json is the broker's only authority source.
// Phase 4 starts it CLOSED with no actors: the deployed broker can then be
// observed against real GitHub while refusing every request. Moving out of
// closed, or adding an actor's signing key, is a separate founder-approved PR
// to this founder-owned file.

const bytes = new Uint8Array(readFileSync(new URL('../policy.json', import.meta.url)));

describe('committed broker/policy.json', () => {
  test('parses, names this repository, and is closed with no actors or qualification entries', () => {
    const policy = parsePolicy(bytes);
    assert.equal(policy.repositoryId, REPOSITORY_ID);
    assert.equal(policy.state, 'closed');
    assert.equal(policy.actors.size, 0);
    assert.deepEqual(policy.qualification, []);
  });

  test('its epoch is the git blob sha of the committed bytes', () => {
    assert.match(parsePolicy(bytes).epoch, /^[0-9a-f]{40}$/);
    assert.equal(parsePolicy(bytes).epoch, gitBlobSha(bytes));
  });

  test('every request is refused under it', async () => {
    const loader = new PolicyLoader({ fetch: async () => ({ bytes, blobSha: gitBlobSha(bytes) }) });
    const decision = await decide({ envelope: {}, signature: 'x', payload: {} }, () => loader, Date.now);
    assert.equal(decision.decision, 'deny');
  });
});
