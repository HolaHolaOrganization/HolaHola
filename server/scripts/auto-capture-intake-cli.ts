/**
 * auto-capture-intake-cli.ts — operator view and correction for writer 3's
 * durable auto-capture intake (attribution design f5d77712 section 3.5).
 *
 *   npx tsx server/scripts/auto-capture-intake-cli.ts list
 *   npx tsx server/scripts/auto-capture-intake-cli.ts assign --record <name> --turn-id <id>
 *
 * `list` shows each pending record's name, id, roles and byte size (never
 * the dialogue text). `assign` commits ONE named pending record's exact bytes
 * under an explicit caller turn id, through the locked canonical ingress. The
 * id must come from the caller that authored the exchange; never derive it
 * from the record name, a timestamp, the text or a digest.
 *
 * Exit codes: 0 recorded / exact retry / listed; 2 usage; 3 refused;
 * 4 still pending (with the reason); 5 not pending; 75 busy (retry).
 */
import { assignIntakeTurnId, listAutoCaptureIntake } from '../services/auto-capture-intake';

const args = process.argv.slice(2);
const arg = (flag: string) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : undefined; };

if (args[0] === 'list') {
  const records = listAutoCaptureIntake();
  if (records.length === 0) console.log('[AutoCaptureIntake] no pending records');
  for (const r of records) console.log(`${r.name}  turnId=${r.turnId ?? '(missing)'}  roles=${r.roles.join('+') || '(none)'}  bytes=${r.bytes}`);
  process.exit(0);
}

if (args[0] === 'assign') {
  const record = arg('--record');
  const turnId = arg('--turn-id');
  if (!record || !turnId) {
    console.error('usage: auto-capture-intake-cli.ts assign --record <name> --turn-id <id>');
    process.exit(2);
  }
  const result = assignIntakeTurnId(record, turnId);
  switch (result.kind) {
    case 'recorded':
    case 'exact-retry':
      console.log(`[AutoCaptureIntake] ${result.kind}: ${record} committed under ${result.turnId}; the canonical pipeline projects it`);
      process.exit(0);
    case 'pending':
      console.error(`[AutoCaptureIntake] still pending, unchanged: ${result.reason}`);
      process.exit(4);
    case 'not-pending':
      console.error(`[AutoCaptureIntake] ${record} is not pending; canonical log ${result.canonicalHasTurnId ? 'holds' : 'does not hold'} ${turnId}`);
      process.exit(5);
    case 'refused':
      console.error(`[AutoCaptureIntake] refused: ${result.reason}`);
      process.exit(3);
    case 'busy':
      console.error('[AutoCaptureIntake] intake is busy; retry the same command');
      process.exit(75);
  }
}

console.error('usage: auto-capture-intake-cli.ts list | assign --record <name> --turn-id <id>');
process.exit(2);
