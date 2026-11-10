import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { createWorld, deleteWorld, getWorld, listWorlds, type Side } from './store.ts';
import { games, handleConquer, saveAll } from './game/conquer.ts';
import { getDemTile, getTile } from './tiles.ts';

const ROOT = join(import.meta.dirname, '..');
const PORT = Number(process.env.PORT ?? 5173);

const STATIC: Record<string, [string, string]> = {
  // The game is the front page. /conquer is its old address, kept so saved links still open.
  '/': ['public/game/index.html', 'text/html; charset=utf-8'],
  '/conquer': ['public/game/index.html', 'text/html; charset=utf-8'],
  '/explorer': ['public/index.html', 'text/html; charset=utf-8'],
  '/app.js': ['public/app.js', 'text/javascript; charset=utf-8'],
  '/style.js': ['public/style.js', 'text/javascript; charset=utf-8'],
  '/game/game.js': ['public/game/game.js', 'text/javascript; charset=utf-8'],
  '/game/art.js': ['public/game/art.js', 'text/javascript; charset=utf-8'],
  '/game/mapart.js': ['public/game/mapart.js', 'text/javascript; charset=utf-8'],
  '/game/city.js': ['public/game/city.js', 'text/javascript; charset=utf-8'],
  '/vendor/three.module.js': ['node_modules/three/build/three.module.js', 'text/javascript'],
  '/vendor/three.core.js': ['node_modules/three/build/three.core.js', 'text/javascript'],
  '/vendor/pixi.mjs': ['node_modules/pixi.js/dist/pixi.min.mjs', 'text/javascript'],
  '/vendor/maplibre-gl.css': ['node_modules/maplibre-gl/dist/maplibre-gl.css', 'text/css'],
  '/vendor/maplibre-gl.mjs': ['node_modules/maplibre-gl/dist/maplibre-gl.mjs', 'text/javascript'],
  '/vendor/maplibre-gl-shared.mjs': ['node_modules/maplibre-gl/dist/maplibre-gl-shared.mjs', 'text/javascript'],
  '/vendor/maplibre-gl-worker.mjs': ['node_modules/maplibre-gl/dist/maplibre-gl-worker.mjs', 'text/javascript'],
};

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  const parts: Buffer[] = [];
  for await (const p of req) parts.push(p as Buffer);
  if (!parts.length) return {};
  try { return JSON.parse(Buffer.concat(parts).toString()); } catch { return {}; }
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const path = url.pathname;
  const method = req.method ?? 'GET';

  const file = STATIC[path];
  if (file && method === 'GET') {
    res.writeHead(200, { 'content-type': file[1], 'cache-control': 'no-cache' });
    res.end(await readFile(join(ROOT, file[0])));
    return;
  }

  if (path === '/favicon.ico') { res.writeHead(204); res.end(); return; }

  if (path.startsWith('/api/conquer') && await handleConquer(req, res, path, method, () => body(req))) return;

  if (path === '/api/worlds' && method === 'GET') return json(res, 200, listWorlds());
  if (path === '/api/worlds' && method === 'POST') {
    const b = await body(req);
    const name = String(b.name || 'New world').slice(0, 60);
    const seed = String(b.seed || Math.random().toString(36).slice(2, 10));
    const w = await createWorld(name, seed);
    return json(res, 201, w.info());
  }

  // Game worlds share the map routes for tiles and statistics, but only the game may change them.
  const m = path.match(/^\/api\/(worlds|conquer)\/([a-z0-9-]+)(?:\/(.*))?$/);
  if (m) {
    const explorer = m[1] === 'worlds';
    const world = explorer ? getWorld(m[2]) : games.get(m[2]);
    if (!world) return json(res, 404, { error: 'no such world' });
    const rest = m[3] ?? '';
    if (rest === '' && method === 'GET') return json(res, 200, world.info());
    if (rest === '' && method === 'DELETE' && explorer) {
      if (world.job) return json(res, 409, { error: 'world is expanding' });
      return json(res, 200, { deleted: deleteWorld(m[2]) });
    }
    if (rest === 'stats' && method === 'GET') return json(res, 200, world.stats());
    if (rest === 'expand' && method === 'POST' && explorer) {
      if (world.job) return json(res, 409, { error: 'already expanding' });
      const b = await body(req);
      const km = Math.min(20, Math.max(0.1, Number(b.km) || 2));
      const asked = Array.isArray(b.sides) ? b.sides.filter((s): s is Side => ['n', 'e', 's', 'w'].includes(s as string)) : [];
      const expansion = await world.expand(km, asked.length ? asked : ['n', 'e', 's', 'w']);
      return json(res, 200, { world: world.info(), expansion });
    }
    const d = rest.match(/^dem\/(\d+)\/(\d+)\/(\d+)\.png$/);
    if (d && method === 'GET') {
      const tile = await getDemTile(world, Number(d[1]), Number(d[2]), Number(d[3]));
      if (!tile) { res.writeHead(204); res.end(); return; }
      res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'max-age=3600' });
      res.end(tile);
      return;
    }
    const t = rest.match(/^tiles\/(\d+)\/(\d+)\/(\d+)\.mvt$/);
    if (t && method === 'GET') {
      const tile = getTile(world, Number(t[1]), Number(t[2]), Number(t[3]));
      if (!tile) { res.writeHead(204); res.end(); return; }
      res.writeHead(200, { 'content-type': 'application/vnd.mapbox-vector-tile', 'cache-control': 'max-age=3600' });
      res.end(tile);
      return;
    }
  }
  json(res, 404, { error: 'not found' });
}

createServer((req, res) => {
  handle(req, res).catch((err) => {
    console.error(err);
    if (!res.headersSent) json(res, 500, { error: String(err?.message ?? err) });
    else res.end();
  });
}).listen(PORT, () => console.log(`Conquer running at http://localhost:${PORT}`));

// Stopping the server (Ctrl-C, or a kill) saves any games in play first.
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    saveAll().then((n) => { if (n) console.log(`saved ${n} game${n > 1 ? 's' : ''}`); }).finally(() => process.exit(0));
  });
}
