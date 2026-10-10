import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { ProcessIdentity } from './coordination-listener-identity';

// Keep the former CIM identity's microsecond precision and UTC round-trip format.
// Only GetProcessById's specific not-found exception establishes absence.
export const WINDOWS_IDENTITY_SCRIPT = `
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false)
[Console]::Out.WriteLine('{"ready":true}')
while ($null -ne ($line=[Console]::In.ReadLine())) {
  try {
    $parts=$line.Split('|')
    $id=[long]0
    $target=[int]0
    if ($parts.Length -ne 2 -or ![long]::TryParse($parts[0],[ref]$id) -or
        ![int]::TryParse($parts[1],[ref]$target) -or $id -lt 1 -or $target -lt 1) {
      [Console]::Out.WriteLine('{"state":"unknown"}')
      continue
    }
    $state='unknown'
    $created=$null
    $p=$null
    try { $p=[System.Diagnostics.Process]::GetProcessById($target) }
    catch { if ($_.Exception.GetBaseException() -is [System.ArgumentException]) { $state='absent' } }
    if ($null -ne $p) {
      try {
        $start=$p.StartTime.ToUniversalTime()
        $start=$start.AddTicks(-($start.Ticks % 10))
        $state='present'
        $created=$start.ToString('o')
      } catch { $state='unknown'; $created=$null }
      finally { $p.Dispose() }
    }
    $response='{"id":'+$id+',"state":"'+$state+'"'
    if ($state -eq 'present') { $response+=',"created":"'+$created+'"' }
    [Console]::Out.WriteLine($response+'}')
  } catch { [Console]::Out.WriteLine('{"state":"unknown"}') }
}`;

interface Worker {
  child: ChildProcessWithoutNullStreams;
  ready: Promise<boolean>;
  finishReady: (ready: boolean) => void;
  startupTimer?: NodeJS.Timeout;
  buffer: string;
  isReady: boolean;
  failed?: boolean;
}
export interface WindowsReaderOptions {
  spawnImpl?: typeof spawn;
  startupMs?: number;
  queryMs?: number;
}

/** One owned, bounded helper. No PID cache, CIM provider, shell, policy override or remote API. */
export class WindowsIdentityReader {
  private worker?: Worker;
  private tail: Promise<unknown> = Promise.resolve();
  private queued = 0;
  private sequence = 0;
  private closed = false;
  private pending?: { worker: Worker; id: number; finish: (result: ProcessIdentity) => void; timer: NodeJS.Timeout };
  constructor(private executable: string, private options: WindowsReaderOptions = {}) {}

  query(pid: number): Promise<ProcessIdentity> {
    if (this.closed || !Number.isSafeInteger(pid) || pid < 1 || pid > 0x7fffffff || this.queued >= 32) {
      return Promise.resolve({ state: 'unknown' });
    }
    this.queued++;
    const result = this.tail.then(() => this.querySerial(pid));
    this.tail = result.catch(() => {});
    return result.finally(() => { this.queued--; });
  }

  close() { this.closed = true; if (this.worker) this.fail(this.worker); }

  private fail(worker: Worker) {
    if (worker.failed) return;
    worker.failed = true;
    if (this.worker === worker) this.worker = undefined;
    clearTimeout(worker.startupTimer);
    worker.finishReady(false);
    if (this.pending?.worker === worker) {
      const request = this.pending;
      this.pending = undefined;
      clearTimeout(request.timer);
      request.finish({ state: 'unknown' });
    }
    // Only the child handle created by this reader; never kill a queried process.
    worker.child.stdin.destroy();
    worker.child.stdout.destroy();
    worker.child.stderr.destroy();
    worker.child.kill();
  }

  private start(): Worker | undefined {
    let child: ChildProcessWithoutNullStreams;
    try {
      child = (this.options.spawnImpl ?? spawn)(this.executable,
        ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand',
          Buffer.from(WINDOWS_IDENTITY_SCRIPT, 'utf16le').toString('base64')],
        { shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch { return undefined; }
    let finishReady!: (ready: boolean) => void;
    const worker: Worker = { child, ready: new Promise(r => { finishReady = r; }),
      finishReady, buffer: '', isReady: false };
    this.worker = worker;
    worker.startupTimer = setTimeout(() => this.fail(worker), this.options.startupMs ?? 60_000);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      if (this.worker !== worker) return;
      worker.buffer += chunk;
      if (Buffer.byteLength(worker.buffer) > 4096) return this.fail(worker);
      let end: number;
      while ((end = worker.buffer.indexOf('\n')) >= 0) {
        const line = worker.buffer.slice(0, end).replace(/^\uFEFF/, '').trim();
        worker.buffer = worker.buffer.slice(end + 1);
        let value: any;
        try { value = JSON.parse(line); } catch { return this.fail(worker); }
        if (!worker.isReady) {
          if (value?.ready !== true || Object.keys(value).length !== 1) return this.fail(worker);
          worker.isReady = true;
          clearTimeout(worker.startupTimer);
          worker.finishReady(true);
          continue;
        }
        const request = this.pending;
        if (!request || request.worker !== worker || value?.id !== request.id ||
            !['present', 'absent', 'unknown'].includes(value.state) ||
            (value.state === 'present' && (typeof value.created !== 'string' ||
              !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}0Z$/.test(value.created) ||
              !Number.isFinite(Date.parse(value.created))))) {
          return this.fail(worker);
        }
        this.pending = undefined;
        clearTimeout(request.timer);
        request.finish(value.state === 'present' ? { state: 'present', created: value.created }
          : { state: value.state });
      }
    });
    child.on('error', () => this.fail(worker));
    child.on('close', () => this.fail(worker));
    child.stdin.on('error', () => this.fail(worker));
    // Drain without echoing stderr, with a cumulative cap.
    let errors = 0;
    child.stderr.on('data', chunk => {
      errors += Buffer.byteLength(chunk);
      if (errors > 4096) this.fail(worker);
    });
    // An idle helper must not keep a short-lived CLI alive. EOF ends its read loop.
    child.unref();
    for (const stream of [child.stdin, child.stdout, child.stderr]) {
      (stream as typeof stream & { unref?: () => void }).unref?.();
    }
    return worker;
  }

  private async querySerial(pid: number): Promise<ProcessIdentity> {
    if (this.closed) return { state: 'unknown' };
    const worker = this.worker ?? this.start();
    if (!worker || !await worker.ready || this.worker !== worker) return { state: 'unknown' };
    return new Promise(resolve => {
      const id = ++this.sequence;
      const timer = setTimeout(() => this.fail(worker), this.options.queryMs ?? 10_000);
      this.pending = { worker, id, finish: resolve, timer };
      worker.child.stdin.write(`${id}|${pid}\n`, error => {
        if (error) this.fail(worker);
      });
    });
  }
}
