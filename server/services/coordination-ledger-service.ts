import {
  and,
  asc,
  desc,
  eq,
  gt,
  inArray,
  isNull,
  lte,
  or,
  sql,
} from 'drizzle-orm';
import { createHash } from 'node:crypto';
import {
  COORDINATION_ACTOR_IDS,
  COORDINATION_EVENT_TYPES,
  COORDINATION_EVIDENCE_TYPES,
  coordinationAdapterDeliveries,
  coordinationActorFeedCursors,
  coordinationEvents,
  coordinationThreads,
  agentNotes,
  type CoordinationActorId,
  type CoordinationEvent,
  type CoordinationEventType,
  type CoordinationEvidenceReference,
  type CoordinationThread,
  type CoordinationThreadState,
} from '@shared/schema';
import { getSharedDb } from '../db';
import { replyToAgentNoteAndVerifyInTransaction } from './agent-notes';
import { signatureRefusal } from './coordination-signature';

const ACTOR_SET = new Set<string>(COORDINATION_ACTOR_IDS);
const EVENT_TYPE_SET = new Set<string>(COORDINATION_EVENT_TYPES);
const EVIDENCE_TYPE_SET = new Set<string>(COORDINATION_EVIDENCE_TYPES);
const PARTICIPANT_EVENT_TYPES = new Set<CoordinationEventType>([
  'progress',
  'evidence_added',
  'blocked',
  'completed',
]);

// Actors who see every coordination event system-wide via listCoordinationFeed,
// not just threads where they are origin, intended recipient, or current owner.
// Luca [HolaHola] is the coordination observer/delegator; Alden is the steward
// of the code (docs/alden-steward-role-design.md section 3.1). Checked by
// membership so a third full-feed actor never needs a second equality check
// added by hand.
const FULL_FEED_READ_ACTORS: ReadonlySet<CoordinationActorId> = new Set([
  'luca-holahola',
  'alden',
]);

const DIRECT_ACTOR_EVENT_PERMISSIONS: Record<
  'luca-holahola' | 'alden' | 'daniela',
  ReadonlySet<CoordinationEventType>
> = {
  'luca-holahola': new Set(['reassigned', 'comment']),
  alden: new Set([
    'accepted', 'progress', 'evidence_added', 'blocked', 'completed',
    'outcome_acknowledged', 'reassigned', 'comment', 'steward_comment',
  ]),
  daniela: new Set([
    'accepted', 'progress', 'evidence_added', 'blocked', 'completed', 'comment',
  ]),
};

export function canCoordinationActorPerform(
  actor: CoordinationActorId,
  eventType: CoordinationEventType,
): boolean {
  const permissions = DIRECT_ACTOR_EVENT_PERMISSIONS[actor as keyof typeof DIRECT_ACTOR_EVENT_PERMISSIONS];
  return !permissions || permissions.has(eventType);
}

function assertCoordinationActorCanCreate(actor: CoordinationActorId): void {
  // Alden originates threads directly — he needs to reach Luca and the rest of the
  // team without waiting to be addressed first (task 1450). Daniela remains
  // receive-and-update only: she has no coordination tools on her own registry.
  if (actor === 'daniela') {
    throw new CoordinationError(
      `${actor} may receive and update coordination work but cannot originate threads`,
      403,
      'operation_not_allowed',
    );
  }
}

/** A message may not open signed as someone other than its poster (coordination-signature.ts). */
function assertSignatureMatchesActor(actor: CoordinationActorId, ...texts: string[]): void {
  for (const text of texts) {
    const refusal = signatureRefusal(text, actor);
    if (refusal) throw new CoordinationError(refusal.error, 422, refusal.refused, { signedAs: refusal.signedAs });
  }
}

export class CoordinationError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
    readonly code: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'CoordinationError';
  }
}

export type CoordinationCreateInput = {
  actor: CoordinationActorId;
  intendedRecipient: CoordinationActorId;
  title: string;
  description: string;
  priority?: 'low' | 'normal' | 'high' | 'urgent';
  content?: string;
  payload?: Record<string, unknown>;
  createInboxDelivery?: boolean;
  idempotencyKey: string;
  sourceReference?: CoordinationEvidenceReference;
};

export type CoordinationAppendInput = {
  threadId: string;
  actor: CoordinationActorId;
  eventType: CoordinationEventType;
  content: string;
  idempotencyKey: string;
  expectedSequence: number;
  recipientActor?: CoordinationActorId;
  payload?: Record<string, unknown>;
  evidence?: CoordinationEvidenceReference[];
  causalParentEventId?: string;
};

export type CoordinationMutationResult = {
  thread: CoordinationThread;
  event: CoordinationEvent;
  deduplicated: boolean;
  deliveryState: 'not_applicable' | 'pending' | 'delivered' | 'failed';
};

export type CompleteWithLinkedOutcomeInput = {
  threadId: string;
  actor: CoordinationActorId;
  content: string;
  expectedSequence: number;
  idempotencyKey: string;
  evidence?: CoordinationEvidenceReference[];
  causalParentEventId?: string;
  reply: { body: string; subject?: string; sessionLabel?: string };
};

export type CompleteWithLinkedOutcomeResult = CoordinationMutationResult & {
  achievedState: 'completed';
  linkedReply: {
    id: string;
    deliveryState: 'delivered';
    deduplicated: boolean;
  };
};

export function isCoordinationActorId(value: unknown): value is CoordinationActorId {
  return typeof value === 'string' && ACTOR_SET.has(value);
}

export function isCoordinationEventType(value: unknown): value is CoordinationEventType {
  return typeof value === 'string' && EVENT_TYPE_SET.has(value);
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => (
      `${JSON.stringify(key)}:${canonicalJson(record[key])}`
    )).join(',')}}`;
  }
  return JSON.stringify(value);
}

function linkedOutcomeRequestDigest(input: CompleteWithLinkedOutcomeInput): string {
  const immutableRequest = {
    threadId: input.threadId,
    actor: input.actor,
    content: input.content,
    evidence: input.evidence ?? [],
    causalParentEventId: input.causalParentEventId ?? null,
    reply: {
      body: input.reply.body,
      subject: input.reply.subject ?? null,
      sessionLabel: input.reply.sessionLabel ?? null,
    },
  };
  return `sha256:${createHash('sha256').update(canonicalJson(immutableRequest)).digest('hex')}`;
}

function requiredText(value: string, field: string, maxLength: number): string {
  const normalized = value?.trim();
  if (!normalized) throw new CoordinationError(`${field} is required`, 400, 'invalid_request');
  if (normalized.length > maxLength) {
    throw new CoordinationError(`${field} exceeds ${maxLength} characters`, 400, 'invalid_request');
  }
  return normalized;
}

function validateIdempotencyKey(value: string): string {
  const normalized = requiredText(value, 'idempotencyKey', 255);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{7,254}$/.test(normalized)) {
    throw new CoordinationError(
      'idempotencyKey must be 8-255 safe characters',
      400,
      'invalid_idempotency_key',
    );
  }
  return normalized;
}

function validateEvidenceReference(reference: CoordinationEvidenceReference): CoordinationEvidenceReference {
  if (!reference || !EVIDENCE_TYPE_SET.has(reference.type)) {
    throw new CoordinationError('Unsupported evidence type', 400, 'invalid_evidence');
  }
  const provider = requiredText(reference.provider, 'evidence.provider', 80);
  const identifier = requiredText(reference.identifier, 'evidence.identifier', 1000);
  if (reference.type === 'commit' && !/^[0-9a-f]{40,64}$/i.test(identifier)) {
    throw new CoordinationError(
      'Commit evidence requires an immutable hexadecimal commit identifier',
      400,
      'invalid_evidence',
    );
  }
  if (reference.type === 'external_url') {
    let parsed: URL;
    try {
      parsed = new URL(identifier);
    } catch {
      throw new CoordinationError('External URL evidence is invalid', 400, 'invalid_evidence');
    }
    if (!['https:', 'http:'].includes(parsed.protocol)) {
      throw new CoordinationError('External URL evidence must use HTTPS or HTTP', 400, 'invalid_evidence');
    }
  }
  if (reference.digest && !/^[A-Za-z0-9:+/=_-]{16,255}$/.test(reference.digest)) {
    throw new CoordinationError('Evidence digest is malformed', 400, 'invalid_evidence');
  }
  return {
    type: reference.type,
    provider,
    identifier,
    ...(reference.label ? { label: requiredText(reference.label, 'evidence.label', 300) } : {}),
    ...(reference.digest ? { digest: reference.digest } : {}),
    ...(reference.metadata ? { metadata: reference.metadata } : {}),
  };
}

function replyIdentity(actor: CoordinationActorId): { inbox: string; sender: string } | null {
  if (actor === 'luca-replit') return { inbox: 'agent', sender: 'agent' };
  if (actor === 'luca-claude-code') return { inbox: 'luca-claude-code', sender: 'luca-claude-code' };
  return null;
}

async function assertAgentNoteOrigin(
  db: any,
  reference: CoordinationEvidenceReference,
  actor: CoordinationActorId,
) {
  if (reference.provider !== 'agent_notes') {
    throw new CoordinationError('agent_note evidence must use provider agent_notes', 400, 'invalid_evidence');
  }
  const identity = replyIdentity(actor);
  if (!identity) throw new CoordinationError('agent_note origin requires a Luca coordination actor', 403, 'invalid_evidence');
  const [note] = await db.select().from(agentNotes).where(eq(agentNotes.id, reference.identifier)).limit(1);
  if (!note) throw new CoordinationError('Referenced agent note not found', 404, 'agent_note_not_found');
  if (note.toAgent !== identity.inbox || note.fromAgent === identity.sender) {
    throw new CoordinationError('Referenced agent note is outside the actor communication path', 403, 'agent_note_forbidden');
  }
  return note;
}

async function validateCausalParent(
  tx: any,
  threadId: string,
  causalParentEventId: string | undefined,
  newSequence: number,
): Promise<void> {
  if (!causalParentEventId) return;
  const [parent] = await tx.select({
    threadId: coordinationEvents.threadId,
    sequence: coordinationEvents.sequence,
  }).from(coordinationEvents).where(eq(coordinationEvents.id, causalParentEventId)).limit(1);
  if (!parent) throw new CoordinationError('Causal parent event not found', 404, 'causal_parent_not_found');
  if (parent.threadId !== threadId) {
    throw new CoordinationError('Causal parent must belong to the same thread', 409, 'invalid_causal_parent');
  }
  if (parent.sequence >= newSequence) {
    throw new CoordinationError('Causal parent must precede the new event', 409, 'invalid_causal_parent');
  }
}

async function assertLinkedOutcome(
  tx: any,
  thread: CoordinationThread,
  actor: CoordinationActorId,
) {
  if (thread.sourceReference?.type !== 'agent_note') return;
  const parent = await assertAgentNoteOrigin(tx, thread.sourceReference, actor);
  const identity = replyIdentity(actor);
  if (!identity) throw new CoordinationError('Agent-note completion requires a Luca actor', 403, 'linked_outcome_forbidden');
  const [reply] = await tx.select({ id: agentNotes.id }).from(agentNotes).where(and(
    eq(agentNotes.inReplyToId, parent.id),
    eq(agentNotes.fromAgent, identity.sender),
    eq(agentNotes.toAgent, parent.fromAgent),
  )).limit(1);
  if (!reply) {
    throw new CoordinationError(
      'Completion requires a delivered linked reply to the originating agent note',
      409,
      'linked_outcome_required',
    );
  }
}

function assertParticipant(
  thread: CoordinationThread,
  actor: CoordinationActorId,
  eventType?: CoordinationEventType,
): void {
  if (actor === 'luca-holahola') return;
  // Alden's steward bypass is deliberately narrower than Luca [HolaHola]'s:
  // it covers pure reads (no eventType — e.g. getCoordinationThread, used to
  // read context before interjecting) and the steward_comment event type
  // (cross-thread interjection), never any other direct-actor event type.
  // Alden's accepted/progress/evidence_added/blocked/completed/
  // outcome_acknowledged/reassigned/comment stay exactly as participant-gated
  // as every other actor's. See docs/alden-steward-role-design.md section 3.2.
  if (actor === 'alden' && (eventType === undefined || eventType === 'steward_comment')) return;
  // A system alert channel addresses several hats who are not its participants;
  // any of them may read it. Writing to it stays participant-gated.
  if (eventType === undefined && SYSTEM_ALERT_CHANNEL_THREAD_IDS.has(thread.id)) return;
  if (
    actor !== thread.originActor
    && actor !== thread.intendedRecipient
    && actor !== thread.currentOwner
  ) {
    throw new CoordinationError('Actor is not a participant in this thread', 403, 'not_participant');
  }
}

function stateForEvent(
  thread: CoordinationThread,
  eventType: CoordinationEventType,
): CoordinationThreadState {
  if (eventType === 'progress' || eventType === 'evidence_added') return 'in_progress';
  if (eventType === 'comment' || eventType === 'steward_comment') return thread.state;
  if (eventType === 'delivered') {
    return ['created', 'reassigned', 'reopened'].includes(thread.state)
      ? 'delivered'
      : thread.state;
  }
  if (eventType === 'created') return 'created';
  return eventType;
}

function validateLifecycle(
  thread: CoordinationThread,
  input: CoordinationAppendInput,
): void {
  const { actor, eventType } = input;
  if (!canCoordinationActorPerform(actor, eventType)) {
    throw new CoordinationError(
      `${actor} is not allowed to perform ${eventType}`,
      403,
      'operation_not_allowed',
    );
  }
  if (eventType === 'created') {
    throw new CoordinationError('created is only valid during thread creation', 400, 'invalid_transition');
  }
  if (eventType === 'delivered') {
    if (actor !== 'coordination-system') {
      throw new CoordinationError('delivered is reserved for adapters', 403, 'invalid_transition');
    }
    return;
  }

  if (eventType === 'reassigned' && actor === 'alden' && actor !== thread.currentOwner) {
    throw new CoordinationError(
      'Alden may only reassign work he currently owns',
      403,
      'not_owner',
    );
  }

  // steward_comment exists to mark that a comment came from Alden's stewardship
  // role, not from a thread participant -- that distinction only holds if no
  // other actor can ever emit one. DIRECT_ACTOR_EVENT_PERMISSIONS alone is not
  // enough to guarantee this: it's an opt-in restriction list keyed on
  // 'luca-holahola' | 'alden' | 'daniela', so canCoordinationActorPerform
  // returns true unconditionally for every actor NOT in that list (e.g.
  // luca-replit, luca-claude-code, david, luca-gemini), even for an event type
  // none of them should ever be able to send. This explicit check is the only
  // thing standing between "Alden-only event type" and "any participant can
  // forge one on their own thread."
  if (eventType === 'steward_comment' && actor !== 'alden') {
    throw new CoordinationError(
      'steward_comment is reserved for Alden, the steward of the code',
      403,
      'operation_not_allowed',
    );
  }

  assertParticipant(thread, actor, eventType);

  if (eventType === 'accepted') {
    if (actor !== thread.intendedRecipient || thread.currentOwner) {
      throw new CoordinationError(
        'Only the intended recipient may accept unowned work',
        409,
        'invalid_transition',
        { currentOwner: thread.currentOwner, intendedRecipient: thread.intendedRecipient },
      );
    }
    if (!['created', 'delivered', 'reopened', 'reassigned'].includes(thread.state)) {
      throw new CoordinationError('Thread cannot be accepted from its current state', 409, 'invalid_transition');
    }
    return;
  }

  if (PARTICIPANT_EVENT_TYPES.has(eventType)) {
    if (!thread.currentOwner || actor !== thread.currentOwner) {
      throw new CoordinationError('Only the current owner may update active work', 403, 'not_owner');
    }
    if (['completed', 'outcome_acknowledged'].includes(thread.state)) {
      throw new CoordinationError('Completed work must be reopened before further updates', 409, 'invalid_transition');
    }
    return;
  }

  if (eventType === 'outcome_acknowledged') {
    if (actor !== thread.originActor) {
      throw new CoordinationError('Only the origin actor may acknowledge the outcome', 403, 'invalid_transition');
    }
    if (thread.state !== 'completed') {
      throw new CoordinationError('Only completed work can be acknowledged', 409, 'invalid_transition');
    }
    return;
  }

  if (eventType === 'reopened') {
    if (actor !== thread.originActor) {
      throw new CoordinationError('Only the origin actor may reopen work', 403, 'invalid_transition');
    }
    if (!['blocked', 'completed', 'outcome_acknowledged'].includes(thread.state)) {
      throw new CoordinationError('Thread cannot be reopened from its current state', 409, 'invalid_transition');
    }
    return;
  }

  if (eventType === 'reassigned') {
    if (
      actor !== 'luca-holahola'
      && actor !== thread.originActor
      && actor !== thread.currentOwner
    ) {
      throw new CoordinationError(
        'Only Luca [HolaHola], the origin actor, or the current owner may reassign work',
        403,
        'invalid_transition',
      );
    }
    if (!input.recipientActor || input.recipientActor === 'coordination-system') {
      throw new CoordinationError('reassigned requires a valid recipientActor', 400, 'invalid_transition');
    }
  }
}

async function findIdempotentEvent(actor: CoordinationActorId, idempotencyKey: string, db = getSharedDb()) {
  const [existing] = await db
    .select()
    .from(coordinationEvents)
    .where(and(
      eq(coordinationEvents.actor, actor),
      eq(coordinationEvents.idempotencyKey, idempotencyKey),
    ))
    .limit(1);
  return existing ?? null;
}

async function mutationResultFromExisting(event: CoordinationEvent): Promise<CoordinationMutationResult> {
  const [thread] = await getSharedDb()
    .select()
    .from(coordinationThreads)
    .where(eq(coordinationThreads.id, event.threadId))
    .limit(1);
  if (!thread) throw new CoordinationError('Idempotent event references a missing thread', 500, 'ledger_corrupt');
  const [delivery] = await getSharedDb()
    .select({ status: coordinationAdapterDeliveries.status })
    .from(coordinationAdapterDeliveries)
    .where(eq(coordinationAdapterDeliveries.eventId, event.id))
    .limit(1);
  const { verifyExistingCoordinationInboxItems } = await import('./coordination-inbox-service');
  await verifyExistingCoordinationInboxItems(event, thread);
  return {
    thread,
    event,
    deduplicated: true,
    deliveryState: delivery?.status ?? 'not_applicable',
  };
}

/**
 * Standing threads the production server posts alerts into as coordination-system
 * (comment events with payload kind 'system_alert', each naming its recipient).
 * - 9e442310…: "Episode backup alerts (standing thread)", opened by luca-claude-code
 *   2026-11-03 for the episode backup scheduler (episode-backup-scheduler.ts).
 */
export const SYSTEM_ALERT_CHANNEL_THREAD_IDS: ReadonlySet<string> = new Set([
  '9e442310-8e80-4c4c-bfbb-449f627efffd',
]);

function shouldCreateInboxDelivery(actor: CoordinationActorId): boolean {
  return actor === 'luca-replit' || actor === 'luca-claude-code';
}

export async function createCoordinationThread(
  rawInput: CoordinationCreateInput,
  executor?: any,
): Promise<CoordinationMutationResult> {
  const db = executor ?? getSharedDb();
  const input = {
    ...rawInput,
    title: requiredText(rawInput.title, 'title', 300),
    description: requiredText(rawInput.description, 'description', 20_000),
    content: requiredText(rawInput.content || rawInput.description, 'content', 20_000),
    idempotencyKey: validateIdempotencyKey(rawInput.idempotencyKey),
    sourceReference: rawInput.sourceReference
      ? validateEvidenceReference(rawInput.sourceReference)
      : undefined,
  };
  if (!isCoordinationActorId(input.actor) || input.actor === 'coordination-system') {
    throw new CoordinationError('Invalid origin actor', 400, 'invalid_actor');
  }
  assertCoordinationActorCanCreate(input.actor);
  assertSignatureMatchesActor(input.actor, input.description, input.content);
  if (!isCoordinationActorId(input.intendedRecipient) || input.intendedRecipient === 'coordination-system') {
    throw new CoordinationError('Invalid intended recipient', 400, 'invalid_actor');
  }
  if (input.sourceReference?.type === 'agent_note') {
    await assertAgentNoteOrigin(db, input.sourceReference, input.intendedRecipient);
  }

  const existing = await findIdempotentEvent(input.actor, input.idempotencyKey, db);
  if (existing) return mutationResultFromExisting(existing);

  try {
    const mutation = async (tx: any) => {
      const [thread] = await tx.insert(coordinationThreads).values({
        title: input.title,
        description: input.description,
        originActor: input.actor,
        intendedRecipient: input.intendedRecipient,
        priority: input.priority ?? 'normal',
        state: 'created',
        latestSequence: 0,
        latestGlobalSequence: 0,
        sourceReference: input.sourceReference,
      }).returning();
      if (!thread) throw new CoordinationError('Thread insert returned no row', 500, 'insert_failed');

      const [event] = await tx.insert(coordinationEvents).values({
        threadId: thread.id,
        sequence: 1,
        actor: input.actor,
        recipientActor: input.intendedRecipient,
        eventType: 'created',
        content: input.content,
        payload: input.payload ?? {},
        evidence: input.sourceReference ? [input.sourceReference] : [],
        idempotencyKey: input.idempotencyKey,
      }).returning();
      if (!event) throw new CoordinationError('Created event insert returned no row', 500, 'insert_failed');

      const { insertCoordinationInboxItems } = await import('./coordination-inbox-service');
      await insertCoordinationInboxItems(tx, {
        event,
        preThread: thread,
        postThread: thread,
        explicitRecipient: input.intendedRecipient,
      });

      const [updatedThread] = await tx.update(coordinationThreads).set({
        latestSequence: 1,
        latestGlobalSequence: event.globalSequence,
        updatedAt: new Date(),
      }).where(eq(coordinationThreads.id, thread.id)).returning();
      if (!updatedThread) throw new CoordinationError('Thread projection update failed', 500, 'projection_failed');

      let deliveryState: CoordinationMutationResult['deliveryState'] = 'not_applicable';
      // A self-addressed thread (actor === intendedRecipient) can never be routed:
      // inboxActors() in coordination-delivery-worker.ts rejects same-actor delivery
      // by design (no point mirroring your own action into your own inbox). Creating
      // the delivery row anyway leaves it retrying forever at the capped backoff,
      // permanently 'failed' with no way to succeed -- see the Sep 8 2026 thread
      // created by shared-spec publication notifications when the publish actor was
      // also the original requester (event e2a598f2, coordination-inbox-delivery-actor-routing.md).
      if (
        input.createInboxDelivery !== false
        && input.actor !== input.intendedRecipient
        && shouldCreateInboxDelivery(input.intendedRecipient)
      ) {
        await tx.insert(coordinationAdapterDeliveries).values({
          eventId: event.id,
          adapterName: 'agent_notes',
          targetActor: input.intendedRecipient,
          status: 'pending',
        });
        deliveryState = 'pending';
      }
      return { thread: updatedThread, event, deduplicated: false, deliveryState };
    };
    return executor ? await mutation(executor) : await db.transaction(mutation);
  } catch (error) {
    const wonRace = await findIdempotentEvent(input.actor, input.idempotencyKey, db);
    if (wonRace) return mutationResultFromExisting(wonRace);
    throw error;
  }
}

export async function appendCoordinationEvent(
  rawInput: CoordinationAppendInput,
  executor?: any,
): Promise<CoordinationMutationResult> {
  const db = executor ?? getSharedDb();
  const input: CoordinationAppendInput = {
    ...rawInput,
    threadId: requiredText(rawInput.threadId, 'threadId', 255),
    content: requiredText(rawInput.content, 'content', 20_000),
    idempotencyKey: validateIdempotencyKey(rawInput.idempotencyKey),
    evidence: (rawInput.evidence ?? []).map(validateEvidenceReference),
    payload: rawInput.payload ?? {},
  };
  if (!isCoordinationActorId(input.actor)) {
    throw new CoordinationError('Invalid actor', 400, 'invalid_actor');
  }
  assertSignatureMatchesActor(input.actor, input.content);
  if (!isCoordinationEventType(input.eventType)) {
    throw new CoordinationError('Invalid event type', 400, 'invalid_event_type');
  }
  if (!Number.isInteger(input.expectedSequence) || input.expectedSequence < 1) {
    throw new CoordinationError('expectedSequence must be a positive integer', 400, 'invalid_sequence');
  }

  const existing = await findIdempotentEvent(input.actor, input.idempotencyKey, db);
  if (existing) {
    if (existing.threadId !== input.threadId) {
      throw new CoordinationError('Idempotency key was already used for another thread', 409, 'idempotency_conflict');
    }
    return mutationResultFromExisting(existing);
  }

  try {
    const mutation = async (tx: any) => {
      const [thread] = await tx
        .select()
        .from(coordinationThreads)
        .where(eq(coordinationThreads.id, input.threadId))
        .limit(1);
      if (!thread) throw new CoordinationError('Coordination thread not found', 404, 'thread_not_found');
      const [createdEvent] = await tx
        .select({ payload: coordinationEvents.payload })
        .from(coordinationEvents)
        .where(and(
          eq(coordinationEvents.threadId, thread.id),
          eq(coordinationEvents.sequence, 1),
        ))
        .limit(1);
      const isObservationBench =
        (createdEvent?.payload as Record<string, unknown> | undefined)?.kind === 'dual_luca_observation_bench';
      if (isObservationBench) {
        const [endedEvent] = await tx
          .select({ id: coordinationEvents.id })
          .from(coordinationEvents)
          .where(and(
            eq(coordinationEvents.threadId, thread.id),
            sql`${coordinationEvents.payload}->>'kind' = 'observation_window_ended'`,
          ))
          .limit(1);
        if (endedEvent) {
          throw new CoordinationError(
            'Observation window has ended',
            409,
            'observation_window_ended',
          );
        }
      }
      const isNeutralObservationCapture =
        isObservationBench
        && input.actor === 'coordination-system'
        && input.eventType === 'comment'
        && (input.payload as Record<string, unknown> | undefined)?.kind === 'observation_source';
      const payloadKind = String((input.payload as Record<string, unknown> | undefined)?.kind ?? '');
      if (
        isObservationBench
        && !isNeutralObservationCapture
        && new Set([
          'dual_luca_observation_bench',
          'observation_source',
          'bench_observation',
          'observation_invitation',
          'observation_window_ended',
        ]).has(payloadKind)
      ) {
        throw new CoordinationError(
          'Observation bench lifecycle payloads require a dedicated verified route',
          403,
          'reserved_observation_payload',
        );
      }
      // A system alert is a comment the server itself posts, as coordination-system,
      // into a standing alert channel. coordination-system is never a participant,
      // so only the listed channels accept it, and no other actor may send the kind.
      const isSystemAlert =
        input.actor === 'coordination-system'
        && input.eventType === 'comment'
        && payloadKind === 'system_alert'
        && SYSTEM_ALERT_CHANNEL_THREAD_IDS.has(thread.id);
      if (payloadKind === 'system_alert' && !isSystemAlert) {
        throw new CoordinationError(
          'system_alert comments are reserved for coordination-system in a listed alert channel',
          403,
          'reserved_system_alert_payload',
        );
      }
      if (isSystemAlert && (!input.recipientActor || input.recipientActor === 'coordination-system')) {
        throw new CoordinationError('A system alert must name the actor it is for', 400, 'invalid_actor');
      }
      if (!isNeutralObservationCapture && !isSystemAlert) validateLifecycle(thread, input);

      if (input.eventType === 'completed' && (input.evidence?.length ?? 0) === 0) {
        const [priorEvidence] = await tx
          .select({ id: coordinationEvents.id })
          .from(coordinationEvents)
          .where(and(
            eq(coordinationEvents.threadId, thread.id),
            eq(coordinationEvents.eventType, 'evidence_added'),
          ))
          .limit(1);
        if (!priorEvidence) {
          throw new CoordinationError(
            'Completion requires immutable evidence',
            400,
            'completion_evidence_required',
          );
        }
      }
      if (input.eventType === 'completed') {
        await assertLinkedOutcome(tx, thread, input.actor);
      }

      const nextSequence = thread.latestSequence + 1;
      await validateCausalParent(tx, thread.id, input.causalParentEventId, nextSequence);
      const [reservedThread] = await tx
        .update(coordinationThreads)
        .set({
          latestSequence: nextSequence,
          updatedAt: new Date(),
        })
        .where(and(
          eq(coordinationThreads.id, thread.id),
          eq(coordinationThreads.latestSequence, input.expectedSequence),
        ))
        .returning();
      if (!reservedThread) {
        const [current] = await tx
          .select({ latestSequence: coordinationThreads.latestSequence })
          .from(coordinationThreads)
          .where(eq(coordinationThreads.id, thread.id))
          .limit(1);
        throw new CoordinationError(
          'Thread sequence changed',
          409,
          'sequence_conflict',
          { currentSequence: current?.latestSequence ?? null },
        );
      }

      const [event] = await tx.insert(coordinationEvents).values({
        threadId: thread.id,
        sequence: nextSequence,
        actor: input.actor,
        recipientActor: input.recipientActor ?? null,
        eventType: input.eventType,
        content: input.content,
        payload: input.payload ?? {},
        evidence: input.evidence ?? [],
        causalParentEventId: input.causalParentEventId ?? null,
        idempotencyKey: input.idempotencyKey,
      }).returning();
      if (!event) throw new CoordinationError('Event insert returned no row', 500, 'insert_failed');

      const newRecipient = input.eventType === 'reassigned'
        ? input.recipientActor!
        : thread.intendedRecipient;
      const newOwner = input.eventType === 'accepted'
        ? input.actor
        : input.eventType === 'reassigned' || input.eventType === 'reopened'
          ? null
          : thread.currentOwner;
      const postThread = {
        ...thread,
        intendedRecipient: newRecipient,
        currentOwner: newOwner,
        state: stateForEvent(thread, input.eventType),
      };
      const { insertCoordinationInboxItems } = await import('./coordination-inbox-service');
      await insertCoordinationInboxItems(tx, {
        event,
        preThread: thread,
        postThread,
        explicitRecipient: input.recipientActor,
      });
      const [updatedThread] = await tx
        .update(coordinationThreads)
        .set({
          intendedRecipient: newRecipient,
          currentOwner: newOwner,
          state: postThread.state,
          latestGlobalSequence: event.globalSequence,
          updatedAt: new Date(),
        })
        .where(eq(coordinationThreads.id, thread.id))
        .returning();
      if (!updatedThread) throw new CoordinationError('Thread projection update failed', 500, 'projection_failed');

      let deliveryState: CoordinationMutationResult['deliveryState'] = 'not_applicable';
      // Same self-addressed guard as createCoordinationThread: inboxActors() at
      // delivery time already refuses to route thread.originActor -> itself, so
      // gate row creation on it here too rather than letting an unroutable row
      // retry forever. See coordination-inbox-delivery-actor-routing.md.
      if (
        ['reassigned', 'reopened'].includes(input.eventType)
        && thread.originActor !== newRecipient
        && shouldCreateInboxDelivery(newRecipient as CoordinationActorId)
      ) {
        await tx.insert(coordinationAdapterDeliveries).values({
          eventId: event.id,
          adapterName: 'agent_notes',
          targetActor: newRecipient,
          status: 'pending',
        });
        deliveryState = 'pending';
      }
      return { thread: updatedThread, event, deduplicated: false, deliveryState };
    };
    return executor ? await mutation(executor) : await db.transaction(mutation);
  } catch (error) {
    const wonRace = await findIdempotentEvent(input.actor, input.idempotencyKey, db);
    if (wonRace && wonRace.threadId === input.threadId) {
      return mutationResultFromExisting(wonRace);
    }
    throw error;
  }
}

/**
 * Repository-controlled completion for work that originated in an agent note.
 *
 * The local shared-database path is atomic: sequence reservation, linked reply,
 * delivery verification, completion event, and thread projection commit or
 * roll back together.
 */
export async function completeWithLinkedOutcome(
  rawInput: CompleteWithLinkedOutcomeInput,
): Promise<CompleteWithLinkedOutcomeResult> {
  const input: CompleteWithLinkedOutcomeInput = {
    ...rawInput,
    threadId: requiredText(rawInput.threadId, 'threadId', 255),
    content: requiredText(rawInput.content, 'content', 20_000),
    idempotencyKey: validateIdempotencyKey(rawInput.idempotencyKey),
    evidence: (rawInput.evidence ?? []).map(validateEvidenceReference),
    reply: {
      body: requiredText(rawInput.reply?.body, 'reply.body', 20_000),
      ...(rawInput.reply?.subject
        ? { subject: requiredText(rawInput.reply.subject, 'reply.subject', 300) }
        : {}),
      ...(rawInput.reply?.sessionLabel
        ? { sessionLabel: requiredText(rawInput.reply.sessionLabel, 'reply.sessionLabel', 300) }
        : {}),
    },
  };
  if (!isCoordinationActorId(input.actor)) {
    throw new CoordinationError('Invalid actor', 400, 'invalid_actor');
  }
  assertSignatureMatchesActor(input.actor, input.content, input.reply.body);
  if (!Number.isInteger(input.expectedSequence) || input.expectedSequence < 1) {
    throw new CoordinationError('expectedSequence must be a positive integer', 400, 'invalid_sequence');
  }
  const requestDigest = linkedOutcomeRequestDigest(input);

  const existing = await findIdempotentEvent(input.actor, input.idempotencyKey);
  if (existing) {
    if (existing.threadId !== input.threadId || existing.eventType !== 'completed') {
      throw new CoordinationError(
        'Idempotency key was already used for another operation',
        409,
        'idempotency_conflict',
      );
    }
    const linkedOutcome = (existing.payload as Record<string, any> | null)?.linkedOutcome;
    if (!linkedOutcome || linkedOutcome.requestDigest !== requestDigest) {
      throw new CoordinationError(
        'Idempotency key was already used with conflicting completion content',
        409,
        'idempotency_conflict',
      );
    }
    const result = await mutationResultFromExisting(existing);
    const thread = result.thread;
    if (thread.sourceReference?.type !== 'agent_note') {
      throw new CoordinationError('Completed event has no agent-note origin', 409, 'agent_note_origin_required');
    }
    const parent = await assertAgentNoteOrigin(getSharedDb(), thread.sourceReference, input.actor);
    const identity = replyIdentity(input.actor)!;
    const [reply] = await getSharedDb().select().from(agentNotes).where(and(
      eq(agentNotes.id, linkedOutcome.replyId),
      eq(agentNotes.inReplyToId, parent.id),
      eq(agentNotes.fromAgent, identity.sender),
      eq(agentNotes.toAgent, parent.fromAgent),
    )).limit(1);
    if (!reply) {
      throw new CoordinationError(
        'Completed event is missing its linked reply',
        500,
        'ledger_corrupt',
      );
    }
    return {
      ...result,
      achievedState: 'completed',
      linkedReply: { id: reply.id, deliveryState: 'delivered', deduplicated: true },
    };
  }

  const db = getSharedDb();
  try {
    return await db.transaction(async (tx) => {
      const [thread] = await tx.select().from(coordinationThreads)
        .where(eq(coordinationThreads.id, input.threadId)).limit(1);
      if (!thread) throw new CoordinationError('Coordination thread not found', 404, 'thread_not_found');
      if (thread.latestSequence !== input.expectedSequence) {
        throw new CoordinationError(
          'Thread sequence changed',
          409,
          'sequence_conflict',
          { currentSequence: thread.latestSequence },
        );
      }
      validateLifecycle(thread, {
        ...input,
        eventType: 'completed',
        payload: {},
      });
      if (thread.sourceReference?.type !== 'agent_note') {
        throw new CoordinationError(
          'Linked-outcome completion requires an agent-note origin',
          409,
          'agent_note_origin_required',
        );
      }
      await assertAgentNoteOrigin(tx, thread.sourceReference, input.actor);
      if ((input.evidence?.length ?? 0) === 0) {
        const [priorEvidence] = await tx.select({ id: coordinationEvents.id })
          .from(coordinationEvents)
          .where(and(
            eq(coordinationEvents.threadId, thread.id),
            eq(coordinationEvents.eventType, 'evidence_added'),
          ))
          .limit(1);
        if (!priorEvidence) {
          throw new CoordinationError(
            'Completion requires immutable evidence',
            400,
            'completion_evidence_required',
          );
        }
      }
      const nextSequence = thread.latestSequence + 1;
      await validateCausalParent(tx, thread.id, input.causalParentEventId, nextSequence);
      const [reservedThread] = await tx.update(coordinationThreads).set({
        latestSequence: nextSequence,
        updatedAt: new Date(),
      }).where(and(
        eq(coordinationThreads.id, thread.id),
        eq(coordinationThreads.latestSequence, input.expectedSequence),
      )).returning();
      if (!reservedThread) {
        const [current] = await tx.select({ latestSequence: coordinationThreads.latestSequence })
          .from(coordinationThreads).where(eq(coordinationThreads.id, thread.id)).limit(1);
        throw new CoordinationError(
          'Thread sequence changed',
          409,
          'sequence_conflict',
          { currentSequence: current?.latestSequence ?? null },
        );
      }

      const reply = await replyToAgentNoteAndVerifyInTransaction(tx, {
        actor: input.actor as 'luca-replit' | 'luca-claude-code',
        parentId: thread.sourceReference.identifier,
        body: input.reply.body,
        subject: input.reply.subject,
        sessionLabel: input.reply.sessionLabel,
        idempotencyKey: input.idempotencyKey,
      });
      const [event] = await tx.insert(coordinationEvents).values({
        threadId: thread.id,
        sequence: nextSequence,
        actor: input.actor,
        recipientActor: null,
        eventType: 'completed',
        content: input.content,
        payload: {
          linkedOutcome: {
            replyId: reply.note.id,
            requestDigest,
            deliveryState: 'delivered',
          },
        },
        evidence: input.evidence ?? [],
        causalParentEventId: input.causalParentEventId ?? null,
        idempotencyKey: input.idempotencyKey,
      }).returning();
      if (!event) throw new CoordinationError('Event insert returned no row', 500, 'insert_failed');
      const { insertCoordinationInboxItems } = await import('./coordination-inbox-service');
      await insertCoordinationInboxItems(tx, {
        event,
        preThread: thread,
        postThread: thread,
      });
      const [updatedThread] = await tx.update(coordinationThreads).set({
        state: 'completed',
        latestGlobalSequence: event.globalSequence,
        updatedAt: new Date(),
      }).where(eq(coordinationThreads.id, thread.id)).returning();
      if (!updatedThread) {
        throw new CoordinationError('Thread projection update failed', 500, 'projection_failed');
      }
      return {
        thread: updatedThread,
        event,
        deduplicated: false,
        deliveryState: 'not_applicable',
        achievedState: 'completed',
        linkedReply: {
          id: reply.note.id,
          deliveryState: 'delivered',
          deduplicated: reply.deduplicated,
        },
      };
    });
  } catch (error) {
    const wonRace = await findIdempotentEvent(input.actor, input.idempotencyKey);
    if (wonRace && wonRace.threadId === input.threadId && wonRace.eventType === 'completed') {
      return completeWithLinkedOutcome(rawInput);
    }
    throw error;
  }
}

export async function getCoordinationThread(
  threadId: string,
  actor: CoordinationActorId,
  afterSequence = 0,
) {
  const [thread] = await getSharedDb()
    .select()
    .from(coordinationThreads)
    .where(eq(coordinationThreads.id, threadId))
    .limit(1);
  if (!thread) throw new CoordinationError('Coordination thread not found', 404, 'thread_not_found');
  assertParticipant(thread, actor);
  const events = await getSharedDb()
    .select()
    .from(coordinationEvents)
    .where(and(
      eq(coordinationEvents.threadId, threadId),
      gt(coordinationEvents.sequence, afterSequence),
    ))
    .orderBy(asc(coordinationEvents.sequence));
  return { thread, events };
}

function validateFeedCursor(value: number, field = 'cursor'): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new CoordinationError(`${field} must be a non-negative integer`, 400, 'invalid_request');
  }
  return value;
}

export async function getCoordinationFeedCursor(actor: CoordinationActorId): Promise<number> {
  if (!isCoordinationActorId(actor) || actor === 'coordination-system') {
    throw new CoordinationError('Invalid coordination actor', 400, 'invalid_actor');
  }
  const [cursor] = await getSharedDb()
    .select({ acknowledgedGlobalSequence: coordinationActorFeedCursors.acknowledgedGlobalSequence })
    .from(coordinationActorFeedCursors)
    .where(eq(coordinationActorFeedCursors.actor, actor))
    .limit(1);
  return cursor?.acknowledgedGlobalSequence ?? 0;
}

export async function acknowledgeCoordinationFeed(
  actor: CoordinationActorId,
  globalSequence: number,
): Promise<{ actor: CoordinationActorId; acknowledgedGlobalSequence: number }> {
  if (!isCoordinationActorId(actor) || actor === 'coordination-system') {
    throw new CoordinationError('Invalid coordination actor', 400, 'invalid_actor');
  }
  const requestedSequence = validateFeedCursor(globalSequence, 'globalSequence');

  const result = await getSharedDb().transaction(async (tx) => {
    const [latestEvent] = await tx
      .select({ globalSequence: coordinationEvents.globalSequence })
      .from(coordinationEvents)
      .orderBy(desc(coordinationEvents.globalSequence))
      .limit(1);
    const latestGlobalSequence = latestEvent?.globalSequence ?? 0;
    if (requestedSequence > latestGlobalSequence) {
      throw new CoordinationError(
        'Cannot acknowledge a coordination cursor beyond the current feed',
        409,
        'cursor_ahead',
        { latestGlobalSequence },
      );
    }

    const [cursor] = await tx
      .insert(coordinationActorFeedCursors)
      .values({
        actor,
        acknowledgedGlobalSequence: requestedSequence,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: coordinationActorFeedCursors.actor,
        set: {
          acknowledgedGlobalSequence: sql`GREATEST(${coordinationActorFeedCursors.acknowledgedGlobalSequence}, ${requestedSequence})`,
          updatedAt: new Date(),
        },
      })
      .returning({
        acknowledgedGlobalSequence: coordinationActorFeedCursors.acknowledgedGlobalSequence,
      });
    if (!cursor) throw new CoordinationError('Coordination cursor update failed', 500, 'cursor_update_failed');
    return cursor.acknowledgedGlobalSequence;
  });

  return { actor, acknowledgedGlobalSequence: result };
}

export async function listCoordinationFeed(
  actor: CoordinationActorId,
  sinceGlobalSequence?: number,
  limit = 50,
) {
  const acknowledgedGlobalSequence = await getCoordinationFeedCursor(actor);
  const previousCursor = sinceGlobalSequence === undefined
    ? acknowledgedGlobalSequence
    : validateFeedCursor(sinceGlobalSequence);
  const boundedLimit = Math.min(Math.max(limit, 1), 100);
  const items = await getSharedDb()
    .select({ thread: coordinationThreads, event: coordinationEvents })
    .from(coordinationEvents)
    .innerJoin(coordinationThreads, eq(coordinationThreads.id, coordinationEvents.threadId))
    .where(and(
      gt(coordinationEvents.globalSequence, previousCursor),
      FULL_FEED_READ_ACTORS.has(actor)
        ? sql`true`
        : or(
          eq(coordinationThreads.originActor, actor),
          eq(coordinationThreads.intendedRecipient, actor),
          eq(coordinationThreads.currentOwner, actor),
        ),
    ))
    .orderBy(asc(coordinationEvents.globalSequence))
    .limit(boundedLimit);
  return {
    items,
    cursor: {
      previous: previousCursor,
      next: items.at(-1)?.event.globalSequence ?? previousCursor,
      hasMore: items.length === boundedLimit,
      acknowledged: acknowledgedGlobalSequence,
    },
  };
}

export async function listPendingCoordinationDeliveries(limit = 20) {
  return getSharedDb()
    .select()
    .from(coordinationAdapterDeliveries)
    .where(and(
      inArray(coordinationAdapterDeliveries.status, ['pending', 'failed']),
      lte(coordinationAdapterDeliveries.nextAttemptAt, new Date()),
    ))
    .orderBy(asc(coordinationAdapterDeliveries.nextAttemptAt))
    .limit(Math.min(Math.max(limit, 1), 100));
}

export async function markCoordinationDeliveryFailed(id: string, error: string, attemptCount: number) {
  const delayMs = Math.min(60 * 60 * 1000, 5_000 * (2 ** Math.min(attemptCount, 8)));
  await getSharedDb().update(coordinationAdapterDeliveries).set({
    status: 'failed',
    attemptCount,
    lastError: error.slice(0, 2_000),
    nextAttemptAt: new Date(Date.now() + delayMs),
    updatedAt: new Date(),
  }).where(eq(coordinationAdapterDeliveries.id, id));
}

export async function markCoordinationDeliverySucceeded(
  id: string,
  externalReference: string,
  attemptCount: number,
) {
  const [delivery] = await getSharedDb().update(coordinationAdapterDeliveries).set({
    status: 'delivered',
    attemptCount,
    lastError: null,
    externalReference,
    deliveredAt: new Date(),
    updatedAt: new Date(),
  }).where(and(
    eq(coordinationAdapterDeliveries.id, id),
    isNull(coordinationAdapterDeliveries.deliveredAt),
  )).returning();
  return delivery ?? null;
}

export async function getCoordinationDeliveryContext(eventId: string) {
  const [row] = await getSharedDb()
    .select({ event: coordinationEvents, thread: coordinationThreads })
    .from(coordinationEvents)
    .innerJoin(coordinationThreads, eq(coordinationThreads.id, coordinationEvents.threadId))
    .where(eq(coordinationEvents.id, eventId))
    .limit(1);
  return row ?? null;
}
