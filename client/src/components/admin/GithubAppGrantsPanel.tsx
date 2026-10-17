import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { apiRequest, getQueryFn } from "@/lib/queryClient";

const ADMIN_URL = "/api/coordination/github-grants/admin";
const AGENTS = [
  "luca-claude-code",
  "luca-replit",
  "luca-antigravity",
  "luca-holahola",
  "luca-gemini",
  "luca-cursor",
  "luca-openai-agents",
  "alden",
];

interface Grant {
  id: string;
  actor: string;
  appId: number;
  installationId: number;
  state: string;
  proposedBy: string;
  decidedAt: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}

interface Snapshot {
  grants: Grant[];
  csrfToken: string;
}

type Decision = "approve" | "reject" | "disable" | "enable" | "revoke";

const DECISIONS_BY_STATE: Record<string, Decision[]> = {
  pending: ["approve", "reject", "revoke"],
  active: ["disable", "revoke"],
  disabled: ["enable", "revoke"],
};

function when(value: string | null): string {
  return value ? new Date(value).toLocaleString() : "—";
}

/**
 * Founder controls for per-agent GitHub App grants (plan efb1e3d1 rev 10, A1b).
 * A grant lets one agent ask the server for short-lived GitHub tokens for its
 * own App; the App's private key never leaves the server.
 */
export function GithubAppGrantsPanel() {
  const client = useQueryClient();
  const [actor, setActor] = useState(AGENTS[0]);
  const [appId, setAppId] = useState("");
  const [installationId, setInstallationId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const query = useQuery<Snapshot>({ queryKey: [ADMIN_URL], queryFn: getQueryFn({ on401: "throw" }) });
  const refresh = () => client.invalidateQueries({ queryKey: [ADMIN_URL] });

  const propose = useMutation({
    mutationFn: async () => {
      const response = await apiRequest("POST", "/api/coordination/github-grants", {
        actor, appId: Number(appId), installationId: Number(installationId), csrfToken: query.data?.csrfToken,
      });
      return response.json();
    },
    onSuccess: () => { setError(null); setAppId(""); setInstallationId(""); void refresh(); },
    onError: (err: unknown) => setError(err instanceof Error ? err.message : String(err)),
  });

  const decide = useMutation({
    mutationFn: async ({ id, decision }: { id: string; decision: Decision }) => {
      const response = await apiRequest("POST", `${ADMIN_URL}/${encodeURIComponent(id)}/${decision}`, { csrfToken: query.data?.csrfToken });
      return response.json();
    },
    onSuccess: () => { setError(null); void refresh(); },
    onError: (err: unknown) => setError(err instanceof Error ? err.message : String(err)),
  });

  const confirmDecision = (grant: Grant, decision: Decision) => {
    const text = decision === "approve"
      ? `Approve ${grant.actor} to receive GitHub tokens for App ${grant.appId} (installation ${grant.installationId})? Tokens are limited to HolaHola, contents and pull requests, 1 hour each. The grant expires in 90 days.`
      : `${decision[0].toUpperCase()}${decision.slice(1)} the GitHub grant for ${grant.actor}?${decision === "revoke" || decision === "disable" ? " New tokens stop immediately; tokens already issued expire within 1 hour. Suspend the App installation on GitHub for an immediate cut-off." : ""}`;
    if (window.confirm(text)) decide.mutate({ id: grant.id, decision });
  };

  return (
    <Card data-testid="github-app-grants-panel">
      <CardHeader>
        <CardTitle>GitHub App grants</CardTitle>
        <CardDescription>
          Each agent has its own GitHub App. A grant lets that agent get short-lived GitHub tokens for its own App, for the HolaHola repository only. You approve, disable and revoke grants here.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {error && <p className="text-sm text-destructive" data-testid="github-grants-error">{error}</p>}
        <div className="grid gap-3 md:grid-cols-4 md:items-end">
          <div className="space-y-1">
            <Label>Agent</Label>
            <Select value={actor} onValueChange={setActor}>
              <SelectTrigger data-testid="github-grant-actor"><SelectValue /></SelectTrigger>
              <SelectContent>{AGENTS.map((a) => <SelectItem key={a} value={a}>{a}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="github-grant-app-id">App ID</Label>
            <Input id="github-grant-app-id" inputMode="numeric" value={appId} onChange={(e) => setAppId(e.target.value.trim())} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="github-grant-installation-id">Installation ID</Label>
            <Input id="github-grant-installation-id" inputMode="numeric" value={installationId} onChange={(e) => setInstallationId(e.target.value.trim())} />
          </div>
          <Button
            data-testid="github-grant-propose"
            disabled={propose.isPending || !appId || !installationId || !query.data}
            onClick={() => propose.mutate()}
          >
            {propose.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}Propose grant
          </Button>
        </div>
        {query.isLoading ? (
          <p className="text-sm text-muted-foreground">Loading grants…</p>
        ) : !query.data?.grants.length ? (
          <p className="text-sm text-muted-foreground">No grants yet.</p>
        ) : (
          <div className="space-y-2">
            {query.data.grants.map((grant) => (
              <div key={grant.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-3 text-sm" data-testid={`github-grant-${grant.id}`}>
                <div className="space-y-1">
                  <div className="flex items-center gap-2">
                    <span className="font-medium">{grant.actor}</span>
                    <Badge variant={grant.state === "active" ? "default" : "secondary"}>{grant.state}</Badge>
                  </div>
                  <div className="text-muted-foreground">
                    App {grant.appId} · installation {grant.installationId} · proposed by {grant.proposedBy} · expires {when(grant.expiresAt)}
                  </div>
                </div>
                <div className="flex gap-2">
                  {(DECISIONS_BY_STATE[grant.state] ?? []).map((decision) => (
                    <Button
                      key={decision}
                      size="sm"
                      variant={decision === "approve" || decision === "enable" ? "default" : "outline"}
                      disabled={decide.isPending}
                      onClick={() => confirmDecision(grant, decision)}
                    >
                      {decision}
                    </Button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
