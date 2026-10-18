import test from 'node:test';
import assert from 'node:assert/strict';
import {fork} from 'node:child_process';
import {createServer} from 'node:http';
import {once} from 'node:events';

test('navigation commits without waiting for a blocked page script; subsequent read verifies visible content',async()=>{
 const site=createServer((req,res)=>{if(req.url==='/blocked.js')return;res.setHeader('content-type','text/html');res.end(req.url==='/shell'?'<nav>Home</nav><main><nav><a href="/">Today</a></nav></main>':req.url==='/busy'?'<main aria-busy="true">Visible incomplete task</main>':'<h1>Visible committed page</h1><script src="/blocked.js"></script>')});await new Promise(r=>site.listen(0,'127.0.0.1',r));
 const child=fork(new URL('../src/browser-server.mjs',import.meta.url),[],{env:{...process.env,COKE_BROWSER_TOKEN:'test-navigation-token'},stdio:['ignore','ignore','ignore','ipc']});
 try{const [ready]=await once(child,'message');const call=async(route,body)=>{const r=await fetch(`http://127.0.0.1:${ready.port}${route}`,{method:'POST',headers:{authorization:'Bearer test-navigation-token','content-type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(2500)});return r.json()};const identity={userId:'navigation-fixture',taskId:'navigation-task'};const lease=await call('/acquire',identity);identity.leaseId=lease.leaseId;const url=`http://127.0.0.1:${site.address().port}/`;assert.equal((await call('/action',{...identity,action:'navigate',url})).url,url);const read=await call('/action',{...identity,action:'read'});assert.ok(read.text.includes('Visible committed page'));assert.equal(read.loading,false);for(const path of ['shell','busy']){await call('/action',{...identity,action:'navigate',url:url+path});assert.equal((await call('/action',{...identity,action:'read'})).loading,true,path)}const failed=await call('/action',{...identity,action:'navigate',url:'http://127.0.0.1:1/'});assert.deepEqual(failed,{error:{code:'BROWSER_NAVIGATION_FAILED'}});}
 finally{child.send({type:'shutdown'});await once(child,'exit');site.closeAllConnections();await new Promise(r=>site.close(r))}
});

test('agent reads visible main content while a subresource remains blocked',async()=>{
 const {execFile}=await import('node:child_process');const {promisify}=await import('node:util');const {mkdtemp,rm}=await import('node:fs/promises');const{tmpdir}=await import('node:os');const{join,resolve}=await import('node:path');let requests=0;
 const site=createServer((req,res)=>{if(req.url==='/blocked.js')return;res.setHeader('content-type','text/html');res.end('<nav><a href="/">Home</a></nav><main><h1>Today</h1><p>Visible task evidence</p></main><script src="/blocked.js"></script>')});
 const model=createServer(async(req,res)=>{let body='';for await(const chunk of req)body+=chunk;requests++;const observation=JSON.parse(JSON.parse(body).messages.at(-1).content);assert.ok(observation.text.includes('Visible task evidence'));res.setHeader('content-type','application/json');res.end(JSON.stringify({choices:[{message:{content:JSON.stringify({action:'answer',value:'Visible task evidence'})}}]}))});await Promise.all([new Promise(r=>site.listen(0,'127.0.0.1',r)),new Promise(r=>model.listen(0,'127.0.0.1',r))]);const output=await mkdtemp(join(tmpdir(),'blocked-subresource-'));
 try{const result=await promisify(execFile)(process.execPath,[resolve('bin/coke.mjs'),'task','run','Read visible task evidence only','--runtime','local','--url',`http://127.0.0.1:${site.address().port}/`,'--model','fixture','--max-steps','1','--output-dir',output],{timeout:15000,env:{...process.env,COKE_MODEL_API_KEY:'fixture',COKE_MODEL_BASE_URL:`http://127.0.0.1:${model.address().port}/v1`}});assert.equal(JSON.parse(result.stdout).value,'Visible task evidence');assert.equal(requests,1)}finally{site.closeAllConnections();model.closeAllConnections();await Promise.all([new Promise(r=>site.close(r)),new Promise(r=>model.close(r))]);await rm(output,{recursive:true,force:true})}
});

test('gateway can capture visible login content while a web font remains pending', async () => {
 const {createBrowserGateway} = await import('../src/browser-gateway.mjs');
 const {createServer:createTLS} = await import('node:https');
 const {execFile} = await import('node:child_process');
 const {promisify} = await import('node:util');
 const {mkdtemp,readFile,rm} = await import('node:fs/promises');
 const {tmpdir} = await import('node:os');
 const {join,resolve} = await import('node:path');
 const exec = promisify(execFile);
 const certDir = await mkdtemp(join(tmpdir(),'pending-font-tls-'));
 await exec('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',join(certDir,'key'),'-out',join(certDir,'cert'),'-days','1','-subj','/CN=localhost','-addext','subjectAltName=DNS:localhost']);
 let fontRequested;
 const pendingFont = new Promise(resolve => { fontRequested = resolve; });
 const site = createServer((req, res) => {
  if (req.url === '/pending.woff2') { fontRequested(); return; }
  res.setHeader('content-type', 'text/html');
  res.end('<style>@font-face{font-family:Pending;src:url(/pending.woff2)}body{font-family:Pending, sans-serif;min-height:1800px}</style><h1>Sign In</h1><p>Log in to view today tasks</p>');
 });
 await new Promise(resolve => site.listen(0, '127.0.0.1', resolve));
 const child = fork(new URL('../src/browser-server.mjs', import.meta.url), [], {env:{...process.env,COKE_BROWSER_TOKEN:'pending-font-fixture'},stdio:['ignore','ignore','ignore','ipc']});
 const gateway = createBrowserGateway();
 const server = createTLS({key:await readFile(join(certDir,'key')),cert:await readFile(join(certDir,'cert'))},gateway.handle);
 await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
 let revoke;
 try {
  const [ready] = await once(child, 'message');
  const direct = async (path, body) => (await fetch(`http://127.0.0.1:${ready.port}${path}`, {method:'POST',headers:{authorization:'Bearer pending-font-fixture','content-type':'application/json'},body:JSON.stringify(body)})).json();
  const identity = {userId:'pending-font-user',taskId:'pending-font-task'};
  identity.leaseId = (await direct('/acquire', identity)).leaseId;
  revoke = gateway.register({...identity,token:'pending-font-gateway',browserToken:'pending-font-fixture',port:ready.port,expiresAt:Date.now()+30000});
  await direct('/action', {...identity, action:'navigate',url:`http://127.0.0.1:${site.address().port}/`});
  await pendingFont;
  const {stdout} = await exec(process.execPath,[resolve('src/tools-cli.mjs'),'browser','screenshot'],{timeout:8000,env:{...process.env,NODE_EXTRA_CA_CERTS:join(certDir,'cert'),COKE_BROWSER_GATEWAY_URL:`https://localhost:${server.address().port}`,COKE_BROWSER_GATEWAY_TOKEN:'pending-font-gateway',COKE_TOOL_REQUEST:JSON.stringify({...identity,action:'screenshot'})}});
  const result = JSON.parse(stdout);
  assert.equal(result.transport,'https-gateway');
  const image = Buffer.from(result.result.pngBase64,'base64');
  assert.equal(image.subarray(0,8).toString('hex'),'89504e470d0a1a0a');
  assert.ok(image.readUInt32BE(20)>=1800,'fallback retains full page height');
  const read = await direct('/action', {...identity,action:'read'});
  assert.ok(read.text.includes('Log in to view today tasks'));
  assert.equal(read.loading, false);
 } finally {
  revoke?.(); server.closeAllConnections();
  child.send({type:'shutdown'}); await once(child,'exit');
  site.closeAllConnections();
  await Promise.all([new Promise(resolve=>server.close(resolve)),new Promise(resolve=>site.close(resolve))]);
  await rm(certDir,{recursive:true,force:true});
 }
});
