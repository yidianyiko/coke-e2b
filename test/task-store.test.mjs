import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TaskStore } from '../src/task-store.mjs';

test('ledger scopes artifacts and rejects foreign task access', async () => {
 const dir = await mkdtemp(join(tmpdir(), 'coke-ledger-'));
 try {
  const store = new TaskStore(dir);
  const a = await store.create('alice', 'local');
  const b = await store.create('bob', 'local');
  assert.notEqual(a.artifactDir, b.artifactDir);
  await assert.rejects(store.get('bob', a.taskId), /TASK_NOT_FOUND/);
  await store.update('alice', a.taskId, { status: 'cancelled' });
  assert.equal((await store.get('alice', a.taskId)).status, 'cancelled');
  assert.equal((await stat(a.artifactDir)).mode & 0o777, 0o700);
  assert.equal((await stat(store.recordPath('alice', a.taskId))).mode & 0o777, 0o600);
 } finally { await rm(dir, { recursive: true, force: true }); }
});

test('cleanup preserves live tasks and foreign sandboxes, cleans owned expired sandbox', async () => {
 const dir = await mkdtemp(join(tmpdir(), 'coke-cleanup-'));
 try {
  const store = new TaskStore(dir);
  const active = await store.create('alice', 'e2b');
  const expired = await store.create('alice', 'e2b');
  const foreign = await store.create('alice', 'e2b');
  await store.update('alice', active.taskId, { sandboxId: 'active', expiresAt: 1, parentPid: 10 });
  await store.update('alice', expired.taskId, { sandboxId: 'owned', expiresAt: 1, parentPid: 20 });
  await store.update('alice', foreign.taskId, { sandboxId: 'foreign', expiresAt: 1, parentPid: 20 });
  const { userScope } = await import('../src/task-store.mjs');
  const killed = [];
  const results = await store.cleanup('alice', { now: 100, alive: pid => pid === 10,
   inspectSandbox: async id => ({ metadata: id === 'owned' ? { cokeTask: expired.taskId, cokeUser: userScope('alice') } : {} }),
   killSandbox: async id => { killed.push(id); return true; },
  });
  assert.deepEqual(killed, ['owned']);
  assert.equal(results.find(x => x.taskId === foreign.taskId).error, 'RESOURCE_OWNERSHIP_MISMATCH');
  assert.equal((await store.get('alice', active.taskId)).status, 'running');
  assert.equal((await store.get('alice', expired.taskId)).status, 'cleaned');
 } finally { await rm(dir, { recursive: true, force: true }); }
});

test('orphan discovery recovers creation-save gaps and preserves active or foreign resources', async () => {
 const dir = await mkdtemp(join(tmpdir(), 'coke-orphans-'));
 try {
  const { userScope } = await import('../src/task-store.mjs');
  const store = new TaskStore(dir);
  const active = await store.create('alice', 'e2b');
  const missing = '11111111-1111-4111-8111-111111111111';
  const metadata = task => ({ cokeApp: 'coke-e2b', cokeUser: userScope('alice'), cokeTask: task, cokeExpiresAt: '1' });
  const sandboxes = [{ sandboxId: 'orphan', metadata: metadata(missing) }, { sandboxId: 'active', metadata: metadata(active.taskId) }, { sandboxId: 'foreign', metadata: { ...metadata(missing), cokeUser: 'foreign' } }];
  const killed = [];
  const results = await store.cleanup('alice', { now: 100, alive: () => true,
   listSandboxes: async () => sandboxes, inspectSandbox: async id => sandboxes.find(s => s.sandboxId === id), killSandbox: async id => { killed.push(id); return true; } });
  assert.deepEqual(killed, ['orphan']);
  assert.equal(results.find(x => x.sandboxId === 'orphan').cleaned, true);
 } finally { await rm(dir, { recursive: true, force: true }); }
});

test('orphan discovery reinspects ownership and retries failures without a local ledger', async () => {
 const dir = await mkdtemp(join(tmpdir(), 'coke-orphan-reinspect-'));
 try {
  const { userScope } = await import('../src/task-store.mjs');
  const store = new TaskStore(join(dir, 'absent'));
  const candidate = { sandboxId: 'orphan', metadata: { cokeApp: 'coke-e2b', cokeUser: userScope('alice'), cokeTask: '11111111-1111-4111-8111-111111111111', cokeExpiresAt: '1' } };
  let kills = 0;
  const args = { now: 100, listSandboxes: async () => [candidate], inspectSandbox: async () => ({ ...candidate, metadata: { ...candidate.metadata, cokeApp: 'foreign' } }), killSandbox: async () => { kills++; return true; } };
  assert.equal((await store.cleanup('alice', args))[0].error, 'RESOURCE_OWNERSHIP_MISMATCH');
  assert.equal(kills, 0);
  args.inspectSandbox = async () => candidate;
  assert.equal((await store.cleanup('alice', args))[0].cleaned, true);
  assert.equal(kills, 1);
 } finally { await rm(dir, { recursive: true, force: true }); }
});
