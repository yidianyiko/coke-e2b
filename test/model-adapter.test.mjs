import test from 'node:test';
import assert from 'node:assert/strict';
import {runAgentLoop} from '../src/agent-loop.mjs';
function fixture(t, fetchImpl) {
 const original=globalThis.fetch; const previous=process.env.COKE_MODEL_REASONING_EFFORT; const key=process.env.COKE_MODEL_API_KEY;
 delete process.env.COKE_MODEL_REASONING_EFFORT;process.env.COKE_MODEL_API_KEY='fixture-key';globalThis.fetch=fetchImpl;
 t.after(()=>{globalThis.fetch=original;if(previous===undefined) delete process.env.COKE_MODEL_REASONING_EFFORT;else process.env.COKE_MODEL_REASONING_EFFORT=previous;if(key===undefined) delete process.env.COKE_MODEL_API_KEY;else process.env.COKE_MODEL_API_KEY=key;});
 return (signal=new AbortController().signal)=>runAgentLoop({options:{task:'Read value',model:'fixture-model',maxSteps:1},call:async()=>({url:'https://example.test',text:'verified-value',elements:[]}),trace:[],signal});
}
test('generic model requests omit provider reasoning option when unconfigured',async t=>{
 const run=fixture(t,async(_url,request)=>{assert.equal(Object.hasOwn(JSON.parse(request.body),'reasoning_effort'),false);return Response.json({choices:[{message:{content:JSON.stringify({action:'answer',value:'verified-value'})}}]});});
 assert.equal((await run()).value,'verified-value');
});
test('model network timeout becomes stable MODEL_TIMEOUT',async t=>{
 const run=fixture(t,async()=>{throw new DOMException('Fixture network deadline','TimeoutError');});
 await assert.rejects(run(),/^Error: MODEL_TIMEOUT:/);
});
test('task cancellation preserves original abort reason',async t=>{
 const controller=new AbortController();const reason=new Error('TASK_CANCELLED');controller.abort(reason);
 const run=fixture(t,async()=>{throw reason;});
 await assert.rejects(run(controller.signal),error=>error===reason);
});
test('unsupported reasoning value fails before sending provider request',async t=>{
 const run=fixture(t,async()=>{assert.fail('invalid configuration must not contact provider');});
 process.env.COKE_MODEL_REASONING_EFFORT='medium';
 await assert.rejects(run(),/^Error: MODEL_INVALID_CONFIG:/);
});

test('blank optional reasoning setting keeps provider defaults',async t=>{
 const run=fixture(t,async(_url,request)=>{assert.equal(Object.hasOwn(JSON.parse(request.body),'reasoning_effort'),false);return Response.json({choices:[{message:{content:JSON.stringify({action:'answer',value:'verified-value'})}}]});});
 process.env.COKE_MODEL_REASONING_EFFORT='';
 assert.equal((await run()).value,'verified-value');
});

test('browser model receives the project skill policy and only declared decisions',async t=>{
 const {readFile}=await import('node:fs/promises');
 const policy=await readFile(new URL('../.agents/skills/browser-use/references/runtime-policy.md',import.meta.url),'utf8');
 const run=fixture(t,async(_url,request)=>{const body=JSON.parse(request.body);assert.ok(body.messages[0].content.includes(policy));assert.equal(body.messages[0].role,'system');const input=JSON.parse(body.messages[1].content);assert.deepEqual(Object.keys(input).sort(),['elements','feedback','observations','task','text','url','workspaceResults']);return Response.json({choices:[{message:{content:JSON.stringify({action:'answer',value:'verified-value'})}}]});});
 assert.equal((await run()).value,'verified-value');
});
