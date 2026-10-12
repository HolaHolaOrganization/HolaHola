import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { publishOwnershipRecord, ownershipStatus, recoverOwnershipGuard, withOwnershipGuard } from './coordination-listener-ownership';
import { closeProcessIdentityReader } from './coordination-listener-identity';

const scope = { actor: 'luca-replit', apiUrl: 'https://example.com' };
async function fixture(t: any) {
  const directory = await fs.mkdtemp(join(tmpdir(), 'ownership-publication-'));
  t.after(async () => { closeProcessIdentityReader(); await fs.rm(directory, { recursive: true, force: true }); });
  return directory;
}

test('exclusive publication never overwrites a winner and removes only its own staging file', async t => {
  const directory = await fixture(t), path = join(directory, 'ownership.guard');
  await fs.writeFile(path, 'original-winner');
  const unrelated = `ownership.guard.${randomUUID()}.tmp`;
  await fs.writeFile(join(directory, unrelated), 'another-process-staging');
  await assert.rejects(publishOwnershipRecord(path, { owner: 'loser' }), { code: 'EEXIST' });
  assert.equal(await fs.readFile(path, 'utf8'), 'original-winner');
  assert.deepEqual((await fs.readdir(directory)).sort(), ['ownership.guard', unrelated].sort());
});

test('a staging-name collision never deletes the file whose exclusive open we lost', async t => {
  const directory = await fixture(t), path = join(directory, 'ownership.guard');
  let collidedPath = '';
  await assert.rejects(publishOwnershipRecord(path, { owner: 'loser' }, {
    ...fs,
    open: async (...args) => {
      collidedPath = String(args[0]);
      await fs.writeFile(collidedPath, 'another-publisher', { flag: 'wx' });
      throw Object.assign(Error('staging_collision'), { code: 'EEXIST' });
    },
  }), { code: 'EEXIST' });
  assert.equal(await fs.readFile(collidedPath, 'utf8'), 'another-publisher');
  await assert.rejects(fs.readFile(path), { code: 'ENOENT' });
});

test('partial-write and link failures leave neither final names nor blocking staging files', async t => {
  const directory = await fixture(t);
  for (const failure of ['write', 'link']) {
    const path = join(directory, `guard-recovery-${randomUUID()}.json`);
    await assert.rejects(publishOwnershipRecord(path, { owner: 'never-published' }, {
      ...fs,
      open: async (...args) => {
        const handle = await fs.open(...args);
        if (failure === 'write') handle.writeFile = async () => {
          await handle.write('{"partial":');
          throw Error('injected_write_failure');
        };
        return handle;
      },
      link: async (...args) => {
        if (failure === 'link') throw Error('injected_link_failure');
        await fs.link(...args);
      },
    }), /injected_/);
    assert.deepEqual(await fs.readdir(directory), []);
  }
});

for (const stage of ['opened', 'prepared', 'published']) {
  for (const target of ['guard', 'recovery-marker']) {
    test(`real child death at ${stage} leaves ${target} absent or complete and explicitly recoverable`, async t => {
      const directory = await fixture(t);
      const name = target === 'guard' ? 'ownership.guard' : `guard-recovery-${randomUUID()}.json`;
      const path = join(directory, name);
      const driver = `
        import * as fs from 'node:fs/promises';
        import {publishOwnershipRecord} from './server/scripts/lib/coordination-listener-ownership.ts';
        import {readProcessIdentity} from './server/scripts/lib/coordination-listener-identity.ts';
        const identity=await readProcessIdentity(process.pid);
        if(identity.state!=='present')throw Error('child_identity_unknown');
        const pause=()=>new Promise(()=>{setInterval(()=>{},1000);process.send({stage:${JSON.stringify(stage)}})});
        await publishOwnershipRecord(process.argv[1],
          {...${JSON.stringify(scope)},pid:process.pid,created:identity.created,owner:${JSON.stringify(randomUUID())}},
          {open:async(...args)=>{const h=await fs.open(...args);if(${JSON.stringify(stage)}==='opened')await pause();return h},
           link:async(...args)=>{if(${JSON.stringify(stage)}==='prepared')await pause();await fs.link(...args);
             if(${JSON.stringify(stage)}==='published')await pause()},unlink:fs.unlink});
      `;
      const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', driver, path],
        { cwd: process.cwd(), stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
      const exited = once(child, 'exit');
      t.after(() => child.kill());
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(Error('fault_boundary_deadline')), 120_000);
        child.once('message', value => {
          clearTimeout(timer);
          try { assert.deepEqual(value, { stage }); resolve(); } catch (e) { reject(e); }
        });
        child.once('exit', () => { clearTimeout(timer); reject(Error('child_exited_before_boundary')); });
        child.once('error', e => { clearTimeout(timer); reject(e); });
      });
      if (stage === 'published') {
        const record = JSON.parse(await fs.readFile(path, 'utf8'));
        assert.equal(record.pid, child.pid);
        assert.equal(record.actor, scope.actor);
        assert.equal(record.apiUrl, scope.apiUrl);
        assert.equal(typeof record.created, 'string');
        assert.ok(record.created.length);
      } else {
        await assert.rejects(fs.readFile(path), { code: 'ENOENT' });
        const staging = (await fs.readdir(directory)).filter(n => n.endsWith('.tmp'));
        assert.equal(staging.length, 1);
        const data = await fs.readFile(join(directory, staging[0]), 'utf8');
        if (stage === 'opened') assert.equal(data, '');
        else assert.equal(JSON.parse(data).pid, child.pid);
      }
      child.kill('SIGKILL');
      await exited;
      // Real native identity query, not a fabricated "absent" reader.
      await recoverOwnershipGuard(directory, scope);
      assert.deepEqual(await ownershipStatus(directory), { guardPresent: false, recoveryMarkers: [] });
      await withOwnershipGuard(directory, scope, async () => {
        const record = JSON.parse(await fs.readFile(join(directory, 'ownership.guard'), 'utf8'));
        assert.equal(record.pid, process.pid);
      });
      assert.deepEqual(await ownershipStatus(directory), { guardPresent: false, recoveryMarkers: [] });
    });
  }
}
