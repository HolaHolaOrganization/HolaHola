import {
  createCoordinationActorClient,
  type CoordinationClientActor,
  type CoordinationEventInput,
} from '../services/coordination-actor-client';
import { FileCoordinationCliCredentialCache } from '../services/coordination-cli-credential-cache';
import { isDirectCliInvocation } from './lib/cli-entrypoint';
import { validateCreatePayload } from '../../shared/worker-contracts';
import {
  COORDINATION_ACTOR_IDS,
  type CoordinationEvidenceReference,
  type CoordinationActorId,
} from '@shared/schema';

type Options = Record<string, string | boolean>;

const commands = new Set([
  'create', 'list', 'ack-feed', 'inbox', 'ack-inbox', 'show', 'accept', 'progress', 'evidence', 'block',
  'complete', 'acknowledge', 'reopen', 'reassign', 'comment', 'reply-and-verify',
  'complete-with-linked-outcome',
]);
const eventCommands = new Set([
  'accept', 'progress', 'evidence', 'block', 'complete', 'acknowledge',
  'reopen', 'reassign', 'comment',
]);

function print(value: unknown, stream: NodeJS.WriteStream = process.stdout): void {
  stream.write(`${JSON.stringify(value, null, 2)}\n`);
}

function fail(message: string, exitCode = 64): never {
  print({ error: message, usage: 'coordination-cli <command> [options]' }, process.stderr);
  process.exit(exitCode);
}

function usage(): never {
  return fail(
    'Commands: create, list, ack-feed, show, accept, progress, evidence, block, complete, acknowledge, reopen, reassign, comment, reply-and-verify, complete-with-linked-outcome. ' +
    'Configuration: COORDINATION_API_URL, COORDINATION_ACTOR, and that actor’s dedicated COORDINATION_*_TOKEN. ' +
    'There is no shared coordination token. --url overrides the API URL. ' +
    'Mutations require --idempotency-key; event mutations require --id and --expected-sequence. ' +
    'Use --cursor/--limit for list, --global-sequence for ack-feed, --after-sequence for show, and --evidence/--data with event mutations. ' +
    'Plain comment is record-only and requires --ledger-only; use reply-and-verify for a recipient-facing response.',
  );
}

function parseArgs(args: string[]): { command: string; options: Options } {
  const command = args.shift();
  if (!command || !commands.has(command)) usage();
  const options: Options = {};
  while (args.length) {
    const token = args.shift()!;
    if (!token.startsWith('--')) fail(`Unexpected argument: ${token}`);
    const name = token.slice(2);
    if (!name) usage();
    const value = args[0] && !args[0].startsWith('--') ? args.shift()! : true;
    if (options[name] !== undefined) fail(`Option --${name} was provided more than once`);
    options[name] = value;
  }
  return { command, options };
}

const OPTIONS_BY_COMMAND: Record<string, ReadonlySet<string>> = {
  list: new Set(['url', 'cursor', 'limit']),
  'ack-feed': new Set(['url', 'global-sequence']),
  inbox: new Set(['url', 'token', 'after', 'limit', 'human']),
  'ack-inbox': new Set(['url', 'window-token']),
  show: new Set(['url', 'id', 'after-sequence']),
  create: new Set([
    'url', 'title', 'description', 'recipient', 'priority', 'source-reference',
    'idempotency-key', 'data',
  ]),
  accept: new Set(['url', 'id', 'expected-sequence', 'idempotency-key', 'content', 'evidence', 'data', 'causal-parent-event-id']),
  progress: new Set(['url', 'id', 'expected-sequence', 'idempotency-key', 'content', 'evidence', 'data', 'causal-parent-event-id']),
  evidence: new Set(['url', 'id', 'expected-sequence', 'idempotency-key', 'content', 'evidence', 'data', 'causal-parent-event-id']),
  block: new Set(['url', 'id', 'expected-sequence', 'idempotency-key', 'content', 'evidence', 'data', 'causal-parent-event-id']),
  complete: new Set(['url', 'id', 'expected-sequence', 'idempotency-key', 'content', 'evidence', 'data', 'causal-parent-event-id']),
  acknowledge: new Set(['url', 'id', 'expected-sequence', 'idempotency-key', 'content', 'evidence', 'data', 'causal-parent-event-id']),
  reopen: new Set(['url', 'id', 'expected-sequence', 'idempotency-key', 'content', 'evidence', 'data', 'causal-parent-event-id']),
  reassign: new Set([
    'url', 'id', 'expected-sequence', 'idempotency-key', 'content', 'recipient',
    'evidence', 'data',
  ]),
  comment: new Set(['url', 'id', 'expected-sequence', 'idempotency-key', 'content', 'recipient', 'evidence', 'data', 'causal-parent-event-id', 'ledger-only']),
  'reply-and-verify': new Set(['url', 'id', 'body', 'subject', 'session-label', 'event-type', 'idempotency-key']),
  'complete-with-linked-outcome': new Set([
    'url', 'id', 'expected-sequence', 'idempotency-key', 'content', 'evidence',
    'causal-parent-event-id', 'reply-body', 'reply-subject', 'reply-session-label',
  ]),
};

export function unsupportedCoordinationCliOptions(
  command: string,
  options: Options,
): string[] {
  const allowed = OPTIONS_BY_COMMAND[command] ?? new Set<string>();
  return Object.keys(options).filter((name) => !allowed.has(name));
}

export function assertExplicitCoordinationCommentIntent(
  command: string,
  options: Options,
): void {
  if (command !== 'comment') return;
  const hasRecipient = typeof options.recipient === 'string';
  const ledgerOnly = options['ledger-only'] === true;
  if (hasRecipient === ledgerOnly) {
    throw new Error(
      'comment requires exactly one delivery intent: pass --recipient for a recipient-facing inbox message, ' +
      'or --ledger-only for a record-only comment.',
    );
  }
}

export type CoordinationCliDeliverySummary = {
  state: 'delivered' | 'queued' | 'not_requested' | 'failed' | 'unknown';
  message: string;
};

export function coordinationCliDeliverySummary(
  command: string,
  result: unknown,
): CoordinationCliDeliverySummary | null {
  if (command === 'comment') {
    const event = typeof result === 'object' && result !== null
      ? (result as Record<string, any>).event
      : null;
    if (event?.recipientActor) {
      return {
        state: 'delivered',
        message: 'Recipient-addressed canonical inbox message recorded atomically.',
      };
    }
    return {
      state: 'not_requested',
      message: 'Ledger-only comment recorded; no recipient delivery was requested.',
    };
  }
  if (typeof result !== 'object' || result === null) return null;
  const record = result as Record<string, unknown>;
  const linkedReply = typeof record.linkedReply === 'object' && record.linkedReply !== null
    ? record.linkedReply as Record<string, unknown>
    : null;
  const rawState = linkedReply?.deliveryState ?? record.deliveryState;
  if (rawState === 'delivered') {
    return { state: 'delivered', message: 'Recipient inbox delivery verified.' };
  }
  if (rawState === 'pending' || rawState === 'queued') {
    return { state: 'queued', message: 'Recipient delivery is queued and has not been verified yet.' };
  }
  if (rawState === 'not_applicable' || rawState === 'not_requested') {
    return { state: 'not_requested', message: 'No recipient delivery was requested.' };
  }
  if (rawState === 'failed' || rawState === 'delivery_failed') {
    return { state: 'failed', message: 'Recipient delivery failed.' };
  }
  return null;
}

function required(options: Options, name: string): string {
  const value = options[name];
  if (typeof value !== 'string' || !value) fail(`--${name} is required`);
  return value;
}

// Actor and recipient validation share the canonical registry, excluding only
// the internal pseudo-actor that cannot run the CLI or receive messages.
export const SUPPORTED_COORDINATION_ACTORS: readonly CoordinationClientActor[] = COORDINATION_ACTOR_IDS.filter(
  (id): id is CoordinationClientActor => id !== 'coordination-system',
);
export const SUPPORTED_COORDINATION_CLI_ACTORS = SUPPORTED_COORDINATION_ACTORS;

export const SUPPORTED_COORDINATION_CLI_RECIPIENTS: readonly Exclude<
  CoordinationActorId,
  'coordination-system'
>[] = SUPPORTED_COORDINATION_CLI_ACTORS;

export function isSupportedCoordinationActor(value: string): value is CoordinationClientActor {
  return SUPPORTED_COORDINATION_ACTORS.includes(value as CoordinationClientActor);
}

function requiredRecipient(options: Options): Exclude<CoordinationActorId, 'coordination-system'> {
  const value = required(options, 'recipient');
  if (!isSupportedCoordinationActor(value)) {
    fail(`Unsupported --recipient: ${value}`);
  }
  return value;
}

function optionalPriority(
  options: Options,
): 'low' | 'normal' | 'high' | 'urgent' | undefined {
  const value = options.priority;
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !['low', 'normal', 'high', 'urgent'].includes(value)) {
    fail('--priority must be low, normal, high, or urgent');
  }
  return value as 'low' | 'normal' | 'high' | 'urgent';
}

function optionalNonNegativeInteger(options: Options, name: string): number | undefined {
  const value = options[name];
  if (value === undefined) return undefined;
  if (typeof value !== 'string') fail(`--${name} requires a non-negative integer`);
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) {
    fail(`--${name} requires a non-negative integer`);
  }
  return number;
}

function optionalJson(options: Options, name: string): unknown {
  const value = options[name];
  if (value === undefined) return undefined;
  if (typeof value !== 'string') fail(`--${name} requires JSON`);
  try {
    return JSON.parse(value);
  } catch {
    fail(`--${name} must be valid JSON`);
  }
}

async function main(): Promise<void> {
  const { command, options } = parseArgs(process.argv.slice(2));
  const unsupported = unsupportedCoordinationCliOptions(command, options);
  if (unsupported.length > 0) {
    fail(`Unsupported option${unsupported.length === 1 ? '' : 's'} for ${command}: ${unsupported.map((name) => `--${name}`).join(', ')}`);
  }
  try {
    assertExplicitCoordinationCommentIntent(command, options);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
  const apiUrl = typeof options.url === 'string' ? options.url : process.env.COORDINATION_API_URL;
  const actorValue = process.env.COORDINATION_ACTOR;
  if (!apiUrl) fail('COORDINATION_API_URL is required (or provide --url)');
  if (!actorValue) fail('COORDINATION_ACTOR is required; set it to the identity running this client');
  if (!isSupportedCoordinationActor(actorValue)) {
    fail(`Unsupported COORDINATION_ACTOR: ${actorValue}`);
  }
  const actor = actorValue;

  const client = createCoordinationActorClient(actor, {
    apiUrl,
    credentialCache: new FileCoordinationCliCredentialCache(),
  });
  let result: unknown;

  if (command === 'show') {
    result = await client.show(
      required(options, 'id'),
      optionalNonNegativeInteger(options, 'after-sequence') ?? 0,
    );
  } else if (command === 'list') {
    const cursor = optionalNonNegativeInteger(options, 'cursor');
    const limit = optionalNonNegativeInteger(options, 'limit');
    result = await client.listFeed({
      ...(cursor !== undefined ? { cursor } : {}),
      ...(limit !== undefined ? { limit } : {}),
    });
  } else if (command === 'inbox') {
    const after = optionalNonNegativeInteger(options, 'after');
    const limit = optionalNonNegativeInteger(options, 'limit');
    result = await client.listInbox({
      ...(typeof options.token === 'string' ? { token: options.token } : {}),
      ...(after !== undefined ? { after } : {}),
      ...(limit !== undefined ? { limit } : {}),
    });
    if (options.human === true && typeof result === 'object' && result !== null) {
      const record = result as Record<string, any>;
      const items = Array.isArray(record.items) ? record.items : [];
      for (const item of items) {
        print({
          sequence: item.inboxItem?.eventGlobalSequence,
          from: item.inboxItem?.senderActor,
          kind: item.inboxItem?.messageKind,
          thread: item.thread?.title,
          content: item.event?.content,
        });
      }
      print({ window: record.window, legacyCoverage: record.legacyCoverage });
      return;
    }
  } else if (command === 'ack-inbox') {
    result = await client.acknowledgeInbox(required(options, 'window-token'));
  } else if (command === 'ack-feed') {
    result = await client.acknowledgeFeed(
      optionalNonNegativeInteger(options, 'global-sequence')
        ?? (() => fail('--global-sequence is required'))(),
    );
  } else if (command === 'create') {
    // --data: structured created-event payload. Only hh.worker.job.v1 is accepted;
    // this local check is a convenience, the server re-validates as authority.
    const rawData = optionalJson(options, 'data');
    let createPayload: Record<string, unknown> | undefined;
    if (rawData !== undefined) {
      const checked = validateCreatePayload(rawData, new Date().toISOString());
      if (!checked.ok) fail(`--data rejected: ${checked.reason}`);
      createPayload = rawData as Record<string, unknown>;
    }
    result = await client.create({
      title: required(options, 'title'),
      description: required(options, 'description'),
      intendedRecipient: requiredRecipient(options),
      ...(optionalPriority(options) ? { priority: optionalPriority(options) } : {}),
      ...(optionalJson(options, 'source-reference') !== undefined
        ? { sourceReference: optionalJson(options, 'source-reference') as CoordinationEvidenceReference }
        : {}),
      ...(createPayload ? { payload: createPayload } : {}),
      idempotencyKey: required(options, 'idempotency-key'),
    });
  } else if (command === 'reply-and-verify') {
    if (actor !== 'luca-replit' && actor !== 'luca-claude-code') {
      fail('reply-and-verify requires COORDINATION_ACTOR=luca-replit or luca-claude-code');
    }
    result = await client.replyAndVerify({
      parentNoteId: required(options, 'id'),
      body: required(options, 'body'),
      ...(typeof options.subject === 'string' ? { subject: options.subject } : {}),
      ...(typeof options['session-label'] === 'string' ? { sessionLabel: options['session-label'] } : {}),
      ...(typeof options['event-type'] === 'string'
        ? { eventType: options['event-type'] as Exclude<import('@shared/schema').CoordinationEventType, 'created' | 'delivered'> }
        : {}),
      idempotencyKey: required(options, 'idempotency-key'),
    });
  } else if (command === 'complete-with-linked-outcome') {
    if (actor !== 'luca-replit' && actor !== 'luca-claude-code') {
      fail('complete-with-linked-outcome requires COORDINATION_ACTOR=luca-replit or luca-claude-code');
    }
    result = await client.completeWithLinkedOutcome(
      required(options, 'id'),
      {
        content: typeof options.content === 'string' ? options.content : 'Work completed',
        expectedSequence: Number(required(options, 'expected-sequence')),
        idempotencyKey: required(options, 'idempotency-key'),
        ...(optionalJson(options, 'evidence') !== undefined
          ? { evidence: optionalJson(options, 'evidence') as CoordinationEvidenceReference[] }
          : {}),
        ...(typeof options['causal-parent-event-id'] === 'string'
          ? { causalParentEventId: options['causal-parent-event-id'] }
          : {}),
        reply: {
          body: required(options, 'reply-body'),
          ...(typeof options['reply-subject'] === 'string'
            ? { subject: options['reply-subject'] }
            : {}),
          ...(typeof options['reply-session-label'] === 'string'
            ? { sessionLabel: options['reply-session-label'] }
            : {}),
        },
      },
    );
  } else if (eventCommands.has(command)) {
    const id = required(options, 'id');
    const expectedSequence = Number(required(options, 'expected-sequence'));
    if (!Number.isSafeInteger(expectedSequence) || expectedSequence < 0) fail('--expected-sequence must be a non-negative integer');
    const input: CoordinationEventInput = {
      content: typeof options.content === 'string' ? options.content : '',
      expectedSequence,
      idempotencyKey: required(options, 'idempotency-key'),
      ...(typeof options.recipient === 'string' ? { recipientActor: requiredRecipient(options) } : {}),
      ...(optionalJson(options, 'evidence') !== undefined
        ? { evidence: optionalJson(options, 'evidence') as CoordinationEvidenceReference[] }
        : {}),
      ...(optionalJson(options, 'data') !== undefined
        ? { payload: optionalJson(options, 'data') as Record<string, unknown> }
        : {}),
      ...(typeof options['causal-parent-event-id'] === 'string'
        ? { causalParentEventId: options['causal-parent-event-id'] }
        : {}),
    };
    const method = client[command as keyof typeof client];
    if (typeof method !== 'function') fail(`Unsupported client action: ${command}`);
    result = await (method as (threadId: string, input: CoordinationEventInput) => Promise<unknown>).call(
      client,
      id,
      input,
    );
  }

  print(result);
  const delivery = coordinationCliDeliverySummary(command, result);
  if (delivery) print({ delivery }, process.stderr);
}

if (isDirectCliInvocation('coordination-cli.ts')) {
  main().catch((error: unknown) => {
    print({ error: error instanceof Error ? error.message : String(error) }, process.stderr);
    process.exitCode = 1;
  });
}