import test from 'node:test';
import assert from 'node:assert/strict';
import {fork} from 'node:child_process';
import {createServer} from 'node:http';
import {createServer as createTLS} from 'node:https';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createBrowserGateway} from '../src/browser-gateway.mjs';
import {TaskStore} from '../src/task-store.mjs';

test('E2B controls the page over TLS while large screenshot artifacts stay on their owning host',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'host-screenshot-'));
 const exec=promisify(execFile);
 await exec('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',join(dir,'key'),'-out',join(dir,'cert'),'-days','1','-subj','/CN=localhost','-addext','subjectAltName=DNS:localhost']);
 const gateway=createBrowserGateway();
 const tls=createTLS({key:await readFile(join(dir,'key')),cert:await readFile(join(dir,'cert'))},gateway.handle);
 const site=createServer((req,res)=>{
  res.setHeader('content-type','text/html');
  res.end('<a href="/result">Next</a><main id="value">actual page evidence</main><canvas width="1200" height="900"></canvas><script>const c=document.querySelector("canvas").getContext("2d"),d=c.createImageData(1200,900);for(let i=0;i<d.data.length;i+=4){d.data[i]=Math.random()*256;d.data[i+1]=Math.random()*256;d.data[i+2]=Math.random()*256;d.data[i+3]=255}c.putImageData(d,0,0)</script>');
 });
 await Promise.all([new Promise(r=>tls.listen(0,'127.0.0.1',r)),new Promise(r=>site.listen(0,'127.0.0.1',r))]);
 const hook=join(dir,'sandbox.mjs');
 await writeFile(hook,`import {Sandbox,TimeoutError} from ${JSON.stringify(import.meta.resolve('e2b'))};
import {createHash} from 'node:crypto';import {readFile} from 'node:fs/promises';
import {execFile} from 'node:child_process';import {promisify} from 'node:util';
const exec=promisify(execFile);
Sandbox.create=async()=>({sandboxId:'fixture-sandbox',kill:async()=>true,commands:{async run(command,{envs={}}={}){
 if(command.includes('sha256')){const p=command.includes('workspace-cli')?'src/workspace-cli.mjs':'src/tools-cli.mjs';return {exitCode:0,stdout:createHash('sha256').update(await readFile(p)).digest('hex'),stderr:''}}
 if(command.startsWith('mkdir'))return {exitCode:0,stdout:'',stderr:''};
 const request=JSON.parse(envs.COKE_TOOL_REQUEST);
 if(request.action==='screenshot')throw new TimeoutError('large remote screenshot output stalled');
 const out=await exec(process.execPath,['src/tools-cli.mjs','browser',request.action],{env:{...process.env,...envs},maxBuffer:2*1024*1024});
 return {exitCode:0,...out};
}}});`);
 let revoke,child;
 try{
  child=fork(resolve('bin/coke.mjs'),['task','run','Read actual page evidence','--runtime','e2b','--user','screenshot-user','--url',`http://127.0.0.1:${site.address().port}/`,'--link-text','Next','--value-selector','#value','--output-dir',dir],{
   execArgv:['--import',hook],env:{...process.env,E2B_API_KEY:'fixture',COKE_BROWSER_PUBLIC_ONLY:'0',COKE_BROWSER_GATEWAY_URL:`https://localhost:${tls.address().port}`,NODE_EXTRA_CA_CERTS:join(dir,'cert')},stdio:['ignore','pipe','pipe','ipc'],
  });
  let stdout='',stderr='';child.stdout.on('data',c=>stdout+=c);child.stderr.on('data',c=>stderr+=c);
  child.on('message',m=>{if(m.type==='browser-gateway-register'){revoke=gateway.register(m.scope);child.send({type:'browser-gateway-ready'})}});
  const code=await new Promise((yes,no)=>{const timer=setTimeout(()=>{child.kill('SIGKILL');no(Error('worker did not finish'))},20000);child.once('error',no);child.once('exit',code=>{clearTimeout(timer);yes(code)})});
  assert.equal(code,0,stderr);
  const result=JSON.parse(stdout);
  assert.equal(result.value,'actual page evidence');
  assert.ok(result.trace.some(t=>t.action==='navigate'&&t.source==='e2b-https-gateway'));
  assert.ok(result.trace.some(t=>t.action==='extract'&&t.source==='e2b-https-gateway'));
  assert.ok(result.trace.filter(t=>t.action==='screenshot').every(t=>t.ok&&t.source==='local-cli'));
  const png=await readFile(result.screenshotPath);
  assert.equal(png.subarray(0,8).toString('hex'),'89504e470d0a1a0a');
  assert.ok(png.length>1024*1024,'exercise a screenshot larger than one MiB');
  const record=await new TaskStore(dir).get('screenshot-user',result.taskId);
  assert.equal(record.resourcesReleased,true);assert.equal(record.sandboxKilled,true);
 }finally{
  if(child?.exitCode===null)child.kill('SIGKILL');
  revoke?.();tls.closeAllConnections();site.closeAllConnections();
  await Promise.all([new Promise(r=>tls.close(r)),new Promise(r=>site.close(r))]);
  await rm(dir,{recursive:true,force:true});
 }
});
