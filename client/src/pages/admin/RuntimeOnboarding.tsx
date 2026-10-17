import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "wouter";
import { AlertTriangle, ArrowLeft, Check, Clock3, Loader2, RefreshCw, ShieldCheck, X } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { apiRequest, getQueryFn } from "@/lib/queryClient";
import { GithubAppGrantsPanel } from "@/components/admin/GithubAppGrantsPanel";
import type { RuntimeOnboardingClientType } from "@shared/schema";
import type {
  RuntimeOnboardingInvitationView,
  RuntimeOnboardingRequestView,
} from "@shared/runtime-onboarding";

type ClientType = RuntimeOnboardingClientType;

interface Actor {
  id: string;
  capabilities: string[];
}

interface Invitation extends RuntimeOnboardingInvitationView {
  preparedBy?: string;
  provider?: string;
  model?: string;
}

type OnboardingRequest = RuntimeOnboardingRequestView;

interface Runtime {
  runtimeId: string;
  actor: string;
  displayName: string;
  capabilities: string[];
  enabled: boolean;
  revokedAt: string | null;
  provider?: string | null;
  model?: string | null;
  credentialExpiresAt?: string | null;
  connectionEvidence?: {
    authenticatedLedgerAt: string | null;
    evidence: "server_ledger_read" | null;
  };
}

interface OnboardingSnapshot {
  actors: Actor[];
  invitations: Invitation[];
  requests: OnboardingRequest[];
  runtimes: Runtime[];
  csrfToken: string;
}

interface InvitationCreated {
  invitation: Invitation;
  setup: {
    invitationId: string;
    endpoint?: string;
    approvalPath?: string;
  };
}

type ConfirmAction =
  | { kind: "request"; id: string; decision: "approve" | "deny" }
  | { kind: "cancel"; id: string }
  | { kind: "revoke"; id: string };

const ONBOARDING_URL = "/api/coordination/onboarding";
const ONBOARDING_ADMIN_URL = `${ONBOARDING_URL}/admin`;

function isPendingRequest(state: string): boolean {
  return state === "requested" || state === "pending";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "The request could not be completed.";
}

function formatDate(value: string | null | undefined): string {
  if (!value) return "Not provided";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function quoteShellArgument(value: string): string {
  return "'" + value.replace(/'/g, "'\\''") + "'";
}

function makeLocalSetupCommand(result: InvitationCreated, invitation: Invitation): string | null {
  if (!result.setup.endpoint) return null;
  return [
    "npx tsx server/scripts/runtime-onboarding-cli.ts setup \\",
    `  --endpoint ${quoteShellArgument(result.setup.endpoint)} \\`,
    `  --actor ${quoteShellArgument(invitation.actor)} \\`,
    `  --runtime-id ${quoteShellArgument(invitation.runtimeId)} \\`,
    `  --invitation-id ${quoteShellArgument(result.setup.invitationId)}`,
  ].join("\n");
}

function StateBadge({ state }: { state: string }) {
  const variant = state === "denied" || state === "cancelled" || state === "revoked" ? "destructive"
    : state === "approved" || state === "enrolled" ? "default"
    : "secondary";
  return <Badge variant={variant}>{state}</Badge>;
}

function CapabilityList({ capabilities }: { capabilities: string[] }) {
  if (!capabilities.length) return <span className="text-sm text-muted-foreground">No capabilities listed</span>;
  return (
    <ul className="flex flex-wrap gap-1.5" aria-label="Capabilities">
      {capabilities.map((capability) => (
        <li key={capability}>
          <Badge variant="outline" className="font-mono text-xs">{capability}</Badge>
        </li>
      ))}
    </ul>
  );
}

export default function RuntimeOnboarding() {
  const searchRequestId = useMemo(
    () => (typeof window === "undefined" ? null : new URLSearchParams(window.location.search).get("request")),
    [],
  );
  const [confirmAction, setConfirmAction] = useState<ConfirmAction | null>(null);
  const [localVerificationConfirmed, setLocalVerificationConfirmed] = useState(false);
  const [selectedActor, setSelectedActor] = useState("");
  const [selectedCapabilities, setSelectedCapabilities] = useState<string[]>([]);
  const [runtimeId, setRuntimeId] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [provider, setProvider] = useState("");
  const [model, setModel] = useState("");
  const [clientType, setClientType] = useState<ClientType>("mcp-stdio");
  const [createdInvitation, setCreatedInvitation] = useState<InvitationCreated | null>(null);
  const client = useQueryClient();
  const onboardingQuery = useQuery<OnboardingSnapshot>({
    queryKey: [ONBOARDING_ADMIN_URL],
    queryFn: getQueryFn({ on401: "throw" }),
    refetchInterval: 30_000,
  });
  const snapshot = onboardingQuery.data;
  const selectedActorRecord = snapshot?.actors.find((actor) => actor.id === selectedActor);
  const exactRequest = snapshot?.requests.find((request) => request.id === searchRequestId);

  useEffect(() => {
    if (!snapshot?.actors.length) return;
    if (!selectedActor || !snapshot.actors.some((actor) => actor.id === selectedActor)) {
      const firstActor = snapshot.actors[0];
      setSelectedActor(firstActor.id);
      setSelectedCapabilities(firstActor.capabilities);
    }
  }, [snapshot?.actors, selectedActor]);

  const refreshAfterWrite = async () => {
    await client.invalidateQueries({ queryKey: [ONBOARDING_ADMIN_URL] });
    await onboardingQuery.refetch();
  };

  const createInvitation = useMutation({
    mutationFn: async (): Promise<InvitationCreated> => {
      if (!snapshot?.csrfToken) throw new Error("The CSRF token is unavailable. Refresh the page and try again.");
      const response = await apiRequest("POST", `${ONBOARDING_URL}/invitations`, {
        actor: selectedActor,
        runtimeId: runtimeId.trim(),
        displayName: displayName.trim(),
        capabilities: selectedCapabilities,
        ...(provider.trim() ? { provider: provider.trim() } : {}),
        ...(model.trim() ? { model: model.trim() } : {}),
        clientType,
        csrfToken: snapshot.csrfToken,
      });
      return response.json() as Promise<InvitationCreated>;
    },
    onSuccess: async (result) => {
      setCreatedInvitation(result);
      setRuntimeId("");
      setDisplayName("");
      setProvider("");
      setModel("");
      await refreshAfterWrite();
    },
  });

  const requestDecision = useMutation({
    mutationFn: async ({ id, decision }: { id: string; decision: "approve" | "deny" }) => {
      if (!snapshot?.csrfToken) throw new Error("The CSRF token is unavailable. Refresh the page and try again.");
      const response = await apiRequest("POST", `${ONBOARDING_URL}/admin/requests/${encodeURIComponent(id)}/${decision}`, {
        csrfToken: snapshot.csrfToken,
      });
      return response.json();
    },
    onSuccess: refreshAfterWrite,
  });

  const cancelInvitation = useMutation({
    mutationFn: async (id: string) => {
      if (!snapshot?.csrfToken) throw new Error("The CSRF token is unavailable. Refresh the page and try again.");
      const response = await apiRequest("POST", `${ONBOARDING_URL}/invitations/${encodeURIComponent(id)}/cancel`, {
        csrfToken: snapshot.csrfToken,
      });
      return response.json();
    },
    onSuccess: refreshAfterWrite,
  });

  const revokeRuntime = useMutation({
    mutationFn: async (runtimeIdToRevoke: string) => {
      if (!snapshot?.csrfToken) throw new Error("The CSRF token is unavailable. Refresh the page and try again.");
      const response = await apiRequest("POST", `${ONBOARDING_URL}/admin/runtimes/${encodeURIComponent(runtimeIdToRevoke)}/revoke`, {
        csrfToken: snapshot.csrfToken,
      });
      return response.json();
    },
    onSuccess: refreshAfterWrite,
  });

  const activeMutation = createInvitation.isPending || requestDecision.isPending || cancelInvitation.isPending || revokeRuntime.isPending;
  const mutationError = createInvitation.error || requestDecision.error || cancelInvitation.error || revokeRuntime.error;
  const canManage = Boolean(snapshot?.csrfToken);

  const handleConfirm = () => {
    if (!confirmAction) return;
    if (confirmAction.kind === "request") {
      requestDecision.mutate({ id: confirmAction.id, decision: confirmAction.decision });
    } else if (confirmAction.kind === "cancel") {
      cancelInvitation.mutate(confirmAction.id);
    } else {
      revokeRuntime.mutate(confirmAction.id);
    }
    setConfirmAction(null);
    setLocalVerificationConfirmed(false);
  };

  const closeConfirmation = (open: boolean) => {
    if (!open) {
      setConfirmAction(null);
      setLocalVerificationConfirmed(false);
    }
  };

  return (
    <main className="mx-auto w-full max-w-6xl space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <Button asChild variant="ghost" size="sm" className="-ml-3 mb-2">
            <Link href="/admin"><ArrowLeft className="mr-2 h-4 w-4" />Command Center</Link>
          </Button>
          <div className="flex items-center gap-3">
            <ShieldCheck className="h-8 w-8 text-primary" aria-hidden="true" />
            <div>
              <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">Runtime onboarding</h1>
              <p className="mt-1 text-sm text-muted-foreground">Review exact enrollment requests and manage registered runtime credentials.</p>
            </div>
          </div>
        </div>
        <Button variant="outline" onClick={() => onboardingQuery.refetch()} disabled={onboardingQuery.isFetching}>
          {onboardingQuery.isFetching ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-2 h-4 w-4" />}
          Refresh
        </Button>
      </div>

      <Alert>
        <AlertTriangle className="h-4 w-4" />
        <AlertTitle>Verify locally before approving</AlertTitle>
        <AlertDescription>
          Approval is for one exact key and runtime. Compare the verification code and fingerprint shown here with the local helper display, and verify the actor, runtime, scope, and expiry. Do not approve if any value differs. An approved/enrolled state is not proof that the runtime connected, acknowledged a message, or executed work.
        </AlertDescription>
      </Alert>

      {onboardingQuery.isError && (
        <Alert variant="destructive" role="alert">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>Could not load runtime onboarding</AlertTitle>
          <AlertDescription className="flex flex-wrap items-center justify-between gap-3">
            <span>{errorMessage(onboardingQuery.error)}</span>
            <Button size="sm" variant="outline" onClick={() => onboardingQuery.refetch()} disabled={onboardingQuery.isFetching}>Retry</Button>
          </AlertDescription>
        </Alert>
      )}
      {mutationError && (
        <Alert variant="destructive" role="alert">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>Action failed</AlertTitle>
          <AlertDescription>{errorMessage(mutationError)}</AlertDescription>
        </Alert>
      )}

      {onboardingQuery.isLoading ? (
        <Card><CardContent className="flex items-center justify-center gap-3 py-12 text-muted-foreground"><Loader2 className="h-5 w-5 animate-spin" />Loading onboarding records…</CardContent></Card>
      ) : snapshot && (
        <>
          <Card>
            <CardHeader>
              <CardTitle>Prepare an invitation</CardTitle>
              <CardDescription>Choose an existing actor and a distinct runtime identity. Creating an invitation does not register a runtime or issue a credential.</CardDescription>
            </CardHeader>
            <CardContent>
              <form
                className="grid grid-cols-1 gap-4 sm:grid-cols-2"
                onSubmit={(event) => { event.preventDefault(); createInvitation.mutate(); }}
              >
                <div className="space-y-2">
                  <Label htmlFor="runtime-onboarding-actor">Registered actor</Label>
                  <Select
                    value={selectedActor}
                    onValueChange={(value) => {
                      setSelectedActor(value);
                      setSelectedCapabilities(snapshot.actors.find((actor) => actor.id === value)?.capabilities ?? []);
                    }}
                  >
                    <SelectTrigger id="runtime-onboarding-actor" aria-label="Registered actor">
                      <SelectValue placeholder="Choose an actor" />
                    </SelectTrigger>
                    <SelectContent>
                      {snapshot.actors.map((actor) => <SelectItem key={actor.id} value={actor.id}>{actor.id}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="runtime-onboarding-transport">Client transport</Label>
                  <Select value={clientType} onValueChange={(value) => setClientType(value as ClientType)}>
                    <SelectTrigger id="runtime-onboarding-transport" aria-label="Client transport"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="mcp-stdio">MCP stdio</SelectItem>
                      <SelectItem value="openai-http">OpenAI HTTP</SelectItem>
                      <SelectItem value="http-cli">HTTP / CLI</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="runtime-onboarding-runtime-id">Runtime ID</Label>
                   <Input id="runtime-onboarding-runtime-id" value={runtimeId} onChange={(event) => setRuntimeId(event.target.value)} required maxLength={120} pattern="[A-Za-z0-9][A-Za-z0-9._:-]{1,119}" title="Use 2–120 letters, digits, dots, underscores, colons, or hyphens." autoComplete="off" />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="runtime-onboarding-display-name">Display name</Label>
                  <Input id="runtime-onboarding-display-name" value={displayName} onChange={(event) => setDisplayName(event.target.value)} required maxLength={120} autoComplete="off" />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="runtime-onboarding-provider">Provider <span className="font-normal text-muted-foreground">(optional)</span></Label>
                   <Input id="runtime-onboarding-provider" value={provider} onChange={(event) => setProvider(event.target.value)} maxLength={40} autoComplete="off" />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="runtime-onboarding-model">Model <span className="font-normal text-muted-foreground">(optional)</span></Label>
                   <Input id="runtime-onboarding-model" value={model} onChange={(event) => setModel(event.target.value)} maxLength={80} autoComplete="off" />
                </div>
                <fieldset className="space-y-2 sm:col-span-2">
                  <legend className="text-sm font-medium">Requested capabilities</legend>
                  {selectedActorRecord?.capabilities.length ? (
                    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
                      {selectedActorRecord.capabilities.map((capability, index) => {
                        const checked = selectedCapabilities.includes(capability);
                        const id = `runtime-capability-${index}-${capability.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
                        return (
                          <div key={capability} className="flex items-center gap-2 rounded-md border p-2.5">
                            <Checkbox
                              id={id}
                              checked={checked}
                              onCheckedChange={(value) => setSelectedCapabilities((current) => value
                                ? [...new Set([...current, capability])]
                                : current.filter((item) => item !== capability))}
                            />
                            <Label htmlFor={id} className="break-all font-mono text-xs">{capability}</Label>
                          </div>
                        );
                      })}
                    </div>
                  ) : <p className="text-sm text-muted-foreground">No capabilities are registered for this actor.</p>}
                </fieldset>
                <div className="sm:col-span-2">
                  <Button type="submit" disabled={!canManage || activeMutation || !selectedActor || !runtimeId.trim() || !displayName.trim()}>
                    {createInvitation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                    Prepare invitation
                  </Button>
                </div>
              </form>
              {!canManage && <p className="mt-3 text-sm text-destructive">A CSRF token is unavailable. Refresh before making changes.</p>}
              {createdInvitation && (
                <Alert className="mt-5" role="status">
                  <Check className="h-4 w-4" />
                  <AlertTitle>Invitation prepared — no credential issued</AlertTitle>
                  <AlertDescription className="space-y-2">
                    <p>These setup arguments are non-secret. The invitation reference is not a credential.</p>
                    <dl className="grid gap-x-4 gap-y-1 sm:grid-cols-[max-content_1fr]">
                      <dt className="font-medium">Invitation</dt><dd className="break-all font-mono">{createdInvitation.setup.invitationId}</dd>
                      {createdInvitation.setup.endpoint && <><dt className="font-medium">Endpoint</dt><dd className="break-all font-mono">{createdInvitation.setup.endpoint}</dd></>}
                      {createdInvitation.setup.approvalPath && <><dt className="font-medium">Approval path</dt><dd className="break-all font-mono">{createdInvitation.setup.approvalPath}</dd></>}
                    </dl>
                    {makeLocalSetupCommand(createdInvitation, createdInvitation.invitation) && (
                      <div className="space-y-1">
                        <p className="font-medium">Repository-local helper entry (reviewed checkout only)</p>
                        <pre className="overflow-x-auto rounded-md bg-muted p-3 font-mono text-xs leading-relaxed" aria-label="Non-secret local setup command">
                          {makeLocalSetupCommand(createdInvitation, createdInvitation.invitation)}
                        </pre>
                      </div>
                    )}
                    <p className="text-xs">The command uses the actual <code>server/scripts/runtime-onboarding-cli.ts</code> entry and is for a reviewed checkout with its pinned dependencies only. For destination installation, follow <code>docs/runtime-onboarding-clients.md</code> and transfer only an integrity-verified helper from the approved source pin. Do not use remote download-and-evaluate commands or move credentials through this browser.</p>
                  </AlertDescription>
                </Alert>
              )}
            </CardContent>
          </Card>

          <section aria-labelledby="runtime-requests-heading" className="space-y-3">
            <div>
              <h2 id="runtime-requests-heading" className="text-xl font-semibold">Enrollment requests</h2>
              <p className="text-sm text-muted-foreground">Only pending requests offer a founder decision. Denial is final for that request.</p>
            </div>
            {searchRequestId && (
              <Alert className={exactRequest ? "border-primary" : ""} role="status">
                <AlertTitle>{exactRequest ? "Exact request selected" : "Requested approval reference not found"}</AlertTitle>
                <AlertDescription>
                  {exactRequest
                    ? <>The <span className="font-mono">{searchRequestId}</span> request is highlighted below. Approve only if its displayed code and fingerprint match the local helper.</>
                    : <>No request with ID <span className="font-mono break-all">{searchRequestId}</span> appears in the current authorized response. Refresh and verify the request reference; do not approve another request instead.</>}
                </AlertDescription>
              </Alert>
            )}
            {snapshot.requests.length ? snapshot.requests.slice().sort((left, right) => {
              if (left.id === searchRequestId) return -1;
              if (right.id === searchRequestId) return 1;
              return 0;
            }).map((request) => {
              const selected = request.id === searchRequestId;
              return (
                <Card key={request.id} id={`request-${request.id}`} className={selected ? "border-primary ring-2 ring-primary/20" : ""}>
                  <CardHeader className="pb-3">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0">
                        <CardTitle className="break-all text-base">{request.displayName}</CardTitle>
                        <CardDescription className="mt-1 break-all font-mono">{request.id}</CardDescription>
                      </div>
                      <StateBadge state={request.state} />
                    </div>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    <dl className="grid grid-cols-1 gap-x-6 gap-y-3 text-sm sm:grid-cols-2 lg:grid-cols-3">
                      <div><dt className="text-muted-foreground">Actor</dt><dd className="break-all font-medium">{request.actor}</dd></div>
                      <div><dt className="text-muted-foreground">Runtime ID</dt><dd className="break-all font-mono">{request.runtimeId}</dd></div>
                      <div><dt className="text-muted-foreground">Expires</dt><dd>{formatDate(request.expiresAt)}</dd></div>
                      <div><dt className="text-muted-foreground">Client transport</dt><dd>Not included in request metadata</dd></div>
                      <div><dt className="text-muted-foreground">Reported source</dt><dd className="break-words">{[request.provider, request.model].filter(Boolean).join(" / ") || "Not reported"}</dd></div>
                    </dl>
                    <div>
                      <p className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">Requested capabilities</p>
                      <CapabilityList capabilities={request.capabilities} />
                    </div>
                    <div className="grid gap-3 rounded-lg border border-amber-500/40 bg-amber-500/5 p-4 sm:grid-cols-2">
                      <div>
                        <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Local verification code — compare exactly</p>
                        <p className="select-all break-all font-mono text-lg font-bold tracking-wider" data-testid={`verification-code-${request.id}`}>{request.verificationCode}</p>
                      </div>
                      <div>
                        <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Public-key fingerprint — compare exactly</p>
                        <p className="select-all break-all font-mono text-sm font-semibold" data-testid={`fingerprint-${request.id}`}>{request.fingerprint}</p>
                      </div>
                      <p className="flex items-start gap-2 text-sm text-amber-900 dark:text-amber-200 sm:col-span-2">
                        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                        Compare both values on the local helper before approving. Confirm actor, runtime ID, capabilities, expiry, and requesting party too.
                      </p>
                    </div>
                    {isPendingRequest(request.state) && (
                      <div className="flex flex-wrap gap-2">
                        <Button onClick={() => { setLocalVerificationConfirmed(false); setConfirmAction({ kind: "request", id: request.id, decision: "approve" }); }} disabled={!canManage || activeMutation}>
                          <Check className="mr-2 h-4 w-4" />Approve exact request
                        </Button>
                        <Button variant="destructive" onClick={() => setConfirmAction({ kind: "request", id: request.id, decision: "deny" })} disabled={!canManage || activeMutation}>
                          <X className="mr-2 h-4 w-4" />Deny request
                        </Button>
                      </div>
                    )}
                  </CardContent>
                </Card>
              );
            }) : <Card><CardContent className="py-8 text-center text-sm text-muted-foreground">No enrollment requests are present.</CardContent></Card>}
          </section>

          <section aria-labelledby="runtime-invitations-heading" className="space-y-3">
            <div>
              <h2 id="runtime-invitations-heading" className="text-xl font-semibold">Invitations</h2>
              <p className="text-sm text-muted-foreground">Prepared references do not register a runtime or issue a bearer credential.</p>
            </div>
            {snapshot.invitations.length ? snapshot.invitations.map((invitation) => (
              <Card key={invitation.id}>
                <CardContent className="flex flex-col justify-between gap-4 pt-6 sm:flex-row sm:items-start">
                  <div className="min-w-0 space-y-2">
                    <div className="flex flex-wrap items-center gap-2"><span className="font-semibold">{invitation.displayName}</span><StateBadge state={invitation.state} /></div>
                    <p className="break-all font-mono text-xs">{invitation.id}</p>
                    <p className="break-words text-sm text-muted-foreground">{invitation.actor} · {invitation.runtimeId} · {invitation.clientType}</p>
                    {invitation.preparedBy && <p className="text-xs text-muted-foreground">Prepared by: {invitation.preparedBy}</p>}
                    {(invitation.provider || invitation.model) && <p className="text-xs text-muted-foreground">Reported source: {[invitation.provider, invitation.model].filter(Boolean).join(" / ")}</p>}
                    <p className="text-xs text-muted-foreground">Expires {formatDate(invitation.expiresAt)}</p>
                    <CapabilityList capabilities={invitation.capabilities} />
                  </div>
                  {(invitation.state === "prepared" || invitation.state === "requested") && (
                    <Button variant="outline" size="sm" onClick={() => setConfirmAction({ kind: "cancel", id: invitation.id })} disabled={!canManage || activeMutation}>
                      Cancel invitation
                    </Button>
                  )}
                </CardContent>
              </Card>
            )) : <Card><CardContent className="py-8 text-center text-sm text-muted-foreground">No invitations are present.</CardContent></Card>}
          </section>

          <section aria-labelledby="registered-runtimes-heading" className="space-y-3">
            <div>
              <h2 id="registered-runtimes-heading" className="text-xl font-semibold">Runtime registrations</h2>
              <p className="text-sm text-muted-foreground">Registration/enrollment is not evidence of an authenticated connection or acknowledgement.</p>
            </div>
            {snapshot.runtimes.length ? snapshot.runtimes.map((runtime) => {
              const revoked = Boolean(runtime.revokedAt) || !runtime.enabled;
              return (
                <Card key={runtime.runtimeId}>
                  <CardContent className="flex flex-col justify-between gap-4 pt-6 sm:flex-row sm:items-start">
                    <div className="min-w-0 space-y-2">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-semibold">{runtime.displayName}</span>
                        <Badge variant={revoked ? "destructive" : "secondary"}>{revoked ? "Revoked / disabled" : "Registered (enrollment only)"}</Badge>
                      </div>
                      <p className="break-all font-mono text-xs">{runtime.runtimeId}</p>
                      <p className="break-all text-sm text-muted-foreground">Actor: {runtime.actor}</p>
                      {(runtime.provider || runtime.model) && <p className="text-xs text-muted-foreground">Reported source: {[runtime.provider, runtime.model].filter(Boolean).join(" / ")}</p>}
                      {runtime.revokedAt && <p className="text-xs text-muted-foreground">Revoked at {formatDate(runtime.revokedAt)}</p>}
                      <p className="text-xs text-muted-foreground">
                        Credential expiry: {runtime.credentialExpiresAt ? formatDate(runtime.credentialExpiresAt) : "No unrevoked credential"}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {runtime.connectionEvidence?.evidence === "server_ledger_read"
                          && runtime.connectionEvidence.authenticatedLedgerAt
                          ? `Authenticated ledger read recorded at ${formatDate(runtime.connectionEvidence.authenticatedLedgerAt)} (historical evidence, not proof of a current connection).`
                          : "No verified onboarding ledger-read evidence recorded."}
                      </p>
                      <CapabilityList capabilities={runtime.capabilities} />
                    </div>
                    {!revoked && (
                      <Button variant="destructive" size="sm" onClick={() => setConfirmAction({ kind: "revoke", id: runtime.runtimeId })} disabled={!canManage || activeMutation}>
                        Revoke runtime
                      </Button>
                    )}
                  </CardContent>
                </Card>
              );
            }) : <Card><CardContent className="py-8 text-center text-sm text-muted-foreground">No runtime registrations are present.</CardContent></Card>}
          </section>

          <div className="flex items-center gap-2 text-xs text-muted-foreground"><Clock3 className="h-3.5 w-3.5" />Status refreshes automatically every 30 seconds. Use Refresh to check immediately.</div>
        </>
      )}

      <GithubAppGrantsPanel />

      <AlertDialog open={Boolean(confirmAction)} onOpenChange={closeConfirmation}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {confirmAction?.kind === "request" && confirmAction.decision === "approve" ? "Approve this exact enrollment request?" :
                confirmAction?.kind === "request" ? "Deny this enrollment request?" :
                  confirmAction?.kind === "cancel" ? "Cancel this invitation?" : "Revoke this runtime?"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {confirmAction?.kind === "request" && confirmAction.decision === "approve"
                ? <>Approval authorizes only the displayed request and key. It does not prove a connection, inbox acknowledgement, or successful task execution. Verify the local code and fingerprint before continuing.</>
                : confirmAction?.kind === "request"
                  ? <>Denial is final for this request; the helper cannot reverse it or restore its approval path. A new authorization requires a new invitation/request.</>
                  : confirmAction?.kind === "cancel"
                    ? <>Cancellation invalidates this invitation and its remaining pending proof attempts. It cannot be used to complete enrollment afterward.</>
                    : <>Revocation disables this runtime credential and invalidates remaining pending proof attempts for this runtime. The runtime loses coordination access; this action cannot be undone by the helper.</>}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {confirmAction?.kind === "request" && confirmAction.decision === "approve" && (
            <div className="flex items-start gap-2 rounded-md border p-3">
              <Checkbox
                id="confirm-local-runtime-verification"
                checked={localVerificationConfirmed}
                onCheckedChange={(value) => setLocalVerificationConfirmed(value === true)}
              />
              <Label htmlFor="confirm-local-runtime-verification" className="text-sm leading-relaxed">
                I compared this request's verification code and fingerprint with the local helper and verified its actor, runtime ID, scope, and expiry.
              </Label>
            </div>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={activeMutation}>Go back</AlertDialogCancel>
            <AlertDialogAction
              disabled={activeMutation || (confirmAction?.kind === "request" && confirmAction.decision === "approve" && !localVerificationConfirmed)}
              onClick={(event) => { event.preventDefault(); handleConfirm(); }}
              className={confirmAction?.kind === "request" && confirmAction.decision === "approve" ? "" : "bg-destructive text-destructive-foreground hover:bg-destructive/90"}
            >
              {activeMutation && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {confirmAction?.kind === "request" && confirmAction.decision === "approve" ? "Confirm approval" :
                confirmAction?.kind === "request" ? "Confirm denial" :
                  confirmAction?.kind === "cancel" ? "Confirm cancellation" : "Confirm revocation"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </main>
  );
}