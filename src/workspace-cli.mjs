#!/usr/bin/env node
import * as fs from 'node:fs';
import { resolve, join, dirname, sep } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

const LIMIT = 64 * 1024;
const hash = value => createHash('sha256').update(value).digest('hex');
const fail = code => { throw Object.assign(new Error(code), {code}); };
function safeDirectory(path, create = false) {
  const absolute = resolve(path);
  let current = sep;
  for (const part of absolute.split(sep).filter(Boolean)) {
    current = join(current, part);
    if (!fs.existsSync(current)) {
      // lstat detects dangling links that existsSync intentionally ignores.
      try { fs.lstatSync(current); fail('UNSAFE_WORKSPACE_PATH'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (!create) fail('WORKSPACE_NOT_FOUND');
      fs.mkdirSync(current, {mode:0o700});
    }
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) fail('UNSAFE_WORKSPACE_PATH');
  }
  return absolute;
}
function atomic(path, value) {
  const temp = join(dirname(path), `.coke-${randomUUID()}.tmp`);
  const fd = fs.openSync(temp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
  try { fs.writeFileSync(fd,value); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  try { fs.renameSync(temp,path); const dir=fs.openSync(dirname(path),'r'); try {fs.fsyncSync(dir);} finally {fs.closeSync(dir);} }
  finally {fs.rmSync(temp,{force:true});}
}
function read(path) {
  const fd=fs.openSync(path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat=fs.fstatSync(fd);
    if (!stat.isFile()) fail('UNSAFE_WORKSPACE_PATH');
    if (stat.size > LIMIT) fail('WORKSPACE_FILE_TOO_LARGE');
    const buffer=Buffer.alloc(LIMIT+1);
    const bytes=fs.readSync(fd,buffer,0,buffer.length,0);
    if (bytes > LIMIT) fail('WORKSPACE_FILE_TOO_LARGE');
    try { return new TextDecoder('utf-8',{fatal:true}).decode(buffer.subarray(0,bytes)); }
    catch {fail('INVALID_WORKSPACE_UTF8');}
  } finally {fs.closeSync(fd);}
}
function fingerprint(path) {
  try {return hash(read(path));} catch(error) {if(error.code==='ENOENT') return null; throw error;}
}
let lock;
try {
  const [family,action,...rest]=process.argv.slice(2);
  let request;
  try {request=JSON.parse(process.env.COKE_TOOL_REQUEST || '{}');} catch {fail('INVALID_TOOL_REQUEST');}
  if(family!=='workspace' || !['read','write'].includes(action) || rest.length || !request || typeof request!=='object' || request.action!==action || !['userId','taskId'].every(key=>typeof request[key]==='string' && request[key].length>0 && request[key].length<=256)) fail('INVALID_TOOL_REQUEST');
  if(typeof request.path!=='string' || request.path.length===0 || request.path.length>1024 || request.path.includes(':') || request.path.includes('\\') || request.path.includes('\0') || request.path.startsWith('/') || request.path.split('/').some(p=>!p || p==='.' || p==='..' || p.startsWith('.coke'))) fail('INVALID_WORKSPACE_PATH');
  if(action==='write' && (typeof request.value!=='string' || typeof request.idempotencyKey!=='string' || !request.idempotencyKey.length || request.idempotencyKey.length>256)) fail('INVALID_TOOL_REQUEST');
  if(action==='write' && !request.value.isWellFormed()) fail('INVALID_WORKSPACE_UTF8');
  if(action==='write' && Buffer.byteLength(request.value,'utf8')>LIMIT) fail('WORKSPACE_FILE_TOO_LARGE');
  if(!process.env.COKE_WORKSPACE_ROOT) fail('WORKSPACE_ROOT_REQUIRED');
  const root=safeDirectory(process.env.COKE_WORKSPACE_ROOT);
  const scope=safeDirectory(join(root,hash(JSON.stringify([request.userId,request.taskId]))),true);
  const internal=safeDirectory(join(scope,'.coke'),true);
  const lockPath=join(internal,'lock');
  // Single-writer lock: no stale-lock stealing. A killed process leaves a safe BUSY
  // boundary for host reconciliation rather than risking concurrent replay.
  try {fs.mkdirSync(lockPath,{mode:0o700}); lock=lockPath;} catch(error) {if(error.code==='EEXIST') fail('WORKSPACE_BUSY');throw error;}
  const target=join(scope,request.path);
  safeDirectory(dirname(target),action==='write');
  try {if(!fs.lstatSync(target).isFile()) fail('UNSAFE_WORKSPACE_PATH');} catch(error) {if(error.code!=='ENOENT') throw error;}
  let result;
  if(action==='read') result={path:request.path,value:read(target)};
  else {
    const recordPath=join(internal,`${hash(request.idempotencyKey)}.json`);
    let record;
    try {record=JSON.parse(read(recordPath));} catch(error) {if(error.code!=='ENOENT') throw error;}
    const signature=hash(JSON.stringify([request.path,request.value]));
    if(record && record.signature!==signature) fail('IDEMPOTENCY_CONFLICT');
    if(!record) {
      record={version:1,status:'pending',signature,before:fingerprint(target),result:{path:request.path,bytes:Buffer.byteLength(request.value,'utf8')}};
      atomic(recordPath,JSON.stringify(record));
    }
    if(record.status==='pending') {
      const current=fingerprint(target);
      if(current!==hash(request.value) && current!==record.before) fail('WORKSPACE_RECOVERY_CONFLICT');
      if(current!==hash(request.value)) atomic(target,request.value);
      record.status='complete';
      atomic(recordPath,JSON.stringify(record));
    }
    result=record.result;
  }
  process.stdout.write(`${JSON.stringify({schemaVersion:1,family:'workspace',action,userId:request.userId,taskId:request.taskId,result})}\n`);
} catch(error) {
  const known=new Set(['INVALID_TOOL_REQUEST','INVALID_WORKSPACE_PATH','WORKSPACE_FILE_TOO_LARGE','INVALID_WORKSPACE_UTF8','WORKSPACE_ROOT_REQUIRED','WORKSPACE_NOT_FOUND','UNSAFE_WORKSPACE_PATH','IDEMPOTENCY_CONFLICT','WORKSPACE_RECOVERY_CONFLICT','WORKSPACE_BUSY']);
  const code=known.has(error.code)?error.code:error.code==='ENOENT'?'WORKSPACE_FILE_NOT_FOUND':error.code==='ELOOP'?'UNSAFE_WORKSPACE_PATH':'WORKSPACE_IO_ERROR';
  process.stderr.write(`${JSON.stringify({error:{code,message:code}})}\n`);
  process.exitCode=1;
} finally {if(lock) fs.rmdirSync(lock);}
