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
import { ALDEN_WORKER_MODEL, ALDEN_WORKER_MEDIUM_EFFORT, aldenWorkerText } from './alden-worker-model';
import { getSharedDb } from '../db';
import { costTracker } from './cost-tracker';
import { proposedCodeChanges, editorInsights, founderSessions } from '@shared/schema';
import { eq, and, desc, gte } from 'drizzle-orm';
import { founderCollabService } from './founder-collaboration-service';
import { postToActiveTeamRoom } from './team-room-proactive-poster';
import { SourceControlService } from './source-control-service';

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

interface ReviewResult {
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
    model: ALDEN_WORKER_MODEL,
    max_tokens: 8000,
    ...ALDEN_WORKER_MEDIUM_EFFORT,
    system: `You are Alden, HolaHola's platform architect. You review code changes from the AI team with architectural judgment. Respond ONLY with a JSON object: { "decision": "approve"|"revise"|"escalate", "reason": "...", "revisionGuidance": "..." (if revise), "escalationSummary": "..." (if escalate) }`,
    messages: [{ role: 'user', content: prompt }],
  });
  costTracker.track(ALDEN_WORKER_MODEL, response.usage?.input_tokens ?? 0, response.usage?.output_tokens ?? 0, 'alden-code-review');

  const raw = aldenWorkerText(response.content as any);
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

function applyPatch(filePath: string, lineStart: number, lineEnd: number, afterCode: string): boolean {
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const lines = raw.split('\n');
    const before = lines.slice(0, lineStart - 1);
    const after = lines.slice(lineEnd);
    const newLines = [...before, ...afterCode.split('\n'), ...after];
    fs.writeFileSync(filePath, newLines.join('\n'), 'utf-8');
    console.log(`[AldenReview] Applied patch to ${filePath}:${lineStart}-${lineEnd}`);
    return true;
  } catch (err: any) {
    console.error(`[AldenReview] File write failed for ${filePath}:`, err.message);
    return false;
  }
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
  githubSynced: boolean
): Promise<void> {
  const sessionId = await getOrCreateAldenSession();

  const icon = result.decision === 'approve' ? '✓' : result.decision === 'revise' ? '↩' : '⚠';
  const label = result.decision === 'approve'
    ? applied ? 'APPROVED + APPLIED' : 'APPROVED (apply failed)'
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

export async function runReviewQueue(): Promise<CodeReviewSummary> {
  const db = getSharedDb();
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

  const memory = await loadAldenMemory();

  for (const change of pending) {
    console.log(`[AldenReview] Reviewing: "${change.findingTitle}"`);
    let result: ReviewResult;

    try {
      result = await reviewWithClaude(change, memory);
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

      applied = applyPatch(change.filePath, change.lineStart, change.lineEnd, change.afterCode);

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
        reviewedAt: new Date(),
        appliedAt: applied ? new Date() : null,
        githubSynced,
      }).where(eq(proposedCodeChanges.id, change.id));

      await postReviewDecision(change, result, applied, githubSynced);

    } else if (result.decision === 'revise') {
      summary.revised++;
      await db.update(proposedCodeChanges).set({
        status: 'revised',
        reviewerNotes: result.revisionGuidance || result.reason,
        aldenDecisionReason: result.reason,
        reviewedAt: new Date(),
      }).where(eq(proposedCodeChanges.id, change.id));

      await postReviewDecision(change, result, false, false);

    } else {
      summary.escalated++;
      await db.update(proposedCodeChanges).set({
        status: 'escalated',
        reviewerNotes: result.escalationSummary || result.reason,
        aldenDecisionReason: result.reason,
        reviewedAt: new Date(),
      }).where(eq(proposedCodeChanges.id, change.id));

      await postReviewDecision(change, result, false, false);
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
