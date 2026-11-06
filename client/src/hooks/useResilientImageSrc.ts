import { useEffect, useRef, useState, type SyntheticEvent } from 'react';

const RETRY_MS = 5000;

/** A neutral head and shoulders, inline so it needs no network. */
export const IMAGE_PLACEHOLDER = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E%3Ccircle cx='50' cy='36' r='20' fill='%23cbd5e1'/%3E%3Cpath d='M14 92c0-22 16-34 36-34s36 12 36 34z' fill='%23cbd5e1'/%3E%3C/svg%3E";

/**
 * Keeps an <img> showing something when its image can't load, as when the avatar changes state
 * during a network outage. A failed <img> never retries by itself and shows the broken-image
 * icon, so this shows the last image that loaded (or a neutral placeholder if there is none),
 * retries in the background (on an interval and when the network returns), and switches once the
 * requested image really is available.
 *
 * `scope` says whose images these are. When it changes, the old last image no longer stands in:
 * a new tutor's failed image must not show the previous tutor's face.
 */
export function useResilientImageSrc(src: string, scope = '') {
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const lastLoaded = useRef<string | null>(null);
  const lastScope = useRef(scope);
  if (lastScope.current !== scope) {
    lastScope.current = scope;
    lastLoaded.current = null;
  }

  const showing = failedSrc === src ? lastLoaded.current ?? IMAGE_PLACEHOLDER : src;

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
      const loaded = event.currentTarget.getAttribute('src');
      if (loaded === src) lastLoaded.current = loaded;
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
