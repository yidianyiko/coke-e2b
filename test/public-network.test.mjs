import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { isPublicAddress, publicHttpUrl, createPublicNetworkProxy } from '../src/public-network.mjs';
test('only globally routable destination addresses and plain HTTP URLs are accepted', () => {
 for (const ip of ['127.0.0.1','10.0.0.1','172.16.1.1','192.168.1.1','169.254.169.254','100.64.0.1','0.0.0.0','224.0.0.1','198.18.0.1','192.0.2.1','::1','::','fc00::1','fe80::1','ff02::1','::ffff:127.0.0.1','2001:db8::1']) assert.equal(isPublicAddress(ip),false,ip);
 for(const ip of ['8.8.8.8','1.1.1.1','2606:4700:4700::1111']) assert.equal(isPublicAddress(ip),true,ip);
 for(const url of ['file:///etc/passwd','http://user:pass@example.com','http://127.1','http://[::1]']) assert.throws(()=>publicHttpUrl(url));
 assert.equal(publicHttpUrl('https://example.com').hostname,'example.com');
});
test('proxy pins resolved public address and denies private redirect/subresource destinations and CONNECT', async () => {
 const target=http.createServer((req,res)=>res.end(req.headers.host)); await new Promise(r=>target.listen(0,'127.0.0.1',r));
 const connections=[];
 const proxy=await createPublicNetworkProxy({lookup:async host=>[{address:host==='public.example'?'8.8.8.8':'127.0.0.1',family:4}],connect:options=>{connections.push(options); return net.connect({host:'127.0.0.1',port:target.address().port});}});
 const request=url=>new Promise((resolve,reject)=>http.get(proxy.url,{path:url},res=>{let body='';res.on('data',c=>body+=c);res.on('end',()=>resolve({status:res.statusCode,body}));}).on('error',reject));
 try {
 assert.equal((await request('http://public.example/')).body,'public.example');
 assert.equal(connections[0].host,'8.8.8.8');
 assert.equal((await request('http://private.example/')).status,403);
 assert.equal((await request('http://169.254.169.254/')).status,403);
 const status=await new Promise((resolve,reject)=>{const req=http.request(proxy.url,{method:'CONNECT',path:'private.example:443'});req.on('connect',(res,socket)=>{socket.destroy();resolve(res.statusCode);});req.on('error',reject);req.end();});
 assert.equal(status,403);assert.equal(connections.length,1);
 } finally {await proxy.close();await new Promise(r=>target.close(r));}
});
test('public-only Chromium lease cannot reach loopback even through browser proxy bypass', async()=>{
 const {fork}=await import('node:child_process'); const {once}=await import('node:events');
 let hits=0;const site=http.createServer((_q,r)=>{hits++;r.end('private sentinel');});await new Promise(r=>site.listen(0,'127.0.0.1',r));
 const child=fork(new URL('../src/browser-server.mjs',import.meta.url),[],{env:{...process.env,COKE_BROWSER_TOKEN:'public-test'},stdio:['ignore','ignore','ignore','ipc']});
 try{const [ready]=await once(child,'message');const identity={userId:'public-user',taskId:'public-task'};const call=async(route,body)=>(await fetch(`http://127.0.0.1:${ready.port}${route}`,{method:'POST',headers:{authorization:'Bearer public-test','content-type':'application/json'},body:JSON.stringify(body)})).json();identity.leaseId=(await call('/acquire',{...identity,publicOnly:true})).leaseId;assert.ok(identity.leaseId);await call('/action',{...identity,action:'navigate',url:`http://localhost:${site.address().port}/`});assert.equal(hits,0);}
 finally{child.send({type:'shutdown'});await once(child,'exit');site.closeAllConnections();await new Promise(r=>site.close(r));}
});
test('DNS rebinding and mixed public/private records never open a private connection',async()=>{
 let lookupCount=0,connections=0;
 const proxy=await createPublicNetworkProxy({lookup:async()=>{lookupCount++;return lookupCount===1?[{address:'8.8.8.8',family:4},{address:'10.1.2.3',family:4}]:[{address:'169.254.169.254',family:4}];},connect:()=>{connections++;throw new Error('must not connect');}});
 try{for(let i=0;i<2;i++){const status=await new Promise((resolve,reject)=>http.get(proxy.url,{path:'http://rebind.example/'},res=>{res.resume();res.once('end',()=>resolve(res.statusCode));}).on('error',reject));assert.equal(status,403);}assert.equal(lookupCount,2);assert.equal(connections,0);}finally{await proxy.close();}
});
test('HTTPS CONNECT pins destination numeric address and relays bytes without resolving again',async()=>{
 const target=net.createServer(socket=>socket.on('data',data=>socket.write(data)));await new Promise(r=>target.listen(0,'127.0.0.1',r));let observed;
 const proxy=await createPublicNetworkProxy({lookup:async()=>[{address:'1.1.1.1',family:4}],connect:options=>{observed=options;return net.connect({host:'127.0.0.1',port:target.address().port});}});
 try{await new Promise((resolve,reject)=>{const req=http.request(proxy.url,{method:'CONNECT',path:'public.example:443'});req.once('error',reject);req.once('connect',(res,socket)=>{assert.equal(res.statusCode,200);socket.once('data',data=>{assert.equal(data.toString(),'tunnel-check');socket.destroy();resolve();});socket.write('tunnel-check');});req.end();});assert.deepEqual(observed,{host:'1.1.1.1',family:4,port:443});}finally{await proxy.close();await new Promise(r=>target.close(r));}
});
test('client reset during asynchronous CONNECT lookup cannot crash proxy process',async()=>{
 const {spawn}=await import('node:child_process');
 const source=`import net from 'node:net';import {createPublicNetworkProxy} from './src/public-network.mjs';
 const proxy=await createPublicNetworkProxy({lookup:async()=>{await new Promise(r=>setTimeout(r,50));return [{address:'127.0.0.1',family:4}]}});
 const client=net.connect(new URL(proxy.url).port,'127.0.0.1');await new Promise(r=>client.once('connect',r));client.write('CONNECT example.com:443 HTTP/1.1\\r\\nHost: example.com:443\\r\\n\\r\\n');await new Promise(r=>setTimeout(r,10));client.resetAndDestroy();await new Promise(r=>setTimeout(r,100));await proxy.close();`;
 const child=spawn(process.execPath,['--input-type=module','-e',source],{cwd:new URL('..',import.meta.url),stdio:['ignore','ignore','pipe']});let errors='';child.stderr.on('data',data=>errors+=data);const code=await new Promise(resolve=>child.once('exit',resolve));assert.equal(code,0,errors);
});
