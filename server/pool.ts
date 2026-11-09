import { availableParallelism } from 'node:os';
import { Worker } from 'node:worker_threads';

// A small pool of generator threads. Tasks can be pinned to a worker, which lets an
// expansion hand each worker a contiguous patch of chunks so its caches stay warm.

interface Task { msg: Record<string, unknown>; resolve: (v: any) => void; reject: (e: Error) => void }

export const THREADS = Math.max(1, Math.min(6, Number(process.env.WORKERS) || availableParallelism() - 1));

const workers: { w: Worker; queue: Task[]; busy: Task | null }[] = [];
let nextId = 1;

function pump(slot: (typeof workers)[number]): void {
  if (slot.busy || !slot.queue.length) return;
  slot.busy = slot.queue.shift()!;
  slot.w.postMessage({ ...slot.busy.msg, id: nextId++ });
}

function start(): void {
  for (let k = 0; k < THREADS; k++) {
    const slot = { w: new Worker(new URL('./worker.ts', import.meta.url)), queue: [] as Task[], busy: null as Task | null };
    slot.w.on('message', (m) => {
      const task = slot.busy!;
      slot.busy = null;
      if (m.ok) task.resolve(m); else task.reject(new Error(m.error));
      pump(slot);
    });
    slot.w.on('error', (err: Error) => {
      slot.busy?.reject(err);
      slot.busy = null;
      for (const t of slot.queue.splice(0)) t.reject(err);
    });
    workers.push(slot);
  }
}

/** Run a task on worker `pin` (modulo pool size), or on the least busy worker. */
export function run<T = any>(msg: Record<string, unknown>, pin?: number): Promise<T> {
  if (!workers.length) start();
  const load = (s: (typeof workers)[number]) => s.queue.length + (s.busy ? 1 : 0);
  const slot = pin === undefined ? workers.reduce((a, b) => (load(b) < load(a) ? b : a)) : workers[pin % workers.length];
  return new Promise((resolve, reject) => {
    slot.queue.push({ msg, resolve, reject });
    pump(slot);
  });
}
