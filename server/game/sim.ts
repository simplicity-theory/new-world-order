import { NEUTRAL, PLAYER, RIVAL, RULES, type BuildingKind, type RoadKind, type UnitKind, type UpgradeKind } from './rules.ts';

// The Conquer simulation: plain data in, plain data out, no files or network. One step()
// advances everything by a slice of time; command() is the only way a player or the
// rival changes anything. That keeps it easy to test and easy to save.

export type Pt = [number, number];
export interface Units { infantry: number; vehicle: number }
export interface TownNode {
  id: string; name: string; tier: number; r: number; x: number; y: number;
  outline: Pt[]; sites: Pt[][];
  traits: { hill: boolean; river: boolean; port: boolean; rail: boolean };
}
export interface Road {
  id: string; a: string; b: string; kind: string; ref: string; pts: Pt[]; length: number;
  bridges: { d: number; x: number; y: number }[];
  intact: boolean;
  cutAt: Pt | null;         // where the break is, once cut
  repair: number;           // -1 not being mended, otherwise progress 0..1
}
export interface Building { done: boolean; progress: number; queue: number; training: number; repeat: boolean }
export interface TownState {
  owner: number;
  garrison: Units;
  buildings: Partial<Record<BuildingKind, Building>>;
  market: number; fort: number;
  rally: string | null;     // newly trained units march here
  supplied: boolean;        // joined to its owner's capital by held towns and intact roads
}
export interface Leg { road: string; rev: boolean }
export interface Group extends Units {
  id: number; owner: number; from: string; to: string;
  path: Leg[]; leg: number; dist: number;   // metres along the current leg
  speed: number;                            // metres per simulation second on the current leg
}
export interface Faction {
  id: number; name: string; color: string; money: number;
  capital: string; ai: boolean; alive: boolean;
  seen: string[];           // towns this faction has had in view at some point
  thought: number;          // clock time of the rival's last decision
}
export interface Graph { towns: TownNode[]; roads: Road[] }
export interface State {
  version: 2;
  clock: number;            // simulation seconds played
  speed: number;            // 0 paused, otherwise a multiplier
  factions: Faction[];
  graph: Graph;
  towns: Record<string, TownState>;
  groups: Group[];
  nextId: number;
  events: { clock: number; to: number; text: string }[];
  winner: number | null;
  dismissed: boolean;       // the player chose to keep playing after the game was decided
}
export type Result = { ok: true } | { error: string };
export type RawGraph = { towns: TownNode[]; roads: Omit<Road, 'length' | 'intact' | 'cutAt' | 'repair'>[] };

export const UNIT_KINDS = Object.keys(RULES.units) as UnitKind[];
const none = (): Units => ({ infantry: 0, vehicle: 0 });
const count = (u: Units): number => u.infantry + u.vehicle;

export function lineLength(pts: Pt[]): number {
  let l = 0;
  for (let i = 0; i + 1 < pts.length; i++) l += Math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]);
  return l;
}
export function pointAlong(pts: Pt[], d: number): Pt {
  for (let i = 0; i + 1 < pts.length; i++) {
    const l = Math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]);
    if (d <= l) return [pts[i][0] + ((pts[i + 1][0] - pts[i][0]) * d) / (l || 1), pts[i][1] + ((pts[i + 1][1] - pts[i][1]) * d) / (l || 1)];
    d -= l;
  }
  return pts[pts.length - 1];
}

// ----- Combat -----

export const attackPower = (u: Units): number => u.infantry * RULES.units.infantry.attack + u.vehicle * RULES.units.vehicle.attack;
export const defencePower = (u: Units, multiplier: number): number =>
  (u.infantry * RULES.units.infantry.defence + u.vehicle * RULES.units.vehicle.defence) * multiplier;

/**
 * Settle a fight between two strengths. The stronger side wins and loses a share of its
 * units that grows with how close the fight was; the weaker side is wiped out. A tie goes
 * to the defender.
 */
export function fight(att: Units, ap: number, def: Units, dp: number): { win: boolean; att: Units; def: Units } {
  const survive = (u: Units, share: number): Units => {
    const out = { infantry: u.infantry - Math.round(u.infantry * share), vehicle: u.vehicle - Math.round(u.vehicle * share) };
    if (count(out) === 0 && count(u) > 0) { if (u.vehicle) out.vehicle = 1; else out.infantry = 1; }
    return out;
  };
  if (ap > dp) return { win: true, att: survive(att, dp > 0 ? (dp / ap) ** RULES.lossPower : 0), def: none() };
  return { win: false, att: none(), def: survive(def, ap > 0 ? (ap / dp) ** RULES.lossPower : 0) };
}

/** Metres per simulation second for a group on a class of road: the pace of its slowest kind of unit. */
export function speedOn(u: Units, kind: string): number {
  const k = (kind in RULES.speed.vehicle ? kind : 'tertiary') as RoadKind;
  let kmh = Infinity;
  for (const unit of UNIT_KINDS) if (u[unit] > 0) kmh = Math.min(kmh, RULES.speed[unit][k]);
  if (kmh === Infinity) kmh = RULES.speed.infantry[k];
  return (kmh / 3.6) * RULES.timeScale;
}

// ----- Setting up -----

/** Fold towns and roads from the generator into a game; anything already known is left alone. */
export function mergeGraph(state: State, raw: RawGraph): void {
  const towns = new Set(state.graph.towns.map((t) => t.id)), roads = new Set(state.graph.roads.map((r) => r.id));
  for (const t of raw.towns) {
    if (towns.has(t.id)) continue;
    state.graph.towns.push(t);
    state.towns[t.id] = { owner: NEUTRAL, garrison: { ...RULES.neutralGarrison[t.tier] }, buildings: {}, market: 0, fort: 0, rally: null, supplied: true };
  }
  for (const r of raw.roads) {
    if (!roads.has(r.id)) state.graph.roads.push({ ...r, length: lineLength(r.pts), intact: true, cutAt: null, repair: -1 });
  }
}

export function newState(raw: RawGraph, withRival = true): State {
  const state: State = {
    version: 2, clock: 0, speed: 1, graph: { towns: [], roads: [] }, towns: {}, groups: [], nextId: 1, events: [], winner: null, dismissed: false,
    factions: [
      { id: NEUTRAL, name: 'Neutral', color: '#7d848c', money: 0, capital: '', ai: false, alive: true, seen: [], thought: 0 },
      { id: PLAYER, name: 'You', color: '#1f6feb', money: RULES.startMoney, capital: '', ai: false, alive: true, seen: [], thought: 0 },
    ],
  };
  mergeGraph(state, raw);
  const sim = new Sim(state);
  const towns = state.graph.towns;
  const degree = (t: TownNode) => sim.links.get(t.id)!.length;
  // The player starts in a village with a choice of roads out, as near the middle of the map as possible.
  const pool = [towns.filter((t) => t.tier === 1 && degree(t) >= 2), towns.filter((t) => t.tier <= 2 && degree(t) >= 1), towns.filter((t) => degree(t) >= 1), towns]
    .find((p) => p.length);
  if (!pool) return state;
  const start = pool.reduce((a, b) => (Math.hypot(b.x, b.y) < Math.hypot(a.x, a.y) ? b : a));
  const claim = (f: Faction, t: TownNode) => {
    f.capital = t.id;
    state.towns[t.id] = { ...state.towns[t.id], owner: f.id, garrison: none() };
  };
  claim(state.factions[PLAYER], start);
  if (withRival) {
    // The rival starts in a small place as far away by road as the map allows.
    const far = sim.distances(start.id);
    const options = towns.filter((t) => t.id !== start.id && t.tier <= 2 && (far.get(t.id) ?? 0) > 5000);
    if (options.length) {
      const home = options.reduce((a, b) => (far.get(b.id)! - b.tier * 4000 > far.get(a.id)! - a.tier * 4000 ? b : a));
      state.factions.push({ id: RIVAL, name: 'Rival', color: '#d1345b', money: RULES.startMoney, capital: home.id, ai: true, alive: true, seen: [], thought: 0 });
      claim(state.factions[RIVAL], home);
    }
  }
  sim.note(`You hold ${start.name}. Build an infantry base to begin.`);
  sim.upkeepSupplyVision();
  return state;
}

// ----- The simulation -----

export class Sim {
  state: State;
  roads = new Map<string, Road>();
  nodes = new Map<string, TownNode>();
  links = new Map<string, { road: Road; other: string }[]>();
  /** Called when a town changes hands. */
  onCapture: ((town: TownNode, by: number) => void) | null = null;
  /** The rival's decision-making, called every few seconds for each computer-run faction. */
  brain: ((sim: Sim, f: Faction) => void) | null = null;

  constructor(state: State) {
    this.state = state;
    this.index();
  }

  index(): void {
    this.roads.clear(); this.nodes.clear(); this.links.clear();
    for (const t of this.state.graph.towns) { this.nodes.set(t.id, t); this.links.set(t.id, []); }
    for (const r of this.state.graph.roads) {
      this.roads.set(r.id, r);
      this.links.get(r.a)?.push({ road: r, other: r.b });
      this.links.get(r.b)?.push({ road: r, other: r.a });
    }
  }

  note(text: string, to = PLAYER): void {
    this.state.events.push({ clock: this.state.clock, to, text });
    if (this.state.events.length > 60) this.state.events.shift();
  }

  faction(id: number): Faction {
    return this.state.factions.find((f) => f.id === id)!;
  }

  // ----- Derived numbers -----

  /** How much a town multiplies its defenders' strength. */
  defenceOf(id: string): number {
    const t = this.nodes.get(id)!, s = this.state.towns[id], b = RULES.defenceBonus;
    return 1 + (t.traits.hill ? b.hill : 0) + (t.traits.river ? b.river : 0) + s.fort * b.fort;
  }

  /** Money a town earns per minute for whoever holds it. */
  incomeOf(id: string): number {
    const t = this.nodes.get(id)!, s = this.state.towns[id];
    return RULES.income[t.tier] * (1 + s.market * RULES.upgrades.market.perLevel)
      * (1 + (t.traits.port ? RULES.portBonus : 0) + (t.traits.rail ? RULES.railBonus : 0)) * (s.supplied ? 1 : RULES.cutOffShare);
  }

  upgradeCost(id: string, kind: UpgradeKind): number {
    return RULES.upgrades[kind].base * (this.state.towns[id][kind] + 1) * (this.nodes.get(id)!.tier + 1);
  }

  upkeepOf(who: number): number {
    let total = 0;
    const add = (u: Units) => { for (const k of UNIT_KINDS) total += u[k] * RULES.units[k].upkeep; };
    for (const t of Object.values(this.state.towns)) if (t.owner === who) add(t.garrison);
    for (const g of this.state.groups) if (g.owner === who) add(g);
    return total;
  }

  position(g: Group): Pt {
    const leg = g.path[g.leg], road = this.roads.get(leg.road)!;
    return pointAlong(road.pts, leg.rev ? road.length - g.dist : g.dist);
  }

  /** Towns a faction can see right now: near a town it holds or a group it has on the road. */
  visible(who: number): Set<string> {
    const eyes: [number, number, number][] = [];
    for (const t of this.state.graph.towns) if (this.state.towns[t.id].owner === who) eyes.push([t.x, t.y, RULES.vision.town]);
    for (const g of this.state.groups) if (g.owner === who) eyes.push([...this.position(g), RULES.vision.group]);
    const out = new Set<string>();
    for (const t of this.state.graph.towns) {
      if (eyes.some(([x, y, r]) => Math.hypot(t.x - x, t.y - y) <= r + t.r)) out.add(t.id);
    }
    return out;
  }

  canSee(who: number, p: Pt): boolean {
    for (const t of this.state.graph.towns) if (this.state.towns[t.id].owner === who && Math.hypot(t.x - p[0], t.y - p[1]) <= RULES.vision.town) return true;
    for (const g of this.state.groups) {
      if (g.owner !== who) continue;
      const q = this.position(g);
      if (Math.hypot(q[0] - p[0], q[1] - p[1]) <= RULES.vision.group) return true;
    }
    return false;
  }

  // ----- Routes -----

  /** Road distance from one town to every town it can reach on intact roads. */
  distances(from: string): Map<string, number> {
    return this.search(from, null, (r) => r.length).dist;
  }

  private search(from: string, to: string | null, weight: (r: Road) => number) {
    const dist = new Map<string, number>([[from, 0]]);
    const via = new Map<string, { road: Road; prev: string }>();
    const done = new Set<string>();
    for (;;) {
      let cur: string | null = null, best = Infinity;
      for (const [k, d] of dist) if (!done.has(k) && d < best) { best = d; cur = k; }
      if (cur === null || cur === to) break;
      done.add(cur);
      for (const { road, other } of this.links.get(cur) ?? []) {
        if (!road.intact) continue;
        const d = best + weight(road);
        if (d < (dist.get(other) ?? Infinity)) { dist.set(other, d); via.set(other, { road, prev: cur }); }
      }
    }
    return { dist, via };
  }

  /** Quickest route for these units between two towns, over intact roads; null if there is none. */
  route(from: string, to: string, units: Units): { legs: Leg[]; time: number } | null {
    if (from === to) return { legs: [], time: 0 };
    const { dist, via } = this.search(from, to, (r) => r.length / speedOn(units, r.kind));
    if (!dist.has(to)) return null;
    const legs: Leg[] = [];
    for (let at = to; at !== from;) {
      const { road, prev } = via.get(at)!;
      legs.unshift({ road: road.id, rev: road.a !== prev });
      at = prev;
    }
    return { legs, time: dist.get(to)! };
  }

  private endOf(leg: Leg): string {
    const road = this.roads.get(leg.road)!;
    return leg.rev ? road.a : road.b;
  }

  // ----- Fighting and capture -----

  /** A group attacks a town. Returns true if the town fell; either way the group is used up. */
  private assault(g: Group, id: string, onTheWay: boolean): void {
    const s = this.state, town = s.towns[id], node = this.nodes.get(id)!;
    const result = fight(g, attackPower(g), town.garrison, defencePower(town.garrison, this.defenceOf(id)));
    const before = town.owner, lostA = count(g) - count(result.att), lostD = count(town.garrison) - count(result.def);
    if (!result.win) {
      town.garrison = result.def;
      this.note(`Your attack on ${node.name} failed: ${count(g)} lost, ${lostD} defenders killed.`, g.owner);
      if (before !== NEUTRAL) this.note(`${node.name} held against an attack, losing ${lostD} of its defenders.`, before);
      return;
    }
    town.owner = g.owner;
    town.garrison = result.att;
    town.rally = null;
    for (const b of Object.values(town.buildings)) { b.queue = 0; b.training = 0; b.repeat = false; if (!b.done) b.progress = 0; }
    this.note(`${node.name} captured${lostA ? `, ${lostA} lost` : ''}${onTheWay ? '; the group halted there' : ''}.`, g.owner);
    if (before !== NEUTRAL) this.note(`${node.name} was lost to the ${g.owner === PLAYER ? 'player' : this.faction(g.owner).name.toLowerCase()}.`, before);
    // Losing a capital ends the game for that side.
    const loser = s.factions.find((f) => f.id !== NEUTRAL && f.capital === id && f.id !== g.owner);
    if (loser) {
      loser.alive = false;
      if (s.winner === null) s.winner = g.owner;
    }
    this.onCapture?.(node, g.owner);
  }

  /** Two hostile groups meet on a road and fight it out; the loser is destroyed. */
  private meet(a: Group, b: Group): void {
    const result = fight(a, attackPower(a), b, attackPower(b));
    const [winner, loser, left] = result.win ? [a, b, result.att] : [b, a, result.def];
    const road = this.roads.get(a.path[a.leg].road)!;
    const where = `between ${this.nodes.get(road.a)!.name} and ${this.nodes.get(road.b)!.name}`;
    this.note(`Your group won a fight ${where}, losing ${count(winner) - count(left)}.`, winner.owner);
    this.note(`Your group of ${count(loser)} was destroyed ${where}.`, loser.owner);
    winner.infantry = left.infantry;
    winner.vehicle = left.vehicle;
    this.state.groups.splice(this.state.groups.indexOf(loser), 1);
  }

  private join(g: Group, id: string): void {
    const town = this.state.towns[id];
    town.garrison.infantry += g.infantry;
    town.garrison.vehicle += g.vehicle;
  }

  private dispatch(owner: number, from: string, to: string, units: Units): boolean {
    const r = this.route(from, to, units);
    if (!r || !r.legs.length) return false;
    this.state.groups.push({ id: this.state.nextId++, owner, ...units, from, to, path: r.legs, leg: 0, dist: 0, speed: speedOn(units, this.roads.get(r.legs[0].road)!.kind) });
    return true;
  }

  // ----- One slice of time -----

  step(dt: number): void {
    const s = this.state;
    s.clock += dt;

    // Money: income from towns, less upkeep for every unit.
    for (const f of s.factions) {
      if (f.id === NEUTRAL || !f.alive) continue;
      let perMinute = -this.upkeepOf(f.id);
      for (const t of s.graph.towns) if (s.towns[t.id].owner === f.id) perMinute += this.incomeOf(t.id);
      f.money = Math.max(0, f.money + (perMinute * dt) / 60);
    }

    // Construction and training.
    for (const [id, town] of Object.entries(s.towns)) {
      if (town.owner === NEUTRAL) continue;
      const owner = this.faction(town.owner);
      for (const [kind, b] of Object.entries(town.buildings) as [BuildingKind, Building][]) {
        const rule = RULES.buildings[kind], unit = RULES.units[rule.trains];
        if (!b.done) {
          b.progress += dt / rule.time;
          if (b.progress >= 1) { b.done = true; b.progress = 0; this.note(`${rule.name} finished in ${this.nodes.get(id)!.name}.`, town.owner); }
          continue;
        }
        if (b.repeat && b.queue === 0 && owner.money >= unit.cost) { owner.money -= unit.cost; b.queue = 1; }
        if (b.queue > 0) {
          b.training += dt / unit.time;
          while (b.training >= 1 && b.queue > 0) {
            b.training -= 1;
            b.queue--;
            const fresh = { ...none(), [rule.trains]: 1 } as Units;
            // New units go straight to the rally point, if one is set and still held.
            if (!(town.rally && s.towns[town.rally]?.owner === town.owner && this.dispatch(town.owner, id, town.rally, fresh))) town.garrison[rule.trains]++;
          }
          if (!b.queue) b.training = 0;
        }
      }
    }

    // Road repairs.
    for (const r of s.graph.roads) {
      if (r.repair < 0) continue;
      r.repair += dt / (r.bridges.length ? RULES.roads.repairBridgeTime : RULES.roads.repairTime);
      if (r.repair >= 1) { r.repair = -1; r.intact = true; r.cutAt = null; }
    }

    // Movement. Each group's stretch of road covered this step is kept so that hostile
    // groups passing each other can be made to fight.
    const swept = new Map<Group, { road: string; lo: number; hi: number }>();
    for (const g of [...s.groups]) {
      if (!s.groups.includes(g)) continue;
      let move = g.speed * dt;
      const along = () => { const leg = g.path[g.leg], road = this.roads.get(leg.road)!; return leg.rev ? road.length - g.dist : g.dist; };
      const startRoad = g.path[g.leg].road, startAt = along();
      let changed = false;
      while (move > 0) {
        const leg = g.path[g.leg], road = this.roads.get(leg.road)!;
        const left = road.length - g.dist;
        if (move < left) { g.dist += move; break; }
        move -= left;
        changed = true;
        const reached = this.endOf(leg);
        const last = g.leg === g.path.length - 1;
        const remove = () => { s.groups.splice(s.groups.indexOf(g), 1); };
        if (s.towns[reached].owner !== g.owner) { remove(); this.assault(g, reached, !last); break; }
        if (last) { remove(); this.join(g, reached); break; }
        // A cut road ahead: find another way from here, or stop.
        if (!this.roads.get(g.path[g.leg + 1].road)!.intact) {
          const again = this.route(reached, g.to, g);
          if (!again) { remove(); this.join(g, reached); this.note(`A group stopped at ${this.nodes.get(reached)!.name}: the road ahead is cut.`, g.owner); break; }
          g.path = [...g.path.slice(0, g.leg + 1), ...again.legs];
        }
        g.leg++;
        g.dist = 0;
        g.speed = speedOn(g, this.roads.get(g.path[g.leg].road)!.kind);
      }
      if (!changed && s.groups.includes(g)) { const now = along(); swept.set(g, { road: startRoad, lo: Math.min(startAt, now), hi: Math.max(startAt, now) }); }
    }
    const moving = [...swept.keys()];
    for (let i = 0; i < moving.length; i++) {
      for (let j = i + 1; j < moving.length; j++) {
        const a = moving[i], b = moving[j];
        if (a.owner === b.owner || !s.groups.includes(a) || !s.groups.includes(b)) continue;
        const sa = swept.get(a)!, sb = swept.get(b)!;
        if (sa.road === sb.road && sa.lo <= sb.hi + 60 && sb.lo <= sa.hi + 60) this.meet(a, b);
      }
    }

    this.upkeepSupplyVision();

    // The rival thinks every few seconds.
    for (const f of s.factions) {
      if (f.ai && f.alive && this.brain && s.clock - f.thought >= 3) { f.thought = s.clock; this.brain(this, f); }
    }

    // Victory by share of the map.
    if (s.winner === null) {
      for (const f of s.factions) {
        if (f.id === NEUTRAL || !f.alive) continue;
        const held = s.graph.towns.filter((t) => s.towns[t.id].owner === f.id).length;
        if (held >= Math.ceil(s.graph.towns.length * RULES.winShare)) s.winner = f.id;
      }
    }
  }

  /** Recompute which towns are joined to their capital, and what each side has seen. */
  upkeepSupplyVision(): void {
    const s = this.state;
    for (const f of s.factions) {
      if (f.id === NEUTRAL) continue;
      const reach = new Set<string>();
      if (s.towns[f.capital]?.owner === f.id) {
        const queue = [f.capital];
        reach.add(f.capital);
        while (queue.length) {
          for (const { road, other } of this.links.get(queue.pop()!) ?? []) {
            if (road.intact && !reach.has(other) && s.towns[other].owner === f.id) { reach.add(other); queue.push(other); }
          }
        }
      }
      for (const [id, t] of Object.entries(s.towns)) if (t.owner === f.id) t.supplied = reach.has(id);
      const seen = new Set(f.seen);
      for (const id of this.visible(f.id)) seen.add(id);
      if (seen.size !== f.seen.length) f.seen = [...seen];
    }
  }

  // ----- Commands -----

  command(c: Record<string, unknown>, who = PLAYER): Result {
    const s = this.state;
    const me = this.faction(who);
    const fail = (error: string): Result => ({ error });
    const id = typeof c.town === 'string' ? c.town : '';
    const town = s.towns[id];
    const mine = town?.owner === who;
    const pay = (cost: number): boolean => { if (me.money < cost) return false; me.money -= cost; return true; };
    switch (c.type) {
      case 'speed':
        if (![0, 1, 2, 4, 8].includes(c.value as number)) return fail('unknown speed');
        s.speed = c.value as number;
        return { ok: true };
      case 'dismiss':
        s.dismissed = true;
        return { ok: true };
      case 'build': {
        const kind = c.building as BuildingKind, rule = RULES.buildings[kind];
        if (!mine) return fail('not your town');
        if (!rule) return fail('unknown building');
        if (town.buildings[kind]) return fail('already built here');
        if (!pay(rule.cost)) return fail('not enough money');
        town.buildings[kind] = { done: false, progress: 0, queue: 0, training: 0, repeat: false };
        return { ok: true };
      }
      case 'train':
      case 'repeat': {
        const unit = c.unit as UnitKind, rule = RULES.units[unit];
        if (!mine) return fail('not your town');
        if (!rule) return fail('unknown unit');
        const b = (Object.entries(town.buildings) as [BuildingKind, Building][]).find(([k, v]) => v.done && RULES.buildings[k].trains === unit)?.[1];
        if (!b) return fail(`needs a finished ${Object.values(RULES.buildings).find((x) => x.trains === unit)!.name.toLowerCase()}`);
        if (c.type === 'repeat') { b.repeat = !!c.on; return { ok: true }; }
        if (b.queue >= RULES.maxQueue) return fail('queue is full');
        if (!pay(rule.cost)) return fail('not enough money');
        b.queue++;
        return { ok: true };
      }
      case 'upgrade': {
        const kind = c.upgrade as UpgradeKind;
        if (!mine) return fail('not your town');
        if (!RULES.upgrades[kind]) return fail('unknown upgrade');
        if (town[kind] >= RULES.maxLevel) return fail('already at the top level');
        if (!pay(this.upgradeCost(id, kind))) return fail('not enough money');
        town[kind]++;
        return { ok: true };
      }
      case 'rally': {
        if (!mine) return fail('not your town');
        const to = typeof c.to === 'string' ? c.to : null;
        if (to && (to === id || s.towns[to]?.owner !== who)) return fail('a rally point must be another town you hold');
        town.rally = to;
        return { ok: true };
      }
      case 'move': {
        const from = String(c.from), to = String(c.to), src = s.towns[from];
        if (!src || src.owner !== who) return fail('not your town');
        if (!s.towns[to] || to === from) return fail('pick another town');
        const units: Units = {
          infantry: Math.min(src.garrison.infantry, Math.max(0, Math.floor(Number(c.infantry) || 0))),
          vehicle: Math.min(src.garrison.vehicle, Math.max(0, Math.floor(Number(c.vehicle) || 0))),
        };
        if (!count(units)) return fail('no units to send');
        if (!this.dispatch(who, from, to, units)) return fail('no road leads there');
        src.garrison.infantry -= units.infantry;
        src.garrison.vehicle -= units.vehicle;
        return { ok: true };
      }
      case 'redirect': {
        // Send a group on the road somewhere else. It may carry on to the next town or turn round, whichever is quicker.
        const g = s.groups.find((x) => x.id === c.group);
        if (!g || g.owner !== who) return fail('not your group');
        const to = c.to === undefined ? g.from : String(c.to);
        if (!s.towns[to]) return fail('pick a town');
        const leg = g.path[g.leg], road = this.roads.get(leg.road)!;
        const pace = speedOn(g, road.kind);
        const ahead = this.route(this.endOf(leg), to, g), behind = this.route(leg.rev ? road.b : road.a, to, g);
        const tAhead = ahead ? (road.length - g.dist) / pace + ahead.time : Infinity;
        const tBehind = behind ? g.dist / pace + behind.time : Infinity;
        if (tAhead === Infinity && tBehind === Infinity) return fail('no road leads there');
        if (tAhead <= tBehind) g.path = [leg, ...ahead!.legs];
        else { g.path = [{ road: leg.road, rev: !leg.rev }, ...behind!.legs]; g.dist = road.length - g.dist; }
        g.leg = 0;
        g.to = to;
        return { ok: true };
      }
      case 'cut':
      case 'repair': {
        const road = this.roads.get(String(c.road));
        if (!road) return fail('unknown road');
        if (s.towns[road.a].owner !== who && s.towns[road.b].owner !== who) return fail('you must hold a town at one end of the road');
        const bridge = road.bridges.length > 0;
        if (c.type === 'cut') {
          if (!road.intact) return fail('already cut');
          if (!pay(bridge ? RULES.roads.cutBridge : RULES.roads.cut)) return fail('not enough money');
          road.intact = false;
          road.repair = -1;
          road.cutAt = bridge ? [road.bridges[0].x, road.bridges[0].y] : pointAlong(road.pts, road.length / 2);
          for (const f of s.factions) if (f.id !== NEUTRAL && f.id !== who && (s.towns[road.a].owner === f.id || s.towns[road.b].owner === f.id)) {
            this.note(`The road between ${this.nodes.get(road.a)!.name} and ${this.nodes.get(road.b)!.name} has been cut.`, f.id);
          }
        } else {
          if (road.intact) return fail('nothing to repair');
          if (road.repair >= 0) return fail('already being repaired');
          if (!pay(bridge ? RULES.roads.repairBridge : RULES.roads.repair)) return fail('not enough money');
          road.repair = 0;
        }
        return { ok: true };
      }
      default: return fail('unknown command');
    }
  }

  // ----- What one side is allowed to know -----

  view(who: number) {
    const s = this.state, me = this.faction(who);
    const visible = this.visible(who), seen = new Set(me.seen);
    const towns: Record<string, unknown> = {};
    let income = 0;
    for (const t of s.graph.towns) {
      const st = s.towns[t.id], own = st.owner === who, vis = visible.has(t.id);
      if (own) income += this.incomeOf(t.id);
      towns[t.id] = {
        // Towns never seen show no owner; towns seen but out of sight show their owner but not their defenders.
        owner: seen.has(t.id) ? st.owner : -1, visible: vis,
        garrison: vis ? st.garrison : null,
        defence: this.defenceOf(t.id), fort: vis ? st.fort : null,
        ...(own ? { buildings: st.buildings, market: st.market, rally: st.rally, supplied: st.supplied, income: this.incomeOf(t.id),
          costs: { market: this.upgradeCost(t.id, 'market'), fort: this.upgradeCost(t.id, 'fort') } } : {}),
      };
    }
    return {
      clock: s.clock, speed: s.speed, me: { id: me.id, money: me.money, capital: me.capital, income, upkeep: this.upkeepOf(who) },
      factions: s.factions.map((f) => ({ id: f.id, name: f.name, color: f.color, alive: f.alive, capital: seen.has(f.capital) ? f.capital : null })),
      towns,
      groups: s.groups.filter((g) => g.owner === who || this.canSee(who, this.position(g))),
      roads: s.graph.roads.filter((r) => !r.intact).map((r) => ({ id: r.id, cutAt: r.cutAt, repair: r.repair })),
      events: s.events.filter((e) => e.to === who).slice(-6),
      winner: s.winner, dismissed: s.dismissed,
      goal: Math.ceil(s.graph.towns.length * RULES.winShare),
    };
  }
}
