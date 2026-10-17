'use strict';
const $=id=>document.getElementById(id);let token='',loginId='',taskId='',poll;
function status(text){$('status').textContent=text;}
async function api(path,body,method=body===undefined?'GET':'POST'){
 if(!token)throw Error('请先输入访问令牌并连接');
 const response=await fetch(path,{method,headers:{Authorization:`Bearer ${token}`,...(body!==undefined?{'Content-Type':'application/json'}:{})},...(body!==undefined?{body:JSON.stringify(body)}:{})});
 const data=await response.json();if(!response.ok)throw Error(data.error?.code||`HTTP ${response.status}`);return data;
}
function act(fn){return async()=>{try{await fn();}catch(error){status(error.message);}};}
function picture(data){if(data.pngBase64){$('screen').src=`data:image/png;base64,${data.pngBase64}`;$('screen').hidden=false;$('screen').dataset.width=data.width;$('screen').dataset.height=data.height;}}
const loginPath=()=>{if(!loginId)throw Error('请先打开登录页面');return `/v1/logins/${loginId}`;};
const input=async action=>picture(await api(loginPath()+'/input',action));
$('connect').onclick=act(async()=>{token=$('token').value;$('token').value='';await api('/v1/session');status('已连接');});
$('start').onclick=act(async()=>{const data=await api('/v1/logins',{url:$('url').value,profile:$('profile').value});loginId=data.id;picture(data);status('浏览器已打开。完成登录后请确认保存。');});
$('refresh').onclick=act(async()=>picture(await api(loginPath())));
$('screen').onclick=async event=>{try{const box=event.target.getBoundingClientRect();await input({action:'click',x:Math.min(Number(event.target.dataset.width)-1,Math.floor((event.clientX-box.left)*Number(event.target.dataset.width)/box.width)),y:Math.min(Number(event.target.dataset.height)-1,Math.floor((event.clientY-box.top)*Number(event.target.dataset.height)/box.height))});}catch(error){status(error.message);}};
$('type').onclick=act(async()=>{const text=$('typing').value;$('typing').value='';await input({action:'type',text});});
for(const button of document.querySelectorAll('[data-key]'))button.onclick=act(()=>input({action:'press',key:button.dataset.key}));
$('up').onclick=act(()=>input({action:'scroll',deltaY:-600}));$('down').onclick=act(()=>input({action:'scroll',deltaY:600}));
$('save').onclick=act(async()=>{await api(loginPath()+'/confirm',{});loginId='';$('screen').hidden=true;$('screen').removeAttribute('src');status('登录状态已加密保存');});
$('cancelLogin').onclick=act(async()=>{await api(loginPath()+'/cancel',{});loginId='';$('screen').hidden=true;$('screen').removeAttribute('src');status('登录已取消，未保存');});
$('revoke').onclick=act(async()=>{await api('/v1/profiles/revoke',{url:$('url').value,profile:$('profile').value});status('已撤销保存的登录状态');});
async function updateTask(){const data=await api(`/v1/tasks/${taskId}`);$('result').textContent=JSON.stringify(data,null,2);$('artifacts').replaceChildren();for(const artifact of data.artifacts||[]){const button=document.createElement('button');button.textContent=`下载 ${artifact.name}`;button.onclick=act(async()=>{const response=await fetch(`/v1/tasks/${taskId}/artifacts/${encodeURIComponent(artifact.id)}`,{headers:{Authorization:`Bearer ${token}`}});if(!response.ok)throw Error('下载失败');const url=URL.createObjectURL(await response.blob());const a=document.createElement('a');a.href=url;a.download=artifact.name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);});$('artifacts').append(button);}if(['succeeded','failed','cancelled','completed','interrupted'].includes(data.status)){clearInterval(poll);status(data.status==='succeeded'?'任务完成，报告可在下方下载。':data.status==='failed'?`任务未完成：${({PAGE_NOT_READY:'页面仍在加载，请稍后重试',BROWSER_NAVIGATION_TIMEOUT:'网站打开超时，请稍后重试',BROWSER_NAVIGATION_FAILED:'暂时无法打开网站',BROWSER_GATEWAY_TIMEOUT:'浏览器操作超时，本次任务已停止',BROWSER_GATEWAY_UNAVAILABLE:'浏览器连接中断，本次任务已停止',BROWSER_GATEWAY_REVOKED:'浏览器授权已结束，本次任务已停止',REMOTE_CLI_FAILED:'远程浏览器执行失败',MODEL_UNVERIFIED_REPORT:'报告引用未通过校验',MODEL_INVALID_RESPONSE:'模型响应不符合要求',MODEL_STEP_LIMIT:'已达到执行步数上限',MODEL_TIMEOUT:'模型响应超时'})[data.errorCode]||data.errorCode||'执行失败'}`:`任务状态：${data.status}`);}}
$('run').onclick=act(async()=>{const data=await api('/v1/tasks',{task:$('task').value,url:$('url').value,profile:$('profile').value});taskId=data.id;status('Agent 正在执行任务，完成后可下载报告。');clearInterval(poll);await updateTask();poll=setInterval(()=>updateTask().catch(error=>{clearInterval(poll);status(error.message);}),2000);});
$('cancelTask').onclick=act(async()=>{if(!taskId)throw Error('没有运行中的任务');await api(`/v1/tasks/${taskId}/cancel`,{});await updateTask();});

$('createLink').onclick=act(async()=>{const data=await api('/v1/login-links',{task:$('task').value,url:$('url').value,profile:$('profile').value});const a=document.createElement('a');a.href=location.origin+'/login#'+data.secret;a.textContent='打开凭证授权表单（10 分钟有效）';a.rel='noreferrer';$('loginLink').replaceChildren(a);status('链接只能兑换一次。提交凭证后会后台登录并继续指定任务。');});
