import { isDirectCliInvocation } from "./lib/cli-entrypoint";

class UsageError extends Error {}

function parseArgs(): { bundle: string; receiptId: string; attemptId: string } {
  const values: Record<string, string> = {};
  const allowed = new Set(["--bundle", "--receipt-id", "--attempt-id"]);
  for (let i = 2; i < process.argv.length; i += 2) {
    const flag = process.argv[i];
    if (!allowed.has(flag) || values[flag]) throw new UsageError();
    const value = process.argv[i + 1];
    if (!value || value.startsWith("--")) throw new UsageError();
    values[flag] = value;
  }
  if (process.argv.length % 2 !== 0 || Object.keys(values).length !== 3) throw new UsageError();
  return { bundle: values["--bundle"], receiptId: values["--receipt-id"], attemptId: values["--attempt-id"] };
}

if (isDirectCliInvocation("coordination-gate3-assignment-window.ts")) {
  (async () => {
    let closeDbConnections: (() => Promise<void>) | undefined;
    const originalLog = console.log;
    console.log = (...args: unknown[]) => console.error(...args);
    try {
      const args = parseArgs();
      const service = await import("../services/coordination-gate3-assignment-window-service");
      ({ closeDbConnections } = await import("../db"));
      const result = await service.createGate3AssignmentWindow({
        bundle: await service.readGate3AssignmentBundle(args.bundle),
        receiptId: args.receiptId,
        assignmentAttemptId: args.attemptId,
      });
      await closeDbConnections();
      closeDbConnections = undefined;
      console.log = originalLog;
      process.stdout.write(`${JSON.stringify(result)}\n`);
    } catch (error) {
      if (closeDbConnections) await closeDbConnections().catch(() => undefined);
      console.log = originalLog;
      if (error instanceof UsageError) {
        process.stderr.write("gate3_assignment_window_usage\n");
      } else if (
        error
        && typeof error === "object"
        && "name" in error
        && error.name === "Gate3AssignmentWindowError"
        && "message" in error
      ) {
        process.stderr.write(`${String(error.message)}\n`);
      } else {
        process.stderr.write("gate3_assignment_window_failed\n");
      }
      process.exitCode = 1;
    }
  })();
}