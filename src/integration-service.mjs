import {createHash,randomBytes,timingSafeEqual} from 'node:crypto';
import {mkdir,readFile,readdir,writeFile,rename} from 'node:fs/promises';
import {join} from 'node:path';
const fail=(code,status=400)=>Object.assign(new Error(code),{code,status});
const hash=s=>createHash('sha256').update(s).digest('hex');
const equal=(a,b)=>{const x=Buffer.from(a||''),y=Buffer.from(b||'');return x.length===y.length&&timingSafeEqual(x,y)};
const publicJob=j=>({status:j.status,result:j.result,artifacts:j.artifacts,errorCode:j.errorCode});
/** Restricted machine API. A trusted caller supplies canonical identity, never a browser owner. */
export async function createIntegrationService({manager,loginLinks,dataDir,serviceToken,publicBaseUrl,validateTarget=async()=>{},now=Date.now,capabilityTtlMs=15*60*1000}){
 if(typeof serviceToken!=='string'||serviceToken.length<24)throw Error('INVALID_INTEGRATION_TOKEN');
 const base=new URL(publicBaseUrl);if(!['http:','https:'].includes(base.protocol)||base.username||base.password||base.search||base.hash)throw Error('INVALID_PUBLIC_BASE');
 const root=join(dataDir,'integration');await mkdir(root,{recursive:true,mode:0o700});const records=new Map(),sessions=new Map(),authLinks=new Map();let chain=Promise.resolve();
 const save=async r=>{const file=join(root,r.key+'.json');await writeFile(file+'.tmp',JSON.stringify(r),{mode:0o600});await rename(file+'.tmp',file)};
 for(const name of await readdir(root)){if(!/^[a-f0-9]{64}\.json$/.test(name))continue;const r=JSON.parse(await readFile(join(root,name),'utf8'));if(r.status==='dispatching'){r.status='interrupted';r.error='DISPATCH_UNCERTAIN';await save(r)}records.set(r.key,r)}
 const serial=fn=>{const next=chain.then(fn);chain=next.catch(()=>{});return next};
 const identity=(ownerId,requestId)=>{if(typeof ownerId!=='string'||!ownerId.trim()||ownerId.length>256||typeof requestId!=='string'||!/^[-a-zA-Z0-9_]{1,128}$/.test(requestId))throw fail('INVALID_IDENTITY');return {owner:'legacy:'+hash(ownerId),key:hash(JSON.stringify([ownerId,requestId]))}};
 const owned=(owner,id)=>{const {key}=identity(owner,id),r=records.get(key);if(!r)throw fail('NOT_FOUND',404);return r};
 const refresh=async r=>{
  if(r.status==='queued'){
   r.status='dispatching';await save(r);
   try{const job=await manager.submit(r.owner,r.input);r.jobId=job.id;r.status=job.status;r.job=publicJob(job);delete r.error;await save(r)}catch(e){r.status=e.code==='CAPACITY_BUSY'?'queued':'interrupted';r.error=r.status==='queued'?undefined:'DISPATCH_UNCERTAIN';await save(r)}
  }
  if(r.jobId&&['dispatching','running'].includes(r.status)){try{const j=await manager.get(r.owner,r.jobId);r.status=j.status;r.job=publicJob(j);if(['SITE_AUTHENTICATION_REQUIRED','SITE_CAPTCHA_REQUIRED','SITE_MFA_REQUIRED','SITE_LOGIN_UNSUPPORTED'].includes(j.errorCode)){r.status=j.errorCode==='SITE_AUTHENTICATION_REQUIRED'&&loginLinks&&['https://ticktick.com','https://www.ticktick.com'].includes(new URL(r.input.url).origin)?'needs_authorization':'blocked';r.error=j.errorCode}await save(r)}catch{r.status='interrupted';r.error='JOB_UNAVAILABLE';await save(r)}}
  return r;
 };
 const view=r=>({id:r.requestId,...(r.job||{}),status:r.status,...(r.error?{error:{code:r.error}}:{})});
 const link=async r=>{if(r.cap?.expires>now())return new URL('/result',base).href+'#'+r.cap.secret;const secret=randomBytes(32).toString('base64url');r.cap={secret,hash:hash(secret),expires:now()+capabilityTtlMs};await save(r);return new URL('/result',base).href+'#'+secret};
 const response=async r=>{const out=view(r);if(r.status==='needs_authorization'){
   let a=authLinks.get(r.key);if(!a||a.expiresAt<=now()){
    a=loginLinks.create(r.owner,{...r.input,url:new URL('/signin',r.input.url).href},{submit:()=>serial(async()=>{
     if(r.status!=='needs_authorization')throw fail('REQUEST_CONFLICT',409);
     r.status='dispatching';await save(r);try{const job=await manager.submit(r.owner,r.input);r.jobId=job.id;r.status=job.status;r.job=publicJob(job);delete r.error;authLinks.delete(r.key);await save(r);return job}catch(e){r.status=e.code==='CAPACITY_BUSY'?'needs_authorization':'interrupted';r.error=r.status==='interrupted'?'DISPATCH_UNCERTAIN':undefined;await save(r);throw e}
    })});authLinks.set(r.key,a);
   }out.authorizationUrl=new URL('/login',base).href+'#'+a.secret;
  }if(r.status==='succeeded')out.resultUrl=await link(r);return out};
 const json=(res,status,value)=>{res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff','referrer-policy':'no-referrer'});res.end(JSON.stringify(value))};
 const body=async req=>{if(!req.headers['content-type']?.startsWith('application/json'))throw fail('INVALID_BODY');let bytes=0,chunks=[];for await(const c of req){bytes+=c.length;if(bytes>32768)throw fail('BODY_TOO_LARGE',413);chunks.push(c)}try{const b=JSON.parse(Buffer.concat(chunks).toString());if(!b||typeof b!=='object'||Array.isArray(b))throw Error();return b}catch{throw fail('INVALID_BODY')}};
 return {async handle(req,res){const url=new URL(req.url,'http://localhost'),path=url.pathname;
  if(!path.startsWith('/v1/integration/')&&!path.startsWith('/v1/result')&&path!=='/result'&&path!=='/result.js')return false;
  try{
   if(req.headers.origin&&new URL(req.headers.origin).host!==req.headers.host)throw fail('INVALID_ORIGIN',403);
   if(req.method==='GET'&&(path==='/result'||path==='/result.js')){const file=path==='/result'?'integration-result.html':'integration-result.js';const bytes=await readFile(new URL('../web/'+file,import.meta.url));res.writeHead(200,{'content-type':file.endsWith('.js')?'text/javascript':'text/html; charset=utf-8','cache-control':'no-store','referrer-policy':'no-referrer','content-security-policy':"default-src 'self'; script-src 'self'; frame-ancestors 'none'; base-uri 'none'"});res.end(bytes);return true}
   const token=req.headers.authorization?.startsWith('Bearer ')?req.headers.authorization.slice(7):'';
   if(path.startsWith('/v1/result')){
    if(path==='/v1/result/exchange'&&req.method==='POST'){
     const b=await body(req);if(typeof b.secret!=='string'||b.secret.length>128)throw fail('NOT_FOUND',404);
     const r=[...records.values()].find(r=>r.cap?.hash===hash(b.secret)&&r.cap.expires>now());if(!r)throw fail('NOT_FOUND',404);
     const expires=r.cap.expires;delete r.cap;await save(r);const session=randomBytes(32).toString('base64url');sessions.set(hash(session),{key:r.key,expires});json(res,200,{token:session});return true;
    }
    const s=sessions.get(hash(token));if(!s||s.expires<=now())throw fail('UNAUTHORIZED',401);const r=records.get(s.key);if(!r?.jobId)throw fail('NOT_FOUND',404);
    if(path==='/v1/result'&&req.method==='GET'){json(res,200,view(r));return true}
    const m=/^\/v1\/result\/artifacts\/([0-9]+)$/.exec(path);if(m&&req.method==='GET'){const a=await manager.artifact(r.owner,r.jobId,m[1]);res.writeHead(200,{'content-type':a.type,'content-disposition':'attachment','cache-control':'no-store','x-content-type-options':'nosniff'});res.end(a.bytes);return true}throw fail('NOT_FOUND',404);
   }
   if(!equal(token,serviceToken))throw fail('UNAUTHORIZED',401);
   const b=req.method==='POST'?await body(req):{};
   if(path==='/v1/integration/tasks'&&req.method==='POST'){
    if(Object.keys(b).some(k=>!['ownerId','requestId','task','url'].includes(k))||typeof b.task!=='string'||!b.task.trim()||b.task.length>16000||typeof b.url!=='string'||b.url.length>2048)throw fail('INVALID_TASK');
    let target;try{target=new URL(b.url)}catch{throw fail('INVALID_URL')}if(!['http:','https:'].includes(target.protocol)||target.username||target.password)throw fail('INVALID_URL');await validateTarget(target.href);
    const ident=identity(b.ownerId,b.requestId),input={task:b.task,url:target.href,publicOnly:true,profile:'legacy-'+hash(target.origin).slice(0,24)},fingerprint=hash(JSON.stringify(input));
    const out=await serial(async()=>{let r=records.get(ident.key);if(r&&r.fingerprint!==fingerprint)throw fail('REQUEST_CONFLICT',409);if(!r){r={...ident,requestId:b.requestId,input,fingerprint,status:'queued',createdAt:now()};records.set(r.key,r);await save(r)}await refresh(r);return response(r)});json(res,202,out);return true;
   }
   const m=/^\/v1\/integration\/tasks\/([-a-zA-Z0-9_]{1,128})(?:\/(cancel|result-link))?$/.exec(path);
   if(m){const out=await serial(async()=>{const r=owned(req.method==='GET'?url.searchParams.get('ownerId'):b.ownerId,m[1]);if(req.method==='GET'&&!m[2]){await refresh(r);return response(r)}if(req.method==='POST'&&m[2]==='cancel'){if(r.status==='needs_authorization'){r.status='cancelled';delete r.error}else if(r.jobId){const j=await manager.cancel(r.owner,r.jobId);r.status=j.status;r.job=publicJob(j)}else if(['queued','needs_authorization'].includes(r.status))r.status='cancelled';if(r.status==='needs_authorization')r.status='cancelled';authLinks.delete(r.key);delete r.cap;await save(r);for(const [k,s]of sessions)if(s.key===r.key)sessions.delete(k);return view(r)}if(req.method==='POST'&&m[2]==='result-link'&&r.status==='succeeded')return {resultUrl:await link(r)};throw fail('NOT_FOUND',404)});json(res,200,out);return true}
   throw fail('NOT_FOUND',404);
  }catch(e){json(res,e.status||500,{error:{code:e.status?e.code:'INTERNAL_ERROR'}});return true}
 }};
}
