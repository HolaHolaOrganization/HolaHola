import React from "react";
import type { PromotionApprovalContext as Context } from "@shared/promotion-approval-context";
import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert";

export function PromotionApprovalContext({ context, contextDigest }: { context?: Context; contextDigest?: string | null }) {
  if (contextDigest == null) return <p className="text-sm text-muted-foreground" data-testid="promotion-context-free">Context-free task approval — no release candidate is approved by this request.</p>;
  if (context?.status === "verified" && context.descriptor && context.contextDigest === contextDigest) {
    const descriptor = context.descriptor;
    return <section className="space-y-2 rounded-md border p-3 text-sm" data-testid="promotion-context-verified">
      <h3 className="font-semibold">Exact promotion candidate — digest verified</h3>
      <dl className="space-y-2">
        {Object.entries({ Purpose: descriptor.purpose, Repository: descriptor.repository, Branch: descriptor.branch, "Candidate commit": descriptor.candidateCommit, "Submitted context SHA-256": contextDigest, "Recomputed context SHA-256": context.computedDigest ?? "" }).map(([label, value]) => <div key={label}><dt className="text-xs text-muted-foreground">{label}</dt><dd className="break-all">{value}</dd></div>)}
      </dl>
      <p className="text-muted-foreground">This descriptor names the exact candidate, not the task starting commit. It is not a live remote-head check. Execution must independently recheck the branch and commit. Metadata alone grants no authority.</p>
    </section>;
  }
  const status = context?.status ?? "descriptor_missing";
  const explanation = status === "storage_unavailable" ? "Promotion-context storage is unavailable or has not been rolled out." :
    status === "descriptor_missing" ? "This opaque digest has no stored, readable candidate descriptor. Request a new challenge using the updated client." :
    "The descriptor, parent challenge or digest cannot be verified.";
  return <Alert variant="destructive" data-testid={`promotion-context-${status}`}><AlertTitle>Promotion context is not reviewable</AlertTitle><AlertDescription>{explanation} Approval is unavailable; rejection or receipt revocation remains available.<div className="mt-2 break-all">Submitted context SHA-256: {contextDigest}</div></AlertDescription></Alert>;
}
