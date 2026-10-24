/**
 * Reader side of the runtime-notice relabel: a notice label is never a
 * speaker, and only an exact label-only receipt lets the episode loss guards
 * accept the correction. No data is changed here; everything is synthetic.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseSpeakerLine } from '../services/canonical-attribution';
import { checkEpisodeContentLoss, type GitRunner } from '../services/episode-content-loss-guard';
import {
  RUNTIME_NOTICE_LABEL,
  isRuntimeNoticeLabel,
  runtimeNoticeRelabelReceiptPath,
  verifyRuntimeNoticeRelabelReceipt,
} from '../services/runtime-notice-relabel';

const sha = (t: string) => createHash('sha256').update(t, 'utf8').digest('hex');
const EP34 = 'docs/episode-34.md';
const NOTICE = '<task-notification> background task "CI" completed </task-notification>';
const before = `# Episode\n\n**David [Claude Code]:** ${NOTICE}\n\n**Claude Code:** CI is green — exact words 🙂\n\n**David [Claude Code]:** a real founder line stays\n`;
const after = before.replace(`**David [Claude Code]:** ${NOTICE}`, `**${RUNTIME_NOTICE_LABEL}:** ${NOTICE}`);

function receiptFor(oldContent: string, newContent: string, extra: Record<string, unknown> = {}) {
  const offset = oldContent.indexOf(`**David [Claude Code]:** ${NOTICE}`);
  return {
    kind: 'runtime-notice-relabel',
    episodeId: '41200170-1c49-4660-838c-9d397aff5d27',
    label: RUNTIME_NOTICE_LABEL,
    applied: true, replicaParity: true,
    beforeSha256: sha(oldContent), afterSha256: sha(newContent),
    edits: [{ offset, oldLabel: '**David [Claude Code]:**', newLabel: `**${RUNTIME_NOTICE_LABEL}:**`, lineSha256: sha(NOTICE) }],
    ...extra,
  };
}

test('a notice label line is never parsed as a speaker, in plain or bold form', () => {
  assert.equal(isRuntimeNoticeLabel(RUNTIME_NOTICE_LABEL), true);
  assert.equal(parseSpeakerLine(`${RUNTIME_NOTICE_LABEL}: ${NOTICE}`), null);
  assert.equal(parseSpeakerLine(`**${RUNTIME_NOTICE_LABEL}:** ${NOTICE}`), null);
  assert.equal(parseSpeakerLine('**David [Claude Code]:** hello')?.name, 'David');
});

test('receipt paths exist only for the two affected episode replicas', () => {
  assert.equal(runtimeNoticeRelabelReceiptPath('docs/episode-33.md'), 'docs/episode-33-runtime-notice-relabel-evidence.json');
  assert.equal(runtimeNoticeRelabelReceiptPath(EP34), 'docs/episode-34-runtime-notice-relabel-evidence.json');
  assert.equal(runtimeNoticeRelabelReceiptPath('docs/episode-35.md'), null);
});

test('an exact label-only receipt verifies, including after the rolling episode grew', () => {
  const receipt = receiptFor(before, after);
  assert.equal(verifyRuntimeNoticeRelabelReceipt(EP34, before, after, receipt), true);
  assert.equal(verifyRuntimeNoticeRelabelReceipt(EP34, before, after + '\n**David [Claude Code]:** appended later\n', receipt), true);
});

test('the receipt rejects anything beyond the exact label span', () => {
  const receipt = receiptFor(before, after);
  const edit = receipt.edits[0];
  const cases: Array<[string, string, string, unknown]> = [
    ['wrong replica', 'docs/episode-35.md', after, receipt],
    ['changed notice text', EP34, after.replace('completed', 'finished'), receipt],
    ['changed reply text', EP34, after.replace('exact words', 'other words'), receipt],
    ['relabelled a genuine founder line too', EP34, after.replace('**David [Claude Code]:** a real', `**${RUNTIME_NOTICE_LABEL}:** a real`), receipt],
    ['deleted dialogue', EP34, after.replace('a real founder line stays', ''), receipt],
    ['wrong before hash', EP34, after, { ...receipt, beforeSha256: '0'.repeat(64) }],
    ['wrong after hash', EP34, after, { ...receipt, afterSha256: '0'.repeat(64) }],
    ['wrong kind', EP34, after, { ...receipt, kind: 'claude-attribution' }],
    ['wrong label', EP34, after, { ...receipt, label: 'Something else' }],
    ['unapplied', EP34, after, { ...receipt, applied: false }],
    ['no replica parity', EP34, after, { ...receipt, replicaParity: false }],
    ['line hash for another line', EP34, after, { ...receipt, edits: [{ ...edit, lineSha256: sha('a real founder line stays') }] }],
    ['different new label', EP34, after, { ...receipt, edits: [{ ...edit, newLabel: '**Daniela:**' }] }],
    ['mismatched bold', EP34, after, { ...receipt, edits: [{ ...edit, newLabel: `${RUNTIME_NOTICE_LABEL}:` }] }],
    ['offset not at a label', EP34, after, { ...receipt, edits: [{ ...edit, offset: edit.offset + 1 }] }],
    ['no edits', EP34, after, { ...receipt, edits: [] }],
    ['malformed', EP34, after, null],
  ];
  for (const [name, path, content, r] of cases) {
    assert.equal(verifyRuntimeNoticeRelabelReceipt(path, before, content, r), false, name);
  }
});

test('a self-consistent receipt for any other old or new label is rejected', () => {
  for (const [oldLabel, newLabel] of [['**David [Claude Code]:**', '**Daniela:**'], ['**David [Claude Code]:**', '**David:**'], ['**Claude Code:**', `**${RUNTIME_NOTICE_LABEL}:**`]]) {
    const oldContent = `# Episode

${oldLabel} ${NOTICE}
`;
    const newContent = oldContent.replace(oldLabel, newLabel);
    const receipt = {
      ...receiptFor(oldContent, newContent),
      edits: [{ offset: oldContent.indexOf(oldLabel), oldLabel, newLabel, lineSha256: sha(NOTICE) }],
    };
    assert.equal(verifyRuntimeNoticeRelabelReceipt(EP34, oldContent, newContent, receipt), false, `${oldLabel} -> ${newLabel}`);
  }
});

test('a label inside a code fence is never relabelled', () => {
  const fenced = `# Episode\n\n\`\`\`\n**David [Claude Code]:** ${NOTICE}\n\`\`\`\n`;
  const fencedAfter = fenced.replace('**David [Claude Code]:**', `**${RUNTIME_NOTICE_LABEL}:**`);
  assert.equal(verifyRuntimeNoticeRelabelReceipt(EP34, fenced, fencedAfter, receiptFor(fenced, fencedAfter)), false);
});

function gitRunner(cwd: string): GitRunner {
  return async (args: string[]) => {
    try {
      return { stdout: execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] }), exitCode: 0 };
    } catch (err: any) {
      return { stdout: typeof err?.stdout === 'string' ? err.stdout : '', exitCode: typeof err?.status === 'number' ? err.status : 1 };
    }
  };
}

test('the content-loss guard blocks the relabel without a committed receipt and passes it with one', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'notice-relabel-guard-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  try {
    mkdirSync(join(repo, 'docs'));
    git('init', '-b', 'main', '-q');
    git('config', 'user.email', 'ci@test');
    git('config', 'user.name', 'CI Test');
    const commit = (message: string) => { git('add', '-A'); git('commit', '--allow-empty', '-qm', message); return git('rev-parse', 'HEAD'); };
    writeFileSync(join(repo, 'docs', 'episode-34.md'), before);
    const base = commit('seed');
    writeFileSync(join(repo, 'docs', 'episode-34.md'), after);
    const bare = commit('relabel without receipt');
    const runGit = gitRunner(repo);
    assert.equal((await checkEpisodeContentLoss(runGit, base, bare)).blocked, true);
    writeFileSync(join(repo, 'docs', 'episode-34-runtime-notice-relabel-evidence.json'), JSON.stringify(receiptFor(before, after)));
    const withReceipt = commit('commit receipt');
    const verified = await checkEpisodeContentLoss(runGit, base, withReceipt);
    assert.equal(verified.blocked, false);
    assert.deepEqual(verified.violations, {});
    writeFileSync(join(repo, 'docs', 'episode-34.md'), after.replace('exact words', 'other words'));
    assert.equal((await checkEpisodeContentLoss(runGit, base, commit('change a reply'))).blocked, true);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
