#!/usr/bin/env node
import { fork, execFile } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { Sandbox } from 'e2b';
import { TaskTrace, summarizeUsage, inspectTask, parseTimeoutMs, startTaskDeadline } from '../src/task-observability.mjs';
import { ProfileStore, profileDescriptor } from '../src/profile-store.mjs';
import { sandboxCleanupOptions } from '../src/sandbox-cleanup.mjs';
import { stopService, serviceExited } from '../src/service-process.mjs';
import { TaskStore, userScope } from '../src/task-store.mjs';
import { runSetupCommand } from '../src/e2b-setup.mjs';
import { runAgentLoop } from '../src/agent-loop.mjs';
import {browserFailureCode, remoteBrowserFailure} from '../src/browser-errors.mjs';

const execFileAsync = promisify(execFile);
const WORKSPACE_CLI_PATH = '/opt/coke/workspace-cli.mjs';
const E2B_TEMPLATE = 'coke-task-cli:v3';
const E2B_CLI_PATH = '/opt/coke/tools-cli.mjs';

function errorCode(error) {
  return browserFailureCode(error) || /^(?:(?:MODEL_|WORKSPACE_|INVALID_WORKSPACE_|UNSAFE_WORKSPACE_)[A-Z_]+|TASK_(?:TIMEOUT|CANCELLED|NOT_FOUND|FAILED)|BROWSER_SERVICE_EXITED|IDEMPOTENCY_CONFLICT|INVALID_TIMEOUT)(?=:|$)/.exec(error.message)?.[0] || 'TASK_FAILED';
}

function parse(argv) {
  if (argv[0] !== 'task' || argv[1] !== 'run' || !argv[2]) {
    throw new Error('Usage: coke task run "<task>" --runtime local --url <url> --link-text <text> --value-selector <selector>');
  }
  const options = { task: argv[2], runtime: 'local', user: 'local-user', outputDir: resolve('artifacts') };
  for (let index = 3; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith('--') || !value) throw new Error(`Invalid option: ${key}`);
    const name = {
      '--runtime': 'runtime', '--user': 'user', '--url': 'url',
      '--link-text': 'linkText', '--value-selector': 'valueSelector',
      '--output-dir': 'outputDir', '--model': 'model', '--max-steps': 'maxSteps', '--timeout-ms': 'timeoutMs', '--profile': 'profileName', '--profile-dir': 'profileDir',
    }[key];
    if (!name) throw new Error(`Unknown option: ${key}`);
    options[name] = value;
  }
  for (const name of options.model ? ['url'] : ['url', 'linkText', 'valueSelector']) {
    if (!options[name]) throw new Error(`Missing --${name.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`)}`);
  }
  if (!['local', 'e2b'].includes(options.runtime)) throw new Error(`Unknown runtime: ${options.runtime}`);
  options.maxSteps = options.maxSteps === undefined ? 6 : Number(options.maxSteps);
  if (!Number.isInteger(options.maxSteps) || options.maxSteps < 1 || options.maxSteps > 20) {
    throw new Error('--max-steps must be an integer from 1 to 20');
  }
  options.timeoutMs = parseTimeoutMs(options.timeoutMs);
  options.outputDir = resolve(options.outputDir);
  return options;
}

function traceResult(action, data) {
  switch (action) {
    case 'acquire': return { leaseId: data.leaseId };
    case 'navigate':
    case 'click-link':
    case 'click-ref':
    case 'fill-ref':
    case 'current-url': return { url: data.url };
    case 'read': return { url: data.url, textLength: data.text.length, elementCount: data.elements?.length || 0 };
    case 'extract': return { url: data.url, value: data.value };
    case 'screenshot': return { url: data.url, byteLength: Buffer.byteLength(data.pngBase64, 'base64') };
    case 'release': return { released: data.released };
    default: return {};
  }
}

function startService(token, overrides = {}) {
  const child = fork(fileURLToPath(new URL('../src/browser-server.mjs', import.meta.url)), [], {
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    env: { ...process.env, COKE_BROWSER_TOKEN: token, ...overrides },
  });
  return new Promise((resolveStart, reject) => {
    const cleanup = () => {
      clearTimeout(timeout);
      child.off('message', onMessage);
      child.off('exit', onExit);
      child.off('error', onError);
    };
    const fail = error => {
      cleanup();
      if (child.exitCode === null) child.kill('SIGKILL');
      reject(error);
    };
    const onMessage = message => {
      if (message?.type !== 'ready') return;
      cleanup();
      resolveStart({ child, port: message.port });
    };
    const onExit = code => fail(new Error(`Browser service exited during startup: ${code}`));
    const onError = error => fail(error);
    const timeout = setTimeout(() => fail(new Error('Browser service did not start')), 15_000);
    child.on('message', onMessage);
    child.once('exit', onExit);
    child.once('error', onError);
  });
}


async function run(options) {
  try {
    process.loadEnvFile(fileURLToPath(new URL('../.env.local', import.meta.url)));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const store = new TaskStore(options.outputDir);
  const record = await store.create(options.user, options.runtime);
  const taskId = record.taskId;
  const token = randomBytes(32).toString('hex');
  const trace = new TaskTrace();
  const resourceTimes = {};
  const limits = {timeoutMs:options.timeoutMs,maxSteps:options.maxSteps,maxBrowserContexts:1};
  await store.update(options.user,taskId,{limits});
  let child;
  let normalBrowserShutdown = false;
  let unexpectedBrowserExit = false;
  let leaseId;
  let gatewayReady=false;
  const gatewayToken=randomBytes(32).toString('hex');
  let sandbox;
  let sandboxKilled = false;
  let call;
  let outcome;
  let failure;
  let screenshotBytes;
  let screenshotSaved = false;
  const workspaceArtifacts = [];
  const workspacePaths = new Set();
  const localWorkspaceRoot = join(record.artifactDir, '.workspace');
  const workspaceRoot = options.runtime === 'e2b' ? '/tmp/coke-workspace' : localWorkspaceRoot;
  const workspaceScope = createHash('sha256').update(JSON.stringify([options.user, taskId])).digest('hex');
  const screenshotPath = join(record.artifactDir, 'screenshot.png');
  const cancellation = new AbortController();
  const setupDeadline = Date.now() + options.timeoutMs;
  const clearDeadline = startTaskDeadline(cancellation, options.timeoutMs);
  const cancelledCode = () => cancellation.signal.reason?.message === 'TASK_TIMEOUT' ? 'TASK_TIMEOUT' : 'TASK_CANCELLED';
  const onCancel = () => cancellation.abort(new Error('Task cancelled'));
  process.on('SIGINT', onCancel);
  process.on('SIGTERM', onCancel);
  try {
    const service = await startService(token, { COKE_PROFILE_ROOT: options.profileDir || fileURLToPath(new URL('../.coke-private/profiles', import.meta.url)) });
    child = service.child;
    child.once('exit', () => { if (!normalBrowserShutdown) unexpectedBrowserExit = true; });
    resourceTimes.browserStartedAt = Date.now();
    await store.update(options.user, taskId, { browserPid: child.pid, ...resourceTimes });
    if (options.runtime === 'e2b') {
      if (!process.env.E2B_API_KEY) throw new Error('E2B_API_KEY is required');
      sandbox = await Sandbox.create(E2B_TEMPLATE, { timeoutMs: options.timeoutMs + 30_000, metadata: { cokeApp: 'coke-e2b', cokeExpiresAt: String(Date.now() + options.timeoutMs + 30_000), cokeTask: taskId, cokeUser: userScope(options.user) } });
      resourceTimes.sandboxStartedAt = Date.now();
      await store.update(options.user, taskId, { sandboxId: sandbox.sandboxId, ...resourceTimes });
      if (cancellation.signal.aborted) throw cancellation.signal.reason;
      const localCliSha256 = createHash('sha256')
        .update(await readFile(new URL('../src/tools-cli.mjs', import.meta.url))).digest('hex');
      const setup = (command, phase) => runSetupCommand(sandbox,command,{deadline:setupDeadline,signal:cancellation.signal,phase,trace});
      const remoteHash = await setup(
        `node -e "const c=require('node:crypto');const f=require('node:fs');process.stdout.write(c.createHash('sha256').update(f.readFileSync('${E2B_CLI_PATH}')).digest('hex'))"`,
        'browser-cli-hash',
      );
      if (remoteHash.exitCode !== 0 || remoteHash.stdout.trim() !== localCliSha256) {
        throw new Error('E2B task template CLI version does not match local package');
      }
      options.cliSha256 = localCliSha256;
      const workspaceHash = createHash('sha256').update(await readFile(new URL('../src/workspace-cli.mjs', import.meta.url))).digest('hex');
      const remoteWorkspaceHash = await setup(`node -e "const c=require('node:crypto');const f=require('node:fs');process.stdout.write(c.createHash('sha256').update(f.readFileSync('${WORKSPACE_CLI_PATH}')).digest('hex'))"`, 'workspace-cli-hash');
      if (remoteWorkspaceHash.exitCode !== 0 || remoteWorkspaceHash.stdout.trim() !== workspaceHash) throw new Error('WORKSPACE_CLI_VERSION_MISMATCH: E2B workspace CLI does not match local package');
      options.workspaceCliSha256 = workspaceHash;
      await setup('mkdir -p /tmp/coke-workspace', 'workspace-root');
    }
    if (!sandbox) await mkdir(localWorkspaceRoot, {recursive:true,mode:0o700});
    const workspaceCall = async decision => {
      if (cancellation.signal.aborted) throw cancellation.signal.reason;
      const action = decision.action.slice('workspace-'.length);
      const request = {userId:options.user,taskId,action,path:decision.path,...(action === 'write' ? {value:decision.value,idempotencyKey:decision.idempotencyKey} : {})};
      const envs = {COKE_TOOL_REQUEST:JSON.stringify(request),COKE_WORKSPACE_ROOT:workspaceRoot};
      let command;
      if (sandbox) command = await sandbox.commands.run(`node ${WORKSPACE_CLI_PATH} workspace ${action}`, {envs,timeoutMs:15_000,signal:cancellation.signal});
      else {
        try {const local=await execFileAsync(process.execPath,[fileURLToPath(new URL('../src/workspace-cli.mjs',import.meta.url)),'workspace',action],{env:{...process.env,...envs},timeout:15_000,signal:cancellation.signal,maxBuffer:256*1024});command={exitCode:0,...local};}
        catch(error) {if(cancellation.signal.aborted) throw cancellation.signal.reason;command={exitCode:1,stderr:error.stderr};}
      }
      let data;
      try {data=JSON.parse(command.exitCode===0?command.stdout:command.stderr);} catch {throw new Error('WORKSPACE_INVALID_RESPONSE: invalid workspace CLI output');}
      if(command.exitCode!==0) {const code=/^(?:WORKSPACE_|INVALID_WORKSPACE_|INVALID_TOOL_REQUEST$|UNSAFE_WORKSPACE_|IDEMPOTENCY_CONFLICT$)/.test(data.error?.code)?data.error.code:'WORKSPACE_CLI_FAILED';trace.push({action:decision.action,ok:false,source:`${options.runtime}-cli`,error:code});throw new Error(`${code}: workspace operation failed`);}
      if(data.schemaVersion!==1 || data.family!=='workspace' || data.userId!==options.user || data.taskId!==taskId || data.action!==action || data.result?.path!==decision.path) throw new Error('WORKSPACE_RESPONSE_MISMATCH: workspace CLI task binding mismatch');
      const result=data.result;
      if (action==='read' ? typeof result.value!=='string' || Buffer.byteLength(result.value,'utf8')>64*1024 : !Number.isInteger(result.bytes) || result.bytes<0 || result.bytes>64*1024) throw new Error('WORKSPACE_INVALID_RESPONSE: invalid workspace result');
      trace.push({action:decision.action,ok:true,source:`${options.runtime}-cli`,result:{path:result.path,bytes:action==='read'?Buffer.byteLength(result.value,'utf8'):result.bytes}});
      if(action==='write') workspacePaths.add(result.path);
      return result;
    };
    call = async (route, action, payload = {}, bypassRemote = false) => {
      if (cancellation.signal.aborted && action !== 'release' && !bypassRemote) throw cancellation.signal.reason;
      let request = { userId: options.user, taskId, leaseId, action, ...payload };
      if (sandbox && !bypassRemote && (gatewayReady || !process.env.COKE_BROWSER_GATEWAY_URL) && action !== 'release') {
        let command;
        try {command = await sandbox.commands.run(`node ${E2B_CLI_PATH} browser ${action}`, {
          envs: { COKE_TOOL_REQUEST: JSON.stringify(request), ...(gatewayReady ? {COKE_BROWSER_GATEWAY_URL:process.env.COKE_BROWSER_GATEWAY_URL,COKE_BROWSER_GATEWAY_TOKEN:gatewayToken} : {}) },
          timeoutMs: 15_000,
          signal: cancellation.signal,
        });}catch(error){
          if(cancellation.signal.aborted)throw cancellation.signal.reason;
          const failure=remoteBrowserFailure(error);
          trace.push({action,ok:false,source:'e2b-cli',error:browserFailureCode(failure)});
          throw failure;
        }
        if (command.exitCode !== 0) {
          const failure=remoteBrowserFailure(command);
          trace.push({action,ok:false,source:'e2b-cli',error:browserFailureCode(failure)});
          throw failure;
        }
        const normalized = JSON.parse(command.stdout.trim());
        if (normalized.schemaVersion !== 1 || normalized.family !== 'browser'
          || normalized.action !== action || normalized.userId !== options.user
          || normalized.taskId !== taskId || normalized.leaseId !== leaseId) {
          trace.push({ action, ok: false, source: 'e2b-cli', error: 'REMOTE_REQUEST_MISMATCH' });
          throw new Error(`Remote CLI returned a mismatched ${action} request`);
        }
        if(gatewayReady){
          if(normalized.transport!=='https-gateway'||!normalized.result)throw new Error('REMOTE_RESPONSE_MISMATCH');
          trace.push({action,ok:true,source:'e2b-https-gateway',result:traceResult(action,normalized.result)});
          return normalized.result;
        }
        request = normalized;
      }
      const response = await fetch(`http://127.0.0.1:${service.port}${route}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify(request),
        signal: bypassRemote ? AbortSignal.timeout(5_000) : cancellation.signal,
      });
      const data = await response.json();
      trace.push(response.ok
        ? { action, ok: true, source: sandbox && !bypassRemote ? 'e2b-cli' : 'local-cli', result: traceResult(action, data) }
        : { action, ok: false, source: sandbox && !bypassRemote ? 'e2b-cli' : 'local-cli', error: data.error?.code });
      if (!response.ok) throw new Error(`${data.error.code}: ${data.error.message || ''}`.trim());
      return data;
    };
    leaseId = (await call('/acquire', 'acquire', options.profileName ? { profile: profileDescriptor({ name: options.profileName, origin: new URL(options.url).origin }) } : {})).leaseId;
    if(sandbox&&process.env.COKE_BROWSER_GATEWAY_URL){
      if(!process.send)throw new Error('BROWSER_GATEWAY_REGISTRATION_REQUIRED');
      await new Promise((yes,no)=>{
        const onMessage=message=>{if(message?.type==='browser-gateway-ready'){clearTimeout(timer);process.off('message',onMessage);yes()}};
        const timer=setTimeout(()=>{process.off('message',onMessage);no(new Error('BROWSER_GATEWAY_REGISTRATION_TIMEOUT'))},5000);
        process.on('message',onMessage);
        process.send({type:'browser-gateway-register',scope:{token:gatewayToken,browserToken:token,port:service.port,userId:options.user,taskId,leaseId,expiresAt:setupDeadline}});
      });
      gatewayReady=true;
    }
    await store.update(options.user, taskId, { leaseId });
    screenshotBytes = Buffer.from((await call('/action', 'screenshot')).pngBase64, 'base64');
    await call('/action', 'navigate', { url: options.url });
    screenshotBytes = Buffer.from((await call('/action', 'screenshot')).pngBase64, 'base64');
    let extracted;
    if (options.model) {
      extracted = await runAgentLoop({ options, call, workspaceCall, trace, signal: cancellation.signal });
    } else {
      await call('/action', 'read');
      await call('/action', 'click-link', { linkText: options.linkText });
      await call('/action', 'read');
      extracted = await call('/action', 'extract', { selector: options.valueSelector });
    }
    const screenshot = await call('/action', 'screenshot');
    screenshotBytes = Buffer.from(screenshot.pngBase64, 'base64');
    outcome = { taskId, leaseId, sandboxId: sandbox?.sandboxId, template: sandbox ? E2B_TEMPLATE : undefined, cliSha256: options.cliSha256, workspaceCliSha256: options.workspaceCliSha256, workspaceArtifacts, modelAdapter: options.model ? 'openai-compatible' : undefined, model: options.model, finalUrl: extracted.url, value: extracted.value, screenshotPath, trace };
  } catch (error) {
    failure = child && serviceExited(child) ? new Error('BROWSER_SERVICE_EXITED: browser lease is no longer available') : error;
  } finally {
    if (failure && leaseId && call) {
      try {
        screenshotBytes = Buffer.from((await call('/action', 'screenshot', {}, true)).pngBase64, 'base64');
      } catch {
        // Preserve the last successfully captured page when the live page is unavailable.
      }
    }
    if (screenshotBytes) {
      try {
        await mkdir(options.outputDir, { recursive: true });
        await writeFile(screenshotPath, screenshotBytes, { mode: 0o600 });
        screenshotSaved = true;
      } catch (error) {
        failure ||= error;
      }
    }
    for (const path of workspacePaths) {
      try {
        const source = join(workspaceRoot, workspaceScope, path);
        const value = sandbox ? await sandbox.files.read(source, {format:'bytes'}) : await readFile(source);
        if(value.byteLength > 64*1024) throw new Error('WORKSPACE_FILE_TOO_LARGE: workspace export rejected');
        const artifactPath = join(record.artifactDir, `workspace-${createHash('sha256').update(path).digest('hex')}.txt`);
        await writeFile(artifactPath,value,{mode:0o600});
        workspaceArtifacts.push({path,artifactPath,bytes:value.byteLength});
      } catch(error) {failure ||= error;}
    }
    if (!sandbox) await rm(localWorkspaceRoot,{recursive:true,force:true});
    if(gatewayReady&&process.connected)process.send({type:'browser-gateway-revoke'});
    if (leaseId && call) {
      try {
        await call('/release', 'release', {}, cancellation.signal.aborted);
      } catch (error) {
        try {
          await call('/release', 'release', {}, true);
        } catch (fallbackError) {
          failure ||= fallbackError;
        }
      }
    }
    if (sandbox) {
      try {
        sandboxKilled = await sandbox.kill();
        resourceTimes.sandboxFinishedAt = Date.now();
      } catch (error) {
        failure ||= error;
      }
    }
    try {
      normalBrowserShutdown = true;
      const stopped = await stopService(child);
      if (unexpectedBrowserExit || child && (child.exitCode !== null && child.exitCode !== 0 || child.signalCode !== null && !stopped.requestedSignals.includes(child.signalCode))) {
        failure = new Error('BROWSER_SERVICE_EXITED: browser lease is no longer available');
      }
      resourceTimes.browserFinishedAt = Date.now();
    } catch (error) {
      failure ||= error;
    }
    if (cancellation.signal.aborted) failure = new Error(`${cancelledCode()}: task interrupted`);
    resourceTimes.finishedAt = Date.now();
    await store.update(options.user, taskId, {
      ...resourceTimes, limits,
      status: cancellation.signal.aborted ? 'cancelled' : failure ? 'failed' : 'succeeded',
      resourcesReleased: (!sandbox || sandboxKilled) && serviceExited(child),
      sandboxKilled, screenshotPath: screenshotSaved ? screenshotPath : undefined,
      trace, workspaceArtifacts, result: outcome ? { value: outcome.value, finalUrl: outcome.finalUrl, model: outcome.model } : undefined,
      errorCode: failure ? (cancellation.signal.aborted ? cancelledCode() : errorCode(failure)) : undefined,
    });
    clearDeadline();
    process.off('SIGINT', onCancel);
    process.off('SIGTERM', onCancel);
  }
  if (cancellation.signal.aborted && (!failure || errorCode(failure) !== cancelledCode())) {
    failure = new Error(`${cancelledCode()}: task interrupted during cleanup`);
    await store.update(options.user,taskId,{status:'cancelled',errorCode:cancelledCode()});
  }
  if (failure) {
    failure.taskId = taskId;
    failure.trace = trace;
    failure.workspaceArtifacts = workspaceArtifacts;
    failure.sandboxId = sandbox?.sandboxId;
    failure.sandboxKilled = sandboxKilled;
    if (screenshotSaved) failure.screenshotPath = screenshotPath;
    throw failure;
  }
  return { ...outcome, sandboxKilled, usage:summarizeUsage({...record,...resourceTimes,limits}) };
}

async function profileCommand(argv) {
  const options = { user: 'local-user', profileDir: fileURLToPath(new URL('../.coke-private/profiles', import.meta.url)), timeoutMs: 120_000 };
  if (!['login', 'revoke'].includes(argv[1]) || !argv[2]) throw new Error('Usage: coke profile login|revoke <name> --url <url> [--user <user>] [--profile-dir <dir>]');
  for (let i = 3; i < argv.length; i += 2) {
    const key = { '--url': 'url', '--user': 'user', '--profile-dir': 'profileDir', '--timeout-ms': 'timeoutMs' }[argv[i]];
    if (!key || !argv[i + 1]) throw new Error('Invalid profile option');
    options[key] = argv[i + 1];
  }
  const profile = profileDescriptor({ name: argv[2], origin: new URL(options.url).origin });
  const store = new ProfileStore(options.profileDir);
  if (argv[1] === 'revoke') { await store.revoke(options.user, profile); return { revoked: true, profile: profile.name, origin: profile.origin }; }
  const timeoutMs = parseTimeoutMs(options.timeoutMs);
  const cancellation = new AbortController();
  const cancel = () => cancellation.abort(new Error('PROFILE_LOGIN_CANCELLED'));
  process.on('SIGINT', cancel); process.on('SIGTERM', cancel);
  const timer = setTimeout(() => cancellation.abort(new Error('PROFILE_LOGIN_TIMEOUT')), timeoutMs);
  const token = randomBytes(32).toString('hex');
  let service, leaseId, confirmed = false;
  const taskId = randomUUID();
  const call = async (route, payload, cleanup = false) => {
    const response = await fetch(`http://127.0.0.1:${service.port}${route}`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ userId: options.user, taskId, leaseId, ...payload }), signal: cleanup ? AbortSignal.timeout(5000) : cancellation.signal });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error.code);
    return data;
  };
  try {
    service = await startService(token, { COKE_PROFILE_ROOT: options.profileDir, COKE_BROWSER_HEADLESS: process.env.COKE_BROWSER_HEADLESS || '0' });
    leaseId = (await call('/acquire', { profile })).leaseId;
    await call('/action', { action: 'navigate', url: options.url });
    process.stderr.write('Complete login in the browser, then press Enter to save this profile.\n');
    await new Promise((done, reject) => {
      let text = '';
      const clean = () => { process.stdin.off('data', data); process.stdin.off('end', end); cancellation.signal.removeEventListener('abort', aborted); process.stdin.pause(); };
      const data = chunk => { text += chunk; if (text.includes('\n')) { clean(); done(); } };
      const end = () => { clean(); reject(new Error('PROFILE_LOGIN_UNCONFIRMED')); };
      const aborted = () => { clean(); reject(cancellation.signal.reason); };
      process.stdin.on('data', data); process.stdin.once('end', end); cancellation.signal.addEventListener('abort', aborted, { once: true });
      if (cancellation.signal.aborted) aborted(); else if (process.stdin.readableEnded) end(); else process.stdin.resume();
    });
    confirmed = true;
    return { saved: true, profile: profile.name, origin: profile.origin };
  } finally {
    clearTimeout(timer);
    try { if (leaseId) { const released = await call('/release', { saveProfile: confirmed }, true); if (confirmed && !released.profileSaved) throw new Error('PROFILE_REVOKED'); } }
    finally { await stopService(service?.child); process.off('SIGINT', cancel); process.off('SIGTERM', cancel); }
  }
}

try {
  const argv = process.argv.slice(2);
  let result;
  if (argv[0] === 'profile') result = await profileCommand(argv);
  else if (argv[0] === 'task' && ['trace','usage'].includes(argv[1])) {
    const options = {user:'local-user',outputDir:resolve('artifacts')};
    if(!argv[2]) throw new Error('Task ID is required');
    for(let i=3;i<argv.length;i+=2) {
      if(!['--user','--output-dir'].includes(argv[i]) || !argv[i+1]) throw new Error('Invalid task inspection option');
      options[argv[i]==='--user'?'user':'outputDir']=argv[i+1];
    }
    result=await inspectTask(new TaskStore(options.outputDir),options.user,argv[2],argv[1]);
  } else if (argv[0] === 'task' && argv[1] === 'cleanup') {
    const options = { user: 'local-user', outputDir: resolve('artifacts') };
    for (let i = 2; i < argv.length; i += 2) {
      if (!['--user', '--output-dir'].includes(argv[i]) || !argv[i + 1]) throw new Error('Usage: coke task cleanup [--user <user>] [--output-dir <dir>]');
      options[argv[i] === '--user' ? 'user' : 'outputDir'] = argv[i + 1];
    }
    try { process.loadEnvFile(fileURLToPath(new URL('../.env.local', import.meta.url))); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    result = { tasks: await new TaskStore(options.outputDir).cleanup(options.user, sandboxCleanupOptions(options.user)) };
  } else result = await run(parse(argv));
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) {
  const code = errorCode(error);
  process.stderr.write(`${JSON.stringify({ error: { code, message: error.message }, taskId: error.taskId, sandboxId: error.sandboxId, sandboxKilled: error.sandboxKilled, screenshotPath: error.screenshotPath, workspaceArtifacts: error.workspaceArtifacts || [], trace: error.trace || [] })}\n`);
  process.exitCode = 1;
}

if (process.connected) process.disconnect();
