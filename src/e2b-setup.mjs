// e2b@2.56.0 uses 60 seconds for command streams by default. Setup may
// include cold provider startup, but never receives more than the task budget.
export async function runSetupCommand(sandbox, command, {deadline, signal, phase, trace, now = Date.now}) {
  signal.throwIfAborted();
  const remaining = deadline - now();
  if (remaining <= 0) throw new Error('TASK_TIMEOUT: setup exhausted task deadline');
  const timeoutMs = Math.min(60_000, remaining);
  try {
    const result = await sandbox.commands.run(command, {timeoutMs, requestTimeoutMs:timeoutMs, signal});
    trace.push({action:'sandbox-setup',phase,ok:result.exitCode===0,source:'e2b-cli',result:{exitCode:result.exitCode}});
    return result;
  } catch(error) {
    trace.push({action:'sandbox-setup',phase,ok:false,source:'e2b-cli',error:'E2B_SETUP_FAILED'});
    throw error;
  }
}
