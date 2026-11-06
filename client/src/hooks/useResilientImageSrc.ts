import { useEffect, useRef, useState, type SyntheticEvent } from 'react';

const RETRY_MS = 5000;

/**
 * Keeps an <img> showing something when its image can't load, as when the avatar changes state
 * during a network outage. A failed <img> never retries by itself and shows the broken-image
 * icon, so this shows the last image that loaded, retries in the background (on an interval and
 * when the network returns), and switches once the requested image really is available.
 */
export function useResilientImageSrc(src: string) {
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const lastLoaded = useRef<string | null>(null);

  const showing = failedSrc === src && lastLoaded.current ? lastLoaded.current : src;

  useEffect(() => {
    if (!failedSrc) return;
    let cancelled = false;
    let probe: HTMLImageElement | null = null;
    const retry = () => {
      if (probe) probe.onload = null;
      probe = new Image();
      probe.onload = () => {
        if (cancelled) return;
        setFailedSrc(null);
        setAttempt(a => a + 1); // A new element, in case the failed one is still the one mounted.
      };
      probe.src = failedSrc;
    };
    const timer = setInterval(retry, RETRY_MS);
    window.addEventListener('online', retry);
    return () => {
      cancelled = true;
      if (probe) probe.onload = null;
      clearInterval(timer);
      window.removeEventListener('online', retry);
    };
  }, [failedSrc]);

  return {
    src: showing,
    key: attempt,
    onLoad: (event: SyntheticEvent<HTMLImageElement>) => {
      lastLoaded.current = event.currentTarget.getAttribute('src');
    },
    onError: () => {
      if (showing === src) setFailedSrc(src);
    },
  };
}

/** Loads images ahead of time, so switching to one later is instant and survives an outage. */
export function usePreloadImages(urls: string[]): void {
  const held = useRef<HTMLImageElement[]>([]);
  const signature = urls.join('|');
  useEffect(() => {
    held.current = urls.map(url => {
      const image = new Image();
      image.src = url;
      return image;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the signature is the list's identity
  }, [signature]);
}
