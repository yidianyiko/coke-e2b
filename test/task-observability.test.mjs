import test from 'node:test';
import assert from 'node:assert/strict';
import { TaskTrace, summarizeUsage, inspectTask, parseTimeoutMs, startTaskDeadline } from '../src/task-observability.mjs';

test('trace records independent clock times and outcomes and serializes as an array', () => {
 const times = [1000, 1400]; const trace = new TaskTrace(() => times.shift());
 trace.push({action:'acquire',ok:true,result:{leaseId:'lease'}});
 trace.push({action:'release',ok:false,error:'FAILED'});
 assert.deepEqual(JSON.parse(JSON.stringify(trace)), [
  {action:'acquire',ok:true,result:{leaseId:'lease'},timestamp:1000,outcome:'succeeded'},
  {action:'release',ok:false,error:'FAILED',timestamp:1400,outcome:'failed'}]);
});

test('usage reports recorded resource lifetimes and configured limits', () => {
 const record = {taskId:'task',createdAt:1000,finishedAt:9000,sandboxStartedAt:2000,sandboxFinishedAt:8000,browserStartedAt:3000,browserFinishedAt:7000,limits:{timeoutMs:10000,maxSteps:6,maxBrowserContexts:1}};
 assert.deepEqual(summarizeUsage(record), {taskId:'task',taskDurationMs:8000,e2bDurationMs:6000,browserDurationMs:4000,limits:record.limits});
 assert.equal(summarizeUsage({taskId:'local',createdAt:1000,finishedAt:1500}).e2bDurationMs,0);
});

test('inspection uses user scoped lookup and returns only trace metadata', async () => {
 const record={taskId:'t',status:'succeeded',trace:[{action:'read'}],sandboxId:'s',leaseId:'l',screenshotPath:'/artifact.png',resourcesReleased:true,secret:'never'};
 const store={get:async (user,id)=>{assert.equal(id,'t');if(user!=='alice')throw new Error('TASK_NOT_FOUND');return record;}};
 assert.deepEqual(await inspectTask(store,'alice','t','trace'),{taskId:'t',status:'succeeded',sandboxId:'s',leaseId:'l',screenshotPath:'/artifact.png',workspaceArtifacts:[],resourcesReleased:true,trace:record.trace});
 await assert.rejects(inspectTask(store,'bob','t','trace'),/TASK_NOT_FOUND/);
});

test('deadline bounds timeout and can be cleared after cleanup', () => {
 assert.equal(parseTimeoutMs(undefined),90000);
 assert.equal(parseTimeoutMs('1000'),1000);
 for(const value of ['999','120001','abc','1.5','']) assert.throws(()=>parseTimeoutMs(value),/INVALID_TIMEOUT/);
 const controller = new AbortController(); let callback; let unrefed=false; let cleared=false;
 const stop=startTaskDeadline(controller,1000,{schedule:(fn,ms)=>{assert.equal(ms,1000);callback=fn;return {unref:()=>{unrefed=true;}};},cancel:()=>{cleared=true;}});
 assert.equal(unrefed,true);callback();assert.equal(controller.signal.reason.message,'TASK_TIMEOUT');stop();assert.equal(cleared,true);
});

test('deadline preserves a manual cancellation reason', () => {
 const controller=new AbortController();let fire;
 const stop=startTaskDeadline(controller,1000,{schedule:fn=>{fire=fn;return {unref(){}};},cancel(){}});
 controller.abort(new Error('TASK_CANCELLED'));fire();
 assert.equal(controller.signal.reason.message,'TASK_CANCELLED');stop();
});
