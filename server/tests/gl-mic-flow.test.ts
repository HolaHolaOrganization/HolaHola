/**
 * Live test 2: David spoke for minutes with nothing transcribed, and no record could say where his
 * voice stopped. These drive the real session's mic path.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { MicFlow, pcm16Peak } from '../services/gl-mic-flow';

// The session module starts housekeeping timers and requires these to load. Nothing connects.
const realSetInterval = globalThis.setInterval;
globalThis.setInterval = ((...args: Parameters<typeof setInterval>) => realSetInterval(...args).unref()) as typeof setInterval;
process.env.NEON_SHARED_DATABASE_URL ??= 'postgresql://unit-test:unit-test@127.0.0.1:1/unit_test_no_db';
process.env.DEEPGRAM_API_KEY ||= 'unit-test-dummy-deepgram-key';
const { GeminiLiveSession } = await import('../services/gemini-live-session');
const { voiceTelemetry } = await import('../services/voice-pipeline-telemetry');

const pcm = (sample: number) => {
  const buffer = Buffer.alloc(8);
  for (let i = 0; i < 4; i++) buffer.writeInt16LE(sample, i * 2);
  return buffer;
};

describe('pcm16Peak', () => {
  it('reads the highest absolute sample', () => {
    assert.equal(pcm16Peak(pcm(0)), 0);
    assert.equal(pcm16Peak(pcm(-1234)), 1234);
    assert.equal(pcm16Peak(Buffer.alloc(0)), 0);
  });
});

describe('MicFlow', () => {
  it('reports each outcome once per window, then starts again', () => {
    const flow = new MicFlow();
    assert.equal(flow.noteChunk('forwarded', 5_000, 0), null);
    assert.equal(flow.noteChunk('droppedTutorAudio', 5_000, 1_000), null);
    assert.equal(flow.noteChunk('droppedGreeting', 0, 2_000), null);
    flow.noteInputTranscript(3_000);
    assert.deepEqual(flow.noteChunk('forwarded', 0, 30_000), {
      windowMs: 30_000,
      forwarded: 2,
      droppedTutorAudio: 1,
      droppedGreeting: 1,
      droppedNoSession: 0,
      loudForwarded: 1,
      loudDropped: 1,
      inputTranscriptChunks: 1,
    });
    assert.equal(flow.noteChunk('forwarded', 0, 30_100), null, 'a new window has started');
  });

  it('tells a silent mic from a loud one', () => {
    const flow = new MicFlow();
    flow.noteChunk('forwarded', 999, 0);
    const report = flow.noteChunk('forwarded', 1_000, 30_000)!;
    assert.equal(report.forwarded, 2);
    assert.equal(report.loudForwarded, 1);
  });
});

describe('real session mic path', () => {
  const makeSession = () => {
    const gl: any = new GeminiLiveSession({ id: 's', userId: 'u', conversationId: 'c', ws: {}, currentTurnId: 0 } as any, () => {});
    gl.sent = 0;
    gl.liveSession = { sendRealtimeInput: () => { gl.sent++; } };
    return gl;
  };
  const collectReports = () => {
    const reports: any[] = [];
    const original = voiceTelemetry.log;
    (voiceTelemetry as any).log = (_session: string, _user: string, type: string, data: unknown) => { if (type === 'gl_mic_flow') reports.push(data); };
    return { reports, restore: () => { (voiceTelemetry as any).log = original; } };
  };

  it('counts what the gates do, without changing what they do', (t) => {
    const { reports, restore } = collectReports();
    t.after(restore);
    t.mock.timers.enable({ apis: ['Date'] });
    const gl = makeSession();

    gl.sendAudioChunk(pcm(5_000));
    assert.equal(gl.sent, 1, 'forwarded');

    gl.isTutorGeneratingAudio = true;
    gl.sendAudioChunk(pcm(5_000));
    assert.equal(gl.sent, 1, 'the tutor-audio gate still drops');
    gl.isTutorGeneratingAudio = false;

    gl.greetingPhaseActive = true;
    gl.sendAudioChunk(pcm(0));
    assert.equal(gl.sent, 1, 'the greeting gate still drops');
    gl.greetingPhaseActive = false;

    t.mock.timers.tick(30_000);
    gl.sendAudioChunk(pcm(0));
    assert.equal(reports.length, 1);
    assert.equal(reports[0].forwarded, 2);
    assert.equal(reports[0].droppedTutorAudio, 1);
    assert.equal(reports[0].droppedGreeting, 1);
    assert.equal(reports[0].loudForwarded, 1);
    assert.equal(reports[0].loudDropped, 1);
  });

  it('counts chunks with no live connection', (t) => {
    const { reports, restore } = collectReports();
    t.after(restore);
    t.mock.timers.enable({ apis: ['Date'] });
    const gl = makeSession();
    gl.liveSession = null;
    gl.sendAudioChunk(pcm(5_000));
    t.mock.timers.tick(30_000);
    gl.sendAudioChunk(pcm(5_000));
    assert.equal(reports[0].droppedNoSession, 2);
    assert.equal(reports[0].loudDropped, 2);
  });
});
