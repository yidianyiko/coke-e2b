import test from 'node:test';
import assert from 'node:assert/strict';
import {runSetupCommand} from '../src/e2b-setup.mjs';
test('setup uses SDK sixty-second default capped by remaining task budget',async()=>{
 for(const [remaining,expected] of [[90000,60000],[12000,12000]]) {
  let options;const signal=new AbortController().signal;const trace=[];
  const sandbox={commands:{run:async(_command,opts)=>{options=opts;return{exitCode:0,stdout:'private output'};}}};
  await runSetupCommand(sandbox,'opaque-command',{deadline:100000+remaining,now:()=>100000,signal,phase:'browser-cli-hash',trace});
  assert.equal(options.timeoutMs,expected);assert.equal(options.requestTimeoutMs,expected);assert.equal(options.signal,signal);
  assert.equal(trace[0].phase,'browser-cli-hash');assert.equal(JSON.stringify(trace).includes('private output'),false);
 }
});
test('setup forwards task abort and records its failed phase without retry',async()=>{
 const controller=new AbortController();const reason=new Error('TASK_TIMEOUT');let calls=0;const trace=[];
 const sandbox={commands:{run:async(_command,{signal})=>{calls++;return new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));}}};
 const pending=runSetupCommand(sandbox,'opaque-command',{deadline:Date.now()+90000,signal:controller.signal,phase:'workspace-root',trace});
 controller.abort(reason);
 await assert.rejects(pending,error=>error===reason);assert.equal(calls,1);assert.equal(trace[0].ok,false);assert.equal(trace[0].phase,'workspace-root');
});
test('expired setup budget never sends a remote command',async()=>{
 const sandbox={commands:{run:async()=>assert.fail('must not issue expired setup request')}};
 await assert.rejects(runSetupCommand(sandbox,'opaque-command',{deadline:1,now:()=>2,signal:new AbortController().signal,phase:'hash',trace:[]}),/^Error: TASK_TIMEOUT/);
});
