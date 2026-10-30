import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { TaskOwnershipService } from "./task-ownership-service";
import { assertOwnershipForInfraMutation, type OwnershipProbe } from "./infra-mutation-guard";
import { proveStandaloneTaskOwnership, type TaskOwnershipHttpClient } from "./task-ownership-client";

/** No proof cache: revocation/expiry must be checked again at every boundary. */
export function createEpisodeBackupOwnership(input: {
  taskRef: string; actor: string; receiptId: string; client: TaskOwnershipHttpClient;
  rootDir?: string;
}): { probe: OwnershipProbe; authorize: (action: string) => Promise<void> } {
  const rootDir = resolve(input.rootDir ?? process.cwd());
  const artifact = resolve(rootDir, ".local/tasks", `task-${input.taskRef}.md`);
  if (!/^[1-9][0-9]*$/.test(input.taskRef) || input.actor !== "luca-replit") {
    throw new Error("Backup requires its exact task and own Replit actor");
  }
  const probe: OwnershipProbe = async (ref, actor) => {
    if (ref !== input.taskRef || (actor !== undefined && actor !== input.actor)) {
      throw new Error("Backup ownership binding mismatch");
    }
    return new TaskOwnershipService({
      rootDir,
      verifyActiveIsolatedProof: async (taskRef, digest) => {
        if (!digest) return false;
        const before = await lstat(artifact);
        if (!before.isFile() || before.isSymbolicLink()) return false;
        await proveStandaloneTaskOwnership(
          input.client, taskRef, input.actor, input.receiptId, digest,
        );
        const after = await lstat(artifact);
        return after.isFile() && !after.isSymbolicLink()
          && createHash("sha256").update(await readFile(artifact)).digest("hex") === digest;
      },
    }).probe(ref);
  };
  return {
    probe,
    authorize: async action => {
      await assertOwnershipForInfraMutation(input.taskRef, action, probe, input.actor);
    },
  };
}
