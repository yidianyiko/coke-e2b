import {mkdtemp,rm,mkdir} from 'node:fs/promises';
import {tmpdir,homedir} from 'node:os';
import {join} from 'node:path';
import assert from 'node:assert/strict';
import {chromium} from 'playwright-core';
import {createIntegrationService} from '../src/integration-service.mjs';
import {createOnlineServer} from '../src/online-server.mjs';
const dir=await mkdtemp(join(tmpdir(),'coke-result-ui-'));
const downloadsRoot=join(homedir(),'Downloads');await mkdir(downloadsRoot,{recursive:true});const downloads=await mkdtemp(join(downloadsRoot,'coke-accept-'));
let service,browser;
const manager={async submit(){return{id:'fixture-job',status:'succeeded',result:{value:'Verified fixture text <script>unsafe()</script>'},artifacts:[{id:'0',name:'report.txt',type:'text/plain'}]}},async artifact(){return{bytes:Buffer.from('Verified fixture report'),type:'text/plain'}}};
const server=createOnlineServer({manager,tokens:[],integrationService:{handle:(req,res)=>service.handle(req,res)}});
try{
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const base=`http://127.0.0.1:${server.address().port}`;
 service=await createIntegrationService({manager,dataDir:dir,serviceToken:'fixture-service-token-only-123456',publicBaseUrl:base});
 const response=await fetch(base+'/v1/integration/tasks',{method:'POST',headers:{authorization:'Bearer fixture-service-token-only-123456','content-type':'application/json'},body:JSON.stringify({ownerId:'fixture-user',requestId:'ui-flow',task:'read',url:'https://example.com'})});
 assert.equal(response.status,202);const job=await response.json();
 browser=await chromium.launch({executablePath:process.env.COKE_CHROMIUM_PATH||'/usr/bin/chromium-browser',headless:true,downloadsPath:downloads,args:['--no-sandbox']});
 const page=await browser.newPage({acceptDownloads:true});const errors=[];page.on('pageerror',error=>errors.push(error.message));
 await page.goto(job.resultUrl);
 await page.getByText('Verified fixture text <script>unsafe()</script>',{exact:true}).waitFor();
 assert.equal(new URL(page.url()).hash,'');assert.deepEqual(errors,[]);
 const downloadPromise=page.waitForEvent('download');await page.getByRole('button',{name:'下载 report.txt'}).click();
 const download=await downloadPromise;assert.equal(download.suggestedFilename(),'report.txt');
 assert.equal(await download.failure(),null);await download.saveAs(join(dir,'downloaded-report.txt'));const {readFile}=await import('node:fs/promises');assert.equal(await readFile(join(dir,'downloaded-report.txt'),'utf8'),'Verified fixture report');
 console.log(JSON.stringify({status:'passed',entry:'online server result link',fragmentRemoved:true,textEscaped:true,downloadVerified:true}));
}finally{await browser?.close();server.closeAllConnections();await new Promise(r=>server.close(r));await rm(dir,{recursive:true,force:true});await rm(downloads,{recursive:true,force:true})}
