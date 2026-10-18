import test from 'node:test';
import assert from 'node:assert/strict';
import {captureBrowserScreenshot} from '../src/browser-screenshot.mjs';

test('unresponsive CDP cleanup cannot suppress screenshot deadline', async () => {
 const pending = () => new Promise(() => {});
 const page = {async screenshot(){throw Object.assign(new Error('font pending'),{name:'TimeoutError'})},context(){return {async newCDPSession(){return {send:pending,detach:pending}}}}};
 let timer;
 try {
  await assert.rejects(Promise.race([
   captureBrowserScreenshot(page,{timeoutMs:20}),
   new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('cleanup suppressed deadline')),150)}),
  ]), {message:'BROWSER_SCREENSHOT_TIMEOUT'});
 } finally {clearTimeout(timer)}
});
