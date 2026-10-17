import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createTaskManager,createCapacity} from '../src/online-task-manager.mjs';
import {createOnlineServer} from '../src/online-server.mjs';

test('authenticated lifecycle is scoped, bounded, durable, and cancellable',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'coke-online-'));
 const fixture=join(dir,'worker.mjs');
 await writeFile(fixture,`if(process.argv[2]==='wait') {process.on('SIGINT',()=>{console.log(JSON.stringify({value:'cancelled'}));process.exit(1)});setInterval(()=>{},1000)}else console.log(JSON.stringify({value:'fixture result',trace:[{action:'fill-ref',result:{value:'private-secret'}}]}));`);
 const manager=await createTaskManager({dataDir:dir,capacity:createCapacity(),users:['alice','bob'],workerCommand:input=>[process.execPath,[fixture,input.task==='wait'?'wait':'done']],cleanup:async()=>{}});
 const server=createOnlineServer({manager,tokens:[{token:'alice-key',userId:'alice'},{token:'bob-key',userId:'bob'}],allowedHosts:['ticktick.com']});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(async()=>{await manager.close();await new Promise(r=>server.close(r))});
 const base=`http://127.0.0.1:${server.address().port}`;
 const req=async(path,body,token='alice-key')=>{const r=await fetch(base+path,{method:body===undefined?'GET':'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});return {status:r.status,body:await r.json()}};
 assert.equal((await req('/v1/tasks',{},'wrong')).status,401);
 assert.equal((await req('/v1/tasks',{task:'x'.repeat(40000),url:'https://ticktick.com'})).status,413);
 assert.equal((await req('/v1/session')).body.authenticated,true);
 assert.equal((await req('/v1/tasks',{task:'read',url:'https://ticktick.com',user:'bob'})).status,400);
 assert.equal((await req('/v1/tasks',{task:'read',url:'https://127.0.0.1'})).status,400);
 const submitted=await req('/v1/tasks',{task:'read',url:'https://ticktick.com'});assert.equal(submitted.status,202);
 const id=submitted.body.id;
 assert.equal((await req('/v1/tasks/'+id,undefined,'bob-key')).status,404);
 let done;for(let i=0;i<100;i++){done=await req('/v1/tasks/'+id);if(done.body.status!=='running')break;await new Promise(r=>setTimeout(r,10))}
 assert.equal(done.body.status,'succeeded');assert.equal(done.body.result.value,'fixture result');
 const trace=await req('/v1/tasks/'+id+'/trace');assert.ok(!JSON.stringify(trace).includes('private-secret'));
 assert.ok(!(await readFile(join(dir,'jobs',id+'.json'),'utf8')).includes('alice-key'));
 const active=await req('/v1/tasks',{task:'wait',url:'https://ticktick.com'});
 assert.equal((await req('/v1/tasks',{task:'read',url:'https://ticktick.com'})).status,409);
 await new Promise(r=>setTimeout(r,100));assert.equal((await req('/v1/tasks/'+active.body.id+'/cancel',{})).status,200);
 await manager.close();
 const restored=await createTaskManager({dataDir:dir,capacity:createCapacity(),users:['alice'],cleanup:async()=>{}});t.after(()=>restored.close());
 assert.equal((await restored.get('alice',id)).status,'succeeded');
});

test('restart interrupts running jobs and cleans all persisted owners before accepting work',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'coke-restart-'));
 const {mkdir}=await import('node:fs/promises');await mkdir(join(dir,'jobs'));
 const id='11111111-1111-4111-8111-111111111111';await writeFile(join(dir,'jobs',id+'.json'),JSON.stringify({id,userId:'prior-user',status:'running',createdAt:1}));
 const calls=[];const manager=await createTaskManager({dataDir:dir,users:['current-user'],cleanup:async user=>calls.push(user)});
 assert.deepEqual(calls,['current-user','prior-user']);assert.equal((await manager.get('prior-user',id)).status,'interrupted');await manager.close();
});

test('cancel escalates unresponsive child and releases capacity',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'coke-stuck-')),fixture=join(dir,'stuck.mjs');await writeFile(fixture,`import {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(join(dir,'pid'))},String(process.pid));process.on('SIGINT',()=>{});setInterval(()=>{},1000)`);
 const manager=await createTaskManager({dataDir:dir,capacity:createCapacity(),cleanup:async()=>{},cancelGraceMs:40,workerCommand:()=>[process.execPath,[fixture]]});
 const job=await manager.submit('alice',{task:'read',url:'https://ticktick.com'});await new Promise(r=>setTimeout(r,150));
 const result=await Promise.race([manager.cancel('alice',job.id),new Promise((_,reject)=>setTimeout(()=>reject(Error('cancel hung')),500))]).catch(async error=>{process.kill(Number(await readFile(join(dir,'pid'),'utf8')),'SIGKILL');throw error});
 assert.equal(result.status,'cancelled');assert.equal(manager.capacity.active,undefined);await manager.close();
});

test('POST preserves Chinese UTF8 split across socket chunks',async t=>{
 const {request}=await import('node:http');let received;
 const server=createOnlineServer({manager:{async submit(user,input){received=input;return {id:'example'}}},tokens:[{token:'test-key',userId:'alice'}]});await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));
 const bytes=Buffer.from(JSON.stringify({task:'读取今天任务',url:'https://ticktick.com'}));const split=bytes.indexOf(Buffer.from('读'))+1;
 const response=await new Promise((resolve,reject)=>{const req=request({host:'127.0.0.1',port:server.address().port,path:'/v1/tasks',method:'POST',headers:{authorization:'Bearer test-key','content-type':'application/json'}},res=>{res.resume();res.on('end',()=>resolve(res.statusCode))});req.on('error',reject);req.write(bytes.subarray(0,split));setTimeout(()=>req.end(bytes.subarray(split)),30)});
 assert.equal(response,202);assert.equal(received.task,'读取今天任务');
});

test('worker output preserves Chinese UTF8 split across pipe chunks',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'coke-unicode-')),fixture=join(dir,'worker.mjs');
 await writeFile(fixture,`const bytes=Buffer.from(JSON.stringify({value:'中文结果'}));const split=bytes.indexOf(Buffer.from('中'))+1;process.stdout.write(bytes.subarray(0,split));setTimeout(()=>process.stdout.write(bytes.subarray(split)),30);`);
 const manager=await createTaskManager({dataDir:dir,cleanup:async()=>{},workerCommand:()=>[process.execPath,[fixture]]});const job=await manager.submit('alice',{task:'read',url:'https://ticktick.com'});
 let done;for(let i=0;i<100;i++){done=await manager.get('alice',job.id);if(done.status!=='running')break;await new Promise(r=>setTimeout(r,10))}
 assert.equal(done.result.value,'中文结果');await manager.close();
});

test('failed worker exposes stable recovery error code and redacted wait/recovery trace',async t=>{
 const {rm}=await import('node:fs/promises');const dir=await mkdtemp(join(tmpdir(),'coke-recovery-api-'));const fixture=join(dir,'worker.mjs');await writeFile(fixture,`console.error(JSON.stringify({error:{code:'PAGE_NOT_READY',message:'private provider detail'},trace:[{action:'agent-wait',step:1,milliseconds:2000,reason:'page-loading'},{action:'model-recovery',step:2,code:'MODEL_UNVERIFIED_REPORT',attempt:1,raw:'private model text'}]}));process.exitCode=1;`);const m=await createTaskManager({dataDir:dir,cleanup:async()=>{},workerCommand:()=>[process.execPath,[fixture]]});t.after(async()=>{await m.close();await rm(dir,{recursive:true,force:true})});const job=await m.submit('alice',{task:'read',url:'https://ticktick.com'});let done;for(let i=0;i<100;i++){done=await m.get('alice',job.id);if(done.status!=='running')break;await new Promise(r=>setTimeout(r,10))}assert.equal(done.errorCode,'PAGE_NOT_READY');const{trace}=await m.trace('alice',job.id);assert.equal(trace[0].milliseconds,2000);assert.equal(trace[1].code,'MODEL_UNVERIFIED_REPORT');assert.equal(trace[1].attempt,1);assert.ok(!JSON.stringify({done,trace}).includes('private'));});

test('browser failure survives worker boundary without private detail',async t=>{
 const {rm}=await import('node:fs/promises');const dir=await mkdtemp(join(tmpdir(),'coke-browser-error-')),fixture=join(dir,'worker.mjs');
 await writeFile(fixture,`console.error(JSON.stringify({error:{code:'BROWSER_GATEWAY_TIMEOUT',message:'private-secret'},trace:[{action:'navigate',ok:false,error:'BROWSER_GATEWAY_TIMEOUT',raw:'private-secret'}]}));process.exitCode=1;`);
 const manager=await createTaskManager({dataDir:dir,cleanup:async()=>{},workerCommand:()=>[process.execPath,[fixture]]});t.after(async()=>{await manager.close();await rm(dir,{recursive:true,force:true})});
 const job=await manager.submit('alice',{task:'read',url:'https://ticktick.com'});let done;for(let i=0;i<100;i++){done=await manager.get('alice',job.id);if(done.status!=='running')break;await new Promise(r=>setTimeout(r,10))}
 assert.equal(done.errorCode,'BROWSER_GATEWAY_TIMEOUT');const {trace}=await manager.trace('alice',job.id);assert.equal(trace[0].error,'BROWSER_GATEWAY_TIMEOUT');assert.ok(!JSON.stringify({done,trace}).includes('private-secret'));
});


test('report rejection diagnostics expose enums and integers only',async()=>{
 const {redactTrace}=await import('../src/online-task-manager.mjs');
 const trace=redactTrace([{action:'model-rejected',code:'MODEL_UNVERIFIED_REPORT',reason:'quote-mismatch',excerptIndex:0,observationStep:3,step:4,quote:'private-secret'}, {action:'model-rejected',code:'MODEL_UNVERIFIED_REPORT',reason:'private-secret',excerptIndex:'private-secret',observationStep:'private-secret'}]);
 assert.equal(redactTrace([{action:'model-rejected',code:'MODEL_INVALID_RESPONSE',step:2}])[0].code,'MODEL_INVALID_RESPONSE');assert.equal(trace[0].reason,'quote-mismatch');assert.equal(trace[0].excerptIndex,0);assert.equal(trace[0].observationStep,3);assert.equal(trace[0].step,4);assert.ok(!JSON.stringify(trace).includes('private-secret'));
});

test('terminal status is published only after capacity is available for the next task',async t=>{
 const {rm}=await import('node:fs/promises');const dir=await mkdtemp(join(tmpdir(),'coke-terminal-capacity-')),fixture=join(dir,'worker.mjs');await writeFile(fixture,"console.log(JSON.stringify({value:'done'}))");const manager=await createTaskManager({dataDir:dir,cleanup:async()=>{},workerCommand:()=>[process.execPath,[fixture]]});t.after(async()=>{await manager.close();await rm(dir,{recursive:true,force:true})});
 const job=await manager.submit('alice',{task:'read'});let done;
 for(let i=0;i<10000;i++){done=await manager.get('alice',job.id);if(done.status!=='running'){assert.equal(manager.capacity.active,undefined);break}await new Promise(setImmediate)}
 assert.equal(done.status,'succeeded');const next=await manager.submit('alice',{task:'read'});await manager.cancel('alice',next.id);
});

test('terminal GET waits for storage failure classification before releasing capacity',async t=>{
 const {mkdir,rm}=await import('node:fs/promises');const {TaskStore}=await import('../src/task-store.mjs');
 const dir=await mkdtemp(join(tmpdir(),'coke-terminal-store-failure-')),fixture=join(dir,'worker.mjs');
 const workerTaskId='11111111-1111-4111-8111-111111111111';
 await writeFile(fixture,`setTimeout(()=>console.log(JSON.stringify({value:'done',taskId:'${workerTaskId}'})),100)`);
 let reached,unblock;const entered=new Promise(r=>reached=r),gate=new Promise(r=>unblock=r),original=TaskStore.prototype.get;
 TaskStore.prototype.get=async function(user,id){if(id===workerTaskId){reached();await gate;throw Error('fixture missing task record')}return original.call(this,user,id)};
 const manager=await createTaskManager({dataDir:dir,cleanup:async()=>{},workerCommand:()=>[process.execPath,[fixture]]});
 t.after(async()=>{unblock();TaskStore.prototype.get=original;await manager.close();await rm(dir,{recursive:true,force:true})});
 const job=await manager.submit('alice',{task:'read'});
 await mkdir(join(dir,'jobs',job.id+'.json.tmp'));
 await entered;const terminal=manager.get('alice',job.id);unblock();
 const result=await terminal;
 assert.equal(result.status,'failed');assert.equal(result.errorCode,'STORE_FAILED');assert.equal(manager.capacity.active,undefined);
});
test('public network restriction reaches the spawned integration worker only',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'coke-public-worker-')),fixture=join(dir,'worker.mjs');
 await writeFile(fixture,`console.log(JSON.stringify({value:process.env.COKE_BROWSER_PUBLIC_ONLY||'off'}));`);
 const manager=await createTaskManager({dataDir:dir,cleanup:async()=>{},workerCommand:()=>[process.execPath,[fixture]]});t.after(()=>manager.close());
 for(const [publicOnly,expected] of [[true,'1'],[false,'0']]){
  const job=await manager.submit('alice',{task:'read',url:'https://example.com',publicOnly});let done;
  for(let i=0;i<100;i++){done=await manager.get('alice',job.id);if(done.status!=='running')break;await new Promise(r=>setTimeout(r,10))}
  assert.equal(done.result.value,expected);
 }
});
test('online entry delegates restricted integration before operator body and authentication',async t=>{
 const server=createOnlineServer({manager:{},tokens:[],integrationService:{async handle(req,res){if(req.url!=='/v1/integration/tasks')return false;res.writeHead(202,{'content-type':'application/json'});res.end(JSON.stringify({status:'queued'}));return true}}});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));
 const response=await fetch(`http://127.0.0.1:${server.address().port}/v1/integration/tasks`,{method:'POST'});assert.equal(response.status,202);assert.equal((await response.json()).status,'queued');
});
