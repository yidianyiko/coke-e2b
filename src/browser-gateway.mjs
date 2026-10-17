import {createHash} from 'node:crypto';
const fields={read:[],navigate:['url'],'click-link':['linkText'],'click-ref':['ref'],'fill-ref':['ref','value'],'current-url':[],extract:['selector'],screenshot:[]};
const digest=value=>createHash('sha256').update(value).digest('hex');
export function createBrowserGateway({now=Date.now}={}){
 const tasks=new Map();
 const reply=(res,status,body)=>{res.writeHead(status,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify(body))};
 return {
 register(scope){const key=digest(scope.token),entry={...scope,seen:new Set(),busy:false,controller:new AbortController()};tasks.set(key,entry);return()=>{if(tasks.get(key)===entry)tasks.delete(key);entry.controller.abort()}},
 async handle(req,res){
  if(req.url!=='/v1/browser/action')return reply(res,404,{error:{code:'NOT_FOUND'}});
  const presented=req.headers.authorization;const entry=typeof presented==='string'&&presented.startsWith('Bearer ')?tasks.get(digest(presented.slice(7))):undefined;
  if(!entry||entry.expiresAt<=now())return reply(res,401,{error:{code:'UNAUTHORIZED'}});
  if(req.method!=='POST'||!req.headers['content-type']?.startsWith('application/json'))return reply(res,400,{error:{code:'INVALID_REQUEST'}});
  try{
   let bytes=0;const chunks=[];for await(const chunk of req){bytes+=chunk.length;if(bytes>32768)return reply(res,413,{error:{code:'BODY_TOO_LARGE'}});chunks.push(chunk)}
   const body=JSON.parse(Buffer.concat(chunks).toString());
   if(!body||Array.isArray(body)||!Object.hasOwn(fields,body.action)||typeof body.requestId!=='string'||!/^[a-f0-9-]{36}$/.test(body.requestId)||Object.keys(body).some(k=>!['userId','taskId','leaseId','action','requestId',...fields[body.action]].includes(k)))return reply(res,400,{error:{code:'INVALID_REQUEST'}});
   if(body.userId!==entry.userId||body.taskId!==entry.taskId||body.leaseId!==entry.leaseId)return reply(res,403,{error:{code:'LEASE_FORBIDDEN'}});
   if(entry.controller.signal.aborted||entry.expiresAt<=now())return reply(res,401,{error:{code:'UNAUTHORIZED'}});
   if(entry.busy||entry.seen.has(body.requestId)||entry.seen.size>=256)return reply(res,409,{error:{code:'REQUEST_REPLAY_OR_BUSY'}});
   entry.seen.add(body.requestId);entry.busy=true;
   const timeoutSignal=AbortSignal.timeout(Math.max(1,Math.min(12000,entry.expiresAt-now())));
   try{
    const upstream=await fetch(`http://127.0.0.1:${entry.port}/action`,{method:'POST',headers:{authorization:`Bearer ${entry.browserToken}`,'content-type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.any([entry.controller.signal,timeoutSignal])});
    reply(res,upstream.status,await upstream.json());
   }catch{const code=entry.controller.signal.aborted?'BROWSER_GATEWAY_REVOKED':timeoutSignal.aborted?'BROWSER_GATEWAY_TIMEOUT':'BROWSER_GATEWAY_UNAVAILABLE';tasks.delete(digest(entry.token));entry.controller.abort();reply(res,502,{error:{code}})}finally{entry.busy=false}
  }catch{reply(res,400,{error:{code:'INVALID_REQUEST'}})}
 }
 };
}
