import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, chmod, readFile, writeFile, rename, unlink, rmdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const hash = value => createHash('sha256').update(value).digest('hex');
const empty = () => ({ cookies: [], origins: [] });
export function profileDescriptor(profile) {
 if (!profile || typeof profile.name !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(profile.name)) throw new Error('INVALID_PROFILE');
 const url = new URL(profile.origin);
 if (!['http:', 'https:'].includes(url.protocol) || url.origin !== profile.origin || url.username || url.password) throw new Error('INVALID_PROFILE_ORIGIN');
 return { name: profile.name, origin: url.origin };
}
export function filterProfileState(state, origin) {
 const host = new URL(origin).hostname;
 return {
  cookies: (state.cookies || []).filter(cookie => cookie.domain === host || cookie.domain.startsWith('.') && (host === cookie.domain.slice(1) || host.endsWith(cookie.domain))),
  origins: (state.origins || []).filter(entry => entry.origin === origin),
 };
}
export class ProfileStore {
 constructor(root = resolve('.coke-private/profiles')) { this.root = resolve(root); }
 identity(user, profile) { return JSON.stringify([user, profileDescriptor(profile)]); }
 path(user, profile) { return join(this.root, hash(this.identity(user, profile)) + '.enc'); }
 async init() {
  await mkdir(this.root, { recursive: true, mode: 0o700 });
  await chmod(this.root, 0o700);
  const keyPath = join(this.root, '.key');
  // Publish a fully written key atomically. Hard link refuses replacement if another process wins.
  let key;
  try { key = await readFile(keyPath); } catch (error) {
   if (error.code !== 'ENOENT') throw error;
   const temp = join(this.root, `.key-${randomUUID()}`);
   await writeFile(temp, randomBytes(32), { mode: 0o600 });
   try { const { link } = await import('node:fs/promises'); await link(temp, keyPath); }
   catch (e) { if (e.code !== 'EEXIST') throw e; }
   finally { await unlink(temp); }
   key = await readFile(keyPath);
  }
  if (key.length !== 32) throw new Error('INVALID_PROFILE_KEY');
  await chmod(keyPath, 0o600);
  return key;
 }
 async lock(path, action) {
  const lock = path + '.lock';
  for (let i = 0; ; i++) {
   try { await mkdir(lock, { mode: 0o700 }); break; }
   catch (e) { if (e.code !== 'EEXIST') throw e; if (i >= 100) throw new Error('PROFILE_BUSY'); await new Promise(r => setTimeout(r, 20)); }
  }
  try { return await action(); } finally { await rmdir(lock); }
 }
 async decode(path, key, identity) {
  try {
   const envelope = JSON.parse(await readFile(path, 'utf8'));
   const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'base64'));
   decipher.setAAD(Buffer.from(identity));
   decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
   return JSON.parse(Buffer.concat([decipher.update(Buffer.from(envelope.data, 'base64')), decipher.final()]).toString('utf8'));
  } catch (error) { if (error.code === 'ENOENT') return null; throw new Error('PROFILE_DECRYPT_FAILED'); }
 }
 async encode(path, key, identity, value) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(identity));
  const data = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
  const temp = `${path}.${randomUUID()}.tmp`;
  await writeFile(temp, JSON.stringify({ iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') }), { mode: 0o600 });
  await rename(temp, path);
 }
 async load(user, profile) {
  const key = await this.init(); const identity = this.identity(user, profile); const path = this.path(user, profile);
  return this.lock(path, async () => {
   let value = await this.decode(path, key, identity);
   if (!value) { value = { generation: randomUUID(), state: empty() }; await this.encode(path, key, identity, value); }
   return value;
  });
 }
 async save(user, profile, state, generation) {
  const key = await this.init(); const identity = this.identity(user, profile); const path = this.path(user, profile);
  return this.lock(path, async () => {
   const current = await this.decode(path, key, identity);
   if (!current || current.generation !== generation) throw new Error('PROFILE_REVOKED');
   await this.encode(path, key, identity, { generation, state: filterProfileState(state, profile.origin) });
  });
 }
 async revoke(user, profile) {
  const key = await this.init(); const identity = this.identity(user, profile); const path = this.path(user, profile);
  return this.lock(path, () => this.encode(path, key, identity, { generation: randomUUID(), state: empty() }));
 }
}
