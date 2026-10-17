export const serviceExited = child => !child || child.exitCode !== null || child.signalCode !== null;
export async function stopService(child) {
 const requestedSignals = [];
 if (serviceExited(child)) return { requestedSignals };
 const terminate = signal => { if (!serviceExited(child)) { requestedSignals.push(signal); child.kill(signal); } };
 const exited = new Promise(resolveExit => child.once('exit', resolveExit));
 const timeout = setTimeout(() => terminate('SIGKILL'), 3_000);
 if (child.connected) {
  child.send({ type: 'shutdown' }, error => { if (error) terminate('SIGTERM'); });
 } else terminate('SIGTERM');
 try { await exited; } finally { clearTimeout(timeout); }
 return { requestedSignals };
}
