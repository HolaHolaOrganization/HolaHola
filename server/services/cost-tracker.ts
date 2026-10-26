/**
 * Cost Tracker
 *
 * Tracks approximate AI token costs across all LLM providers.
 * Maintains a rolling in-memory window and provides summary methods
 * for Lyra's reporting cycle.
 *
 * DB persistence is wired in via `setCostPersister()` called from
 * server startup to avoid circular imports.
 */

interface ModelPricing {
  inputPerMillion: number;
  outputPerMillion: number;
  label: string;
}

const PRICING: Record<string, ModelPricing> = {
  // Gemini
  'gemini-3-flash-preview':           { inputPerMillion: 0.50,  outputPerMillion: 3.00,  label: 'Gemini 3 Flash'        }, // ai.google.dev/gemini-api/docs/gemini-3 (2026-10-25)
  'gemini-2.5-flash':                 { inputPerMillion: 0.30,  outputPerMillion: 2.50,  label: 'Gemini 2.5 Flash'      },
  'gemini-2.5-pro':                   { inputPerMillion: 3.50,  outputPerMillion: 10.50, label: 'Gemini Pro'            },
  'gemini-2.0-flash':                 { inputPerMillion: 0.10,  outputPerMillion: 0.40,  label: 'Gemini 2 Flash'        },
  // Gemini Live (real-time voice) — audio tokens included in usageMetadata counts
  'gemini-3.1-flash-live-preview':              { inputPerMillion: 0.10,  outputPerMillion: 0.40,  label: 'Gemini Live 3.1'       },
  'gemini-2.5-flash-native-audio-preview-12-2025': { inputPerMillion: 0.10, outputPerMillion: 0.40, label: 'Gemini Live 3.5 (Native Audio)' },
  'gemini-2.0-flash-live-001':                  { inputPerMillion: 0.10,  outputPerMillion: 0.40,  label: 'Gemini 2 Flash Live'   },
  // Vision frames sent via GL sendRealtimeInput({ video }) — estimated at ~2,000 tokens/frame
  // (640×480 webcam ≈ 1,548 tokens; 1280×720 screen ≈ 3,870 tokens; 2,000 is a conservative midpoint)
  // These tokens ARE included in the GL session's usageMetadata, so this line shows the vision
  // portion of the GL input cost for visibility — not an additional charge.
  'gemini-live-vision':                         { inputPerMillion: 0.10,  outputPerMillion: 0.00,  label: 'Gemini Live Vision (est.)' },
  // Claude Haiku
  'claude-3-haiku-20240307':      { inputPerMillion: 0.25,  outputPerMillion: 1.25,  label: 'Claude Haiku'       },
  'claude-3-5-haiku-20241022':    { inputPerMillion: 0.80,  outputPerMillion: 4.00,  label: 'Claude Haiku 3.5'   },
  // Claude Fable (Mythos-class, released June 9 2026)
  'claude-fable-5':               { inputPerMillion: 10.00, outputPerMillion: 50.00, label: 'Claude Fable 5'     },
  // Claude Sonnet 5.5: $2 / $10 per MTok (Alden's background workers)
  'claude-sonnet-5-5':            { inputPerMillion: 2.00,  outputPerMillion: 10.00, label: 'Claude Sonnet 5.5'  },
  // Claude Sonnet (all versions map to same pricing tier)
  'claude-sonnet-4-5':            { inputPerMillion: 3.00,  outputPerMillion: 15.00, label: 'Claude Sonnet 4.5'  },
  'claude-sonnet-4-20250514':     { inputPerMillion: 3.00,  outputPerMillion: 15.00, label: 'Claude Sonnet 4'    },
  'claude-3-5-sonnet-20241022':   { inputPerMillion: 3.00,  outputPerMillion: 15.00, label: 'Claude Sonnet 3.5'  },
  'claude-3-sonnet-20240229':     { inputPerMillion: 3.00,  outputPerMillion: 15.00, label: 'Claude Sonnet 3'    },
  // Claude Opus
  'claude-opus-5-5':              { inputPerMillion: 4.00,  outputPerMillion: 20.00, label: 'Claude Opus 5.5'    },
  'claude-opus-4-6':              { inputPerMillion: 15.00, outputPerMillion: 75.00, label: 'Claude Opus 4.6'    },
  'claude-3-opus-20240229':       { inputPerMillion: 15.00, outputPerMillion: 75.00, label: 'Claude Opus 3'      },
  // OpenAI
  'gpt-4o':                       { inputPerMillion: 2.50,  outputPerMillion: 10.00, label: 'GPT-4o'             },
  'gpt-4o-mini':                  { inputPerMillion: 0.15,  outputPerMillion: 0.60,  label: 'GPT-4o Mini'        },
  'gpt-4':                        { inputPerMillion: 30.00, outputPerMillion: 60.00, label: 'GPT-4'              },
};

interface CostEntry {
  timestamp: number;
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  context?: string;
}

export interface CostSummary {
  windowHours: number;
  totalCostUsd: number;
  callCount: number;
  byModel: Record<string, { calls: number; inputTokens: number; outputTokens: number; costUsd: number }>;
  mostExpensiveModel: string | null;
  avgCostPerCall: number;
}

const MAX_ENTRIES = 10_000;

// Optional DB persister — set by server startup to avoid circular imports.
type DbPersister = (entry: CostEntry) => Promise<void>;
let dbPersister: DbPersister | null = null;

export function setCostPersister(fn: DbPersister): void {
  dbPersister = fn;
}

class CostTracker {
  private entries: CostEntry[] = [];
  private devAutoResolvedCount = 0;

  track(model: string, inputTokens: number, outputTokens: number, context?: string): number {
    const pricing = PRICING[model];
    if (!pricing) {
      console.warn(`[CostTracker] Unknown model "${model}" — cost will be $0. Add it to PRICING.`);
    }
    const costUsd = pricing
      ? (inputTokens / 1_000_000) * pricing.inputPerMillion +
        (outputTokens / 1_000_000) * pricing.outputPerMillion
      : 0;

    const entry: CostEntry = { timestamp: Date.now(), model, inputTokens, outputTokens, costUsd, context };
    this.entries.push(entry);
    if (this.entries.length > MAX_ENTRIES) this.entries = this.entries.slice(-MAX_ENTRIES);

    // Persist to DB (fire-and-forget — never block a response on this)
    if (dbPersister) {
      dbPersister(entry).catch(err =>
        console.warn('[CostTracker] DB persist failed:', err?.message || err)
      );
    }

    return costUsd;
  }

  /**
   * Track a raw cost that isn't token-based (TTS characters, STT seconds, etc.).
   * inputUnits and outputUnits are stored as-is for reporting — not used for cost calculation.
   * costUsd is the pre-computed dollar amount.
   */
  trackRaw(model: string, costUsd: number, context?: string, inputUnits = 0, outputUnits = 0): void {
    const entry: CostEntry = { timestamp: Date.now(), model, inputTokens: inputUnits, outputTokens: outputUnits, costUsd, context };
    this.entries.push(entry);
    if (this.entries.length > MAX_ENTRIES) this.entries = this.entries.slice(-MAX_ENTRIES);
    if (dbPersister) {
      dbPersister(entry).catch(err =>
        console.warn('[CostTracker] DB persist failed (raw):', err?.message || err)
      );
    }
  }

  incrementDevAutoResolved() {
    this.devAutoResolvedCount++;
  }

  getDevAutoResolvedCount(): number {
    return this.devAutoResolvedCount;
  }

  resetDevAutoResolvedCount() {
    this.devAutoResolvedCount = 0;
  }

  private getWindow(hours: number): CostEntry[] {
    const cutoff = Date.now() - hours * 60 * 60 * 1000;
    return this.entries.filter(e => e.timestamp >= cutoff);
  }

  getSummary(hours = 24): CostSummary {
    const window = this.getWindow(hours);
    const byModel: Record<string, { calls: number; inputTokens: number; outputTokens: number; costUsd: number }> = {};
    let totalCostUsd = 0;

    for (const e of window) {
      totalCostUsd += e.costUsd;
      if (!byModel[e.model]) byModel[e.model] = { calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 };
      byModel[e.model].calls++;
      byModel[e.model].inputTokens += e.inputTokens;
      byModel[e.model].outputTokens += e.outputTokens;
      byModel[e.model].costUsd += e.costUsd;
    }

    const mostExpensiveModel = Object.entries(byModel)
      .sort((a, b) => b[1].costUsd - a[1].costUsd)[0]?.[0] || null;

    return {
      windowHours: hours,
      totalCostUsd,
      callCount: window.length,
      byModel,
      mostExpensiveModel,
      avgCostPerCall: window.length > 0 ? totalCostUsd / window.length : 0,
    };
  }

  checkBudgetThreshold(thresholdUsd: number, hours = 24): { exceeded: boolean; totalCostUsd: number; thresholdUsd: number } {
    const s = this.getSummary(hours);
    return { exceeded: s.totalCostUsd >= thresholdUsd, totalCostUsd: s.totalCostUsd, thresholdUsd };
  }

  formatForReport(hours = 12): string {
    const s = this.getSummary(hours);
    if (s.callCount === 0) return `No AI calls tracked in the last ${hours}h.`;

    const modelLines = Object.entries(s.byModel)
      .sort((a, b) => b[1].costUsd - a[1].costUsd)
      .map(([model, stats]) => {
        const label = PRICING[model]?.label || model;
        const tokensIn  = (stats.inputTokens  / 1000).toFixed(1);
        const tokensOut = (stats.outputTokens / 1000).toFixed(1);
        return `  ${label}: ${stats.calls} call(s), ${tokensIn}k in / ${tokensOut}k out → ~$${stats.costUsd.toFixed(4)}`;
      });

    const perCallLine = s.avgCostPerCall > 0 ? ` | avg $${s.avgCostPerCall.toFixed(5)}/call` : '';
    const devNote = this.devAutoResolvedCount > 0
      ? `\n  Dev runtime faults auto-resolved this window: ${this.devAutoResolvedCount}`
      : '';

    return [
      `**AI Cost Report (last ${hours}h):** ~$${s.totalCostUsd.toFixed(4)} across ${s.callCount} call(s)${perCallLine}`,
      ...modelLines,
      devNote,
    ].filter(Boolean).join('\n');
  }
}

export const costTracker = new CostTracker();
