/**
 * Local Read-only Worker v1 — Windows Job Object launcher (design §5.6, rev b8fe5e66).
 *
 * The supervisor never spawns the harness directly. It spawns
 *   powershell.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand <LAUNCHER_SCRIPT>
 * which compiles a small C# helper (Add-Type) that:
 *   1. CreateJobObject(NULL)  -> non-inheritable, never duplicated, sole handle;
 *      limits KILL_ON_JOB_CLOSE | DIE_ON_UNHANDLED_EXCEPTION; no breakaway flags.
 *   2. STARTUPINFOEX with PROC_THREAD_ATTRIBUTE_JOB_LIST = {job} (child is CREATED
 *      inside the job) and PROC_THREAD_ATTRIBUTE_HANDLE_LIST = {stdin/stdout/stderr
 *      pipe ends only}, so the job handle is never inherited.
 *   3. CreateProcessW(EXTENDED_STARTUPINFO_PRESENT|CREATE_SUSPENDED|CREATE_NO_WINDOW|
 *      CREATE_UNICODE_ENVIRONMENT). Any attribute/creation failure => no child.
 *   4. IsProcessInJob(hProcess, hJob) must be TRUE before ResumeThread.
 *   5. Post-creation setup failure => TerminateJobObject + TerminateProcess(owned
 *      handle), verify ActiveProcesses == 0, explicit cleanup. Never a numeric PID.
 *   6. Control on stdin: "TERMINATE <nonce>" -> TerminateJobObject(own handle), poll
 *      ActiveProcesses to 0 (<= 10 s) -> verified/unverified; "LIST <nonce>" -> job
 *      member process ids, each with an image path read through a query-limited handle
 *      that IsProcessInJob confirms is still a member (monitoring only, never kill targets).
 * Protocol: harness stdout is relayed raw to launcher stdout; harness stderr lines are
 * relayed as "H:<line>"; launcher status lines are "S:<json>" on stderr.
 * Test hooks exist only when env LRW_ALLOW_TEST_HOOKS=1 AND the config requests them;
 * they are part of the config object, so any hooked config has a different digest
 * and can never match a qualified configuration.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { sha256Hex } from '../../../shared/worker-contracts';

const CSHARP = String.raw`
using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using Microsoft.Win32.SafeHandles;

public static class LrwJobLauncher {
  [StructLayout(LayoutKind.Sequential)] struct IO_COUNTERS { public ulong a,b,c,d,e,f; }
  [StructLayout(LayoutKind.Sequential)] struct BASIC_LIMIT { public long PerProcessUserTimeLimit; public long PerJobUserTimeLimit; public uint LimitFlags; public UIntPtr MinimumWorkingSetSize; public UIntPtr MaximumWorkingSetSize; public uint ActiveProcessLimit; public UIntPtr Affinity; public uint PriorityClass; public uint SchedulingClass; }
  [StructLayout(LayoutKind.Sequential)] struct EXT_LIMIT { public BASIC_LIMIT Basic; public IO_COUNTERS Io; public UIntPtr ProcessMemoryLimit; public UIntPtr JobMemoryLimit; public UIntPtr PeakProcessMemoryUsed; public UIntPtr PeakJobMemoryUsed; }
  [StructLayout(LayoutKind.Sequential)] struct BASIC_ACCOUNTING { public long TotalUserTime; public long TotalKernelTime; public long ThisPeriodTotalUserTime; public long ThisPeriodTotalKernelTime; public uint TotalPageFaultCount; public uint TotalProcesses; public uint ActiveProcesses; public uint TotalTerminatedProcesses; }
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct STARTUPINFO { public int cb; public string lpReserved; public string lpDesktop; public string lpTitle; public int dwX; public int dwY; public int dwXSize; public int dwYSize; public int dwXCountChars; public int dwYCountChars; public int dwFillAttribute; public int dwFlags; public short wShowWindow; public short cbReserved2; public IntPtr lpReserved2; public IntPtr hStdInput; public IntPtr hStdOutput; public IntPtr hStdError; }
  [StructLayout(LayoutKind.Sequential)] struct STARTUPINFOEX { public STARTUPINFO StartupInfo; public IntPtr lpAttributeList; }
  [StructLayout(LayoutKind.Sequential)] struct PROCESS_INFORMATION { public IntPtr hProcess; public IntPtr hThread; public int dwProcessId; public int dwThreadId; }
  [StructLayout(LayoutKind.Sequential)] struct SECURITY_ATTRIBUTES { public int nLength; public IntPtr lpSecurityDescriptor; public bool bInheritHandle; }

  [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)] static extern IntPtr CreateJobObjectW(IntPtr a, string name);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job, int cls, ref EXT_LIMIT info, int len);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job, int cls, out BASIC_ACCOUNTING info, int len, IntPtr ret);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job, int cls, IntPtr info, int len, IntPtr ret);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateJobObject(IntPtr job, uint code);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool IsProcessInJob(IntPtr proc, IntPtr job, out bool result);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, int flags, ref IntPtr size);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr attr, IntPtr value, IntPtr size, IntPtr prev, IntPtr retSize);
  [DllImport("kernel32.dll", SetLastError=true)] static extern void DeleteProcThreadAttributeList(IntPtr list);
  [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)] static extern bool CreateProcessW(string app, StringBuilder cmd, IntPtr pa, IntPtr ta, bool inherit, uint flags, IntPtr env, string cwd, ref STARTUPINFOEX si, out PROCESS_INFORMATION pi);
  [DllImport("kernel32.dll", SetLastError=true)] static extern uint ResumeThread(IntPtr thread);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateProcess(IntPtr proc, uint code);
  [DllImport("kernel32.dll", SetLastError=true)] static extern uint WaitForSingleObject(IntPtr h, uint ms);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr h, out uint code);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool CloseHandle(IntPtr h);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool CreatePipe(out IntPtr r, out IntPtr w, ref SECURITY_ATTRIBUTES sa, int size);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetHandleInformation(IntPtr h, int mask, int flags);
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
  [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)] static extern bool QueryFullProcessImageNameW(IntPtr h, int flags, StringBuilder name, ref int size);
  // Monitoring only: a query-limited handle carries no terminate right and is never used to kill.
  const uint PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;

  const uint EXTENDED_STARTUPINFO_PRESENT = 0x00080000, CREATE_SUSPENDED = 0x4, CREATE_NO_WINDOW = 0x08000000, CREATE_UNICODE_ENVIRONMENT = 0x400;
  const int STARTF_USESTDHANDLES = 0x100, HANDLE_FLAG_INHERIT = 1;
  static readonly IntPtr ATTR_HANDLE_LIST = (IntPtr)0x20002, ATTR_JOB_LIST = (IntPtr)0x2000D;
  const uint LIMIT_KILL_ON_CLOSE = 0x2000, LIMIT_DIE_ON_UNHANDLED = 0x400;

  static IntPtr job = IntPtr.Zero, hProcess = IntPtr.Zero, hThread = IntPtr.Zero, attrList = IntPtr.Zero;
  static readonly object outLock = new object();
  static Stream stdoutRaw;

  static string Esc(string s) { return s.Replace("\\","\\\\").Replace("\"","\\\""); }
  public static void Status(string json) { lock(outLock) { Console.Error.WriteLine("S:" + json); Console.Error.Flush(); } }

  static uint ActiveCount() {
    BASIC_ACCOUNTING a;
    if (!QueryInformationJobObject(job, 1, out a, Marshal.SizeOf(typeof(BASIC_ACCOUNTING)), IntPtr.Zero)) return uint.MaxValue;
    return a.ActiveProcesses;
  }
  static bool TerminateAndVerify(int ms) {
    TerminateJobObject(job, 0xC0000005);
    if (hProcess != IntPtr.Zero) TerminateProcess(hProcess, 0xC0000005);
    int waited = 0;
    while (waited <= ms) { uint n = ActiveCount(); if (n == 0) return true; Thread.Sleep(100); waited += 100; }
    return false;
  }
  // Job member pids from JobObjectBasicProcessIdList; null when the query fails.
  static List<long> MemberPids() {
    int size = 8 + 8 * 512; IntPtr buf = Marshal.AllocHGlobal(size);
    try {
      if (!QueryInformationJobObject(job, 3, buf, size, IntPtr.Zero)) return null;
      int n = Marshal.ReadInt32(buf, 4); var ids = new List<long>();
      for (int i = 0; i < n && i < 512; i++) ids.Add((long)Marshal.ReadIntPtr(buf, 8 + i * IntPtr.Size));
      return ids;
    } finally { Marshal.FreeHGlobal(buf); }
  }
  // Image of one listed pid, bound to the job by IsProcessInJob on the opened handle, so a
  // reused pid is reported as "gone" rather than misattributed. Never a kill target.
  static string Describe(long pid) {
    IntPtr h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, (int)pid);
    if (h == IntPtr.Zero) {
      int e = Marshal.GetLastWin32Error();
      return "{\"pid\":" + pid + ",\"state\":\"" + (e == 87 ? "gone" : "unknown") + "\",\"win32\":" + e + "}";
    }
    try {
      bool member;
      if (!IsProcessInJob(h, job, out member)) return "{\"pid\":" + pid + ",\"state\":\"unknown\",\"win32\":" + Marshal.GetLastWin32Error() + "}";
      if (!member) return "{\"pid\":" + pid + ",\"state\":\"gone\"}";
      var sb = new StringBuilder(1024); int n = sb.Capacity;
      if (!QueryFullProcessImageNameW(h, 0, sb, ref n)) return "{\"pid\":" + pid + ",\"state\":\"unknown\",\"win32\":" + Marshal.GetLastWin32Error() + "}";
      return "{\"pid\":" + pid + ",\"state\":\"member\",\"image\":\"" + Esc(sb.ToString()) + "\"}";
    } finally { CloseHandle(h); }
  }
  static string ListMembers() {
    var ids = MemberPids();
    if (ids == null) return "{\"event\":\"members\",\"listOk\":false,\"pids\":[],\"processes\":[],\"active\":" + ActiveCount() + "}";
    var pids = new List<string>(); var procs = new List<string>();
    foreach (long pid in ids) { pids.Add(pid.ToString()); procs.Add(Describe(pid)); }
    return "{\"event\":\"members\",\"listOk\":true,\"pids\":[" + string.Join(",", pids.ToArray()) + "],\"processes\":[" + string.Join(",", procs.ToArray()) + "],\"active\":" + ActiveCount() + "}";
  }
  static void Cleanup() {
    if (attrList != IntPtr.Zero) { DeleteProcThreadAttributeList(attrList); Marshal.FreeHGlobal(attrList); attrList = IntPtr.Zero; }
    if (hThread != IntPtr.Zero) { CloseHandle(hThread); hThread = IntPtr.Zero; }
    if (hProcess != IntPtr.Zero) { CloseHandle(hProcess); hProcess = IntPtr.Zero; }
  }

  // Returns the launcher exit code. Job handle is closed only by process exit.
  public static int Run(string exe, string cmdLine, string cwd, string envBlock, string nonce, string hooks, bool allowHooks) {
    bool hkJobListFail = allowHooks && hooks.Contains("fail_job_list");
    bool hkPause = allowHooks && hooks.Contains("pause_before_resume");
    bool hkResumeFail = allowHooks && hooks.Contains("fail_resume");
    bool hkNotInJob = allowHooks && hooks.Contains("fake_not_in_job");
    bool hkVerifyFail = allowHooks && hooks.Contains("fail_cleanup_verify");
    if (hooks.Length > 0 && !allowHooks) { Status("{\"event\":\"setup_failed\",\"stage\":\"hooks_not_allowed\"}"); return 70; }

    job = CreateJobObjectW(IntPtr.Zero, null);
    if (job == IntPtr.Zero) { Status("{\"event\":\"setup_failed\",\"stage\":\"create_job\",\"win32\":" + Marshal.GetLastWin32Error() + "}"); return 71; }
    var lim = new EXT_LIMIT(); lim.Basic.LimitFlags = LIMIT_KILL_ON_CLOSE | LIMIT_DIE_ON_UNHANDLED;
    if (!SetInformationJobObject(job, 9, ref lim, Marshal.SizeOf(typeof(EXT_LIMIT)))) { Status("{\"event\":\"setup_failed\",\"stage\":\"job_limits\"}"); return 71; }

    var sa = new SECURITY_ATTRIBUTES(); sa.nLength = Marshal.SizeOf(sa); sa.bInheritHandle = true;
    IntPtr inR, inW, outR, outW, errR, errW;
    if (!CreatePipe(out inR, out inW, ref sa, 0) || !CreatePipe(out outR, out outW, ref sa, 0) || !CreatePipe(out errR, out errW, ref sa, 0)) { Status("{\"event\":\"setup_failed\",\"stage\":\"pipes\"}"); return 72; }
    SetHandleInformation(inW, HANDLE_FLAG_INHERIT, 0); SetHandleInformation(outR, HANDLE_FLAG_INHERIT, 0); SetHandleInformation(errR, HANDLE_FLAG_INHERIT, 0);

    IntPtr size = IntPtr.Zero; InitializeProcThreadAttributeList(IntPtr.Zero, 2, 0, ref size);
    attrList = Marshal.AllocHGlobal(size);
    if (!InitializeProcThreadAttributeList(attrList, 2, 0, ref size)) { Status("{\"event\":\"setup_failed\",\"stage\":\"attr_init\"}"); Cleanup(); return 73; }
    IntPtr jobArr = Marshal.AllocHGlobal(IntPtr.Size); Marshal.WriteIntPtr(jobArr, job);
    IntPtr hList = Marshal.AllocHGlobal(IntPtr.Size * 3); Marshal.WriteIntPtr(hList, 0, inR); Marshal.WriteIntPtr(hList, IntPtr.Size, outW); Marshal.WriteIntPtr(hList, IntPtr.Size * 2, errW);
    bool jobAttrOk = !hkJobListFail && UpdateProcThreadAttribute(attrList, 0, ATTR_JOB_LIST, jobArr, (IntPtr)IntPtr.Size, IntPtr.Zero, IntPtr.Zero);
    if (!jobAttrOk) { Status("{\"event\":\"setup_failed\",\"stage\":\"job_list_attribute\",\"win32\":" + Marshal.GetLastWin32Error() + "}"); Cleanup(); return 74; }
    if (!UpdateProcThreadAttribute(attrList, 0, ATTR_HANDLE_LIST, hList, (IntPtr)(IntPtr.Size * 3), IntPtr.Zero, IntPtr.Zero)) { Status("{\"event\":\"setup_failed\",\"stage\":\"handle_list_attribute\"}"); Cleanup(); return 74; }

    var si = new STARTUPINFOEX(); si.StartupInfo.cb = Marshal.SizeOf(typeof(STARTUPINFOEX)); si.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
    si.StartupInfo.hStdInput = inR; si.StartupInfo.hStdOutput = outW; si.StartupInfo.hStdError = errW; si.lpAttributeList = attrList;
    IntPtr env = Marshal.StringToHGlobalUni(envBlock);
    PROCESS_INFORMATION pi;
    bool created = CreateProcessW(exe, new StringBuilder(cmdLine), IntPtr.Zero, IntPtr.Zero, true,
      EXTENDED_STARTUPINFO_PRESENT | CREATE_SUSPENDED | CREATE_NO_WINDOW | CREATE_UNICODE_ENVIRONMENT, env, cwd, ref si, out pi);
    Marshal.FreeHGlobal(env);
    CloseHandle(inR); CloseHandle(outW); CloseHandle(errW); CloseHandle(inW);
    if (!created) { Status("{\"event\":\"setup_failed\",\"stage\":\"create_process\",\"win32\":" + Marshal.GetLastWin32Error() + "}"); Cleanup(); return 75; }
    hProcess = pi.hProcess; hThread = pi.hThread;

    bool inJob; bool q = IsProcessInJob(hProcess, job, out inJob);
    if (hkNotInJob) inJob = false;
    if (!q || !inJob) {
      bool ok = TerminateAndVerify(10000) && !hkVerifyFail;
      Status("{\"event\":\"setup_failed\",\"stage\":\"membership\",\"cleanup\":\"" + (ok ? "verified" : "unverified") + "\"}"); Cleanup(); return ok ? 76 : 79;
    }
    Status("{\"event\":\"created\",\"rootPid\":" + pi.dwProcessId + ",\"suspended\":true}");
    if (hkPause) { Status("{\"event\":\"paused_before_resume\"}"); Thread.Sleep(60000); }
    if (hkResumeFail || ResumeThread(hThread) == 0xFFFFFFFF) {
      bool ok = TerminateAndVerify(10000) && !hkVerifyFail;
      Status("{\"event\":\"setup_failed\",\"stage\":\"resume\",\"cleanup\":\"" + (ok ? "verified" : "unverified") + "\"}"); Cleanup(); return ok ? 77 : 79;
    }
    Status("{\"event\":\"running\",\"rootPid\":" + pi.dwProcessId + "}");

    stdoutRaw = Console.OpenStandardOutput();
    var outPipe = new FileStream(new SafeFileHandle(outR, true), FileAccess.Read);
    var errPipe = new StreamReader(new FileStream(new SafeFileHandle(errR, true), FileAccess.Read), Encoding.UTF8);
    var tOut = new Thread(() => { var b = new byte[8192]; int n; while ((n = outPipe.Read(b, 0, b.Length)) > 0) { lock(outLock) { stdoutRaw.Write(b, 0, n); stdoutRaw.Flush(); } } });
    var tErr = new Thread(() => { string line; while ((line = errPipe.ReadLine()) != null) { lock(outLock) { Console.Error.WriteLine("H:" + line); Console.Error.Flush(); } } });
    tOut.IsBackground = true; tErr.IsBackground = true; tOut.Start(); tErr.Start();

    var ctl = new Thread(() => {
      string line;
      while ((line = Console.In.ReadLine()) != null) {
        var parts = line.Trim().Split(' ');
        if (parts.Length != 2 || parts[1] != nonce) continue;
        if (parts[0] == "LIST") Status(ListMembers());
        if (parts[0] == "TERMINATE") {
          bool ok = TerminateAndVerify(10000) && !hkVerifyFail;
          Status("{\"event\":\"terminated\",\"verified\":" + (ok ? "true" : "false") + "}");
          Environment.Exit(ok ? 80 : 79);
        }
      }
    });
    ctl.IsBackground = true; ctl.Start();

    WaitForSingleObject(hProcess, 0xFFFFFFFF);
    uint code; GetExitCodeProcess(hProcess, out code);
    tOut.Join(5000); tErr.Join(5000);
    uint remaining = ActiveCount();
    if (remaining != 0) {
      bool ok = TerminateAndVerify(10000) && !hkVerifyFail;
      Status("{\"event\":\"root_exited\",\"exitCode\":" + code + ",\"descendantsTerminated\":true,\"verified\":" + (ok ? "true" : "false") + "}");
      Cleanup(); return ok ? 0 : 79;
    }
    Status("{\"event\":\"root_exited\",\"exitCode\":" + code + ",\"verified\":true}");
    Cleanup();
    return 0;
  }
}
`;

/** PowerShell host script: reads one JSON config line from stdin, then runs the helper. */
const HOST_PS = `
$ErrorActionPreference = 'Stop'
try { Add-Type -TypeDefinition @'
${CSHARP}
'@ -Language CSharp } catch { [Console]::Error.WriteLine('S:{"event":"setup_failed","stage":"add_type"}'); exit 78 }
$cfg = [Console]::In.ReadLine() | ConvertFrom-Json
$allow = ($env:LRW_ALLOW_TEST_HOOKS -eq '1')
$hooks = [string]::Join(',', @($cfg.testHooks))
exit [LrwJobLauncher]::Run([string]$cfg.exe, [string]$cfg.cmdLine, [string]$cfg.cwd, [string]$cfg.envBlock, [string]$cfg.nonce, $hooks, $allow)
`;

export const LAUNCHER_SCRIPT = HOST_PS;
/** Part of the adapter configDigest (§6.3). */
export const LAUNCHER_SHA256 = sha256Hex(Buffer.from(HOST_PS, 'utf8'));

/**
 * The full launcher exceeds the 32,767-character command-line limit as
 * -EncodedCommand, so a small bootstrap receives it as the first stdin line
 * (base64 UTF-8), verifies its sha256 against the pinned LAUNCHER_SHA256, and
 * only then runs it. A mismatch exits 78 (setup failure, no harness).
 */
export const BOOTSTRAP_SCRIPT = `$ErrorActionPreference='Stop'
$b=[Convert]::FromBase64String([Console]::In.ReadLine())
$h=[BitConverter]::ToString([Security.Cryptography.SHA256]::Create().ComputeHash($b)).Replace('-','').ToLowerInvariant()
if($h -ne '${LAUNCHER_SHA256}'){[Console]::Error.WriteLine('S:{"event":"setup_failed","stage":"launcher_digest"}');exit 78}
. ([ScriptBlock]::Create([Text.Encoding]::UTF8.GetString($b)))`;

/** Windows command-line quoting per CommandLineToArgvW rules. */
export function quoteWindowsArg(arg: string): string {
  if (arg.length > 0 && !/[\s"]/.test(arg)) return arg;
  let out = '"';
  let backslashes = 0;
  for (const ch of arg) {
    if (ch === '\\') { backslashes += 1; continue; }
    if (ch === '"') { out += '\\'.repeat(backslashes * 2 + 1) + '"'; backslashes = 0; continue; }
    out += '\\'.repeat(backslashes) + ch; backslashes = 0;
  }
  return `${out}${'\\'.repeat(backslashes * 2)}"`;
}

/** Unicode environment block: sorted KEY=VALUE entries, NUL-separated, double-NUL terminated. */
export function buildEnvBlock(env: Record<string, string>): string {
  const entries = Object.entries(env).sort(([a], [b]) => a.toUpperCase().localeCompare(b.toUpperCase()));
  for (const [k, v] of entries) {
    if (!k || k.includes('=') || k.includes('\0') || v.includes('\0')) throw new Error('env_invalid_entry');
  }
  return `${entries.map(([k, v]) => `${k}=${v}`).join('\0')}\0\0`;
}

export type LauncherStatus = { event: string; [k: string]: unknown };

/** One LIST reply: every job member pid with its membership-verified image, or why it is not known. */
export type MembersSnapshot = {
  listOk: boolean;
  active: number;
  processes: { pid: number; state: 'member' | 'gone' | 'unknown'; image?: string }[];
};

export function parseMembersStatus(s: LauncherStatus): MembersSnapshot | null {
  if (s.event !== 'members' || typeof s.listOk !== 'boolean' || !Array.isArray(s.processes) || typeof s.active !== 'number') return null;
  const processes: MembersSnapshot['processes'] = [];
  for (const p of s.processes as Record<string, unknown>[]) {
    if (!p || typeof p.pid !== 'number' || !['member', 'gone', 'unknown'].includes(String(p.state))) return null;
    if (p.state === 'member' && typeof p.image !== 'string') return null;
    processes.push({ pid: p.pid, state: p.state as 'member' | 'gone' | 'unknown', ...(typeof p.image === 'string' ? { image: p.image } : {}) });
  }
  return { listOk: s.listOk, active: s.active, processes };
}

/** Retention bounds (F5): nothing the harness or launcher prints can grow supervisor memory without limit. */
export const LAUNCHER_BOUNDS = Object.freeze({ stdoutBytes: 4 * 1024 * 1024, statusEntries: 256, stderrLines: 256, lineChars: 4000, memberRepliesRetained: 8 });

/**
 * Parses the launcher's stderr protocol. Monitoring replies ("members") do NOT enter the
 * bounded diagnostic history: they are counted (stable reply number n = 1, 2, ...) and only
 * the latest few are retained, so routine §5.6 monitoring can never exhaust the history
 * budget that keeps lifecycle events such as "terminated" (review 58d3fcaf item 1.2).
 */
export function createLauncherStatusSink() {
  const statuses: LauncherStatus[] = [];
  const harnessStderr: string[] = [];
  const overflow = { statuses: false, stderr: false };
  const replies = new Map<number, LauncherStatus>();
  let received = 0;
  let buf = '';
  const line = (raw: string) => {
    const l = raw.replace(/\r$/, '').slice(0, LAUNCHER_BOUNDS.lineChars);
    if (l.startsWith('S:')) {
      let s: LauncherStatus;
      try { s = JSON.parse(l.slice(2)); } catch { s = { event: 'malformed_status' }; }
      if (s && s.event === 'members') {
        received += 1;
        replies.set(received, s);
        replies.delete(received - LAUNCHER_BOUNDS.memberRepliesRetained);
        return;
      }
      if (statuses.length >= LAUNCHER_BOUNDS.statusEntries) { overflow.statuses = true; return; }
      statuses.push(s);
    } else if (l.startsWith('H:')) {
      if (harnessStderr.length >= LAUNCHER_BOUNDS.stderrLines) { overflow.stderr = true; return; }
      harnessStderr.push(l.slice(2));
    }
  };
  return {
    statuses, harnessStderr, overflow,
    push(chunk: string) {
      buf += chunk;
      if (buf.length > LAUNCHER_BOUNDS.lineChars * 4 && buf.indexOf('\n') < 0) { overflow.stderr = true; buf = ''; return; }
      let i: number;
      while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); line(l); }
    },
    membersReceived: () => received,
    /** The n-th monitoring reply if still retained (replies arrive in LIST order). */
    memberReply: (n: number) => replies.get(n) ?? null,
  };
}

export type LauncherExit = {
  code: number | null;
  signal: NodeJS.Signals | null;
  /** True only when Node reports the launcher process was never created (no pid): no harness can exist. */
  spawnFailed: boolean;
  /** Any child/pipe error observed (spawn, stdin, stdout, stderr). */
  error: string | null;
};

export type LauncherHandle = {
  child: ChildProcessWithoutNullStreams;
  nonce: string;
  statuses: LauncherStatus[];
  harnessStdout: Buffer[];
  harnessStderr: string[];
  /** Set when any retention bound was hit; the run must not be treated as a complete result. */
  overflow: { stdout: boolean; statuses: boolean; stderr: boolean };
  /** Returns false when the control line could not be written (launcher unresponsive). */
  terminate(): boolean;
  list(): void;
  /** §5.6 monitoring: one LIST round trip, bounded; null when no well-formed reply arrives in time. */
  listMembers(timeoutMs: number): Promise<MembersSnapshot | null>;
  /** Kills the LAUNCHER through Node's own child handle (identity-bound). Never a numeric PID. */
  killLauncher(): void;
  exited: Promise<LauncherExit>;
};

export type LaunchConfig = {
  exe: string;
  args: readonly string[];
  cwd: string;
  env: Record<string, string>;
  testHooks?: readonly string[];
  /** Only for tests: allow the launcher to honour testHooks. */
  allowTestHooks?: boolean;
};

export function startJobLauncher(cfg: LaunchConfig): LauncherHandle {
  if (process.platform !== 'win32') throw new Error('job_launcher_requires_windows');
  const nonce = randomUUID();
  const encoded = Buffer.from(BOOTSTRAP_SCRIPT, 'utf16le').toString('base64');
  const launcherEnv: Record<string, string> = {
    SystemRoot: process.env.SystemRoot ?? 'C:\\Windows',
    TEMP: process.env.TEMP ?? '', TMP: process.env.TMP ?? '',
    ...(cfg.allowTestHooks ? { LRW_ALLOW_TEST_HOOKS: '1' } : {}),
  };
  const child = spawn(`${launcherEnv.SystemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`,
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
    { cwd: cfg.cwd, env: launcherEnv, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const sink = createLauncherStatusSink();
  const statuses = sink.statuses;
  const harnessStdout: Buffer[] = [];
  const harnessStderr = sink.harnessStderr;
  const overflow = { stdout: false, get statuses() { return sink.overflow.statuses; }, get stderr() { return sink.overflow.stderr; } };
  let listsSent = 0;
  let stdoutBytes = 0;
  let firstError: string | null = null;
  const noteError = (where: string) => (e: Error) => { firstError ??= `${where}:${(e as NodeJS.ErrnoException).code ?? e.name}`; };
  child.stdin.on('error', noteError('stdin'));
  child.stdout.on('error', noteError('stdout'));
  child.stderr.on('error', noteError('stderr'));
  child.stdout.on('data', (b: Buffer) => {
    if (stdoutBytes + b.length > LAUNCHER_BOUNDS.stdoutBytes) { overflow.stdout = true; return; }
    stdoutBytes += b.length; harnessStdout.push(b);
  });
  child.stderr.on('data', (b: Buffer) => sink.push(b.toString('utf8')));
  // Settles on 'exit' OR on a spawn error (which may never be followed by 'exit').
  const exited = new Promise<LauncherExit>((resolve) => {
    child.on('exit', (code, signal) => resolve({ code, signal, spawnFailed: false, error: firstError }));
    child.on('error', (e) => {
      noteError('child')(e);
      if (child.pid === undefined) resolve({ code: null, signal: null, spawnFailed: true, error: firstError });
    });
  });
  const write = (line: string): boolean => {
    if (!child.stdin.writable) return false;
    try { child.stdin.write(line); return true; } catch (e) { noteError('stdin')(e as Error); return false; }
  };
  const cmdLine = [cfg.exe, ...cfg.args].map(quoteWindowsArg).join(' ');
  write(`${Buffer.from(LAUNCHER_SCRIPT, 'utf8').toString('base64')}\n`);
  write(`${JSON.stringify({ exe: cfg.exe, cmdLine, cwd: cfg.cwd, envBlock: buildEnvBlock(cfg.env), nonce, testHooks: cfg.testHooks ?? [] })}\n`);
  return {
    child, nonce, statuses, harnessStdout, harnessStderr, overflow, exited,
    terminate: () => write(`TERMINATE ${nonce}\n`),
    list: () => { write(`LIST ${nonce}\n`); },
    // Replies are correlated by their stable sequence number: this request's reply is the
    // listsSent-th one. A late reply to an earlier timed-out LIST is never mistaken for it.
    listMembers: async (timeoutMs) => {
      if (!write(`LIST ${nonce}\n`)) return null;
      const n = ++listsSent;
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (sink.membersReceived() >= n) { const r = sink.memberReply(n); return r ? parseMembersStatus(r) : null; }
        await new Promise((r) => setTimeout(r, 25));
      }
      return null;
    },
    killLauncher: () => { try { child.kill('SIGKILL'); } catch (e) { noteError('kill')(e as Error); } },
  };
}

/** Launcher exit codes: 0 root exited & job empty; 70-78 setup failures (no harness ran); 79 unverified; 80 terminated & verified. */
export function interpretLauncherExit(code: number | null): 'completed' | 'harness_unavailable' | 'termination_unverified' | 'terminated_verified' {
  if (code === 0) return 'completed';
  if (code === 80) return 'terminated_verified';
  if (code !== null && code >= 70 && code <= 78) return 'harness_unavailable';
  return 'termination_unverified';
}
