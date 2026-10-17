import { fork } from 'node:child_process';
import { randomUUID, randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { ProfileStore, profileDescriptor } from './profile-store.mjs';
import { stopService, serviceExited } from './service-process.mjs';

export function createLoginManager({capacity,dataDir,allowedOrigins=['https://ticktick.com','https://www.ticktick.com'],ttlMs=600000}) {
 const sessions=new Map(), profileDir=join(dataDir,'profiles'),store=new ProfileStore(profileDir);
 let closing=false;
 function descriptor(body){const url=new URL(body?.url);if(url.username||url.password||!allowedOrigins.includes(url.origin))throw Error('INVALID_LOGIN_URL');return {url:url.href,profile:profileDescriptor({name:body.profile,origin:url.origin})};}
 async function start(){
  const token=randomBytes(32).toString('hex');const child=fork(new URL('./browser-server.mjs',import.meta.url),[],{env:{...process.env,COKE_BROWSER_TOKEN:token,COKE_PROFILE_ROOT:profileDir,COKE_BROWSER_HEADLESS:'1',COKE_BROWSER_READ_ONLY:'0'},stdio:['ignore','ignore','ignore','ipc']});
  const port=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('BROWSER_START_FAILED')),15000);timer.unref();const fail=()=>{clearTimeout(timer);reject(Error('BROWSER_START_FAILED'));};child.once('error',fail);child.once('exit',fail);child.on('message',m=>{if(m.type==='ready'){clearTimeout(timer);resolve(m.port);}});}).catch(async error=>{await stopService(child);throw error;});
  return {child,async request(path,args){const response=await fetch(`http://127.0.0.1:${port}${path}`,{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify(args),signal:AbortSignal.timeout(15000)});const data=await response.json();if(!response.ok)throw Error(data.error?.code||'BROWSER_FAILED');return data;}};
 }
 async function finish(session,save){
  if(session.ended)throw Error('LOGIN_NOT_FOUND');session.ended=true;clearTimeout(session.timer);sessions.delete(session.id);
  try {const result=await session.service.request('/release',{...session.identity,saveProfile:save});if(save&&!result.profileSaved)throw Error('PROFILE_REVOKED');return {id:session.id,status:save?'saved':'cancelled'};}
  finally{await stopService(session.service.child);session.release();}
 }
 const view=async s=>({id:s.id,status:'active',expiresAt:s.expiresAt,...await s.service.request('/handoff',{...s.identity,action:'screenshot'})});
 return {
  async handle({method,path,userId,body={}}){
   try {
    if(closing)throw Error('SERVICE_CLOSING');
    if(method==='POST'&&path==='/v1/profiles/revoke'){const {profile}=descriptor(body);await store.revoke(userId,profile);return {status:200,body:{revoked:true}};}
    if(method==='POST'&&path==='/v1/logins'){
     const {url,profile}=descriptor(body),id=randomUUID();const releaseSlot=capacity.claimSlot(userId,'login',id);let released=false;const release=()=>{if(!released){released=true;releaseSlot();}};let service;
     try {service=await start();service.child.once('exit',()=>{const stale=sessions.get(id);if(stale){stale.ended=true;clearTimeout(stale.timer);sessions.delete(id);}release();});if(serviceExited(service.child))throw Error('BROWSER_START_FAILED');if(closing)throw Error('SERVICE_CLOSING');const acquired=await service.request('/acquire',{userId,taskId:id,profile,vault:body.silent===true});const identity={userId,taskId:id,leaseId:acquired.leaseId};await service.request('/action',{...identity,action:'navigate',url});const s={id,userId,identity,service,release,silent:body.silent===true,authenticated:false,expiresAt:new Date(Date.now()+ttlMs).toISOString()};if(serviceExited(service.child))throw Error('BROWSER_START_FAILED');sessions.set(id,s);s.timer=setTimeout(()=>void finish(s,false).catch(()=>{}),ttlMs);s.timer.unref();const output=s.silent?{id:s.id,status:'login_required',expiresAt:s.expiresAt}:await view(s);if(s.ended)throw Error('LOGIN_NOT_FOUND');return {status:201,body:output};}
     catch(error){const stale=sessions.get(id);if(stale){clearTimeout(stale.timer);sessions.delete(id);}if(service)await stopService(service.child);release();throw error;}
    }
    const match=path.match(/^\/v1\/logins\/([^/]+)(?:\/(input|confirm|cancel|vault))?$/);if(!match)return {status:404,body:{error:{code:'NOT_FOUND'}}};const s=sessions.get(match[1]);if(!s||s.userId!==userId)throw Error('LOGIN_NOT_FOUND');
    if(s.silent&&((method==='GET'&&!match[2])||match[2]==='input'))throw Error('LOGIN_NOT_FOUND');
    if(method==='POST'&&match[2]==='vault'){
     if(!s.silent)throw Error('LOGIN_NOT_FOUND');
     if(!['login','code','status'].includes(body.action)||Object.keys(body).some(k=>!['action','email','password','code'].includes(k)))throw Error('INVALID_INPUT');
     const output=await s.service.request('/vault',{...body,...s.identity});
     if(!['authenticated','invalid_credentials','code_required','verification_required','pending','login_required'].includes(output.status))throw Error('LOGIN_FAILED');
     s.authenticated=output.status==='authenticated';return {status:200,body:{status:output.status}};
    }
    if(method==='POST'&&match[2]==='confirm'&&s.silent&&!s.authenticated)throw Error('LOGIN_NOT_AUTHENTICATED');
    if(method==='GET'&&!match[2])return {status:200,body:await view(s)};
    if(method==='POST'&&match[2]==='input'){const output=await s.service.request('/handoff',{...body,...s.identity});return {status:200,body:{id:s.id,...output}};}
    if(method==='POST'&&['confirm','cancel'].includes(match[2]))return {status:200,body:await finish(s,match[2]==='confirm')};
    return {status:405,body:{error:{code:'METHOD_NOT_ALLOWED'}}};
   }catch(error){const code=['INVALID_LOGIN_URL','INVALID_PROFILE','INVALID_PROFILE_ORIGIN','INVALID_INPUT','CAPACITY_BUSY','LOGIN_NOT_FOUND','LOGIN_NOT_AUTHENTICATED','PROFILE_REVOKED','PROFILE_BUSY','SERVICE_CLOSING'].includes(error.message)?error.message:'LOGIN_FAILED';return {status:code==='LOGIN_NOT_FOUND'?404:['CAPACITY_BUSY','PROFILE_REVOKED','PROFILE_BUSY','LOGIN_NOT_AUTHENTICATED'].includes(code)?409:code.startsWith('INVALID')?400:503,body:{error:{code}}};}
  },
  async close(){closing=true;await Promise.allSettled([...sessions.values()].map(s=>finish(s,false)));}
 };
}
