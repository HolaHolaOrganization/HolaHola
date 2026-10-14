export type ApprovalPromotionDescriptor = {
  purpose: "cross-tool-promote";
  repository: string;
  branch: string;
  candidateCommit: string;
};

export type PromotionApprovalContext = {
  status: "context_free" | "verified" | "descriptor_missing" | "storage_unavailable" | "hash_mismatch" | "invalid";
  contextDigest: string | null;
  computedDigest?: string;
  descriptor?: ApprovalPromotionDescriptor;
};
