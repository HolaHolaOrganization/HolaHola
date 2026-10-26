import { closeDbConnections } from '../db';
import {
  completeCoordinationRuntimeReplacement,
  disableCoordinationRuntimeRegistration,
  reissueCoordinationRuntimeBootstrap,
  rollbackCoordinationRuntimeReplacement,
  stageCoordinationRuntimeReplacement,
} from '../services/coordination-credential-broker';
import { isDirectCliInvocation } from './lib/cli-entrypoint';

function option(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function usage(): never {
  throw new Error([
    'Usage:',
    '  stage --from-runtime-id <current-id> --runtime-id <new-id> --display-name <name>',
    '  complete --from-runtime-id <current-id> --runtime-id <new-id>',
    '  rollback --from-runtime-id <current-id> --runtime-id <new-id>',
    '  reissue --runtime-id <existing-id>',
    '  disable --runtime-id <existing-id> [--dormant-days <n>]',
    '',
    'stage/complete/rollback move a live runtime to a new immutable ID without',
    'interrupting its current credential (zero-downtime rotation).',
    '',
    'reissue replaces the bootstrap secret in place for the SAME existing',
    'runtime ID. Use it to recover a runtime whose bootstrap was already',
    'consumed or lost and has nothing live left to protect -- the common case',
    'after a crash, redeploy, or container recycle.',
    '',
    'disable permanently closes out a standalone registration that was',
    'abandoned before it was ever staged into a rotation pair -- e.g. one that',
    'kept failing bootstrap exchange and was replaced by registering a brand',
    'new runtime ID from scratch. It refuses to run while the registration',
    'still has a live, unexpired, or ever-used credential, or is part of an',
    'active staged/ready rotation -- use revoke or rotation for those instead.',
    '',
    '--dormant-days <n> (integer, at least 30) also retires a registration whose',
    'credentials were used in the past but are all expired or revoked, with the',
    'most recent use at least n days ago. A live credential still refuses.',
  ].join('\n'));
}

export function formatRollbackOutcome(input: {
  actor: string;
  sourceRuntimeId: string;
  replacementRuntimeId: string;
  sourceActive: boolean;
}): string {
  if (input.sourceActive) {
    return `Rotation rolled back for ${input.actor}: ${input.replacementRuntimeId} is revoked and ${input.sourceRuntimeId} remains active.\n`;
  }
  return [
    `Rotation rolled back for ${input.actor}: ${input.replacementRuntimeId} is revoked.`,
    `${input.sourceRuntimeId} was already disabled and was not re-enabled; no runtime in this pair remains active.`,
    'Recover by staging a new replacement from another active registration for this actor.',
    '',
  ].join('\n');
}

async function main(): Promise<void> {
  const action = process.argv[2];

  if (action === 'reissue') {
    const runtimeId = option('runtime-id');
    if (!runtimeId) usage();
    const result = await reissueCoordinationRuntimeBootstrap(runtimeId);
    if (!result.ok) throw new Error(`Bootstrap could not be reissued: ${result.reason}`);
    process.stdout.write([
      `Bootstrap reissued in place for ${runtimeId} (${result.actor}).`,
      'The runtime ID, actor, capabilities, and token TTL are unchanged; only the bootstrap secret is new.',
      'Any credential this runtime already holds is untouched and keeps working until it expires or is revoked.',
      'Store this bootstrap token in that runtime’s existing 1Password item, replacing the old value.',
      'It is shown once and cannot be recovered from the database:',
      result.bootstrapToken,
      '',
    ].join('\n'));
    return;
  }

  if (action === 'disable') {
    const runtimeId = option('runtime-id');
    if (!runtimeId) usage();
    const dormantDaysText = option('dormant-days');
    if (dormantDaysText !== undefined && !/^\d+$/.test(dormantDaysText)) usage();
    const result = await disableCoordinationRuntimeRegistration(runtimeId, undefined, {
      dormantDays: dormantDaysText === undefined ? undefined : Number(dormantDaysText),
    });
    if (!result.ok) throw new Error(`Registration could not be disabled: ${result.reason}`);
    process.stdout.write(
      `Registration ${runtimeId} (${result.actor}) is now disabled and revoked. It can no longer exchange its bootstrap or authenticate any credential.\n`,
    );
    return;
  }

  const sourceRuntimeId = option('from-runtime-id');
  const replacementRuntimeId = option('runtime-id');
  if (!sourceRuntimeId || !replacementRuntimeId) usage();

  if (action === 'stage') {
    const replacementDisplayName = option('display-name');
    if (!replacementDisplayName) usage();
    const result = await stageCoordinationRuntimeReplacement({
      sourceRuntimeId,
      replacementRuntimeId,
      replacementDisplayName,
    });
    if (!result.ok) throw new Error(`Rotation could not be staged: ${result.reason}`);
    process.stdout.write([
      `Replacement runtime ${replacementRuntimeId} staged for ${sourceRuntimeId} as ${result.actor}.`,
      `Capabilities and token TTL were copied exactly (${result.tokenTtlSeconds}s).`,
      'Store this bootstrap token in only the replacement runtime’s 1Password vault item.',
      'It is shown once and cannot be recovered from the database:',
      result.bootstrapToken,
      '',
      'Do not complete rotation yet. Start the replacement, exchange this bootstrap,',
      'then call POST /api/coordination/credentials/rotation-ready with its broker credential.',
      '',
    ].join('\n'));
    return;
  }

  if (action === 'complete') {
    const result = await completeCoordinationRuntimeReplacement({
      sourceRuntimeId,
      replacementRuntimeId,
    });
    if (!result.ok) throw new Error(`Rotation could not be completed: ${result.reason}`);
    process.stdout.write(
      `Rotation completed for ${result.actor}: ${sourceRuntimeId} is revoked and ${replacementRuntimeId} remains active.\n`,
    );
    return;
  }

  if (action === 'rollback') {
    const result = await rollbackCoordinationRuntimeReplacement({
      sourceRuntimeId,
      replacementRuntimeId,
    });
    if (!result.ok) throw new Error(`Rotation could not be rolled back: ${result.reason}`);
    process.stdout.write(formatRollbackOutcome({
      actor: result.actor,
      sourceRuntimeId,
      replacementRuntimeId,
      sourceActive: result.sourceActive,
    }));
    return;
  }

  usage();
}

if (isDirectCliInvocation('coordination-runtime-rotation.ts')) {
  main()
    .catch((error) => {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
    })
    .finally(closeDbConnections);
}