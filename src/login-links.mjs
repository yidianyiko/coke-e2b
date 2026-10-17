import {randomBytes,createHash} from 'node:crypto';
const fail=code=>{throw Object.assign(new Error(code),{code})};
const hash=s=>createHash('sha256').update(s).digest('hex');
export function createLoginLinks({loginManager,manager,now=Date.now,linkTtlMs=600000,sessionTtlMs=1200000,sweepIntervalMs=10000}){
 const links=new Map(),sessions=new Map();let closing=false;
 async function discard(s){sessions.delete(s.key);if(s.loginId&&!s.saved)await loginManager.handle({method:'POST',path:`/v1/logins/${s.loginId}/cancel`,userId:s.userId,body:{}});}
 async function sweep(){const time=now();for(const [k,l]of links)if(l.expiresAt<=time)links.delete(k);for(const s of sessions.values())if(s.expiresAt<=time&&!s.pending)await discard(s);}
 const timer=setInterval(()=>void sweep().catch(()=>{}),sweepIntervalMs);timer.unref();
 function session(token){const s=typeof token==='string'&&sessions.get(hash(token));if(closing||!s||s.expiresAt<=now())fail('LINK_NOT_FOUND');return s;}
 async function login(s,action,body){const result=await loginManager.handle({method:action==='view'?'GET':'POST',path:action==='start'?'/v1/logins':`/v1/logins/${s.loginId}${action==='view'?'':'/'+action}`,userId:s.userId,body});if(result.status>=400)fail(result.body.error.code);return result.body;}
 return {
  create(userId,input){if(closing)fail('LINK_NOT_FOUND');for(const[k,l]of links)if(l.expiresAt<=now())links.delete(k);if(links.size+sessions.size>=100)fail('CAPACITY_BUSY');const secret=randomBytes(32).toString('base64url');const expiresAt=now()+linkTtlMs;links.set(hash(secret),{userId,input:{...input},expiresAt});return {secret,expiresAt};},
  async exchange(secret){if(typeof secret!=='string'||secret.length>128||closing)fail('LINK_NOT_FOUND');const key=hash(secret),l=links.get(key);if(!l||l.expiresAt<=now())fail('LINK_NOT_FOUND');links.delete(key);const token=randomBytes(32).toString('base64url'),expiresAt=now()+sessionTtlMs;sessions.set(hash(token),{...l,key:hash(token),expiresAt});return {token,expiresAt,url:l.input.url,task:l.input.task};},
  async handle(token,method,action,body={}){const s=session(token);
   if(method==='POST'&&action==='input'){if(!s.loginId||s.saved)fail('LINK_NOT_FOUND');if(Object.keys(body).some(k=>!['action','x','y','text','key','deltaY'].includes(k)))fail('INVALID_INPUT');return login(s,'input',body);}
   if(method==='GET'&&action==='view'){if(!s.loginId||s.saved)fail('LINK_NOT_FOUND');return login(s,'view',{});}
   if(method==='GET'&&action==='task'){if(!s.task)fail('TASK_NOT_FOUND');return manager.get(s.userId,s.task.id);}
   const artifact=/^artifacts\/([0-9]+)$/.exec(action);if(method==='GET'&&artifact){if(!s.task)fail('TASK_NOT_FOUND');return manager.artifact(s.userId,s.task.id,artifact[1]);}
   if(method!=='POST'||!['start','confirm','cancel'].includes(action))fail('NOT_FOUND');
   if(Object.keys(body).length)fail('INVALID_BODY');
   if(s.pending){if(s.operation===action)return s.pending;fail('CAPACITY_BUSY');}
   s.operation=action;s.pending=(async()=>{
    if(action==='start'){if(s.saved)fail('LINK_NOT_FOUND');if(s.loginId)return login(s,'view',{});const out=await login(s,'start',{url:s.input.url,profile:s.input.profile});s.loginId=out.id;return out;}
    if(action==='cancel'){if(s.saved)fail('LINK_NOT_FOUND');await discard(s);return {status:'cancelled'};}
    if(s.task)return {status:'saved',task:s.task};if(!s.loginId)fail('LINK_NOT_FOUND');if(!s.saved){await login(s,'confirm',{});s.saved=true;}s.task=await manager.submit(s.userId,s.input);return {status:'saved',task:s.task};
   })();try{return await s.pending;}finally{s.pending=undefined;s.operation=undefined;}
  },
  async close(){closing=true;clearInterval(timer);await Promise.allSettled([...sessions.values()].map(async s=>{await s.pending?.catch(()=>{});await discard(s)}));links.clear();}
 };
}
