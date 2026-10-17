/** A JSON array whose entries record when each action completed. */
export class TaskTrace extends Array {
 static get [Symbol.species]() { return Array; }
 constructor(clock = Date.now) { super(); Object.defineProperty(this, 'clock', { value: clock }); }
 push(...entries) {
  return super.push(...entries.map(entry => ({ ...entry, timestamp: this.clock(), outcome: entry.ok === false ? 'failed' : 'succeeded' })));
 }
}

export function summarizeUsage(record, now = Date.now()) {
 const duration = (start, end) => typeof start === 'number' ? Math.max(0, (typeof end === 'number' ? end : now) - start) : 0;
 return {
  taskId: record.taskId,
  taskDurationMs: duration(record.createdAt, record.finishedAt),
  e2bDurationMs: duration(record.sandboxStartedAt, record.sandboxFinishedAt),
  browserDurationMs: duration(record.browserStartedAt, record.browserFinishedAt),
  limits: record.limits || { timeoutMs: 90000, maxSteps: 6, maxBrowserContexts: 1 },
 };
}

export async function inspectTask(store, user, taskId, view) {
 const record = await store.get(user, taskId);
 if (view === 'usage') return summarizeUsage(record);
 if (view !== 'trace') throw new Error('INVALID_TASK_VIEW');
 return {
  taskId: record.taskId, status: record.status, sandboxId: record.sandboxId,
  leaseId: record.leaseId, screenshotPath: record.screenshotPath,
  workspaceArtifacts: record.workspaceArtifacts || [], resourcesReleased: record.resourcesReleased,
  trace: record.trace || [],
 };
}

export function parseTimeoutMs(value) {
 if (value === undefined) return 90000;
 if (!/^\d+$/.test(String(value))) throw new Error('INVALID_TIMEOUT: --timeout-ms must be 1000..120000');
 const timeoutMs = Number(value);
 if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 120000) throw new Error('INVALID_TIMEOUT: --timeout-ms must be 1000..120000');
 return timeoutMs;
}

export function startTaskDeadline(controller, timeoutMs, { schedule = setTimeout, cancel = clearTimeout } = {}) {
 const timer = schedule(() => {
  if (!controller.signal.aborted) controller.abort(new Error('TASK_TIMEOUT'));
 }, parseTimeoutMs(timeoutMs));
 timer.unref();
 return () => cancel(timer);
}
