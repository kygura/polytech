import { EventEmitter } from "node:events";

export type BusEvent = { type: string; payload: unknown; ts: number };

// ponytail: in-process bus, single instance only. Multi-instance => Upstash pub/sub behind the same publish/subscribe.
const bus: EventEmitter = ((globalThis as any).__pmBus ??= new EventEmitter().setMaxListeners(0));

export const publish = (type: string, payload: unknown = {}) => bus.emit("event", { type, payload, ts: Date.now() } satisfies BusEvent);

/** Returns the unsubscribe fn. */
export const subscribe = (fn: (e: BusEvent) => void) => {
  bus.on("event", fn);
  return () => void bus.off("event", fn);
};
