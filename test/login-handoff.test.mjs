import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { createLoginManager } from '../src/login-manager.mjs';
import { ProfileStore } from '../src/profile-store.mjs';
test('login ownership, confirmation, revoke and discarded cancellation use real browser',async()=>{
 const dataDir=await mkdtemp(join(tmpdir(),'login-handoff-'));
 const fixture=createServer((q,s)=>{s.setHeader('content-type','text/html');s.end('<input aria-label="password" type="password" style="position:absolute;left:10px;top:10px;width:200px;height:30px"><button style="position:absolute;left:10px;top:70px" onclick="localStorage.setItem(\'session\',document.querySelector(\'input\').value)">Login</button>');});
 await new Promise(r=>fixture.listen(0,'127.0.0.1',r)); const url=`http://127.0.0.1:${fixture.address().port}`;
 let busy=false;const manager=createLoginManager({dataDir,allowedOrigins:[url],capacity:{claimSlot(){if(busy)throw Error('CAPACITY_BUSY');busy=true;return()=>{busy=false;};}}});
 const call=(method,path,body,userId='alice')=>manager.handle({method,path,body,userId});
 try {
  assert.equal((await call('POST','/v1/logins',{url:'http://evil.test',profile:'main'})).status,400);
  const created=await call('POST','/v1/logins',{url,profile:'main'}); assert.equal(created.status,201); const id=created.body.id; const path=`/v1/logins/${id}`;
  assert.equal((await call('GET',path,{},'bob')).status,404);
  assert.equal((await call('POST','/v1/logins',{url,profile:'other'})).status,409);
  assert.equal((await call('POST',path+'/input',{action:'click',x:-1,y:10})).status,400);
  await call('POST',path+'/input',{action:'click',x:30,y:25});await call('POST',path+'/input',{action:'type',text:'fixture-secret'});await call('POST',path+'/input',{action:'click',x:30,y:80});
  const shot=await call('GET',path);assert.ok(shot.body.pngBase64);assert.ok(!JSON.stringify(shot).includes('fixture-secret'));
  assert.equal((await call('POST',path+'/confirm')).status,200);
  const store=new ProfileStore(join(dataDir,'profiles'));assert.equal((await store.load('alice',{name:'main',origin:url})).state.origins[0].localStorage[0].value,'fixture-secret');
  const second=await call('POST','/v1/logins',{url,profile:'main'});
  assert.equal((await call('POST','/v1/profiles/revoke',{url,profile:'main'})).status,200);
  assert.equal((await call('POST',`/v1/logins/${second.body.id}/confirm`)).status,409);
  assert.deepEqual((await store.load('alice',{name:'main',origin:url})).state,{cookies:[],origins:[]});
  const third=await call('POST','/v1/logins',{url,profile:'main'});assert.equal((await call('POST',`/v1/logins/${third.body.id}/cancel`)).status,200);assert.equal(busy,false);
 }finally{await manager.close();await new Promise(r=>fixture.close(r));await rm(dataDir,{recursive:true,force:true});}
});
test('failed browser startup releases shared slot and discards session',async()=>{
 const dataDir=await mkdtemp(join(tmpdir(),'login-timeout-'));let released=false;
 const manager=createLoginManager({dataDir,allowedOrigins:['http://127.0.0.1:1'],ttlMs:50,capacity:{claimSlot(){return()=>{released=true;};}}});
 // Navigation failure must also clean up browser and slot without saving.
 try{const result=await manager.handle({method:'POST',path:'/v1/logins',userId:'alice',body:{url:'http://127.0.0.1:1',profile:'main'}});assert.equal(result.status,503);assert.equal(released,true);assert.deepEqual((await new ProfileStore(join(dataDir,'profiles')).load('alice',{name:'main',origin:'http://127.0.0.1:1'})).state,{cookies:[],origins:[]});}
 finally{await manager.close();await rm(dataDir,{recursive:true,force:true});}
});

test('login TTL discards unconfirmed browser state',async()=>{
 const dataDir=await mkdtemp(join(tmpdir(),'login-ttl-'));const fixture=createServer((q,s)=>{s.setHeader('content-type','text/html');s.end('<script>localStorage.setItem("unsaved","private")</script>Login');});await new Promise(r=>fixture.listen(0,'127.0.0.1',r));const url=`http://127.0.0.1:${fixture.address().port}`;let released=false;
 const manager=createLoginManager({dataDir,allowedOrigins:[url],ttlMs:300,capacity:{claimSlot(){return()=>{released=true;};}}});
 try{const result=await manager.handle({method:'POST',path:'/v1/logins',userId:'alice',body:{url,profile:'main'}});assert.equal(result.status,201);await new Promise(r=>setTimeout(r,650));assert.equal(released,true);assert.equal((await manager.handle({method:'GET',path:`/v1/logins/${result.body.id}`,userId:'alice'})).status,404);assert.deepEqual((await new ProfileStore(join(dataDir,'profiles')).load('alice',{name:'main',origin:url})).state,{cookies:[],origins:[]});}
 finally{await manager.close();await new Promise(r=>fixture.close(r));await rm(dataDir,{recursive:true,force:true});}
});
test('unexpected browser child exit immediately discards session and frees capacity',async()=>{
 const {readFile}=await import('node:fs/promises');const children=async()=>(await readFile(`/proc/${process.pid}/task/${process.pid}/children`,'utf8')).trim().split(/\s+/).filter(Boolean).map(Number);
 const before=await children();const dataDir=await mkdtemp(join(tmpdir(),'login-death-'));const fixture=createServer((q,s)=>{s.setHeader('content-type','text/html');s.end('<script>localStorage.setItem("unsaved","private")</script>Login');});await new Promise(r=>fixture.listen(0,'127.0.0.1',r));const url=`http://127.0.0.1:${fixture.address().port}`;let busy=false,releases=0;
 const manager=createLoginManager({dataDir,allowedOrigins:[url],capacity:{claimSlot(){if(busy)throw Error('CAPACITY_BUSY');busy=true;return()=>{busy=false;releases++;};}}});
 try{const created=await manager.handle({method:'POST',path:'/v1/logins',userId:'alice',body:{url,profile:'main'}});assert.equal(created.status,201);const child=(await children()).find(pid=>!before.includes(pid));assert.ok(child);process.kill(child,'SIGKILL');for(let i=0;i<50&&busy;i++)await new Promise(r=>setTimeout(r,20));assert.equal(busy,false);assert.equal(releases,1);assert.equal((await manager.handle({method:'GET',path:`/v1/logins/${created.body.id}`,userId:'alice'})).status,404);assert.deepEqual((await new ProfileStore(join(dataDir,'profiles')).load('alice',{name:'main',origin:url})).state,{cookies:[],origins:[]});const next=await manager.handle({method:'POST',path:'/v1/logins',userId:'alice',body:{url,profile:'main'}});assert.equal(next.status,201);await manager.close();assert.equal(releases,2);}
 finally{await manager.close();await new Promise(r=>fixture.close(r));await rm(dataDir,{recursive:true,force:true});}
});
