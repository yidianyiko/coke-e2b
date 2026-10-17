import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProfileStore } from '../src/profile-store.mjs';
import { stopService } from '../src/service-process.mjs';
test('browser profile retains only its users session and revoke prevents active lease resurrection', async () => {
 const root = await mkdtemp(join(tmpdir(), 'coke-profile-browser-'));
 const fixture = createServer((request,response) => {
  response.setHeader('content-type','text/html');
  if(request.url === '/login') response.setHeader('set-cookie','session=private-session; HttpOnly; SameSite=Lax; Path=/');
  response.end(`<main>${request.headers.cookie?.includes('private-session') ? 'logged-in' : 'anonymous'}</main>`);
 });
 await new Promise(r=>fixture.listen(0,'127.0.0.1',r));
 const origin = `http://127.0.0.1:${fixture.address().port}`;
 const child = fork(new URL('../src/browser-server.mjs',import.meta.url),[],{stdio:['ignore','ignore','pipe','ipc'],env:{...process.env,COKE_BROWSER_TOKEN:'test-profile',COKE_PROFILE_ROOT:root}});
 let stderr = ''; child.stderr.on('data', c=>{stderr+=c;});
 try {
  const [ready] = await once(child,'message');
  const call = async(route,args)=> {const r=await fetch(`http://127.0.0.1:${ready.port}${route}`,{method:'POST',headers:{authorization:'Bearer test-profile','content-type':'application/json'},body:JSON.stringify(args)});const data=await r.json();assert.equal(r.status,200,JSON.stringify(data));return data;};
  const acquire=async userId=>({...await call('/acquire',{userId,taskId:userId,profile:{name:'primary',origin}}),userId,taskId:userId});
  const a=await acquire('alice');
  await call('/action',{...a,action:'navigate',url:origin+'/login'});
  await call('/release',a);
  const a2=await acquire('alice');
  await call('/action',{...a2,action:'navigate',url:origin+'/'});
  assert.equal((await call('/action',{...a2,action:'read'})).text,'logged-in');
  const b=await acquire('bob');
  await call('/action',{...b,action:'navigate',url:origin+'/'});
  assert.equal((await call('/action',{...b,action:'read'})).text,'anonymous');
  await call('/release',b);
  await new ProfileStore(root).revoke('alice',{name:'primary',origin});
  await call('/release',a2);
  const a3=await acquire('alice');
  await call('/action',{...a3,action:'navigate',url:origin+'/'});
  assert.equal((await call('/action',{...a3,action:'read'})).text,'anonymous');
  await call('/release',a3);
  assert.equal(stderr.includes('private-session'),false);
 } finally {await stopService(child);fixture.close();await rm(root,{recursive:true,force:true});}
});

test('CLI human handoff saves only after newline confirmation and revoke clears the session', async () => {
 const { spawn } = await import('node:child_process');
 const root = await mkdtemp(join(tmpdir(),'coke-profile-cli-'));
 const fixture = createServer((_request,response)=> {response.setHeader('set-cookie','session=human-login-private; HttpOnly; SameSite=Lax; Path=/');response.end('<main>Login fixture</main>');});
 await new Promise(r=>fixture.listen(0,'127.0.0.1',r));
 const origin = `http://127.0.0.1:${fixture.address().port}`;
 const invoke = (command,input) => new Promise((done,reject)=> {
  const child=spawn(process.execPath,[new URL('../bin/coke.mjs',import.meta.url).pathname,'profile',command,'primary','--url',origin,'--user','alice','--profile-dir',root],{env:{...process.env,COKE_BROWSER_HEADLESS:'1'},stdio:['pipe','pipe','pipe']});
  let stdout='',stderr='';child.stdout.on('data',c=>stdout+=c);child.stderr.on('data',c=>stderr+=c);child.once('error',reject);child.once('exit',code=>done({code,stdout,stderr}));child.stdin.end(input);
 });
 try {
  const unconfirmed=await invoke('login','');assert.equal(unconfirmed.code,1);
  assert.equal((await new ProfileStore(root).load('alice',{name:'primary',origin})).state.cookies.length,0);
  const confirmed=await invoke('login','\n');assert.equal(confirmed.code,0,confirmed.stderr);assert.equal(JSON.parse(confirmed.stdout).saved,true);
  assert.equal((await new ProfileStore(root).load('alice',{name:'primary',origin})).state.cookies[0].value,'human-login-private');
  assert.equal(confirmed.stdout.includes('human-login-private'),false);assert.equal(confirmed.stderr.includes('human-login-private'),false);
  assert.equal((await invoke('revoke','')).code,0);
  assert.equal((await new ProfileStore(root).load('alice',{name:'primary',origin})).state.cookies.length,0);
 } finally {fixture.close();await rm(root,{recursive:true,force:true});}
});

for (const runtime of ['local','e2b']) test(`task profile opt-in reuses session in separate task processes (${runtime})`, {skip: runtime==='e2b' && (!process.env.RUN_E2B_TEST || !process.env.E2B_API_KEY)}, async () => {
 const { execFile }=await import('node:child_process');const { promisify }=await import('node:util');const exec=promisify(execFile);
 const root=await mkdtemp(join(tmpdir(),'coke-profile-task-'));
 const fixture=createServer((request,response)=>{response.setHeader('content-type','text/html');response.end(request.url==='/'?'<a href="/result">Next</a>':`<main id="value">${request.headers.cookie?.includes('saved-private')?'authenticated':'anonymous'}</main>`);});
 await new Promise(r=>fixture.listen(0,'127.0.0.1',r));const origin=`http://127.0.0.1:${fixture.address().port}`;
 try {
  const store=new ProfileStore(root);const descriptor={name:'primary',origin};const initial=await store.load('alice',descriptor);
  await store.save('alice',descriptor,{cookies:[{name:'session',value:'saved-private',domain:'127.0.0.1',path:'/',expires:-1,httpOnly:true,secure:false,sameSite:'Lax'}],origins:[]},initial.generation);
  const run=async user=>{const {stdout}=await exec(process.execPath,[new URL('../bin/coke.mjs',import.meta.url).pathname,'task','run','Read session status','--runtime',runtime,'--user',user,'--url',origin,'--link-text','Next','--value-selector','#value','--profile','primary','--profile-dir',root,'--output-dir',join(root,'artifacts')],{timeout:60000,env:process.env});assert.equal(stdout.includes('saved-private'),false);return JSON.parse(stdout);};
  const first=await run('alice');assert.equal(first.value,'authenticated');
  const second=await run('alice');assert.equal(second.value,'authenticated');
  assert.equal((await run('bob')).value,'anonymous');
  if(runtime==='e2b'){assert.equal(first.sandboxKilled,true);assert.equal(second.sandboxKilled,true);assert.notEqual(first.sandboxId,second.sandboxId);}
 }finally{fixture.close();await rm(root,{recursive:true,force:true});}
});

test('unconfirmed handoff timeout and SIGINT discard session changes', async () => {
 const { spawn }=await import('node:child_process');
 const root=await mkdtemp(join(tmpdir(),'coke-profile-abort-'));
 const fixture=createServer((_request,response)=>{response.setHeader('set-cookie','session=discard-private; Path=/');response.end('<main>login</main>');});
 await new Promise(r=>fixture.listen(0,'127.0.0.1',r));const origin=`http://127.0.0.1:${fixture.address().port}`;
 try{
  for(const mode of ['timeout','cancel']){
   const code=await new Promise((done,reject)=>{
    const child=spawn(process.execPath,[new URL('../bin/coke.mjs',import.meta.url).pathname,'profile','login',mode,'--url',origin,'--user','alice','--profile-dir',root,'--timeout-ms',mode==='timeout'?'1000':'10000'],{env:{...process.env,COKE_BROWSER_HEADLESS:'1'},stdio:['pipe','pipe','pipe']});
    child.stderr.on('data',chunk=>{if(mode==='cancel'&&chunk.toString().includes('press Enter'))child.kill('SIGINT');});child.once('error',reject);child.once('exit',done);
   });
   assert.equal(code,1);assert.equal((await new ProfileStore(root).load('alice',{name:mode,origin})).state.cookies.length,0);
  }
 }finally{fixture.close();await rm(root,{recursive:true,force:true});}
});
