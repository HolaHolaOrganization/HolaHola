/**
 * Browser harness for the voice client (phase 1 of the shared browser test lane).
 * Composes the same pieces StreamingVoiceChat does — useStreamingVoice, the vision
 * phase and useVisionCapture — and exposes a small control surface on window for
 * Playwright. A mock voice server stands in for the real one; no secrets, no Gemini.
 */
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import '@/index.css';
import { SceneCanvas } from '@/components/SceneCanvas';
import { ComparisonItemDisplay, VocabCardItemDisplay } from '@/components/Whiteboard';
import { usePreloadImages, useResilientImageSrc } from '@/hooks/useResilientImageSrc';
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

/** The avatar's image behaviour, on images a test controls. */
function AvatarProbe() {
  const [{ src, scope }, setImage] = useState({ src: '/e2e-image/listening.png', scope: 'tutor-a' });
  const image = useResilientImageSrc(src, scope);
  usePreloadImages(['/e2e-image/talking.png']);
  (window as any).avatar = {
    setSrc: (next: string) => setImage(current => ({ ...current, src: next })),
    setTutor: (nextScope: string, next: string) => setImage({ src: next, scope: nextScope }),
  };
  return <img id="avatar" key={image.key} src={image.src} onLoad={image.onLoad} onError={image.onError} alt="avatar" />;
}

/** The two panes David saw poorly sized, at their real widths. */
function Panes() {
  return (
    <>
      <div id="studio-pane" style={{ width: 280 }}>
        <SceneCanvas data={{ environment: '', props: [], emotionData: { emotion: 'excited' } } as any} />
      </div>
      <div id="whiteboard-pane" style={{ width: 280 }}>
        <VocabCardItemDisplay index={0} item={{ type: 'vocab_card', content: 'gato', data: { word: 'gato', definition: 'cat', imageUrl: '/e2e-image/gato.png' } } as any} />
        <ComparisonItemDisplay index={0} item={{ type: 'comparison', content: 'ser vs estar', data: { concept_a: 'ser', concept_b: 'estar' } } as any} />
      </div>
    </>
  );
}

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
      <AvatarProbe />
      <Panes />
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<Harness />);
