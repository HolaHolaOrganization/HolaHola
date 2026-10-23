import { isDirectCliInvocation } from "./lib/cli-entrypoint";

type Options = Record<string, string | boolean>;

const commands = new Set(["list", "show", "show-review", "my-reviews", "create", "revision", "ready", "claim", "approve", "reject", "export", "share", "pull", "resync"]);
const mutationCommands = new Set(["create", "revision", "ready", "claim", "approve", "reject", "share"]);
// Fast-share notes live in a fixed flat namespace (see canonicalNotePathPattern
// in shared-spec-core.ts). This default lets `share`/`pull` omit --repository
// for the common case of one shared space across all of Luca's hats.
const DEFAULT_NOTE_REPOSITORY = "luca-hats/notes";

export interface SharedSpecCliDependencies {
  readonly fetchImpl?: typeof fetch;
  readonly writeOutput?: (output: string) => void;
  readonly writeFile?: (path: string, content: string) => void;
}

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(64);
}
function parse(argv: string[]): { command: string; options: Options } {
  const command = argv.shift();
  if (!command || !commands.has(command)) fail("Usage: shared-spec-cli <list|show|show-review|my-reviews|create|revision|ready|claim|approve|reject|export|share|pull|resync> --url URL --token TOKEN");
  const options: Options = {};
  while (argv.length) {
    const part = argv.shift()!;
    if (!part.startsWith("--")) fail(`Unexpected argument: ${part}`);
    const name = part.slice(2);
    const value = argv[0] && !argv[0].startsWith("--") ? argv.shift()! : true;
    if (!name || options[name] !== undefined) fail(`Invalid or repeated option: ${part}`);
    options[name] = value;
  }
  return { command, options };
}
function required(options: Options, name: string): string {
  const value = options[name];
  if (typeof value !== "string" || !value) fail(`--${name} is required`);
  return value;
}
function json(value: string | boolean | undefined, name: string): unknown {
  if (typeof value !== "string") return undefined;
  try { return JSON.parse(value); } catch { fail(`--${name} must be JSON`); }
}
function notePath(options: Options): string {
  const value = required(options, "path").trim();
  const withPrefix = value.startsWith("notes/") ? value : `notes/${value}`;
  return withPrefix.endsWith(".md") ? withPrefix : `${withPrefix}.md`;
}
function noteRepository(options: Options): string {
  return typeof options.repository === "string" && options.repository ? options.repository : DEFAULT_NOTE_REPOSITORY;
}

/** `pull` needs the document plus its revision history, so it makes two requests instead of the generic single-request dispatch below. */
async function runPull(baseUrl: string, token: string, options: Options, dependencies: SharedSpecCliDependencies): Promise<void> {
  const headers: Record<string, string> = { "x-shared-spec-token": token };
  const get = async (path: string): Promise<any> => {
    const response = await (dependencies.fetchImpl ?? fetch)(`${baseUrl}${path}`, { method: "GET", headers });
    const payload = await response.json();
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${JSON.stringify(payload)}`);
    return payload;
  };
  const found = typeof options.id === "string"
    ? await get(`/documents/${options.id}`)
    : await get(`/documents/by-destination?${new URLSearchParams({ repository: noteRepository(options), gitPath: notePath(options) })}`);
  const revisions = await get(`/documents/${found.document.id}/revisions`);
  if (typeof options["write-file"] === "string") {
    const markdown: unknown = found.currentRevision?.markdown;
    if (typeof markdown !== "string") fail("pull response had no currentRevision.markdown to write");
    const content = markdown.endsWith("\n") ? markdown : `${markdown}\n`;
    if (dependencies.writeFile) {
      dependencies.writeFile(options["write-file"], content);
    } else {
      // Dynamic import: shared-spec-cli.ts otherwise has zero filesystem
      // dependencies, so this stays out of the module's top-level imports
      // and only loads for real invocations that pass --write-file (tests
      // always inject dependencies.writeFile instead).
      const { writeFileSync } = await import("node:fs");
      writeFileSync(options["write-file"], content, "utf8");
    }
  }
  (dependencies.writeOutput ?? ((value) => process.stdout.write(value)))(`${JSON.stringify({ ...found, revisions }, null, 2)}\n`);
}

export async function runSharedSpecCli(
  argv = process.argv.slice(2),
  dependencies: SharedSpecCliDependencies = {},
): Promise<void> {
  const { command, options } = parse(argv);
  const baseUrl = required(options, "url").replace(/\/$/, "");
  const token = required(options, "token");
  if (command === "pull") { await runPull(baseUrl, token, options, dependencies); return; }
  let path = "/documents";
  let method = "GET";
  let body: Record<string, unknown> | undefined;
  if (command === "show") path = `/documents/${required(options, "id")}`;
  if (command === "show-review") path = `/reviews/${required(options, "id")}`;
  // Review discovery for the caller's own authenticated actor: every review
  // assigned to or claimed by them, plus every fully open review their
  // reviewer policy makes them eligible to claim right now -- see
  // SharedSpecCore.listReviewerQueue. Lets Claude Code, Gemini Code, and
  // Antigravity ask "what's waiting on me" without already knowing a
  // reviewId, the same discovery Alden already has in-process.
  if (command === "my-reviews") path = "/reviews/mine";
  if (command === "export") path = `/documents/${required(options, "id")}/export/raw`;
  if (command === "create") { method = "POST"; body = { title: required(options, "title"), kind: required(options, "kind"), repository: required(options, "repository"), gitPath: required(options, "path"), markdown: required(options, "markdown"), summary: options.summary, liveInstructionDocument: options["live-instruction-document"] === true }; }
  if (command === "resync") { method = "POST"; path = `/documents/${required(options, "id")}/resync`; }
  if (command === "revision") { method = "POST"; path = `/documents/${required(options, "id")}/revisions`; body = { baseRevisionId: required(options, "base"), markdown: required(options, "markdown") }; }
  if (command === "ready") { method = "POST"; path = `/documents/${required(options, "id")}/ready`; body = { revisionId: required(options, "revision"), requestedReviewerActorId: options.reviewer }; }
  if (command === "claim") { method = "POST"; path = `/reviews/${required(options, "id")}/claim`; body = {}; }
  if (command === "approve" || command === "reject") { method = "POST"; path = `/reviews/${required(options, "id")}/${command}`; body = { rationale: options.rationale, evidenceReferences: json(options.evidence, "evidence") }; }
  if (command === "share") { method = "POST"; path = "/documents/share"; body = { repository: noteRepository(options), gitPath: notePath(options), markdown: required(options, "markdown"), title: options.title, summary: options.summary, baseRevisionId: options.base, notifyActorId: options.notify }; }
  const headers: Record<string, string> = { "x-shared-spec-token": token };
  if (mutationCommands.has(command)) {
    headers["idempotency-key"] = required(options, "idempotency-key");
    headers["content-type"] = "application/json";
  }
  const response = await (dependencies.fetchImpl ?? fetch)(`${baseUrl}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const output = command === "export" ? await response.text() : JSON.stringify(await response.json(), null, 2);
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${output}`);
  (dependencies.writeOutput ?? ((value) => process.stdout.write(value)))(command === "export" ? output : `${output}\n`);
}

if (isDirectCliInvocation("shared-spec-cli.ts")) {
  runSharedSpecCli().catch(error => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
}
