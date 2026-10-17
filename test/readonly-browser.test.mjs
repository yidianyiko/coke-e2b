import test from 'node:test';
import assert from 'node:assert/strict';
import {fork} from 'node:child_process';
import {once} from 'node:events';
import {createServer} from 'node:http';
import {stopService} from '../src/service-process.mjs';

for(const readOnly of [true,false]) test(`browser mutation guard ${readOnly?'blocks':'allows'} POST and exposes semantic refs`,async()=>{
 let posts=0;
 const server=createServer((req,res)=>{res.setHeader('content-type','text/html; charset=utf-8');if(req.method==='POST'){posts++;res.end('saved');return}res.end(`<main id="value">今日任务</main><div role="tab" onclick="document.querySelector('#value').textContent='已选择今日'">未完成</div><div role="button" onclick="fetch('/save',{method:'POST'}).then(()=>document.querySelector('#value').textContent='saved').catch(()=>document.querySelector('#value').textContent='blocked')">提交</div><input type="checkbox" aria-label="完成任务"><input aria-label="搜索"><a href="/next">Add/Remove Elements</a><button aria-label="删除任务" onclick="fetch('/save',{method:'POST'})">删除任务</button>`)});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin=`http://127.0.0.1:${server.address().port}`;
 const child=fork(new URL('../src/browser-server.mjs',import.meta.url),[],{stdio:['ignore','ignore','ignore','ipc'],env:{...process.env,COKE_BROWSER_TOKEN:'readonly-test',COKE_BROWSER_READ_ONLY:readOnly?'1':'0'}});
 try{
 const [ready]=await once(child,'message');const call=async(route,args)=>{const r=await fetch(`http://127.0.0.1:${ready.port}${route}`,{method:'POST',headers:{authorization:'Bearer readonly-test','content-type':'application/json'},body:JSON.stringify(args)});return {status:r.status,...await r.json()}};
 const lease={...await call('/acquire',{userId:'u',taskId:'t'}),userId:'u',taskId:'t'};delete lease.status;
 const action=args=>call('/action',{...lease,...args});await action({action:'navigate',url:origin});
 let snapshot=await action({action:'read'});const tab=snapshot.elements.find(e=>e.name==='未完成');assert.equal(tab?.role,'tab');assert.equal(snapshot.elements.find(e=>e.name==='完成任务')?.role,'checkbox');
 await action({action:'click-ref',ref:tab.ref});assert.match((await action({action:'read'})).text,/已选择今日/);
 snapshot=await action({action:'read'});const fill=await action({action:'fill-ref',ref:snapshot.elements.find(e=>e.name==='搜索').ref,value:'hello'});assert.equal(fill.status,readOnly?403:200);
 if(readOnly){const destructive=await action({action:'click-ref',ref:snapshot.elements.find(e=>e.name==='删除任务').ref});assert.equal(destructive.error.code,'READ_ONLY_VIOLATION');const check=await action({action:'click-ref',ref:snapshot.elements.find(e=>e.name==='完成任务').ref});assert.equal(check.error.code,'READ_ONLY_VIOLATION');const handoff=await call('/handoff',{...lease,action:'type',text:'bad'});assert.equal(handoff.status,403)}
 snapshot=await action({action:'read'});await action({action:'click-ref',ref:snapshot.elements.find(e=>e.name==='提交').ref});
 for(let i=0;i<50;i++){if((await action({action:'read'})).text.includes(readOnly?'blocked':'saved'))break;await new Promise(r=>setTimeout(r,20))}
 assert.equal(posts,readOnly?0:1);assert.match((await action({action:'read'})).text,readOnly?/blocked/:/saved/);
 snapshot=await action({action:'read'});await action({action:'click-ref',ref:snapshot.elements.find(e=>e.name==='Add/Remove Elements').ref});assert.equal((await action({action:'current-url'})).url,origin+'/next');await call('/release',lease);
 }finally{await stopService(child);await new Promise(r=>server.close(r))}
});

test('online worker read-only environment cannot inherit a writable host setting',async()=>{
 const {mkdtemp,writeFile,rm}=await import('node:fs/promises');const {join}=await import('node:path');const {tmpdir}=await import('node:os');const {createTaskManager}=await import('../src/online-task-manager.mjs');
 const dir=await mkdtemp(join(tmpdir(),'coke-readonly-worker-'));const fixture=join(dir,'worker.mjs');await writeFile(fixture,`console.log(JSON.stringify({value:process.env.COKE_BROWSER_READ_ONLY}))`);
 const prior=process.env.COKE_BROWSER_READ_ONLY;process.env.COKE_BROWSER_READ_ONLY='0';let manager;
 try{manager=await createTaskManager({dataDir:dir,cleanup:async()=>{},workerCommand:()=>[process.execPath,[fixture]]});const job=await manager.submit('alice',{task:'read',url:'https://ticktick.com'});let result;for(let i=0;i<100;i++){result=await manager.get('alice',job.id);if(result.status!=='running')break;await new Promise(r=>setTimeout(r,10))}assert.equal(result.result.value,'1')}
 finally{if(prior===undefined)delete process.env.COKE_BROWSER_READ_ONLY;else process.env.COKE_BROWSER_READ_ONLY=prior;await manager?.close();await rm(dir,{recursive:true,force:true})}
});
