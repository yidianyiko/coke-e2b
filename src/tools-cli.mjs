#!/usr/bin/env node

import {randomUUID} from 'node:crypto';

const actions = new Set(['acquire', 'navigate', 'read', 'click-link', 'click-ref', 'fill-ref', 'current-url', 'extract', 'screenshot', 'release']);
const [family, action] = process.argv.slice(2);
let dispatched = false;
let gatewaySignal;

try {
  if (family !== 'browser' || !actions.has(action)) throw new Error('Unknown tool action');
  const request = JSON.parse(process.env.COKE_TOOL_REQUEST || '{}');
  if (!request.taskId || !request.userId || request.action !== action) {
    throw new Error('Invalid task-bound tool request');
  }
  if (action !== 'acquire' && !request.leaseId) throw new Error('Browser lease is required');
  let result;
  if (process.env.COKE_BROWSER_GATEWAY_URL) {
    const url = new URL(process.env.COKE_BROWSER_GATEWAY_URL);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/' || !process.env.COKE_BROWSER_GATEWAY_TOKEN) throw new Error('Invalid browser gateway configuration');
    gatewaySignal = AbortSignal.timeout(13000);
    dispatched = true;
    const response = await fetch(new URL('/v1/browser/action', url), {
      method: 'POST', headers: {authorization: `Bearer ${process.env.COKE_BROWSER_GATEWAY_TOKEN}`, 'content-type': 'application/json'},
      body: JSON.stringify({...request, requestId: randomUUID()}), signal: gatewaySignal, redirect: 'error',
    });
    result = await response.json();
    if (!response.ok) { const code = /^[A-Z_]+$/.test(result.error?.code) ? result.error.code : 'BROWSER_GATEWAY_FAILED'; process.stderr.write(`${JSON.stringify({error:{code}})}\n`); process.exit(1); }
  }
  process.stdout.write(`${JSON.stringify({ schemaVersion: 1, family, ...request, ...(result === undefined ? {} : {result,transport:'https-gateway'}) })}\n`);
} catch (error) {
  const code = dispatched ? (gatewaySignal?.aborted ? 'BROWSER_GATEWAY_TIMEOUT' : 'BROWSER_GATEWAY_UNAVAILABLE') : 'INVALID_TOOL_REQUEST';
  process.stderr.write(`${JSON.stringify({ error: { code } })}\n`);
  process.exitCode = 1;
}
