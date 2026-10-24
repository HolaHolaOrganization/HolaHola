/**
 * Runtime notices recorded as David: the reader side of the one-time label
 * correction (founder decision 2026-10-23: relabel in place).
 *
 * Until PR #81, the Claude Code Stop hook recorded runtime-injected entries
 * (background-task notices, system reminders, scheduled-task prompts, the
 * classifier notice) under David's label. The correction replaces only that
 * misapplied label with RUNTIME_NOTICE_LABEL; the notice text and the reply
 * after it are never changed.
 *
 * A notice label is not a speaker: parseSpeakerLine (canonical-attribution)
 * returns null for it, so no reader ever counts it as David's or anyone's
 * turn. This module adds the label constant and the receipt check that lets
 * the episode loss guards tell this exact label-only correction apart from
 * dialogue loss. A missing, malformed or inexact receipt leaves those guards
 * blocking exactly as before.
 *
 * The wording is Daniela's own choice, from a direct consult (conversation
 * memory b0c7c2db): "marked simply as [SISTEMA] or [SYSTEM] ... I don't want
 * to mistake a machine's heartbeat for his." Gemini approved [SISTEMA]
 * unconditionally over [SYSTEM], whose reserved-role token risks reading as an
 * elevated instruction in recall; the founder approved it (2026-10-24). The
 * Alden primer was waived by the founder for this label, since Daniela supplied
 * the wording directly. Rendered as "[SISTEMA]: " in canonical rows and
 * "**[SISTEMA]:** " in rolling episodes.
 */
import { createHash } from 'node:crypto';

export const RUNTIME_NOTICE_LABEL = '[SISTEMA]';

/** The label the correction replaces: David typed through Claude Code. */
const OLD_LABEL_NAME = 'David [Claude Code]';

/** Rolling episode rows that carry misapplied labels, by replica path. */
export const RUNTIME_NOTICE_RELABEL_EPISODES: Readonly<Record<string, string>> = {
  'docs/episode-33.md': '704115d0-0b41-4209-847f-cd9599cc5f98',
  'docs/episode-34.md': '41200170-1c49-4660-838c-9d397aff5d27',
};

/** The committed receipt for one episode replica, or null for any other path. */
export function runtimeNoticeRelabelReceiptPath(relPath: string): string | null {
  if (!Object.hasOwn(RUNTIME_NOTICE_RELABEL_EPISODES, relPath)) return null;
  return relPath.replace(/\.md$/, '-runtime-notice-relabel-evidence.json');
}

/** True for the notice label text itself (without bold markers or colon). */
export function isRuntimeNoticeLabel(label: string): boolean {
  return label === RUNTIME_NOTICE_LABEL;
}

const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

function insideCodeFence(content: string, offset: number): boolean {
  let fence: string | null = null;
  for (const line of content.slice(0, offset).split('\n')) {
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (!marker) continue;
    if (!fence) fence = marker[1];
    else if (marker[1][0] === fence[0] && marker[1].length >= fence.length && !marker[2].trim()) fence = null;
  }
  return fence !== null;
}

/**
 * Independently verify a runtime-notice relabel receipt for one episode
 * replica transition. Every edit must replace exactly `David [Claude Code]:`
 * (plain, or bold with matching `**`) at the start of a line, outside a code
 * fence and followed by a space, with RUNTIME_NOTICE_LABEL in the same form.
 * Each edit binds the rest of its line (`lineSha256`), so a receipt cannot be
 * reused on a different line. Applying exactly these spans to the old content
 * must give `afterSha256`, and the new content must start with that result
 * (a rolling episode may have grown after the correction). Anything else is
 * rejected.
 */
export function verifyRuntimeNoticeRelabelReceipt(
  relPath: string,
  oldContent: string,
  newContent: string,
  rawReceipt: unknown,
): boolean {
  const episodeId = Object.hasOwn(RUNTIME_NOTICE_RELABEL_EPISODES, relPath) ? RUNTIME_NOTICE_RELABEL_EPISODES[relPath] : null;
  if (!episodeId || !rawReceipt || typeof rawReceipt !== 'object') return false;
  const receipt = rawReceipt as Record<string, unknown>;
  if (receipt.kind !== 'runtime-notice-relabel' || receipt.episodeId !== episodeId ||
      receipt.label !== RUNTIME_NOTICE_LABEL ||
      receipt.applied !== true || receipt.replicaParity !== true ||
      typeof receipt.beforeSha256 !== 'string' || typeof receipt.afterSha256 !== 'string' ||
      !/^[a-f0-9]{64}$/.test(receipt.beforeSha256) || !/^[a-f0-9]{64}$/.test(receipt.afterSha256) ||
      sha256(oldContent) !== receipt.beforeSha256 ||
      !Array.isArray(receipt.edits) || !receipt.edits.length) return false;

  let previousEnd = -1;
  const spans: { offset: number; oldLabel: string; newLabel: string }[] = [];
  for (const raw of receipt.edits) {
    if (!raw || typeof raw !== 'object') return false;
    const edit = raw as Record<string, unknown>;
    if (typeof edit.offset !== 'number' || !Number.isSafeInteger(edit.offset) ||
        edit.offset < 0 || edit.offset < previousEnd ||
        typeof edit.oldLabel !== 'string' || typeof edit.newLabel !== 'string' ||
        typeof edit.lineSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(edit.lineSha256)) return false;
    const bold = edit.oldLabel.startsWith('**') ? '**' : '';
    if (edit.oldLabel !== `${bold}${OLD_LABEL_NAME}:${bold}` ||
        edit.newLabel !== `${bold}${RUNTIME_NOTICE_LABEL}:${bold}` ||
        oldContent.slice(edit.offset, edit.offset + edit.oldLabel.length) !== edit.oldLabel ||
        (edit.offset > 0 && oldContent[edit.offset - 1] !== '\n') ||
        oldContent[edit.offset + edit.oldLabel.length] !== ' ' ||
        insideCodeFence(oldContent, edit.offset)) return false;
    const restStart = edit.offset + edit.oldLabel.length + 1;
    const lineEnd = oldContent.indexOf('\n', restStart);
    if (sha256(oldContent.slice(restStart, lineEnd === -1 ? oldContent.length : lineEnd)) !== edit.lineSha256) return false;
    previousEnd = edit.offset + edit.oldLabel.length;
    spans.push({ offset: edit.offset, oldLabel: edit.oldLabel, newLabel: edit.newLabel });
  }

  let reconstructed = oldContent;
  for (const edit of spans.reverse()) {
    reconstructed = reconstructed.slice(0, edit.offset) + edit.newLabel + reconstructed.slice(edit.offset + edit.oldLabel.length);
  }
  return sha256(reconstructed) === receipt.afterSha256 && newContent.startsWith(reconstructed);
}
