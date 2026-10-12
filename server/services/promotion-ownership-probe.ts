import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { COORDINATION_TOKEN_ENV_BY_ACTOR } from '../middleware/coordination-auth';
import { TaskOwnershipService } from './task-ownership-service';
import type { OwnershipProbe } from './infra-mutation-guard';
import { ownershipEndpoint } from './task-ownership-attempt';
import { loadTaskAgentKey } from './task-ownership-key-custody';
import { ownershipUuid, readOwnershipChallengeHandles } from './task-ownership-discovery';
import { TaskOwnershipHttpClient, proveStandaloneTaskOwnership } from './task-ownership-client';
import {
  localPromotionCandidate, promotionContextDigest, remotePromotionHead, verifyPromotionHead,
  type PromotionCandidate, type PromotionMerge,
} from './promotion-candidate';

export type PromotionOwnershipOptions = {
  rootDir?: string; actor?: string; appUrl?: string; receiptId?: string;
  environment?: NodeJS.ProcessEnv;
  branch?: string;
  merge?: () => PromotionMerge | undefined;
  phase?: () => 'upload' | 'dispatch';
};
export type PromotionOwnershipProbe = OwnershipProbe & {
  candidate: () => PromotionCandidate | undefined;
  verifiedCommit: () => string | undefined;
};

/** Local handles/status are discovery only. Every call performs a new server proof. */
export function createPromotionOwnershipProbe(options: PromotionOwnershipOptions = {}): PromotionOwnershipProbe {
  const rootDir = resolve(options.rootDir ?? process.cwd());
  const environment = options.environment ?? process.env;
  let approvedCandidate: PromotionCandidate | undefined;
  let verifiedCommit: string | undefined;
  const probe: OwnershipProbe = async (taskRef, expectedActor) => {
    verifiedCommit = undefined;
    let reason = '';
    const service = new TaskOwnershipService({
      rootDir,
      verifyActiveIsolatedProof: async (ref, artifactSha256) => {
        try {
          const actor = options.actor ?? environment.COORDINATION_ACTOR;
          if (!actor || !actor.startsWith('luca-') || !(actor in COORDINATION_TOKEN_ENV_BY_ACTOR)) {
            throw new Error('Configure your own COORDINATION_ACTOR or --actor before promotion.');
          }
          if ((options.actor && environment.COORDINATION_ACTOR && options.actor !== environment.COORDINATION_ACTOR)
              || (expectedActor && actor !== expectedActor)) throw new Error('Promotion actor conflicts with the configured actor.');
          const envName = COORDINATION_TOKEN_ENV_BY_ACTOR[actor as keyof typeof COORDINATION_TOKEN_ENV_BY_ACTOR];
          const legacyToken = environment[envName];
          const token = actor === 'luca-gemini'
            ? environment.COORDINATION_LUCA_GEMINI_CODE_TOKEN ?? legacyToken
            : legacyToken;
          if (!token) throw new Error(`Own actor credential is missing: ${envName}.`);
          if (actor === 'luca-gemini' && environment.COORDINATION_LUCA_GEMINI_CODE_TOKEN
              && legacyToken && legacyToken !== environment.COORDINATION_LUCA_GEMINI_CODE_TOKEN) {
            throw new Error('Conflicting Gemini coordination credential aliases.');
          }
          const rawUrl = options.appUrl ?? environment.COORDINATION_API_URL ?? environment.APP_URL;
          if (!rawUrl) throw new Error('Configure the trusted ownership server origin with --app-url or COORDINATION_API_URL.');
          const endpoint = ownershipEndpoint(rawUrl);
          if (!artifactSha256) throw new Error('Exact local task artifact is missing.');
          const key = await loadTaskAgentKey(ref); // Never generate or replace custody.
          const client = new TaskOwnershipHttpClient(endpoint, token);
          let receiptId = options.receiptId;
          if (receiptId !== undefined && !ownershipUuid(receiptId)) throw new Error('Invalid ownership receipt ID.');
          if (!receiptId) {
            const handles = await readOwnershipChallengeHandles(rootDir, {
              endpoint, actor, taskRef: ref, artifactSha256, keyFingerprint: key.fingerprint,
            });
            const receipts = new Set<string>();
            for (const handle of handles) {
              const status: any = await client.status(handle.challengeId);
              if (!status || status.id !== handle.challengeId ||
                  !['pending', 'approved', 'expired', 'rejected'].includes(status.status)) {
                throw new Error('Malformed ownership challenge status.');
              }
              // Older status responses lack these fields. No status response grants
              // authority: a fresh nonce/signature below verifies every binding.
              for (const [field, value] of Object.entries({
                taskRef: ref, intendedActor: actor, artifactSha256, keyFingerprint: key.fingerprint,
              })) {
                if (status[field] !== undefined && status[field] !== value) throw new Error('Ownership status binding mismatch.');
              }
              if (status.status === 'approved' && status.receipt?.status === 'active') {
                if (!ownershipUuid(status.receipt.id)) throw new Error('Malformed ownership receipt discovery.');
                receipts.add(status.receipt.id);
              }
            }
            if (receipts.size !== 1) throw new Error(receipts.size > 1
              ? 'Multiple ownership receipts discovered; specify the exact --receipt-id.'
              : 'No approved ownership receipt discovered. Complete founder approval first; older host state needs --receipt-id.');
            receiptId = [...receipts][0];
          }
          if (!options.branch) throw new Error('Exact promotion branch is required.');
          const candidate = approvedCandidate ?? localPromotionCandidate(rootDir, options.branch);
          const merge = options.merge?.();
          const head = verifyPromotionHead(rootDir, candidate, merge);
          const expectedRemote = merge && options.phase?.() === 'upload' ? candidate.candidateCommit : head;
          if (remotePromotionHead(rootDir, candidate.branch) !== expectedRemote) {
            throw new Error('Remote branch differs from the approved promotion head.');
          }
          await proveStandaloneTaskOwnership(
            client, ref, actor, receiptId, artifactSha256, promotionContextDigest(candidate),
          );
          const artifactPath = join(rootDir, '.local', 'tasks', `task-${ref}.md`);
          const stat = await lstat(artifactPath);
          const after = createHash('sha256').update(await readFile(artifactPath)).digest('hex');
          if (!stat.isFile() || stat.isSymbolicLink() || after !== artifactSha256) {
            throw new Error('Task artifact changed during ownership verification.');
          }
          if (verifyPromotionHead(rootDir, candidate, merge) !== head) {
            throw new Error('Promotion head changed during ownership verification.');
          }
          approvedCandidate = Object.freeze(candidate);
          verifiedCommit = head;
          return true;
        } catch (error) {
          // Known errors contain no provider response body or credential values.
          reason = error instanceof Error ? error.message : 'Ownership verification failed.';
          return false;
        }
      },
    });
    const result = await service.probe(taskRef);
    if (result.state === 'unknown_stop' && reason) result.explanation = reason;
    return result;
  };
  return Object.assign(probe, {
    candidate: () => approvedCandidate,
    verifiedCommit: () => verifiedCommit,
  });
}
