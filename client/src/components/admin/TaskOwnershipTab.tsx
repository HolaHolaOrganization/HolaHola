import { useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { AlertTriangle, Check, Clock3, Fingerprint, KeyRound, RefreshCw, ShieldCheck, X, XCircle } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import type { OwnershipApprovalScope } from "@shared/task-ownership-scope";
import { TaskOwnershipScope } from "./TaskOwnershipScope";
import { PromotionApprovalContext } from "./PromotionApprovalContext";
import type { PromotionApprovalContext as PromotionContext } from "@shared/promotion-approval-context";

type Receipt = { id: string; status: string; expiresAt: string; revokedAt?: string | null };
type Challenge = {
  id: string;
  taskRef: string;
  artifactSha256: string;
  intendedActor: string;
  keyFingerprint: string;
  contextDigest?: string | null;
  scopeContext?: OwnershipApprovalScope;
  promotionContext?: PromotionContext;
  status: string;
  expiresAt: string;
  createdAt: string;
  decidedAt?: string | null;
  receipt?: Receipt | null;
};
type Action = "approve" | "reject" | "revoke";

const dateTime = (value?: string | null) => value ? new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value)) : "Not recorded";
const shortId = (value: string) => value.length > 26 ? `${value.slice(0, 13)}…${value.slice(-11)}` : value;
const reviewable = (challenge: Challenge) => challenge.contextDigest == null ||
  (challenge.promotionContext?.status === "verified" &&
   challenge.promotionContext.contextDigest === challenge.contextDigest &&
   challenge.promotionContext.computedDigest === challenge.contextDigest &&
   !!challenge.promotionContext.descriptor);

export function TaskOwnershipTab() {
  const { toast } = useToast();
  const [dialog, setDialog] = useState<{ action: Action; challenge: Challenge } | null>(null);
  const [reason, setReason] = useState("");
  const { data, isLoading, isError, refetch, isFetching } = useQuery<Challenge[]>({
    queryKey: ["/api/task-ownership/challenges"],
  });
  const actionMutation = useMutation({
    mutationFn: async ({ action, challenge, reason: actionReason }: { action: Action; challenge: Challenge; reason?: string }) => {
      const path = action === "revoke"
        ? `/api/task-ownership/receipts/${challenge.receipt?.id}/revoke`
        : `/api/task-ownership/challenges/${challenge.id}/${action}`;
      const response = await apiRequest("POST", path, actionReason ? { reason: actionReason } : {});
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/task-ownership/challenges"] });
      setDialog(null);
      setReason("");
    },
  });

  const challenges = useMemo(() => data ?? [], [data]);
  const pendingCount = challenges.filter((item) => item.status.toLowerCase() === "pending").length;
  const openDialog = (action: Action, challenge: Challenge) => {
    actionMutation.reset();
    setReason("");
    setDialog({ action, challenge });
  };
  const confirm = () => {
    if (!dialog) return;
    const now = Date.now();
    const isExpired = new Date(dialog.challenge.expiresAt).getTime() <= now;
    const isPending = dialog.challenge.status.toLowerCase() === "pending";
    if (dialog.action === "approve" && !reviewable(dialog.challenge)) {
      toast({ variant: "destructive", title: "Promotion context is not reviewable", description: "A matching readable candidate descriptor is required before approval." });
      return;
    }
    const receiptExpired = dialog.challenge.receipt
      ? new Date(dialog.challenge.receipt.expiresAt).getTime() <= now
      : true;
    if ((dialog.action !== "revoke" && (!isPending || isExpired)) || (dialog.action === "revoke" && (!dialog.challenge.receipt || receiptExpired))) {
      setDialog(null);
      toast({ variant: "destructive", title: "Decision no longer available", description: "This challenge or receipt is stale or expired. Refresh the ledger before trying again." });
      return;
    }
    actionMutation.mutate({ action: dialog.action, challenge: dialog.challenge, reason: reason.trim() || undefined });
  };

  return (
    <div className="space-y-5" data-testid="task-ownership-panel">
      <Card className="border-primary/20 bg-primary/[0.03]">
        <CardHeader className="pb-4">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div className="flex gap-3">
              <div className="rounded-md border border-primary/20 bg-primary/10 p-2 text-primary"><KeyRound className="h-5 w-5" /></div>
              <div>
                <CardTitle className="text-lg">Task ownership approvals</CardTitle>
                <CardDescription className="mt-1 max-w-3xl">A founder decision binds a task to a cryptographic actor before execution.</CardDescription>
              </div>
            </div>
            <Badge variant="outline" className="w-fit gap-1.5"><ShieldCheck className="h-3.5 w-3.5" /> Founder-only surface</Badge>
          </div>
        </CardHeader>
        <CardContent>
          <Alert className="border-amber-500/30 bg-amber-500/[0.06]">
            <AlertTriangle className="h-4 w-4 text-amber-600" />
            <AlertTitle>What approval proves</AlertTitle>
            <AlertDescription>Review requests in Command Center → System → Ownership. Approval authorizes the process holding that private key for this task; it does not independently prove Replit sandbox identity. Registry metadata is informational, not approval or ownership proof.</AlertDescription>
          </Alert>
        </CardContent>
      </Card>

      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold">Challenge ledger</h2>
          <p className="text-sm text-muted-foreground">{pendingCount} awaiting decision · {challenges.length} total</p>
        </div>
        <Button variant="outline" size="sm" onClick={() => refetch()} disabled={isFetching} aria-label="Refresh task ownership challenges" data-testid="button-refresh-task-ownership">
          <RefreshCw className={`mr-2 h-4 w-4 ${isFetching ? "animate-spin" : ""}`} /> Refresh
        </Button>
      </div>

      {isLoading && <div className="space-y-3" data-testid="task-ownership-loading">{[1, 2].map((item) => <Skeleton key={item} className="h-64 w-full rounded-lg" />)}</div>}
      {isError && (
        <Card data-testid="task-ownership-error">
          <CardContent className="flex flex-col items-center gap-3 py-12 text-center">
            <XCircle className="h-8 w-8 text-destructive" />
            <div><p className="font-medium">Challenges could not be loaded</p><p className="text-sm text-muted-foreground">The approval ledger is unavailable. No action has been taken.</p></div>
            <Button variant="outline" onClick={() => refetch()}>Try again</Button>
          </CardContent>
        </Card>
      )}
      {!isLoading && !isError && challenges.length === 0 && (
        <Card data-testid="task-ownership-empty">
          <CardContent className="flex flex-col items-center gap-3 py-14 text-center">
            <Check className="h-8 w-8 text-emerald-600" />
            <div><p className="font-medium">No ownership challenges</p><p className="text-sm text-muted-foreground">There are no task claims waiting for a founder decision.</p></div>
          </CardContent>
        </Card>
      )}

      <div className="space-y-3">
        {challenges.map((challenge) => {
          const pending = challenge.status.toLowerCase() === "pending";
          const expired = new Date(challenge.expiresAt).getTime() <= Date.now();
          const receiptActive = !!challenge.receipt && challenge.receipt.status.toLowerCase() !== "revoked" && !challenge.receipt.revokedAt;
          const receiptExpired = !!challenge.receipt && new Date(challenge.receipt.expiresAt).getTime() <= Date.now();
          const canRevoke = receiptActive && !receiptExpired;
          return (
            <Card key={challenge.id} className={pending && !expired ? "border-primary/30" : ""} data-testid={`task-ownership-challenge-${challenge.id}`}>
              <CardHeader className="pb-3">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <div className="min-w-0">
                    <CardTitle className="flex items-center gap-2 text-base"><span className="truncate">{challenge.taskRef}</span><Badge variant={pending && !expired ? "default" : "secondary"}>{expired && pending ? "Challenge expired" : challenge.status}</Badge></CardTitle>
                    <CardDescription className="mt-1">Challenge {shortId(challenge.id)}</CardDescription>
                  </div>
                  <div className="flex shrink-0 gap-2">
                    <Button size="sm" onClick={() => openDialog("approve", challenge)} disabled={!pending || expired || actionMutation.isPending || !reviewable(challenge)} data-testid={`button-approve-${challenge.id}`}><Check className="mr-1.5 h-4 w-4" /> Approve</Button>
                    <Button size="sm" variant="outline" onClick={() => openDialog("reject", challenge)} disabled={!pending || expired || actionMutation.isPending} data-testid={`button-reject-${challenge.id}`}><X className="mr-1.5 h-4 w-4" /> Reject</Button>
                    {challenge.receipt && <Button size="sm" variant="destructive" onClick={() => openDialog("revoke", challenge)} disabled={!canRevoke || actionMutation.isPending} data-testid={`button-revoke-${challenge.id}`}><ShieldCheck className="mr-1.5 h-4 w-4" /> Revoke receipt</Button>}
                  </div>
                </div>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                  <Detail label="Intended actor" value={challenge.intendedActor} icon={<ShieldCheck />} />
                  <Detail label="Created" value={dateTime(challenge.createdAt)} icon={<Clock3 />} />
                  <Detail label="Expires" value={dateTime(challenge.expiresAt)} icon={<Clock3 />} warning={expired} />
                  <Detail label="Decided" value={dateTime(challenge.decidedAt)} icon={<Check />} />
                </div>
                <Digest label="Artifact SHA-256" value={challenge.artifactSha256} />
                <Digest label="Public-key fingerprint" value={challenge.keyFingerprint} icon={<Fingerprint />} />
                <TaskOwnershipScope context={challenge.scopeContext} />
                <PromotionApprovalContext context={challenge.promotionContext} contextDigest={challenge.contextDigest} />
                <div className="rounded-md border bg-muted/30 p-3 text-sm">
                  <span className="font-medium">Receipt: </span>{challenge.receipt ? `${challenge.receipt.status} · expires ${dateTime(challenge.receipt.expiresAt)}${challenge.receipt.revokedAt ? ` · revoked ${dateTime(challenge.receipt.revokedAt)}` : ""}` : "Not issued"}
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>

      <AlertDialog open={!!dialog} onOpenChange={(open) => !open && !actionMutation.isPending && setDialog(null)}>
        <AlertDialogContent data-testid="task-ownership-confirmation">
          <AlertDialogHeader>
            <AlertDialogTitle>{dialog?.action === "approve" ? "Approve task ownership?" : dialog?.action === "reject" ? "Reject task ownership?" : "Revoke receipt?"}</AlertDialogTitle>
            <AlertDialogDescription>
              {dialog?.action === "approve" ? "This authorizes the process holding the listed private key for this task. It does not independently prove Replit sandbox identity." : "This decision changes the authorization state for this task. Confirm only if you have reviewed the digests and actor fingerprint."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {dialog && <div className="max-h-[40vh] space-y-3 overflow-y-auto"><TaskOwnershipScope context={dialog.challenge.scopeContext} /><PromotionApprovalContext context={dialog.challenge.promotionContext} contextDigest={dialog.challenge.contextDigest} /></div>}
          {actionMutation.isError && <Alert variant="destructive"><AlertTitle>Decision failed</AlertTitle><AlertDescription>{actionMutation.error instanceof Error ? actionMutation.error.message : "The server refused this decision."}</AlertDescription></Alert>}
          <div className="space-y-2"><Label htmlFor="ownership-reason">Reason <span className="font-normal text-muted-foreground">(optional)</span></Label><Textarea id="ownership-reason" value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Record the operational basis for this decision" data-testid="input-ownership-reason" /></div>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={actionMutation.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={(event) => { event.preventDefault(); confirm(); }} disabled={actionMutation.isPending}>
              {actionMutation.isPending ? "Submitting…" : `Confirm ${dialog?.action}`}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function Detail({ label, value, icon, warning }: { label: string; value: string; icon: React.ReactNode; warning?: boolean }) {
  return <div className="min-w-0"><div className="mb-1 flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">{icon && <span className={warning ? "text-amber-600" : ""}>{icon}</span>}{label}</div><p className={`truncate text-sm ${warning ? "font-medium text-amber-700" : ""}`}>{value}</p></div>;
}

function Digest({ label, value, icon }: { label: string; value: string; icon?: React.ReactNode }) {
  return <div className="rounded-md border bg-muted/20 p-3"><div className="mb-1 flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">{icon}{label}</div><code className="block break-all font-mono text-xs text-foreground/80">{value}</code></div>;
}