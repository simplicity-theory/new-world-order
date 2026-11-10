import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import { CHUNK } from '../gen/chunk.ts';
import { run } from '../pool.ts';
import { Store, type Side, type World } from '../store.ts';
import { encodePng } from '../tiles.ts';
import { think } from './ai.ts';
import { DEFAULTS, PLAYER, RULES, type Settings } from './rules.ts';
import { Sim, UNIT_KINDS, mergeGraph, newBuilding, newState, type RawGraph, type State, type TownNode } from './sim.ts';
import { sight, territory, type Territory } from './territory.ts';

// Conquer's server side: loading and saving games, running the clock, streaming the game
// to the page and taking its commands. The rules themselves live in sim.ts.

export const games = new Store(process.env.DATA_DIR
  ? join(process.env.DATA_DIR, 'conquer')
  : join(import.meta.dirname, '..', '..', 'data', 'conquer'));

export class Game {
  world: World;
  sim: Sim;
  private clients = new Set<ServerResponse>();
  private timer: NodeJS.Timeout | null = null;
  private last = 0;
  private dirty = 0;
  private growing = false;
  private landKey = '';
  private land: Territory[] = [];
  private sightKey = '';
  private mini: { key: string; png: Promise<Buffer> } | null = null;
  private ticks = 0;

  private constructor(world: World, state: State) {
    this.world = world;
    this.sim = new Sim(state);
    this.sim.brain = think;
    this.sim.onCapture = (town, by) => { if (by === PLAYER) this.grow(town); };
  }

  static async open(world: World, settings?: Settings): Promise<Game> {
    world.db.exec('CREATE TABLE IF NOT EXISTS game (id INTEGER PRIMARY KEY CHECK (id = 1), state TEXT NOT NULL, updated TEXT)');
    const row = world.db.prepare('SELECT state FROM game WHERE id = 1').get() as { state: string } | undefined;
    const saved = row ? JSON.parse(row.state) as State : null;
    // Games saved by an earlier version of the rules start again on the same map.
    const game = new Game(world, saved?.version === 5 ? saved : newState(await Game.graph(world), settings ?? saved?.settings ?? DEFAULTS));
    game.save();
    return game;
  }

  /** Ask the generator for the towns and roads inside the world. */
  private static async graph(world: World): Promise<RawGraph> {
    const b = world.meta.bounds!;
    const [ox, oy] = world.meta.origin;
    const box = { minx: ox + (b.x0 - 0.5) * CHUNK, miny: oy + (b.y0 - 0.5) * CHUNK, maxx: ox + (b.x1 + 0.5) * CHUNK, maxy: oy + (b.y1 + 0.5) * CHUNK };
    return (await run({ type: 'graph', seed: world.seedNumber, origin: world.meta.origin, box })).graph;
  }

  save(): void {
    this.world.db.prepare('INSERT OR REPLACE INTO game (id, state, updated) VALUES (1, ?, ?)').run(JSON.stringify(this.sim.state), new Date().toISOString());
    this.dirty = 0;
  }

  /** Capturing a town near the edge of the map generates the land beyond it, so there is always somewhere to go. */
  private grow(node: TownNode): void {
    const b = this.world.meta.bounds!;
    const edge = RULES.growth.edgeKm * 1000;
    const sides: Side[] = [];
    if (node.x > (b.x1 + 0.5) * CHUNK - edge) sides.push('e');
    if (node.x < (b.x0 - 0.5) * CHUNK + edge) sides.push('w');
    if (node.y > (b.y1 + 0.5) * CHUNK - edge) sides.push('n');
    if (node.y < (b.y0 - 0.5) * CHUNK + edge) sides.push('s');
    if (!sides.length || this.growing || this.world.job) return;
    this.growing = true;
    this.sim.note('Scouts are mapping new territory…');
    this.world.expand(RULES.growth.addKm, sides)
      .then(() => Game.graph(this.world))
      .then((raw) => {
        mergeGraph(this.sim.state, raw);
        this.sim.index();
        this.sim.note('New territory mapped.');
        this.save();
        this.send('graph', this.full());
      })
      .catch((err) => console.error('conquer: could not grow the map', err))
      .finally(() => { this.growing = false; });
  }

  command(c: Record<string, unknown>) {
    // For automated tests only: with CONQUER_DEBUG set, a 'debug' command can hand out money and units and alter towns.
    if (c.type === 'debug' && process.env.CONQUER_DEBUG) {
      // `as` runs an ordinary command on behalf of another side, e.g. to make a rival attack.
      if (typeof c.as === 'number' && c.command) { const r = this.sim.command(c.command as Record<string, unknown>, c.as); this.send('tick', this.live()); return r; }
      const s = this.sim.state, t = typeof c.town === 'string' ? s.towns[c.town] : undefined;
      if (typeof c.money === 'number') this.sim.faction(PLAYER).money = c.money;
      if (t && typeof c.owner === 'number') t.owner = c.owner;
      if (t && typeof c.infantry === 'number') t.garrison.infantry = c.infantry;
      if (t && typeof c.vehicle === 'number') t.garrison.vehicle = c.vehicle;
      if (t && typeof c.fort === 'number') t.fort = c.fort;
      if (t && c.barracks) t.buildings.barracks = newBuilding('barracks', true);
      if (t && c.factory) t.buildings.factory = newBuilding('factory', true);
      if (t) for (const k of UNIT_KINDS) if (typeof c[k] === 'number') t.garrison[k] = c[k] as number;
      this.sim.refresh();
      this.send('tick', this.live());
      return { ok: true as const };
    }
    const result = this.sim.command(c, PLAYER);
    if ('ok' in result) { this.dirty++; this.send('tick', this.live()); }
    return result;
  }

  /** Everything the player may know that changes from tick to tick. */
  live() {
    return { ...this.sim.view(PLAYER), growing: this.growing };
  }

  /** Who controls which land, as far as the player knows. Recomputed only when a town or road changes hands or state. */
  private territory(): Territory[] {
    const view = this.sim.view(PLAYER).towns as Record<string, { owner: number }>;
    const owners = Object.fromEntries(Object.entries(view).map(([id, t]) => [id, t.owner]));
    const key = JSON.stringify([owners, this.sim.state.graph.roads.map((r) => r.intact), this.world.meta.bounds]);
    if (key !== this.landKey) {
      this.landKey = key;
      this.land = territory(this.sim.state.graph, owners, this.world.info().boundsM);
      return this.land;
    }
    return this.land;
  }

  /**
   * A small picture of the whole map for the minimap: sea, land and a little shading for height.
   * It covers a square from the map's south-west corner, as wide as the map's longer side.
   */
  miniMap(): Promise<Buffer> {
    const b = this.world.info().boundsM, key = JSON.stringify(b);
    if (this.mini?.key === key) return this.mini.png;
    const size = 220, side = Math.max(b.maxx - b.minx, b.maxy - b.miny), step = side / size;
    const [ox, oy] = this.world.meta.origin;
    const png = run({ type: 'dem', seed: this.world.seedNumber, origin: this.world.meta.origin, size, step, carve: false, x0: ox + b.minx + step / 2, y0: oy + b.miny + step / 2 })
      .then((r: { grid: Float32Array }) => {
        const rgb = new Uint8Array(size * size * 3);
        for (let row = 0; row < size; row++) {
          for (let col = 0; col < size; col++) {
            const e = r.grid[(size - 1 - row) * size + col], o = (row * size + col) * 3;
            // Sea deepens away from the shore; land darkens gently with height.
            const c = e < 0 ? [165 - Math.min(30, -e), 207 - Math.min(25, -e * 0.8), 238] : [232 - Math.min(60, e * 0.22), 235 - Math.min(50, e * 0.17), 220 - Math.min(70, e * 0.26)];
            rgb[o] = c[0]; rgb[o + 1] = c[1]; rgb[o + 2] = c[2];
          }
        }
        return encodePng(size, size, rgb);
      });
    this.mini = { key, png };
    return png;
  }

  /** The area the player can see right now, or null if it has not changed since it was last asked for. */
  private sight(force = false) {
    const eyes = this.sim.eyes(PLAYER).map(([x, y, r]) => [Math.round(x / 50) * 50, Math.round(y / 50) * 50, r] as [number, number, number]);
    const key = JSON.stringify([eyes, this.world.meta.bounds]);
    if (key === this.sightKey && !force) return null;
    this.sightKey = key;
    return sight(eyes, this.world.info().boundsM);
  }

  /** The whole game, including the map graph. Sent once on load and again when the map grows. */
  full() {
    return { world: this.world.info(), rules: RULES, unitKinds: UNIT_KINDS, graph: this.sim.state.graph, live: this.live(), territory: this.territory(), sight: this.sight(true) };
  }

  private send(event: string, data: unknown): void {
    const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of this.clients) res.write(msg);
  }

  /** Stream the game to a page. The game only runs while at least one page is watching. */
  attach(req: IncomingMessage, res: ServerResponse): void {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    res.write(`event: tick\ndata: ${JSON.stringify(this.live())}\n\n`);
    res.write(`event: territory\ndata: ${JSON.stringify(this.territory())}\n\n`);
    res.write(`event: sight\ndata: ${JSON.stringify(this.sight(true))}\n\n`);
    this.clients.add(res);
    req.on('close', () => {
      this.clients.delete(res);
      if (!this.clients.size) this.stop();
    });
    if (!this.timer) {
      this.last = performance.now();
      this.timer = setInterval(() => this.tick(), RULES.tickSeconds * 1000);
    }
  }

  private tick(): void {
    const now = performance.now();
    const real = Math.min(1, (now - this.last) / 1000);
    this.last = now;
    const s = this.sim.state;
    // The clock stops when the game is decided, until the player chooses to carry on.
    if (s.speed > 0 && (s.winner === null || s.dismissed)) { this.sim.step(real * s.speed); this.dirty++; }
    this.send('tick', this.live());
    const before = this.land;
    if (this.territory() !== before) this.send('territory', this.land);
    // Sight changes whenever an army moves, so it is refreshed a couple of times a second at most.
    if (++this.ticks % 3 === 0) { const seen = this.sight(); if (seen) this.send('sight', seen); }
    if (this.dirty > 25) this.save();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.dirty) this.save();
  }
}

// ----- HTTP -----

const loaded = new Map<string, Promise<Game>>();

function gameFor(id: string, settings?: Settings): Promise<Game> | null {
  let g = loaded.get(id);
  if (!g) {
    const world = games.get(id);
    if (!world) return null;
    g = Game.open(world, settings);
    loaded.set(id, g);
    g.catch(() => loaded.delete(id));
  }
  return g;
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

/** Write every game in play to disk. Called when the server is asked to stop, so nothing since the last save is lost. */
export async function saveAll(): Promise<number> {
  let n = 0;
  for (const pending of loaded.values()) {
    try { (await pending).save(); n++; } catch { /* a game that failed to load has nothing to save */ }
  }
  return n;
}

/** Handles the game's own routes. Returns false for anything else (map tiles are served by the shared routes). */
export async function handleConquer(
  req: IncomingMessage, res: ServerResponse, path: string, method: string, body: () => Promise<Record<string, unknown>>,
): Promise<boolean> {
  if (path === '/api/conquer' && method === 'GET') { json(res, 200, games.list()); return true; }
  if (path === '/api/conquer' && method === 'POST') {
    const b = await body();
    const name = String(b.name || 'Campaign').slice(0, 60);
    const seed = String(b.seed || Math.random().toString(36).slice(2, 10));
    const settings: Settings = {
      rivals: Math.max(0, Math.min(RULES.rivals.length, Math.floor(Number(b.rivals ?? DEFAULTS.rivals)))),
      difficulty: String(b.difficulty) in RULES.difficulty ? b.difficulty as Settings['difficulty'] : DEFAULTS.difficulty,
      size: String(b.size) in RULES.sizes ? b.size as Settings['size'] : DEFAULTS.size,
      watch: !!b.watch,
      reveal: !!b.reveal,
    };
    const world = await games.create(name, seed);
    // Grow from the first chunk to the starting map size.
    const [w, h] = RULES.sizes[settings.size];
    await world.expand(((w - 1) / 2) * (CHUNK / 1000), ['e', 'w']);
    await world.expand(Math.floor((h - 1) / 2) * (CHUNK / 1000), ['s']);
    await world.expand(Math.ceil((h - 1) / 2) * (CHUNK / 1000), ['n']);
    const game = await gameFor(world.meta.id, settings)!;
    json(res, 201, game.full());
    return true;
  }
  const m = path.match(/^\/api\/conquer\/([a-z0-9-]+)(?:\/(game|command|events|mini))?$/);
  if (!m) return false;
  if (!m[2] && method !== 'DELETE') return false;
  const pending = gameFor(m[1]);
  if (!pending) { json(res, 404, { error: 'no such game' }); return true; }
  const game = await pending;
  if (!m[2]) {
    if (game.world.job) { json(res, 409, { error: 'the map is still growing' }); return true; }
    game.stop();
    loaded.delete(m[1]);
    json(res, 200, { deleted: games.delete(m[1]) });
  } else if (m[2] === 'game' && method === 'GET') json(res, 200, game.full());
  else if (m[2] === 'mini' && method === 'GET') {
    res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'max-age=3600' });
    res.end(await game.miniMap());
  }
  else if (m[2] === 'command' && method === 'POST') {
    const result = game.command(await body());
    json(res, 'ok' in result ? 200 : 400, result);
  } else if (m[2] === 'events' && method === 'GET') game.attach(req, res);
  else return false;
  return true;
}
