import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { digest } from './shared-task-registry-contract';

test('actual portable CLI subprocess materializes exact bytes, refuses collisions and hides parse bodies', async () => {
  const root=await mkdtemp(join(tmpdir(),'registry-cli-'));
  const script=resolve('server/scripts/shared-task-registry-cli.ts');
  const launcher=createRequire(import.meta.url).resolve('tsx/cli');
  const bytes=Buffer.from('# Frozen artifact\n\nNo execution authority.\n');
  const artifact={taskRef:'9007199254740993',repositoryIdentity:'github:davidwmcintosh/holahola',
    artifactBase64:bytes.toString('base64'),artifactSha256:digest(bytes)};
  const requests: string[]=[];
  const server=createServer((req,res)=>{
    assert.equal(req.headers['x-coordination-token'],'synthetic-token-'.repeat(4));
    requests.push(req.url!);
    res.setHeader('content-type','application/json');
    res.end(JSON.stringify(req.url!.endsWith('/artifact')?artifact:{...artifact,title:'Exact CLI task'}));
  });
  server.listen(0,'127.0.0.1');await new Promise<void>(r=>server.once('listening',r));
  const address=server.address() as {port:number};
  const run=(args:string[],actor='luca-replit')=>new Promise<{code:number|null;stdout:string;stderr:string}>((done,reject)=>{
    const child=spawn(process.execPath,[launcher,script,...args,'--url',`http://127.0.0.1:${address.port}`,'--actor',actor],{
      cwd:root,env:{...process.env,COORDINATION_LUCA_REPLIT_TOKEN:'synthetic-token-'.repeat(4),
        COORDINATION_LUCA_GEMINI_TOKEN:'synthetic-token-'.repeat(4),
        COORDINATION_LUCA_GEMINI_CODE_TOKEN:''},stdio:['ignore','pipe','pipe']});
    let stdout='',stderr='';child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b);
    child.on('error',reject);child.on('close',code=>done({code,stdout,stderr}));
  });
  try {
    execFileSync('git',['init','--quiet'],{cwd:root});
    execFileSync('git',['remote','add','origin','https://github.com/DavidWMcIntosh/HolaHola.git'],{cwd:root});
    const first=await run(['materialize','--ref',artifact.taskRef]);
    assert.equal(first.code,0,first.stderr);
    assert.deepEqual(await readFile(join(root,'.local','tasks',`task-${artifact.taskRef}.md`)),bytes);
    const retry=await run(['materialize','--ref',artifact.taskRef]);assert.equal(retry.code,0);
    assert.equal(JSON.parse(retry.stdout).reused,true);
    const gemini=await run(['show','--ref',artifact.taskRef],'luca-gemini');
    assert.equal(gemini.code,0,`Canonical Gemini credential subprocess: ${gemini.stderr}`);
    await writeFile(join(root,'.local','tasks',`task-${artifact.taskRef}.md`),'different');
    const conflict=await run(['materialize','--ref',artifact.taskRef]);
    assert.equal(conflict.code,1);assert.equal(conflict.stderr.trim(),'LOCAL_ARTIFACT_CONFLICT');
    assert.equal(await readFile(join(root,'.local','tasks',`task-${artifact.taskRef}.md`),'utf8'),'different');
    await mkdir(join(root,'inputs'));await writeFile(join(root,'inputs','bad.json'),'PRIVATE_SYNTHETIC_BODY');
    const invalid=await run(['create','--input','inputs/bad.json','--idempotency-key','fixed']);
    assert.equal(invalid.code,1);assert.equal(invalid.stderr.trim(),'REGISTRY_REQUEST_FAILED');
    assert.ok(!invalid.stderr.includes('PRIVATE_SYNTHETIC_BODY'));
    assert.equal(requests.length,4);
  } finally {server.close();await rm(root,{recursive:true,force:true});}
});
