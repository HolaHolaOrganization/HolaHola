import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";

type Grant = { id: string; runtimeId: string; actor: string; expiresAt: string; revokedAt: string | null };
type Decision = { kind: "grant"; runtimeId: string; actor: string; expiresAt: string; expectedGrantId: string | null }
  | { kind: "revoke"; grant: Grant };
type Snapshot = {
  csrfToken: string;
  maximumExpiresAt: string;
  runtimes: { runtimeId: string; actor: string; displayName: string; enabled: boolean }[];
  grants: Grant[];
};
const endpoint = "/api/runtime/central-read/admin";
function localDateTime(iso: string) {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}T${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}
async function request(path: string, body?: unknown) {
  const response = await fetch(path, { credentials: "same-origin",
    ...(body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? "Central-read permissions are unavailable.");
  return result;
}
export function CentralReadGrantsPanel() {
  const cache = useQueryClient();
  const query = useQuery<Snapshot>({ queryKey: [endpoint], queryFn: () => request(endpoint), retry: false });
  const [runtimeId, setRuntimeId] = useState("");
  const [expiresAt, setExpiresAt] = useState("");
  const [confirm, setConfirm] = useState<Decision | null>(null);
  const runtime = query.data?.runtimes.find(r => r.runtimeId === runtimeId);
  const maximumExpiry = query.data?.maximumExpiresAt;
  const invalidExpiry = !expiresAt || !Number.isFinite(new Date(expiresAt).getTime())
    || !maximumExpiry || new Date(expiresAt).getTime() > Date.parse(maximumExpiry);
  const previous = query.data?.grants.find(g => g.runtimeId === runtimeId && !g.revokedAt);
  const mutation = useMutation({
    mutationFn: async (decision: Decision) => {
      if (!query.data?.csrfToken) throw new Error("Refresh permissions before continuing.");
      if (decision.kind === "grant") {
        return request(`${endpoint}/grants`, { runtimeId: decision.runtimeId, actor: decision.actor,
          expiresAt: decision.expiresAt, expectedGrantId: decision.expectedGrantId,
          csrfToken: query.data.csrfToken });
      }
      return request(`${endpoint}/grants/${decision.grant.id}/revoke`, { csrfToken: query.data.csrfToken });
    },
    onSuccess: () => { setConfirm(null); void cache.invalidateQueries({ queryKey: [endpoint] }); },
  });
  return <Card>
    <CardHeader>
      <CardTitle>Central record access</CardTitle>
      <CardDescription>Founder-only permission for one exact runtime to read canonical episodes and stories.
        Ordinary coordination credentials remain unchanged. Document access is not enabled here.</CardDescription>
    </CardHeader>
    <CardContent className="space-y-4">
      {query.isLoading && <p role="status">Loading permissions…</p>}
      {query.error && <Alert variant="destructive"><AlertDescription>
        Permission status unavailable: {query.error.message}. No access changes have been made.
        <Button variant="outline" className="ml-2" onClick={() => query.refetch()}>Retry</Button>
      </AlertDescription></Alert>}
      {query.data && <>
        <form className="grid gap-4 sm:grid-cols-2" onSubmit={event => {
          event.preventDefault();
          if (runtime?.enabled && !invalidExpiry) {
            // Freeze what the founder reviewed. A background query refresh must
            // never advance expectedGrantId while this confirmation is open.
            setConfirm({ kind: "grant", runtimeId, actor: runtime.actor,
              expiresAt: new Date(expiresAt).toISOString(), expectedGrantId: previous?.id ?? null });
          }
        }}>
          <div className="space-y-2">
            <Label htmlFor="central-runtime">Exact runtime</Label>
            <select id="central-runtime" required value={runtimeId} disabled={mutation.isPending}
              onChange={event => setRuntimeId(event.target.value)}
              className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm">
              <option value="">Choose a runtime</option>
              {query.data.runtimes.map(r => <option key={r.runtimeId} value={r.runtimeId} disabled={!r.enabled}>
                {r.actor} / {r.runtimeId}{r.enabled ? "" : " (disabled)"}
              </option>)}
            </select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="central-expiry">Grant expires at your local time</Label>
            <Input id="central-expiry" type="datetime-local" required value={expiresAt}
              max={maximumExpiry ? localDateTime(maximumExpiry) : undefined}
              disabled={mutation.isPending} onChange={event => setExpiresAt(event.target.value)} />
            <p className="text-sm text-muted-foreground">Maximum: one calendar year from database time. A founder-inbox warning is sent within the final 14 days.</p>
            {expiresAt && invalidExpiry && <p role="alert" className="text-sm text-destructive">Choose a valid expiry no later than the one-year limit.</p>}
          </div>
          <Button type="submit" disabled={!runtime?.enabled || invalidExpiry || mutation.isPending}>
            Review {previous ? "replacement" : "grant"}
          </Button>
        </form>
        <p className="text-sm text-muted-foreground">
          The runtime pulls its own five-minute, read-only token. No token is displayed to you.
          Revocation blocks subsequent central-read authentication; a request already authenticated may finish.
        </p>
        <ul className="space-y-3" aria-label="Central record grants">
          {query.data.grants.length === 0 && <li className="text-sm text-muted-foreground">No grants.</li>}
          {query.data.grants.map(grant => <li key={grant.id} className="flex flex-wrap items-center justify-between gap-3 rounded-md border p-3">
            <div className="min-w-0 text-sm">
              <p className="break-all font-medium">{grant.actor} / {grant.runtimeId}</p>
              <p>{grant.revokedAt ? "Revoked" : new Date(grant.expiresAt) <= new Date() ? "Expired" : "Granted"}
                {" · "}{new Date(grant.expiresAt).toLocaleString()}</p>
            </div>
            {!grant.revokedAt && <Button variant="outline" disabled={mutation.isPending}
              onClick={() => setConfirm({ kind: "revoke", grant })}>Review revocation</Button>}
          </li>)}
        </ul>
      </>}
      {mutation.error && <Alert variant="destructive"><AlertDescription>{mutation.error.message}</AlertDescription></Alert>}
      <AlertDialog open={!!confirm} onOpenChange={open => { if (!open && !mutation.isPending) setConfirm(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{confirm?.kind === "grant" ? "Grant central-record reading?" : "Revoke central-record reading?"}</AlertDialogTitle>
            <AlertDialogDescription>
              {confirm?.kind === "grant" ? `${confirm.actor} / ${confirm.runtimeId}, until ${new Date(confirm.expiresAt).toLocaleString()}. Scope: central-records:read only.
              ${confirm.expectedGrantId ? "The previous grant and its read tokens will stop authorizing new requests." : ""}`
                : `${confirm?.grant.actor} / ${confirm?.grant.runtimeId}. Its central-read tokens will stop authorizing new requests.
                Ordinary coordination access is not revoked.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={mutation.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction disabled={mutation.isPending} onClick={event => {
              event.preventDefault(); if (confirm) mutation.mutate(confirm);
            }}>{mutation.isPending ? "Saving…" : "Confirm"}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </CardContent>
  </Card>;
}
