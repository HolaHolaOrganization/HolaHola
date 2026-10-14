import type { Application, Request, Response } from "express";
import {
  requireFounder,
  loadAuthenticatedUser,
  type AuthenticatedRequest,
} from "../middleware/rbac";
import { isAuthenticated } from "../replitAuth";
import { storage } from "../storage";
import {
  requireCoordinationAuth,
  type CoordinationAuthenticatedRequest,
} from "../middleware/coordination-auth";
import {
  createChallenge,
  getChallenge,
  listChallenges,
  decideChallenge,
  revokeReceipt,
  issueProofNonce,
  verifyProof,
} from "../services/founder-task-ownership-service";
import {
  isGate3BrokerCredential,
  issueGate3ProofGrant,
} from "../services/coordination-gate3-proof-grant-service";

type FounderRequest = Request<{ id: string }, unknown, { reason?: unknown }>;

type CoordinationRequest = CoordinationAuthenticatedRequest & {
  body: Record<string, unknown>;
  params: { id: string };
};

const STATUS_BY_ERROR_CODE: Readonly<Record<string, number>> = {
  ACTOR_MISMATCH: 403,
  CHALLENGE_ALREADY_DECIDED: 409,
  CHALLENGE_EXPIRED: 410,
  CHALLENGE_EXPIRED_OR_DECIDED: 409,
  CHALLENGE_NOT_FOUND: 404,
  FOUNDER_ID_REQUIRED: 401,
  IDEMPOTENCY_CONFLICT: 409,
  INVALID_CHALLENGE: 422,
  INVALID_KEY_FINGERPRINT: 422,
  INVALID_PUBLIC_KEY: 422,
  PROMOTION_DESCRIPTOR_INVALID: 422,
  PROMOTION_CONTEXT_MISMATCH: 422,
  PROMOTION_CONTEXT_REQUIRED: 409,
  PROMOTION_CONTEXT_UNAVAILABLE: 503,
  NONCE_INVALID: 410,
  NONCE_REPLAYED: 409,
  OWNERSHIP_UNAVAILABLE: 503,
  RECEIPT_NOT_ACTIVE: 410,
  RECEIPT_NOT_FOUND: 404,
  SIGNATURE_INVALID: 401,
  GATE3_PROOF_GRANT_INVALID: 403,
};

function replyError(res: Response, error: unknown): void {
  const code = (error as { code?: string })?.code || "OWNERSHIP_UNAVAILABLE";
  res.status(STATUS_BY_ERROR_CODE[code] || 400).json({ error: { code } });
}

function requireLucaActor(
  req: CoordinationAuthenticatedRequest,
  res: Response,
): req is CoordinationAuthenticatedRequest & { coordinationActor: `luca-${string}` } {
  if (!req.coordinationActor?.startsWith("luca-")) {
    res.status(403).json({ error: { code: "LUCA_COORDINATION_REQUIRED" } });
    return false;
  }
  return true;
}

export function resolveFounderDecisionActor(req: Request): string {
  const id = (req as AuthenticatedRequest).authenticatedUser?.id;
  if (!id) {
    const error = new Error("FOUNDER_ID_REQUIRED") as Error & { code: string };
    error.code = "FOUNDER_ID_REQUIRED";
    throw error;
  }
  return id;
}

function decisionReason(req: FounderRequest): string | undefined {
  return typeof req.body?.reason === "string" ? req.body.reason : undefined;
}

export function buildGate3ProofResponse(proof: {
  ok: true; verified: true; receiptId: string; taskRef: string;
  artifactSha256: string; proofPayloadDigest: string;
}, grant: {
  id: string; taskRef: string; artifactSha256: string; contextDigest: string;
  startingCommit: string; expiresAt: Date;
}) {
  return {
    ...proof,
    contextDigest: grant.contextDigest,
    grant: {
      id: grant.id, taskRef: grant.taskRef, artifactSha256: grant.artifactSha256,
      contextDigest: grant.contextDigest, startingCommit: grant.startingCommit,
      expiresAt: grant.expiresAt.toISOString(),
    },
  };
}

export function registerFounderTaskOwnershipRoutes(app: Application): void {
  const founderSession = [isAuthenticated, loadAuthenticatedUser(storage), requireFounder] as const;

  app.post(
    "/api/task-ownership/challenges",
    requireCoordinationAuth,
    async (req: CoordinationRequest, res) => {
      if (!requireLucaActor(req, res)) return;
      try {
        res.status(201).json(await createChallenge({
          ...req.body,
          coordinationActor: req.coordinationActor,
        }));
      } catch (error) {
        replyError(res, error);
      }
    },
  );

  app.get(
    "/api/task-ownership/challenges/:id",
    requireCoordinationAuth,
    async (req: CoordinationRequest, res) => {
      if (!requireLucaActor(req, res)) return;
      try {
        res.json(await getChallenge(req.params.id, req.coordinationActor));
      } catch (error) {
        replyError(res, error);
      }
    },
  );

  app.get(
    "/api/task-ownership/challenges",
    ...founderSession,
    async (_req, res) => {
      try {
        res.json(await listChallenges());
      } catch (error) {
        replyError(res, error);
      }
    },
  );

  app.post(
    "/api/task-ownership/challenges/:id/approve",
    ...founderSession,
    async (req: FounderRequest, res) => {
      try {
        res.json(await decideChallenge(
          req.params.id,
          "approved",
          resolveFounderDecisionActor(req),
          decisionReason(req),
        ));
      } catch (error) {
        replyError(res, error);
      }
    },
  );

  app.post(
    "/api/task-ownership/challenges/:id/reject",
    ...founderSession,
    async (req: FounderRequest, res) => {
      try {
        res.json(await decideChallenge(
          req.params.id,
          "rejected",
          resolveFounderDecisionActor(req),
          decisionReason(req),
        ));
      } catch (error) {
        replyError(res, error);
      }
    },
  );

  app.post(
    "/api/task-ownership/receipts/:id/revoke",
    ...founderSession,
    async (req: FounderRequest, res) => {
      try {
        res.json(await revokeReceipt(
          req.params.id,
          resolveFounderDecisionActor(req),
          decisionReason(req),
        ));
      } catch (error) {
        replyError(res, error);
      }
    },
  );

  app.post(
    "/api/task-ownership/receipts/:id/proof-nonce",
    requireCoordinationAuth,
    async (req: CoordinationRequest, res) => {
      if (!requireLucaActor(req, res)) return;
      try {
        res.json(await issueProofNonce(req.params.id, req.coordinationActor));
      } catch (error) {
        replyError(res, error);
      }
    },
  );

  app.post(
    "/api/task-ownership/proof",
    requireCoordinationAuth,
    async (req: CoordinationRequest, res) => {
      if (!requireLucaActor(req, res)) return;
      try {
        const nonceId = typeof req.body?.nonceId === "string" ? req.body.nonceId : "";
        const signature = typeof req.body?.signature === "string" ? req.body.signature : "";
        const proof = await verifyProof(nonceId, signature, req.coordinationActor);
        if (!proof.ok) {
          res.json(proof);
          return;
        }
        // Gate 3 grants require broker provenance.  Fixed/legacy actor tokens
        // may continue to verify ownership, but can never mint authority.
        if (
          req.body?.standalone === true
          || req.coordinationAuthType !== "broker"
          || !isGate3BrokerCredential(req.coordinationCredential)
        ) {
          res.json(proof);
          return;
        }
        const grant = await issueGate3ProofGrant(proof, req.coordinationCredential);
        res.json(buildGate3ProofResponse(proof, grant));
      } catch (error) {
        replyError(res, error);
      }
    },
  );
}