import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  claimPath, type ClaimEntry, EXECUTION_DEADLINE_MS, executeOnce, type Ledger, LedgerContendedError, outcomePath,
  type Reconciler,
} from '../src/claims.ts';

const NOW = 1_800_000_000_000;
const DIGEST_A = 'a'.repeat(64);
const DIGEST_B = 'b'.repeat(64);

/**
 * In-memory ledger with real compare-and-swap semantics. Every call yields to
 * the event loop first, so concurrent executeOnce calls genuinely interleave
 * between reading the head and committing.
 */
class MemoryLedger implements Ledger {
  private commits: Array<{ id: string; files: Map<string, string> }> = [{ id: 'c0', files: new Map() }];
  failCommit: (files: Record<string, string>) => boolean = () => false;

  private async tick(): Promise<void> {
    await new Promise((resolve) => setImmediate(resolve));
  }
  private tip() {
    return this.commits[this.commits.length - 1];
  }
  async head(): Promise<string> {
    await this.tick();
    return this.tip().id;
  }
  async read(head: string, path: string): Promise<string | null> {
    await this.tick();
    const commit = this.commits.find((candidate) => candidate.id === head);
    if (!commit) throw new Error(`unknown head ${head}`);
    return commit.files.get(path) ?? null;
  }
  async commit(expectedHead: string, files: Record<string, string>): Promise<{ ok: true; head: string } | { ok: false }> {
    await this.tick();
    if (this.failCommit(files)) throw new Error('ledger write failed');
    if (this.tip().id !== expectedHead) return { ok: false };
    const next = new Map(this.tip().files);
    for (const [path, content] of Object.entries(files)) {
      if (next.has(path)) throw new Error(`refusing to overwrite ${path}`);
      next.set(path, content);
    }
    const id = `c${this.commits.length}`;
    this.commits.push({ id, files: next });
    return { ok: true, head: id };
  }
  file(path: string): unknown {
    const content = this.tip().files.get(path);
    return content === undefined ? null : JSON.parse(content);
  }
}

function entry(operationId = 'op-0000000000000001', digest = DIGEST_A): ClaimEntry {
  return { actor: 'luca-claude-code', operationId, digest, operation: 'pr.comment', pr: 48, headSha: 'f'.repeat(40), policyEpoch: 'e'.repeat(40) };
}

function counter() {
  let count = 0;
  return {
    get count() { return count; },
    effect: async () => { count += 1; return { status: 'succeeded' as const, result: { commentId: 7 } }; },
  };
}

const neverReconcile: Reconciler = async () => { throw new Error('reconcile must not run'); };

describe('unique-executor operation claims', () => {
  test('two concurrent instances with the same (actor, operationId): exactly one executes', async () => {
    const ledger = new MemoryLedger();
    const effects = counter();
    const results = await Promise.all([
      executeOnce(ledger, entry(), effects.effect, neverReconcile, () => NOW),
      executeOnce(ledger, entry(), effects.effect, neverReconcile, () => NOW),
    ]);
    assert.equal(effects.count, 1);
    assert.deepEqual(results.map((result) => result.kind).sort(), ['executed', 'pending']);
  });

  test('rolling-deploy overlap: 5 instances x 20 operations, no duplicate effects', async () => {
    const ledger = new MemoryLedger();
    const effects = counter();
    const ids = Array.from({ length: 20 }, (_, index) => `op-rolling-${String(index).padStart(6, '0')}`);
    await Promise.all(ids.flatMap((id) => Array.from({ length: 5 }, () =>
      executeOnce(ledger, entry(id), effects.effect, neverReconcile, () => NOW).catch((error) => {
        if (!(error instanceof LedgerContendedError)) throw error;
      }))));
    assert.ok(effects.count <= 20, `effects ${effects.count}`);
    // Every operation that executed has exactly one outcome; replays only read it back.
    const replay = counter();
    for (const id of ids) {
      const result = await executeOnce(ledger, entry(id), replay.effect, neverReconcile, () => NOW + EXECUTION_DEADLINE_MS - 1);
      assert.ok(result.kind === 'recorded' || result.kind === 'pending' || result.kind === 'executed');
    }
    assert.equal(effects.count + replay.count, 20);
  });

  test('a replay after success returns the recorded outcome without executing', async () => {
    const ledger = new MemoryLedger();
    const effects = counter();
    const first = await executeOnce(ledger, entry(), effects.effect, neverReconcile, () => NOW);
    assert.equal(first.kind, 'executed');
    const again = await executeOnce(ledger, entry(), effects.effect, neverReconcile, () => NOW + 10 * EXECUTION_DEADLINE_MS);
    assert.equal(again.kind, 'recorded');
    assert.equal(effects.count, 1);
  });

  test('the same operation id with a different digest is denied', async () => {
    const ledger = new MemoryLedger();
    const effects = counter();
    await executeOnce(ledger, entry(), effects.effect, neverReconcile, () => NOW);
    const conflict = await executeOnce(ledger, entry(undefined, DIGEST_B), effects.effect, neverReconcile, () => NOW);
    assert.deepEqual(conflict, { kind: 'digest_conflict' });
    assert.equal(effects.count, 1);
  });

  test('crash after claim, before effect: pending, then uncertain, reconciled to not_applied; a retry needs a new id', async () => {
    const ledger = new MemoryLedger();
    const crashed = await executeOnce(ledger, entry(), async () => { throw new Error('process died'); }, neverReconcile, () => NOW);
    assert.equal(crashed.kind, 'uncertain');
    assert.ok(ledger.file(claimPath('luca-claude-code', 'op-0000000000000001')));
    assert.equal(ledger.file(outcomePath('luca-claude-code', 'op-0000000000000001')), null);

    const effects = counter();
    const early = await executeOnce(ledger, entry(), effects.effect, neverReconcile, () => NOW + EXECUTION_DEADLINE_MS - 1);
    assert.equal(early.kind, 'pending');

    let reconciles = 0;
    const reconciled = await executeOnce(ledger, entry(), effects.effect, async () => { reconciles += 1; return { status: 'not_applied', result: {} }; }, () => NOW + EXECUTION_DEADLINE_MS);
    assert.equal(reconciled.kind, 'recorded');
    assert.equal(reconciled.kind === 'recorded' && reconciled.outcome.status, 'not_applied');
    assert.equal(reconciled.kind === 'recorded' && reconciled.outcome.reconciled, true);
    assert.equal(reconciles, 1);

    const sameId = await executeOnce(ledger, entry(), effects.effect, neverReconcile, () => NOW + 2 * EXECUTION_DEADLINE_MS);
    assert.equal(sameId.kind, 'recorded');
    assert.equal(effects.count, 0, 'the same operation id is never re-executed');

    const retry = await executeOnce(ledger, entry('op-0000000000000002'), effects.effect, neverReconcile, () => NOW + 2 * EXECUTION_DEADLINE_MS);
    assert.equal(retry.kind, 'executed');
    assert.equal(effects.count, 1);
  });

  test('crash after effect, before outcome: reconciled to applied, no second effect', async () => {
    const ledger = new MemoryLedger();
    let applied = 0;
    await executeOnce(ledger, entry(), async () => { applied += 1; throw new Error('died after sending'); }, neverReconcile, () => NOW);
    const result = await executeOnce(ledger, entry(), async () => { applied += 1; return { status: 'succeeded', result: {} }; },
      async () => ({ status: 'applied', result: { commentId: 7 } }), () => NOW + EXECUTION_DEADLINE_MS);
    assert.equal(applied, 1);
    assert.equal(result.kind === 'recorded' && result.outcome.status, 'applied');
  });

  test('outcome write failure: uncertain, then reconciled', async () => {
    const ledger = new MemoryLedger();
    const effects = counter();
    ledger.failCommit = (files) => Object.keys(files).some((path) => path.startsWith('outcomes/'));
    const first = await executeOnce(ledger, entry(), effects.effect, neverReconcile, () => NOW);
    assert.equal(first.kind, 'uncertain');
    ledger.failCommit = () => false;
    const later = await executeOnce(ledger, entry(), effects.effect, async () => ({ status: 'applied', result: { commentId: 7 } }), () => NOW + EXECUTION_DEADLINE_MS);
    assert.equal(later.kind === 'recorded' && later.outcome.status, 'applied');
    assert.equal(effects.count, 1);
  });

  test('ambiguous reconciliation stays uncertain and records nothing', async () => {
    const ledger = new MemoryLedger();
    await executeOnce(ledger, entry(), async () => { throw new Error('unknown'); }, neverReconcile, () => NOW);
    const result = await executeOnce(ledger, entry(), counter().effect, async () => ({ status: 'ambiguous' }), () => NOW + EXECUTION_DEADLINE_MS);
    assert.deepEqual(result, { kind: 'uncertain' });
    assert.equal(ledger.file(outcomePath('luca-claude-code', 'op-0000000000000001')), null);
  });

  test('concurrent reconcilers agree on the single outcome actually on the ledger', async () => {
    const ledger = new MemoryLedger();
    await executeOnce(ledger, entry(), async () => { throw new Error('unknown'); }, neverReconcile, () => NOW);
    const later = () => NOW + EXECUTION_DEADLINE_MS;
    const [one, two] = await Promise.all([
      executeOnce(ledger, entry(), counter().effect, async () => ({ status: 'applied', result: { commentId: 7 } }), later),
      executeOnce(ledger, entry(), counter().effect, async () => ({ status: 'not_applied', result: {} }), later),
    ]);
    const onLedger = ledger.file(outcomePath('luca-claude-code', 'op-0000000000000001'));
    assert.ok(onLedger);
    assert.deepEqual(one.kind === 'recorded' && one.outcome, onLedger);
    assert.deepEqual(two.kind === 'recorded' && two.outcome, onLedger);
  });

  test('a failed claim write denies without executing', async () => {
    const ledger = new MemoryLedger();
    const effects = counter();
    ledger.failCommit = () => true;
    await assert.rejects(executeOnce(ledger, entry(), effects.effect, neverReconcile, () => NOW));
    assert.equal(effects.count, 0);
  });

  test('rejects path-unsafe actors and operation ids', () => {
    assert.throws(() => claimPath('../x', 'op-0000000000000001'));
    assert.throws(() => outcomePath('luca-claude-code', 'a/b'));
  });
});
