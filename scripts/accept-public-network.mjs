import {fork} from 'node:child_process';
import assert from 'node:assert/strict';
import {stopService} from '../src/service-process.mjs';
const token='public-acceptance-fixture-only';let stderr='';
const child=fork(new URL('../src/browser-server.mjs',import.meta.url),[],{env:{...process.env,COKE_BROWSER_TOKEN:token,COKE_BROWSER_PUBLIC_ONLY:'1',COKE_BROWSER_READ_ONLY:'1'},stdio:['ignore','ignore','pipe','ipc']});child.stderr.on('data',chunk=>stderr+=chunk);
try{
 const port=await new Promise((resolve,reject)=>{const timeout=setTimeout(()=>reject(Error('START_TIMEOUT')),15000);child.on('message',m=>{if(m.type==='ready'){clearTimeout(timeout);resolve(m.port)}});child.once('exit',()=>{clearTimeout(timeout);reject(Error('EARLY_EXIT'))})});
 const call=async(path,body)=>{const r=await fetch(`http://127.0.0.1:${port}${path}`,{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(15000)});const data=await r.json();assert.ok(r.ok,JSON.stringify(data));return data};
 const identity={userId:'public-acceptance-user',taskId:'public-acceptance-task'};identity.leaseId=(await call('/acquire',identity)).leaseId;
 const results=[];
 for(const url of ['https://example.com/','http://example.com/']){
  await call('/action',{...identity,action:'navigate',url});
  let page;for(let attempt=0;attempt<10;attempt++){page=await call('/action',{...identity,action:'read'});if(page.text.includes('documentation examples'))break;await new Promise(r=>setTimeout(r,500))}assert.ok(page.text.includes('documentation examples'),JSON.stringify({url:page.url,text:page.text.slice(0,500)}));results.push({url:page.url,observed:page.text.slice(0,220)});
 }
 await call('/release',{...identity,saveProfile:false});assert.equal(stderr,'');
 console.log(JSON.stringify({status:'passed',publicOnly:true,results,stderrEmpty:true}));
}finally{await stopService(child)}
