/**
 * The Alden inbox wake worker (design eb2ed6bf r11, build step W2b). Every
 * 60 seconds on a production instance: set the cutoff on the first pass,
 * reconcile, deliver notices, then claim and answer eligible items one at a
 * time until none is claimable. Each turn runs on the wake engine (Gemini
 * Flash unless ALDEN_WAKE_ENGINE=sonnet) under the wake tool profile, with
 * cost logged as alden-wake. ALDEN_INBOX_WAKE=off is the second emergency
 * stop; the control row is the first.
 */
import { hostname } from 'node:os';
import { sql } from 'drizzle-orm';
import { getSharedDb } from '../db';
import { ALDEN_BACKGROUND_MODEL } from './alden-background-model';
import { wakeAllowlist } from './alden-tool-profiles';
import {
  activateWake, claimNextWakeItem, deliverWakeNotices, reconcileWake, recordWakeOutcome, releaseWakeForFollowUp,
  type AldenWakeTurn, type WakeAttempt, WAKE_COST_CONTEXT,
} from './alden-wake-ledger';
import { annotateUnpublishedNotes, buildFollowUpNote, buildTriggerText, buildWakeMessage, decideWakeOutcome, WAKE_MAX_ROUNDS, wakeEngineConfig } from './alden-wake-rules';

export const WAKE_INTERVAL_MS = 60_000;

type Generate = (params: Record<string, any>) => Promise<{ response: string; toolsUsed: string[]; error?: string; roundLimitReached?: boolean }>;

export interface WakeDeps {
  db?: any;
  generate?: Generate;
  workerId?: string;
  env?: NodeJS.ProcessEnv;
}

const defaultWorkerId = () => `alden-wake:${hostname()}:${process.pid}`;

async function defaultGenerate(params: Record<string, any>) {
  const { generateAldenResponse } = await import('./alden-persona-service');
  return generateAldenResponse(params as any);
}

/** Runs one claimed item's turn and records its outcome unless the reply already did. */
export async function runWakeTurn(attempt: WakeAttempt, deps: WakeDeps = {}): Promise<string> {
  const db = deps.db ?? getSharedDb();
  const workerId = deps.workerId ?? defaultWorkerId();
  const generate = deps.generate ?? defaultGenerate;
  const [event] = ((await db.execute(sql`
    select e.id, e.actor, e.created_at, e.content, t.title, a.notes from alden_wake_attempts a
    join coordination_events e on e.id = a.event_id
    join coordination_threads t on t.id = e.thread_id
    where a.item_id = ${attempt.itemId}`)) as any).rows;
  const turn: AldenWakeTurn = {
    itemId: attempt.itemId, workerId, claimEpoch: attempt.claimEpoch,
    threadId: attempt.targetThreadId, targetSender: attempt.targetSender, itemKind: attempt.itemKind,
  };
  let response: Awaited<ReturnType<Generate>> | null = null;
  let thrown: string | null = null;
  try {
    const { engine, model } = wakeEngineConfig((deps.env ?? process.env).ALDEN_WAKE_ENGINE, ALDEN_BACKGROUND_MODEL);
    response = await generate({
      userMessage: buildWakeMessage({
        eventId: event.id, threadId: attempt.targetThreadId, title: event.title, actor: event.actor,
        createdAt: new Date(event.created_at).toISOString(),
      // The trusted follow-up note comes before the quoted trigger text, so a
      // crafted message cannot pose as it (LR, #167 review).
      }) + (attempt.claimEpoch > 1 && event.notes ? buildFollowUpNote(event.notes) : '')
        + buildTriggerText({ eventId: event.id, actor: event.actor, content: event.content }),
      maxRounds: WAKE_MAX_ROUNDS,
      founderName: 'David',
      engineOverride: engine,
      modelOverride: model,
      toolAllowlist: wakeAllowlist(attempt.targetThreadId),
      wakeTurn: turn,
      costContext: WAKE_COST_CONTEXT,
    });
  } catch (err) {
    thrown = String((err as Error)?.message ?? err);
  }
  if (turn.published) return `published:${(turn.published as any).status}`;
  const decision = decideWakeOutcome(turn, thrown ? { error: thrown } : response);
  if (!decision) return 'published';
  if (decision.outcome === 'follow_up') {
    const released = await releaseWakeForFollowUp({
      itemId: attempt.itemId, workerId, claimEpoch: attempt.claimEpoch,
      notes: annotateUnpublishedNotes(response?.response ?? ''), toolsUsed: response?.toolsUsed ?? [],
    }, db);
    return `follow_up:${released}`;
  }
  const recorded = await recordWakeOutcome({
    itemId: attempt.itemId, workerId, claimEpoch: attempt.claimEpoch,
    outcome: decision.outcome, errorClass: decision.errorClass,
    notes: annotateUnpublishedNotes((thrown ?? response?.error ?? response?.response ?? '').slice(0, 1800)),
    toolsUsed: response?.toolsUsed ?? [],
  }, db);
  return `${decision.outcome}:${recorded}`;
}

/** One wake pass. Returns what it did, for logs and tests. */
export async function runWakePass(deps: WakeDeps = {}): Promise<{ skipped?: string; turns: string[]; stop?: string }> {
  const env = deps.env ?? process.env;
  if ((env.ALDEN_INBOX_WAKE ?? '').trim().toLowerCase() === 'off') return { skipped: 'ALDEN_INBOX_WAKE=off', turns: [] };
  const db = deps.db ?? getSharedDb();
  const workerId = deps.workerId ?? defaultWorkerId();
  await activateWake(db);
  await reconcileWake(db);
  await deliverWakeNotices(db);
  const turns: string[] = [];
  let stop: string;
  for (;;) {
    const claim = await claimNextWakeItem(workerId, {}, db);
    if (claim.status !== 'claimed') { stop = claim.status; break; }
    turns.push(await runWakeTurn(claim.attempt, { ...deps, db, workerId }));
  }
  await deliverWakeNotices(db);
  return { turns, stop };
}

let started = false;

/** Starts the 60 s pass loop. Registered as the production-only 'alden-wake' background task. */
export function startAldenWakeWorker(): void {
  if (started) return;
  started = true;
  const tick = async () => {
    try {
      const result = await runWakePass();
      if (result.turns.length) console.log(`[Alden Wake] ${result.turns.length} turn(s): ${result.turns.join(', ')} (stopped: ${result.stop})`);
      else if (result.stop === 'spending' || result.stop === 'stopped') console.log(`[Alden Wake] pass held: ${result.stop}`);
    } catch (err) {
      console.error('[Alden Wake] pass failed:', (err as Error)?.message ?? err);
    } finally {
      setTimeout(tick, WAKE_INTERVAL_MS);
    }
  };
  setTimeout(tick, WAKE_INTERVAL_MS);
}
