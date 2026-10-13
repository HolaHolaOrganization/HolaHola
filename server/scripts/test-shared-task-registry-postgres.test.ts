import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { SharedTaskRegistry, type RegistryDatabase } from '../services/shared-task-registry-service';
import { digest, TASK_ACTOR_OUTSTANDING_LIMIT } from '../services/shared-task-registry-contract';

function disposableTarget() {
  const dedicated = process.env.SHARED_TASK_REGISTRY_TEST_DATABASE_URL;
  const gate = process.env.COORDINATOR_V2_REQUIRE_DATABASE_TESTS==='1';
  const url = dedicated || (gate ? process.env.COORDINATOR_V2_TEST_DATABASE_URL : undefined);
  if (!url) {
    if (process.env.SHARED_TASK_REGISTRY_REQUIRE_DATABASE_TESTS==='1' || gate) throw new Error('Required disposable registry target missing');
    return null;
  }
  const disposable=dedicated ? process.env.SHARED_TASK_REGISTRY_TEST_DATABASE_DISPOSABLE : process.env.COORDINATOR_V2_TEST_DATABASE_DISPOSABLE;
  const forbidden=dedicated ? process.env.SHARED_TASK_REGISTRY_FORBIDDEN_SHARED_URL : process.env.COORDINATOR_V2_FORBIDDEN_SHARED_URL;
  const host=(value:string)=>new URL(value).hostname.replace('-pooler.','.');
  if (disposable!=='1' || !forbidden || host(url)===host(forbidden)) throw new Error('Unsafe registry test target');
  return url;
}
const migrationSource=readFileSync('migrations/0065_shared_task_registry.sql','utf8');
const repo='github:davidwmcintosh/holahola';
const commit='a'.repeat(40);
test('registry test fails closed without its dedicated disposable URL', () => {
  const before=process.env.SHARED_TASK_REGISTRY_REQUIRE_DATABASE_TESTS;
  if (!process.env.SHARED_TASK_REGISTRY_TEST_DATABASE_URL && process.env.COORDINATOR_V2_REQUIRE_DATABASE_TESTS!=='1') {
    process.env.SHARED_TASK_REGISTRY_REQUIRE_DATABASE_TESTS='1';
    assert.throws(disposableTarget,/Required disposable/);
    if(before===undefined)delete process.env.SHARED_TASK_REGISTRY_REQUIRE_DATABASE_TESTS;else process.env.SHARED_TASK_REGISTRY_REQUIRE_DATABASE_TESTS=before;
  } else assert.ok(disposableTarget());
});
test('real PostgreSQL migration, legacy faults, concurrent registry/CAS/old-writer races', async context => {
  const url=disposableTarget();
  if(!url){context.skip('verified disposable registry target required');return;}
  // Job-local namespace makes reruns hermetic even after the gate has applied
  // the migration to public. No canonical production row is a fixture.
  const namespace='registry_'+randomUUID().replaceAll('-','');
  const admin=new Pool({connectionString:url,max:1});
  await admin.query(`CREATE SCHEMA ${namespace}`);
  for(const table of ['coordination_v2_task_artifacts','coordination_threads','coordination_events']) {
    await admin.query(`CREATE TABLE ${namespace}.${table} (LIKE public.${table} INCLUDING ALL)`);
  }
  const migration=migrationSource.replaceAll('"public"."shared_task_definitions"',`"${namespace}"."shared_task_definitions"`);
  const pool=new Pool({connectionString:url,max:8,connectionTimeoutMillis:10000,options:`-c search_path=${namespace},public`});
  const client=await pool.connect();
  try {
    // Migration must fail atomically on poisoned legacy bytes.
    await client.query('BEGIN');
    await client.query(`INSERT INTO coordination_v2_task_artifacts(task_ref,artifact_base64,task_artifact_sha256,repository_identity,starting_commit,published_by)
      VALUES('999998','eA==',$1,$2,$3,'registry-test')`,['f'.repeat(64),repo,commit]);
    await assert.rejects(client.query(migration),/TASK_REGISTRY_BACKFILL_CONFLICT/);
    await client.query('ROLLBACK');
    assert.equal((await client.query("SELECT to_regclass($1) AS name",[`${namespace}.shared_task_definitions`])).rows[0].name,null);
    // Accepted bootstrap hash collision also blocks the entire rollout.
    await client.query('BEGIN');
    await client.query(`INSERT INTO coordination_v2_task_artifacts(task_ref,artifact_base64,task_artifact_sha256,repository_identity,starting_commit,published_by)
      VALUES('1000002','eA==',$1,$2,$3,'registry-test') ON CONFLICT(task_ref) DO UPDATE SET artifact_base64='eA==',task_artifact_sha256=$1`,[digest('x'),repo,commit]);
    await assert.rejects(client.query(migration),/TASK_REGISTRY_BACKFILL_CONFLICT/);
    await client.query('ROLLBACK');
    // Valid unknown legacy provenance is kept, never invented.
    await client.query('BEGIN');
    await client.query(`INSERT INTO coordination_v2_task_artifacts(task_ref,artifact_base64,task_artifact_sha256,repository_identity,starting_commit,published_by)
      VALUES('999997','eA==',$1,$2,$3,'legacy-transport-publisher')`,[digest('x'),repo,commit]);
    await client.query(migration);
    const legacy=(await client.query("SELECT * FROM shared_task_definitions WHERE task_ref='999997'")).rows[0];
    assert.equal(legacy.creator_actor,null);assert.equal(legacy.definition.title,null);
    assert.equal(legacy.definition.publishedBy,'legacy-transport-publisher');
    await client.query('COMMIT');
    const bootstrap=(await client.query("SELECT * FROM shared_task_definitions WHERE task_ref IN('1000001','1000002') ORDER BY task_ref")).rows;
    assert.equal(bootstrap.length,2);
    for(const b of bootstrap) assert.equal(digest(Buffer.from(b.artifact_base64,'base64')),b.artifact_sha256);
    const actor='luca-registry-test';const peer='luca-registry-peer';const thread=randomUUID();
    await client.query(`INSERT INTO coordination_threads(id,title,description,origin_actor,intended_recipient) VALUES($1,'Synthetic registry thread','Disposable test',$2,$3)`,[thread,actor,peer]);
    const input={repositoryIdentity:repo,startingCommit:commit,title:'Synthetic task',purpose:'Prove frozen registry',
      scope:['Disposable tests'],exclusions:['No execution authority'],sourceThread:thread};
    const registry=new SharedTaskRegistry(async()=>drizzle(pool) as unknown as RegistryDatabase,repo,async()=>false);
    const [one,retry]=await Promise.all([registry.create(actor,'same',input),registry.create(actor,'same',input)]);
    assert.equal(one.task_ref,retry.task_ref);assert.ok(BigInt(one.task_ref)>1000002n);
    assert.equal(one.ownership.grantsAuthority,false);
    await assert.rejects(registry.create(actor,'same',{...input,title:'Changed'}),/IDEMPOTENCY_CONFLICT/);
    const [two,three]=await Promise.all([registry.create(actor,'distinct-1',input),registry.create(peer,'distinct-2',input)]);
    assert.notEqual(two.task_ref,three.task_ref);
    await assert.rejects(registry.create('luca-unrelated','forbidden',input),/SOURCE_THREAD_FORBIDDEN/);
    await assert.rejects(registry.create(actor,'wrong-project',{...input,repositoryIdentity:'github:other/project'}),/PROJECT_FORBIDDEN/);
    const bytes=Buffer.from('exact imported task\n');
    const imported={...input,taskRef:'9007199254740993',sourceKind:'replit',artifactBase64:bytes.toString('base64')};
    const [a,b]=await Promise.all([registry.create(actor,'import-a',imported,true),registry.create(peer,'import-b',imported,true)]);
    assert.equal(a.task_ref,'9007199254740993');assert.equal(a.creator_actor,b.creator_actor);
    assert.equal((a.definition as any).platformProvenance.verified,false);
    await assert.rejects(registry.create(actor,'import-drift',{...imported,scope:['Different scope']},true),/TASK_CONFLICT/);
    await assert.rejects(registry.create(actor,'import-byte-drift',{...imported,artifactBase64:Buffer.from('different').toString('base64')},true),/TASK_CONFLICT/);
    const after=await registry.create(peer,'after-high',input);assert.ok(BigInt(after.task_ref)>9007199254740993n);
    // Application-bypassing identity/byte edits and deletes are refused.
    await assert.rejects(client.query("UPDATE shared_task_definitions SET definition='{}' WHERE task_ref=$1",[one.task_ref]),/TASK_DEFINITION_IMMUTABLE/);
    await assert.rejects(client.query('DELETE FROM shared_task_definitions WHERE task_ref=$1',[one.task_ref]),/TASK_DEFINITION_IMMUTABLE/);
    await assert.rejects(client.query("UPDATE coordination_v2_task_artifacts SET artifact_base64='eA==' WHERE task_ref=$1",[one.task_ref]),/TASK_ARTIFACT_FROZEN/);
    await assert.rejects(client.query("INSERT INTO coordination_v2_task_artifacts(task_ref,artifact_base64,task_artifact_sha256,repository_identity,starting_commit,published_by) VALUES('999996','eA==',$1,$2,$3,'old-writer')",[digest('x'),repo,commit]),/TASK_REGISTRY_IMPORT_REQUIRED/);
    await assert.rejects(registry.transition(peer,one.task_ref,{state:'completed',expectedVersion:1,reason:'Unrelated actor'}),/TRANSITION_FORBIDDEN/);
    const cas=await Promise.allSettled([registry.transition(actor,one.task_ref,{state:'active',expectedVersion:1,reason:'CAS one'}),
      registry.transition(actor,one.task_ref,{state:'blocked',expectedVersion:1,reason:'CAS two'})]);
    assert.equal(cas.filter(r=>r.status==='fulfilled').length,1);
    assert.match(String((cas.find(r=>r.status==='rejected') as PromiseRejectedResult).reason),/VERSION_CONFLICT/);
    assert.deepEqual(await registry.create(actor,'same',input),one,'exact retry is independent of lifecycle mutations');
    // Both acquisition orders: an old exact upsert cannot change provenance;
    // a raw UPDATE fails fast rather than invert row-lock -> ref-lock order.
    const legacyWriter=await pool.connect();
    const upsert=`INSERT INTO coordination_v2_task_artifacts(task_ref,artifact_base64,task_artifact_sha256,repository_identity,starting_commit,published_by)
      SELECT task_ref,artifact_base64,artifact_sha256,repository_identity,starting_commit,'old-writer'
      FROM shared_task_definitions WHERE task_ref=$1 ON CONFLICT(task_ref) DO UPDATE SET
      artifact_base64=excluded.artifact_base64,published_by=excluded.published_by`;
    try {
      await legacyWriter.query('BEGIN');
      await legacyWriter.query(upsert,[a.task_ref]);
      const pendingImport=registry.create(peer,'old-first-import',imported,true);
      await legacyWriter.query('COMMIT');
      assert.equal((await pendingImport).artifact_sha256,a.artifact_sha256);
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[a.task_ref]);
      const pendingOld=legacyWriter.query(upsert,[a.task_ref]);
      await client.query('COMMIT');
      await pendingOld;
      assert.equal((await client.query('SELECT published_by FROM coordination_v2_task_artifacts WHERE task_ref=$1',[a.task_ref])).rows[0].published_by,a.creator_actor);
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[a.task_ref]);
      await assert.rejects(legacyWriter.query("UPDATE coordination_v2_task_artifacts SET published_by='raw-writer' WHERE task_ref=$1",[a.task_ref]),/TASK_ARTIFACT_BUSY/);
      await client.query('ROLLBACK');
    } finally {legacyWriter.release();}
    // Rollback releases the shared ref lock without modifying identity.
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[a.task_ref]);
    const afterRollback=registry.create(peer,'rollback-import',imported,true);
    await client.query('ROLLBACK');
    assert.equal((await afterRollback).artifact_sha256,a.artifact_sha256);
    // A lost old-writer connection rolls back; a fresh pool/service can replay
    // the committed request using DB state only, not a process-local cursor.
    const lostWriter=await pool.connect();
    await lostWriter.query('BEGIN');await lostWriter.query(upsert,[a.task_ref]);
    const afterDisconnect=registry.create(peer,'disconnect-import',imported,true);
    lostWriter.release(true);
    assert.equal((await afterDisconnect).artifact_sha256,a.artifact_sha256);
    const restartedPool=new Pool({connectionString:url,options:`-c search_path=${namespace},public`});
    try {
      const restarted=new SharedTaskRegistry(async()=>drizzle(restartedPool) as unknown as RegistryDatabase,repo,async()=>false);
      assert.deepEqual(await restarted.create(peer,'disconnect-import',imported,true),await registry.create(peer,'disconnect-import',imported,true));
    } finally {await restartedPool.end();}
    // Bounds are serialized per actor; concurrent requests cannot exceed them.
    const bounded=await Promise.allSettled(Array.from({length:12},(_,i)=>registry.create('luca-registry-peer',`bounded-${i}`,input)));
    const peerCount=(await client.query('SELECT count(*)::int AS count FROM shared_task_definitions WHERE creator_actor=$1',[peer])).rows[0].count;
    assert.equal(peerCount,TASK_ACTOR_OUTSTANDING_LIMIT);
    assert.ok(bounded.some(r=>r.status==='rejected'&&String(r.reason).includes('ALLOCATION_LIMIT')));
    assert.equal((await client.query('SELECT count(*)::int AS count FROM shared_task_events WHERE task_ref=$1',[one.task_ref])).rows[0].count,2);
    // Daily bound still applies after every outstanding task is closed.
    const peerTasks=(await client.query('SELECT d.task_ref,l.version FROM shared_task_definitions d JOIN shared_task_lifecycle l USING(task_ref) WHERE creator_actor=$1',[peer])).rows;
    for(const task of peerTasks)await registry.transition(peer,task.task_ref,{state:'completed',expectedVersion:task.version,reason:'Disposable daily bound'});
    for(let i=peerTasks.length;i<20;i++){
      const task=await registry.create(peer,`daily-${i}`,input);
      await registry.transition(peer,task.task_ref,{state:'completed',expectedVersion:1,reason:'Disposable daily bound'});
    }
    await assert.rejects(registry.create(peer,'daily-overflow',input),/ALLOCATION_LIMIT/);
    // SQL numeric advancement preserves over-bigint imports and fails closed
    // on subsequent allocation instead of rounding/reusing a reference.
    const huge={...imported,taskRef:'99999999999999999999999999999999'};
    await registry.create(actor,'huge-import',huge,true);
    await assert.rejects(registry.create(actor,'sequence-exhausted',input),/ALLOCATION_EXHAUSTED/);
  } finally {
    await client.query('ROLLBACK').catch(()=>{});client.release();await pool.end();
    await admin.query(`DROP SCHEMA ${namespace} CASCADE`);await admin.end();
  }
});
