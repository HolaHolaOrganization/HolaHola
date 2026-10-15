import { createHash } from "node:crypto";

export const GATE3_TASK_ARTIFACT_MAX_BYTES = 64 * 1024;
export const GATE3_STARTING_COMMIT_PLACEHOLDER = "__FINAL_STARTING_COMMIT__";

export type Gate3TaskArtifactMaterializationCode =
  | "artifact_invalid"
  | "artifact_line_endings_invalid"
  | "artifact_template_invalid"
  | "starting_commit_invalid";

export class Gate3TaskArtifactMaterializationError extends Error {
  readonly code: Gate3TaskArtifactMaterializationCode;

  constructor(code: Gate3TaskArtifactMaterializationCode) {
    super(code);
    this.name = "Gate3TaskArtifactMaterializationError";
    this.code = code;
  }
}

const fail = (code: Gate3TaskArtifactMaterializationCode): never => {
  throw new Gate3TaskArtifactMaterializationError(code);
};

export function materializeGate3TaskArtifact(
  templateBytes: Uint8Array,
  startingCommit: string,
): { text: string; bytes: Uint8Array; sha256: string } {
  if (
    templateBytes.byteLength < 1
    || templateBytes.byteLength > GATE3_TASK_ARTIFACT_MAX_BYTES
  ) {
    fail("artifact_invalid");
  }
  if (!/^[0-9a-f]{40}$|^[0-9a-f]{64}$/.test(startingCommit)) {
    fail("starting_commit_invalid");
  }

  let sourceText: string;
  try {
    sourceText = new TextDecoder("utf-8", { fatal: true }).decode(templateBytes);
  } catch {
    fail("artifact_invalid");
  }
  if (/\r(?!\n)/.test(sourceText!)) {
    fail("artifact_line_endings_invalid");
  }

  const templateText = sourceText!.replace(/\r\n/g, "\n");
  const occurrences = templateText.split(GATE3_STARTING_COMMIT_PLACEHOLDER).length - 1;
  if (occurrences !== 1) {
    fail("artifact_template_invalid");
  }

  const text = templateText.replace(GATE3_STARTING_COMMIT_PLACEHOLDER, startingCommit);
  const bytes = new TextEncoder().encode(text);
  if (bytes.byteLength > GATE3_TASK_ARTIFACT_MAX_BYTES) {
    fail("artifact_invalid");
  }
  return {
    text,
    bytes,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}