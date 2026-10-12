import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { canonicalJson } from './task-ownership-service';

export const PROMOTION_REPOSITORY = 'github:davidwmcintosh/holahola';
export type PromotionCandidate = {
  purpose: 'cross-tool-promote'; repository: string; branch: string; candidateCommit: string;
};
export type PromotionMerge = {
  candidateCommit: string; mainCommit: string; commitSha: string;
};
export const isCommitSha = (value: unknown): value is string =>
  typeof value === 'string' && /^[0-9a-f]{40}$/.test(value);
export function validPromotionBranch(branch: string): boolean {
  return typeof branch === 'string' && branch.length > 0 && branch.length <= 200 &&
    /^[A-Za-z0-9._/-]+$/.test(branch) && !branch.startsWith('-') && !branch.includes('..');
}
export function validatePromotionCandidate(value: unknown): asserts value is PromotionCandidate {
  const candidate = value as PromotionCandidate;
  if (!candidate || Object.keys(candidate).sort().join(',') !== 'branch,candidateCommit,purpose,repository' ||
      candidate.purpose !== 'cross-tool-promote' || candidate.repository !== PROMOTION_REPOSITORY ||
      !validPromotionBranch(candidate.branch) || !isCommitSha(candidate.candidateCommit)) {
    throw new Error('Invalid promotion candidate descriptor.');
  }
}
export function promotionContextDigest(candidate: PromotionCandidate): string {
  validatePromotionCandidate(candidate);
  return createHash('sha256').update(canonicalJson(candidate)).digest('hex');
}
export function promotionGit(root: string, args: string[]): string {
  try {
    return execFileSync('git', args, {
      cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 15_000,
    }).trim();
  } catch {
    // Git errors can include credential-bearing rewritten remote URLs.
    throw new Error('Cannot inspect promotion Git state.');
  }
}
export function promotionRepository(root: string): string {
  const raw = promotionGit(root, ['config', '--get', 'remote.origin.url']);
  const match = /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([a-zA-Z0-9_-]+)\/([a-zA-Z0-9_.-]+?)(?:\.git)?\/?$/.exec(raw);
  const repository = match ? `github:${match[1].toLowerCase()}/${match[2].toLowerCase()}` : '';
  if (repository !== PROMOTION_REPOSITORY) throw new Error('Promotion origin is not the approved destination repository.');
  return repository;
}
export function localPromotionCandidate(root: string, branch: string, commit?: string): PromotionCandidate {
  if (!validPromotionBranch(branch)) throw new Error('Invalid promotion branch.');
  if (promotionGit(root, ['rev-parse', '--abbrev-ref', 'HEAD']) !== branch) {
    throw new Error('Promotion branch is not the checked-out branch.');
  }
  const head = promotionGit(root, ['rev-parse', 'HEAD']);
  if (!isCommitSha(head) || (commit !== undefined && head !== commit)) {
    throw new Error('Promotion head differs from the approved candidate.');
  }
  const candidate: PromotionCandidate = {
    purpose: 'cross-tool-promote', repository: promotionRepository(root), branch, candidateCommit: head,
  };
  validatePromotionCandidate(candidate);
  return candidate;
}
export function remotePromotionHead(root: string, branch: string): string {
  promotionGit(root, ['fetch', 'origin', `refs/heads/${branch}`, '--no-tags']);
  const sha = promotionGit(root, ['rev-parse', '--verify', 'FETCH_HEAD^{commit}']);
  if (!isCommitSha(sha)) throw new Error('Invalid remote promotion head.');
  return sha;
}
export function verifyPromotionHead(
  root: string, candidate: PromotionCandidate, merge?: PromotionMerge,
): string {
  validatePromotionCandidate(candidate);
  const current = localPromotionCandidate(root, candidate.branch);
  if (current.repository !== candidate.repository) throw new Error('Promotion repository changed.');
  if (!merge) {
    if (current.candidateCommit !== candidate.candidateCommit) throw new Error('Promotion head differs from the approved candidate.');
  } else {
    if (merge.candidateCommit !== candidate.candidateCommit ||
        !isCommitSha(merge.mainCommit) || !isCommitSha(merge.commitSha) ||
        current.candidateCommit !== merge.commitSha ||
        promotionGit(root, ['rev-list', '--parents', '-n', '1', merge.commitSha]) !==
          `${merge.commitSha} ${candidate.candidateCommit} ${merge.mainCommit}`) {
      throw new Error('Promotion merge is not the exact in-process two-parent merge.');
    }
  }
  return current.candidateCommit;
}
