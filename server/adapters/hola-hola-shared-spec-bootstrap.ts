import type { Application, Request } from "express";
import { getSharedDb } from "../db";
import {
  COORDINATION_ACTOR_IDS,
  type CoordinationActorId,
} from "@shared/schema";
import { resolveCoordinationActor, resolveCoordinationCapability } from "../middleware/coordination-auth";
import type { SharedSpecActorAuthenticator } from "../services/shared-spec-auth";
import { registerPostgresSharedSpecApi } from "../services/shared-spec-bootstrap";
import {
  GitHubSpecPublisher,
  type GitHubSpecPublisherConfig,
} from "../services/github-spec-publisher";
import {
  createGitHubPublishOwnershipProbe,
  createSharedSpecGitHubPublishGuard,
} from "../services/shared-spec-github-publish-guard";
import { hasActiveOwnershipReceipt } from "../services/founder-task-ownership-service";
import type {
  SpecPublication,
  SpecPublicationProvider,
} from "../services/shared-spec-publication";
import { createCoordinationThread } from "../services/coordination-ledger-service";
import { HolaHolaSharedSpecNotificationSink } from "../services/shared-spec-notifications";
import { GitWorkingTreeLiveSyncProvider } from "../services/shared-spec-live-sync";

type HostEnvironment = Record<string, string | undefined>;

const actorIds = new Set<string>(COORDINATION_ACTOR_IDS);

function readHeader(request: Request, name: string): string | undefined {
  const value = request.headers[name];
  return typeof value === "string" ? value : undefined;
}

export class HolaHolaSharedSpecAuthenticator
  implements SharedSpecActorAuthenticator
{
  private readonly policyAdmins: ReadonlySet<string>;

  constructor(
    private readonly environment: HostEnvironment = process.env,
    private readonly resolveCapability: typeof resolveCoordinationCapability = resolveCoordinationCapability,
  ) {
    this.policyAdmins = new Set(
      (environment.SHARED_SPEC_POLICY_ADMIN_ACTORS ?? "david,luca-replit")
        .split(",")
        .map((actor) => actor.trim())
        .filter(Boolean),
    );
  }

  async authenticate(request: Request) {
    const credential =
      readHeader(request, "x-shared-spec-token") ??
      readHeader(request, "x-coordination-token");
    if (!credential) return undefined;
    const legacy = resolveCoordinationActor(credential, undefined, this.environment);
    let actor: string | undefined = legacy.ok ? legacy.actor : undefined;
    if (!legacy.ok) {
      // A runtime that has migrated to the coordination credential broker has
      // no legacy token. Its own short-lived broker credential is accepted
      // when it carries coordination:write, the same capability the
      // coordination routes require for writes.
      const broker = await this.resolveCapability(
        credential,
        "coordination:write",
        undefined,
        request.ip,
        this.environment,
      );
      if (broker.ok && broker.authType === "broker") actor = broker.actor;
    }
    if (!actor || !actorIds.has(actor)) return undefined;
    return {
      actorId: actor,
      capabilities: this.policyAdmins.has(actor)
        ? (["policy_admin"] as const)
        : undefined,
    };
  }
}

class UnavailablePublicationProvider implements SpecPublicationProvider {
  private unavailable(): never {
    throw new Error(
      "Shared-spec GitHub publication is not configured; drafting, review, approval, and export remain available",
    );
  }

  async prepare(): Promise<never> {
    return this.unavailable();
  }

  async publish(): Promise<never> {
    return this.unavailable();
  }

  async reconcile(
    _publication: SpecPublication,
  ): Promise<Pick<SpecPublication, "state" | "pullRequestNumber" | "pullRequestUrl">> {
    return this.unavailable();
  }
}

function publicationProvider(
  environment: HostEnvironment,
): SpecPublicationProvider {
  const repository = environment.SHARED_SPEC_GITHUB_REPOSITORY?.trim();
  const token = environment.SHARED_SPEC_GITHUB_TOKEN?.trim();
  if (!repository || !token) return new UnavailablePublicationProvider();

  const config: GitHubSpecPublisherConfig = {
    repository,
    token,
    baseRef: environment.SHARED_SPEC_GITHUB_BASE_REF?.trim() || "main",
    destinationPrefix: "docs/superpowers/specs/",
    authorizeMutation: createSharedSpecGitHubPublishGuard(
      createGitHubPublishOwnershipProbe(hasActiveOwnershipReceipt),
    ),
  };
  return new GitHubSpecPublisher(config);
}

function notificationSink(): HolaHolaSharedSpecNotificationSink {
  return new HolaHolaSharedSpecNotificationSink({
    create: ({ initiatingActorId, ...input }) => {
      if (!actorIds.has(initiatingActorId)) {
        throw new Error("Shared-spec notification initiating actor is invalid");
      }
      return createCoordinationThread({
        ...input,
        actor: initiatingActorId as CoordinationActorId,
        intendedRecipient: input.intendedRecipient as CoordinationActorId,
        createInboxDelivery: true,
      });
    },
  });
}

let cachedNotificationSink: HolaHolaSharedSpecNotificationSink | undefined;
/**
 * Process-wide singleton, shared by the HTTP routes (registered below) and
 * any other in-process caller that decides a review outside the HTTP layer
 * -- e.g. alden-shared-spec-review.ts, via shared-spec-review-decision.ts.
 * The sink itself holds no meaningful per-instance state (each delivery is a
 * fresh createCoordinationThread call), but one singleton keeps every
 * decision path demonstrably identical rather than independently wired.
 */
export function getHolaHolaSharedSpecNotificationSink(): HolaHolaSharedSpecNotificationSink {
  if (!cachedNotificationSink) cachedNotificationSink = notificationSink();
  return cachedNotificationSink;
}

let cachedLiveSync: GitWorkingTreeLiveSyncProvider | undefined;
/**
 * Process-wide singleton -- unlike the notification sink, sharing this one
 * is not just tidiness: GitWorkingTreeLiveSyncProvider serializes concurrent
 * syncs to the same gitPath only within a single instance (see its own
 * concurrency note), so a second instance constructed elsewhere would not be
 * serialized against this one and could interleave commits to the same file.
 */
export function getHolaHolaSharedSpecLiveSync(environment: HostEnvironment = process.env): GitWorkingTreeLiveSyncProvider {
  if (!cachedLiveSync) cachedLiveSync = new GitWorkingTreeLiveSyncProvider({
    expectedRepository: environment.SHARED_SPEC_GITHUB_REPOSITORY?.trim() || undefined,
  });
  return cachedLiveSync;
}

/**
 * HolaHola's host composition. The shared-spec core remains portable: this is
 * the only layer that knows the current app database and coordination auth.
 */
export function registerHolaHolaSharedSpecApi(
  app: Application,
  environment: HostEnvironment = process.env,
): void {
  registerPostgresSharedSpecApi({
    app,
    db: getSharedDb(),
    authenticator: new HolaHolaSharedSpecAuthenticator(environment),
    publicationProvider: publicationProvider(environment),
    notifications: getHolaHolaSharedSpecNotificationSink(),
    // Local working-tree commit, not a GitHub API call -- available even when
    // SHARED_SPEC_GITHUB_TOKEN is unset. SHARED_SPEC_GITHUB_REPOSITORY is
    // reused only as an optional defence-in-depth cross-check (see
    // GitWorkingTreeLiveSyncOptions.expectedRepository), not as a gate.
    liveSync: getHolaHolaSharedSpecLiveSync(environment),
  });
}
