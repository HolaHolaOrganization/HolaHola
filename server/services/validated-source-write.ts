import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

export function assertPackageEditMatches(filePath: string, expected: string, actual: string): void {
  if (path.basename(filePath) === 'package.json' && expected !== actual) {
    throw new Error('Refusing stale package.json line edit: selected text no longer matches the reviewed plan.');
  }
}

/** Validate complete candidates, never replacement fragments. No disk writes. */
export function validatePackageCandidate(filePath: string, candidate: string): void {
  if (path.basename(filePath) !== 'package.json') return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    throw new Error('Refusing package.json update: candidate is not valid JSON.');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Refusing package.json update: manifest must be an object.');
  }
  const overrides = (parsed as Record<string, unknown>).overrides;
  function validOverride(value: unknown): boolean {
    return typeof value === 'string' ||
      (value !== null && typeof value === 'object' && !Array.isArray(value) &&
        Object.values(value).every(validOverride));
  }
  if (overrides !== undefined &&
      (!overrides || typeof overrides !== 'object' || Array.isArray(overrides) ||
        !Object.values(overrides).every(validOverride))) {
    throw new Error('Refusing package.json update: overrides must contain version strings or nested override objects.');
  }
}

/**
 * Package writers cooperate through an exclusive lock. Recheck the snapshot
 * before atomic replacement; never silently apply a stale plan. Uncooperative
 * external writers are not protected by this advisory lock.
 */
export function writeValidatedSourceFile(
  filePath: string,
  candidate: string,
  expectedOriginal: string | null,
): void {
  validatePackageCandidate(filePath, candidate);
  if (path.basename(filePath) !== 'package.json') {
    fs.writeFileSync(filePath, candidate, 'utf8');
    return;
  }
  const target = path.resolve(filePath);
  const lockPath = `${target}.alden-write.lock`;
  const temporary = path.join(path.dirname(target), `.package.json.${randomUUID()}.tmp`);
  let lock: number | undefined;
  let temp: number | undefined;
  const checkSnapshot = () => {
    let current: string | null = null;
    try {
      if (fs.lstatSync(target).isSymbolicLink()) {
        throw new Error('Refusing package.json update through a symbolic link.');
      }
      current = fs.readFileSync(target, 'utf8');
    } catch (error: any) {
      if (error.code !== 'ENOENT') throw error;
    }
    if (current !== expectedOriginal) {
      throw new Error('Refusing stale package.json update: file changed; reread it and regenerate the change.');
    }
  };
  try {
    lock = fs.openSync(lockPath, 'wx', 0o600);
    checkSnapshot();
    const mode = expectedOriginal === null ? 0o644 : fs.statSync(target).mode & 0o777;
    temp = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(temp, candidate, 'utf8');
    fs.fsyncSync(temp);
    fs.closeSync(temp);
    temp = undefined;
    fs.chmodSync(temporary, mode);
    checkSnapshot();
    fs.renameSync(temporary, target);
  } finally {
    if (temp !== undefined) fs.closeSync(temp);
    if (lock !== undefined) {
      try {
        fs.rmSync(temporary, { force: true });
      } finally {
        fs.closeSync(lock);
        fs.unlinkSync(lockPath);
      }
    }
  }
}
