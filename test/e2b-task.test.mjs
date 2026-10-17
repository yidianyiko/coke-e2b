import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { TaskStore } from '../src/task-store.mjs';

const execFileAsync = promisify(execFile);

test('E2B CLI drives the separate browser lease through the host gateway', {
  skip: !process.env.RUN_E2B_TEST || !process.env.E2B_API_KEY,
}, async () => {
  const server = createServer((request, response) => {
    response.setHeader('content-type', 'text/html; charset=utf-8');
    response.end(request.url === '/'
      ? '<a href="/result">Next</a>'
      : '<main><span id="value">cloud-42</span></main>');
  });
  await new Promise(resolveListen => server.listen(0, '127.0.0.1', resolveListen));
  const outputDir = await mkdtemp(join(tmpdir(), 'coke-e2b-test-'));
  try {
    const { stdout } = await execFileAsync(process.execPath, [
      resolve('bin/coke.mjs'), 'task', 'run', 'Follow Next and read the value',
      '--runtime', 'e2b', '--user', 'cloud-test-user',
      '--url', `http://127.0.0.1:${server.address().port}/`,
      '--link-text', 'Next', '--value-selector', '#value', '--output-dir', outputDir,
    ], { cwd: outputDir, timeout: 90_000, env: process.env });
    const result = JSON.parse(stdout);
    assert.match(result.sandboxId, /^[a-z0-9]+$/);
    assert.equal(result.template, 'coke-task-cli:v3');
    assert.equal(result.cliSha256, createHash('sha256').update(await readFile(resolve('src/tools-cli.mjs'))).digest('hex'));
    assert.equal(result.value, 'cloud-42');
    assert.equal(result.trace.find(entry => entry.action === 'extract').source, 'e2b-cli');
    assert.equal(result.trace.at(-1).action, 'release');
    assert.equal(result.sandboxKilled, true);
    const png = await readFile(result.screenshotPath);
    assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  } finally {
    server.close();
    await rm(outputDir, { recursive: true, force: true });
  }
});

test('E2B task failure releases its lease and kills its sandbox', {
  skip: !process.env.RUN_E2B_TEST || !process.env.E2B_API_KEY,
}, async () => {
  const server = createServer((_request, response) => {
    response.setHeader('content-type', 'text/html');
    response.end('<a href="/result">Next</a>');
  });
  await new Promise(resolveListen => server.listen(0, '127.0.0.1', resolveListen));
  try {
    let failure;
    await assert.rejects(execFileAsync(process.execPath, [
      resolve('bin/coke.mjs'), 'task', 'run', 'Read a missing value',
      '--runtime', 'e2b', '--url', `http://127.0.0.1:${server.address().port}/`,
      '--link-text', 'Next', '--value-selector', '#bad[',
    ], { timeout: 90_000, env: process.env }), error => {
      const result = JSON.parse(error.stderr.trim());
      failure = result;
      assert.match(result.sandboxId, /^[a-z0-9]+$/);
      assert.equal(result.sandboxKilled, true);
      assert.equal(result.trace.at(-1).action, 'release');
      assert.equal(result.trace.at(-1).result.released, true);
      return true;
    });
    assert.equal((await readFile(failure.screenshotPath)).subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    await rm(failure.screenshotPath);
  } finally {
    server.close();
  }
});

test('SIGINT cancels an E2B browser action and cleans up both resources', {
  skip: !process.env.RUN_E2B_TEST || !process.env.E2B_API_KEY,
}, async () => {
  let child;
  let pendingResponse;
  const outputDir = await mkdtemp(join(tmpdir(), 'coke-e2b-cancel-'));
  const server = createServer((request, response) => {
    response.setHeader('content-type', 'text/html');
    if (request.url === '/') response.end('<a href="/result">Next</a>');
    else {
      pendingResponse = response;
      child.kill('SIGINT');
    }
  });
  await new Promise(resolveListen => server.listen(0, '127.0.0.1', resolveListen));
  try {
    child = spawn(process.execPath, [
      resolve('bin/coke.mjs'), 'task', 'run', 'Follow Next and read the value',
      '--runtime', 'e2b', '--url', `http://127.0.0.1:${server.address().port}/`,
      '--link-text', 'Next', '--value-selector', '#value', '--output-dir', outputDir,
    ], { env: process.env });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk; });
    const exitCode = await new Promise((resolveExit, reject) => {
      const timeout = setTimeout(() => reject(new Error('Cancellation timed out')), 60_000);
      child.once('exit', code => {
        clearTimeout(timeout);
        resolveExit(code);
      });
    });
    assert.equal(exitCode, 1);
    const result = JSON.parse(stderr.trim());
    const record = await new TaskStore(outputDir).get('local-user', result.taskId);
    assert.equal(record.status, 'cancelled');
    assert.equal(record.resourcesReleased, true);
    assert.equal(record.errorCode, 'TASK_CANCELLED');
    assert.match(result.sandboxId, /^[a-z0-9]+$/);
    assert.equal(result.sandboxKilled, true);
    assert.equal(result.trace.at(-1).action, 'release');
    assert.equal(result.trace.at(-1).result.released, true);
    assert.equal((await readFile(result.screenshotPath)).subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    await rm(result.screenshotPath);
  } finally {
    pendingResponse?.end('<main><span id="value">late</span></main>');
    child?.kill('SIGKILL');
    await rm(outputDir, { recursive: true, force: true });
    server.close();
  }
});

test('concurrent E2B users get separate sandboxes, leases and artifact scopes', {
 skip: !process.env.RUN_E2B_TEST || !process.env.E2B_API_KEY,
}, async () => {
 const outputDir = await mkdtemp(join(tmpdir(), 'coke-e2b-concurrent-'));
 const server = createServer((request, response) => {
  response.setHeader('content-type', 'text/html');
  response.end(request.url === '/' ? '<a href="/result">Next</a>' : '<main id="value">isolated</main>');
 });
 await new Promise(done => server.listen(0, '127.0.0.1', done));
 try {
  const results = await Promise.all(['alice', 'bob'].map(async user => {
   const { stdout } = await execFileAsync(process.execPath, [resolve('bin/coke.mjs'), 'task', 'run', 'Read isolated', '--runtime', 'e2b', '--user', user, '--url', `http://127.0.0.1:${server.address().port}/`, '--link-text', 'Next', '--value-selector', '#value', '--output-dir', outputDir], { timeout: 90_000, env: process.env });
   return JSON.parse(stdout);
  }));
  assert.notEqual(results[0].sandboxId, results[1].sandboxId);
  assert.notEqual(results[0].leaseId, results[1].leaseId);
  assert.notEqual(results[0].screenshotPath.split('/').at(-3), results[1].screenshotPath.split('/').at(-3));
  for (const result of results) assert.equal(result.sandboxKilled, true);
  await assert.rejects(new TaskStore(outputDir).get('bob', results[0].taskId), /TASK_NOT_FOUND/);
 } finally { server.close(); await rm(outputDir, { recursive: true, force: true }); }
});

test('cleanup CLI removes a metadata-verified expired sandbox while preserving an active one', {
 skip: !process.env.RUN_E2B_TEST || !process.env.E2B_API_KEY,
}, async () => {
 const { Sandbox, FileNotFoundError } = await import('e2b');
 const { userScope } = await import('../src/task-store.mjs');
 const outputDir = await mkdtemp(join(tmpdir(), 'coke-e2b-cleanup-'));
 const store = new TaskStore(outputDir);
 const expired = await store.create('cleanup-user', 'e2b');
 const active = await store.create('cleanup-user', 'e2b');
 const sandboxes = [];
 try {
  for (const record of [expired, active]) {
   const sandbox = await Sandbox.create('coke-task-cli:v3', { timeoutMs: 60_000, metadata: { cokeTask: record.taskId, cokeUser: userScope('cleanup-user') } });
   sandboxes.push(sandbox);
   await store.update('cleanup-user', record.taskId, { sandboxId: sandbox.sandboxId, expiresAt: record === expired ? 1 : Date.now() + 60_000, parentPid: record === expired ? 2147483647 : process.pid });
  }
  const privatePath = '/home/user/coke-private-isolation.txt';
  await sandboxes[0].files.write(privatePath, '用户 A 的私有内容');
  assert.equal(await sandboxes[0].files.read(privatePath), '用户 A 的私有内容');
  await assert.rejects(sandboxes[1].files.read(privatePath), FileNotFoundError);
  const { stdout } = await execFileAsync(process.execPath, [resolve('bin/coke.mjs'), 'task', 'cleanup', '--user', 'cleanup-user', '--output-dir', outputDir], { timeout: 30_000, env: process.env });
  assert.deepEqual(JSON.parse(stdout).tasks, [{ taskId: expired.taskId, cleaned: true }]);
  assert.equal((await sandboxes[1].commands.run('true')).exitCode, 0);
  assert.equal((await store.get('cleanup-user', expired.taskId)).resourcesReleased, true);
 } finally {
  await Promise.allSettled(sandboxes.map(sandbox => sandbox.kill()));
  await rm(outputDir, { recursive: true, force: true });
 }
});

test('orphan discovery cleans metadata-owned expired sandbox without a saved local ID', {
 skip: !process.env.RUN_E2B_TEST || !process.env.E2B_API_KEY,
}, async () => {
 const { Sandbox } = await import('e2b');
 const { userScope } = await import('../src/task-store.mjs');
 const { sandboxCleanupOptions } = await import('../src/sandbox-cleanup.mjs');
 const outputDir = await mkdtemp(join(tmpdir(), 'coke-orphan-real-'));
 const store = new TaskStore(outputDir);
 const record = await store.create('orphan-test', 'e2b');
 await store.update('orphan-test', record.taskId, { expiresAt: 1, parentPid: 2147483647 });
 const sandbox = await Sandbox.create('coke-task-cli:v3', { timeoutMs: 60_000, metadata: { cokeApp: 'coke-e2b', cokeUser: userScope('orphan-test'), cokeTask: record.taskId, cokeExpiresAt: '1' } });
 try {
  const results = await store.cleanup('orphan-test', sandboxCleanupOptions('orphan-test'));
  assert.equal(results.find(x => x.sandboxId === sandbox.sandboxId).cleaned, true);
  const recovered = await store.get('orphan-test', record.taskId);
  assert.equal(recovered.sandboxId, sandbox.sandboxId);
  assert.equal(recovered.sandboxKilled, true);
 } finally { await sandbox.kill(); await rm(outputDir, { recursive: true, force: true }); }
});
