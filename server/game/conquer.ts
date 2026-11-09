import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import { CHUNK } from '../gen/chunk.ts';
import { run } from '../pool.ts';
import { Store, type Side, type World } from '../store.ts';
import { NEUTRAL, PLAYER, RULES, type BuildingKind, type UnitKind } from './rules.ts';

// Conquer: towns earn money, money builds bases and units, units travel the roads and
// take towns. The server owns the game; the page sends commands and draws what it is told.
//
// Not in this version but allowed for: other factions (everything has an owner), combat
// and defences (arrive() and meet() are the only places ownership and losses are decided),
// and cutting roads (routes only use roads marked intact).

export const games = new Store(process.env.DATA_DIR
  ? join(process.env.DATA_DIR, 'conquer')
  : join(import.meta.dirname, '..', '..', 'data', 'conquer'));

type Pt = [number, number];
interface TownNode { id: string; name: string; tier: number; r: number; x: number; y: number }
interface Road { id: string; a: string; b: string; kind: string; ref: string; pts: Pt[]; length: number; intact: boolean }
interface Building { done: boolean; progress: number; queue: number; training: number }
interface TownState {
  owner: number;
  defence: number;                                  // unused until towns can be defended
  garrison: Record<UnitKind, number>;
  buildings: Partial<Record<BuildingKind, Building>>;
}
interface Leg { road: string; rev: boolean }
interface Group {
  id: number; owner: number; infantry: number; vehicle: number;
  from: string; to: string;
  path: Leg[]; leg: number; dist: number;           // metres along the current leg
  speed: number;                                    // metres per simulation second
}
interface Faction { id: number; name: string; color: string; money: number }
interface State {
  version: 1;
  clock: number;                                    // simulation seconds played
  speed: number;                                    // 0 paused, otherwise a multiplier
  start: string;
  factions: Faction[];
  graph: { towns: TownNode[]; roads: Road[] };
  towns: Record<string, TownState>;
  groups: Group[];
  nextId: number;
  events: { clock: number; text: string }[];
}
type Result = { ok: true } | { error: string };

const UNIT_KINDS = Object.keys(RULES.units) as UnitKind[];
const lineLength = (pts: Pt[]): number => {
  let l = 0;
  for (let i = 0; i + 1 < pts.length; i++) l += Math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]);
  return l;
};

export class Game {
  world: World;
  state: State;
  private roads = new Map<string, Road>();
  private nodes = new Map<string, TownNode>();
  private links = new Map<string, { road: Road; other: string }[]>();
  private clients = new Set<ServerResponse>();
  private timer: NodeJS.Timeout | null = null;
  private last = 0;
  private dirty = 0;
  private growing = false;

  private constructor(world: World, state: State) {
    this.world = world;
    this.state = state;
    this.index();
  }

  // ----- Loading and saving -----

  static async open(world: World): Promise<Game> {
    world.db.exec('CREATE TABLE IF NOT EXISTS game (id INTEGER PRIMARY KEY CHECK (id = 1), state TEXT NOT NULL, updated TEXT)');
    const row = world.db.prepare('SELECT state FROM game WHERE id = 1').get() as { state: string } | undefined;
    if (row) return new Game(world, JSON.parse(row.state));
    const game = new Game(world, {
      version: 1, clock: 0, speed: 1, start: '', graph: { towns: [], roads: [] }, towns: {}, groups: [], nextId: 1, events: [],
      factions: [{ id: NEUTRAL, name: 'Neutral', color: '#8b9097', money: 0 }, { id: PLAYER, name: 'You', color: '#1f6feb', money: RULES.startMoney }],
    });
    await game.refreshGraph();
    game.chooseStart();
    game.save();
    return game;
  }

  save(): void {
    this.world.db.prepare('INSERT OR REPLACE INTO game (id, state, updated) VALUES (1, ?, ?)').run(JSON.stringify(this.state), new Date().toISOString());
    this.dirty = 0;
  }

  /** Ask the generator for the towns and roads inside the world, and fold in anything new. */
  private async refreshGraph(): Promise<void> {
    const b = this.world.meta.bounds!;
    const [ox, oy] = this.world.meta.origin;
    const box = { minx: ox + (b.x0 - 0.5) * CHUNK, miny: oy + (b.y0 - 0.5) * CHUNK, maxx: ox + (b.x1 + 0.5) * CHUNK, maxy: oy + (b.y1 + 0.5) * CHUNK };
    const { graph } = await run({ type: 'graph', seed: this.world.seedNumber, origin: this.world.meta.origin, box });
    const s = this.state;
    for (const t of graph.towns as TownNode[]) {
      if (this.nodes.has(t.id)) continue;
      s.graph.towns.push(t);
      s.towns[t.id] = { owner: NEUTRAL, defence: 0, garrison: { infantry: 0, vehicle: 0 }, buildings: {} };
    }
    for (const r of graph.roads as Omit<Road, 'id' | 'length' | 'intact'>[]) {
      const id = `${r.a}|${r.b}`;
      if (!this.roads.has(id)) s.graph.roads.push({ ...r, id, length: lineLength(r.pts), intact: true });
    }
    this.index();
  }

  private index(): void {
    this.roads.clear(); this.nodes.clear(); this.links.clear();
    for (const t of this.state.graph.towns) { this.nodes.set(t.id, t); this.links.set(t.id, []); }
    for (const r of this.state.graph.roads) {
      this.roads.set(r.id, r);
      this.links.get(r.a)?.push({ road: r, other: r.b });
      this.links.get(r.b)?.push({ road: r, other: r.a });
    }
  }

  /** The player starts in a village with a choice of roads out, as near the middle of the map as possible. */
  private chooseStart(): void {
    const degree = (t: TownNode) => this.links.get(t.id)!.length;
    const towns = this.state.graph.towns;
    const pool = [towns.filter((t) => t.tier === 1 && degree(t) >= 2), towns.filter((t) => t.tier <= 2 && degree(t) >= 1), towns.filter((t) => degree(t) >= 1), towns]
      .find((p) => p.length);
    if (!pool) return;
    const start = pool.reduce((a, b) => (Math.hypot(b.x, b.y) < Math.hypot(a.x, a.y) ? b : a));
    this.state.start = start.id;
    this.state.towns[start.id].owner = PLAYER;
    this.note(`You hold ${start.name}.`);
  }

  // ----- Simulation -----

  private note(text: string): void {
    this.state.events.push({ clock: this.state.clock, text });
    if (this.state.events.length > 40) this.state.events.shift();
  }

  private faction(id: number): Faction {
    return this.state.factions.find((f) => f.id === id)!;
  }

  /** Shortest route by road between two towns, using only roads that are intact. */
  route(from: string, to: string): Leg[] | null {
    const dist = new Map<string, number>([[from, 0]]);
    const via = new Map<string, { road: Road; prev: string }>();
    const done = new Set<string>();
    for (;;) {
      let cur: string | null = null, best = Infinity;
      for (const [k, d] of dist) if (!done.has(k) && d < best) { best = d; cur = k; }
      if (cur === null) return null;
      if (cur === to) break;
      done.add(cur);
      for (const { road, other } of this.links.get(cur) ?? []) {
        if (!road.intact) continue;
        const d = best + road.length;
        if (d < (dist.get(other) ?? Infinity)) { dist.set(other, d); via.set(other, { road, prev: cur }); }
      }
    }
    const legs: Leg[] = [];
    for (let at = to; at !== from;) {
      const { road, prev } = via.get(at)!;
      legs.unshift({ road: road.id, rev: road.a !== prev });
      at = prev;
    }
    return legs;
  }

  /**
   * A group reaches the town it was sent to. Uncontested for now: the town changes hands
   * and the group becomes its garrison. Combat and defences belong here.
   */
  private arrive(g: Group, townId: string): void {
    const town = this.state.towns[townId], node = this.nodes.get(townId)!;
    if (town.owner !== g.owner) {
      town.owner = g.owner;
      // Anything half-built by the previous owner is lost; finished buildings change hands.
      for (const b of Object.values(town.buildings)) { b.queue = 0; b.training = 0; }
      if (g.owner === PLAYER) this.note(`${node.name} captured.`);
      this.grow(node);
    } else if (g.owner === PLAYER) this.note(`Reinforcements reached ${node.name}.`);
    town.garrison.infantry += g.infantry;
    town.garrison.vehicle += g.vehicle;
  }

  /** A group passes through a town on its way elsewhere. Nothing happens yet; hostile towns will block here. */
  private pass(_g: Group, _townId: string): void { /* reserved for contested movement */ }

  /** Two groups of different factions meet on a road. Nothing happens yet; combat on the road belongs here. */
  private meet(_a: Group, _b: Group): void { /* reserved for combat */ }

  private step(dt: number): void {
    const s = this.state;
    s.clock += dt;
    for (const [id, town] of Object.entries(s.towns)) {
      if (town.owner === NEUTRAL) continue;
      const owner = this.faction(town.owner);
      owner.money += (RULES.income[this.nodes.get(id)!.tier] * dt) / 60;
      for (const [kind, b] of Object.entries(town.buildings) as [BuildingKind, Building][]) {
        const rule = RULES.buildings[kind];
        if (!b.done) {
          b.progress += dt / rule.time;
          if (b.progress >= 1) { b.done = true; b.progress = 0; if (town.owner === PLAYER) this.note(`${rule.name} finished in ${this.nodes.get(id)!.name}.`); }
        } else if (b.queue > 0) {
          b.training += dt / RULES.units[rule.trains].time;
          while (b.training >= 1 && b.queue > 0) { b.training -= 1; b.queue--; town.garrison[rule.trains]++; }
          if (!b.queue) b.training = 0;
        }
      }
    }
    for (const g of [...s.groups]) {
      let move = g.speed * dt;
      while (move > 0) {
        const road = this.roads.get(g.path[g.leg].road)!;
        const left = road.length - g.dist;
        if (move < left) { g.dist += move; break; }
        move -= left;
        const reached = g.path[g.leg].rev ? road.a : road.b;
        if (g.leg === g.path.length - 1) {
          s.groups.splice(s.groups.indexOf(g), 1);
          this.arrive(g, reached);
          break;
        }
        this.pass(g, reached);
        g.leg++;
        g.dist = 0;
      }
    }
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
    this.note('Scouts are mapping new territory…');
    this.world.expand(RULES.growth.addKm, sides)
      .then(() => this.refreshGraph())
      .then(() => { this.note('New territory mapped.'); this.save(); this.send('graph', this.full()); })
      .catch((err) => console.error('conquer: could not grow the map', err))
      .finally(() => { this.growing = false; });
  }

  // ----- Commands from the player -----

  command(c: Record<string, unknown>, who = PLAYER): Result {
    const s = this.state;
    const me = this.faction(who);
    const town = typeof c.town === 'string' ? s.towns[c.town] : undefined;
    const fail = (error: string): Result => ({ error });
    let result: Result = { ok: true };
    switch (c.type) {
      case 'speed': {
        if (![0, 1, 2, 4, 8].includes(c.value as number)) return fail('unknown speed');
        s.speed = c.value as number;
        break;
      }
      case 'build': {
        const kind = c.building as BuildingKind, rule = RULES.buildings[kind];
        if (!town || town.owner !== who) return fail('not your town');
        if (!rule) return fail('unknown building');
        if (town.buildings[kind]) return fail('already built here');
        if (me.money < rule.cost) return fail('not enough money');
        me.money -= rule.cost;
        town.buildings[kind] = { done: false, progress: 0, queue: 0, training: 0 };
        break;
      }
      case 'train': {
        const unit = c.unit as UnitKind, rule = RULES.units[unit];
        if (!town || town.owner !== who) return fail('not your town');
        if (!rule) return fail('unknown unit');
        const b = (Object.entries(town.buildings) as [BuildingKind, Building][]).find(([k, v]) => v.done && RULES.buildings[k].trains === unit)?.[1];
        if (!b) return fail(`needs a finished ${Object.values(RULES.buildings).find((x) => x.trains === unit)!.name.toLowerCase()}`);
        if (b.queue >= RULES.maxQueue) return fail('queue is full');
        if (me.money < rule.cost) return fail('not enough money');
        me.money -= rule.cost;
        b.queue++;
        break;
      }
      case 'move': {
        const from = String(c.from), to = String(c.to);
        const src = s.towns[from];
        if (!src || src.owner !== who) return fail('not your town');
        if (!s.towns[to] || to === from) return fail('pick another town');
        const infantry = Math.min(src.garrison.infantry, Math.max(0, Math.floor(Number(c.infantry) || 0)));
        const vehicle = Math.min(src.garrison.vehicle, Math.max(0, Math.floor(Number(c.vehicle) || 0)));
        if (!infantry && !vehicle) return fail('no units to send');
        const path = this.route(from, to);
        if (!path) return fail('no road leads there');
        src.garrison.infantry -= infantry;
        src.garrison.vehicle -= vehicle;
        // A mixed group moves at the pace of its slowest unit.
        const kmh = infantry ? RULES.units.infantry.kmh : RULES.units.vehicle.kmh;
        s.groups.push({ id: s.nextId++, owner: who, infantry, vehicle, from, to, path, leg: 0, dist: 0, speed: (kmh / 3.6) * RULES.timeScale });
        break;
      }
      default: result = fail('unknown command');
    }
    if ('ok' in result) { this.dirty++; this.send('tick', this.live()); }
    return result;
  }

  // ----- Talking to the page -----

  /** Everything that changes from tick to tick. */
  live() {
    const s = this.state;
    return { clock: s.clock, speed: s.speed, factions: s.factions, towns: s.towns, groups: s.groups, events: s.events.slice(-6), growing: this.growing };
  }

  /** The whole game, including the map graph. Sent once on load and again when the map grows. */
  full() {
    return { world: this.world.info(), rules: RULES, unitKinds: UNIT_KINDS, start: this.state.start, graph: this.state.graph, live: this.live() };
  }

  private send(event: string, data: unknown): void {
    const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of this.clients) res.write(msg);
  }

  /** Stream the game to a page. The game only runs while at least one page is watching. */
  attach(req: IncomingMessage, res: ServerResponse): void {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    res.write(`event: tick\ndata: ${JSON.stringify(this.live())}\n\n`);
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
    if (this.state.speed > 0) { this.step(real * this.state.speed); this.dirty++; }
    this.send('tick', this.live());
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

function gameFor(id: string): Promise<Game> | null {
  let g = loaded.get(id);
  if (!g) {
    const world = games.get(id);
    if (!world) return null;
    g = Game.open(world);
    loaded.set(id, g);
    g.catch(() => loaded.delete(id));
  }
  return g;
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
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
    const world = await games.create(name, seed);
    // Grow from the first chunk to the starting map size.
    const [w, h] = RULES.startChunks;
    await world.expand(((w - 1) / 2) * (CHUNK / 1000), ['e', 'w']);
    await world.expand(Math.floor((h - 1) / 2) * (CHUNK / 1000), ['s']);
    await world.expand(Math.ceil((h - 1) / 2) * (CHUNK / 1000), ['n']);
    const game = await gameFor(world.meta.id)!;
    json(res, 201, game.full());
    return true;
  }
  const m = path.match(/^\/api\/conquer\/([a-z0-9-]+)(?:\/(game|command|events))?$/);
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
  else if (m[2] === 'command' && method === 'POST') {
    const result = game.command(await body());
    json(res, 'ok' in result ? 200 : 400, result);
  } else if (m[2] === 'events' && method === 'GET') game.attach(req, res);
  else return false;
  return true;
}
