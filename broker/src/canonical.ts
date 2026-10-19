// Canonical JSON: the exact bytes a client signs and the broker verifies.
// Object keys are sorted, there is no whitespace, and only JSON-safe values are
// accepted (strings, safe integers, booleans, null, arrays, plain objects).
// Non-integer numbers are rejected so two runtimes can never disagree on how a
// float is printed.

export type CanonicalValue =
  | string
  | number
  | boolean
  | null
  | CanonicalValue[]
  | { [key: string]: CanonicalValue };

export function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new TypeError('canonical JSON accepts only safe integers');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object') {
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) throw new TypeError('canonical JSON accepts only plain objects');
    const entries = Object.keys(value as Record<string, unknown>)
      .sort()
      .map((key) => {
        const item = (value as Record<string, unknown>)[key];
        if (item === undefined) throw new TypeError(`canonical JSON rejects undefined at key ${key}`);
        return `${JSON.stringify(key)}:${canonicalJson(item)}`;
      });
    return `{${entries.join(',')}}`;
  }
  throw new TypeError(`canonical JSON rejects ${typeof value}`);
}
