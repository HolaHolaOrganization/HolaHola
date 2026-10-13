/**
 * Test-only in-memory ledger that mirrors the ordering of the real
 * coordination-ledger-service.ts appendCoordinationEvent that the worker design
 * depends on: (1) (actor, idempotencyKey) lookup BEFORE (2) expectedSequence
 * CAS BEFORE (3) transition rules. Also: accepted only by the intended
 * recipient with no owner; reassigned/reopened clear the owner; owner-only
 * progress/blocked/completed; completed requires evidence or a prior
 * evidence_added; reads require participation (origin, recipient or owner).
 * The real-database race proof (design §7) checks the real service.
 */
import type { LedgerAppendResult, ThreadEventLite } from './lifecycle';

type FakeThread = {
  id: string; originActor: string; intendedRecipient: string; currentOwner: string | null;
  state: string; latestSequence: number;
};
type FakeEvent = ThreadEventLite & { threadId: string; sequence: number; actor: string };

export class FakeLedger {
  threads = new Map<string, FakeThread>();
  events: FakeEvent[] = [];

  createThread(id: string, originActor: string, recipient: string): void {
    this.threads.set(id, { id, originActor, intendedRecipient: recipient, currentOwner: null, state: 'delivered', latestSequence: 2 });
  }

  read(threadId: string, actor: string): { ok: true; thread: FakeThread; events: FakeEvent[] } | { ok: false; error: 'not_participant' } {
    const t = this.threads.get(threadId)!;
    if (![t.originActor, t.intendedRecipient, t.currentOwner].includes(actor)) return { ok: false, error: 'not_participant' };
    return { ok: true, thread: { ...t }, events: this.events.filter((e) => e.threadId === threadId) };
  }

  append(input: {
    threadId: string; actor: string; eventType: string; idempotencyKey: string; expectedSequence: number;
    payload?: Record<string, unknown>; evidence?: unknown[]; recipientActor?: string; content?: string;
  }): LedgerAppendResult {
    // (1) idempotency lookup first — a replay returns the original event regardless of current state.
    const existing = this.events.find((e) => e.actor === input.actor && e.idempotencyKey === input.idempotencyKey);
    if (existing) return { ok: true, deduplicated: true, event: { eventType: existing.eventType, payload: existing.payload as Record<string, unknown>, evidence: existing.evidence, content: existing.content, recipientActor: existing.recipientActor } };
    const t = this.threads.get(input.threadId);
    if (!t) return { ok: false, errorCode: 'thread_not_found', httpStatus: 404 };
    if (![t.originActor, t.intendedRecipient, t.currentOwner].includes(input.actor)) return { ok: false, errorCode: 'not_participant', httpStatus: 403 };
    // (2) optimistic concurrency.
    if (input.expectedSequence !== t.latestSequence) return { ok: false, errorCode: 'sequence_conflict', httpStatus: 409 };
    // (3) transitions.
    const et = input.eventType;
    if (et === 'accepted') {
      if (input.actor !== t.intendedRecipient || t.currentOwner) return { ok: false, errorCode: 'invalid_transition', httpStatus: 409 };
      if (!['created', 'delivered', 'reopened', 'reassigned'].includes(t.state)) return { ok: false, errorCode: 'invalid_transition', httpStatus: 409 };
    } else if (['progress', 'blocked', 'completed'].includes(et)) {
      if (t.currentOwner !== input.actor) return { ok: false, errorCode: 'invalid_transition', httpStatus: 409 };
      if (et === 'completed' && (input.evidence?.length ?? 0) === 0
        && !this.events.some((e) => e.threadId === t.id && e.eventType === 'evidence_added')) {
        return { ok: false, errorCode: 'completion_evidence_required', httpStatus: 400 };
      }
    } else if (et === 'reassigned') {
      if (input.actor !== t.originActor && input.actor !== t.currentOwner) return { ok: false, errorCode: 'invalid_transition', httpStatus: 403 };
    }
    const sequence = t.latestSequence + 1;
    this.events.push({
      threadId: t.id, sequence, actor: input.actor, eventType: et, idempotencyKey: input.idempotencyKey,
      payload: input.payload ?? {}, evidence: input.evidence ?? [], content: input.content ?? '',
      recipientActor: input.recipientActor ?? null, // as the real service stores it (coordination-ledger-service appendCoordinationEvent)
    });
    t.latestSequence = sequence;
    if (et === 'accepted') { t.currentOwner = input.actor; t.state = 'accepted'; }
    else if (et === 'reassigned') { t.currentOwner = null; t.intendedRecipient = input.recipientActor!; t.state = 'reassigned'; }
    else if (et === 'progress') t.state = 'in_progress';
    else if (et === 'blocked' || et === 'completed') t.state = et;
    const stored = this.events[this.events.length - 1];
    return { ok: true, deduplicated: false, event: { eventType: et, payload: stored.payload as Record<string, unknown>, evidence: stored.evidence, content: stored.content, recipientActor: stored.recipientActor } };
  }

  latestAcceptedClaimKey(threadId: string): string | null {
    const acc = this.events.filter((e) => e.threadId === threadId && e.eventType === 'accepted');
    return (acc[acc.length - 1]?.payload as { claimKey?: string } | undefined)?.claimKey ?? null;
  }
}
