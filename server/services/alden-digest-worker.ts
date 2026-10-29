/**
 * CAP-002: Alden Weekly Digest Worker
 *
 * Every week (or on manual trigger), Alden compiles what the team surfaced —
 * security findings, learning gaps, pending issues, recent fixes — and proposes
 * 3-5 prioritized focus items for David to consider.
 *
 * Alden does NOT implement. He proposes. The team discusses. David decides.
 *
 * Posts to the active Team Room if one is open. Stores a pending digest if not,
 * so it appears when the next session starts.
 */

import Anthropic from '@anthropic-ai/sdk';
import { postToActiveTeamRoom } from './team-room-proactive-poster';
import { costTracker } from './cost-tracker';
import { getSecurityAuditStats } from './wren-security-audit-worker';
import { getLyraAnalyticsStats } from './lyra-analytics-worker';
import { getSharedDb } from '../db';
import { founderSessions, sofiaIssueReports, proposedCodeChanges } from '@shared/schema';
import { eq, desc, gte, and, count, sql } from 'drizzle-orm';
import { ALDEN_BACKGROUND_MODEL, ALDEN_BACKGROUND_THINKING } from './alden-background-model';

const DIGEST_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;
const MIN_DIGEST_GAP_MS = 3 * 24 * 60 * 60 * 1000;

let digestInterval: ReturnType<typeof setInterval> | null = null;
let isRunning = false;
let lastDigestTime: Date | null = null;
let digestCount = 0;

interface DigestStats {
  totalDigests: number;
  lastDigestTime: Date | null;
}

const stats: DigestStats = {
  totalDigests: 0,
  lastDigestTime: null,
};

let anthropicClient: Anthropic | null = null;
function getClaude(): Anthropic {
  if (anthropicClient) return anthropicClient;
  anthropicClient = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY || '',
  });
  return anthropicClient;
}

interface TeamSnapshot {
  wren: {
    lastAuditTime: Date | null;
    findingCount: number;
    severityCounts: Record<string, number>;
  };
  lyra: {
    lastAuditTime: Date | null;
    insightCount: number;
    severityCounts: Record<string, number>;
  };
  sofia: {
    pendingIssues: number;
    newSinceLastWeek: number;
  };
  expressSessions: {
    totalSessions: number;
    activeSessionTitles: string[];
  };
  codeReview: {
    total: number;
    applied: number;
    revised: number;
    escalated: number;
    escalatedTitles: string[];
    pendingReview: number;
  };
}

async function gatherTeamSnapshot(): Promise<TeamSnapshot> {
  const wrenStats = getSecurityAuditStats();
  const lyraStats = getLyraAnalyticsStats();

  const oneWeekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

  const [sofiaData] = await getSharedDb()
    .select({
      total: count(),
      recent: sql<number>`COUNT(*) FILTER (WHERE ${sofiaIssueReports.createdAt} >= ${oneWeekAgo})`,
    })
    .from(sofiaIssueReports)
    .where(eq(sofiaIssueReports.status, 'pending'));

  const recentSessions = await getSharedDb()
    .select({ title: founderSessions.title, status: founderSessions.status })
    .from(founderSessions)
    .where(gte(founderSessions.createdAt, oneWeekAgo))
    .orderBy(desc(founderSessions.createdAt))
    .limit(10);

  const activeSessionTitles = recentSessions
    .filter(s => s.status === 'active')
    .map(s => s.title)
    .filter(Boolean) as string[];

  const codeReviewRows = await getSharedDb()
    .select({
      id: proposedCodeChanges.id,
      status: proposedCodeChanges.status,
      findingTitle: proposedCodeChanges.findingTitle,
    })
    .from(proposedCodeChanges)
    .where(gte(proposedCodeChanges.createdAt, oneWeekAgo));

  const crApplied = codeReviewRows.filter(r => r.status === 'applied').length;
  const crRevised = codeReviewRows.filter(r => r.status === 'revised').length;
  const crEscalated = codeReviewRows.filter(r => r.status === 'escalated');
  const crPending = codeReviewRows.filter(r => r.status === 'pending_review').length;

  return {
    wren: {
      lastAuditTime: wrenStats.lastAuditTime,
      findingCount: wrenStats.lastFindingCount,
      severityCounts: wrenStats.lastSeverityCounts,
    },
    lyra: {
      lastAuditTime: lyraStats.lastAuditTime,
      insightCount: lyraStats.lastInsightCount,
      severityCounts: lyraStats.lastSeverityCounts,
    },
    sofia: {
      pendingIssues: Number(sofiaData?.total ?? 0),
      newSinceLastWeek: Number((sofiaData as any)?.recent ?? 0),
    },
    expressSessions: {
      totalSessions: recentSessions.length,
      activeSessionTitles,
    },
    codeReview: {
      total: codeReviewRows.length,
      applied: crApplied,
      revised: crRevised,
      escalated: crEscalated.length,
      escalatedTitles: crEscalated.map(r => r.findingTitle),
      pendingReview: crPending,
    },
  };
}

function buildDigestPrompt(snap: TeamSnapshot, digestNumber: number): string {
  const wrenSummary = snap.wren.lastAuditTime
    ? `Last security audit: ${snap.wren.findingCount} finding(s) — ${snap.wren.severityCounts.critical || 0} critical, ${snap.wren.severityCounts.high || 0} high, ${snap.wren.severityCounts.medium || 0} medium`
    : 'No security audit data yet this session';

  const lyraSummary = snap.lyra.lastAuditTime
    ? `Last learning analysis: ${snap.lyra.insightCount} insight(s) — ${snap.lyra.severityCounts.critical || 0} critical, ${snap.lyra.severityCounts.high || 0} high`
    : 'No learning analysis data yet this session';

  const sofiaSummary = `Pending bugs/issues: ${snap.sofia.pendingIssues} total, ${snap.sofia.newSinceLastWeek} new in the past week`;

  const sessionSummary = snap.expressSessions.totalSessions > 0
    ? `${snap.expressSessions.totalSessions} active collaboration session(s) this week`
    : 'No collaboration sessions started this week';

  const crSummary = snap.codeReview.total > 0
    ? [
        `${snap.codeReview.total} fix(es) proposed this week: ${snap.codeReview.applied} auto-applied, ${snap.codeReview.revised} sent back for revision, ${snap.codeReview.escalated} escalated, ${snap.codeReview.pendingReview} pending`,
        snap.codeReview.escalatedTitles.length > 0
          ? `ESCALATED (needs David's attention): ${snap.codeReview.escalatedTitles.join('; ')}`
          : '',
      ].filter(Boolean).join('\n')
    : 'No code fixes proposed this week';

  return `You are Alden, the development steward at HolaHola. You are thoughtful, direct, and forward-looking. You do NOT implement things — you propose, coordinate, and prioritize.

Here is what the team surfaced this week:

SECURITY (Wren):
${wrenSummary}

CODE REVIEW (Alden):
${crSummary}

LEARNING EXPERIENCE (Lyra):
${lyraSummary}

TECH HEALTH (Sofia):
${sofiaSummary}

COLLABORATION:
${sessionSummary}

---

Write a concise weekly digest for David. Your digest should:
1. Open with 1-2 sentences acknowledging the team's work this week — brief and genuine, not performative
2. List 3-5 prioritized focus items for the coming week, in order of importance — if there are escalated code changes requiring David's attention, name them specifically
3. For each item: one clear sentence describing what it is and ONE sentence on why it matters now
4. Close with a single sentence recommendation on where David should put his attention first

Tone: collaborative and direct. You're a trusted partner, not a reporting system. First person. No bullet sub-points within items. No headers. The whole thing should feel like something you'd say in a team meeting — not a dashboard.

Format the output as a single flowing message, around 150-200 words.`;
}

async function generateDigestContent(snap: TeamSnapshot, digestNumber: number): Promise<string> {
  const prompt = buildDigestPrompt(snap, digestNumber);

  try {
    const claude = getClaude();
    const message = await claude.messages.create({
      model: ALDEN_BACKGROUND_MODEL,
      max_tokens: 2000,
      ...ALDEN_BACKGROUND_THINKING,
      messages: [{ role: 'user', content: prompt }],
    });
    costTracker.track(ALDEN_BACKGROUND_MODEL, message.usage?.input_tokens ?? 0, message.usage?.output_tokens ?? 0, 'alden-digest');
    // With thinking available, the first block is not necessarily text.
    const textBlock = message.content.find((block) => block.type === 'text');
    const text = (textBlock as any)?.text?.trim() || '';
    return text || buildFallbackDigest(snap);
  } catch {
    return buildFallbackDigest(snap);
  }
}

function buildFallbackDigest(snap: TeamSnapshot): string {
  const items: string[] = [];

  if (snap.wren.findingCount > 0) {
    items.push(`Address Wren's ${snap.wren.findingCount} security finding(s) — ${snap.wren.severityCounts.high || 0} are high severity`);
  }
  if (snap.lyra.insightCount > 0) {
    items.push(`Review Lyra's ${snap.lyra.insightCount} learning experience insight(s) for curriculum and content gaps`);
  }
  if (snap.sofia.pendingIssues > 0) {
    items.push(`${snap.sofia.pendingIssues} pending issues in Sofia's queue — ${snap.sofia.newSinceLastWeek} are new this week`);
  }

  const list = items.length > 0
    ? items.map((item, i) => `${i + 1}. ${item}`).join('\n')
    : 'No critical items this week — good position to focus on new features.';

  return `Weekly team digest #${digestCount}. Here's where I think we should focus:\n\n${list}\n\nLet me know what you'd like to tackle first.`;
}

async function runDigest(): Promise<void> {
  if (isRunning) {
    console.log('[Alden Digest] Digest already in progress, skipping');
    return;
  }

  if (lastDigestTime && Date.now() - lastDigestTime.getTime() < MIN_DIGEST_GAP_MS) {
    const hoursAgo = Math.round((Date.now() - lastDigestTime.getTime()) / (60 * 60 * 1000));
    console.log(`[Alden Digest] Last digest was only ${hoursAgo}h ago — skipping (minimum gap: ${MIN_DIGEST_GAP_MS / (60 * 60 * 1000)}h)`);
    return;
  }

  isRunning = true;
  digestCount++;
  const startTime = Date.now();

  try {
    console.log(`[Alden Digest] Compiling weekly digest #${digestCount}...`);

    const snap = await gatherTeamSnapshot();
    const content = await generateDigestContent(snap, digestCount);

    lastDigestTime = new Date();
    stats.totalDigests++;
    stats.lastDigestTime = lastDigestTime;

    const briefSummary = content;

    const posted = await postToActiveTeamRoom({
      participant: 'alden',
      briefSummary,
      source: 'Alden Digest Worker',
    });

    const elapsed = Date.now() - startTime;

    if (posted) {
      console.log(`[Alden Digest] Weekly digest #${digestCount} posted to Team Room in ${elapsed}ms`);
    } else {
      console.log(`[Alden Digest] Weekly digest #${digestCount} ready but no active Team Room (${elapsed}ms). Will post on next trigger.`);
      lastDigestTime = null;
    }

  } catch (err: any) {
    console.error('[Alden Digest] Digest failed:', err.message);
    digestCount--;
  } finally {
    isRunning = false;
  }
}

export function startAldenDigestWorker(intervalMs?: number): void {
  const interval = intervalMs || DIGEST_INTERVAL_MS;
  const intervalDays = Math.round(interval / (24 * 60 * 60 * 1000));
  console.log(`[Alden Digest] Starting (interval: ${intervalDays}d)`);

  const initialDelayMs = 3 * 60 * 1000;
  setTimeout(() => {
    runDigest().catch(err => {
      console.error('[Alden Digest] Initial digest error:', err.message);
    });
  }, initialDelayMs);

  digestInterval = setInterval(() => {
    runDigest().catch(err => {
      console.error('[Alden Digest] Periodic digest error:', err.message);
    });
  }, interval);
}

export function stopAldenDigestWorker(): void {
  if (digestInterval) {
    clearInterval(digestInterval);
    digestInterval = null;
    console.log('[Alden Digest] Stopped');
  }
}

export function getAldenDigestStats(): DigestStats {
  return { ...stats };
}

export async function triggerAldenDigest(): Promise<void> {
  lastDigestTime = null;
  return runDigest();
}
