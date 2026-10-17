import test from 'node:test';
import assert from 'node:assert/strict';
import {runAgentLoop} from '../src/agent-loop.mjs';
import {createServer} from 'node:http';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
const exec=promisify(execFile);
async function fixture(t,decision){
 const requests=[];
 const site=createServer((q,r)=>{r.setHeader('content-type','text/html');r.end(q.url==='/next'?'<title>Second page title</title><main>Second task: buy tea</main>':'<title>First page title</title><main>First task: read book</main><a href="/next">Next page</a>');});
 const model=createServer(async(q,r)=>{const chunks=[];for await(const c of q)chunks.push(c);const body=JSON.parse(Buffer.concat(chunks));const observation=JSON.parse(body.messages.at(-1).content);requests.push(observation);const d=requests.length===1?{action:'click-ref',ref:observation.elements.find(x=>x.role==='link').ref}:decision;r.setHeader('content-type','application/json');r.end(JSON.stringify({choices:[{message:{content:JSON.stringify(d)}}]}));});
 await Promise.all([new Promise(r=>site.listen(0,'127.0.0.1',r)),new Promise(r=>model.listen(0,'127.0.0.1',r))]);
 const output=await mkdtemp(join(tmpdir(),'coke-report-'));
 t.after(async()=>{site.close();model.close();await rm(output,{recursive:true,force:true});});
 return {requests,site,output,run:()=>exec(process.execPath,[resolve('bin/coke.mjs'),'task','run','Capture exact excerpts on both pages into report.txt','--runtime','local','--user','report-user','--url',`http://127.0.0.1:${site.address().port}/`,'--model','fixture-model','--output-dir',output],{timeout:30000,env:{...process.env,COKE_MODEL_API_KEY:'fixture-key',COKE_MODEL_BASE_URL:`http://127.0.0.1:${model.address().port}/v1`}})};
}
test('verified report captures actual historical page excerpts and exports real workspace file',async t=>{
 const f=await fixture(t,{action:'answer-report',path:'report.txt',excerpts:[{step:1,quote:'First task: read book'},{step:2,quote:'Second task: buy tea'}]});
 const {stdout}=await f.run();const result=JSON.parse(stdout);
 assert.equal(result.value,'First task: read book\nSecond task: buy tea');
 const artifact=result.workspaceArtifacts.find(x=>x.path==='report.txt');const report=await readFile(artifact.artifactPath,'utf8');
 assert.match(report,/Captured excerpts only/);assert.match(report,/not a complete task inventory/);assert.ok(report.includes(`http://127.0.0.1:${f.site.address().port}/next`));assert.ok(report.includes('First task: read book'));assert.ok(report.includes('Second task: buy tea'));
 assert.equal(f.requests[1].observations[0].step,1);
 const d=result.trace.find(x=>x.action==='model-decision'&&x.decision.action==='answer-report').decision;
 assert.deepEqual(d,{action:'answer-report',path:'report.txt',count:2});
});
for(const excerpt of [{step:1,quote:'invented task'},{step:99,quote:'First task: read book'}])test('unverified report refuses fabricated quote or unknown observation step',async t=>{
 const f=await fixture(t,{action:'answer-report',path:'report.txt',excerpts:[excerpt]});
 await assert.rejects(f.run(),error=>{const result=JSON.parse(error.stderr);assert.equal(result.error.code,'MODEL_UNVERIFIED_REPORT');assert.deepEqual(result.workspaceArtifacts,[]);const rejection=result.trace.find(x=>x.action==='model-rejected');assert.equal(rejection?.code,'MODEL_UNVERIFIED_REPORT');assert.equal(rejection?.reason,excerpt.step===99?'unknown-observation':'quote-mismatch');assert.equal(rejection?.excerptIndex,0);assert.equal(rejection?.observationStep,excerpt.step);assert.ok(!JSON.stringify(rejection).includes(excerpt.quote));return true;});
});
test('verified report refuses corrupt workspace readback',async t=>{
 const provider=createServer(async(q,r)=>{for await(const _ of q){}r.setHeader('content-type','application/json');r.end(JSON.stringify({choices:[{message:{content:JSON.stringify({action:'answer-report',path:'report.txt',excerpts:[{step:1,quote:'known task'}]})}}]}));});
 await new Promise(r=>provider.listen(0,'127.0.0.1',r));t.after(()=>provider.close());
 const old={key:process.env.COKE_MODEL_API_KEY,url:process.env.COKE_MODEL_BASE_URL};process.env.COKE_MODEL_API_KEY='fixture';process.env.COKE_MODEL_BASE_URL=`http://127.0.0.1:${provider.address().port}/v1`;t.after(()=>{for(const [k,v] of [['COKE_MODEL_API_KEY',old.key],['COKE_MODEL_BASE_URL',old.url]])v===undefined?delete process.env[k]:process.env[k]=v;});
 const calls=[];
 await assert.rejects(runAgentLoop({options:{model:'fixture',maxSteps:1,task:'report'},signal:new AbortController().signal,trace:[],call:async()=>({url:'https://example.test/',text:'known task',elements:[]}),workspaceCall:async d=>{calls.push(d);return d.action==='workspace-read'?{path:d.path,value:'corrupt'}:{path:d.path,bytes:1};}}),/MODEL_REPORT_READBACK_MISMATCH/);
 assert.equal(calls.length,2);assert.equal(calls[0].idempotencyKey,'verified-report');
});

test('verified report selects captured page text by step without model transcription',async t=>{
 const f=await fixture(t,{action:'answer-report',path:'report.txt',excerpts:[{step:1},{step:2}]});
 const {stdout}=await f.run();const result=JSON.parse(stdout);
 assert.equal(result.value,'First task: read book\nNext page\nSecond task: buy tea');
 const report=await readFile(result.workspaceArtifacts.find(x=>x.path==='report.txt').artifactPath,'utf8');
 assert.ok(report.includes('First task: read book\nNext page'));assert.ok(report.includes('Second task: buy tea'));
});

// Titles are document metadata, not body text or model-transcribed content.
test('verified report preserves browser titles on every captured page', async t => {
 const f=await fixture(t,{action:'answer-report',path:'report.txt',excerpts:[{step:1,title:'invented title'},{step:2}]});
 const {stdout}=await f.run();const result=JSON.parse(stdout);
 const report=await readFile(result.workspaceArtifacts.find(x=>x.path==='report.txt').artifactPath,'utf8');
 assert.ok(report.includes('Title: First page title'));
 assert.ok(report.includes('Title: Second page title'));
 assert.ok(!report.includes('invented title'));
 assert.equal(f.requests[1].title,'Second page title');
 assert.equal(f.requests[1].observations[0].title,'First page title');
});
