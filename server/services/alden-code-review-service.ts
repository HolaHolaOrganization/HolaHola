/**
 * CAP-007: Alden Code Review Service
 *
 * Alden acts as the architectural reviewer for the HolaHola AI team.
 * Wren proposes fixes; Alden reviews them using Claude Opus + architectural
 * memory, then approves (applies + syncs to GitHub), requests revision,
 * or escalates to David.
 */

import * as fs from 'fs';
import Anthropic from '@anthropic-ai/sdk';
import { getSharedDb, getUserDb } from '../db';
import { costTracker } from './cost-tracker';
import { ALDEN_BACKGROUND_MODEL, ALDEN_BACKGROUND_THINKING } from './alden-background-model';
import { proposedCodeChanges, editorInsights, founderSessions, aldenNotifications } from '@shared/schema';
import { eq, and, desc, gte } from 'drizzle-orm';
import { founderCollabService } from './founder-collaboration-service';
import { postToActiveTeamRoom } from './team-room-proactive-poster';
import { SourceControlService } from './source-control-service';
import { aldenWriteBoundary } from './alden-write-boundary';
import { applyPinnedApproval, planApproval } from './alden-review-approval';
import { insertPinnedProposal, notifyStoredProposal } from './alden-propose-fix-service';
import { workspaceResolution } from './workspace-root';

const FOUNDER_ID = '49847136';
const ALDEN_SESSION_TITLE = 'Alden Platform Management';

let anthropicClient: Anthropic | null = null;
function getClient(): Anthropic {
  if (anthropicClient) return anthropicClient;
  anthropicClient = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY,
  });
  return anthropicClient;
}

type ReviewDecision = 'approve' | 'revise' | 'escalate';

export interface ReviewResult {
  decision: ReviewDecision;
  reason: string;
  revisionGuidance?: string;
  escalationSummary?: string;
}

async function loadAldenMemory(): Promise<string> {
  const db = getSharedDb();
  const insights = await db
    .select({
      category: editorInsights.category,
      title: editorInsights.title,
      content: editorInsights.content,
      importance: editorInsights.importance,
    })
    .from(editorInsights)
    .orderBy(desc(editorInsights.importance))
    .limit(12);

  if (insights.length === 0) return '';
  return insights
    .map(i => `[${i.category} · importance ${i.importance}] ${i.title}: ${i.content.substring(0, 200)}`)
    .join('\n');
}

function readContext(filePath: string, lineStart: number, lineEnd: number, pad = 12): string {
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const lines = raw.split('\n');
    const ctxStart = Math.max(0, lineStart - pad - 1);
    const ctxEnd = Math.min(lines.length, lineEnd + pad);
    return lines
      .slice(ctxStart, ctxEnd)
      .map((l, i) => `${ctxStart + i + 1}: ${l}`)
      .join('\n');
  } catch {
    return '(file not readable)';
  }
}

async function reviewWithClaude(
  change: { findingTitle: string; findingDescription: string; findingSeverity: string; findingSource: string; filePath: string; lineStart: number; lineEnd: number; beforeCode: string; afterCode: string; patchRationale: string },
  memory: string
): Promise<ReviewResult> {
  const client = getClient();
  const context = readContext(change.filePath, change.lineStart, change.lineEnd);

  const prompt = `You are Alden, HolaHola's platform architect and code reviewer. The AI team operates autonomously, and your role is to review proposed code changes before they are applied to the codebase and pushed to GitHub.

YOUR AUTHORITY BOUNDARY:
- APPROVE: bug fixes, security patches, ≤15 lines changed, no new dependencies, no schema changes, no auth/payment/data model changes, fix matches the stated problem
- REVISE: correct intent but wrong approach, conflicts with established patterns, could be improved before applying — explain specifically what should change  
- ESCALATE: architectural changes, new services/files, dependency additions, schema changes, auth/payment logic, anything you are uncertain about — these go to David

YOUR ARCHITECTURAL MEMORY:
${memory || '(no memory loaded)'}

PROPOSED CHANGE:
Finding: ${change.findingTitle} [${change.findingSeverity.toUpperCase()}]
Source: ${change.findingSource}
Description: ${change.findingDescription}
File: ${change.filePath} (lines ${change.lineStart}-${change.lineEnd})
Wren's rationale: ${change.patchRationale}

BEFORE (lines ${change.lineStart}-${change.lineEnd}):
\`\`\`
${change.beforeCode}
\`\`\`

AFTER (proposed replacement):
\`\`\`
${change.afterCode}
\`\`\`

SURROUNDING CONTEXT:
\`\`\`
${context}
\`\`\`

Review this proposed change. Check:
1. Does the fix actually address the stated problem?
2. Does it fit the patterns in this codebase (check memory)?
3. Is it within your authority to approve?
4. Are there any unintended side effects?

Be direct and specific. If revising, explain exactly what should be different. If escalating, explain what makes it beyond autonomous approval.`;

  const response = await client.messages.create({
    model: ALDEN_BACKGROUND_MODEL,
    max_tokens: 1024,
    ...ALDEN_BACKGROUND_THINKING,
    system: `You are Alden, HolaHola's platform architect. You review code changes from the AI team with architectural judgment. Respond ONLY with a JSON object: { "decision": "approve"|"revise"|"escalate", "reason": "...", "revisionGuidance": "..." (if revise), "escalationSummary": "..." (if escalate) }`,
    messages: [{ role: 'user', content: prompt }],
  });
  costTracker.track(ALDEN_BACKGROUND_MODEL, response.usage?.input_tokens ?? 0, response.usage?.output_tokens ?? 0, 'alden-code-review');

  // With thinking available, the first block is not necessarily text.
  const textBlock = response.content.find((block) => block.type === 'text');
  const raw = (textBlock as any)?.text || '';
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error(`Claude returned unparseable response: ${raw.substring(0, 200)}`);

  const parsed = JSON.parse(jsonMatch[0]);
  return {
    decision: parsed.decision || 'escalate',
    reason: parsed.reason || 'No reason provided',
    revisionGuidance: parsed.revisionGuidance,
    escalationSummary: parsed.escalationSummary,
  };
}

async function requestSourceControlSync(actor: string): Promise<{ success: boolean; output: string }> {
  try {
    const outcome = await new SourceControlService().sync(actor);
    return {
      success: outcome.ok,
      output: outcome.ok ? `Source-control state: ${outcome.state}` : outcome.error || outcome.state,
    };
  } catch (err: any) {
    console.error(`[AldenReview] Source-control request failed:`, err.message);
    return { success: false, output: err.message || '' };
  }
}

async function getOrCreateAldenSession(): Promise<string> {
  const db = getSharedDb();
  const [existing] = await db
    .select()
    .from(founderSessions)
    .where(and(
      eq(founderSessions.title, ALDEN_SESSION_TITLE),
      eq(founderSessions.status, 'active')
    ))
    .orderBy(desc(founderSessions.createdAt))
    .limit(1);

  if (existing) return existing.id;
  const session = await founderCollabService.createSession(FOUNDER_ID, ALDEN_SESSION_TITLE);
  return session.id;
}

async function postReviewDecision(
  change: { id: string; findingTitle: string; filePath: string; lineStart: number; lineEnd: number; beforeCode: string; afterCode: string },
  result: ReviewResult,
  applied: boolean,
  githubSynced: boolean,
  notAppliedReason?: string,
): Promise<void> {
  const sessionId = await getOrCreateAldenSession();

  const icon = result.decision === 'approve' ? '✓' : result.decision === 'revise' ? '↩' : '⚠';
  const label = result.decision === 'approve'
    ? applied ? 'APPROVED + APPLIED' : notAppliedReason ? 'APPROVED (not applied)' : 'APPROVED (apply failed)'
    : result.decision === 'revise' ? 'REVISION REQUESTED'
    : 'ESCALATED TO DAVID';

  const lines = [
    `**Alden Code Review — ${label}**`,
    ``,
    `${icon} **${change.findingTitle}**`,
    `File: \`${change.filePath}:${change.lineStart}-${change.lineEnd}\``,
    ``,
    `**Alden's assessment:** ${result.reason}`,
  ];

  if (result.decision === 'revise' && result.revisionGuidance) {
    lines.push(``, `**Revision needed:** ${result.revisionGuidance}`);
  }

  if (result.decision === 'approve' && notAppliedReason) {
    lines.push(``, `**Not applied:** ${notAppliedReason}`);
  }

  if (result.decision === 'approve' && applied) {
    lines.push(``, `**Change applied:**`);
    lines.push(`\`\`\`\nBefore:\n${change.beforeCode}\nAfter:\n${change.afterCode}\n\`\`\``);
    if (githubSynced) lines.push(`**Synced to GitHub** ✓`);
  }

  if (result.decision === 'escalate') {
    lines.push(``, `**Why escalated:** ${result.escalationSummary || result.reason}`);
    lines.push(`*David, this change needs your architectural judgment.*`);
  }

  lines.push(``, `*Alden Code Review — ${new Date().toISOString()}*`);

  await founderCollabService.addMessage(sessionId, {
    role: 'system',
    content: lines.join('\n'),
    metadata: {
      type: 'alden_code_review',
      changeId: change.id,
      decision: result.decision,
      applied,
      githubSynced,
    },
  });

  if (result.decision === 'escalate') {
    await postToActiveTeamRoom({
      participant: 'alden',
      briefSummary: `I've escalated a proposed change to you: "${change.findingTitle}" — ${result.escalationSummary || result.reason}`,
      source: 'Alden Code Review',
    });
  }
}

export interface CodeReviewSummary {
  total: number;
  approved: number;
  applied: number;
  githubSynced: number;
  revised: number;
  escalated: number;
  failed: number;
}

/**
 * External I/O the queue depends on, injectable so tests can drive the real
 * entry point. Source writes and git sync are deliberately not injectable.
 */
export interface ReviewQueueDeps {
  db: ReturnType<typeof getSharedDb>;
  loadMemory: () => Promise<string>;
  review: (change: typeof proposedCodeChanges.$inferSelect, memory: string) => Promise<ReviewResult>;
  postDecision: typeof postReviewDecision;
  /** The workspace the change is resolved and pinned against. */
  root: string;
  env: NodeJS.ProcessEnv;
  /** Stores a production approval as a pending pinned proposal (propose_fix's route). */
  storeProposal: (input: Parameters<typeof insertPinnedProposal>[1]) => Promise<{ id: string }>;
  /** Records the permitted diagnostic notice for a blocked approval. */
  notifyBlocked: (change: { id: string; findingTitle: string }, reason: string) => Promise<void>;
}

async function storeReviewedProposal(input: Parameters<typeof insertPinnedProposal>[1]): Promise<{ id: string }> {
  const row = await insertPinnedProposal(getUserDb(), input);
  await notifyStoredProposal(row);
  return row;
}

async function noticeBlockedApproval(change: { id: string; findingTitle: string }, reason: string): Promise<void> {
  const db = getUserDb();
  const fingerprint = `review_blocked:${change.id}`.slice(0, 100);
  const [existing] = await db.select({ id: aldenNotifications.id }).from(aldenNotifications).where(eq(aldenNotifications.fingerprint, fingerprint)).limit(1);
  if (existing) return;
  await db.insert(aldenNotifications).values({
    content: `A code review approval is blocked and was not applied: "${change.findingTitle}" (${change.id}). Reason: ${reason}`,
    triggeredBy: 'system',
    severity: 'warning',
    read: false,
    fingerprint,
  });
}

export async function runReviewQueue(deps: Partial<ReviewQueueDeps> = {}): Promise<CodeReviewSummary> {
  const db = deps.db ?? getSharedDb();
  const loadMemory = deps.loadMemory ?? loadAldenMemory;
  const review = deps.review ?? reviewWithClaude;
  const postDecision = deps.postDecision ?? postReviewDecision;
  const root = deps.root ?? workspaceResolution.root;
  const env = deps.env ?? process.env;
  const storeProposal = deps.storeProposal ?? storeReviewedProposal;
  const notifyBlocked = deps.notifyBlocked ?? noticeBlockedApproval;
  const summary: CodeReviewSummary = { total: 0, approved: 0, applied: 0, githubSynced: 0, revised: 0, escalated: 0, failed: 0 };

  const pending = await db
    .select()
    .from(proposedCodeChanges)
    .where(eq(proposedCodeChanges.status, 'pending_review'))
    .orderBy(proposedCodeChanges.createdAt);

  if (pending.length === 0) {
    console.log(`[AldenReview] No pending changes to review`);
    return summary;
  }

  console.log(`[AldenReview] Reviewing ${pending.length} proposed change(s)...`);
  summary.total = pending.length;

  const memory = await loadMemory();

  for (const change of pending) {
    console.log(`[AldenReview] Reviewing: "${change.findingTitle}"`);
    let result: ReviewResult;

    try {
      result = await review(change, memory);
    } catch (err: any) {
      console.error(`[AldenReview] Claude review failed for "${change.findingTitle}":`, err.message);
      await db.update(proposedCodeChanges)
        .set({ status: 'escalated', reviewerNotes: `Review failed: ${err.message}`, reviewedAt: new Date() })
        .where(eq(proposedCodeChanges.id, change.id));
      summary.failed++;
      continue;
    }

    console.log(`[AldenReview] Decision for "${change.findingTitle}": ${result.decision}`);

    if (result.decision === 'approve') {
      summary.approved++;
      let applied = false;
      let githubSynced = false;

      // review_blocked: no apply, no sync, no pin; a diagnostic notice keeps it visible.
      const blockApproval = async (reason: string): Promise<void> => {
        const note = `Not applied: ${reason}.`;
        await db.update(proposedCodeChanges).set({
          status: 'review_blocked',
          reviewerNotes: note,
          aldenDecisionReason: result.reason,
          reviewedAt: new Date(),
          appliedAt: null,
          githubSynced: false,
        }).where(eq(proposedCodeChanges.id, change.id));
        try {
          await notifyBlocked(change, reason);
        } catch (err: any) {
          console.warn(`[AldenReview] Blocked-approval notice failed for ${change.id}:`, err?.message ?? err);
        }
        await postDecision(change, result, false, false, note);
      };

      // Design e4f8e988 P0b: decide before any write. Only dev, with a clean
      // dev-head pin, applies; production stores a release-pinned proposal;
      // anything else is review_blocked. The write boundary is checked again.
      const plan = planApproval(change, root, env);
      if (plan.kind === 'store') {
        let stored: { id: string };
        try {
          stored = await storeProposal({
            title: `Reviewed fix: ${change.findingTitle}`.slice(0, 300),
            description: `Approved by Alden's code review (proposed_code_changes ${change.id}).\n\nFinding: ${change.findingDescription}\n\nPatch rationale: ${change.patchRationale}\n\nAlden's review: ${result.reason}`,
            change: plan.change,
            patternId: null,
            recheckSource: plan.recheckSource,
          });
        } catch (err: any) {
          // The pinned store failed (for example a stale recheck): block it visibly.
          await blockApproval(`the proposal could not be stored: ${err?.message ?? err}`);
          continue;
        }
        // The proposal is durable from here on. A later failure must never mark
        // this item review_blocked, which would hide a stored proposal behind a
        // false "not stored" (LR's #156 review note): link it, then post.
        const note = `Not applied: stored as pending proposal ${stored.id}, pinned to release ${plan.change.pin.commit}. It needs review before anything is built.`;
        try {
          await db.update(proposedCodeChanges).set({
            status: 'approved_pending_review',
            buildQueueId: stored.id,
            reviewerNotes: note,
            aldenDecisionReason: result.reason,
            reviewedAt: new Date(),
            appliedAt: null,
            githubSynced: false,
          }).where(eq(proposedCodeChanges.id, change.id));
        } catch (err: any) {
          // The item stays pending_review; the stored proposal names it, so the link can be repaired.
          console.error(`[AldenReview] Proposal ${stored.id} is stored, but linking review item ${change.id} failed:`, err?.message ?? err);
          continue;
        }
        try {
          await postDecision(change, result, false, false, note);
        } catch (err: any) {
          console.warn(`[AldenReview] Decision post failed for ${change.id} (proposal ${stored.id} is stored and linked):`, err?.message ?? err);
        }
        continue;
      }
      if (plan.kind === 'blocked' || !aldenWriteBoundary(env).allowed) {
        await blockApproval(plan.kind === 'blocked' ? plan.reason : 'the write boundary refused applying it outside a dev instance');
        continue;
      }

      applied = applyPinnedApproval(plan);

      if (applied) {
        summary.applied++;
        const syncResult = await requestSourceControlSync('alden-code-review');
        if (syncResult.success) {
          summary.githubSynced++;
          githubSynced = true;
        }
      }

      await db.update(proposedCodeChanges).set({
        status: applied ? 'applied' : 'approved',
        aldenDecisionReason: result.reason,
        reviewerNotes: `Pinned to dev-head ${plan.pinCommit} before applying.`,
        reviewedAt: new Date(),
        appliedAt: applied ? new Date() : null,
        githubSynced,
      }).where(eq(proposedCodeChanges.id, change.id));

      await postDecision(change, result, applied, githubSynced);

    } else if (result.decision === 'revise') {
      summary.revised++;
      await db.update(proposedCodeChanges).set({
        status: 'revised',
        reviewerNotes: result.revisionGuidance || result.reason,
        aldenDecisionReason: result.reason,
        reviewedAt: new Date(),
      }).where(eq(proposedCodeChanges.id, change.id));

      await postDecision(change, result, false, false);

    } else {
      summary.escalated++;
      await db.update(proposedCodeChanges).set({
        status: 'escalated',
        reviewerNotes: result.escalationSummary || result.reason,
        aldenDecisionReason: result.reason,
        reviewedAt: new Date(),
      }).where(eq(proposedCodeChanges.id, change.id));

      await postDecision(change, result, false, false);
    }
  }

  console.log(`[AldenReview] Queue complete: ${summary.approved} approved (${summary.applied} applied, ${summary.githubSynced} synced), ${summary.revised} revised, ${summary.escalated} escalated`);
  return summary;
}

export async function getReviewStats(daysPast = 7): Promise<CodeReviewSummary> {
  const db = getSharedDb();
  const since = new Date(Date.now() - daysPast * 24 * 60 * 60 * 1000);

  const all = await db
    .select({ status: proposedCodeChanges.status })
    .from(proposedCodeChanges)
    .where(gte(proposedCodeChanges.createdAt, since));

  const summary: CodeReviewSummary = { total: all.length, approved: 0, applied: 0, githubSynced: 0, revised: 0, escalated: 0, failed: 0 };
  for (const r of all) {
    if (r.status === 'approved') summary.approved++;
    if (r.status === 'applied') { summary.approved++; summary.applied++; }
    if (r.status === 'revised') summary.revised++;
    if (r.status === 'escalated') summary.escalated++;
  }
  return summary;
}
