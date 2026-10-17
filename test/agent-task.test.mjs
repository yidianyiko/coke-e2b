import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

const execFileAsync = promisify(execFile);

test('model chooses a fresh link reference and answers from the destination page', async () => {
  const site = createServer((request, response) => {
    response.setHeader('content-type', 'text/html');
    response.end(request.url === '/'
      ? '<a href="/result">Next</a>'
      : '<main><span id="value">agent-42</span></main>');
  });
  let modelCalls = 0;
  const model = createServer(async (request, response) => {
    assert.equal(request.url, '/v1/chat/completions');
    assert.equal(request.headers.authorization, 'Bearer fixture-secret');
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    assert.equal(body.model, 'fixture-model');
    const observation = JSON.parse(body.messages.at(-1).content);
    modelCalls += 1;
    const decision = modelCalls === 1
      ? { action: 'click-ref', ref: observation.elements[0].ref }
      : { action: 'answer', value: 'agent-42' };
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(decision) } }] }));
  });
  await Promise.all([
    new Promise(resolveListen => site.listen(0, '127.0.0.1', resolveListen)),
    new Promise(resolveListen => model.listen(0, '127.0.0.1', resolveListen)),
  ]);
  const outputDir = await mkdtemp(join(tmpdir(), 'coke-agent-test-'));
  try {
    const { stdout } = await execFileAsync(process.execPath, [
      resolve('bin/coke.mjs'), 'task', 'run', 'Follow Next and report the value',
      '--runtime', 'local', '--url', `http://127.0.0.1:${site.address().port}/`,
      '--model', 'fixture-model', '--output-dir', outputDir,
    ], {
      timeout: 30_000,
      env: {
        ...process.env,
        COKE_MODEL_API_KEY: 'fixture-secret',
        COKE_MODEL_BASE_URL: `http://127.0.0.1:${model.address().port}/v1`,
      },
    });
    const result = JSON.parse(stdout);
    assert.equal(modelCalls, 2);
    assert.equal(result.value, 'agent-42');
    assert.match(result.finalUrl, /\/result$/);
    assert.equal(result.modelAdapter, 'openai-compatible');
    assert.equal(result.model, 'fixture-model');
    assert.equal(result.trace.filter(item => item.action === 'model-decision').length, 2);
    assert.equal(result.trace.filter(item => item.action === 'read').length, 2);
    assert.equal(result.trace.at(-1).action, 'release');
    assert.ok(!stdout.includes('fixture-secret'));
    assert.equal((await readFile(result.screenshotPath)).subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  } finally {
    site.close();
    model.close();
    await rm(outputDir, { recursive: true, force: true });
  }
});

test('model step limit reports a bounded error and releases the browser lease', async () => {
  const site = createServer((_request, response) => {
    response.setHeader('content-type', 'text/html');
    response.end('<a href="/again">Again</a>');
  });
  const model = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const observation = JSON.parse(JSON.parse(Buffer.concat(chunks).toString()).messages.at(-1).content);
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ action: 'click-ref', ref: observation.elements[0].ref }) } }] }));
  });
  await Promise.all([
    new Promise(resolveListen => site.listen(0, '127.0.0.1', resolveListen)),
    new Promise(resolveListen => model.listen(0, '127.0.0.1', resolveListen)),
  ]);
  const outputDir = await mkdtemp(join(tmpdir(), 'coke-agent-limit-'));
  try {
    await assert.rejects(execFileAsync(process.execPath, [
      resolve('bin/coke.mjs'), 'task', 'run', 'Keep following the link',
      '--runtime', 'local', '--url', `http://127.0.0.1:${site.address().port}/`,
      '--model', 'fixture-model', '--max-steps', '1', '--output-dir', outputDir,
    ], {
      timeout: 30_000,
      env: { ...process.env, COKE_MODEL_API_KEY: 'fixture-secret', COKE_MODEL_BASE_URL: `http://127.0.0.1:${model.address().port}/v1` },
    }), error => {
      const result = JSON.parse(error.stderr);
      assert.equal(result.error.code, 'MODEL_STEP_LIMIT');
      assert.equal(result.trace.at(-1).action, 'release');
      assert.ok(result.screenshotPath);
      return true;
    });
  } finally {
    site.close();
    model.close();
    await rm(outputDir, { recursive: true, force: true });
  }
});

test('model-selected action runs its task CLI in a real E2B sandbox', {
  skip: !process.env.RUN_E2B_TEST || !process.env.E2B_API_KEY,
}, async () => {
  const site = createServer((request, response) => {
    response.setHeader('content-type', 'text/html');
    response.end(request.url === '/' ? '<a href="/result">Next</a>' : '<main>e2b-agent-42</main>');
  });
  const model = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const observation = JSON.parse(JSON.parse(Buffer.concat(chunks).toString()).messages.at(-1).content);
    const decision = observation.url.endsWith('/result')
      ? { action: 'answer', value: 'e2b-agent-42' }
      : { action: 'click-ref', ref: observation.elements[0].ref };
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(decision) } }] }));
  });
  await Promise.all([
    new Promise(resolveListen => site.listen(0, '127.0.0.1', resolveListen)),
    new Promise(resolveListen => model.listen(0, '127.0.0.1', resolveListen)),
  ]);
  const outputDir = await mkdtemp(join(tmpdir(), 'coke-e2b-agent-'));
  try {
    const { stdout } = await execFileAsync(process.execPath, [
      resolve('bin/coke.mjs'), 'task', 'run', 'Follow Next and report the value',
      '--runtime', 'e2b', '--url', `http://127.0.0.1:${site.address().port}/`,
      '--model', 'fixture-model', '--output-dir', outputDir,
    ], {
      timeout: 90_000,
      env: { ...process.env, COKE_MODEL_API_KEY: 'fixture-secret', COKE_MODEL_BASE_URL: `http://127.0.0.1:${model.address().port}/v1` },
    });
    const result = JSON.parse(stdout);
    assert.match(result.sandboxId, /^[a-z0-9]+$/);
    assert.equal(result.value, 'e2b-agent-42');
    assert.equal(result.trace.find(item => item.action === 'click-ref').source, 'e2b-cli');
    assert.equal(result.sandboxKilled, true);
    assert.equal((await readFile(result.screenshotPath)).subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  } finally {
    site.close();
    model.close();
    await rm(outputDir, { recursive: true, force: true });
  }
});

test('model can fill a form, click its button, and verify the result', async () => {
  const site = createServer((_request, response) => {
    response.setHeader('content-type', 'text/html');
    response.end('<label for="code">Code</label><input id="code"><button onclick="document.body.append(document.querySelector(\'#code\').value)">Send</button>');
  });
  let modelCalls = 0;
  const model = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const observation = JSON.parse(JSON.parse(Buffer.concat(chunks).toString()).messages.at(-1).content);
    modelCalls += 1;
    const decision = modelCalls === 1
      ? { action: 'fill-ref', ref: observation.elements.find(element => element.role === 'textbox').ref, value: 'form-42' }
      : modelCalls === 2
        ? { action: 'click-ref', ref: observation.elements.find(element => element.role === 'button').ref }
        : { action: 'answer', value: 'form-42' };
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(decision) } }] }));
  });
  await Promise.all([
    new Promise(resolveListen => site.listen(0, '127.0.0.1', resolveListen)),
    new Promise(resolveListen => model.listen(0, '127.0.0.1', resolveListen)),
  ]);
  const outputDir = await mkdtemp(join(tmpdir(), 'coke-agent-form-'));
  try {
    const { stdout } = await execFileAsync(process.execPath, [
      resolve('bin/coke.mjs'), 'task', 'run', 'Enter form-42 in Code, send it, and report the result',
      '--runtime', 'local', '--url', `http://127.0.0.1:${site.address().port}/`,
      '--model', 'fixture-model', '--output-dir', outputDir,
    ], {
      timeout: 30_000,
      env: { ...process.env, COKE_MODEL_API_KEY: 'fixture-secret', COKE_MODEL_BASE_URL: `http://127.0.0.1:${model.address().port}/v1` },
    });
    const result = JSON.parse(stdout);
    assert.equal(modelCalls, 3);
    assert.equal(result.value, 'form-42');
    assert.equal(result.trace.find(item => item.action === 'fill-ref').ok, true);
    assert.equal(result.trace.find(item => item.action === 'click-ref').ok, true);
  } finally {
    site.close();
    model.close();
    await rm(outputDir, { recursive: true, force: true });
  }
});
