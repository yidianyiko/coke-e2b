// Trusted backend only. Never return browser text, selectors, response bodies or secrets.
const guarded = new WeakMap();
const CODE = 'input[name="code"][autocomplete="one-time-code"][placeholder="Verification Code"],input[name="code"][autocomplete="one-time-code"][placeholder="Code"]';
const out = status => ({status});
function validOrigin(origin,fixture){
 try{const u=new URL(origin);return u.origin===origin&&(fixture===true?u.protocol==='http:'&&u.hostname==='127.0.0.1':['https://ticktick.com','https://www.ticktick.com'].includes(origin))}catch{return false}
}
async function sameOrigin(page,origin){try{return new URL(page.url()).origin===origin}catch{return false}}
async function inspect(page,origin){
 if(!await sameOrigin(page,origin))return 'verification_required';
 if(/^\/webapp(?:\/|$)/.test(new URL(page.url()).pathname)&&guarded.get(page.context())?.authenticatedPages.has(page))return 'authenticated';
 try{return await page.evaluate(code=>{
  const s=window.SiteStatus;
  if(s?.isLogin===true&&typeof s.userCode==='string'&&s.userCode.length>0)return 'authenticated';
  const visible=e=>!!e&&e.getClientRects().length>0;
  if([...document.querySelectorAll('iframe[src*="captcha"],iframe[title*="CAPTCHA"],iframe[src*="challenges.cloudflare.com"],input[name="captcha"]')].some(visible))return 'verification_required';
  if(visible(document.querySelector(code)))return 'code_required';
  if(visible(document.querySelector('input#password[name="password"][type="password"]')))return 'login_required';
  return 'pending';
 },CODE)}catch{return await sameOrigin(page,origin)?'pending':'verification_required'}
}
export async function prepareVaultContext(context,{origin,fixture=false}={}){
 if(!validOrigin(origin,fixture))throw new Error('VAULT_ORIGIN_REJECTED');
 let guard=guarded.get(context);
 if(guard&&guard.origin!==origin)throw new Error('VAULT_ORIGIN_REJECTED');
 if(!guard){
  guard={blocked:false,origin,secrets:new Set(),authenticatedPages:new WeakSet()};guarded.set(context,guard);
  guard.ready=(async()=>{
   const allowed=new Set([origin,...(fixture?[]:['https://api.ticktick.com'])]);
   // Retain until browser context closes, including delayed scripts after submission.
   await context.route('**/*',async route=>{
    let permitted=false;try{
     const request=route.request(),u=new URL(request.url());
     permitted=allowed.has(u.origin);
     // Public scripts verified in the site's signin HTML. No query, credentials or body.
     if(!permitted&&u.origin==='https://d107mjio2rjf74.cloudfront.net'&&u.pathname.startsWith('/web/static/')&&['GET','HEAD'].includes(request.method())&&!u.search&&!u.username&&!u.password&&!request.postData()){
      let decoded=u.pathname;try{decoded=decodeURIComponent(decoded)}catch{}
      permitted=![...guard.secrets].some(secret=>decoded.includes(secret)||u.href.includes(encodeURIComponent(secret)));
     }
    }catch{}
    if(!permitted){
     // Still abort telemetry; a blocked analytics request is not an authentication challenge.
     let telemetry=false;try{telemetry=['https://www.googletagmanager.com','https://xapi.ticktick.com','https://s.ticktick.com'].includes(new URL(route.request().url()).origin)}catch{}
     if(!telemetry)guard.blocked=true;return route.abort('blockedbyclient')
    }
    return route.continue();
   });
   await context.routeWebSocket('**/*',socket=>{guard.blocked=true;socket.close()});
   context.on('response',async response=>{
    try{
     const request=response.request(),u=new URL(response.url());
     if(request.method()!=='GET'||response.status()!==200||![origin,...(fixture?[]:['https://api.ticktick.com'])].includes(u.origin)||!['/api/v2/user/profile','/api/v2/user/status'].includes(u.pathname)||u.search)return;
     const body=await response.json(),page=response.frame().page();
     if(response.frame()!==page.mainFrame()||!await sameOrigin(page,origin))return;
     if(typeof body?.userCode==='string'&&body.userCode.length>0&&typeof body?.username==='string'&&body.username.length>0)guard.authenticatedPages.add(page);
    }catch{}
   });
  })();
 }
 await guard.ready;
}
export async function vaultBrowserAction(page,input,{origin,fixture=false}={}){
 if(!validOrigin(origin,fixture)||!['login','code','status'].includes(input?.action))return out('verification_required');
 try{
  const actionDeadline=Date.now()+11000;
  if(!await sameOrigin(page,origin))return out('verification_required');
  const context=page.context();
  await prepareVaultContext(context,{origin,fixture});
  const guard=guarded.get(context);
  if(guard.origin!==origin)return out('verification_required');
  for(const value of [input.email,input.password,input.code])if(typeof value==='string'&&value)guard.secrets.add(value);
  let initial=await inspect(page,origin);
  // Navigation commits before the signin application's scripts render the form.
  // Keep this request alive so credentials are filled once readiness is known.
  if(input.action==='login'&&initial==='pending'){
   const readyDeadline=Date.now()+6500;
   while(initial==='pending'&&Date.now()<readyDeadline){
    await new Promise(r=>setTimeout(r,50));
    initial=await inspect(page,origin);
   }
  }
  if(input.action==='status'||initial==='authenticated'||initial==='verification_required')return out(initial);
  if(input.action==='login'){
   if(initial!=='login_required')return out(initial);
   if(typeof input.email!=='string'||!input.email||input.email.length>320||typeof input.password!=='string'||!input.password||input.password.length>4096)return out('invalid_credentials');
   if(!await sameOrigin(page,origin))return out('verification_required');
   await page.locator('input[placeholder="Email"]').fill(input.email,{timeout:1500});
   if(!await sameOrigin(page,origin))return out('verification_required');
   await page.locator('input#password[name="password"][type="password"]').fill(input.password,{timeout:1500});
  }else{
   if(initial!=='code_required')return out(initial);
   if(typeof input.code!=='string'||!/^\d{4,10}$/.test(input.code))return out('code_required');
   if(!await sameOrigin(page,origin))return out('verification_required');
   await page.locator(CODE).fill(input.code,{timeout:1500});
  }
  let responseState;
  const observe=async response=>{
   try{
    const u=new URL(response.url());if(![origin,...(fixture?[]:['https://api.ticktick.com'])].includes(u.origin)||u.pathname!=='/api/v2/user/signon')return;
    const body=await response.json();
    if(['username_not_exist','username_password_not_match'].includes(body?.errorCode))responseState='invalid_credentials';
    else if(['captcha_wrong','need_captcha','incorrect_password_too_many_times'].includes(body?.errorCode))responseState='verification_required';
    // authId denotes MFA, never successful authentication. Wait for the known code UI.
   }catch{}
  };
  page.on('response',observe);
  try{
   if(!await sameOrigin(page,origin))return out('verification_required');
   await page.getByRole('button',{name:input.action==='login'?'Sign In':'Verification',exact:true}).click({timeout:1500,noWaitAfter:true});
   const deadline=Math.min(Date.now()+6500,actionDeadline);
   while(Date.now()<deadline){
    if(responseState)return out(responseState);
    const state=await inspect(page,origin);
    if(['authenticated','code_required','verification_required'].includes(state)){
     if(input.action==='code'&&state==='code_required'){await new Promise(r=>setTimeout(r,50));continue}
     return out(state);
    }
    await new Promise(r=>setTimeout(r,50));
   }
   return out(guard.blocked?'verification_required':'pending');
  }finally{page.off('response',observe)}
 }catch{return out('verification_required')}
}
