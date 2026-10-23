/// <reference lib="webworker" />
// Placeholder until U1 lands the sim core: answers the handshake so the shell can verify the worker loads.
const ctx = self as unknown as DedicatedWorkerGlobalScope;
ctx.onmessage = (e: MessageEvent<{ type: string }>) => {
  if (e.data?.type === 'hello') ctx.postMessage({ type: 'ready' });
};
