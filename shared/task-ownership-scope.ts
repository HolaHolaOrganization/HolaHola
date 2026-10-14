export type OwnershipScopeStatus =
  | "verified"
  | "missing_registry"
  | "unregistered_bootstrap"
  | "metadata_unavailable"
  | "hash_mismatch"
  | "registry_unavailable"
  | "registry_invalid";

export interface OwnershipApprovalScope {
  status: OwnershipScopeStatus;
  taskRef: string;
  submittedArtifactSha256: string;
  registeredArtifactSha256?: string;
  artifactHashMatch: boolean | null;
  definition?: {
    title: string;
    purpose: string;
    scope: string[];
    exclusions: string[];
    creatorActor: string;
    sourceThread: string;
    sourceKind: string;
    repositoryIdentity: string;
    startingCommit: string;
  };
}
