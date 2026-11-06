/**
 * F14 (live-test-1 debrief, design note 135fe51b rev 2): turn ids must never go
 * backwards for a client that is still listening.
 *
 * useStreamingVoice ignores any response_complete whose turnId is below the highest
 * it has seen. The server used to reset currentTurnId to 0 on a Gemini Live
 * reconnect, so every post-reconnect response_complete looked stale until the
 * numbers caught up, and pre- and post-reconnect turns shared ids. A brand-new
 * server session does start again at 0, so the client resets on session_started.
 *
 * Run with:
 *   npx tsx --test client/src/components/turn-id-continuity.test.ts
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const session = readFileSync(new URL('../../../server/services/gemini-live-session.ts', import.meta.url), 'utf8');
const hook = readFileSync(new URL('../hooks/useStreamingVoice.ts', import.meta.url), 'utf8');

describe('server: reconnects advance the turn id', () => {
  it('never resets currentTurnId to 0', () => {
    assert.doesNotMatch(session, /this\.currentTurnId\s*=\s*0\s*;/);
  });

  it('both reconnect reset blocks advance it and keep the session copy in step', () => {
    const advances = session.match(/this\.liveSession = null;\s*\n(?:\s*\/\/[^\n]*\n)*\s*this\.session\.currentTurnId = \+\+this\.currentTurnId;/g) ?? [];
    assert.equal(advances.length, 2, 'auto-reconnect (onclose) and retryConnection');
  });

  it('the stale guard it protects is still the one the client applies', () => {
    assert.match(hook, /msg\.turnId < currentTurnIdRef\.current/);
  });
});

describe('client: a new server session restarts the turn numbering', () => {
  it('handleSessionStart resets currentTurnIdRef to 0', () => {
    const start = hook.indexOf('const handleSessionStart = useCallback(');
    assert.ok(start >= 0);
    const body = hook.slice(start, hook.indexOf('}, []);', start));
    assert.match(body, /currentTurnIdRef\.current = 0;/);
  });
});
