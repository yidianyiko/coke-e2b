import { Sandbox, SandboxNotFoundError } from 'e2b';
import { userScope } from './task-store.mjs';

// SDK e2b@2.56.0 paginator: .hasNext and .nextItems(), metadata filters combine with AND.
export function sandboxCleanupOptions(user) {
 return {
  inspectSandbox: async id => {
   try { return await Sandbox.getInfo(id); }
   catch (error) { if (error instanceof SandboxNotFoundError) return null; throw error; }
  },
  killSandbox: id => Sandbox.kill(id),
  listSandboxes: async () => {
   const paginator = Sandbox.list({ query: { metadata: { cokeApp: 'coke-e2b', cokeUser: userScope(user) } } });
   const items = [];
   while (paginator.hasNext) items.push(...await paginator.nextItems());
   return items;
  },
 };
}
