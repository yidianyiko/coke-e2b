import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, writeFile, access } from 'node:fs/promises';
import { TaskStore } from '../src/task-store.mjs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
const exec=promisify(execFile);
async function setup(t, decisions) {
 const observations=[]; const modelRequests=[];
 const site=createServer((_q,r)=>{r.setHeader('content-type','text/html');r.end('<main>workspace-value-42</main>');});
 const model=createServer(async(q,r)=>{
  const chunks=[];for await(const chunk of q)chunks.push(chunk);
  const body=JSON.parse(Buffer.concat(chunks));modelRequests.push(body);
  observations.push(JSON.parse(body.messages.at(-1).content));
  r.setHeader('content-type','application/json');
  r.end(JSON.stringify({choices:[{message:{content:JSON.stringify(decisions[observations.length-1] || {action:'answer',value:'workspace-value-42'})}}]}));
 });
 await Promise.all([new Promise(r=>site.listen(0,'127.0.0.1',r)),new Promise(r=>model.listen(0,'127.0.0.1',r))]);
 const output=await mkdtemp(join(tmpdir(),'coke-agent-workspace-'));
 t.after(async()=>{site.close();model.close();await rm(output,{recursive:true,force:true});});
 return {observations,modelRequests,output,run(runtime='local',importHook) {return exec(process.execPath,[...(importHook?['--import',importHook]:[]),resolve('bin/coke.mjs'),'task','run','Read the page value, save it to report.txt, read the saved file and report the value','--runtime',runtime,'--user','workspace-user','--url',`http://127.0.0.1:${site.address().port}/`,'--model','fixture-model','--output-dir',output],{timeout:runtime==='e2b'?90000:30000,env:{...process.env,COKE_MODEL_API_KEY:'fixture-secret',COKE_MODEL_REASONING_EFFORT:'low',COKE_MODEL_BASE_URL:`http://127.0.0.1:${model.address().port}/v1`}});}};
}
for(const runtime of ['local','e2b']) test(`model writes and reads a task-bound workspace, delivers durable artifact (${runtime})`,{skip:runtime==='e2b'&&(!process.env.RUN_E2B_TEST||!process.env.E2B_API_KEY)},async t=>{
 const f=await setup(t,[{action:'workspace-write',path:'report.txt',value:'workspace-value-42',idempotencyKey:'save-report'},{action:'workspace-read',path:'report.txt'},{action:'answer',value:'workspace-value-42'}]);
 const {stdout}=await f.run(runtime);const result=JSON.parse(stdout);
 assert.equal(result.value,'workspace-value-42');
 assert.equal(f.modelRequests[0].reasoning_effort,'low');
 assert.equal(f.observations.length,3);
 assert.deepEqual(f.observations[1].workspaceResults.at(-1),{action:'workspace-write',path:'report.txt',result:{path:'report.txt',bytes:18}});
 assert.deepEqual(f.observations[2].workspaceResults.at(-1),{action:'workspace-read',path:'report.txt',result:{path:'report.txt',value:'workspace-value-42'}});
 for(const action of ['workspace-write','workspace-read']) {const entry=result.trace.find(x=>x.action===action);assert.equal(entry.ok,true);assert.equal(entry.source,`${runtime}-cli`);assert.equal(entry.result.path,'report.txt');assert.equal(entry.result.value,undefined);}
 const artifact=result.workspaceArtifacts.find(x=>x.path==='report.txt');
 assert.equal(artifact.bytes,18);assert.equal(await readFile(artifact.artifactPath,'utf8'),'workspace-value-42');
 assert.match(artifact.artifactPath,new RegExp(result.taskId));
 assert.equal(result.trace.at(-1).action,'release');
 if(runtime==='e2b'){assert.equal(result.sandboxKilled,true);assert.match(result.workspaceCliSha256,/^[a-f0-9]{64}$/);}
});
test('Agent workspace traversal refusal keeps task-bound error and releases lease',async t=>{
 const f=await setup(t,[{action:'workspace-write',path:'../escape.txt',value:'private',idempotencyKey:'escape'}]);
 await assert.rejects(f.run(),error=>{const result=JSON.parse(error.stderr);assert.equal(result.error.code,'INVALID_WORKSPACE_PATH');assert.ok(result.taskId);assert.equal(result.trace.at(-1).action,'release');return true;});
});
test('completed workspace writes are exported before cleanup after later Agent failure',async t=>{
 const f=await setup(t,[{action:'workspace-write',path:'report.txt',value:'workspace-value-42',idempotencyKey:'save-before-failure'},{action:'not-a-tool'},{action:'not-a-tool'},{action:'not-a-tool'}]);
 let artifact;
 await assert.rejects(f.run(),error=>{const result=JSON.parse(error.stderr);assert.equal(result.error.code,'MODEL_INVALID_ACTION');assert.equal(result.workspaceArtifacts.length,1);artifact=result.workspaceArtifacts[0].artifactPath;assert.equal(result.trace.at(-1).action,'release');return true;});
 assert.equal(f.observations.length,4);
 assert.equal(f.observations.at(-1).feedback.length,2);
 assert.equal(await readFile(artifact,'utf8'),'workspace-value-42');
});

for (const seam of ['screenshot','workspace','ledger']) test(`SIGINT during ${seam} export cancels a completed outcome and preserves workspace artifact`,async t=>{
 const f=await setup(t,[{action:'workspace-write',path:'report.txt',value:'workspace-value-42',idempotencyKey:'save-before-cancel'},{action:'answer',value:'workspace-value-42'}]);
 const hook=join(f.output,'cleanup-signal.mjs');
 await writeFile(hook,`import fs from 'node:fs/promises';
import {syncBuiltinESMExports} from 'node:module';
const original=fs.writeFile;let fired=false;
fs.writeFile=async(...args)=>{const result=await original(...args);const path=String(args[0]);if(!fired && ${JSON.stringify(seam)}==='screenshot' && path.endsWith('/screenshot.png') || !fired && ${JSON.stringify(seam)}==='workspace' && /\\/workspace-[a-f0-9]+\\.txt$/.test(path) || !fired && ${JSON.stringify(seam)}==='ledger' && String(args[1]).includes('\"status\":\"succeeded\"')){fired=true;process.kill(process.pid,'SIGINT');await new Promise(r=>setTimeout(r,50));}return result;};
syncBuiltinESMExports();`);
 let result;
 await assert.rejects(f.run('local',hook),error=>{result=JSON.parse(error.stderr);assert.equal(result.error.code,'TASK_CANCELLED');assert.equal(result.trace.at(-1).action,'release');return true;});
 assert.equal(f.modelRequests.length,2,'the model produced its successful answer before cleanup cancellation');
 assert.equal(await readFile(result.workspaceArtifacts[0].artifactPath,'utf8'),'workspace-value-42');
 const record=await new TaskStore(f.output).get('workspace-user',result.taskId);
 assert.equal(record.status,'cancelled');assert.equal(record.errorCode,'TASK_CANCELLED');assert.equal(record.resourcesReleased,true);
 await assert.rejects(access(join(record.artifactDir,'.workspace')),{code:'ENOENT'});
});
