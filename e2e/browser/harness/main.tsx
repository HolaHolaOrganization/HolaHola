/**
 * Browser harness for the voice client (phase 1 of the shared browser test lane).
 * Composes the same pieces StreamingVoiceChat does — useStreamingVoice, the vision
 * phase and useVisionCapture — and exposes a small control surface on window for
 * Playwright. A mock voice server stands in for the real one; no secrets, no Gemini.
 */
import { createRoot } from 'react-dom/client';
import { useStreamingVoice } from '@/hooks/useStreamingVoice';
import { useVisionCapture } from '@/hooks/useVisionCapture';
import { getStreamingVoiceClient } from '@/lib/streamingVoiceClient';
import { visionSessionPhase } from '@/lib/vision-session-state';

/**
 * Every state the client announced, as its listeners heard them. Taken from the client, not
 * from renders, because React batches away a state that lasts only a moment.
 */
const stateHistory: string[] = [];
getStreamingVoiceClient().on('stateChange', (state: unknown) => { stateHistory.push(String(state)); });

function Harness() {
  const voice = useStreamingVoice();
  const phase = visionSessionPhase(voice.state.connectionState);
  // Exactly the composition in StreamingVoiceChat (guarded there by vision-session-state.test.ts).
  const vision = useVisionCapture(voice.sendVideoFrame, phase !== 'ended');

  (window as any).harness = {
    connect: (conversationId = 'e2e-conversation') => voice.connect({
      conversationId,
      targetLanguage: 'spanish',
      nativeLanguage: 'english',
      difficultyLevel: 'beginner',
      subtitleMode: 'off',
    }),
    disconnect: () => voice.disconnect(),
    warmUp: (conversationId: string) => getStreamingVoiceClient().warmUp(conversationId),
    setInputMode: (mode: 'push-to-talk' | 'open-mic') => getStreamingVoiceClient().setInputMode(mode),
    micChunk: (sequenceId: number) => getStreamingVoiceClient().sendStreamingChunk(new ArrayBuffer(8), sequenceId),
    forceState: (state: string) => (getStreamingVoiceClient() as any).setState(state),
    toggleWebcam: () => vision.toggleWebcam(),
    state: () => voice.state.connectionState,
    stateHistory: () => [...stateHistory],
    webcamActive: () => vision.webcamActive,
  };

  return (
    <div>
      <div id="connection-state">{voice.state.connectionState}</div>
      <div id="vision-phase">{phase}</div>
      <div id="webcam-active">{String(vision.webcamActive)}</div>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<Harness />);
