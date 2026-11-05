import type { StreamingClientState } from '../../../shared/streaming-voice-types';

/**
 * Where an opt-in webcam / screen share stands for a given voice connection state.
 *
 * - live:   a session is up, so frames may flow. This includes 'processing' (the student just
 *           finished speaking) and 'streaming' (Daniela is speaking). Every normal turn passes
 *           through both, so treating them as disconnected switched vision off after one turn.
 * - paused: the connection is being (re)established. Keep the camera and screen streams so
 *           sharing resumes on its own after a reconnect, but send nothing.
 * - ended:  the session is over or failed. Release the camera and screen.
 */
export type VisionSessionPhase = 'live' | 'paused' | 'ended';

export function visionSessionPhase(state: StreamingClientState): VisionSessionPhase {
  switch (state) {
    case 'connected':
    case 'ready':
    case 'processing':
    case 'streaming':
      return 'live';
    case 'connecting':
    case 'reconnecting':
      return 'paused';
    default:
      return 'ended';
  }
}

export function canSendVideoFrame(state: StreamingClientState, socketConnected: boolean): boolean {
  return socketConnected && visionSessionPhase(state) === 'live';
}
