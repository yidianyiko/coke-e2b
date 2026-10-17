import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProfileStore } from '../src/profile-store.mjs';
test('encrypted user/site profile is private, scoped and cannot be revived after revoke', async () => {
 const root = await mkdtemp(join(tmpdir(), 'coke-profile-'));
 try {
  const store = new ProfileStore(root);
  const profile = { name: 'primary', origin: 'https://example.com' };
  const loaded = await store.load('alice', profile);
  const state = { cookies: [{ name: 'session', value: 'private-cookie-secret', domain: 'example.com', path: '/', expires: -1, httpOnly: true, secure: true, sameSite: 'Lax' }], origins: [{ origin: profile.origin, localStorage: [{name:'auth',value:'private-storage-secret'}] }] };
  await store.save('alice', profile, state, loaded.generation);
  assert.equal((await store.load('alice', profile)).state.cookies[0].value, 'private-cookie-secret');
  assert.equal((await store.load('bob', profile)).state.cookies.length, 0);
  const bytes = await readFile(store.path('alice', profile));
  assert.equal(bytes.includes(Buffer.from('private-cookie-secret')), false);
  assert.equal(bytes.includes(Buffer.from('private-storage-secret')), false);
  assert.equal((await stat(store.path('alice', profile))).mode & 0o777, 0o600);
  await store.revoke('alice', profile);
  await assert.rejects(store.save('alice', profile, state, loaded.generation), /PROFILE_REVOKED/);
  assert.equal((await store.load('alice', profile)).state.cookies.length, 0);
 } finally { await rm(root,{recursive:true,force:true}); }
});

test('profile state drops unrelated origins/cookies and ciphertext cannot move between users', async () => {
 const root=await mkdtemp(join(tmpdir(),'coke-profile-scope-'));
 try {
  const { writeFile }=await import('node:fs/promises');
  const store=new ProfileStore(root);const descriptor={name:'main',origin:'https://example.com'};
  const loaded=await store.load('alice',descriptor);
  await store.save('alice',descriptor,{cookies:[{name:'ok',value:'safe',domain:'example.com'}, {name:'foreign',value:'secret',domain:'foreign.com'}],origins:[{origin:'https://example.com',localStorage:[]},{origin:'https://foreign.com',localStorage:[]}]},loaded.generation);
  const saved=await store.load('alice',descriptor);assert.equal(saved.state.cookies.length,1);assert.equal(saved.state.origins.length,1);
  await writeFile(store.path('bob',descriptor),await readFile(store.path('alice',descriptor)));
  await assert.rejects(store.load('bob',descriptor),/PROFILE_DECRYPT_FAILED/);
  const keys=await Promise.all(Array.from({length:5},()=>new ProfileStore(root).init()));
  assert.ok(keys.every(key=>key.equals(keys[0])));
  assert.equal((await stat(join(root,'.key'))).mode & 0o777,0o600);
 }finally{await rm(root,{recursive:true,force:true});}
});
