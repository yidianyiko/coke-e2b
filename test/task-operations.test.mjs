import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:http';
import { TaskStore } from '../src/task-store.mjs';
const exec=promisify(execFile);
const cli=resolve('bin/coke.mjs');

test('trace and usage CLI inspect only the selected user task', async () => {
 const root=await mkdtemp(join(tmpdir(),'coke-operations-'));
 try {
  const store=new TaskStore(root);const record=await store.create('alice','local');
  await store.update('alice',record.taskId,{finishedAt:record.createdAt+100,trace:[{action:'release',timestamp:123,ok:true}],limits:{timeoutMs:90000,maxSteps:3,maxBrowserContexts:1},resourcesReleased:true});
  const invoke=(view,user)=>exec(process.execPath,[cli,'task',view,record.taskId,'--user',user,'--output-dir',root]);
  assert.equal(JSON.parse((await invoke('trace','alice')).stdout).trace[0].timestamp,123);
  const usage=JSON.parse((await invoke('usage','alice')).stdout);
  assert.equal(usage.taskDurationMs,100);assert.equal(usage.limits.maxSteps,3);
  await assert.rejects(invoke('trace','bob'),error=>{assert.equal(JSON.parse(error.stderr).error.code,'TASK_NOT_FOUND');assert.equal(error.stderr.includes('123'),false);return true;});
 } finally {await rm(root,{recursive:true,force:true});}
});

test('deadline aborts slow navigation and records released resources', async () => {
 const server=createServer(()=>{});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const root=await mkdtemp(join(tmpdir(),'coke-deadline-'));
 try {
  let result;
  await assert.rejects(exec(process.execPath,[cli,'task','run','Read a slow page','--runtime','local','--user','alice','--url',`http://127.0.0.1:${server.address().port}/`,'--link-text','Next','--value-selector','h1','--timeout-ms','1000','--output-dir',root],{timeout:15000}),error=>{result=JSON.parse(error.stderr);assert.equal(result.error.code,'TASK_TIMEOUT');return true;});
   const record=await new TaskStore(root).get('alice',result.taskId);
   assert.equal(record.resourcesReleased,true);assert.equal(record.errorCode,'TASK_TIMEOUT');
   assert.equal(record.limits.timeoutMs,1000);assert.ok(record.finishedAt>=record.createdAt);
 } finally {server.closeAllConnections();server.close();await rm(root,{recursive:true,force:true});}
});

test('browser service death invalidates the lease with a bounded error and cleanup', async () => {
 let requested; const pageRequested=new Promise(resolve=>{requested=resolve;});
 const server=createServer(()=>requested());await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const root=await mkdtemp(join(tmpdir(),'coke-browser-death-'));
 try {
  // Attach a rejection handler immediately while waiting for the page request.
  const execution=exec(process.execPath,[cli,'task','run','Read slow page','--runtime','local','--user','alice','--url',`http://127.0.0.1:${server.address().port}/`,'--link-text','Next','--value-selector','h1','--output-dir',root],{timeout:15000}).then(value=>({value}),error=>({error}));
  const wait=setTimeout(()=>requested(),10000); await pageRequested;clearTimeout(wait);
  const store=new TaskStore(root);const [active]=await store.list('alice');assert.ok(active?.browserPid);
  process.kill(active.browserPid,'SIGKILL');
  const {error}=await execution;assert.ok(error,'browser failure must not succeed');
  const result=JSON.parse(error.stderr);assert.equal(result.error.code,'BROWSER_SERVICE_EXITED');
  const record=await store.get('alice',active.taskId);assert.equal(record.resourcesReleased,true);
  assert.equal(record.errorCode,'BROWSER_SERVICE_EXITED');
 } finally {server.closeAllConnections();server.close();await rm(root,{recursive:true,force:true});}
});
test('transport failure preceding browser exit notification preserves service-death classification',async()=>{
 const root=await mkdtemp(join(tmpdir(),'coke-exit-race-'));
 try {
  const {writeFile}=await import('node:fs/promises');
  const hook=join(root,'exit-race.mjs');
  await writeFile(hook,`import cp from 'node:child_process';import{syncBuiltinESMExports}from'node:module';\nconst originalFork=cp.fork;let browser;cp.fork=(...args)=>{browser=originalFork(...args);return browser;};syncBuiltinESMExports();\nconst originalFetch=globalThis.fetch;globalThis.fetch=async(url,options)=>{if(browser && JSON.parse(options?.body||'{}').action==='navigate'){process.kill(browser.pid,'SIGKILL');throw new TypeError('Fixture transport closes before child exit notification');}return originalFetch(url,options);};`);
  let result;
  await assert.rejects(exec(process.execPath,['--import',hook,cli,'task','run','Read page','--runtime','local','--user','alice','--url','https://example.test/','--link-text','Next','--value-selector','h1','--output-dir',root],{timeout:15000}),error=>{result=JSON.parse(error.stderr);assert.equal(result.error.code,'BROWSER_SERVICE_EXITED');return true;});
  const record=await new TaskStore(root).get('alice',result.taskId);assert.equal(record.errorCode,'BROWSER_SERVICE_EXITED');assert.equal(record.resourcesReleased,true);
 } finally {await rm(root,{recursive:true,force:true});}
});
