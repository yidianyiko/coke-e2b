import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, readdir, chmod } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const scope = user => createHash('sha256').update(user).digest('hex');
export class TaskStore {
 constructor(root) { this.root = resolve(root); }
 recordPath(user, taskId) {
  if (!/^[0-9a-f-]{36}$/.test(taskId)) throw new Error('TASK_NOT_FOUND');
  return join(this.root, scope(user), taskId, 'task.json');
 }
 async create(userId, runtime) {
  const taskId = randomUUID();
  const artifactDir = join(this.root, scope(userId), taskId);
  await mkdir(artifactDir, { recursive: true, mode: 0o700 });
  await chmod(join(this.root, scope(userId)), 0o700);
  const record = { schemaVersion: 1, userId, taskId, runtime, artifactDir, status: 'running', parentPid: process.pid, expiresAt: Date.now() + 180_000, createdAt: Date.now() };
  await this.save(record);
  return record;
 }
 async save(record) {
  const path = this.recordPath(record.userId, record.taskId);
  const temp = `${path}.${randomUUID()}.tmp`;
  await writeFile(temp, JSON.stringify(record), { mode: 0o600 });
  await rename(temp, path);
 }
 async get(user, taskId) {
  try {
   const record = JSON.parse(await readFile(this.recordPath(user, taskId), 'utf8'));
   if (record.userId !== user || record.taskId !== taskId) throw new Error();
   return record;
  } catch { throw new Error('TASK_NOT_FOUND'); }
 }
 async update(user, taskId, fields) {
  const record = { ...await this.get(user, taskId), ...fields, updatedAt: Date.now() };
  await this.save(record);
  return record;
 }
 async list(user) {
  let entries;
  try { entries = await readdir(join(this.root, scope(user))); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const records = [];
  for (const taskId of entries) { try { records.push(await this.get(user, taskId)); } catch {} }
  return records.sort((a, b) => b.createdAt - a.createdAt);
 }
 async cleanup(user, { now = Date.now(), alive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e.code !== 'ESRCH'; } }, inspectSandbox, killSandbox, listSandboxes } = {}) {
  const results = [];
  const handled = new Set();
  let entries;
  try { entries = await readdir(join(this.root, scope(user))); } catch (error) { if (error.code === 'ENOENT') entries = []; else throw error; }
  for (const taskId of entries) {
   let record;
   try { record = await this.get(user, taskId); } catch { continue; }
   if (record.expiresAt > now || alive(record.parentPid) || record.status === 'cleaned' || ['succeeded', 'cancelled', 'failed'].includes(record.status) && record.resourcesReleased) continue;
   try {
    if (record.sandboxId && !record.sandboxKilled) {
     const info = await inspectSandbox(record.sandboxId);
     if (info && (info.metadata?.cokeTask !== taskId || info.metadata?.cokeUser !== scope(user))) throw new Error('RESOURCE_OWNERSHIP_MISMATCH');
     if (info && !await killSandbox(record.sandboxId)) throw new Error('SANDBOX_NOT_KILLED');
    }
    await this.update(user, taskId, { status: 'cleaned', resourcesReleased: true, sandboxKilled: Boolean(record.sandboxId), cleanupAt: now });
    if (record.sandboxId) handled.add(record.sandboxId);
    results.push({ taskId, cleaned: true });
   } catch (error) { results.push({ taskId, cleaned: false, error: error.message }); }
  }
  if (listSandboxes) {
   const ownedExpired = info => info?.metadata?.cokeApp === 'coke-e2b'
    && info.metadata.cokeUser === scope(user)
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(info.metadata.cokeTask || '')
    && /^[1-9][0-9]*$/.test(info.metadata.cokeExpiresAt || '')
    && Number.isSafeInteger(Number(info.metadata.cokeExpiresAt)) && Number(info.metadata.cokeExpiresAt) <= now;
   for (const candidate of await listSandboxes()) {
    if (!candidate.sandboxId || handled.has(candidate.sandboxId) || !ownedExpired(candidate)) continue;
    const taskId = candidate.metadata.cokeTask;
    let record;
    try { record = await this.get(user, taskId); } catch {}
    if (record && (record.expiresAt > now || alive(record.parentPid))) continue;
    try {
     const info = await inspectSandbox(candidate.sandboxId);
     if (info && (!ownedExpired(info) || info.metadata.cokeTask !== taskId)) throw new Error('RESOURCE_OWNERSHIP_MISMATCH');
     if (info && !await killSandbox(candidate.sandboxId)) throw new Error('SANDBOX_NOT_KILLED');
     if (record && (!record.sandboxId || record.sandboxId === candidate.sandboxId)) {
      await this.update(user, taskId, { sandboxId: candidate.sandboxId, sandboxKilled: true, status: 'cleaned', resourcesReleased: true, cleanupAt: now });
     }
     handled.add(candidate.sandboxId);
     results.push({ taskId, sandboxId: candidate.sandboxId, cleaned: true, discovered: true });
    } catch (error) { results.push({ taskId, sandboxId: candidate.sandboxId, cleaned: false, error: error.message }); }
   }
  }
  return results;
 }
}
export const userScope = scope;
