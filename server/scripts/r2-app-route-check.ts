/**
 * r2-app-route-check.ts
 *
 * Shared, side-effect-free helper used by both:
 *   • test-r2-health-check.ts     (the live check; manual, not PR CI)
 *   • test-r2-app-route-negative-path.ts  (the negative-path validator)
 *
 * Keeping this in a dedicated module means the negative-path test can import
 * the REAL decision logic without triggering the side-effects (S3 calls,
 * process.exit) in the main script.  If anyone weakens the non-200 / 0-bytes
 * branches here, the negative-path test will immediately fail in CI.
 */

export type AppRouteOutcome =
  | 'pass'
  | 'fail-non-200'
  | 'fail-empty'
  | 'fail-error'
  | 'skip';

export interface AppRouteResult {
  outcome: AppRouteOutcome;
  status?: number;
  bytes?: number;
  message?: string;
}

async function appGet(url: string): Promise<{ status: number; bytes: number }> {
  const resp = await fetch(url, { signal: AbortSignal.timeout(8000) });
  const buf = await resp.arrayBuffer();
  return { status: resp.status, bytes: buf.byteLength };
}

/**
 * Fetch `url` and return a typed outcome describing whether the proxy route
 * is healthy.
 *
 *   'pass'         – HTTP 200 with a non-empty body
 *   'fail-non-200' – HTTP status other than 200
 *   'fail-empty'   – HTTP 200 but 0-byte body
 *   'fail-error'   – fetch threw an unexpected error
 *   'skip'         – server not reachable (ECONNREFUSED / fetch failed);
 *                    treated as a warning, not a failure, by the main script
 */
export async function checkAppRouteUrl(url: string): Promise<AppRouteResult> {
  try {
    const a = await appGet(url);
    if (a.status === 200 && a.bytes > 0) {
      return { outcome: 'pass', status: a.status, bytes: a.bytes };
    } else if (a.status === 200 && a.bytes === 0) {
      return { outcome: 'fail-empty', status: a.status, bytes: 0 };
    } else {
      return { outcome: 'fail-non-200', status: a.status, bytes: a.bytes };
    }
  } catch (err: any) {
    const msg: string = err?.message ?? String(err);
    if (msg.includes('ECONNREFUSED') || msg.includes('fetch failed')) {
      return { outcome: 'skip', message: msg };
    }
    return { outcome: 'fail-error', message: msg };
  }
}
