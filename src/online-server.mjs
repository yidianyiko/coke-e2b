import {createServer} from 'node:http';
import {timingSafeEqual} from 'node:crypto';
import {readFile} from 'node:fs/promises';
const error=code=>Object.assign(new Error(code),{code});
export function createOnlineServer({integrationService,browserGateway,manager,loginManager,loginLinks,tokens,allowedHosts=['ticktick.com','www.ticktick.com'],webRoot=new URL('../web/',import.meta.url)}){
 const json=(res,status,body)=>{res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff'});res.end(JSON.stringify(body))};
 return createServer(async(req,res)=>{try{
  const url=new URL(req.url,'http://localhost'),path=url.pathname;
  if(integrationService&&await integrationService.handle(req,res))return;
  if(path==='/v1/browser/action'&&browserGateway)return await browserGateway.handle(req,res);
  if(path==='/health'&&req.method==='GET')return json(res,200,{ready:true});
  if(req.method==='GET'&&(['/', '/app.js', '/login', '/login.js'].includes(path))){const file=path==='/'?'index.html':path==='/login'?'login.html':path.slice(1);const bytes=await readFile(new URL(file,webRoot));res.writeHead(200,{'content-type':file.endsWith('.js')?'text/javascript; charset=utf-8':'text/html; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff','content-security-policy':"default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; frame-ancestors 'none'; base-uri 'none'"});return res.end(bytes)}
  if(req.headers.origin){const origin=new URL(req.headers.origin);if(origin.host!==req.headers.host)throw error('INVALID_ORIGIN')}
  let body={};if(req.method==='POST'){if(!req.headers['content-type']?.startsWith('application/json'))throw error('INVALID_BODY');const chunks=[];let bytes=0;for await(const chunk of req){bytes+=chunk.length;if(bytes>32768)throw error('BODY_TOO_LARGE');chunks.push(chunk)}try{body=JSON.parse(Buffer.concat(chunks,bytes).toString('utf8')||'{}')}catch{throw error('INVALID_BODY')}if(!body||Array.isArray(body)||typeof body!=='object')throw error('INVALID_BODY')}
  if(loginLinks&&path.startsWith('/v1/login-link/')){
   if(path==='/v1/login-link/exchange'&&req.method==='POST'){if(Object.keys(body).some(k=>k!=='secret'))throw error('INVALID_BODY');return json(res,200,await loginLinks.exchange(body.secret));}
   const token=req.headers.authorization?.startsWith('Bearer ')?req.headers.authorization.slice(7):'';
   const result=await loginLinks.handle(token,req.method,path.slice('/v1/login-link/'.length),body);
   if(path.includes('/artifacts/')){res.writeHead(200,{'content-type':result.type,'content-disposition':'attachment','cache-control':'no-store','x-content-type-options':'nosniff'});return res.end(result.bytes)}
   return json(res,200,result);
  }
  const presented=req.headers.authorization?.startsWith('Bearer ')?req.headers.authorization.slice(7):'';
  const account=tokens.find(({token})=>{const a=Buffer.from(presented),b=Buffer.from(token);return a.length===b.length&&timingSafeEqual(a,b)});if(!account)return json(res,401,{error:{code:'UNAUTHORIZED'}});
  if(path==='/v1/session'&&req.method==='GET')return json(res,200,{authenticated:true});
  if(req.method==='POST'&&(path==='/v1/tasks'||path==='/v1/login-links')){
   if(Object.keys(body).some(key=>!['task','url','profile'].includes(key))||typeof body.task!=='string'||!body.task.trim()||body.task.length>16000||typeof body.url!=='string'||body.url.length>2048||body.profile!==undefined&&!/^[a-zA-Z0-9_-]{1,64}$/.test(body.profile))throw error('INVALID_TASK');
   let target;try{target=new URL(body.url)}catch{throw error('INVALID_URL')}if(target.protocol!=='https:'||target.username||target.password||!allowedHosts.includes(target.hostname)||target.port&&target.port!=='443')throw error('INVALID_URL');if(path==='/v1/login-links'){if(!loginLinks||!body.profile)throw error('INVALID_TASK');return json(res,201,loginLinks.create(account.userId,body));}return json(res,202,await manager.submit(account.userId,body));
  }
  const match=/^\/v1\/tasks\/([a-f0-9-]{36})(?:\/(cancel|trace|usage|artifacts)(?:\/([0-9]+))?)?$/.exec(path);
  if(match){const [,id,action,artifactId]=match;if(req.method==='GET'&&!action)return json(res,200,await manager.get(account.userId,id));if(req.method==='POST'&&action==='cancel')return json(res,200,await manager.cancel(account.userId,id));if(req.method==='GET'&&['trace','usage'].includes(action))return json(res,200,await manager[action](account.userId,id));if(req.method==='GET'&&action==='artifacts'&&artifactId){const artifact=await manager.artifact(account.userId,id,artifactId);res.writeHead(200,{'content-type':artifact.type,'content-disposition':'attachment','cache-control':'no-store','x-content-type-options':'nosniff'});return res.end(artifact.bytes)}}
  if(loginManager&&(path.startsWith('/v1/logins')||path==='/v1/profiles/revoke')){const result=await loginManager.handle({method:req.method,path,userId:account.userId,body});return json(res,result.status,result.body)}
  return json(res,404,{error:{code:'NOT_FOUND'}});
 }catch(err){const code=err.code||err.message;const status=['CAPACITY_BUSY','PROFILE_BUSY'].includes(code)?409:['TASK_NOT_FOUND','ARTIFACT_NOT_FOUND','LOGIN_NOT_FOUND','LINK_NOT_FOUND','NOT_FOUND'].includes(code)?404:code==='BODY_TOO_LARGE'?413:typeof code==='string'&&/^(INVALID_|PROFILE_|LOGIN_)/.test(code)?400:500;json(res,status,{error:{code:status===500?'INTERNAL_ERROR':code}})}});
}
