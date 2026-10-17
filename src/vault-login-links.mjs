import {randomBytes,createHash} from 'node:crypto';
const fail=code=>{throw Object.assign(new Error(code),{code})};
const hash=s=>createHash('sha256').update(s).digest('hex');
const publicStates=new Set(['authenticated','invalid_credentials','code_required','verification_required','pending','login_required']);
export function createVaultLoginLinks({vault,loginManager,manager,now=Date.now,linkTtlMs=600000,sessionTtlMs=1200000,sweepIntervalMs=10000,fixtureOrigin}){
 if(fixtureOrigin&&!(new URL(fixtureOrigin).origin===fixtureOrigin&&new URL(fixtureOrigin).protocol==='http:'&&new URL(fixtureOrigin).hostname==='127.0.0.1'))fail('INVALID_LOGIN_URL');
 const links=new Map(),sessions=new Map();let closing=false;
 const descriptor=s=>({name:s.input.profile,origin:new URL(s.input.url).origin});
 async function login(s,action,body={}){const result=await loginManager.handle({method:'POST',path:action==='start'?'/v1/logins':`/v1/logins/${s.loginId}/${action}`,userId:s.userId,body});if(result.status>=400)fail(result.body.error.code);return result.body;}
 async function discard(s){sessions.delete(s.key);if(s.loginId&&!s.saved)await login(s,'cancel').catch(()=>{});}
 async function sweep(){for(const[k,l]of links)if(l.expiresAt<=now())links.delete(k);for(const s of sessions.values())if(s.expiresAt<=now()&&!s.pending)await discard(s);}
 const timer=setInterval(()=>void sweep().catch(()=>{}),sweepIntervalMs);timer.unref();
 function session(token){const s=typeof token==='string'&&sessions.get(hash(token));if(closing||!s||s.expiresAt<=now())fail('LINK_NOT_FOUND');return s;}
 function view(s){return {status:s.pending?'working':s.status||'credentials_required',hasCredentials:!!s.hasCredentials,...(s.task?{task:s.task}:{})};}
 async function resume(s){if(closing)fail('SERVICE_CLOSING');if(s.task)return view(s);if(!s.saved){await login(s,'confirm');s.saved=true;}if(closing)fail('SERVICE_CLOSING');s.task=await (s.submit||manager.submit)(s.userId,s.input);s.status='running';return {status:s.status,hasCredentials:true,task:s.task};}
 async function apply(s,result){if(closing)fail('SERVICE_CLOSING');if(!publicStates.has(result.status))fail('LOGIN_FAILED');s.status=result.status;if(s.status==='authenticated')return resume(s);return {status:s.status,hasCredentials:!!s.hasCredentials};}
 return {
  create(userId,input,{submit}={}){let u;try{u=new URL(input.url)}catch{fail('INVALID_LOGIN_URL')}if(!['https://ticktick.com','https://www.ticktick.com',...(fixtureOrigin?[fixtureOrigin]:[])].includes(u.origin)||u.pathname!=='/signin'||u.search||u.hash||u.username||u.password||!/^[a-zA-Z0-9_-]{1,64}$/.test(input.profile)||typeof input.task!=='string'||!input.task.trim())fail('INVALID_LOGIN_URL');if(closing)fail('LINK_NOT_FOUND');for(const[k,l]of links)if(l.expiresAt<=now())links.delete(k);if(links.size+sessions.size>=100)fail('CAPACITY_BUSY');const secret=randomBytes(32).toString('base64url'),expiresAt=now()+linkTtlMs;links.set(hash(secret),{userId,submit,input:{task:input.task,url:u.href,profile:input.profile},expiresAt});return {secret,expiresAt};},
  async exchange(secret){if(typeof secret!=='string'||secret.length>128||closing)fail('LINK_NOT_FOUND');const key=hash(secret),l=links.get(key);if(!l||l.expiresAt<=now())fail('LINK_NOT_FOUND');links.delete(key);const token=randomBytes(32).toString('base64url'),s={...l,key:hash(token),expiresAt:now()+sessionTtlMs,status:'credentials_required'};s.hasCredentials=!!await vault.metadata(s.userId,descriptor(s));sessions.set(s.key,s);return {token,expiresAt:s.expiresAt,url:s.input.url,task:s.input.task,hasCredentials:s.hasCredentials};},
  async handle(token,method,action,body={}){const s=session(token);
   if(method==='GET'&&action==='status')return view(s);
   if(method==='GET'&&action==='task'){if(!s.task)fail('TASK_NOT_FOUND');return manager.get(s.userId,s.task.id);}
   const artifact=/^artifacts\/([0-9]+)$/.exec(action);if(method==='GET'&&artifact){if(!s.task)fail('TASK_NOT_FOUND');return manager.artifact(s.userId,s.task.id,artifact[1]);}
   if(method!=='POST'||!['credentials','code','check','cancel','delete'].includes(action))fail('NOT_FOUND');
   if(action==='credentials'){if(body.useStored===true){if(Object.keys(body).some(k=>k!=='useStored'))fail('INVALID_CREDENTIALS');}else if(Object.keys(body).some(k=>!['email','password'].includes(k))||typeof body.email!=='string'||body.email.length>254||!/^\S+@\S+\.\S+$/.test(body.email)||typeof body.password!=='string'||!body.password||body.password.length>4096)fail('INVALID_CREDENTIALS');}
   else if(action==='code'){if(Object.keys(body).some(k=>k!=='code')||typeof body.code!=='string'||!/^\d{4,10}$/.test(body.code))fail('INVALID_CODE');}
   else if(Object.keys(body).length)fail('INVALID_BODY');
   if(s.pending){if(s.operation===action)return s.pending;fail('CAPACITY_BUSY');}
   s.operation=action;s.pending=(async()=>{
    if(action==='cancel'){if(s.saved)fail('LOGIN_ALREADY_SAVED');await discard(s);return {status:'cancelled'};}
    if(action==='delete'){if(s.task&&['running','queued'].includes((await manager.get(s.userId,s.task.id)).status))fail('CAPACITY_BUSY');if(s.loginId&&!s.saved)await login(s,'cancel').catch(()=>{});await vault.delete(s.userId,descriptor(s));const revoke=await loginManager.handle({method:'POST',path:'/v1/profiles/revoke',userId:s.userId,body:{url:s.input.url,profile:s.input.profile}});if(revoke.status>=400)fail(revoke.body.error.code);sessions.delete(s.key);return {status:'deleted'};}
    if(s.saved)return resume(s);
    if(action==='credentials'){
     if(body.useStored!==true){await vault.set(s.userId,descriptor(s),{email:body.email,password:body.password});s.hasCredentials=true;}
     if(closing)fail('SERVICE_CLOSING');if(!s.hasCredentials)fail('VAULT_NOT_FOUND');
     if(!s.loginId){const opened=await login(s,'start',{url:s.input.url,profile:s.input.profile,silent:true});s.loginId=opened.id;}
     if(closing)fail('SERVICE_CLOSING');const result=await vault.fill(s.userId,descriptor(s),credentials=>login(s,'vault',{action:'login',...credentials}));return apply(s,result);
    }
    if(!s.loginId)fail('LOGIN_NOT_FOUND');
    if(action==='code'&&s.status!=='code_required')fail('INVALID_CODE');
    return apply(s,await login(s,'vault',action==='code'?{action:'code',code:body.code}:{action:'status'}));
   })();try{return await s.pending;}finally{s.pending=undefined;s.operation=undefined;}
  },
  async close(){closing=true;clearInterval(timer);await Promise.allSettled([...sessions.values()].map(async s=>{await s.pending?.catch(()=>{});await discard(s)}));links.clear();}
 };
}
