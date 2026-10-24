/**
 * Execute commands in the canonical `npm test` chain one at a time.
 *
 * The local command intentionally remains the source of truth. CI uses this
 * runner only so a failure is reported with its exact command rather than the
 * opaque exit code produced by a long shell `&&` chain. Named groups allow
 * independent portions of that chain to run in parallel in GitHub Actions.
 */
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// fileURLToPath, not new URL(...).pathname -- on Windows a file:// URL's
// .pathname keeps its leading slash (e.g. "/C:/Users/..."), which
// path.resolve() does not parse as an absolute Windows path, producing a
// doubled drive letter ("C:\C:\Users\..."). fileURLToPath handles this
// correctly on every platform.
const root = fileURLToPath(new URL('..', import.meta.url));
const packageJson = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
const testChain = packageJson.scripts?.test;

function assertSafeCiDatabaseConfiguration() {
  if (process.env.CI !== 'true') return;

  const ciDatabaseUrl = process.env.CI_DATABASE_URL;
  if (!ciDatabaseUrl) {
    throw new Error(
      'GitHub CI requires CI_DATABASE_URL for its isolated PostgreSQL service; refusing to fall back to a live database URL',
    );
  }

  let parsed;
  try {
    parsed = new URL(ciDatabaseUrl);
  } catch {
    throw new Error('CI_DATABASE_URL must be a valid PostgreSQL connection URL');
  }

  const safeHosts = new Set(['127.0.0.1', 'localhost', '::1']);
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol) || !safeHosts.has(parsed.hostname)) {
    throw new Error('CI_DATABASE_URL must target the job-local PostgreSQL service, not an external database');
  }

  if (process.env.NEON_SHARED_DATABASE_URL !== ciDatabaseUrl) {
    throw new Error(
      'NEON_SHARED_DATABASE_URL must exactly match CI_DATABASE_URL in GitHub CI so DB-backed tests cannot use a live database',
    );
  }
}

assertSafeCiDatabaseConfiguration();

if (typeof testChain !== 'string' || !testChain.trim()) {
  throw new Error('package.json must define a non-empty scripts.test command');
}

const commands = testChain
  .split(/\s+&&\s+/)
  .map((command) => command.trim())
  .filter(Boolean);

// Release-safety checks registered directly in the canonical GitHub runner.
// The ingress suite uses getVerifiedCiDatabaseUrl and therefore executes only
// against the job-local CI_DATABASE_URL service validated above.
const safetyInsertion = commands.findIndex((command) =>
  command.startsWith('npx tsx server/scripts/test-openai-pronunciation-error-notice.ts'));
if (safetyInsertion < 0) throw new Error('Could not register projection/source safety checks before the guards group');
commands.splice(safetyInsertion, 0,
  'node --test scripts/alden-build-guardian.test.cjs',
  'npx tsx --test server/services/guardian-token.test.ts',
  'npx tsx --test server/services/instance-role.test.ts',
  'npx tsx --test server/services/github-token-broker.test.ts',
  'npx tsx --test server/services/github-token-broker-store.test.ts',
  'npx tsx server/scripts/test-codeowners-coverage.ts --self-check',
  'npx tsx --test server/scripts/test-launch-gate.test.ts',
  'npx tsx --test server/scripts/test-coordination-github-exec.test.ts',
  'npx tsx --test server/scripts/agent-feed-client.test.ts',
  // Isolated broker (costed plan ff04f70e): own tree, no web-app imports.
  'npx tsx --test broker/test/broker.test.ts broker/test/claims.test.ts broker/test/github.test.ts broker/test/gateway.test.ts broker/test/main.test.ts broker/test/client.test.ts',
  'npx tsx --test broker/test/policy-file.test.ts',
  'npx tsc -p broker/tsconfig.json',
  'node --test scripts/post-merge.test.mjs',
  'npx tsx --test server/services/agent-feed.test.ts server/services/agent-feed-postgres.test.ts',
  'npx tsx --test server/services/claude-code-mirror.test.ts server/services/claude-code-mirror-postgres.test.ts server/services/claude-code-projection.test.ts server/services/claude-code-projection-postgres.test.ts server/scripts/claude-code-mirror-sync.test.ts',
  'npx tsx --test server/scripts/test-episode-claude-attribution-repair.test.ts',
  'npx tsx --test server/scripts/test-episode-attribution-repair-postgres.test.ts',
  'npx tsx --test server/scripts/test-historical-attribution-overlay.test.ts',
  'npx tsx --test server/services/canonical-attribution.test.ts',
  'npx tsx --test server/scripts/test-agent-voice-turn-endsession-tags.test.ts',
  'npx tsx --test server/services/turn-attribution.test.ts server/services/four-channel-continuity-audit.test.ts server/services/inner-life-fragment.test.ts',
  'node --test scripts/test-historical-attribution-release-package.test.mjs',
  'npx tsx --test server/scripts/test-runtime-onboarding-auth-order.test.ts',
  'npx tsx --test server/services/broker-signing-key.test.ts',
  // Reusable onboarding has no live credential fixtures. PostgreSQL proof runs
  // explicitly against the disposable database supplied by the migration gate.
  'node --test scripts/build-runtime-onboarding-package.test.mjs',
  'node --test scripts/finalize-runtime-onboarding-package.test.mjs',
  'npx tsx --test server/services/runtime-onboarding.test.ts server/routes/runtime-onboarding-routes.test.ts server/scripts/runtime-onboarding-client.test.ts server/scripts/runtime-onboarding-native-store.test.ts server/services/runtime-onboarding-openai-sdk.test.ts server/services/runtime-onboarding-restricted-credential.test.ts server/services/runtime-onboarding-postgres.test.ts server/utils/api-response-log-policy.test.ts',
  // TypeScript typecheck: registered as a run_check in run-validation-suite.sh
  // but, unlike every other entry there, it never bottoms out in a file path
  // (npm run typecheck -> tsc --noEmit) -- so test-validation-suite-ci-parity.ts
  // models it as a pathless "cmd:" key instead of a file-path key. Kept here,
  // not left to the parity guard's Replit-only allowlist, because typecheck has
  // no live-DB or live-server dependency and can run in any CI environment.
  'npm run typecheck',
  'npx tsx server/scripts/check-required-runtime-sources.ts',
  'npx tsx server/scripts/check-required-runtime-sources.ts --self-check',
  'npx tsx server/scripts/test-context-lineage-migration-guard-selfcheck.ts',
  'npx tsx server/scripts/test-projection-receipts.ts',
  'npx tsx server/scripts/test-projection-writer-coverage.ts',
  'npx tsx server/scripts/test-source-reconciliation-service.ts',
  'npx tsx server/scripts/test-source-reconciliation-inspection.ts',
  'npx tsx server/scripts/test-source-reconciliation-hermetic-env.ts',
  'npx tsx server/scripts/test-source-reconciliation-hermetic-env.ts --self-check',
  'npx tsx --test server/scripts/test-coordination-cli-hermetic-env.test.ts',
  'npx tsx --test server/scripts/lib/coordination-listener.test.ts',
  'npx tsx --test server/scripts/lib/coordination-listener-transport.test.ts',
  'npx tsx --test server/scripts/lib/coordination-listener-windows-reader.test.ts',
  'npx tsx --test server/scripts/lib/coordination-listener-lifecycle.test.ts',
  'npx tsx --test server/scripts/lib/coordination-listener-ownership.test.ts',
  'npx tsx --test server/scripts/test-claude-capture-hook-registered.test.ts',
  'npx tsx --test server/scripts/test-record-stop-turn-absorbed.test.ts',
  'npx tsx --test server/scripts/test-stop-hook-runtime-notices.test.ts',
  'npx tsx --test server/scripts/test-record-stop-turn-rejected.test.ts',
  'npx tsx --test server/scripts/test-runtime-notice-relabel.test.ts',
  'npx tsx --test server/scripts/test-runtime-notice-relabel-op.test.ts',
  'node --import tsx --test server/scripts/lib/coordination-listener-boot.test.ts',
  'node --import tsx --test server/scripts/lib/coordination-listener-boot-diagnostic.test.ts',
  'npx tsx --test server/services/task-ownership-client.test.ts',
  'node --import tsx --test server/services/ownership-approval-scope.test.ts server/routes/founder-task-ownership-routes.test.ts',
  'node --import tsx --test server/services/promotion-approval-context.test.ts',
  'npx tsx server/services/gate3-task-artifact-materializer.test.ts',
  'npx tsx --test server/services/release-cutover-attestation-service.test.ts',
  'npx tsx server/scripts/prepare-antigravity-provisioning.test.ts',
  'npx tsx --test --test-concurrency=1 server/scripts/test-coordination-gate3-assignment-window.test.ts',
  'npx tsx --test --test-concurrency=1 server/scripts/test-coordination-gate3-eol-cross-host.test.ts',
  'npx tsx --test server/scripts/test-antigravity-windows-dpapi.test.ts',
  'npx tsx --test server/scripts/test-coordination-runtime.test.ts',
  'npx tsx server/scripts/test-coordination-runtime-envelope-violation-selfcheck.ts',
  'npx tsx server/scripts/test-coordination-runtime-verifier-standing-selfcheck.ts',
  'npx tsx server/scripts/test-coordination-actor-completeness-selfcheck.ts',
  'npx tsx --test server/scripts/test-coordination-runtime-http.test.ts',
  'npx tsx --test server/scripts/coordination-runtime-antigravity-e2e.test.ts',
  'npx tsx --test server/services/coordination-v2-runtime-bootstrap-service.test.ts',
  'npx tsx --test server/scripts/test-coordination-v2-runtime-bootstrap-http.test.ts',
  'npx tsx --test server/scripts/test-coordination-v2-runtime-timestamp-replay.test.ts',
  'npx tsx --test server/scripts/test-coordination-v2-runtime-expired-recovery-static.test.ts',
  'npx tsx --test server/scripts/test-coordination-v2-windows-runtime-bootstrap-static.test.ts',

  // Coordination CLI cross-invocation credential cache: lets a runtime run
  // more than one coordination-cli.ts command per bootstrap instead of
  // needing an operator-reissued bootstrap for every single command.
  'npx tsx --test server/services/coordination-cli-credential-cache.test.ts',
  'npx tsx --test server/scripts/test-coordination-cli-credential-persistence-e2e.test.ts',

  // Coordination-check CI parity (below): every run_check registered in
  // server/scripts/run-validation-suite.sh must also run here, or a
  // regression only a manual/task-completion validation run would ever
  // catch. These entries close that gap for checks confirmed hermetic or
  // correctly CI-database-gated. See run-validation-suite.sh for the
  // handful of checks intentionally left out, with reasoning inline.
  //
  // This parity is now enforced automatically -- not just documented -- by
  // test-validation-suite-ci-parity.ts below. It fails loudly if a future
  // run_check line is ever added to run-validation-suite.sh without a
  // matching entry appearing somewhere in this CI command set.
  'npx tsx server/scripts/test-validation-suite-ci-parity.ts',
  'npx tsx server/scripts/test-validation-suite-ci-parity.ts --self-check',
  'npx tsx --test scripts/neon-branch.test.ts',
  'npx tsx --test scripts/render-predeploy.test.ts',
  'npx tsx --test scripts/cross-tool-promote.test.ts',
  'npx tsx --test scripts/promotion-ownership.test.ts',
  'npx tsx --test scripts/reconciliation-history-object-storage.test.ts',
  'npx tsx --test scripts/archive-reconciliation-history.test.ts',
  'npx tsx --test server/scripts/test-source-control-cli-sync-ownership-guard.test.ts',
  'npx tsx --test server/scripts/test-source-promotion-sync-ownership-guard.test.ts',

  // Source-bridge and GitHub transport safety.
  'bash scripts/test-github-sync-guards.sh',
  'npx tsx server/scripts/test-source-control-service.ts',
  'npx tsx server/scripts/test-source-control-mutation-boundary.ts',
  'npx tsx server/scripts/test-github-release-safety.ts',
  'npx tsx server/scripts/test-github-branch-bypass-guard.ts',
  'npx tsx server/scripts/test-github-branch-bypass-guard.ts --self-check',
  'npx tsx --test server/scripts/test-github-branch-bypass-guard-required.test.ts',
  'npx tsx server/scripts/test-cross-tool-promote-content-loss-guard.ts',
  'npx tsx server/scripts/test-cross-tool-promote-content-loss-guard.ts --self-check',
  'npx tsx server/scripts/test-cross-tool-promote-stale-main-guard.ts',
  'npx tsx server/scripts/test-cross-tool-promote-stale-main-guard.ts --self-check',
  'npx tsx server/scripts/test-agent-skills-symlink.ts',
  'npx tsx server/scripts/test-agent-skills-symlink.ts --self-check',

  // Shared-spec live-instruction-document PostgreSQL integration tests,
  // including the drift-regression tests proving approve/resync refuse to
  // overwrite a live-instruction document once its git file has drifted out
  // of shared-spec's recorded history. Previously reachable only through
  // scripts/neon-branch.ts's migration-gate branch -- meaning this coverage
  // ran incidentally, whenever a migration happened to be tested, rather
  // than on every change. Now also reachable here via the file's own
  // getVerifiedCiDatabaseUrl-first disposableTarget() check, no schema
  // migration required.
  'npx tsx --test server/scripts/test-shared-spec-live-instruction-document-postgres.test.ts',

  // Alden's review-discovery tool (list_shared_spec_reviews), proven end to
  // end through his real dispatch path -- executeAldenTool ->
  // listAldenSharedSpecReviews -> PostgresSharedSpecRepository -> a real
  // Postgres database -- not just the in-memory domain coverage already in
  // shared-spec-core.test.ts. Same getVerifiedCiDatabaseUrl-first
  // disposableTarget() pattern as the file above, so no extra gate wiring is
  // needed.
  'npx tsx --test server/scripts/test-alden-shared-spec-review-discovery.test.ts',
  'npx tsx --test server/scripts/test-shared-spec-broker-auth.test.ts',
  'npx tsx --test server/scripts/test-alden-review-source.test.ts',

  // Task 1658's listReviewerQueue open_eligible case made a fully open
  // pending review discoverable by every eligible reviewer at once, so two
  // reviewers racing to claim it is now realistic. Proves against a real
  // Postgres database that claimReview's compareAndSetReviewClaim guard lets
  // exactly one of two concurrent claims win -- the in-memory mirror in
  // shared-spec-core.test.ts cannot exercise genuine cross-transaction
  // interleaving (see that file's comment). Same getVerifiedCiDatabaseUrl-first
  // disposableTarget() pattern as the file above, so no extra gate wiring is
  // needed.
  'npx tsx --test server/scripts/test-shared-spec-review-claim-race-postgres.test.ts',

  // Task 1664: assignReview and decideReview wrote reviews through the same
  // plain unconditional tx.updateReview(updated) call the claim race above
  // used to, with no compare-and-set on the fields each changes. Proves
  // against a real Postgres database that compareAndSetReviewAssignment and
  // compareAndSetReviewDecision each let exactly one of two concurrent writes
  // win. Same getVerifiedCiDatabaseUrl-first disposableTarget() pattern as
  // the file above, so no extra gate wiring is needed.
  'npx tsx --test server/scripts/test-shared-spec-review-assign-decision-race-postgres.test.ts',

  // Alden's own shared-spec review-decision entry point
  // (alden-shared-spec-review.ts), exercised through its real singleton
  // wiring (getCore/getHolaHolaSharedSpecNotificationSink/
  // getHolaHolaSharedSpecLiveSync) rather than the shared wrapper directly.
  // Same getVerifiedCiDatabaseUrl-first disposableTarget() pattern as above.
  'npx tsx --test server/scripts/test-alden-shared-spec-review-postgres.test.ts',
  'npx tsx --test server/scripts/test-alden-coordination-read.test.ts',

  // Coordinator V2 lifecycle diagnostics, cleanup, fault fallback, evidence,
  // and neighboring first-host-bootstrap/contract/reauthorization suites.
  'npx tsx --test server/scripts/test-coordination-v2-first-host-bootstrap.test.ts',
  'npx tsx --test server/scripts/test-coordination-lifecycle-facade.test.ts',
  'npx tsx --test server/scripts/test-coordination-windows-host.test.ts',
  'npx tsx --test server/scripts/test-coordination-v2-cli.test.ts',
  'npx tsx --test server/scripts/test-coordination-errors.test.ts',
  'npx tsx --test server/scripts/test-coordination-session-status.test.ts',
  'npx tsx --test server/scripts/test-coordination-cleanup.test.ts',
  'npx tsx --test server/scripts/test-coordination-v2-e2e.test.ts',
  'npx tsx --test server/scripts/test-coordination-v2-fault-injection.test.ts',
  'npx tsx --test server/scripts/test-coordination-v2-provider-fallback.test.ts',
  'npx tsx --test server/scripts/test-coordination-gemini-provider-driver.test.ts',
  'npx tsx --test server/scripts/test-coordination-v2-evidence-integrity.test.ts',
  'npx tsx --test server/scripts/test-coordination-v2-host-completion-boundary.test.ts',
  'npx tsx --test server/scripts/test-coordination-v2-host-factory-route.test.ts',
  'npx tsx --test server/scripts/test-coordination-v2-dpapi-contract.test.ts',
  'npx tsx --test server/scripts/test-coordination-v2-authority-seams.test.ts',
  'npx tsx --test server/scripts/test-coordination-v2-public-material-digest.test.ts',
  'npx tsx --test server/scripts/test-coordination-v2-deferred-session.test.ts',
  'npx tsx --test server/scripts/test-coordinator-v2-schema.test.ts',
  'npx tsx --test server/scripts/test-coordination-lifecycle-reaper.test.ts',
  'npx tsx --test server/scripts/test-coordination-v2-powershell-contract.test.ts',
  'npx tsx --test server/scripts/test-coordination-v2-acl-mask.test.ts',
  'npx tsx --test server/scripts/test-coordination-v2-recovery-clock.test.ts',
  'npx tsx --test server/scripts/test-coordination-v2-staged-enrollment-contract.test.ts',
  'npx tsx --test server/services/coordination-v2-host-reauthorization-contract.test.ts',
  'npx tsx --test server/services/coordination-v2-host-reauthorization-validation.test.ts',
  'npx tsx --test server/scripts/test-coordination-v2-host-reauthorization-static.test.ts',
  'npx tsx --test server/scripts/test-coordination-diagnostic-results.test.ts',

  // Episode/capture/inbox lifecycle guards. The plain mode of
  // detect-episode-dialogue-loss.ts degrades to an informational no-op when
  // history/DB signal is thin (e.g. a fresh checkout) instead of failing --
  // see its own SKIP/informational logging -- so it is safe here even
  // though it will rarely have real signal to report in this environment.
  'npx tsx server/scripts/audit-episode-28-gaps.ts --self-check',
  'npx tsx server/scripts/check-episode-content-loss.ts --self-check',
  'npx tsx server/scripts/detect-episode-dialogue-loss.ts --self-check',
  'npx tsx server/scripts/detect-episode-dialogue-loss.ts',
  'npx tsx server/scripts/test-capture-status-ordering.ts',
  'npx tsx server/scripts/test-truth-pipeline-unified-recall-diagnosis.ts',
  'npx tsx server/scripts/test-capture-status-stale-escalation.ts',
  'npx tsx server/scripts/test-canonical-conversation-capture.ts',
  'npx tsx server/scripts/test-canonical-capture-worker-readiness.ts',
  'npx tsx server/scripts/test-chat-capture-episode-outbox.ts',
  'npx tsx server/scripts/test-episode-lifecycle-create-dedup.ts',
  // NOT run automatically here or from run-validation-suite.sh: this test
  // briefly flips the shared DB's live 'rolling' tag to a disposable row. The
  // Team Room/chat hook's 60s rolling-name cache
  // (server/services/team-room-episode-hook.ts) means a real chat write can
  // keep resolving to the disposable filename for up to a minute after the
  // flip, well past the test's own back-to-back promote/restore window and
  // its own tag-based restoration check -- so a real conversation turn can
  // land on the disposable row and be permanently deleted with it even when
  // the test reports full success. Run it manually and deliberately (during a
  // quiet period, watching for concurrent activity) before changing
  // promoteRollingEpisode() itself. See
  // .agents/memory/episode-lifecycle-service-guards.md.
  // 'npx tsx server/scripts/test-episode-lifecycle-promote-success.ts',
  'npx tsx server/scripts/test-set-rolling-episode-bad-name.ts',
  'npx tsx server/scripts/set-rolling-episode.ts --self-check',
  'npx tsx server/scripts/test-set-rolling-episode-selfcheck-hang.ts',
  'npx tsx server/scripts/test-set-rolling-episode-selfcheck-hang.ts --self-check',
  'npx tsx --test server/scripts/repair-preincident-watchdog-source-identity.test.ts',
  'npx tsx server/scripts/test-agent-notes-inbox.ts',
  'npx tsx server/scripts/test-alden-provider-tool-projection.ts',
  'npx tsx server/scripts/test-linked-outcome-static-guard.ts',
  'npx tsx --test server/__tests__/daniela-memory-boundary.test.ts',
  'npx tsx --test server/__tests__/voice-exchange-accounting.test.ts',
  'npx tsx --test server/__tests__/live-voice-routing.test.ts',
  'npx tsx server/scripts/test-inner-life-no-episode-row.ts',
  'npx tsx --test server/scripts/test-agent-memory-round-trip-gate-isolation.test.ts',
  'npx tsx server/scripts/test-agent-memory-drift-guard.ts --self-check',
  'npx tsx --test server/scripts/test-shared-spec-guards-ci-wiring.test.ts',

  // GL/raw-window/startup-recovery guards.
  'npx tsx server/scripts/test-gl-reconnected-client-recovery.ts',
  'npx tsx server/scripts/test-gl-game-session-detector.ts',
  'npx tsx server/scripts/test-gl-game-session-detector.ts --self-check',
  'npx tsx server/scripts/test-raw-window-capture.ts --self-check',
  'npx tsx server/scripts/test-memory-decay-startup-schema-guard.ts',
  'npx tsx server/scripts/test-memory-decay-startup-schema-guard.ts --self-check',
  'bash server/scripts/test-start-application-recovery.sh',
  'bash server/scripts/test-start-application-recovery.sh --self-check',
  'npx tsx --test server/scripts/test-infra-mutation-ownership-guard.test.ts',
  'npx tsx server/scripts/test-release-identity.ts',
  'npx tsx server/scripts/test-replit-attribution-discipline.ts',

  'npx tsx --test server/scripts/test-team-room-attribution-route.test.ts',
  'npx tsx --test server/scripts/test-agent-note-coordination-ingress.test.ts',
);

if (commands.length === 0) {
  throw new Error('No executable commands were found in package.json scripts.test');
}

const GROUPS = {
  unit: {
    startsWith: 'npx tsx --test server/scripts/gemini-gate-check.test.ts',
    endsWith: 'server/scripts/test-agent-note-coordination-ingress.test.ts',
  },
  guards: {
    startsWith: 'npx tsx server/scripts/test-openai-pronunciation-error-notice.ts',
    endsWith: 'server/scripts/test-reach-north-star-response-field.ts',
  },
  episodes: {
    startsWith: 'npx tsx server/scripts/seed-episode1.ts',
    endsWith: 'server/scripts/test-north-star-resync-debounce.ts',
  },
};

function findGroupRange(name, definition) {
  const start = commands.findIndex((command) => command.startsWith(definition.startsWith));
  const end = commands.findIndex((command) => command.endsWith(definition.endsWith));

  if (start === -1 || end === -1 || end < start) {
    throw new Error(
      `Could not locate the ${name} CI test group boundaries in package.json scripts.test`,
    );
  }

  return { start, end };
}

const groupRanges = Object.fromEntries(
  Object.entries(GROUPS).map(([name, definition]) => [name, findGroupRange(name, definition)]),
);

const ranges = Object.values(groupRanges);
const coveredCommandIndexes = ranges.flatMap(({ start, end }) =>
  Array.from({ length: end - start + 1 }, (_, offset) => start + offset),
);
const expectedCommandIndexes = Array.from({ length: commands.length }, (_, index) => index);

if (
  coveredCommandIndexes.length !== expectedCommandIndexes.length ||
  coveredCommandIndexes.some((index, position) => index !== expectedCommandIndexes[position])
) {
  throw new Error('CI test groups must cover the canonical test command chain contiguously');
}

const requestedGroup = process.argv.slice(2).find((argument) => argument.startsWith('--group='));
const groupName = requestedGroup?.slice('--group='.length);

if (groupName && !Object.hasOwn(groupRanges, groupName)) {
  throw new Error(
    `Unknown CI test group "${groupName}". Expected one of: ${Object.keys(groupRanges).join(', ')}`,
  );
}

const selectedRange = groupName ? groupRanges[groupName] : { start: 0, end: commands.length - 1 };
const selectedCommands = commands.slice(selectedRange.start, selectedRange.end + 1);

// This DB-backed ownership test is deterministic on its own but races with
// other test files when Node launches the large multi-file batch in parallel.
// Keep the canonical command list intact while giving this security-sensitive
// test its own process in CI.
const ISOLATED_TEST_FILE = 'server/__tests__/global-pool-conversation-leak-guard.test.ts';

// A leaked handle (e.g. an unclosed database pool) can keep a spawned
// command's Node process alive indefinitely even after every assertion in it
// has already passed. Bound every command so this runner always reaches a
// terminal state instead of hanging the whole suite forever on one child.
const DEFAULT_STEP_TIMEOUT_MS = 10 * 60 * 1000;
const configuredStepTimeoutMs = Number(process.env.CI_TEST_STEP_TIMEOUT_MS);
const STEP_TIMEOUT_MS = Number.isFinite(configuredStepTimeoutMs) && configuredStepTimeoutMs > 0
  ? configuredStepTimeoutMs
  : DEFAULT_STEP_TIMEOUT_MS;
const FORCE_KILL_GRACE_MS = 10_000;

function run(command) {
  return new Promise((resolveRun) => {
    const child = spawn(command, {
      cwd: root,
      env: process.env,
      shell: true,
      stdio: 'inherit',
      // POSIX only: makes the child the leader of its own process group so a
      // hung command's whole group can be terminated, not just the shell
      // wrapping it (npx/tsx often nest an extra process under the shell).
      detached: process.platform !== 'win32',
    });

    let settled = false;
    const settle = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      resolveRun(result);
    };

    function killChild(signal) {
      try {
        if (process.platform !== 'win32') {
          process.kill(-child.pid, signal);
        } else {
          child.kill(signal);
        }
      } catch {
        // Process (or group) may already be gone -- nothing further to do.
      }
    }

    const timeoutTimer = setTimeout(() => {
      console.error(
        `[ci:test] Command exceeded ${STEP_TIMEOUT_MS}ms with no exit -- terminating: ${command}`,
      );
      killChild('SIGTERM');
      const forceKillTimer = setTimeout(() => killChild('SIGKILL'), FORCE_KILL_GRACE_MS);
      forceKillTimer.unref();
      settle({ code: 1, error: new Error(`timed out after ${STEP_TIMEOUT_MS}ms with no exit`) });
    }, STEP_TIMEOUT_MS);
    timeoutTimer.unref();

    child.on('error', (error) => settle({ code: 1, error }));
    child.on('close', (code, signal) => settle({ code, signal }));
  });
}

function commandParts(command) {
  if (!command.includes(ISOLATED_TEST_FILE)) {
    return [command];
  }

  const sharedBatch = command.replace(` ${ISOLATED_TEST_FILE}`, '').trim();
  if (!sharedBatch || sharedBatch === command) {
    throw new Error(`Could not isolate ${ISOLATED_TEST_FILE} from the CI test command`);
  }

  return [
    sharedBatch,
    `npx tsx --test ${ISOLATED_TEST_FILE}`,
  ];
}

for (const [index, command] of selectedCommands.entries()) {
  const canonicalIndex = selectedRange.start + index;
  const label = groupName
    ? `[ci:test:${groupName} ${index + 1}/${selectedCommands.length} (command ${canonicalIndex + 1}/${commands.length})]`
    : `[ci:test ${index + 1}/${commands.length}]`;
  const parts = commandParts(command);

  for (const [partIndex, part] of parts.entries()) {
    const partLabel = parts.length === 1 ? label : `${label} PART ${partIndex + 1}/${parts.length}`;
    console.log(`${partLabel} START: ${part}`);

    const result = await run(part);
    if (result.error || result.code !== 0 || result.signal) {
      const reason = result.error
        ? result.error.message
        : result.signal
          ? `signal ${result.signal}`
          : `exit ${result.code}`;
      console.error(`${partLabel} FAILED (${reason}): ${part}`);
      process.exitCode = typeof result.code === 'number' && result.code !== 0 ? result.code : 1;
      break;
    }

    console.log(`${partLabel} PASSED`);
  }

  if (process.exitCode) {
    break;
  }
}

if (!process.exitCode) {
  const suffix = groupName ? ` GROUP ${groupName}` : '';
  console.log(`[ci:test] ALL ${selectedCommands.length} COMMANDS${suffix} PASSED`);
}