export interface CentralRecordAccessAudit {
  actor: string;
  runtimeId: string;
  credentialId: string;
  operation: "catalog" | "read" | "markdown";
  recordIds: string[];
  sha256?: string;
  bytes?: number;
  limit?: number;
  offset?: number;
}

/** Explicit projection is also independently testable without loading the DB. */
export function centralRecordAccessAuditValues(event: CentralRecordAccessAudit) {
  return {
    eventType: "central_records_read",
    success: true,
    actor: event.actor,
    runtimeId: event.runtimeId,
    credentialId: event.credentialId,
    // Explicit projection: never persist a credential, request, title or body.
    metadata: {
      operation: event.operation,
      recordIds: event.recordIds,
      ...(event.sha256 !== undefined ? { sha256: event.sha256 } : {}),
      ...(event.bytes !== undefined ? { bytes: event.bytes } : {}),
      ...(event.limit !== undefined ? { limit: event.limit } : {}),
      ...(event.offset !== undefined ? { offset: event.offset } : {}),
    },
  };
}

/** Await before sending content. Reuses the existing singleton and audit table. */
export async function writeCentralRecordAccessAudit(event: CentralRecordAccessAudit): Promise<void> {
  const [{ getSharedDb }, { coordinationCredentialAuditEvents }] = await Promise.all([
    import("../db"), import("@shared/schema"),
  ]);
  await getSharedDb().insert(coordinationCredentialAuditEvents).values(centralRecordAccessAuditValues(event));
}
