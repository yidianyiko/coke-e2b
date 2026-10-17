import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:http';
import {createIntegrationService} from '../src/integration-service.mjs';

test('restricted integration owns durable idempotency and result capabilities',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'integration-'));let calls=0;const jobs=new Map();
 const manager={async submit(owner,input){calls++;jobs.set('job',{owner,id:'job',status:'succeeded',result:{value:'observed result'},artifacts:[{id:'0',name:'report.txt',type:'text/plain'}]});return jobs.get('job')},async get(owner,id){const j=jobs.get(id);if(j?.owner!==owner)throw Error('TASK_NOT_FOUND');return j},async artifact(owner,id,index){await this.get(owner,id);assert.equal(index,'0');return {bytes:Buffer.from('verified report'),type:'text/plain'}},async cancel(owner,id){return {...await this.get(owner,id),status:'cancelled'}}};
 const options={manager,dataDir:dir,serviceToken:'s'.repeat(32),publicBaseUrl:'https://coke.example'};
 let service=await createIntegrationService(options);const server=createServer(async(req,res)=>{if(!await service.handle(req,res)){res.writeHead(404);res.end()}});await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const base=`http://127.0.0.1:${server.address().port}`;
 const call=async(path,body,token='s'.repeat(32))=>fetch(base+path,{method:body?'POST':'GET',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:body?JSON.stringify(body):undefined});
 try{
 const input={ownerId:'alice',requestId:'turn1',task:'read title',url:'https://example.com/'};
 assert.equal((await call('/v1/integration/tasks',input,'operator')).status,401);
 let r=await call('/v1/integration/tasks',input);assert.equal(r.status,202);let j=await r.json();assert.equal(j.status,'succeeded');assert.equal(j.id,'turn1');assert.match(j.resultUrl,/\/result#/);
 await call('/v1/integration/tasks',input);assert.equal(calls,1);
 assert.equal((await call('/v1/integration/tasks',{...input,task:'other'})).status,409);
 assert.equal((await call('/v1/integration/tasks/turn1?ownerId=bob')).status,404);
 service=await createIntegrationService(options);await call('/v1/integration/tasks',input);assert.equal(calls,1);
 const secret=new URL(j.resultUrl).hash.slice(1);r=await call('/v1/result/exchange',{secret},'');assert.equal(r.status,200);const session=await r.json();
 r=await call('/v1/result',undefined,session.token);assert.equal(r.status,200);assert.equal((await r.json()).result.value,'observed result');
 r=await call('/v1/result/artifacts/0',undefined,session.token);assert.equal(await r.text(),'verified report');
 assert.equal((await call('/v1/result/exchange',{secret},'')).status,404);
 assert.equal((await call('/v1/integration/tasks/turn1?ownerId=alice',undefined,session.token)).status,401);
 }finally{await new Promise(r=>server.close(r));await rm(dir,{recursive:true,force:true})}
});

test('uncertain dispatch is not replayed after restart; queued capacity can retry',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'integration-recovery-'));let calls=0,busy=true;
 const manager={async submit(){calls++;throw Object.assign(Error(),{code:busy?'CAPACITY_BUSY':'NETWORK_LOST'})}};
 const options={manager,dataDir:dir,serviceToken:'s'.repeat(32),publicBaseUrl:'https://coke.example'};
 let service=await createIntegrationService(options);const server=createServer((req,res)=>service.handle(req,res));await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}`;
 const submit=()=>fetch(base+'/v1/integration/tasks',{method:'POST',headers:{authorization:'Bearer '+'s'.repeat(32),'content-type':'application/json'},body:JSON.stringify({ownerId:'alice',requestId:'turn2',task:'read',url:'https://example.com'})}).then(r=>r.json());
 try{assert.equal((await submit()).status,'queued');busy=false;assert.equal((await submit()).status,'interrupted');service=await createIntegrationService(options);assert.equal((await submit()).status,'interrupted');assert.equal(calls,2)}finally{await new Promise(r=>server.close(r));await rm(dir,{recursive:true,force:true})}
});

test('authentication resumes only the durable owning request and uses its profile',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'integration-auth-'));let continuation,submitted=0,received;
 const manager={async submit(owner,input){received=input;return {id:String(++submitted),status:'running'}},async get(owner,id){return id==='1'?{id,status:'failed',errorCode:'SITE_AUTHENTICATION_REQUIRED'}:{id,status:'succeeded',result:{value:'account result'}}}};
 const loginLinks={create(owner,input,options){assert.match(owner,/^legacy:/);assert.equal(new URL(input.url).pathname,'/signin');continuation=()=>options.submit(owner,input);return {secret:'auth-secret',expiresAt:Date.now()+60000}}};
 const service=await createIntegrationService({manager,loginLinks,dataDir:dir,serviceToken:'s'.repeat(32),publicBaseUrl:'https://coke.example'});const server=createServer((req,res)=>service.handle(req,res));await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}`;
 const request=(path,body)=>fetch(base+path,{method:body?'POST':'GET',headers:{authorization:'Bearer '+'s'.repeat(32),'content-type':'application/json'},body:body?JSON.stringify(body):undefined}).then(r=>r.json());
 try{let r=await request('/v1/integration/tasks',{ownerId:'alice',requestId:'auth1',task:'read tasks',url:'https://ticktick.com/webapp/'});assert.equal(r.status,'needs_authorization');assert.equal(r.authorizationUrl,'https://coke.example/login#auth-secret');await continuation();r=await request('/v1/integration/tasks/auth1?ownerId=alice');assert.equal(r.status,'succeeded');assert.equal(received.url,'https://ticktick.com/webapp/');assert.ok(received.profile);assert.equal(received.publicOnly,true)}finally{await new Promise(r=>server.close(r));await rm(dir,{recursive:true,force:true})}
});

test('result capabilities expire and cancellation revokes exchanged sessions',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'integration-cap-'));let clock=1000;
 const manager={async submit(){return {id:'job',status:'succeeded'}},async get(){return {id:'job',status:'succeeded',result:{value:'safe'}}},async cancel(){return {id:'job',status:'succeeded'}}};
 const service=await createIntegrationService({manager,dataDir:dir,serviceToken:'s'.repeat(32),publicBaseUrl:'https://coke.example',now:()=>clock,capabilityTtlMs:100});const server=createServer((req,res)=>service.handle(req,res));await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}`;
 const call=(path,body,token='s'.repeat(32))=>fetch(base+path,{method:body?'POST':'GET',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:body?JSON.stringify(body):undefined});
 try{let r=await call('/v1/integration/tasks',{ownerId:'alice',requestId:'cap',task:'read',url:'https://example.com'});let j=await r.json();clock=1101;assert.equal((await call('/v1/result/exchange',{secret:new URL(j.resultUrl).hash.slice(1)},'')).status,404);j=await(await call('/v1/integration/tasks/cap?ownerId=alice')).json();const session=await(await call('/v1/result/exchange',{secret:new URL(j.resultUrl).hash.slice(1)},'')).json();assert.equal((await call('/v1/result',undefined,session.token)).status,200);await call('/v1/integration/tasks/cap/cancel',{ownerId:'alice'});assert.equal((await call('/v1/result',undefined,session.token)).status,401)}finally{await new Promise(r=>server.close(r));await rm(dir,{recursive:true,force:true})}
});

test('cancelled authorization remains terminal on polling and replay',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'integration-cancel-auth-'));let links=0;
 const options={dataDir:dir,serviceToken:'s'.repeat(32),publicBaseUrl:'https://coke.example',manager:{async submit(){return {id:'job',status:'running'}},async get(){return {id:'job',status:'failed',errorCode:'SITE_AUTHENTICATION_REQUIRED'}}},loginLinks:{create(){return {secret:'auth-'+(++links),expiresAt:Date.now()+60000}}}};
 let service=await createIntegrationService(options);const server=createServer((req,res)=>service.handle(req,res));await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}`;
 const call=(path,body)=>fetch(base+path,{method:body?'POST':'GET',headers:{authorization:'Bearer '+'s'.repeat(32),'content-type':'application/json'},body:body?JSON.stringify(body):undefined}).then(r=>r.json());
 const input={ownerId:'alice',requestId:'cancel-auth',task:'read tasks',url:'https://ticktick.com/webapp/'};
 try{assert.equal((await call('/v1/integration/tasks',input)).status,'needs_authorization');assert.equal((await call('/v1/integration/tasks/cancel-auth/cancel',{ownerId:'alice'})).status,'cancelled');assert.equal((await call('/v1/integration/tasks/cancel-auth?ownerId=alice')).status,'cancelled');service=await createIntegrationService(options);assert.equal((await call('/v1/integration/tasks',input)).status,'cancelled');assert.equal(links,1)}finally{await new Promise(r=>server.close(r));await rm(dir,{recursive:true,force:true})}
});
