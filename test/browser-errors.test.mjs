import test from 'node:test';
import assert from 'node:assert/strict';
import {remoteBrowserFailure, browserFailureCode} from '../src/browser-errors.mjs';
test('remote CLI errors retain only known safe browser codes from command results and SDK exceptions',()=>{
 for(const result of [{exitCode:1,stderr:'{"error":{"code":"BROWSER_GATEWAY_TIMEOUT","message":"private URL and token"}}'}, {stderr:'{"error":{"code":"BROWSER_GATEWAY_TIMEOUT"}}'}]) {
  const error=remoteBrowserFailure(result);
  assert.equal(browserFailureCode(error),'BROWSER_GATEWAY_TIMEOUT');
  assert.equal(error.message,'BROWSER_GATEWAY_TIMEOUT: browser action failed');
 }
 for(const stderr of ['raw secret', '{"error":{"code":"private-secret"}}']) assert.equal(remoteBrowserFailure({stderr}).message,'REMOTE_CLI_FAILED: browser action failed');
});

test('actual E2B SDK timeout is distinct from a browser action failure', async () => {
 const {TimeoutError, CommandExitError} = await import('e2b');
 const timeout = remoteBrowserFailure(new TimeoutError('private request details'));
 assert.equal(browserFailureCode(timeout), 'BROWSER_REMOTE_COMMAND_TIMEOUT');
 assert.equal(timeout.message, 'BROWSER_REMOTE_COMMAND_TIMEOUT: browser action failed');
 const exit = new CommandExitError({exitCode:1,stdout:'',stderr:'{"error":{"code":"BROWSER_SCREENSHOT_TIMEOUT"}}'});
 assert.equal(browserFailureCode(remoteBrowserFailure(exit)), 'BROWSER_SCREENSHOT_TIMEOUT');
});
