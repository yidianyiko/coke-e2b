import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, stat, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { VaultStore } from '../src/vault-store.mjs';
const descriptor = { name: 'ticktick', origin: 'https://ticktick.com' };
const credentials = { email: 'private@example.com', password: 'vault-password-secret' };
async function fixture(t) { const root = await mkdtemp(join(tmpdir(), 'coke-vault-')); t.after(() => rm(root, { recursive: true, force: true })); return { root, store: new VaultStore(root) }; }
test('Vault encrypts credentials and exposes metadata and trusted fill only', async t => {
 const {root,store}=await fixture(t);
 assert.equal(await store.metadata('alice',descriptor),null);
 assert.deepEqual(await store.set('alice',descriptor,credentials),{...descriptor,fields:['email','password']});
 assert.deepEqual(await store.metadata('alice',descriptor),{...descriptor,fields:['email','password']});
 assert.deepEqual(await store.fill('alice',descriptor, value => value),credentials);
 assert.equal(store.get,undefined);
 for(const name of await readdir(root)) { const path=join(root,name); if((await stat(path)).isFile()) { const bytes=await readFile(path); assert.ok(!bytes.includes(Buffer.from(credentials.password))); assert.ok(!bytes.includes(Buffer.from(credentials.email))); assert.equal((await stat(path)).mode&0o777,0o600); } }
 assert.equal((await stat(root)).mode&0o777,0o700);
 assert.deepEqual(await store.delete('alice',descriptor),{deleted:true});
 assert.deepEqual(await store.delete('alice',descriptor),{deleted:false});
 await assert.rejects(store.fill('alice',descriptor,()=>{}),/VAULT_NOT_FOUND/);
});
test('Vault identity binding rejects swapped and modified ciphertext without leaking values', async t => {
 const {root,store}=await fixture(t);
 await store.set('alice',descriptor,credentials);
 assert.equal(await store.metadata('bob',descriptor),null);
 assert.equal(await store.metadata('alice',{...descriptor,origin:'https://www.ticktick.com'}),null);
 const first=(await readdir(root)).find(name=>name.endsWith('.enc'));
 const original=await readFile(join(root,first));
 await store.set('bob',descriptor,{email:'other@example.com',password:'other-secret'});
 const second=(await readdir(root)).find(name=>name.endsWith('.enc')&&name!==first);
 await writeFile(join(root,second),original);
 await assert.rejects(store.fill('bob',descriptor,()=>assert.fail('must not fill')),{message:'VAULT_DECRYPT_FAILED'});
 const envelope=JSON.parse(original); envelope.data=Buffer.from('tampered').toString('base64');
 await writeFile(join(root,first),JSON.stringify(envelope));
 await assert.rejects(store.metadata('alice',descriptor),{message:'VAULT_DECRYPT_FAILED'});
});
test('Concurrent instances initialize one key and entry locks order fill and deletion', async t => {
 const {root}=await fixture(t);
 const stores=Array.from({length:12},()=>new VaultStore(root));
 await Promise.all(stores.map((store,index)=>store.set(`user-${index}`,descriptor,credentials)));
 assert.equal((await readFile(join(root,'.key'))).length,32);
 for(let index=0;index<stores.length;index++) assert.deepEqual(await stores[index].fill(`user-${index}`,descriptor,value=>value),credentials);
 let entered; const entry=new Promise(done=>entered=done); let release; const gate=new Promise(done=>release=done);
 const fill=stores[0].fill('user-0',descriptor,async()=>{entered();await gate;return 'filled';});
 await entry;
 let deleted=false; const deletion=stores[1].delete('user-0',descriptor).then(value=>{deleted=true;return value;});
 await new Promise(done=>setTimeout(done,50)); assert.equal(deleted,false);
 release(); assert.equal(await fill,'filled'); assert.deepEqual(await deletion,{deleted:true});
 assert.equal((await readdir(root)).filter(name=>name.endsWith('.lock')||name.endsWith('.tmp')||name.startsWith('.key-')).length,0);
});
test('Vault rejects invalid identities and sanitizes callback errors', async t => {
 const {store}=await fixture(t);
 for(const user of ['',null,'a\nsecret']) await assert.rejects(store.set(user,descriptor,credentials),/INVALID_VAULT_USER/);
 for(const origin of ['http://ticktick.com','https://ticktick.com/path','https://u:p@ticktick.com','broken']) await assert.rejects(store.set('alice',{...descriptor,origin},credentials),/INVALID_VAULT_DESCRIPTOR/);
 await assert.rejects(store.set('alice',{...descriptor,name:'../secret'},credentials),/INVALID_VAULT_DESCRIPTOR/);
 await store.set('alice',descriptor,credentials);
 await assert.rejects(store.fill('alice',descriptor, value=>{throw new Error(value.password);}),{message:'VAULT_FILL_FAILED'});
});

test('Separate processes share atomic key publication and entry locks', async t => {
 const {root,store}=await fixture(t);
 const moduleUrl=new URL('../src/vault-store.mjs',import.meta.url).href;
 const run=index=>new Promise((resolve,reject)=>{
  const source=`import { VaultStore } from ${JSON.stringify(moduleUrl)}; const store=new VaultStore(process.argv[1]); await store.set('shared',{name:'ticktick',origin:'https://ticktick.com'},{email:'user-'+process.argv[2]+'@example.com',password:'parallel-password'});`;
  const child=spawn(process.execPath,['--input-type=module','-e',source,root,String(index)],{stdio:['ignore','ignore','pipe']});
  let stderr=''; child.stderr.on('data',chunk=>stderr+=chunk); child.once('error',reject); child.once('exit',code=>code===0?resolve():reject(new Error(stderr)));
 });
 await Promise.all(Array.from({length:8},(_,index)=>run(index)));
 const filled=await store.fill('shared',descriptor,value=>value);
 assert.match(filled.email,/^user-[0-7]@example\.com$/); assert.equal(filled.password,'parallel-password');
 assert.equal((await readdir(root)).filter(name=>name.endsWith('.enc')).length,1);
});
