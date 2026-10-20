import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

import { parseMemoryTurns, parseRawEvidence, type RawEvidenceTurn } from '../scripts/repair-preincident-watchdog-source-identity';
import { parseSpeakerLine } from './canonical-attribution';

export interface AuditNeedle {
  turn: number;
  label: string;
  text: string;
  sha256: string;
}

export interface EvidenceDocument {
  class: 'retained-capture' | 'raw-window-ledger' | 'archive-raw' | 'derived-replica';
  location: string;
  content: string;
  sha256?: string;
  eventId?: string;
  payloadSha256?: string | null;
}

export interface EvidenceMatch {
  class: EvidenceDocument['class'];
  location: string;
  documentSha256: string;
  matchedTurns: number[];
  exactSequence: boolean;
  eventId?: string;
  payloadSha256?: string | null;
  source?: 'replit' | 'claude-code';
  captureId?: string;
}

export interface EvidenceAuditReport {
  schemaVersion: 1;
  coverageComplete: boolean;
  conversationMemory: { id: string; contentSha256: string; turnCount: number };
  needles: AuditNeedle[];
  searched: Array<{
    class: EvidenceDocument['class'];
    location: string;
    sha256: string;
    bytes: number;
    eventId?: string;
    payloadSha256?: string | null;
    payloadChecksumVerified?: boolean | null;
  }>;
  matches: EvidenceMatch[];
  archive?: {
    bundlePath: string;
    bundleSha256: string;
    manifestSha256: string;
    checksumVerified: boolean;
    gitBundleVerified: boolean;
    gitFsckVerified: boolean;
  };
  conclusion: {
    status: 'safe-to-tag' | 'remain-ambiguous' | 'not-applicable';
    sourceTag: 'source-replit' | 'source-claude-code' | null;
    captureIdTag: string | null;
    reason: string;
  };
}

export function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function expectedSpeaker(label: string): RawEvidenceTurn['speaker'] {
  if (label === 'David') return 'David';
  if (label === 'LUCA [Claude Code]') return 'Claude Code';
  return 'Luca Replit';
}

function exactCaptureSequences(content: string, raw: string): RawEvidenceTurn[][] {
  const memoryTurns = parseMemoryTurns(content);
  const rawTurns = parseRawEvidence(raw);
  const matches: RawEvidenceTurn[][] = [];
  for (let start = 0; start <= rawTurns.length - memoryTurns.length; start++) {
    const candidate = rawTurns.slice(start, start + memoryTurns.length);
    if (memoryTurns.every((turn, offset) =>
      candidate[offset].speaker === expectedSpeaker(turn.label) &&
      candidate[offset].text === turn.text
    )) {
      matches.push(candidate);
    }
  }
  return matches;
}

function explicitIdentity(sequence: RawEvidenceTurn[]): {
  source?: 'replit' | 'claude-code';
  captureId?: string;
} {
  const lucaTurns = sequence.filter(turn => turn.speaker !== 'David');
  if (lucaTurns.length === 0) return {};
  const sourceAgreesWithSpeaker = lucaTurns.every(turn =>
    turn.source === null ||
    (turn.source === 'replit' && (turn.speaker === 'Luca Replit' || turn.speaker === 'Luca')) ||
    (turn.source === 'claude-code' && turn.speaker === 'Claude Code')
  );
  if (!sourceAgreesWithSpeaker) return {};
  const explicitSources = new Set(lucaTurns.map(turn => turn.source).filter(Boolean));
  let source: 'replit' | 'claude-code' | undefined;
  if (explicitSources.size === 1) source = [...explicitSources][0]!;
  else if (
    explicitSources.size === 0 &&
    lucaTurns.every(turn => turn.speaker === 'Luca Replit')
  ) source = 'replit';

  const ids = new Set(sequence.map(turn => turn.captureId).filter(Boolean));
  const captureId = ids.size === 1 && sequence.every(turn => turn.captureId)
    ? [...ids][0]!
    : undefined;
  return { source, captureId };
}

export function auditEvidenceDocuments(
  id: string,
  content: string,
  documents: EvidenceDocument[],
  archive?: EvidenceAuditReport['archive'],
  coverageComplete = true,
): EvidenceAuditReport {
  const turns = parseMemoryTurns(content);
  if (turns.length === 0 && content.split('\n').some(line => parseSpeakerLine(line)?.form === 'plain')) {
    // A plain-label row (attribution design f5d77712): its hat lives in the
    // hat-/provider-/model- tags and the attribution column, never in label
    // text. This audit proves source identity for historical bracket-label
    // rows only, so it reports not-applicable and never tags from text.
    return {
      schemaVersion: 1,
      coverageComplete,
      conversationMemory: { id, contentSha256: sha256(content), turnCount: 0 },
      needles: [],
      searched: [],
      matches: [],
      archive,
      conclusion: {
        status: 'not-applicable',
        sourceTag: null,
        captureIdTag: null,
        reason: 'Plain-label row: attribution is carried by its hat-/provider-/model- tags and attribution column, not label text; this audit applies only to historical bracket-label rows.',
      },
    };
  }
  if (turns.length === 0) throw new Error(`${id}: no exact dialogue turns found`);
  const needles = turns.map((turn, index) => ({
    turn: index + 1,
    label: turn.label,
    text: turn.text,
    sha256: sha256(turn.text),
  }));
  const searched = documents.map(document => ({
    class: document.class,
    location: document.location,
    sha256: document.sha256 ?? sha256(document.content),
    bytes: Buffer.byteLength(document.content),
    eventId: document.eventId,
    payloadSha256: document.payloadSha256,
    payloadChecksumVerified: document.payloadSha256 === undefined || document.payloadSha256 === null
      ? null
      : document.payloadSha256 === (document.sha256 ?? sha256(document.content)),
  }));
  const matches: EvidenceMatch[] = [];

  for (const document of documents) {
    const matchedTurns = needles.filter(needle => document.content.includes(needle.text)).map(needle => needle.turn);
    const sequences = ['retained-capture', 'archive-raw'].includes(document.class)
      ? exactCaptureSequences(content, document.content)
      : [];
    const documentSha256 = document.sha256 ?? sha256(document.content);
    for (const sequence of sequences) {
      matches.push({
        class: document.class,
        location: document.location,
        documentSha256,
        matchedTurns,
        exactSequence: true,
        eventId: document.eventId,
        payloadSha256: document.payloadSha256,
        ...explicitIdentity(sequence),
      });
    }
    if (matchedTurns.length > 0 && sequences.length === 0) {
      matches.push({
        class: document.class,
        location: document.location,
        documentSha256,
        matchedTurns,
        exactSequence: false,
        eventId: document.eventId,
        payloadSha256: document.payloadSha256,
      });
    }
  }

  const provingMatches = matches.filter(match =>
    match.exactSequence &&
    match.class !== 'derived-replica' &&
    match.source
  );
  const uniqueProof = provingMatches.length === 1 ? provingMatches[0] : undefined;
  const status = coverageComplete && uniqueProof ? 'safe-to-tag' : 'remain-ambiguous';
  return {
    schemaVersion: 1,
    coverageComplete,
    conversationMemory: { id, contentSha256: sha256(content), turnCount: turns.length },
    needles,
    searched,
    matches,
    archive,
    conclusion: {
      status,
      sourceTag: coverageComplete && uniqueProof
        ? uniqueProof.source === 'replit' ? 'source-replit' : 'source-claude-code'
        : null,
      captureIdTag: coverageComplete && uniqueProof?.captureId ? `capture-id:${uniqueProof.captureId}` : null,
      reason: !coverageComplete
        ? 'Archive coverage was explicitly skipped; the incomplete audit cannot support tagging.'
        : uniqueProof
        ? 'Exactly one raw source document contains the full turn sequence with explicit source identity.'
        : provingMatches.length > 1
          ? 'Multiple raw source sequences claim identity; uniqueness is not established.'
          : 'No unique full-sequence raw source match carries explicit source identity; derived replicas and text-only matches are not proof.',
    },
  };
}

export function retainedCaptureDocuments(workspace: string): EvidenceDocument[] {
  const documents: EvidenceDocument[] = [];
  const capturePath = join(workspace, '.local', '.chat_capture');
  if (existsSync(capturePath)) {
    documents.push({
      class: 'retained-capture',
      location: capturePath,
      content: readFileSync(capturePath, 'utf8'),
    });
  }
  const rawDir = join(workspace, '.local', 'raw-window-captures');
  if (existsSync(rawDir)) {
    for (const name of readdirSync(rawDir).filter(name => name.endsWith('.raw')).sort()) {
      const path = join(rawDir, name);
      documents.push({
        class: 'retained-capture',
        location: path,
        content: readFileSync(path, 'utf8'),
      });
    }
  }
  return documents;
}

function git(repo: string, args: string[], options: { encoding?: 'utf8' | 'buffer' } = {}): string | Buffer {
  return execFileSync('git', ['-C', repo, ...args], {
    encoding: options.encoding === 'buffer' ? 'buffer' : 'utf8',
    maxBuffer: 1024 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

export function verifiedArchiveDocuments(archiveDir: string): {
  documents: EvidenceDocument[];
  archive: NonNullable<EvidenceAuditReport['archive']>;
} {
  const manifestPath = join(archiveDir, 'manifest.txt');
  const manifest = readFileSync(manifestPath, 'utf8');
  const bundleName = /^archive_id=(.+)$/m.exec(manifest)?.[1];
  const expectedSha = /^bundle_sha256=(.+)$/m.exec(manifest)?.[1];
  if (!bundleName || !expectedSha) throw new Error('archive manifest lacks archive_id or bundle_sha256');
  if (!/^[A-Za-z0-9._-]+$/.test(bundleName)) throw new Error('archive_id contains unsafe path characters');
  const bundlePath = join(archiveDir, `${bundleName}.bundle`);
  const bundleSha256 = execFileSync('sha256sum', [bundlePath], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim().split(/\s+/, 1)[0];
  if (bundleSha256 !== expectedSha) throw new Error('archive bundle SHA-256 does not match manifest');

  execFileSync('git', ['bundle', 'verify', bundlePath], { stdio: ['ignore', 'ignore', 'pipe'] });
  const temp = mkdtempSync(join(tmpdir(), 'conversation-evidence-'));
  const repo = join(temp, 'recovered.git');
  try {
    execFileSync('git', ['clone', '--quiet', '--bare', bundlePath, repo], { stdio: ['ignore', 'ignore', 'pipe'] });
    git(repo, ['fsck', '--full', '--strict', '--no-reflogs']);
    const objectRows = String(git(repo, [
      'cat-file', '--batch-all-objects', '--batch-check=%(objectname) %(objecttype) %(objectsize)',
    ])).trim().split('\n').filter(Boolean);
    const pathsByOid = new Map<string, Set<string>>();
    for (const line of String(git(repo, ['rev-list', '--objects', '--all'])).split('\n')) {
      const separator = line.indexOf(' ');
      if (separator < 0) continue;
      const oid = line.slice(0, separator);
      const path = line.slice(separator + 1);
      if (!pathsByOid.has(oid)) pathsByOid.set(oid, new Set());
      pathsByOid.get(oid)!.add(path);
    }
    const documents: EvidenceDocument[] = [];
    for (const row of objectRows) {
      const [oid, type, sizeText] = row.split(' ');
      if (type !== 'blob') continue;
      const paths = [...(pathsByOid.get(oid) ?? [])];
      const rawPath = paths.find(path =>
        path === '.local/.chat_capture' ||
        /^\.local\/raw-window-captures\/[^/]+\.raw$/.test(path)
      );
      const derivedPath = paths.find(path => /^docs\/episode-.*\.md$/.test(path));
      if (!rawPath && !derivedPath) continue;
      const size = Number(sizeText);
      if (!Number.isFinite(size)) throw new Error(`archive candidate blob ${oid} has an invalid size`);
      // The exact-turn parser is intentionally bounded. Silently skipping a
      // candidate would make a "complete" absence conclusion false.
      if (size > 64 * 1024 * 1024) {
        throw new Error(
          `archive candidate blob ${oid} (${rawPath ?? derivedPath}, ${size} bytes) exceeds the 64MiB exact-search bound; coverage is incomplete`,
        );
      }
      const content = git(repo, ['cat-file', 'blob', oid], { encoding: 'buffer' }) as Buffer;
      documents.push({
        class: rawPath ? 'archive-raw' : 'derived-replica',
        location: `git:${oid}:${rawPath ?? derivedPath ?? '(unreachable blob)'}`,
        content: content.toString('utf8'),
        sha256: sha256(content),
      });
    }
    return {
      documents,
      archive: {
        bundlePath,
        bundleSha256,
        manifestSha256: sha256(manifest),
        checksumVerified: true,
        gitBundleVerified: true,
        gitFsckVerified: true,
      },
    };
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

export function describeFile(path: string): { sha256: string; bytes: number; name: string } {
  const bytes = readFileSync(path);
  return { sha256: sha256(bytes), bytes: statSync(path).size, name: basename(path) };
}