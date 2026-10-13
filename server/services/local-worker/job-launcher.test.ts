/**
 * Job launcher tests (design §5.6 / §7). Native cases run only on Windows and use
 * synthetic non-model processes (powershell / cmd ping sleepers) with owned cleanup.
 * On other platforms they are reported as SKIPPED, never as passes.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  BOOTSTRAP_SCRIPT, LAUNCHER_SCRIPT, buildEnvBlock, createLauncherStatusSink, interpretLauncherExit, parseMembersStatus, quoteWindowsArg, startJobLauncher,
} from './job-launcher';
import { judgeMembers } from './supervisor';

const WIN = process.platform === 'win32';
const skip = WIN ? false : 'native Windows Job Object test (not run on this platform)';
const PS = `${process.env.SystemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
const ENV = () => ({
  // PATHEXT is required for cmd to resolve `ping` to PING.EXE. Before 2026-10-08 it was missing here, so the
  // sleeper's cmd -> ping grandchild exited at once ("'ping' is not recognized") and was never a job member.
  SystemRoot: process.env.SystemRoot!, ComSpec: process.env.ComSpec!, PATH: `${process.env.SystemRoot}\\System32`, PATHEXT: process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD',
  TEMP: process.env.TEMP ?? '', TMP: process.env.TMP ?? '',
});
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; } // signal 0 = existence check only
}
async function exitOf(h: ReturnType<typeof startJobLauncher>, ms = 30_000) {
  return Promise.race([h.exited, wait(ms).then(() => ({ code: -999, signal: null }))]);
}
async function membersOf(h: ReturnType<typeof startJobLauncher>): Promise<number[]> {
  const snap = await h.listMembers(4000);
  return snap ? snap.processes.filter((p) => p.state === 'member').map((p) => p.pid) : [];
}
const sleeperArgs = (inner = '') => ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
  `${inner}Start-Process -WindowStyle Hidden -FilePath $env:ComSpec -ArgumentList "/c ping -n 120 127.0.0.1 >nul"; Start-Sleep 120`];

test('quoteWindowsArg follows CommandLineToArgvW rules', () => {
  assert.equal(quoteWindowsArg('plain'), 'plain');
  assert.equal(quoteWindowsArg('two words'), '"two words"');
  assert.equal(quoteWindowsArg(''), '""');
  assert.equal(quoteWindowsArg('a"b'), '"a\\"b"');
  assert.equal(quoteWindowsArg('C:\\dir with space\\'), '"C:\\dir with space\\\\"');
});

test('buildEnvBlock is sorted, NUL-separated, double-NUL terminated and rejects bad entries', () => {
  assert.equal(buildEnvBlock({ b: '2', A: '1' }), 'A=1\0b=2\0\0');
  assert.throws(() => buildEnvBlock({ 'A=B': '1' }));
  assert.throws(() => buildEnvBlock({ A: 'x\0y' }));
});

test('review 58d3fcaf 1.2: >256 healthy monitoring replies never exhaust the history; lifecycle statuses stay retained; replies correlate by number', () => {
  const sink = createLauncherStatusSink();
  const reply = (pid: number) => `S:{"event":"members","listOk":true,"pids":[${pid}],"processes":[{"pid":${pid},"state":"member","image":"C:\\\\x\\\\claude.exe"}],"active":1}\n`;
  sink.push('S:{"event":"running","rootPid":1}\n');
  for (let i = 1; i <= 1000; i += 1) sink.push(reply(i));
  sink.push('S:{"event":"terminated","verified":true}\r\n');
  assert.equal(sink.membersReceived(), 1000);
  assert.equal(sink.overflow.statuses, false, 'monitoring replies do not consume the status budget');
  assert.deepEqual(sink.statuses.map((s) => s.event), ['running', 'terminated'], 'termination acknowledgement retained');
  assert.equal(parseMembersStatus(sink.memberReply(1000)!)!.processes[0].pid, 1000, 'reply n is the n-th reply');
  assert.equal(sink.memberReply(1), null, 'only the latest replies are retained (memory bounded)');
  // A late reply to an earlier request is never returned for a later request number.
  assert.equal(sink.memberReply(1001), null);
  // Lifecycle history itself stays bounded.
  for (let i = 0; i < 300; i += 1) sink.push('S:{"event":"noise"}\n');
  assert.equal(sink.statuses.length, 256);
  assert.equal(sink.overflow.statuses, true);
});

test('launcher exit interpretation', () => {
  assert.equal(interpretLauncherExit(0), 'completed');
  assert.equal(interpretLauncherExit(80), 'terminated_verified');
  assert.equal(interpretLauncherExit(74), 'harness_unavailable');
  assert.equal(interpretLauncherExit(79), 'termination_unverified');
  assert.equal(interpretLauncherExit(null), 'termination_unverified');
});

test('static: no PID-based or tree kill path exists in worker sources', () => {
  const dir = dirname(fileURLToPath(import.meta.url));
  for (const f of readdirSync(dir).filter((n) => n.endsWith('.ts') && !n.endsWith('.test.ts'))) {
    const src = readFileSync(join(dir, f), 'utf8');
    assert.equal(/taskkill/i.test(src), false, `${f} mentions taskkill`);
    assert.equal(/process\.kill\(/.test(src), false, `${f} calls process.kill`);
    assert.equal(/\/T\s+\/F/.test(src), false, `${f} has a /T /F tree kill`);
    if (f !== 'job-launcher.ts') assert.equal(/OpenProcess\b/.test(src), false, `${f} opens processes by PID`);
  }
  const launcher = readFileSync(join(dir, 'job-launcher.ts'), 'utf8');
  // The only kill the launcher wrapper performs is on its own Node child handle.
  assert.match(launcher, /child\.kill\('SIGKILL'\)/);
  // §5.6 monitoring opens listed pids ONLY with query-limited access (no terminate right),
  // at exactly one call site, and TerminateProcess is only ever applied to the owned root handle.
  const opens = launcher.match(/OpenProcess\((?:[^()]|\([^()]*\))*\)/g) ?? [];
  assert.deepEqual(opens, ['OpenProcess(uint access, bool inherit, int pid)', 'OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, (int)pid)']);
  assert.match(launcher, /const uint PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;/);
  const csharp = launcher.slice(launcher.indexOf('const CSHARP'), launcher.indexOf('const HOST_PS'));
  const terminates = csharp.match(/TerminateProcess\(([^,)]*)/g) ?? [];
  assert.deepEqual([...new Set(terminates)], ['TerminateProcess(IntPtr proc', 'TerminateProcess(hProcess']);
});

test('bootstrap refuses a launcher whose sha256 does not match the pin', { skip }, async () => {
  const enc = Buffer.from(BOOTSTRAP_SCRIPT, 'utf16le').toString('base64');
  const child = spawn(PS, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', enc],
    { env: { SystemRoot: process.env.SystemRoot! }, windowsHide: true });
  let err = '';
  child.stderr.on('data', (b) => { err += b; });
  child.stdin.write(`${Buffer.from(`${LAUNCHER_SCRIPT}\n# tampered`, 'utf8').toString('base64')}\n`);
  const code = await new Promise<number | null>((r) => child.on('exit', r));
  assert.equal(code, 78);
  assert.match(err, /launcher_digest/);
});

// Wall-clock observation budgets for the two phases of the grandchild test (CI run 38022306429:
// no cmd/ping member appeared and the old message could not say why). Readiness: "hello" has been
// observed on the root's stdout. Membership: cmd and ping are both observed as job members. Each
// budget is a deadline, not an iteration count: no LIST starts after it, the pause between LISTs
// is cut to the time remaining, and a LIST already in flight may finish up to its own 5 s timeout
// late (plus scheduling jitter). These are finite diagnostic budgets, not measured or proven
// performance thresholds and not a flake fix: 60 s is a generous choice with no cold-start data
// behind it, kept well inside the sleepers' 120 s lifetime so cmd/ping cannot expire before the
// membership phase ends (worst case before cleanup: 60 + 30 + 5 s plus jitter).
const GRANDCHILD_READY_MS = 60_000;
const GRANDCHILD_MEMBERS_MS = 30_000;

/** Bounded failure context: phase, timings, LIST outcomes, launcher exit, stdout/stderr/status tails. */
function launcherDiagnostics(h: ReturnType<typeof startJobLauncher>, info: Record<string, unknown>): string {
  const tail = (s: string, n: number) => (s.length > n ? `…${s.slice(-n)}` : s);
  return JSON.stringify({
    ...info,
    stdoutTail: tail(Buffer.concat(h.harnessStdout).toString('utf8'), 1000),
    stderrTail: h.harnessStderr.slice(-10).map((l) => tail(l, 300)),
    statusesTail: h.statuses.slice(-8),
    overflow: { ...h.overflow },
  });
}

test('child and grandchild are job members and TERMINATE ends both with verification', { skip }, async (t) => {
  const t0 = Date.now();
  // Same sleeper as sleeperArgs, but the root also prints the pid Start-Process returned. Seeing
  // "started:<pid>" shows Start-Process returned a created process; it does not by itself show
  // that process was ever observed as a job member, nor why it is absent from later snapshots.
  const args = ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
    'Write-Output "hello"; $c = Start-Process -PassThru -WindowStyle Hidden -FilePath $env:ComSpec -ArgumentList "/c ping -n 120 127.0.0.1 >nul"; '
    + 'Write-Output "started:$($c.Id)"; Start-Sleep 120'];
  const h = startJobLauncher({ exe: PS, args, cwd: process.cwd(), env: ENV() });
  let launcherExit: unknown = null;
  void h.exited.then((e) => { launcherExit = { ...e, atMs: Date.now() - t0 }; });
  let pids: number[] = [];
  let terminated = false;
  try {
    // Phase 1 (readiness). "no_hello" means "hello" was not observed within the budget, not that
    // PowerShell never executed anything; the stdout tail shows what was observed.
    const helloSeen = () => Buffer.concat(h.harnessStdout).toString('utf8').includes('hello');
    const readyDeadline = Date.now() + GRANDCHILD_READY_MS;
    while (!helloSeen() && launcherExit === null && Date.now() < readyDeadline) await wait(250);
    const readyMs = Date.now() - t0;
    assert.ok(helloSeen(), `no_hello: ${launcherDiagnostics(h, { phase: 'ready', readyMs, launcherExit })}`);

    // Phase 2 (membership): poll until the sleeper's cmd and ping descendants exist.
    // A count alone is not proof (conhost.exe is also a member): require the actual cmd and ping images.
    type Snap = Awaited<ReturnType<typeof h.listMembers>>;
    const has = (s: Snap) => {
      const im = (s?.processes ?? []).filter((p) => p.state === 'member').map((p) => (p.image ?? '').toLowerCase());
      return im.some((i) => i.endsWith('\\cmd.exe')) && im.some((i) => i.endsWith('\\ping.exe'));
    };
    const lists = { ok: 0, timedOut: 0 };
    let snap: Snap = null;
    const membersDeadline = Date.now() + GRANDCHILD_MEMBERS_MS;
    do {
      const s = await h.listMembers(5000);
      if (s) { lists.ok += 1; snap = s; } else lists.timedOut += 1;
      if (has(snap) || launcherExit !== null) break;
      await wait(Math.min(1000, Math.max(0, membersDeadline - Date.now())));
    } while (Date.now() < membersDeadline);
    const images = (snap?.processes ?? []).map((p) => `${p.pid}:${p.state}:${(p.image ?? '').toLowerCase()}`);
    assert.ok(has(snap), `hello_without_descendants: ${launcherDiagnostics(h, {
      phase: 'members', readyMs, membersMs: Date.now() - t0 - readyMs, lists, lastMembers: images, launcherExit,
    })}`);
    // Phase timings on success too (a TAP diagnostic line), so passing CI runs record them.
    t.diagnostic(`grandchild phases: readyMs=${readyMs} membersMs=${Date.now() - t0 - readyMs} lists=${JSON.stringify(lists)}`);
    pids = (snap?.processes ?? []).filter((p) => p.state === 'member').map((p) => p.pid);
    assert.ok(pids.length >= 3, `expected >=3 job members, got ${JSON.stringify(pids)}`);
    h.terminate();
    terminated = true;
    const ex = await exitOf(h);
    assert.equal(interpretLauncherExit(ex.code), 'terminated_verified');
    assert.equal(h.statuses.at(-1)?.verified, true);
  } finally {
    if (!terminated) { h.terminate(); await exitOf(h); }
  }
  await wait(500);
  for (const pid of pids) assert.equal(alive(pid), false, `job member ${pid} survived`);
  assert.match(Buffer.concat(h.harnessStdout).toString(), /hello/);
});

test('§5.6 LIST reports every job member with a membership-verified image; the policy flags non-harness images (native)', { skip }, async () => {
  const h = startJobLauncher({ exe: PS, args: sleeperArgs(), cwd: process.cwd(), env: ENV() });
  try {
    // Poll (bounded) until the sleeper's cmd/ping descendants exist.
    let snap = await h.listMembers(5000);
    for (let i = 0; i < 30 && !(snap?.processes ?? []).some((p) => /ping\.exe$/i.test(p.image ?? '')); i += 1) {
      await wait(1000);
      snap = await h.listMembers(5000);
    }
    assert.ok(snap, 'LIST reply within the bound');
    assert.equal(snap!.listOk, true);
    assert.equal(snap!.processes.some((p) => p.state === 'unknown'), false, JSON.stringify(snap));
    const images = snap!.processes.filter((p) => p.state === 'member').map((p) => p.image!.toLowerCase());
    const sys32 = `${process.env.SystemRoot}\\System32\\`.toLowerCase();
    assert.ok(images.includes(PS.toLowerCase()), `root image present: ${images.join(', ')}`);
    assert.ok(images.includes(`${sys32}cmd.exe`) && images.includes(`${sys32}ping.exe`), `descendants present: ${images.join(', ')}`);
    // With the PowerShell sleeper standing in for the harness, its cmd/ping descendants violate the image policy.
    const v = judgeMembers(snap, PS, process.env.SystemRoot!);
    assert.equal(v.kind, 'violation');
    assert.ok(v.kind === 'violation' && v.images.some((i) => /ping\.exe$/i.test(i)));
  } finally {
    h.terminate();
    const ex = await exitOf(h);
    assert.equal(interpretLauncherExit(ex.code), 'terminated_verified');
  }
});

test('an out-of-job process survives job termination (no tree kill)', { skip }, async () => {
  const outside = spawn(process.env.ComSpec!, ['/c', 'ping -n 60 127.0.0.1 >nul'], { windowsHide: true });
  try {
    const h = startJobLauncher({ exe: PS, args: sleeperArgs(), cwd: process.cwd(), env: ENV() });
    await wait(6000);
    h.terminate();
    assert.equal(interpretLauncherExit((await exitOf(h)).code), 'terminated_verified');
    assert.equal(outside.exitCode, null, 'out-of-job sleeper must still be running');
  } finally {
    outside.kill(); // test-owned handle
  }
});

test('a child cannot break away from the job', { skip }, async () => {
  const script = [
    "Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class B {",
    "[StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] public struct SI { public int cb; public string a; public string b; public string c; public int d,e,f,g,h,i,j,k; public short l,m; public IntPtr n,o,p,q; }",
    "[StructLayout(LayoutKind.Sequential)] public struct PI { public IntPtr hp, ht; public int pid, tid; }",
    "[DllImport(\"kernel32.dll\", SetLastError=true, CharSet=CharSet.Unicode)] public static extern bool CreateProcessW(string app, string cmd, IntPtr pa, IntPtr ta, bool inh, uint fl, IntPtr env, string cwd, ref SI si, out PI pi);",
    "public static string Try(string exe) { SI si = new SI(); si.cb = Marshal.SizeOf(si); PI pi; bool ok = CreateProcessW(exe, null, IntPtr.Zero, IntPtr.Zero, false, 0x01000000 | 0x08000000, IntPtr.Zero, null, ref si, out pi); return ok ? \"BREAKAWAY_SUCCEEDED\" : (\"BREAKAWAY_DENIED_\" + Marshal.GetLastWin32Error()); } }';",
    "Write-Output ([B]::Try($env:ComSpec))",
  ].join(' ');
  const h = startJobLauncher({ exe: PS, args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], cwd: process.cwd(), env: ENV() });
  const ex = await exitOf(h);
  assert.equal(interpretLauncherExit(ex.code), 'completed');
  const out = Buffer.concat(h.harnessStdout).toString();
  assert.match(out, /BREAKAWAY_DENIED_5/, out);
});

test('killing the launcher through its own handle terminates the job (kill-on-close)', { skip }, async () => {
  const h = startJobLauncher({ exe: PS, args: sleeperArgs(), cwd: process.cwd(), env: ENV() });
  await wait(6000);
  const pids = await membersOf(h);
  assert.ok(pids.length >= 1);
  h.killLauncher();
  const ex = await exitOf(h);
  assert.equal(interpretLauncherExit(ex.code), 'termination_unverified');
  await wait(1500);
  for (const pid of pids) assert.equal(alive(pid), false, `member ${pid} survived kill-on-close`);
});

test('startup fault: job-list attribute failure creates no process', { skip }, async () => {
  const h = startJobLauncher({ exe: PS, args: sleeperArgs(), cwd: process.cwd(), env: ENV(), testHooks: ['fail_job_list'], allowTestHooks: true });
  const ex = await exitOf(h);
  assert.equal(ex.code, 74);
  assert.equal(h.statuses.some((s) => s.event === 'created'), false);
});

test('startup fault: launcher killed before resume leaves no suspended root', { skip }, async () => {
  const h = startJobLauncher({ exe: PS, args: sleeperArgs(), cwd: process.cwd(), env: ENV(), testHooks: ['pause_before_resume'], allowTestHooks: true });
  for (let i = 0; i < 100 && !h.statuses.some((s) => s.event === 'paused_before_resume'); i += 1) await wait(100);
  const root = h.statuses.find((s) => s.event === 'created')?.rootPid as number;
  assert.ok(root && alive(root), 'suspended root should exist before the kill');
  h.killLauncher();
  await exitOf(h);
  await wait(1500);
  assert.equal(alive(root), false, 'suspended root survived launcher death');
});

test('startup fault: resume failure is cleaned up through the job to zero members', { skip }, async () => {
  const h = startJobLauncher({ exe: PS, args: sleeperArgs(), cwd: process.cwd(), env: ENV(), testHooks: ['fail_resume'], allowTestHooks: true });
  const ex = await exitOf(h);
  assert.equal(ex.code, 77);
  assert.equal(interpretLauncherExit(ex.code), 'harness_unavailable');
  const root = h.statuses.find((s) => s.event === 'created')?.rootPid as number;
  assert.equal(alive(root), false);
});

test('startup fault: membership check failure is cleaned up', { skip }, async () => {
  const h = startJobLauncher({ exe: PS, args: sleeperArgs(), cwd: process.cwd(), env: ENV(), testHooks: ['fake_not_in_job'], allowTestHooks: true });
  assert.equal((await exitOf(h)).code, 76);
});

test('startup fault: unverifiable cleanup reports termination_unverified', { skip }, async () => {
  const h = startJobLauncher({ exe: PS, args: sleeperArgs(), cwd: process.cwd(), env: ENV(), testHooks: ['fail_resume', 'fail_cleanup_verify'], allowTestHooks: true });
  const ex = await exitOf(h);
  assert.equal(interpretLauncherExit(ex.code), 'termination_unverified');
});

test('test hooks are refused unless explicitly allowed', { skip }, async () => {
  const h = startJobLauncher({ exe: PS, args: sleeperArgs(), cwd: process.cwd(), env: ENV(), testHooks: ['fail_resume'] });
  assert.equal((await exitOf(h)).code, 70);
  assert.equal(h.statuses.some((s) => s.event === 'created'), false);
});

test('F5 launcher spawn failure settles exited with spawnFailed (no process created) and never throws', { skip }, async () => {
  const h = startJobLauncher({ exe: PS, args: ['-NoProfile', '-Command', 'exit 0'], cwd: 'C:\\lrw-does-not-exist-\\x', env: ENV() });
  const e = await exitOf(h, 15_000);
  assert.equal((e as { spawnFailed?: boolean }).spawnFailed, true);
  assert.equal(h.child.pid, undefined);
  assert.equal(h.terminate(), false, 'control line cannot be delivered to a launcher that never started');
});

test('F5 harness stdout retention is bounded and overflow is flagged', { skip }, async () => {
  // ~6 MiB from a synthetic non-model process; only 4 MiB may be retained.
  const h = startJobLauncher({ exe: PS, args: ['-NoProfile', '-Command', "[Console]::Out.Write(('x' * 6291456))"], cwd: process.cwd(), env: ENV() });
  const e = await exitOf(h, 60_000);
  assert.equal(e.code, 0);
  assert.equal(h.overflow.stdout, true);
  assert.ok(h.harnessStdout.reduce((n, b) => n + b.length, 0) <= 4 * 1024 * 1024);
});
