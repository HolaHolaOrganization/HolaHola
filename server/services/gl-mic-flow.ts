/**
 * Where a student's voice stops, for the hats' observer. In live test 2 David spoke to Daniela for
 * minutes and nothing was transcribed, and no record could say whether the audio never reached the
 * server, was dropped at a gate, or reached Gemini unheard. This counts each outcome. Counts and
 * loudness only: no audio is kept.
 */

const REPORT_EVERY_MS = 30_000;

/** About -30 dBFS, in PCM16 units: above room noise on a typical mic, below normal speech. */
const LOUD_PEAK = 1_000;

export type MicChunkOutcome = 'forwarded' | 'droppedTutorAudio' | 'droppedGreeting' | 'droppedNoSession';

export interface MicFlowReport {
  windowMs: number;
  forwarded: number;
  droppedTutorAudio: number;
  droppedGreeting: number;
  droppedNoSession: number;
  /** Chunks with speech-level audio that went to Gemini, and that were dropped before it. */
  loudForwarded: number;
  loudDropped: number;
  /** Text chunks Gemini sent back as what it heard. */
  inputTranscriptChunks: number;
}

/** Highest absolute sample in a little-endian PCM16 buffer. */
export function pcm16Peak(pcm: Buffer): number {
  let peak = 0;
  for (let i = 0; i + 1 < pcm.length; i += 2) {
    const sample = Math.abs(pcm.readInt16LE(i));
    if (sample > peak) peak = sample;
  }
  return peak;
}

export class MicFlow {
  private windowStart: number | null = null;
  private counts = this.empty();

  private empty(): Omit<MicFlowReport, 'windowMs'> {
    return {
      forwarded: 0,
      droppedTutorAudio: 0,
      droppedGreeting: 0,
      droppedNoSession: 0,
      loudForwarded: 0,
      loudDropped: 0,
      inputTranscriptChunks: 0,
    };
  }

  /** Records one chunk. Returns a report when one is due, and starts a new window. */
  noteChunk(outcome: MicChunkOutcome, peak: number, now: number): MicFlowReport | null {
    this.counts[outcome]++;
    if (peak >= LOUD_PEAK) {
      if (outcome === 'forwarded') this.counts.loudForwarded++;
      else this.counts.loudDropped++;
    }
    return this.reportIfDue(now);
  }

  noteInputTranscript(now: number): void {
    this.counts.inputTranscriptChunks++;
    this.windowStart ??= now;
  }

  private reportIfDue(now: number): MicFlowReport | null {
    this.windowStart ??= now;
    const windowMs = now - this.windowStart;
    if (windowMs < REPORT_EVERY_MS) return null;
    const report = { windowMs, ...this.counts };
    this.counts = this.empty();
    this.windowStart = now;
    return report;
  }
}
