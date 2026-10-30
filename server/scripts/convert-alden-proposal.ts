/**
 * Convert one of Alden's stored fix proposals into a working tree a reviewing
 * hat can turn into a pull request (gated-fixes design e4f8e988, P1 "At PR
 * conversion").
 *
 *   npx tsx server/scripts/convert-alden-proposal.ts --id <build_queue id> --worktree <new dir> [--remote origin]
 *
 * It fetches the remote, refuses a pin that is not published ("pin not
 * published"), re-verifies every before-hash, unique find and after-hash at
 * the pinned commit ("stale base" on any mismatch; it never re-targets), then
 * adds a detached worktree at the pinned commit and writes the change there.
 * It does not commit, push or open anything: the hat reviews the diff and
 * lands it with its own identity and the normal review process. Rebasing onto
 * newer main happens after that PR exists.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { buildQueue } from '@shared/schema';
import { getUserDb, closeDbConnections } from '../db';
import { gitEntryAt, isCommitPublished, verifyProposalForConversion, writeConvertedFiles } from '../services/alden-propose-fix';

function option(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const id = option('id');
  const worktree = option('worktree');
  const remote = option('remote') ?? 'origin';
  if (!id || !worktree) throw new Error('usage: --id <build_queue id> --worktree <new dir> [--remote origin]');
  const target = path.resolve(worktree);
  if (fs.existsSync(target)) throw new Error(`refusing: ${target} already exists`);
  const root = process.cwd();
  const git = (args: string[], cwd = root) => execFileSync('git', args, { cwd, maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });

  const [row] = await getUserDb().select().from(buildQueue).where(eq(buildQueue.id, id));
  if (!row) throw new Error(`no build_queue row ${id}`);
  if (row.proposedBy !== 'alden' || row.status !== 'pending') throw new Error(`refusing: ${id} is not a pending Alden proposal (${row.proposedBy}, ${row.status})`);

  if (!/^[A-Za-z0-9._-]+$/.test(remote)) throw new Error(`refusing: invalid remote name ${remote}`);
  // --prune drops deleted branches, so stale remote refs are not publication evidence.
  git(['fetch', '--quiet', '--prune', remote]);
  if (!row.pinCommit || !isCommitPublished(root, row.pinCommit, remote)) {
    throw new Error(`pin not published: ${row.pinCommit ?? '(none)'} is not on any ${remote} branch; a local dev commit must be pushed and reviewed first`);
  }
  const files = verifyProposalForConversion(row, (commit, rel) => gitEntryAt(root, commit, rel));

  git(['worktree', 'add', '--quiet', '--detach', target, row.pinCommit]);
  writeConvertedFiles(target, files);
  console.log(JSON.stringify({
    converted: id,
    pinKind: row.pinKind,
    pinCommit: row.pinCommit,
    worktree: target,
    files: files.map((f) => f.path),
    next: 'Review the diff in the worktree, commit it with your own identity, and open a PR for review.',
  }, null, 2));
}

main()
  .catch((err) => {
    console.error(`CONVERSION REFUSED: ${err?.message ?? err}`);
    process.exitCode = 1;
  })
  .finally(() => closeDbConnections().catch(() => {}));
