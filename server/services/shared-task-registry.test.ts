import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, symlink, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { artifactBytes, digest, renderTaskArtifact, taskInput, taskReference } from './shared-task-registry-contract';
import { materializeRegistryArtifact } from './shared-task-registry-materialize';
import { normalizeCoordinationRepositoryIdentity as normalize } from './coordination-repository-identity';
import { TaskOwnershipService } from './task-ownership-service';

const input = { repositoryIdentity: 'github:davidwmcintosh/holahola', startingCommit: 'a'.repeat(40),
  title: 'Exact registry task', purpose: 'Test without granting authority', scope: ['Code and tests'],
  exclusions: ['No publication'], sourceThread: '872ea6d0-bd94-4d0f-9ccf-187c18187a02' };
test('reference boundaries preserve integers beyond JS safe precision', () => {
  for (const ref of ['1', '1000000', '9007199254740993', '99999999999999999999999999999999']) assert.equal(taskReference(ref), ref);
  for (const ref of [0, 1, 9007199254740992, '01', '-1', '0', '../1', '1e7', '1 '.trimEnd()+' ', '9'.repeat(33)]) assert.throws(() => taskReference(ref));
});
test('deterministic task bytes bind creator and immutable scope, never authority', () => {
  const validated = taskInput(input);
  const bytes = renderTaskArtifact('9007199254740993', 'luca-replit', validated);
  assert.deepEqual(bytes, renderTaskArtifact('9007199254740993', 'luca-replit', validated));
  assert.notEqual(digest(bytes), digest(renderTaskArtifact('9007199254740993', 'luca-claude-code', validated)));
  assert.match(bytes.toString(), /do not grant ownership/);
  assert.deepEqual(artifactBytes(bytes.toString('base64')), bytes);
});
test('strict UTF8/base64, current cap, source thread and scope checks', () => {
  for (const value of ['', '%%%=', Buffer.from([0xff]).toString('base64'), Buffer.alloc(262145, 'x').toString('base64'), 'eA==\n']) assert.throws(() => artifactBytes(value));
  for (const patch of [{ title: '' }, { scope: [1] }, { sourceThread: 'missing' }, { startingCommit: 'X'.repeat(40) }, { supersedes: 42 }]) assert.throws(() => taskInput({ ...input, ...patch }));
});
test('common remote forms normalize only GitHub components', () => {
  for (const remote of ['git@github.com:DavidWMcIntosh/HolaHola.git', 'https://github.com/DavidWMcIntosh/HolaHola.git',
    'ssh://git@github.com/DavidWMcIntosh/HolaHola.GIT', 'github:DavidWMcIntosh/HolaHola', input.repositoryIdentity]) {
    assert.equal(normalize(remote), input.repositoryIdentity);
  }
  for (const remote of ['https://token@github.com/a/b', 'https://github.com/a/b?x=1', 'ssh://evil@github.com/a/b',
    'https://evil.test/a/b', 'file:///a/b', 'github:a/../b', 'github:a/b%2f', 'github:a/b#x', 'github:a\\b/c',
    ' github:a/b', 'github:a/b/', 'github:a/b.', 'github:a/b..c']) assert.throws(() => normalize(remote));
});
test('complete exclusive materialization, concurrency, collision and no ownership', async () => {
  const root = await mkdtemp(join(tmpdir(), 'registry-materialize-'));
  try {
    const bytes = renderTaskArtifact('9007199254740993', 'luca-replit', taskInput(input));
    const raw = { taskRef: '9007199254740993', repositoryIdentity: input.repositoryIdentity,
      artifactBase64: bytes.toString('base64'), artifactSha256: digest(bytes) };
    const results = await Promise.all(Array.from({ length: 8 }, () => materializeRegistryArtifact(root, input.repositoryIdentity, raw)));
    assert.deepEqual(await readFile(results[0].path), bytes);
    assert.equal((await readdir(join(root,'.local','tasks'))).length, 1);
    assert.equal((await materializeRegistryArtifact(root, input.repositoryIdentity, raw)).reused, true);
    const changed = Buffer.from('different');
    await assert.rejects(materializeRegistryArtifact(root, input.repositoryIdentity, { ...raw,
      artifactBase64: changed.toString('base64'), artifactSha256: digest(changed) }), /LOCAL_ARTIFACT_CONFLICT/);
    await assert.rejects(materializeRegistryArtifact(root, 'github:another/repo', raw), /PROJECT_FORBIDDEN/);
    await assert.rejects(materializeRegistryArtifact(root, input.repositoryIdentity, { ...raw, artifactSha256:'f'.repeat(64) }), /ARTIFACT_HASH_MISMATCH/);
    assert.equal((await new TaskOwnershipService({ rootDir: root }).probe(raw.taskRef)).state,'unknown_stop');
  } finally { await rm(root,{recursive:true,force:true}); }
});
test('symlink parents, symlink final paths and interrupted temp files cannot authorize overwrite', async () => {
  const root = await mkdtemp(join(tmpdir(), 'registry-path-'));
  const outside = await mkdtemp(join(tmpdir(), 'registry-outside-'));
  const raw = { taskRef:'1', repositoryIdentity:input.repositoryIdentity, artifactBase64:'eA==', artifactSha256:digest('x') };
  try {
    await symlink(outside, join(root,'.local'), process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(materializeRegistryArtifact(root,input.repositoryIdentity,raw), /UNSAFE_ARTIFACT_PATH/);
    assert.deepEqual(await readdir(outside),[]);
    await rm(join(root,'.local'));
    await mkdir(join(root,'.local','tasks'),{recursive:true});
    await writeFile(join(root,'.local','tasks','task-1.md.interrupted.tmp'),'partial');
    await materializeRegistryArtifact(root,input.repositoryIdentity,raw);
    assert.equal(await readFile(join(root,'.local','tasks','task-1.md'),'utf8'),'x');
    await rm(join(root,'.local','tasks','task-1.md'));
    // Windows junctions apply only to directories; parent coverage above is
    // native-safe even without the OS privilege needed for file symlinks.
    if (process.platform !== 'win32') {
      await writeFile(join(outside,'artifact'),'x');
      await symlink(join(outside,'artifact'),join(root,'.local','tasks','task-1.md'));
      await assert.rejects(materializeRegistryArtifact(root,input.repositoryIdentity,raw), /UNSAFE_ARTIFACT_PATH/);
    }
  } finally { await rm(root,{recursive:true,force:true});await rm(outside,{recursive:true,force:true}); }
});
