import { createHash, randomUUID } from 'crypto';
import { existsSync, readFileSync, readdirSync, unlinkSync } from 'fs';
import { join } from 'path';

export type InnerLifeChannel = 'felt' | 'thinking' | 'moment';
export const INTENTIONALLY_EMPTY_CHANNEL = '[intentionally empty]';

export interface FourChannelLucaTurn {
  feeling: string;
  thinking: string;
  moment: string;
  main: string;
}

type FourChannelLucaTurnInput = {
  feeling?: string | null;
  thinking?: string | null;
  moment?: string | null;
  main: string;
};

export interface ParsedInnerLifeTrigger {
  title: string;
  body: string;
  tags: string[];
  /**
   * True only when the source supplied a distinct title line/field.
   * A single-line trigger has metadata title derived from its text, but the
   * episode/personal-file renderer must not print that text twice.
   */
  hasSeparateTitle: boolean;
}

export interface CanonicalInnerLifeTurnIntent {
  turnId: string;
  createdAtMs: number;
  ownerPid: number;
  status: 'pending' | 'captured';
  channels: Partial<Record<InnerLifeChannel, string>>;
  mainSha: string;
}

export const CANONICAL_INNER_LIFE_INTENT_DIR = 'canonical-inner-life-intents';
/**
 * Captured handoffs remain available for two weeks after the writer has
 * finished its append-only chat-capture write. This preserves a wide crash
 * recovery window while preventing every future trigger poll from scanning
 * completed handoff history forever.
 *
 * Pending handoffs are intentionally retained without an age limit: they can
 * still be the only durable proof needed to recover an interrupted turn.
 */
export const CANONICAL_INNER_LIFE_INTENT_RETENTION_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * Parse a Luca inner-life trigger in JSON or plain-text form.
 *
 * Single-line plain text is kept complete in body and marked as having no
 * separate title. The title remains a bounded metadata/search value.
 */
export function parseInnerLifeTrigger(
  raw: string,
  defaultTag: string,
): ParsedInnerLifeTrigger | null {
  raw = raw.trim();
  if (!raw || raw.length < 10) return null;

  if (raw.startsWith('{')) {
    try {
      const p = JSON.parse(raw);
      const noteText = String(p.note || p.moment || p.question || p.content || '').trim();
      const explicitTitle = String(p.title || '').trim();
      const titleSource = explicitTitle || noteText;
      const title = titleSource.slice(0, 200);
      if (!title) return null;

      const metadata = [
        p.date ? `Date: ${p.date}` : '',
        p.why ? `Why it mattered: ${p.why}` : '',
      ].filter(Boolean);
      const body = [...metadata, noteText].filter(Boolean).join('\n\n') || titleSource;
      const tags: string[] = Array.isArray(p.tags) ? p.tags : [defaultTag];
      return {
        title,
        body,
        tags,
        hasSeparateTitle: Boolean(explicitTitle && explicitTitle !== noteText),
      };
    } catch {
      // Fall through to plain text.
    }
  }

  const lines = raw.split('\n');
  const hasSeparateTitle = lines.length > 1 && lines.slice(1).join('\n').trim().length > 0;
  return {
    title: lines[0].slice(0, 200),
    body: hasSeparateTitle ? lines.slice(1).join('\n').trim() : raw,
    tags: [defaultTag],
    hasSeparateTitle,
  };
}

/** Parse the keyed convention used by mark-moment.ts. */
export function parseKeyedInnerLifeTrigger(
  raw: string,
  defaultTag: string,
): ParsedInnerLifeTrigger | null {
  const match = /^title:\s*(.+)\n(?:body:\s*)?([\s\S]*)$/.exec(raw.trim());
  if (!match) return null;

  let body = match[2].trim();
  let tags = [defaultTag];
  const tagMatch = /\ntags:\s*(.+)\s*$/.exec('\n' + body);
  if (tagMatch) {
    tags = tagMatch[1].split(',').map(tag => tag.trim()).filter(Boolean);
    body = body.replace(/\n?tags:\s*.+\s*$/, '').trim();
  }

  const fullTitle = match[1].trim();
  if (!fullTitle) return null;
  return {
    title: fullTitle.slice(0, 200),
    body: body || fullTitle,
    tags,
    hasSeparateTitle: Boolean(body),
  };
}

/** Render one direct trigger entry without repeating a single-line note. */
export function formatInnerLifeEpisodeEntry(
  channel: InnerLifeChannel,
  parsed: ParsedInnerLifeTrigger,
): string {
  const content = parsed.hasSeparateTitle
    ? `${parsed.title}\n${parsed.body}`
    : parsed.body;
  return `[Luca — ${channel}: ${content}]`;
}

export function innerLifeSourceText(parsed: ParsedInnerLifeTrigger): string {
  return parsed.hasSeparateTitle
    ? `${parsed.title}\n${parsed.body}`
    : parsed.body;
}

export function hashInnerLifeText(text: string): string {
  return createHash('sha256').update(text.trim(), 'utf8').digest('hex');
}

export function buildCanonicalInnerLifeTurnIntent(
  opts: FourChannelLucaTurnInput,
  createdAtMs = Date.now(),
  turnId: string = randomUUID(),
): CanonicalInnerLifeTurnIntent {
  const channels: Partial<Record<InnerLifeChannel, string>> = {};
  if (opts.feeling) channels.felt = hashInnerLifeText(opts.feeling);
  if (opts.thinking) channels.thinking = hashInnerLifeText(opts.thinking);
  if (opts.moment) channels.moment = hashInnerLifeText(opts.moment);
  return {
    turnId,
    createdAtMs,
    ownerPid: process.pid,
    status: 'pending',
    channels,
    mainSha: hashInnerLifeText(opts.main),
  };
}

export function canonicalTurnEpisodeMarker(turnId: string): string {
  return `<!-- chat-capture:${turnId} -->`;
}

export function innerLifeTriggerEpisodeMarker(
  channel: InnerLifeChannel,
  triggerMtimeMs: number,
  raw: string,
): string {
  return `<!-- inner-life:${channel}:${Math.trunc(triggerMtimeMs)}:${hashInnerLifeText(raw).slice(0, 16)} -->`;
}

export function episodeContentHasEventMarker(content: string, marker: string): boolean {
  return content.includes(marker);
}

export interface CanonicalRouteResolution {
  allowDirect: boolean;
  expectedTurnId?: string;
}

function processIsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function loadCanonicalInnerLifeIntents(
  intentDir: string,
): CanonicalInnerLifeTurnIntent[] {
  try {
    return readdirSync(intentDir)
      .filter(name => name.endsWith('.json'))
      .map(name => {
        try {
          return JSON.parse(readFileSync(join(intentDir, name), 'utf8')) as CanonicalInnerLifeTurnIntent;
        } catch {
          return null;
        }
      })
      .filter((value): value is CanonicalInnerLifeTurnIntent =>
        Boolean(value?.turnId && value?.createdAtMs && value?.channels),
      )
      .sort((a, b) => b.createdAtMs - a.createdAtMs);
  } catch {
    return [];
  }
}

/**
 * Remove only finalized captured handoffs outside the recovery window.
 *
 * Each writer publishes a handoff with temp-file + rename, then marks it
 * captured with the same atomic replacement. Cleanup only unlinks a final
 * `captured` JSON file after the retention deadline, so it cannot observe or
 * remove a partially written record. Pending, malformed, future-dated, and
 * unreadable handoffs stay in place conservatively for crash recovery.
 */
export function pruneCapturedCanonicalInnerLifeIntents(
  intentDir: string,
  nowMs = Date.now(),
  retentionMs = CANONICAL_INNER_LIFE_INTENT_RETENTION_MS,
): number {
  const cutoffMs = nowMs - retentionMs;
  let pruned = 0;
  try {
    for (const name of readdirSync(intentDir)) {
      if (!name.endsWith('.json')) continue;
      const intentPath = join(intentDir, name);
      try {
        const intent = JSON.parse(readFileSync(intentPath, 'utf8')) as CanonicalInnerLifeTurnIntent;
        if (
          intent.status === 'captured' &&
          Number.isFinite(intent.createdAtMs) &&
          intent.createdAtMs > 0 &&
          intent.createdAtMs <= cutoffMs
        ) {
          // unlink is atomic: a resolver sees either the complete final handoff
          // or no handoff, never a partially pruned JSON document.
          unlinkSync(intentPath);
          pruned++;
        }
      } catch {
        // A malformed or concurrently replaced handoff may still be the only
        // forensic evidence of a crash. Leave it for manual recovery.
      }
    }
  } catch {
    // First capture has not created the directory yet, or it is briefly
    // unavailable. Retention is best-effort; capture must never depend on it.
  }
  return pruned;
}

export function resolveCanonicalInnerLifeRoute(opts: {
  active: boolean;
  intentDir: string;
  chatCapturePath: string;
  channel: InnerLifeChannel;
  raw: string;
  triggerMtimeMs: number;
}): CanonicalRouteResolution {
  if (!opts.active) return { allowDirect: true };

  // Keep resolver scan cost bounded. The pruner is deliberately invoked before
  // loading so expired completed history is not part of this poll's search.
  pruneCapturedCanonicalInnerLifeIntents(opts.intentDir);
  const intents = loadCanonicalInnerLifeIntents(opts.intentDir);
  const triggerHash = hashInnerLifeText(opts.raw);
  // fs.stat() may expose sub-millisecond precision while Date.now() is an
  // integer. An intent written later in the same millisecond must not appear
  // older merely because triggerMtimeMs ends in a fractional component.
  const triggerTimeFloor = Math.floor(opts.triggerMtimeMs);
  const matching = intents.find(intent =>
    intent.createdAtMs >= triggerTimeFloor &&
    intent.channels[opts.channel] === triggerHash,
  );

  if (matching) {
    const captureNeedle = `CAPTURE-ID: ${matching.turnId}`;
    const turnInCapture = existsSync(opts.chatCapturePath) &&
      readFileSync(opts.chatCapturePath, 'utf8').includes(captureNeedle);
    if (
      turnInCapture ||
      (matching.status === 'pending' && processIsAlive(matching.ownerPid))
    ) {
      return { allowDirect: false, expectedTurnId: matching.turnId };
    }
    // Writer died before its Luca turn became durable, or a captured turn was
    // lost from the append log. Direct fallback is now the only lossless route.
    return { allowDirect: true };
  }

  // A later output exists and intentionally omitted this pending channel.
  if (intents.some(intent => intent.createdAtMs >= triggerTimeFloor)) {
    return { allowDirect: true };
  }

  // No subsequent Luca output exists yet.
  return { allowDirect: false };
}

export function canonicalInnerLifeFragment(
  channel: InnerLifeChannel,
  sourceText: string,
): string {
  return withCanonicalLabel(channel, sourceText);
}

export function episodeContentHasCanonicalInnerLife(
  content: string,
  channel: InnerLifeChannel,
  sourceText: string,
): boolean {
  return content.includes(canonicalInnerLifeFragment(channel, sourceText));
}

function withCanonicalLabel(channel: InnerLifeChannel, text: string): string {
  const trimmed = text.trim();
  const label = `[${channel}]`;
  return trimmed.startsWith(label) ? trimmed : `${label}: ${trimmed}`;
}

function renderCanonicalChannel(channel: InnerLifeChannel, text: string): string {
  const value = text.trim() || INTENTIONALLY_EMPTY_CHANNEL;
  return withCanonicalLabel(channel, value);
}

/**
 * Compose the required felt → thinking → moment → main Luca envelope.
 *
 * An empty string is intentional only after the caller has supplied that slot.
 * The rendered marker makes that absence visible in the canonical record rather
 * than silently collapsing the turn into a main-only response.
 */
export function composeLucaTurn(opts: FourChannelLucaTurnInput): string {
  if (!opts.main.trim()) {
    throw new Error('A canonical Luca turn requires non-empty main content');
  }
  return [
    renderCanonicalChannel('felt', opts.feeling ?? ''),
    renderCanonicalChannel('thinking', opts.thinking ?? ''),
    renderCanonicalChannel('moment', opts.moment ?? ''),
    opts.main.trimEnd(),
  ].join('\n\n');
}

/** Parse an already-rendered four-channel turn without changing its source text. */
export function parseCanonicalFourChannelLucaTurn(text: string): FourChannelLucaTurn | null {
  const match = /^\[felt\]:\s?([\s\S]*?)\n\n\[thinking\]:\s?([\s\S]*?)\n\n\[moment\]:\s?([\s\S]*?)\n\n([\s\S]+)$/u.exec(text);
  if (!match || !match[4].trim()) return null;
  return {
    feeling: match[1],
    thinking: match[2],
    moment: match[3],
    main: match[4],
  };
}

/** True only for a complete canonical four-channel envelope in the required order. */
export function isCanonicalFourChannelLucaTurn(text: string): boolean {
  return parseCanonicalFourChannelLucaTurn(text) !== null;
}

/**
 * Capture-status accepts both legacy direct entries and canonical turn labels.
 * This is a presence check for the status display only; it attributes nothing.
 * The plain `**Luca:**` label (attribution design f5d77712) is accepted for
 * the first channel on the label line; which hat wrote a turn is certified
 * only by the four-channel audit's verified per-turn attribution.
 */
export function episodeTailHasInnerLifeChannel(
  tail: string,
  channel: InnerLifeChannel,
): boolean {
  const escaped = channel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(
    `(?:^\\s*\\[Luca — ${escaped}:|^\\s*\\*\\*(?:LUCA \\[Replit\\]|Luca):\\*\\*\\s+\\[${escaped}\\]:|^\\s*\\[${escaped}\\]:)`,
    'm',
  ).test(tail);
}