/**
 * Browser harness for the voice client (phase 1 of the shared browser test lane).
 * Composes the same pieces StreamingVoiceChat does — useStreamingVoice, the vision
 * phase and useVisionCapture — and exposes a small control surface on window for
 * Playwright. A mock voice server stands in for the real one; no secrets, no Gemini.
 */
import { createRoot } from 'react-dom/client';
import { useStreamingVoice } from '@/hooks/useStreamingVoice';
import { useVisionCapture } from '@/hooks/useVisionCapture';
import { visionSessionPhase } from '@/lib/vision-session-state';

/** Every connection state the UI rendered, so a brief one can't slip past a test's polling. */
const stateHistory: string[] = [];

function Harness() {
  const voice = useStreamingVoice();
  const phase = visionSessionPhase(voice.state.connectionState);
  if (stateHistory.at(-1) !== voice.state.connectionState) stateHistory.push(voice.state.connectionState);
  // Exactly the composition in StreamingVoiceChat (guarded there by vision-session-state.test.ts).
  const vision = useVisionCapture(voice.sendVideoFrame, phase !== 'ended');

  (window as any).harness = {
    connect: () => voice.connect({
      conversationId: 'e2e-conversation',
      targetLanguage: 'spanish',
      nativeLanguage: 'english',
      difficultyLevel: 'beginner',
      subtitleMode: 'off',
    }),
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
