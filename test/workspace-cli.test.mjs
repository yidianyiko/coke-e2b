import { createHash } from 'node:crypto';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, symlinkSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
const cli = new URL('../src/workspace-cli.mjs', import.meta.url);
function fixture(t) {
 const root = mkdtempSync(join(tmpdir(), 'coke-workspace-'));
 t.after(() => rmSync(root, {recursive:true, force:true}));
 return {root, call(action, extra={}) {const p=spawnSync(process.execPath,[cli.pathname,'workspace',action],{encoding:'utf8',env:{...process.env,COKE_WORKSPACE_ROOT:root,COKE_TOOL_REQUEST:JSON.stringify({userId:'user',taskId:'task',action,...extra})}}); return {status:p.status,...JSON.parse(p.stdout || p.stderr)};}};
}
test('task workspace writes and reads bounded UTF8 content; replay preserves newer file',t=>{
 const f=fixture(t);
 assert.equal(f.call('write',{path:'report.txt',value:'你好',idempotencyKey:'one'}).status,0);
 assert.equal(f.call('read',{path:'report.txt'}).result.value,'你好');
 assert.equal(f.call('write',{path:'report.txt',value:'new',idempotencyKey:'two'}).status,0);
 assert.equal(f.call('write',{path:'report.txt',value:'你好',idempotencyKey:'one'}).status,0);
 assert.equal(f.call('read',{path:'report.txt'}).result.value,'new');
 assert.equal(f.call('write',{path:'other.txt',value:'你好',idempotencyKey:'one'}).error.code,'IDEMPOTENCY_CONFLICT');
});
test('rejects invalid paths, input and oversized UTF8',t=>{
 const f=fixture(t);
 for(const path of ['../escape','/tmp/escape','C:/escape','a/../b','.coke/record','a\\b']) assert.equal(f.call('write',{path,value:'x',idempotencyKey:'k'}).error.code,'INVALID_WORKSPACE_PATH');
 assert.equal(f.call('write',{path:'x',value:'界'.repeat(22000),idempotencyKey:'k'}).error.code,'WORKSPACE_FILE_TOO_LARGE');
 assert.equal(f.call('write',{path:'x',value:'\ud800',idempotencyKey:'k'}).error.code,'INVALID_WORKSPACE_UTF8');
 assert.equal(f.call('write',{path:'x',value:'x'}).error.code,'INVALID_TOOL_REQUEST');
});
test('rejects symlink roots, parents and targets; task scopes are independent',t=>{
 const f=fixture(t);
 assert.equal(f.call('write',{path:'safe.txt',value:'private',idempotencyKey:'setup'}).status,0);
 const scope=join(f.root,createHash('sha256').update(JSON.stringify(['user','task'])).digest('hex'));
 const outside=join(f.root,'outside'); mkdirSync(outside);
 writeFileSync(join(outside,'secret'),'secret');
 symlinkSync(outside,join(scope,'link'));
 symlinkSync(join(outside,'secret'),join(scope,'target'));
 symlinkSync(join(outside,'missing'),join(scope,'dangling'));
 for(const path of ['link/secret','target','dangling']) {
  assert.equal(f.call('read',{path}).error.code,'UNSAFE_WORKSPACE_PATH');
  assert.equal(f.call('write',{path,value:'replace',idempotencyKey:path}).error.code,'UNSAFE_WORKSPACE_PATH');
 }
 assert.equal(readFileSync(join(outside,'secret'),'utf8'),'secret');
 assert.equal(f.call('read',{path:'safe.txt',userId:'other'}).error.code,'WORKSPACE_FILE_NOT_FOUND');
 assert.equal(f.call('read',{path:'safe.txt',taskId:'other'}).error.code,'WORKSPACE_FILE_NOT_FOUND');
});
test('pending journal recovers interrupted rename and refuses changed external outcome',t=>{
 const f=fixture(t);
 const digest=value=>createHash('sha256').update(value).digest('hex');
 assert.equal(f.call('write',{path:'report',value:'old',idempotencyKey:'initial'}).status,0);
 const scope=join(f.root,digest(JSON.stringify(['user','task'])));
 const record=key=>join(scope,'.coke',`${digest(key)}.json`);
 const pending={version:1,status:'pending',signature:digest(JSON.stringify(['report','new'])),before:digest('old'),result:{path:'report',bytes:3}};
 writeFileSync(record('interrupted'),JSON.stringify(pending));
 assert.equal(f.call('write',{path:'report',value:'new',idempotencyKey:'interrupted'}).status,0);
 assert.equal(f.call('read',{path:'report'}).result.value,'new');
 // Interruption after rename but before journal completion.
 writeFileSync(record('after-rename'),JSON.stringify(pending));
 assert.equal(f.call('write',{path:'report',value:'new',idempotencyKey:'after-rename'}).status,0);
 writeFileSync(record('conflict'),JSON.stringify(pending));
 writeFileSync(join(scope,'report'),'externally changed');
 assert.equal(f.call('write',{path:'report',value:'new',idempotencyKey:'conflict'}).error.code,'WORKSPACE_RECOVERY_CONFLICT');
 assert.equal(readFileSync(join(scope,'report'),'utf8'),'externally changed');
 mkdirSync(join(scope,'.coke','lock'));
 assert.equal(f.call('read',{path:'report'}).error.code,'WORKSPACE_BUSY');
});
test('read rejects invalid UTF8 and oversized existing files',t=>{
 const f=fixture(t);
 assert.equal(f.call('write',{path:'report',value:'ok',idempotencyKey:'setup'}).status,0);
 const scope=join(f.root,createHash('sha256').update(JSON.stringify(['user','task'])).digest('hex'));
 writeFileSync(join(scope,'report'),Buffer.from([0xff]));
 assert.equal(f.call('read',{path:'report'}).error.code,'INVALID_WORKSPACE_UTF8');
 writeFileSync(join(scope,'report'),Buffer.alloc(65537));
 assert.equal(f.call('read',{path:'report'}).error.code,'WORKSPACE_FILE_TOO_LARGE');
});
