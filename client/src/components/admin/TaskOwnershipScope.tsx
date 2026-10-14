import React from "react";
import type { OwnershipApprovalScope } from "@shared/task-ownership-scope";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";

const unavailable = {
  missing_registry: ["No registry record", "This task has no canonical registry record. No scope has been inferred from its reference or local files."],
  unregistered_bootstrap: ["Unregistered bootstrap artifact", "This reference has a bootstrap reservation, but no immutable task definition is registered. A reservation is not verified scope or approval."],
  metadata_unavailable: ["Scope or provenance unavailable", "The artifact hash matches, but the registry lacks structured scope or authenticated creator/source-thread provenance. Legacy publisher claims are not authenticated authorship."],
  hash_mismatch: ["Artifact mismatch", "The submitted artifact does not match the registered artifact. The registered scope does not verify this request."],
  registry_unavailable: ["Registry unavailable", "Canonical scope could not be retrieved. Challenge and receipt states have not been changed."],
  registry_invalid: ["Registry integrity check failed", "The registry record or its artifact bytes could not be verified. No scope is presented as canonical."],
} as const;

export function TaskOwnershipScope({ context }: { context?: OwnershipApprovalScope }) {
  if (!context) {
    return <Alert data-testid="task-scope-unavailable"><AlertTitle>Scope metadata unavailable</AlertTitle><AlertDescription>This server response does not include verified task scope. No scope has been inferred.</AlertDescription></Alert>;
  }
  const definition = context.status === "verified" ? context.definition : undefined;
  return (
    <section className="space-y-3 rounded-md border p-3 text-sm" data-testid={`task-scope-${context.status}`}>
      <h3 className="font-semibold">Task scope — immutable registry</h3>
      {definition ? (
        <>
          <p className="font-medium">{definition.title}</p>
          <p className="whitespace-pre-wrap break-words">{definition.purpose}</p>
          <ScopeList title="Included scope" items={definition.scope} />
          <ScopeList title="Exclusions" items={definition.exclusions} />
          <dl className="grid gap-2 sm:grid-cols-2">
            <Fact label="Authenticated registry creator" value={definition.creatorActor} />
            <Fact label="Source thread" value={definition.sourceThread} />
            <Fact label="Registry source kind" value={definition.sourceKind} />
            <Fact label="Repository" value={definition.repositoryIdentity} />
            <Fact label="Task starting commit" value={definition.startingCommit} />
          </dl>
          {definition.sourceKind === "replit" && <p className="text-muted-foreground">The registry creator is authenticated; external Replit provenance is declared, not independently verified.</p>}
          <p className="font-medium text-emerald-700 dark:text-emerald-400">Exact artifact hash matches the registered bytes.</p>
        </>
      ) : (
        <Alert><AlertTitle>{unavailable[context.status === "verified" ? "registry_invalid" : context.status][0]}</AlertTitle><AlertDescription>{unavailable[context.status === "verified" ? "registry_invalid" : context.status][1]}</AlertDescription></Alert>
      )}
      <dl className="space-y-2">
        <Fact label="Submitted artifact SHA-256" value={context.submittedArtifactSha256} />
        {context.registeredArtifactSha256 && <Fact label="Registered artifact SHA-256" value={context.registeredArtifactSha256} />}
      </dl>
      <p className="text-muted-foreground">Registry metadata does not grant approval, ownership, execution or publication authority. Actor, artifact and key bindings and your founder decision remain required.</p>
    </section>
  );
}

function ScopeList({ title, items }: { title: string; items: string[] }) {
  return <div><h4 className="font-medium">{title}</h4>{items.length ? <ul className="ml-5 list-disc space-y-1">{items.map((item, index) => <li key={index} className="whitespace-pre-wrap break-words">{item}</li>)}</ul> : <p className="text-muted-foreground">None recorded.</p>}</div>;
}

function Fact({ label, value }: { label: string; value: string }) {
  return <div className="min-w-0"><dt className="text-xs text-muted-foreground">{label}</dt><dd className="break-all">{value}</dd></div>;
}
