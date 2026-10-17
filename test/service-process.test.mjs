import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { stopService } from '../src/service-process.mjs';
test('stopping an already signal-killed service returns without waiting for a second exit', async () => {
 const child = fork(new URL('../src/browser-server.mjs', import.meta.url), [], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'], env: { ...process.env, COKE_BROWSER_TOKEN: 'test-token' } });
 await once(child, 'message');
 const exit = once(child, 'exit');
 child.kill('SIGKILL');
 await exit;
 await Promise.race([stopService(child), new Promise((_, reject) => { const t = setTimeout(() => reject(new Error('stopService hung after signal exit')), 100); t.unref(); })]);
 assert.equal(child.signalCode, 'SIGKILL');
});
