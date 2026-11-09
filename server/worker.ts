import { parentPort } from 'node:worker_threads';
import { WorldGen, isOverview } from './gen/chunk.ts';

// Generation runs here, off the server's main thread. Each worker keeps its own
// generator per world; because generation is a pure function of the seed, workers
// never need to share state and their output is interchangeable.

const gens = new Map<string, WorldGen>();

function generator(seed: number, origin: [number, number] | null): WorldGen {
  const key = `${seed}:${origin}`;
  let g = gens.get(key);
  if (!g) {
    g = new WorldGen(seed, origin ?? undefined);
    gens.set(key, g);
    if (gens.size > 2) gens.delete(gens.keys().next().value!);
  }
  return g;
}

parentPort!.on('message', (m) => {
  try {
    const g = generator(m.seed, m.origin);
    if (m.type === 'origin') {
      parentPort!.postMessage({ id: m.id, ok: true, origin: g.origin });
    } else if (m.type === 'chunk') {
      const t0 = performance.now();
      const { features, timings } = g.generate(m.cx, m.cy);
      const t1 = performance.now();
      const data = JSON.stringify(features);
      const overview = JSON.stringify(features.filter(isOverview));
      parentPort!.postMessage({ id: m.id, ok: true, data, overview, features: features.length, timings, genMs: t1 - t0, serializeMs: performance.now() - t1 });
    } else if (m.type === 'graph') {
      parentPort!.postMessage({ id: m.id, ok: true, graph: g.roadGraph(m.box) });
    } else if (m.type === 'dem') {
      const t0 = performance.now();
      const grid = g.relief.grid(m.x0, m.y0, m.step, m.size, m.size, m.carve).z;
      parentPort!.postMessage({ id: m.id, ok: true, grid, ms: performance.now() - t0 }, [grid.buffer as ArrayBuffer]);
    }
  } catch (err) {
    parentPort!.postMessage({ id: m.id, ok: false, error: String((err as Error)?.stack ?? err) });
  }
});
