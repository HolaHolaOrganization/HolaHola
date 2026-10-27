/**
 * Alden Watch Worker
 *
 * Runs on a schedule and autonomously checks system health.
 * If Alden's intelligence determines something warrants the founder's attention,
 * it writes a proactive notification that surfaces in Talk to Alden.
 *
 * This is what gives Alden the ability to initiate — to speak up
 * without being asked.
 */

import Anthropic from "@anthropic-ai/sdk";
import fs from "fs";
import path from "path";
import { getUserDb } from "../db";
import { aldenNotifications, aiCostLogs, aldenWatchConfig, voiceSessions } from "@shared/schema";
import { sql as drizzleSql, eq, desc, and, gte, isNotNull } from "drizzle-orm";
import { executeAldenTool, toAnthropicAldenTools } from "./alden-functions";
import { aldenWatchToolResultContent } from "./alden-tool-result";
import {
  captureSnapshot,
  detectAnomalies,
  analyzePatterns,
  type MetricType,
} from "./monitoring-service";
import { attemptAutoRepair } from "./alden-auto-repair";
import { costTracker } from "./cost-tracker";
import { writeEscalation } from "./alden-escalation-log";
import { founderCollabService } from "./founder-collaboration-service";

// ── Heartbeat & boot-log file paths ─────────────────────────────────────────
// These lightweight files let AldenWatch detect its own failure and let the
// watch cycle detect a server restart spiral — without any schema migration.
const LOCAL_DIR = path.join(process.cwd(), '.local');
const HEARTBEAT_FILE = path.join(LOCAL_DIR, 'alden-watch-heartbeat.json');
const BOOT_LOG_FILE  = path.join(LOCAL_DIR, 'server-boot-log.json');

// How many restarts in a 2h window constitute a spiral worth alerting on
const RESTART_ALERT_THRESHOLD = 3;
const RESTART_ALERT_WINDOW_MS = 2 * 60 * 60 * 1000;

function writeHeartbeat(status: 'running' | 'ok' | 'failed', error?: string): void {
  try {
    fs.mkdirSync(LOCAL_DIR, { recursive: true });
    fs.writeFileSync(HEARTBEAT_FILE, JSON.stringify({
      status,
      updatedAt: Date.now(),
      ...(error ? { error } : {}),
    }), 'utf8');
  } catch { /* non-fatal */ }
}

function readBootTimestamps(): number[] {
  try {
    return JSON.parse(fs.readFileSync(BOOT_LOG_FILE, 'utf8')) as number[];
  } catch {
    return [];
  }
}

function recentBootCount(): number {
  const cutoff = Date.now() - RESTART_ALERT_WINDOW_MS;
  return readBootTimestamps().filter(t => t > cutoff).length;
}

// Counter so the emergency catch-block notification doesn't spam on every failed cycle
let consecutiveWatchFailures = 0;

const DEFAULT_CHECK_INTERVAL_H   = 2;
const CHECK_INTERVAL_MS           = DEFAULT_CHECK_INTERVAL_H * 60 * 60 * 1000;
const HEALTH_SCORE_LOW_THRESHOLD  = 70;

// Cost tier thresholds (24h window) — defaults, overridable via alden_watch_config
const BUDGET_WARN_USD       = 3;   // Tier 1 — notification only (existing behaviour)
const BUDGET_ALERT_USD      = 5;   // Tier 2 — notification + Hive post
const BUDGET_HARD_PAUSE_USD = 10;  // Tier 3 — Hive post + skip cycle entirely

/**
 * Live watch parameters — read from alden_watch_config at the start of each cycle.
 * Falls back to compile-time defaults if the DB row doesn't exist yet.
 */
async function getWatchParams(): Promise<{
  checkIntervalMs: number;
  recoveryPollMs: number;
  budgetWarnUsd: number;
  budgetAlertUsd: number;
  lowHealthThreshold: number;
  consecutiveLowScoreTrigger: number;
  fingerprintTtlMs: number;
}> {
  try {
    const db = getUserDb();
    const rows = await db.select().from(aldenWatchConfig).limit(1);
    const cfg = rows[0];
    if (!cfg) throw new Error('no config row');
    return {
      checkIntervalMs:          (cfg.checkIntervalHours  || DEFAULT_CHECK_INTERVAL_H) * 60 * 60 * 1000,
      recoveryPollMs:           (cfg.recoveryPollMinutes || 10) * 60 * 1000,
      budgetWarnUsd:             cfg.budgetWarnUsd        ?? BUDGET_WARN_USD,
      budgetAlertUsd:            cfg.budgetAlertUsd       ?? BUDGET_ALERT_USD,
      lowHealthThreshold:        cfg.lowHealthThreshold   ?? HEALTH_SCORE_LOW_THRESHOLD,
      consecutiveLowScoreTrigger:cfg.consecutiveLowScoreTrigger ?? 3,
      fingerprintTtlMs:         (cfg.fingerprintTtlHours ?? 24) * 60 * 60 * 1000,
    };
  } catch {
    // Defaults if no config row exists yet
    return {
      checkIntervalMs:           CHECK_INTERVAL_MS,
      recoveryPollMs:            10 * 60 * 1000,
      budgetWarnUsd:             BUDGET_WARN_USD,
      budgetAlertUsd:            BUDGET_ALERT_USD,
      lowHealthThreshold:        HEALTH_SCORE_LOW_THRESHOLD,
      consecutiveLowScoreTrigger:3,
      fingerprintTtlMs:          24 * 60 * 60 * 1000,
    };
  }
}

/**
 * DB-backed 24h AI spend — survives process restarts.
 * Falls back to in-memory costTracker only if the DB query fails.
 */
async function getDb24hSpend(): Promise<{ spend: number; source: 'db' | 'memory' }> {
  try {
    const db = getUserDb();
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    const rows = await db
      .select({ total: drizzleSql<number>`coalesce(sum(${aiCostLogs.costUsd}), 0)` })
      .from(aiCostLogs)
      .where(drizzleSql`${aiCostLogs.loggedAt} >= ${cutoff}`);
    return { spend: Number(rows[0]?.total ?? 0), source: 'db' };
  } catch {
    return { spend: costTracker.getSummary(24).totalCostUsd, source: 'memory' };
  }
}

// Tool-use loop safety cap
const MAX_TOOL_ITERATIONS = 8;

// Founder ID used across Hive/Express-Lane posts
const FOUNDER_ID = '49847136';

// Rolling history — last 5 cycles used for trend comparison
interface CycleMetric {
  timestamp: number;
  activeStudents: number;
  voiceSessionsToday: number;
  newConversations24h: number;
  issueCount: number;
  heapUsedMB: number;
  healthScore: number;
}
const MAX_CYCLE_HISTORY = 5;
const cycleHistory: CycleMetric[] = [];

// Health score consecutive drop tracking
let consecutiveLowScoreCycles = 0;

// Budget alert cooldown — per-tier so Tier-2 is never suppressed by a prior Tier-1 fire
let lastBudgetWarnTime:  number | null = null;  // Tier 1 — $3
let lastBudgetAlertTime: number | null = null;  // Tier 2 — $5

// Hard-pause state: set when 24h spend crosses $10; cleared when spend drops below
let hardPauseActive = false;

// Live watch params — updated at the start of each cycle from alden_watch_config
let liveWarnUsd   = BUDGET_WARN_USD;
let liveAlertUsd  = BUDGET_ALERT_USD;
let liveHealthThreshold = HEALTH_SCORE_LOW_THRESHOLD;
let liveConsecutiveTrigger = 3;

// Last watch cycle timestamp — exposed via /api/admin/alden-status
let lastWatchCycleTime: number | null = null;

// Rolling buffer of last 5 notification fingerprints for status endpoint
const MAX_FP_HISTORY = 5;
const lastNotificationFingerprints: Array<{ fp: string; ts: number }> = [];

// Note: global cooldown removed. Each issue type is deduplicated by fingerprint
// (hasDuplicateActiveIssue). New issue types fire immediately; repeat issues are
// suppressed until the founder marks the prior notification as read.

// Auto-repair proposal: rolling buffer of last 3 non-NOTHING alert messages
const MAX_ALERT_HISTORY = 3;
const recentAlertMessages: string[] = [];

function pct(current: number, avg: number): string {
  if (avg === 0) return current > 0 ? '+∞%' : '—';
  const delta = ((current - avg) / avg) * 100;
  return (delta >= 0 ? '+' : '') + delta.toFixed(0) + '%';
}

function buildTrendBlock(current: CycleMetric, history: CycleMetric[]): Record<string, any> {
  if (history.length === 0) return { note: 'First cycle — no baseline yet' };
  const avg = (key: keyof CycleMetric) => {
    const vals = history.map(h => h[key] as number);
    return vals.reduce((a, b) => a + b, 0) / vals.length;
  };
  return {
    cyclesInBaseline: history.length,
    activeStudents:      `${current.activeStudents} (${pct(current.activeStudents, avg('activeStudents'))} vs avg)`,
    voiceSessionsToday:  `${current.voiceSessionsToday} (${pct(current.voiceSessionsToday, avg('voiceSessionsToday'))} vs avg)`,
    newConversations24h: `${current.newConversations24h} (${pct(current.newConversations24h, avg('newConversations24h'))} vs avg)`,
    issueCount:          `${current.issueCount} (${pct(current.issueCount, avg('issueCount'))} vs avg)`,
    heapUsedMB:          `${current.heapUsedMB.toFixed(0)} MB (${pct(current.heapUsedMB, avg('heapUsedMB'))} vs avg)`,
    healthScore:         `${current.healthScore} (${pct(current.healthScore, avg('healthScore'))} vs avg)`,
  };
}

/**
 * Returns true if an unread notification with this fingerprint already exists.
 * This prevents the same issue from being reported repeatedly until the user
 * marks it as read, at which point it can re-fire if the issue recurs.
 */
async function hasDuplicateActiveIssue(fingerprint: string): Promise<boolean> {
  try {
    const db = getUserDb();
    const existing = await db
      .select({ id: aldenNotifications.id })
      .from(aldenNotifications)
      .where(and(
        eq(aldenNotifications.fingerprint, fingerprint),
        eq(aldenNotifications.read, false),
      ))
      .limit(1);
    return existing.length > 0;
  } catch {
    return false;
  }
}

/**
 * Post a message to the Express Lane / Hive as Alden.
 * Fire-and-forget safe — errors are logged but never throw.
 */
async function postHiveMessage(content: string, metadata?: Record<string, any>): Promise<void> {
  try {
    const session = await founderCollabService.getOrCreateActiveSession(FOUNDER_ID);
    await founderCollabService.addMessage(session.id, {
      role: 'editor',
      content: `[Alden Watch] ${content}`,
      metadata: { source: 'alden-watch', ...metadata },
    });
  } catch (err: any) {
    console.warn('[AldenWatch] Hive post failed:', err.message);
  }
}

async function runWatchCycle() {
  // Read live config from DB at start of each cycle so Alden's self-tuning takes effect
  try {
    const params = await getWatchParams();
    liveWarnUsd            = params.budgetWarnUsd;
    liveAlertUsd           = params.budgetAlertUsd;
    liveHealthThreshold    = params.lowHealthThreshold;
    liveConsecutiveTrigger = params.consecutiveLowScoreTrigger;
  } catch { /* keep existing live values if DB read fails */ }

  writeHeartbeat('running');

  try {
    // ── Pre-flight: hard-pause check (Tier 3 — $10 threshold) ───────────────
    // DB-backed so a restart cannot reset enforcement when real 24h spend is already >$10
    const { spend: preflight24hSpend } = await getDb24hSpend();
    if (preflight24hSpend >= BUDGET_HARD_PAUSE_USD) {
      if (!hardPauseActive) {
        hardPauseActive = true;
        const msg = `HARD PAUSE: 24h AI spend has reached $${preflight24hSpend.toFixed(2)}, crossing the $${BUDGET_HARD_PAUSE_USD} hard limit. Watch cycles are suspended until spend drops below this threshold. No further autonomous AI calls will be made this window.`;
        console.warn('[AldenWatch]', msg);
        await postHiveMessage(msg, { tier: 'hard_pause', spendUsd: preflight24hSpend });
        const fp = 'budget_hard_pause';
        const isDup = await hasDuplicateActiveIssue(fp);
        if (!isDup) {
          const dbHard = getUserDb();
          await dbHard.insert(aldenNotifications).values({
            content: msg,
            triggeredBy: 'alden-watch',
            severity: 'alert',
            read: false,
            fingerprint: fp,
          });
        }
        lastNotificationFingerprints.push({ fp, ts: Date.now() });
        if (lastNotificationFingerprints.length > MAX_FP_HISTORY) lastNotificationFingerprints.shift();
      } else {
        console.log('[AldenWatch] Hard pause active — skipping cycle');
      }
      return;
    } else {
      // Spend dropped back below $10 — lift the pause
      if (hardPauseActive) {
        hardPauseActive = false;
        console.log('[AldenWatch] Spend recovered below hard limit — resuming watch cycles');
      }
    }

    // Gather system state using existing tools — each is isolated so one failure
    // doesn't poison the whole snapshot with a WebSocket/DB error narrative.
    const safeCall = async (toolName: string, args: Record<string, any>) => {
      try {
        // Watch cycles always run on Anthropic (see the Claude client used
        // below) regardless of the saved alden_config default — pass that
        // literal engine so get_current_engine can never report the DB
        // default instead of the engine actually running this worker.
        return await executeAldenTool(toolName, args, { engine: 'anthropic' });
      } catch (e: any) {
        console.warn(`[AldenWatch] Tool ${toolName} failed: ${e.message}`);
        return { data: { error: `${toolName} unavailable: ${e.message}` } };
      }
    };
    // Probe SYNC_PEER_URL directly so Alden can surface peer connectivity issues
    // in his snapshot without relying on the Hive service's internal state.
    let peerUrlStatus = 'not configured';
    const peerUrl = process.env.SYNC_PEER_URL;
    if (peerUrl) {
      const ctrl = new AbortController();
      const probeTimer = setTimeout(() => ctrl.abort(), 5000);
      try {
        const res = await fetch(`${peerUrl}/api/health`, { signal: ctrl.signal });
        peerUrlStatus = `HTTP ${res.status}`;
      } catch (e: any) {
        peerUrlStatus = `unreachable: ${e.message?.substring(0, 60)}`;
      } finally {
        clearTimeout(probeTimer);
      }
    }

    // Count server restarts in the last 2h — auto-alert on spiral before Alden's LLM pass
    const bootCount2h = recentBootCount();
    if (bootCount2h > RESTART_ALERT_THRESHOLD) {
      const fp = 'restart_spiral';
      const isDupRestart = await hasDuplicateActiveIssue(fp);
      if (!isDupRestart) {
        const dbRestart = getUserDb();
        await dbRestart.insert(aldenNotifications).values({
          content: `Server has restarted ${bootCount2h} times in the last 2 hours. This may indicate a crash loop or healthcheck death spiral. Check production logs immediately.`,
          triggeredBy: 'alden-watch',
          severity: 'alert',
          read: false,
          fingerprint: fp,
        });
        await postHiveMessage(`RESTART SPIRAL: ${bootCount2h} server restarts detected in the last 2 hours.`, { bootCount: bootCount2h });
        console.warn(`[AldenWatch] Restart spiral alert fired — ${bootCount2h} boots in 2h`);
      }
    }

    const [health, dbStats, issues, learning] = await Promise.all([
      safeCall('get_system_health', {}),
      safeCall('get_database_stats', {}),
      safeCall('get_pending_issues', {}),
      safeCall('check_learning_metrics', {}),
    ]);

    // Build current cycle metric for trend tracking
    const currentMetric: CycleMetric = {
      timestamp: Date.now(),
      activeStudents:      learning.data?.activeStudents || 0,
      voiceSessionsToday:  learning.data?.voiceSessionsToday || 0,
      newConversations24h: learning.data?.newConversationsLast24h || 0,
      issueCount:          issues.data?.issues?.length || 0,
      heapUsedMB:          health.data?.memory?.heapUsedMB || 0,
      healthScore:         health.data?.voiceHealth?.score || 0,
    };
    const trendBlock = buildTrendBlock(currentMetric, cycleHistory);

    // Capture monitoring snapshots
    await Promise.all([
      captureSnapshot('system_health', {
        status: health.data?.voiceHealth?.status,
        score: health.data?.voiceHealth?.score,
        activeSessions: health.data?.activeSessions,
      }, 'Watch cycle - system health'),
      
      captureSnapshot('user_activity', {
        activeStudents: learning.data?.activeStudents || 0,
        conversationsInProgress: learning.data?.conversationsInProgress || 0,
      }, 'Watch cycle - user activity'),
      
      captureSnapshot('voice_engagement', {
        sessionsToday: learning.data?.voiceSessionsToday || 0,
      }, 'Watch cycle - voice engagement'),
      
      captureSnapshot('error_rate', {
        count: issues.data?.issues?.length || 0,
      }, 'Watch cycle - error rate'),
    ]);

    // Detect anomalies across the last 24 hours
    const anomalies = await detectAnomalies(24);

    // Analyze patterns for each metric type
    const patterns = await Promise.all([
      analyzePatterns('system_health', 7),
      analyzePatterns('user_activity', 7),
      analyzePatterns('voice_engagement', 7),
      analyzePatterns('error_rate', 7),
    ]);

    // Summarise issues — send counts and top 3 by severity, not the full list.
    // This prevents 165-item pending queues from dominating the 5500-char cap.
    const issuesList: any[] = issues.data?.issues || [];
    const issuesSummary = {
      total: issuesList.length,
      bySeverity: issuesList.reduce((acc: Record<string, number>, i: any) => {
        const sev = i.severity || 'unknown';
        acc[sev] = (acc[sev] || 0) + 1;
        return acc;
      }, {}),
      top3: issuesList
        .sort((a: any, b: any) => {
          const order: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };
          return (order[a.severity] ?? 9) - (order[b.severity] ?? 9);
        })
        .slice(0, 3)
        .map((i: any) => ({ type: i.type, severity: i.severity, message: (i.message || '').substring(0, 120) })),
    };

    const systemSnapshot = JSON.stringify({
      health: health.data,
      database: dbStats.data,
      issues: issuesSummary,
      learning: learning.data,
      trends: trendBlock,
      infrastructure: {
        peerSyncUrl: peerUrl ? `${peerUrl} → ${peerUrlStatus}` : 'not configured',
        serverRestartsLast2h: bootCount2h,
      },
      anomalies: anomalies.map(a => ({
        metric: a.metric,
        severity: a.severity,
        message: a.message,
      })),
      patterns: patterns.map(p => ({
        metric: p.metricType,
        trend: p.trend,
        confidence: p.confidence,
        findings: p.findings,
      })),
    }, null, 2).substring(0, 5500);

    // ── Agentic tool-use loop ────────────────────────────────────────────────
    // Alden can call tools autonomously (up to MAX_TOOL_ITERATIONS turns) to
    // investigate before settling on a verdict. The loop terminates when:
    //   • stop_reason === 'end_turn'   — Alden is done thinking
    //   • stop_reason !== 'tool_use'   — unexpected stop, treat as done
    //   • iteration cap reached        — safety valve
    const client = new Anthropic({
      apiKey: process.env.ANTHROPIC_API_KEY,
    });

    const anthropicTools = toAnthropicAldenTools();

    const loopMessages: Anthropic.MessageParam[] = [{
      role: 'user',
      content: `You are Alden, the development steward of HolaHola. You just ran a routine system check with autonomous pattern detection and anomaly analysis. Review this snapshot and decide: is there anything genuinely worth notifying the founder (David) about?

You have access to tools — use them to investigate anything that looks suspicious before reaching a verdict. Only call tools when you genuinely need more information to make a decision.

System snapshot:
${systemSnapshot}

Rules:
- Only notify if something is actually wrong, unusual, or worth his attention
- Don't notify for normal healthy states
- Anomalies and pattern changes are provided — use them in your analysis
- When you are done investigating, respond with exactly: NOTHING
  OR in this exact format on ONE line:
  SEVERITY:FINGERPRINT:Message written as Alden speaking directly to David (1-3 sentences)
  Where SEVERITY is INFO, WARNING, or ALERT
  Where FINGERPRINT is a short snake_case key identifying this issue type (e.g. db_connection_failure, low_engagement, high_latency, health_score_low, budget_exceeded, voice_pipeline_error)

Example: WARNING:db_connection_failure:The database monitoring tools are failing to connect, which is preventing me from gathering accurate system metrics. This needs investigation.

Respond with NOTHING or a single line in SEVERITY:FINGERPRINT:Message format:`,
    }];

    let finalText = 'NOTHING';
    let totalInputTokens = 0;
    let totalOutputTokens = 0;

    for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration++) {
      const response = await client.messages.create({
        model: 'claude-sonnet-4-5',
        max_tokens: 600,
        tools: anthropicTools,
        messages: loopMessages,
      });

      if (response.usage) {
        totalInputTokens  += response.usage.input_tokens;
        totalOutputTokens += response.usage.output_tokens;
      }

      // Append assistant's response to conversation
      loopMessages.push({ role: 'assistant', content: response.content });

      if (response.stop_reason === 'end_turn') {
        // Extract the text verdict from the final response
        const textBlock = response.content.find(b => b.type === 'text');
        finalText = (textBlock as any)?.text?.trim() || 'NOTHING';
        console.log(`[AldenWatch] Tool loop ended at iteration ${iteration + 1}`);
        break;
      }

      if (response.stop_reason !== 'tool_use') {
        // Unexpected stop reason — extract text if present and break
        const textBlock = response.content.find(b => b.type === 'text');
        finalText = (textBlock as any)?.text?.trim() || 'NOTHING';
        console.log(`[AldenWatch] Unexpected stop_reason "${response.stop_reason}" at iteration ${iteration + 1}`);
        break;
      }

      // Execute each tool call and gather results
      const toolResults: Anthropic.ToolResultBlockParam[] = [];
      for (const block of response.content) {
        if (block.type !== 'tool_use') continue;
        console.log(`[AldenWatch] Tool call: ${block.name} (iteration ${iteration + 1})`);
        let toolOutput: any;
        try {
          // Same as safeCall above: this loop is Anthropic-only, so pin the
          // engine context rather than letting get_current_engine fall back
          // to whatever the saved alden_config default currently is.
          toolOutput = await executeAldenTool(block.name, block.input as Record<string, any>, { engine: 'anthropic' });
        } catch (e: any) {
          toolOutput = { error: `Tool "${block.name}" failed: ${e.message}` };
        }
        try {
          toolResults.push({
            type: 'tool_result',
            tool_use_id: block.id,
            content: aldenWatchToolResultContent(block.name, toolOutput),
          });
        } catch (e: any) {
          toolResults.push({
            type: 'tool_result',
            tool_use_id: block.id,
            is_error: true,
            content: e.message,
          });
        }
      }

      // Append tool results as user turn
      loopMessages.push({ role: 'user', content: toolResults });

      // If we hit the cap on the last iteration, extract whatever text is available
      if (iteration === MAX_TOOL_ITERATIONS - 1) {
        console.warn(`[AldenWatch] Tool loop hit iteration cap (${MAX_TOOL_ITERATIONS}) — treating as NOTHING`);
        finalText = 'NOTHING';
      }
    }

    // Track combined token cost for the entire loop
    costTracker.track('claude-sonnet-4-5', totalInputTokens, totalOutputTokens, 'alden-watch');

    // Save this cycle to rolling history (capped at MAX_CYCLE_HISTORY)
    cycleHistory.push(currentMetric);
    if (cycleHistory.length > MAX_CYCLE_HISTORY) cycleHistory.shift();

    // Record cycle time
    lastWatchCycleTime = Date.now();

    // ── Always-on: health score consecutive drop tracking ───────────────────
    if (currentMetric.healthScore < liveHealthThreshold) {
      consecutiveLowScoreCycles++;
      console.log(`[AldenWatch] Health score ${currentMetric.healthScore} below ${liveHealthThreshold} — consecutive: ${consecutiveLowScoreCycles}`);
      if (consecutiveLowScoreCycles >= liveConsecutiveTrigger) {
        const fp = 'health_score_persistent_low';
        const isDup = await hasDuplicateActiveIssue(fp);
        if (!isDup) {
          const dbH = getUserDb();
          await dbH.insert(aldenNotifications).values({
            content: `Health score has been below ${liveHealthThreshold} for ${consecutiveLowScoreCycles} consecutive watch cycles (current: ${currentMetric.healthScore}). This persistent degradation warrants investigation.`,
            triggeredBy: 'alden-watch',
            severity: 'alert',
            read: false,
            fingerprint: fp,
          });
          console.log(`[AldenWatch] Consecutive low-health alert fired (${consecutiveLowScoreCycles} cycles)`);
        } else {
          console.log(`[AldenWatch] Low-health alert suppressed — already reported and unread`);
        }
      }
    } else {
      if (consecutiveLowScoreCycles > 0) console.log(`[AldenWatch] Health score recovered (${currentMetric.healthScore})`);
      consecutiveLowScoreCycles = 0;
    }

    // ── Always-on: tiered cost budget controls (24h window) ─────────────────
    // DB-backed spend so cost controls survive restarts
    const { spend } = await getDb24hSpend();

    if (spend >= liveAlertUsd) {
      // Tier 2 — liveAlertUsd: notification + Hive post
      const sinceLastAlert = lastBudgetAlertTime ? Date.now() - lastBudgetAlertTime : Infinity;
      if (sinceLastAlert > 12 * 60 * 60 * 1000) {
        console.log(`[AldenWatch] Tier-2 budget: $${spend.toFixed(4)} in 24h (threshold: $${liveAlertUsd})`);
        const fp = 'budget_exceeded';
        const isDupAlert = await hasDuplicateActiveIssue(fp);
        if (!isDupAlert) {
          const dbB = getUserDb();
          await dbB.insert(aldenNotifications).values({
            content: `AI spend in the last 24h has reached $${spend.toFixed(4)}, crossing the $${liveAlertUsd} alert threshold. Review the cost breakdown in Lyra's next report.`,
            triggeredBy: 'alden-watch',
            severity: 'warning',
            read: false,
            fingerprint: fp,
          });
          await postHiveMessage(
            `Budget alert (Tier 2): 24h AI spend is $${spend.toFixed(4)}, over the $${liveAlertUsd} threshold. Monitoring closely.`,
            { tier: 'alert', spendUsd: spend },
          );
          lastBudgetAlertTime = Date.now();
          lastNotificationFingerprints.push({ fp, ts: Date.now() });
          if (lastNotificationFingerprints.length > MAX_FP_HISTORY) lastNotificationFingerprints.shift();
          console.log('[AldenWatch] Tier-2 budget alert queued + Hive post sent');
        } else {
          console.log('[AldenWatch] Budget alert suppressed — already reported and unread');
        }
      }
    } else if (spend >= liveWarnUsd) {
      // Tier 1 — liveWarnUsd: notification + Hive post (early warning)
      const sinceLastWarn = lastBudgetWarnTime ? Date.now() - lastBudgetWarnTime : Infinity;
      if (sinceLastWarn > 12 * 60 * 60 * 1000) {
        console.log(`[AldenWatch] Tier-1 budget warn: $${spend.toFixed(4)} in 24h (threshold: $${liveWarnUsd})`);
        const fp = 'budget_warn';
        const isDupWarn = await hasDuplicateActiveIssue(fp);
        if (!isDupWarn) {
          const dbW = getUserDb();
          await dbW.insert(aldenNotifications).values({
            content: `AI spend in the last 24h has reached $${spend.toFixed(4)}, crossing the $${liveWarnUsd} early-warning threshold. No action required yet.`,
            triggeredBy: 'alden-watch',
            severity: 'info',
            read: false,
            fingerprint: fp,
          });
          await postHiveMessage(
            `Budget early warning (Tier 1): 24h AI spend is $${spend.toFixed(4)}, passing the $${liveWarnUsd} watch threshold. No action needed yet — just a heads-up.`,
            { tier: 'warn', spendUsd: spend },
          );
          lastBudgetWarnTime = Date.now();
          lastNotificationFingerprints.push({ fp, ts: Date.now() });
          if (lastNotificationFingerprints.length > MAX_FP_HISTORY) lastNotificationFingerprints.shift();
          console.log('[AldenWatch] Tier-1 budget warning queued + Hive post sent');
        }
      }
    }

    // ── Always-on: Archive Guardian health (last 7 days) ────────────────────
    try {
      const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
      const dbG = getUserDb();
      const recentSessions = await dbG
        .select({
          id: voiceSessions.id,
          startedAt: voiceSessions.startedAt,
          guardianFires:        voiceSessions.guardianFires,
          guardianHardWalls:    voiceSessions.guardianHardWalls,
          guardianHeard:        voiceSessions.guardianHeard,
          guardianMissed:       voiceSessions.guardianMissed,
          guardianCarryForward: voiceSessions.guardianCarryForward,
        })
        .from(voiceSessions)
        .where(and(
          gte(voiceSessions.startedAt, sevenDaysAgo),
          isNotNull(voiceSessions.guardianFires),
        ))
        .orderBy(desc(voiceSessions.startedAt))
        .limit(20);

      if (recentSessions.length > 0) {
        const totalFires    = recentSessions.reduce((s, r) => s + (r.guardianFires    ?? 0), 0);
        const totalHardWalls = recentSessions.reduce((s, r) => s + (r.guardianHardWalls ?? 0), 0);
        const totalHeard    = recentSessions.reduce((s, r) => s + (r.guardianHeard    ?? 0), 0);
        const totalMissed   = recentSessions.reduce((s, r) => s + (r.guardianMissed   ?? 0), 0);
        const hardWallSessions = recentSessions.filter(r => (r.guardianHardWalls ?? 0) > 0).length;
        const missRate = totalFires > 0 ? totalMissed / totalFires : 0;

        // Alert: hard wall fired in 2+ sessions (repeated manipulation attempts)
        if (hardWallSessions >= 2) {
          const hwFp = 'guardian_hard_wall_repeat';
          const isDupHW = await hasDuplicateActiveIssue(hwFp);
          if (!isDupHW) {
            const dbHW = getUserDb();
            await dbHW.insert(aldenNotifications).values({
              content: `The Archive Guardian hard wall intercepted suspicious phrases in ${hardWallSessions} sessions over the last 7 days (${totalHardWalls} total intercepts). This is a pattern — someone may be probing Daniela's memory boundaries. Review recent sessions.`,
              triggeredBy: 'alden-watch',
              severity: 'warning',
              read: false,
              fingerprint: hwFp,
            });
            console.log(`[AldenWatch] Guardian hard-wall pattern alert — ${hardWallSessions} sessions affected`);
          }
        }

        // Warning: missed rate > 40% with at least 5 fires (grounding not landing)
        if (missRate > 0.4 && totalFires >= 5) {
          const missedFp = 'guardian_high_miss_rate';
          const isDupMiss = await hasDuplicateActiveIssue(missedFp);
          if (!isDupMiss) {
            const dbMR = getUserDb();
            await dbMR.insert(aldenNotifications).values({
              content: `The Archive Guardian fired ${totalFires} times in the last 7 days but ${totalMissed} went unacknowledged (${Math.round(missRate * 100)}% miss rate). Daniela may not be connecting the grounding context to her responses — worth investigating injection timing.`,
              triggeredBy: 'alden-watch',
              severity: 'info',
              read: false,
              fingerprint: missedFp,
            });
            console.log(`[AldenWatch] Guardian miss-rate alert — ${Math.round(missRate * 100)}% miss rate over ${recentSessions.length} sessions`);
          }
        }

        const totalCarry = recentSessions.reduce((s, r) => s + (r.guardianCarryForward ?? 0), 0);
        const carryRate = totalFires > 0 ? totalCarry / totalFires : 0;

        // Info: carry-forward rate > 20% with at least 5 fires (grounding regularly arriving late)
        if (carryRate > 0.2 && totalFires >= 5) {
          const carryFp = 'guardian_high_carry_forward';
          const isDupCarry = await hasDuplicateActiveIssue(carryFp);
          if (!isDupCarry) {
            const dbCF = getUserDb();
            await dbCF.insert(aldenNotifications).values({
              content: `The Archive Guardian carry-forward rate is ${Math.round(carryRate * 100)}% over the last 7 days (${totalCarry} of ${totalFires} fires arrived too late to inject this turn). Grounding is still delivered — just one turn late. If this persists, consider Path A (Tool-Gate) or Path B (VAD Delay) for guaranteed same-turn injection.`,
              triggeredBy: 'alden-watch',
              severity: 'info',
              read: false,
              fingerprint: carryFp,
            });
            console.log(`[AldenWatch] Guardian carry-forward alert — ${Math.round(carryRate * 100)}% carry rate over ${recentSessions.length} sessions`);
          }
        }

        console.log(`[AldenWatch] Guardian health: ${recentSessions.length} sessions, ${totalFires} fires, ${hardWallSessions} hard-wall sessions, ${Math.round(missRate * 100)}% miss rate, ${Math.round(carryRate * 100)}% carry-forward rate`);
      }
    } catch (guardianErr: any) {
      console.warn('[AldenWatch] Guardian health check failed (non-fatal):', guardianErr.message);
    }

    // ── Claude intelligence: conditional on having a real finding ────────────
    const lastMeaningfulLine = finalText.split('\n').map(l => l.trim()).filter(Boolean).pop() ?? '';
    if (
      finalText === 'NOTHING' ||
      finalText.startsWith('NOTHING') ||
      lastMeaningfulLine === 'NOTHING' ||
      lastMeaningfulLine.startsWith('NOTHING')
    ) {
      console.log('[AldenWatch] Check complete — no notification needed');
      consecutiveWatchFailures = 0;
      writeHeartbeat('ok');
      return;
    }

    // Parse SEVERITY:FINGERPRINT:Message format
    let severity: 'info' | 'warning' | 'alert' = 'info';
    let fingerprint: string | undefined;
    let message = finalText;

    const parts = finalText.match(/^(INFO|WARNING|ALERT):([a-z0-9_]+):(.+)$/);
    if (parts) {
      const sev = parts[1].toLowerCase();
      severity = sev === 'warning' ? 'warning' : sev === 'alert' ? 'alert' : 'info';
      fingerprint = parts[2];
      message = parts[3].trim();
    } else {
      // Fallback: old-style parsing without fingerprint
      if (finalText.startsWith('WARNING:')) { severity = 'warning'; message = finalText.replace(/^WARNING:\s*/, ''); }
      else if (finalText.startsWith('ALERT:')) { severity = 'alert'; message = finalText.replace(/^ALERT:\s*/, ''); }
      else if (finalText.startsWith('INFO:')) { message = finalText.replace(/^INFO:\s*/, ''); }
    }

    // Dedup: if an unread notification with the same fingerprint exists, skip
    if (fingerprint) {
      const isDup = await hasDuplicateActiveIssue(fingerprint);
      if (isDup) {
        console.log(`[AldenWatch] Suppressed duplicate (fingerprint: ${fingerprint}) — already unread`);
        return;
      }
    }

    // Write notification
    const db = getUserDb();
    await db.insert(aldenNotifications).values({
      content: message,
      triggeredBy: 'alden-watch',
      severity,
      read: false,
      fingerprint,
    });

    console.log(`[AldenWatch] Queued ${severity} notification [${fingerprint ?? 'no-fingerprint'}]: "${message.substring(0, 80)}..."`);
    consecutiveWatchFailures = 0;
    writeHeartbeat('ok');

    // Track recent fingerprints for status endpoint
    if (fingerprint) {
      lastNotificationFingerprints.push({ fp: fingerprint, ts: Date.now() });
      if (lastNotificationFingerprints.length > MAX_FP_HISTORY) lastNotificationFingerprints.shift();
    }

    // Track alert messages for recurring-pattern detection
    recentAlertMessages.push(message);
    if (recentAlertMessages.length > MAX_ALERT_HISTORY) recentAlertMessages.shift();

    // Auto-repair proposal: if the same class of issue has fired 3 cycles in a row,
    // ask Claude to synthesise a fix proposal and post it to the Hive for Wren.
    if (recentAlertMessages.length === MAX_ALERT_HISTORY) {
      checkAndPostRepairProposal(client, recentAlertMessages).catch(err =>
        console.warn('[AldenWatch] Repair proposal check failed:', err.message)
      );
    }

    // For WARNING or ALERT severity, attempt autonomous repair immediately.
    // Auto-repair runs its own eligibility + confidence gates — if the issue
    // isn't safely fixable it bails without touching anything.
    if (severity === 'warning' || severity === 'alert') {
      const errorContext = JSON.stringify({
        anomalies: systemSnapshot.substring(0, 600),
      });
      attemptAutoRepair(message, errorContext).then(attempted => {
        if (attempted) {
          console.log('[AldenWatch] Auto-repair initiated — guardian is monitoring');
        } else {
          console.log('[AldenWatch] Auto-repair ineligible — notification only');
          // ALERT severity that auto-repair can't touch → escalate immediately to Agent
          if (severity === 'alert') {
            writeEscalation(
              message,
              'Auto-repair declined this issue as ineligible (likely infrastructure or architectural). Immediate Agent review recommended.',
              'alert_ineligible',
            ).catch(e => console.warn('[AldenWatch] Escalation write failed:', e.message));
          }
        }
      }).catch(err => {
        console.warn('[AldenWatch] Auto-repair attempt threw:', err.message);
      });
    }

  } catch (err: any) {
    console.warn('[AldenWatch] Watch cycle failed:', err.message);
    // Write a failed heartbeat so the watchdog can detect a silent broken watcher
    writeHeartbeat('failed', err.message);
    consecutiveWatchFailures++;
    // Emergency: bypass Anthropic (which may be the failure) and insert a DB notification directly.
    // Only fires on the first 3 consecutive failures to avoid notification spam.
    if (consecutiveWatchFailures <= 3) {
      try {
        const dbEmergency = getUserDb();
        await dbEmergency.insert(aldenNotifications).values({
          content: `Alden's autonomous watch cycle failed (${consecutiveWatchFailures} consecutive): ${err.message}. The monitoring system could not complete its check — manual review recommended.`,
          triggeredBy: 'alden-watch-emergency',
          severity: 'alert',
          read: false,
          fingerprint: `alden_watch_failure_${consecutiveWatchFailures}`,
        });
      } catch { /* absolutely non-fatal */ }
    }
  }
}

/**
 * If the last MAX_ALERT_HISTORY watch-cycle alerts share a common pattern,
 * Claude drafts a fix proposal and escalates it to the Replit Agent via
 * .local/alden-escalations.md. Also surfaces a DB notification so David
 * can see the issue was routed correctly.
 * Only fires once per pattern; clears after posting.
 */
async function checkAndPostRepairProposal(client: Anthropic, messages: string[]): Promise<void> {
  const response = await client.messages.create({
    model: 'claude-sonnet-4-5',
    max_tokens: 400,
    messages: [{
      role: 'user',
      content: `These are the last ${messages.length} watch-cycle alerts from the HoloHola system monitor:\n\n${messages.map((m, i) => `Alert ${i + 1}: ${m}`).join('\n\n')}\n\nDo these alerts share a recurring root cause? If yes, write a concise diagnosis (2-4 sentences) for the Replit Agent that:\n1. Identifies the root cause pattern\n2. Explains why it cannot be auto-repaired\n3. Recommends a concrete action the Agent should take\nDo NOT address it to Wren. Write it as a clear briefing the Agent will read at session start.\nIf they are unrelated one-off events, respond with exactly: UNRELATED`,
    }],
  });

  if (response.usage) {
    costTracker.track('claude-sonnet-4-5', response.usage.input_tokens, response.usage.output_tokens, 'alden-repair-proposal');
  }

  const proposal = (response.content[0] as any)?.text?.trim() || 'UNRELATED';
  if (proposal === 'UNRELATED' || proposal.startsWith('UNRELATED')) {
    console.log('[AldenWatch] Repair proposal check: alerts are unrelated — no proposal needed');
    return;
  }

  console.log('[AldenWatch] Recurring pattern detected — escalating to Replit Agent');

  // Write to the escalation log so the Agent sees it at session start
  const issueSummary = messages[messages.length - 1] ?? messages[0];
  await writeEscalation(issueSummary, proposal, 'recurring_pattern');

  try {
    const dbR = getUserDb();
    await dbR.insert(aldenNotifications).values({
      content: `[Escalated → Replit Agent] The last ${messages.length} watch cycles flagged the same issue. Auto-repair could not fix it. The Replit Agent has been notified via .local/alden-escalations.md and will address it at next session.\n\nSummary: ${proposal}`,
      triggeredBy: 'alden-watch',
      severity: 'alert',
      read: false,
    });
    // Clear the buffer so we don't fire the same proposal repeatedly
    recentAlertMessages.length = 0;
    console.log('[AldenWatch] Escalation written and buffer cleared');
  } catch (e: any) {
    console.warn('[AldenWatch] Could not queue escalation notification:', e.message);
  }
}

// ── Hard-pause recovery poller ───────────────────────────────────────────────
// Runs on a configurable interval (spend-only, no LLM call) while hard-pause is active.
// Set ALDEN_RECOVERY_POLL_MIN env var to change the cadence without a code deploy.
// As soon as 24h spend drops below BUDGET_HARD_PAUSE_USD it lifts the pause,
// logs the recovery, and posts a Hive message so David knows cycles are back.
const RECOVERY_POLL_MIN = Math.max(1, parseInt(process.env.ALDEN_RECOVERY_POLL_MIN ?? '10', 10) || 10);
const RECOVERY_POLL_INTERVAL_MS = RECOVERY_POLL_MIN * 60 * 1000;

async function runHardPauseRecoveryCheck(): Promise<void> {
  if (!hardPauseActive) return;

  try {
    // DB-backed so recovery is accurate even after a restart
    const { spend } = await getDb24hSpend();
    if (spend < BUDGET_HARD_PAUSE_USD) {
      hardPauseActive = false;
      const msg = `Budget recovered — 24h AI spend is now $${spend.toFixed(2)}, below the $${BUDGET_HARD_PAUSE_USD} hard limit. Watch cycles are resuming.`;
      console.log('[AldenWatch]', msg);
      await postHiveMessage(msg, { tier: 'hard_pause_lifted', spendUsd: spend });
      // Immediately kick off a full watch cycle so there is no gap
      runWatchCycle().catch(err =>
        console.warn('[AldenWatch] Post-recovery watch cycle failed:', err.message)
      );
    }
  } catch (err: any) {
    console.warn('[AldenWatch] Recovery poll failed:', err.message);
  }
}

/**
 * Recursive setTimeout loop so interval changes from alden_watch_config take effect
 * at the next cycle without a restart.
 */
async function scheduleNextCycle(): Promise<void> {
  try {
    const params = await getWatchParams();
    setTimeout(() => {
      runWatchCycle().catch(err =>
        console.warn('[AldenWatch] Cycle failed:', err.message)
      ).finally(() => scheduleNextCycle());
    }, params.checkIntervalMs);
  } catch {
    // Fallback to default interval if DB read fails
    setTimeout(() => {
      runWatchCycle().catch(err =>
        console.warn('[AldenWatch] Cycle failed:', err.message)
      ).finally(() => scheduleNextCycle());
    }, CHECK_INTERVAL_MS);
  }
}

export function startAldenWatchWorker() {
  console.log(`[AldenWatch] Starting (interval: 2h, recovery poll: ${RECOVERY_POLL_MIN}min [ALDEN_RECOVERY_POLL_MIN], per-issue-type dedup via fingerprint)`);

  // ── Startup watchdog: check the previous cycle's heartbeat ──────────────
  // If the last cycle was 'failed' or the heartbeat is stale (>4h old),
  // log a warning so it surfaces in session-start logs. This catches the case
  // where AldenWatch was silently broken across a server restart.
  try {
    const raw = fs.readFileSync(HEARTBEAT_FILE, 'utf8');
    const hb = JSON.parse(raw) as { status: string; updatedAt: number; error?: string };
    const staleMins = Math.round((Date.now() - hb.updatedAt) / 60000);
    if (hb.status === 'failed') {
      console.warn(`[AldenWatch] Previous cycle ended in failure (${staleMins}m ago): ${hb.error ?? 'unknown'}`);
    } else if (Date.now() - hb.updatedAt > 4 * 60 * 60 * 1000) {
      console.warn(`[AldenWatch] Heartbeat is stale — last successful cycle was ${staleMins}m ago`);
    } else {
      console.log(`[AldenWatch] Last cycle: ${hb.status} (${staleMins}m ago)`);
    }
  } catch { /* no heartbeat file = first run, that's fine */ }

  // Initial check after 5 minutes (let the server settle), then self-scheduling
  setTimeout(() => {
    runWatchCycle()
      .catch(err => console.warn('[AldenWatch] First cycle failed:', err.message))
      .finally(() => scheduleNextCycle());
  }, 5 * 60 * 1000);

  // Lightweight recovery poller — fires every 10 min, no-ops unless hard-paused
  setInterval(runHardPauseRecoveryCheck, RECOVERY_POLL_INTERVAL_MS);
}

/**
 * Returns live status data for the /api/admin/alden-status endpoint.
 * Uses ai_cost_logs (DB-backed) for the 24h spend so the figure survives restarts.
 * Falls back to in-memory costTracker if the DB query fails.
 */
export async function getAldenStatus() {
  const { spend, source: spendSource } = await getDb24hSpend();

  // Use the same effective thresholds that runWatchCycle() uses — live vars when
  // alden_watch_config is populated, compile-time constants otherwise.
  let activeTier: 'nominal' | 'warn' | 'alert' | 'hard_pause';
  if (spend >= BUDGET_HARD_PAUSE_USD) {
    activeTier = 'hard_pause';
  } else if (spend >= liveAlertUsd) {
    activeTier = 'alert';
  } else if (spend >= liveWarnUsd) {
    activeTier = 'warn';
  } else {
    activeTier = 'nominal';
  }

  return {
    spend24hUsd: spend,
    spendSource,
    thresholds: {
      warn:              liveWarnUsd,
      alert:             liveAlertUsd,
      hard_pause:        BUDGET_HARD_PAUSE_USD,   // always hardcoded — circuit-breaker
      staticWarn:        BUDGET_WARN_USD,
      staticAlert:       BUDGET_ALERT_USD,
    },
    activeTier,
    hardPauseActive,
    consecutiveLowScoreCycles,
    liveHealthThreshold,
    liveConsecutiveTrigger,
    lastWatchCycleTime,
    lastNotificationFingerprints: lastNotificationFingerprints.slice(-5),
    recoveryPollIntervalMs: RECOVERY_POLL_INTERVAL_MS,
  };
}
