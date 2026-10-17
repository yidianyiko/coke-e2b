import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, chmod, readFile, writeFile, rename, unlink, rmdir, link } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const hash = value => createHash('sha256').update(value).digest('hex');
function descriptor(value) {
 if (!value || typeof value.name !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(value.name) || typeof value.origin !== 'string') throw new Error('INVALID_VAULT_DESCRIPTOR');
 let url; try { url = new URL(value.origin); } catch { throw new Error('INVALID_VAULT_DESCRIPTOR'); }
 const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
 if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) || url.origin !== value.origin || url.username || url.password) throw new Error('INVALID_VAULT_DESCRIPTOR');
 return { name: value.name, origin: url.origin };
}
function identity(user, value) {
 if (typeof user !== 'string' || user.length < 1 || user.length > 256 || /[\x00-\x1f\x7f]/.test(user)) throw new Error('INVALID_VAULT_USER');
 return JSON.stringify([user, descriptor(value)]);
}
function validateCredentials(value) {
 if (!value || typeof value.email !== 'string' || !value.email.trim() || Buffer.byteLength(value.email) > 1024 || typeof value.password !== 'string' || !value.password || Buffer.byteLength(value.password) > 4096) throw new Error('INVALID_VAULT_CREDENTIALS');
 return { email: value.email, password: value.password };
}
const metadata = value => ({ ...descriptor(value), fields: ['email', 'password'] });

// Only trusted backend code receives values, through fill's callback. Never expose this
// callback as a caller-selected tool or HTTP operation.
export class VaultStore {
 constructor(root = resolve('.coke-private/vault')) { this.root = resolve(root); }
 async init() {
  await mkdir(this.root, { recursive: true, mode: 0o700 }); await chmod(this.root, 0o700);
  const keyPath = join(this.root, '.key');
  let key;
  try { key = await readFile(keyPath); } catch (error) {
   if (error.code !== 'ENOENT') throw new Error('VAULT_UNAVAILABLE');
   const temp = join(this.root, `.key-${randomUUID()}`);
   try {
    await writeFile(temp, randomBytes(32), { mode: 0o600, flag: 'wx' });
    try { await link(temp, keyPath); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    key = await readFile(keyPath);
   } catch { throw new Error('VAULT_UNAVAILABLE'); }
   finally { await unlink(temp).catch(() => {}); }
  }
  if (key.length !== 32) throw new Error('VAULT_UNAVAILABLE');
  await chmod(keyPath, 0o600); return key;
 }
 async locked(user, value, action) {
  const aad = identity(user, value); const key = await this.init();
  const path = join(this.root, hash(aad) + '.enc'); const lock = path + '.lock';
  for (let attempt = 0; ; attempt++) {
   try { await mkdir(lock, { mode: 0o700 }); break; }
   catch (error) { if (error.code !== 'EEXIST') throw new Error('VAULT_UNAVAILABLE'); if (attempt >= 100) throw new Error('VAULT_BUSY'); await new Promise(done => setTimeout(done, 20)); }
  }
  try { return await action({ path, key, aad }); } finally { await rmdir(lock); }
 }
 async decode({path,key,aad}) {
  try {
   const envelope = JSON.parse(await readFile(path, 'utf8'));
   const iv = Buffer.from(envelope.iv, 'base64'); const tag = Buffer.from(envelope.tag, 'base64');
   if (envelope.version !== 1 || iv.length !== 12 || tag.length !== 16) throw new Error();
   const decipher = createDecipheriv('aes-256-gcm',key,iv);
   decipher.setAAD(Buffer.from(aad)); decipher.setAuthTag(tag);
   return validateCredentials(JSON.parse(Buffer.concat([decipher.update(Buffer.from(envelope.data, 'base64')),decipher.final()]).toString('utf8')));
  } catch (error) { if (error.code === 'ENOENT') return null; throw new Error('VAULT_DECRYPT_FAILED'); }
 }
 async set(user, value, credentials) {
  const clean = validateCredentials(credentials);
  return this.locked(user,value,async ({path,key,aad}) => {
   const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm',key,iv); cipher.setAAD(Buffer.from(aad));
   const data = Buffer.concat([cipher.update(JSON.stringify(clean)),cipher.final()]); const temp = `${path}.${randomUUID()}.tmp`;
   try {
    await writeFile(temp, JSON.stringify({version:1,iv:iv.toString('base64'),tag:cipher.getAuthTag().toString('base64'),data:data.toString('base64')}),{mode:0o600,flag:'wx'});
    await rename(temp,path);
   } catch { throw new Error('VAULT_UNAVAILABLE'); } finally { await unlink(temp).catch(() => {}); }
   return metadata(value);
  });
 }
 async metadata(user,value) { return this.locked(user,value,async context => await this.decode(context) ? metadata(value) : null); }
 async delete(user,value) {
  return this.locked(user,value,async ({path}) => {
   try { await unlink(path); return {deleted:true}; } catch (error) { if (error.code === 'ENOENT') return {deleted:false}; throw new Error('VAULT_UNAVAILABLE'); }
  });
 }
 async fill(user,value,callback) {
  if (typeof callback !== 'function') throw new Error('INVALID_VAULT_CALLBACK');
  return this.locked(user,value,async context => {
   const credentials = await this.decode(context); if (!credentials) throw new Error('VAULT_NOT_FOUND');
   // Callback errors are deliberately sanitized: browser libraries can echo field values.
   try { return await callback(credentials); } catch { throw new Error('VAULT_FILL_FAILED'); }
  });
 }
}
