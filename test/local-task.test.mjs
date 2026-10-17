import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { fork } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { TaskStore } from '../src/task-store.mjs';

const execFileAsync = promisify(execFile);

test('local CLI follows a link, reads a value, saves PNG, and releases lease', async () => {
  const server = createServer((request, response) => {
    response.setHeader('content-type', 'text/html; charset=utf-8');
    if (request.url === '/') {
      response.end('<a href="/result">Next</a>');
    } else if (request.url === '/result') {
      response.end('<main><span id="value">fixture-42</span></main>');
    } else {
      response.writeHead(404).end('missing');
    }
  });
  await new Promise(resolveListen => server.listen(0, '127.0.0.1', resolveListen));
  const outputDir = await mkdtemp(join(tmpdir(), 'coke-browser-test-'));
  const startUrl = `http://127.0.0.1:${server.address().port}/`;
  try {
    const { stdout } = await execFileAsync(process.execPath, [
      resolve('bin/coke.mjs'), 'task', 'run', 'Follow Next and read the value',
      '--runtime', 'local', '--user', 'fixture-user', '--url', startUrl,
      '--link-text', 'Next', '--value-selector', '#value', '--output-dir', outputDir,
    ], { cwd: outputDir, timeout: 30_000 });
    const result = JSON.parse(stdout);
    assert.match(result.taskId, /^[0-9a-f-]{36}$/);
    assert.equal(result.finalUrl, new URL('/result', startUrl).href);
    assert.equal(result.value, 'fixture-42');
    const record = await new TaskStore(outputDir).get('fixture-user', result.taskId);
    assert.equal(record.status, 'succeeded');
    assert.equal(record.resourcesReleased, true);
    assert.equal(record.result.value, 'fixture-42');
    assert.deepEqual(record.trace, result.trace);
    assert.equal(result.trace.find(entry => entry.action === 'extract').result.value, 'fixture-42');
    assert.equal(result.trace.find(entry => entry.action === 'click-link').result.url, new URL('/result', startUrl).href);
    assert.ok(result.trace.find(entry => entry.action === 'screenshot').result.byteLength > 8);
    assert.equal(result.trace.at(-1).action, 'release');
    assert.equal(result.trace.at(-1).ok, true);
    const png = await readFile(result.screenshotPath);
    assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  } finally {
    server.close();
    await rm(outputDir, { recursive: true, force: true });
  }
});

test('local CLI reports lease release after a failed page extraction', async () => {
  const server = createServer((request, response) => {
    response.setHeader('content-type', 'text/html; charset=utf-8');
    response.end(request.url === '/' ? '<a href="/result">Next</a>' : '<main>No value here</main>');
  });
  await new Promise(resolveListen => server.listen(0, '127.0.0.1', resolveListen));
  const outputDir = await mkdtemp(join(tmpdir(), 'coke-browser-failure-'));
  try {
    await assert.rejects(
      execFileAsync(process.execPath, [
        resolve('bin/coke.mjs'), 'task', 'run', 'Read a missing value',
        '--runtime', 'local', '--user', 'fixture-user',
        '--url', `http://127.0.0.1:${server.address().port}/`,
        '--link-text', 'Next', '--value-selector', '#missing[', '--output-dir', outputDir,
      ], { cwd: outputDir, timeout: 30_000 }),
      error => {
        const result = JSON.parse(error.stderr);
        assert.equal(result.error.code, 'TASK_FAILED');
        assert.equal(result.trace.at(-1).action, 'release');
        assert.equal(result.trace.at(-1).ok, true);
        return true;
      },
    );
  } finally {
    server.close();
    await rm(outputDir, { recursive: true, force: true });
  }
});

test('browser lease rejects another task and cannot be reused after release', async () => {
  const token = randomBytes(16).toString('hex');
  const child = fork(resolve('src/browser-server.mjs'), [], {
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    env: { ...process.env, COKE_BROWSER_TOKEN: token },
  });
  try {
    const port = await new Promise((resolveReady, reject) => {
      child.once('message', message => resolveReady(message.port));
      child.once('exit', code => reject(new Error(`browser service exited: ${code}`)));
    });
    const call = async (route, body) => {
      const response = await fetch(`http://127.0.0.1:${port}${route}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      return { status: response.status, body: await response.json() };
    };
    const owner = { userId: 'alice', taskId: 'task-a' };
    const [acquired, second] = await Promise.all([
      call('/acquire', owner),
      call('/acquire', { userId: 'bob', taskId: 'task-b' }),
    ]);
    assert.equal(acquired.status, 200);
    assert.equal(second.status, 200);
    assert.notEqual(acquired.body.leaseId, second.body.leaseId);
    const leaseId = acquired.body.leaseId;
    const otherTask = await call('/action', { userId: 'alice', taskId: 'task-b', leaseId, action: 'read' });
    assert.equal(otherTask.status, 403);
    assert.equal(otherTask.body.error.code, 'LEASE_FORBIDDEN');
    const otherUser = await call('/action', { userId: 'bob', taskId: 'task-a', leaseId, action: 'read' });
    assert.equal(otherUser.status, 403);
    assert.equal(otherUser.body.error.code, 'LEASE_FORBIDDEN');
    const released = await call('/release', { ...owner, leaseId });
    assert.equal(released.body.released, true);
    const reused = await call('/action', { ...owner, leaseId, action: 'read' });
    assert.equal(reused.status, 404);
    assert.equal(reused.body.error.code, 'LEASE_NOT_FOUND');
    const secondReleased = await call('/release', {
      userId: 'bob', taskId: 'task-b', leaseId: second.body.leaseId,
    });
    assert.equal(secondReleased.body.released, true);
  } finally {
    if (child.exitCode === null) {
      const exited = new Promise(resolveExit => child.once('exit', resolveExit));
      child.send({ type: 'shutdown' });
      await exited;
    }
  }
});

test('browser click-ref uses the latest read and rejects a stale element reference', async () => {
  const site = createServer((_request, response) => {
    response.setHeader('content-type', 'text/html');
    response.end('<a href="/next">Next</a>');
  });
  await new Promise(resolveListen => site.listen(0, '127.0.0.1', resolveListen));
  const token = randomBytes(16).toString('hex');
  const child = fork(resolve('src/browser-server.mjs'), [], {
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    env: { ...process.env, COKE_BROWSER_TOKEN: token },
  });
  try {
    const port = await new Promise(resolveReady => child.once('message', message => resolveReady(message.port)));
    const call = async (route, body) => {
      const response = await fetch(`http://127.0.0.1:${port}${route}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      return { status: response.status, body: await response.json() };
    };
    const owner = { userId: 'alice', taskId: 'task-ref' };
    const leaseId = (await call('/acquire', owner)).body.leaseId;
    const action = (name, extra = {}) => call('/action', { ...owner, leaseId, action: name, ...extra });
    await action('navigate', { url: `http://127.0.0.1:${site.address().port}/` });
    const firstRead = await action('read');
    assert.equal(firstRead.body.elements[0].name, 'Next');
    const ref = firstRead.body.elements[0].ref;
    const clicked = await action('click-ref', { ref });
    assert.equal(clicked.status, 200);
    assert.match(clicked.body.url, /\/next$/);
    const stale = await action('click-ref', { ref });
    assert.equal(stale.status, 409);
    assert.equal(stale.body.error.code, 'STALE_ELEMENT_REFERENCE');
    await call('/release', { ...owner, leaseId });
  } finally {
    site.close();
    if (child.exitCode === null) {
      const exited = new Promise(resolveExit => child.once('exit', resolveExit));
      child.send({ type: 'shutdown' });
      await exited;
    }
  }
});

test('browser fill-ref updates a labeled input and invalidates its reference', async () => {
  const site = createServer((_request, response) => {
    response.setHeader('content-type', 'text/html');
    response.end('<label for="code">Code</label><input id="code"><button id="send" onclick="document.body.append(document.querySelector(\'#code\').value)">Send</button>');
  });
  await new Promise(resolveListen => site.listen(0, '127.0.0.1', resolveListen));
  const token = randomBytes(16).toString('hex');
  const child = fork(resolve('src/browser-server.mjs'), [], {
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'], env: { ...process.env, COKE_BROWSER_TOKEN: token },
  });
  try {
    const port = await new Promise(resolveReady => child.once('message', message => resolveReady(message.port)));
    const call = async (route, body) => {
      const response = await fetch(`http://127.0.0.1:${port}${route}`, {
        method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      return { status: response.status, body: await response.json() };
    };
    const owner = { userId: 'alice', taskId: 'form-task' };
    const leaseId = (await call('/acquire', owner)).body.leaseId;
    const action = (name, extra = {}) => call('/action', { ...owner, leaseId, action: name, ...extra });
    await action('navigate', { url: `http://127.0.0.1:${site.address().port}/` });
    const firstRead = await action('read');
    const input = firstRead.body.elements.find(element => element.role === 'textbox');
    assert.equal(input.name, 'Code');
    assert.equal((await action('fill-ref', { ref: input.ref, value: 'form-42' })).status, 200);
    const stale = await action('fill-ref', { ref: input.ref, value: 'wrong' });
    assert.equal(stale.status, 409);
    const secondRead = await action('read');
    const button = secondRead.body.elements.find(element => element.role === 'button');
    assert.equal(button.name, 'Send');
    assert.equal((await action('click-ref', { ref: button.ref })).status, 200);
    assert.match((await action('read')).body.text, /form-42/);
    assert.match((await action('current-url')).body.url, /^http:\/\/127\.0\.0\.1:/);
    await call('/release', { ...owner, leaseId });
  } finally {
    site.close();
    if (child.exitCode === null) {
      const exited = new Promise(resolveExit => child.once('exit', resolveExit));
      child.send({ type: 'shutdown' });
      await exited;
    }
  }
});
