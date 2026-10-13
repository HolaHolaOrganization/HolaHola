import type { Application, Response } from 'express';
import {
  requireCoordinationAuth,
  type CoordinationAuthenticatedRequest,
} from '../middleware/coordination-auth';
import {
  appendCoordinationEvent,
  acknowledgeCoordinationFeed,
  completeWithLinkedOutcome,
  CoordinationError,
  createCoordinationThread,
  getCoordinationThread,
  isCoordinationActorId,
  isCoordinationEventType,
  listCoordinationFeed,
} from '../services/coordination-ledger-service';
import {
  acknowledgeCoordinationInbox,
  listCoordinationInbox,
} from '../services/coordination-inbox-service';
import { recordOnboardedRuntimeLedgerRead } from '../services/runtime-onboarding-service';
import { validateCreatePayload } from '../../shared/worker-contracts';
import type {
  CoordinationActorId,
  CoordinationEventType,
  CoordinationEvidenceReference,
} from '@shared/schema';
import {
  discoverOperations,
  OPERATIONS_CATALOG,
  toPublicOperationManifest,
} from '../services/operations-catalog';

type LifecycleRoute = {
  path: string;
  eventType: CoordinationEventType;
  defaultContent: string;
};

const lifecycleRoutes: LifecycleRoute[] = [
  { path: 'accept', eventType: 'accepted', defaultContent: 'Accepted work' },
  { path: 'progress', eventType: 'progress', defaultContent: 'Progress updated' },
  { path: 'evidence', eventType: 'evidence_added', defaultContent: 'Evidence added' },
  { path: 'block', eventType: 'blocked', defaultContent: 'Work blocked' },
  { path: 'complete', eventType: 'completed', defaultContent: 'Work completed' },
  { path: 'acknowledge', eventType: 'outcome_acknowledged', defaultContent: 'Outcome acknowledged' },
  { path: 'reopen', eventType: 'reopened', defaultContent: 'Work reopened' },
  { path: 'reassign', eventType: 'reassigned', defaultContent: 'Work reassigned' },
];

function actorFrom(req: CoordinationAuthenticatedRequest): CoordinationActorId {
  if (!req.coordinationActor) {
    throw new CoordinationError('Coordination actor missing after authentication', 500, 'auth_invariant');
  }
  return req.coordinationActor;
}

function recordLedgerReadAfterSuccessfulResponse(
  req: CoordinationAuthenticatedRequest,
  res: Response,
): void {
  const credential = req.coordinationCredential;
  if (!credential) return;
  const identity = {
    runtimeId: credential.runtimeId,
    actor: credential.actor,
    credentialId: credential.credentialId,
  };
  res.once('finish', () => {
    if (res.statusCode !== 200) return;
    void recordOnboardedRuntimeLedgerRead(identity).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : 'unknown audit write failure';
      console.error('[Coordination] Failed to persist successful onboarding ledger-read evidence:', message);
    });
  });
}

function positiveInteger(value: unknown, field: string, fallback?: number): number {
  const selected = value ?? fallback;
  const number = typeof selected === 'number'
    ? selected
    : Number.parseInt(String(selected ?? ''), 10);
  if (!Number.isSafeInteger(number) || number < 0) {
    throw new CoordinationError(`${field} must be a non-negative integer`, 400, 'invalid_request');
  }
  return number;
}

function idempotencyKey(req: CoordinationAuthenticatedRequest): string {
  const header = req.headers['idempotency-key'];
  const value = typeof header === 'string' ? header : req.body?.idempotencyKey;
  if (typeof value !== 'string') {
    throw new CoordinationError('idempotencyKey is required', 400, 'invalid_request');
  }
  return value;
}

function evidenceFrom(value: unknown): CoordinationEvidenceReference[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new CoordinationError('evidence must be an array', 400, 'invalid_request');
  }
  return value as CoordinationEvidenceReference[];
}

const RESERVED_OBSERVATION_BENCH_PAYLOAD_KINDS = new Set([
  'dual_luca_observation_arm',
  'observation_arm_bound',
  'dual_luca_observation_bench',
  'observation_source',
  'bench_observation',
  'observation_invitation',
  'observation_window_ended',
]);

function rejectReservedObservationPayload(value: unknown): void {
  if (
    value
    && typeof value === 'object'
    && RESERVED_OBSERVATION_BENCH_PAYLOAD_KINDS.has(String((value as Record<string, unknown>).kind))
  ) {
    throw new CoordinationError(
      'Observation bench payload kinds are reserved for the verified bench routes',
      403,
      'reserved_observation_payload',
    );
  }
}

function recipientFrom(value: unknown, field: string): CoordinationActorId | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (!isCoordinationActorId(value) || value === 'coordination-system') {
    throw new CoordinationError(`${field} is invalid`, 400, 'invalid_actor');
  }
  return value;
}

function sendError(res: Response, error: unknown): void {
  if (error instanceof CoordinationError) {
    res.status(error.statusCode).json({
      error: error.message,
      code: error.code,
      ...(error.details ?? {}),
    });
    return;
  }
  console.error('[CoordinationRoutes] Unexpected error:', error);
  res.status(500).json({ error: 'Coordination operation failed', code: 'internal_error' });
}

async function appendFromRequest(
  req: CoordinationAuthenticatedRequest,
  eventType: CoordinationEventType,
  defaultContent: string,
) {
  rejectReservedObservationPayload(req.body?.payload);
  return appendCoordinationEvent({
    threadId: req.params.threadId,
    actor: actorFrom(req),
    eventType,
    content: typeof req.body?.content === 'string' && req.body.content.trim()
      ? req.body.content
      : defaultContent,
    idempotencyKey: idempotencyKey(req),
    expectedSequence: positiveInteger(req.body?.expectedSequence, 'expectedSequence'),
    recipientActor: recipientFrom(req.body?.recipientActor, 'recipientActor'),
    payload: req.body?.payload && typeof req.body.payload === 'object'
      ? req.body.payload
      : {},
    evidence: evidenceFrom(req.body?.evidence),
    causalParentEventId: typeof req.body?.causalParentEventId === 'string'
      ? req.body.causalParentEventId
      : undefined,
  });
}

export function registerCoordinationRoutes(app: Application): void {
  app.get(
    '/api/coordination/inbox',
    requireCoordinationAuth,
    async (req: CoordinationAuthenticatedRequest, res: Response) => {
      try {
        const supportedQueryParameters = new Set(['actor', 'token', 'after', 'limit']);
        const unsupportedQueryParameters = Object.keys(req.query)
          .filter((name) => !supportedQueryParameters.has(name));
        if (unsupportedQueryParameters.length > 0) {
          throw new CoordinationError(
            `Unsupported inbox query parameter${unsupportedQueryParameters.length === 1 ? '' : 's'}: ${unsupportedQueryParameters.join(', ')}. Use token to continue a partial window.`,
            400,
            'unsupported_query_parameter',
          );
        }
        const actor = actorFrom(req);
        if (req.query.actor && req.query.actor !== actor) {
          throw new CoordinationError(
            'actor query must match the authenticated actor',
            403,
            'actor_mismatch',
          );
        }
        if (req.query.token !== undefined && typeof req.query.token !== 'string') {
          throw new CoordinationError(
            'token must be a single signed inbox window token',
            400,
            'invalid_request',
          );
        }
        const after = req.query.after === undefined
          ? undefined
          : positiveInteger(req.query.after, 'after');
        const limit = positiveInteger(req.query.limit, 'limit', 50);
        const inbox = await listCoordinationInbox(actor, {
          ...(typeof req.query.token === 'string' ? { token: req.query.token } : {}),
          ...(after !== undefined ? { after } : {}),
          limit,
        });
        recordLedgerReadAfterSuccessfulResponse(req, res);
        res.json(inbox);
      } catch (error) {
        sendError(res, error);
      }
    },
  );

  app.post(
    '/api/coordination/inbox/ack',
    requireCoordinationAuth,
    async (req: CoordinationAuthenticatedRequest, res: Response) => {
      try {
        if (typeof req.body?.windowToken !== 'string' || !req.body.windowToken) {
          throw new CoordinationError('windowToken is required', 400, 'invalid_request');
        }
        res.json(await acknowledgeCoordinationInbox(actorFrom(req), req.body.windowToken));
      } catch (error) {
        sendError(res, error);
      }
    },
  );

  app.get(
    '/api/coordination/operations',
    requireCoordinationAuth,
    async (req: CoordinationAuthenticatedRequest, res: Response) => {
      try {
        const actor = actorFrom(req);
        const query = typeof req.query.query === 'string' ? req.query.query.trim() : '';
        const limit = Math.min(10, positiveInteger(req.query.limit, 'limit', 5));

        if (!query) {
          res.json({
            actor,
            matchType: 'list',
            operations: OPERATIONS_CATALOG.map(toPublicOperationManifest),
          });
          return;
        }

        res.json({ actor, ...(await discoverOperations(query, limit)) });
      } catch (error) {
        sendError(res, error);
      }
    },
  );

  app.post(
    '/api/coordination/threads',
    requireCoordinationAuth,
    async (req: CoordinationAuthenticatedRequest, res: Response) => {
      try {
        const intendedRecipient = recipientFrom(
          req.body?.intendedRecipient ?? req.body?.addressedToActor,
          'intendedRecipient',
        );
        if (!intendedRecipient) {
          throw new CoordinationError('intendedRecipient is required', 400, 'invalid_request');
        }
        // Only a strictly valid Local Read-only Worker job may ride on thread creation;
        // any other structured payload is refused (no reserved-kind injection).
        let payload: Record<string, unknown> | undefined;
        if (req.body?.payload !== undefined) {
          const checked = validateCreatePayload(req.body.payload, new Date().toISOString());
          if (!checked.ok) throw new CoordinationError(`Unsupported create payload: ${checked.reason}`, 400, 'invalid_payload');
          payload = checked.value as unknown as Record<string, unknown>;
        }
        const result = await createCoordinationThread({
          actor: actorFrom(req),
          intendedRecipient,
          title: req.body?.title,
          description: req.body?.description,
          priority: req.body?.priority,
          content: req.body?.content,
          idempotencyKey: idempotencyKey(req),
          sourceReference: req.body?.sourceReference,
          ...(payload ? { payload } : {}),
        });
        res.status(result.deduplicated ? 200 : 201).json({
          achievedState: 'stored',
          accepted: false,
          ...result,
        });
      } catch (error) {
        sendError(res, error);
      }
    },
  );

  app.get(
    '/api/coordination/threads',
    requireCoordinationAuth,
    async (req: CoordinationAuthenticatedRequest, res: Response) => {
      try {
        const actor = actorFrom(req);
        if (req.query.actor && req.query.actor !== actor) {
          throw new CoordinationError(
            'actor query must match the authenticated actor',
            403,
            'actor_mismatch',
          );
        }
        const sinceValue = req.query.since ?? req.query.cursor;
        const since = sinceValue === undefined
          ? undefined
          : positiveInteger(sinceValue, 'cursor');
        const limit = positiveInteger(req.query.limit, 'limit', 50);
        const feed = await listCoordinationFeed(actor, since, limit);
        recordLedgerReadAfterSuccessfulResponse(req, res);
        res.json({ actor, ...feed });
      } catch (error) {
        sendError(res, error);
      }
    },
  );

  app.post(
    '/api/coordination/threads/ack',
    requireCoordinationAuth,
    async (req: CoordinationAuthenticatedRequest, res: Response) => {
      try {
        const rawCursor = req.body?.globalSequence ?? req.body?.cursor;
        const globalSequence = positiveInteger(rawCursor, 'globalSequence');
        res.json(await acknowledgeCoordinationFeed(actorFrom(req), globalSequence));
      } catch (error) {
        sendError(res, error);
      }
    },
  );

  app.get(
    '/api/coordination/threads/:threadId',
    requireCoordinationAuth,
    async (req: CoordinationAuthenticatedRequest, res: Response) => {
      try {
        const afterSequence = positiveInteger(req.query.afterSequence, 'afterSequence', 0);
        res.json(await getCoordinationThread(req.params.threadId, actorFrom(req), afterSequence));
      } catch (error) {
        sendError(res, error);
      }
    },
  );

  app.post(
    '/api/coordination/threads/:threadId/events',
    requireCoordinationAuth,
    async (req: CoordinationAuthenticatedRequest, res: Response) => {
      try {
        if (!isCoordinationEventType(req.body?.eventType)) {
          throw new CoordinationError('eventType is invalid', 400, 'invalid_event_type');
        }
        if (['created', 'delivered'].includes(req.body.eventType)) {
          throw new CoordinationError('eventType is reserved', 403, 'invalid_event_type');
        }
        const result = await appendFromRequest(
          req,
          req.body.eventType,
          req.body.eventType === 'comment' ? 'Comment added' : 'Coordination event added',
        );
        res.status(result.deduplicated ? 200 : 201).json(result);
      } catch (error) {
        sendError(res, error);
      }
    },
  );

  app.post(
    '/api/coordination/threads/:threadId/complete-with-linked-outcome',
    requireCoordinationAuth,
    async (req: CoordinationAuthenticatedRequest, res: Response) => {
      try {
        const reply = req.body?.reply;
        if (!reply || typeof reply !== 'object') {
          throw new CoordinationError('reply is required', 400, 'invalid_request');
        }
        const result = await completeWithLinkedOutcome({
          threadId: req.params.threadId,
          actor: actorFrom(req),
          content: typeof req.body?.content === 'string' && req.body.content.trim()
            ? req.body.content
            : 'Work completed',
          expectedSequence: positiveInteger(req.body?.expectedSequence, 'expectedSequence'),
          idempotencyKey: idempotencyKey(req),
          evidence: evidenceFrom(req.body?.evidence),
          causalParentEventId: typeof req.body?.causalParentEventId === 'string'
            ? req.body.causalParentEventId
            : undefined,
          reply: {
            body: reply.body,
            subject: reply.subject,
            sessionLabel: reply.sessionLabel,
          },
        });
        res.status(result.deduplicated ? 200 : 201).json(result);
      } catch (error) {
        sendError(res, error);
      }
    },
  );

  for (const route of lifecycleRoutes) {
    app.post(
      `/api/coordination/threads/:threadId/${route.path}`,
      requireCoordinationAuth,
      async (req: CoordinationAuthenticatedRequest, res: Response) => {
        try {
          const result = await appendFromRequest(req, route.eventType, route.defaultContent);
          res.status(result.deduplicated ? 200 : 201).json(result);
        } catch (error) {
          sendError(res, error);
        }
      },
    );
  }
}
