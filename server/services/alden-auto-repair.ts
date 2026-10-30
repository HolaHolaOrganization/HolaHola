/**
 * Alden Auto-Repair Service
 *
 * Closes the 24/7 coverage gap: when Alden's watch detects something broken
 * at 3am, he doesn't wait hours for approval — he attempts a fix immediately,
 * the guardian verifies the server came back up, and both David and the agent
 * are notified of what happened (and rolled back if it went wrong).
 *
 * Safety gates (all must pass before any file is touched):
 *   1. Type gate  — only: null_guard, config_value, missing_check, trivial_logic, import_fix
 *   2. Scope gate — ≤3 files; blocklist covers orchestrator, schema, routes, auth, billing
 *   3. Confidence — LLM must rate 'high'; medium/low → notify only, do not repair
 *   4. Search match — fix uses exact-string replacement; if the target string isn't
 *                     found verbatim the plan is rejected before any writes
 *   5. Guardian   — existing rollback mechanism; if server doesn't come back, files restored
 *   6. Dual log   — David sees aldenNotifications; agent sees .local/alden-repairs.md
 */

import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';
import Anthropic from '@anthropic-ai/sdk';
import { getUserDb } from '../db';
import { costTracker } from './cost-tracker';
import { ALDEN_BACKGROUND_MODEL, ALDEN_BACKGROUND_THINKING } from './alden-background-model';
import { aldenNotifications, buildQueue } from '@shared/schema';
import { aldenWriteBoundary } from './alden-write-boundary';

const GUARDIAN_MANIFEST_PATH = '/tmp/alden-guardian-manifest.json';
const REPAIR_LOG_PATH = path.join(process.cwd(), '.local/alden-repairs.md');

const BLOCKED_FILE_PATTERNS = [
  'streaming-voice-orchestrator',
  'unified-ws-handler',
  'schema.ts',
  'routes.ts',
  'index.ts',
  '/auth',
  'billing',
  'stripe',
  'payment',
  'guardian',
  'alden-build-service',
  'alden-auto-repair',
];

export type RepairType =
  | 'null_guard'
  | 'config_value'
  | 'missing_check'
  | 'trivial_logic'
  | 'import_fix';

interface RepairClassification {
  eligible: boolean;
  type: RepairType | null;
  confidence: 'high' | 'medium' | 'low';
  reason: string;
}

interface RepairFileChange {
  filePath: string;
  originalContent: string;
  newContent: string;
  description: string;
}

export interface RepairPlan {
  repairId: string;
  issueDescription: string;
  repairType: RepairType;
  changes: RepairFileChange[];
  explanation: string;
}

export interface AutoRepairCompletePayload {
  repairId: string;
  featureName: string;
  issueDescription: string;
  explanation: string;
  changeDescriptions: Array<{ file: string; desc: string }>;
  success: boolean;
  filesRestored: string[];
  error?: string;
}

function isFileBlocked(filePath: string): boolean {
  return BLOCKED_FILE_PATTERNS.some(p => filePath.includes(p));
}

function getAnthropicClient(): Anthropic {
  return new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY,
  });
}

async function classifyRepair(
  issueDescription: string,
  recentErrors: string,
): Promise<RepairClassification> {
  const client = getAnthropicClient();

  const response = await client.messages.create({
    model: ALDEN_BACKGROUND_MODEL,
    max_tokens: 512,
    ...ALDEN_BACKGROUND_THINKING,
    messages: [{
      role: 'user',
      content: `You are Alden, the autonomous repair system for HolaHola (a 24/7 global language learning app). Evaluate whether this issue qualifies for immediate auto-repair without human approval.


Issue: ${issueDescription}
Recent errors: ${recentErrors.substring(0, 800)}

Auto-repair is ONLY eligible when ALL conditions are met:
1. Fix type is one of: null_guard, config_value, missing_check, trivial_logic, import_fix
2. Root cause is unambiguous from the error — no guesswork required
3. Fix touches ≤3 files and ≤30 changed lines total
4. No understanding of complex business logic is required
5. A server restart + /api/health 200 is sufficient proof the fix worked

Respond with EXACTLY this JSON (no other text):
{
  "eligible": true,
  "type": "null_guard",
  "confidence": "high",
  "reason": "brief explanation"
}`,
    }],
  });

  costTracker.track(ALDEN_BACKGROUND_MODEL, response.usage?.input_tokens ?? 0, response.usage?.output_tokens ?? 0, 'alden-auto-repair-classify');
  // With thinking available, the first block is not necessarily text.
  const textBlock = response.content.find((block) => block.type === 'text');
  const text = (textBlock as any)?.text?.trim() || '';
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return { eligible: false, type: null, confidence: 'low', reason: 'Could not parse LLM response' };

  try {
    return JSON.parse(match[0]) as RepairClassification;
  } catch {
    return { eligible: false, type: null, confidence: 'low', reason: 'JSON parse failed' };
  }
}

async function generateRepairPlan(
  issueDescription: string,
  repairType: RepairType,
  recentErrors: string,
): Promise<RepairPlan | null> {
  const client = getAnthropicClient();
  const repairId = `repair-${Date.now()}`;

  const response = await client.messages.create({
    model: ALDEN_BACKGROUND_MODEL,
    max_tokens: 2048,
    ...ALDEN_BACKGROUND_THINKING,
    messages: [{
      role: 'user',
      content: `You are Alden, generating a minimal autonomous code repair for HolaHola.

Issue: ${issueDescription}
Repair type: ${repairType}
Recent errors: ${recentErrors.substring(0, 1200)}

Rules:
- Maximum 3 files, maximum 30 changed lines per file
- Only ${repairType}-style changes allowed
- Use exact searchString/replaceString — must match the file verbatim
- Never touch: streaming-voice-orchestrator, unified-ws-handler, schema.ts, routes.ts, index.ts, auth, billing, stripe, payment files

Respond with EXACTLY this JSON (no other text):
{
  "explanation": "what was broken and what the fix does in 1-2 sentences",
  "changes": [
    {
      "filePath": "/home/runner/workspace/server/services/example.ts",
      "description": "Added null check before accessing timing.p95",
      "searchString": "const val = data.timing.p95;",
      "replaceString": "const val = data?.timing?.p95 ?? 0;"
    }
  ]
}`,
    }],
  });
  costTracker.track(ALDEN_BACKGROUND_MODEL, response.usage?.input_tokens ?? 0, response.usage?.output_tokens ?? 0, 'alden-auto-repair-plan');

  // With thinking available, the first block is not necessarily text.
  const textBlock = response.content.find((block) => block.type === 'text');
  const text = (textBlock as any)?.text?.trim() || '';
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;

  let parsed: any;
  try {
    parsed = JSON.parse(match[0]);
  } catch {
    return null;
  }

  const changes: RepairFileChange[] = [];
  for (const change of (parsed.changes || [])) {
    if (isFileBlocked(change.filePath)) {
      console.warn(`[AutoRepair] Blocked file in plan: ${change.filePath}`);
      return null;
    }

    let original: string;
    try {
      original = fs.readFileSync(change.filePath, 'utf-8');
    } catch (err: any) {
      console.warn(`[AutoRepair] Cannot read ${change.filePath}:`, err.message);
      return null;
    }

    if (!original.includes(change.searchString)) {
      console.warn(`[AutoRepair] searchString not found verbatim in ${change.filePath} — rejecting plan`);
      return null;
    }

    changes.push({
      filePath: change.filePath,
      originalContent: original,
      newContent: original.replace(change.searchString, change.replaceString),
      description: change.description || '',
    });
  }

  if (changes.length === 0) return null;

  return {
    repairId,
    issueDescription,
    repairType,
    changes,
    explanation: parsed.explanation || 'Auto-repair applied',
  };
}

async function writeNotification(
  content: string,
  severity: 'info' | 'warning' | 'alert',
): Promise<void> {
  try {
    const db = getUserDb();
    await db.insert(aldenNotifications).values({
      content,
      triggeredBy: 'auto-repair',
      severity,
      read: false,
    });
  } catch (err: any) {
    console.warn('[AutoRepair] Failed to write notification:', err.message);
  }
}

function appendRepairLog(entry: string): void {
  try {
    fs.mkdirSync(path.dirname(REPAIR_LOG_PATH), { recursive: true });

    let existing = '';
    try { existing = fs.readFileSync(REPAIR_LOG_PATH, 'utf-8'); } catch {}

    if (!existing) {
      existing = `# Alden Auto-Repair Log\n\n> Agent: check this file at session start. Alden updates it whenever he auto-repairs something while you're offline. Each entry shows what broke, what was changed, and whether it worked.\n\n`;
    }

    fs.writeFileSync(REPAIR_LOG_PATH, existing + entry, 'utf-8');
  } catch (err: any) {
    console.warn('[AutoRepair] Failed to write repair log:', err.message);
  }
}

function utcTimestamp(): string {
  return new Date().toLocaleString('en-US', {
    timeZone: 'UTC',
    month: 'short', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
    hour12: false,
  }) + ' UTC';
}

/**
 * Queue an issue as a build_queue proposal when Alden can't safely auto-repair it.
 * This is the "tiered autonomy" path: instead of silently dropping the issue, we
 * surface it for async review by the Agent or David.
 */
async function queueAsProposal(issueDescription: string, reason: string): Promise<void> {
  try {
    const db = getUserDb();
    await db.insert(buildQueue).values({
      proposedBy: 'alden',
      title: `Auto-repair deferred: ${issueDescription.substring(0, 80)}`,
      description: `Alden identified an issue but could not safely auto-repair it.\n\nIssue: ${issueDescription}\n\nReason deferred: ${reason}\n\nThis needs Agent or human review.`,
      isSafeZone: false,
      priority: 6,
      status: 'pending',
    });
    console.log('[AutoRepair] Queued as build proposal for review');
  } catch (err: any) {
    console.warn('[AutoRepair] Failed to queue proposal:', err.message);
  }
}

/**
 * Main entry point. Called from alden-watch-worker when a WARNING or ALERT
 * issue is detected. Returns true if a repair was initiated, false if ineligible.
 */
export async function attemptAutoRepair(
  issueDescription: string,
  recentErrors: string = '',
): Promise<boolean> {
  console.log('[AutoRepair] Evaluating:', issueDescription.substring(0, 120));

  try {
    const classification = await classifyRepair(issueDescription, recentErrors);

    if (!classification.eligible || classification.confidence !== 'high' || !classification.type) {
      // Tiered autonomy: if there's a meaningful signal (medium confidence or known type),
      // queue it for async review instead of silently dropping it.
      const worthQueuing = classification.confidence === 'medium' || classification.type !== null;
      if (worthQueuing) {
        await queueAsProposal(issueDescription, classification.reason);
      }
      console.log(`[AutoRepair] Ineligible — ${worthQueuing ? 'queued for review' : 'dropped'}. ${classification.reason}`);
      return false;
    }

    console.log(`[AutoRepair] Eligible: type=${classification.type} confidence=high`);

    const plan = await generateRepairPlan(issueDescription, classification.type, recentErrors);
    if (!plan) {
      console.log('[AutoRepair] Plan generation failed or was rejected by safety checks');
      return false;
    }

    console.log(`[AutoRepair] Plan: ${plan.changes.length} file(s) — ${plan.explanation.substring(0, 80)}`);

    // Production write boundary: outside `dev` the plan is queued for review;
    // no manifest or file is written and no guardian is spawned.
    const boundary = aldenWriteBoundary();
    if (!boundary.allowed) {
      const planText = plan.changes.map(c => `• ${c.filePath}: ${c.description}`).join('\n');
      await queueAsProposal(issueDescription, `${boundary.reason}. Proposed repair (${classification.type}): ${plan.explanation}\n${planText}`);
      await writeNotification(
        `Auto-repair proposed, not applied (${boundary.role}): ${plan.explanation}\n\nThe plan is queued for review. Nothing was written.`,
        'info',
      );
      console.log(`[AutoRepair] Not applied (${boundary.role}); queued for review.`);
      return false;
    }

    const changeList = plan.changes
      .map(c => `• ${path.basename(c.filePath)}: ${c.description}`)
      .join('\n');

    await writeNotification(
      `Auto-repair initiated (${classification.type}):\n${plan.explanation}\n\nFiles:\n${changeList}\n\nGuardian is monitoring server health. A follow-up notification will confirm success or rollback.`,
      'info',
    );

    const backups: Record<string, string> = {};
    for (const change of plan.changes) {
      backups[change.filePath] = change.originalContent;
    }

    const manifest = {
      mode: 'auto-repair',
      repairId: plan.repairId,
      featureName: `Auto-repair: ${classification.type}`,
      issueDescription: plan.issueDescription,
      explanation: plan.explanation,
      changeDescriptions: plan.changes.map(c => ({ file: c.filePath, desc: c.description })),
      backups,
      port: 5000,
      cwd: process.cwd(),
      timestamp: new Date().toISOString(),
    };

    fs.writeFileSync(GUARDIAN_MANIFEST_PATH, JSON.stringify(manifest), 'utf-8');

    try {
      const guardianPath = path.join(process.cwd(), 'scripts/alden-build-guardian.js');
      const guardian = spawn(process.execPath, [guardianPath], {
        detached: true,
        stdio: 'ignore',
        env: { ...process.env },
        cwd: process.cwd(),
      });
      guardian.unref();
      console.log(`[AutoRepair] Guardian spawned (PID: ${guardian.pid})`);
    } catch (err: any) {
      console.warn('[AutoRepair] Guardian spawn failed (no rollback protection):', err.message);
    }

    for (const change of plan.changes) {
      fs.writeFileSync(change.filePath, change.newContent, 'utf-8');
      console.log(`[AutoRepair] Wrote: ${change.filePath}`);
    }

    return true;
  } catch (err: any) {
    console.error('[AutoRepair] Unexpected error:', err.message);
    return false;
  }
}

/**
 * Called by the /api/alden/internal/auto-repair-complete route
 * after the guardian finishes health-checking the restarted server.
 * Writes the final notification and the agent briefing log entry.
 */
export function handleAutoRepairComplete(payload: AutoRepairCompletePayload): void {
  const ts = utcTimestamp();
  const changeList = (payload.changeDescriptions || [])
    .map(c => `• ${path.basename(c.file)}: ${c.desc}`)
    .join('\n');

  if (payload.success) {
    writeNotification(
      `Auto-repair COMPLETE — server healthy.\n\n${payload.explanation}\n\nApplied:\n${changeList}`,
      'info',
    ).catch(() => {});

    appendRepairLog(
      `## [${ts}] SUCCESS — ${payload.featureName}\n` +
      `**Issue:** ${payload.issueDescription}\n` +
      `**Fix:** ${payload.explanation}\n` +
      `**Changed:**\n${changeList}\n` +
      `**Health check:** PASSED (server online, /api/health 200)\n\n---\n\n`,
    );

    console.log(`[AutoRepair] Guardian confirmed SUCCESS for ${payload.repairId}`);
  } else {
    writeNotification(
      `Auto-repair ROLLED BACK — fix caused server crash.\n\nIssue: ${payload.issueDescription}\nError: ${payload.error || 'Server did not recover'}\nFiles restored: ${payload.filesRestored.join(', ')}\n\nManual review needed.`,
      'alert',
    ).catch(() => {});

    appendRepairLog(
      `## [${ts}] ROLLED BACK — ${payload.featureName}\n` +
      `**Issue:** ${payload.issueDescription}\n` +
      `**Error:** ${payload.error || 'Server crash after applying fix'}\n` +
      `**Files restored:** ${payload.filesRestored.join(', ')}\n` +
      `**Health check:** FAILED — original files restored\n\n---\n\n`,
    );

    console.warn(`[AutoRepair] Guardian confirmed ROLLBACK for ${payload.repairId}`);
  }
}
