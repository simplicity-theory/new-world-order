import { DEFAULTS, NEUTRAL, PLAYER, RULES, type BuildingKind, type RoadKind, type Settings, type UnitKind, type UpgradeKind } from './rules.ts';

// The Conquer simulation: plain data in, plain data out, no files or network. One step()
// advances everything by a slice of time; command() is the only way a player or the
// rival changes anything. That keeps it easy to test and easy to save.
//
// Units are in one of two places. A town's garrison is the units inside it. An army is a
// named body of units that marches, besieges, retreats, and when it reaches a friendly
// town camps there as itself rather than melting into the garrison.

export type Pt = [number, number];
export type Units = Record<UnitKind, number>;
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
/** One kind of unit being trained in a building: how many are queued, progress on the current one, and whether to keep going. */
export interface Line { queue: number; training: number; repeat: boolean }
export interface Building { done: boolean; progress: number; lines: Partial<Record<UnitKind, Line>> }
export interface TownState {
  owner: number;
  garrison: Units;
  buildings: Partial<Record<BuildingKind, Building>>;
  market: number; fort: number;
  rally: string | null;     // newly trained units march here
  supplied: boolean;        // joined to its owner's capital by held towns and intact roads
}
export interface Leg { road: string; rev: boolean }
export interface Army extends Units {
  id: number; owner: number; name: string;
  at: string | null;        // the town it is camped at or besieging; null while on the road
  from: string; to: string;
  path: Leg[]; leg: number; dist: number;   // metres along the current leg
  speed: number;                            // metres per simulation second on the current leg
  siege: { progress: number; need: number } | null;   // besieging the town it is at
  retreating: boolean;      // beaten and falling back; takes no orders until it gets home
  settle: boolean;          // joins the garrison on arrival (recruits heading for a rally point)
  stars: number;            // fights won, up to the limit; each makes the army stronger
  orders?: string[];        // towns to go on to, in turn, after the one it is heading for
}
export interface Faction {
  id: number; name: string; color: string; money: number;
  capital: string; ai: boolean; alive: boolean;
  seen: string[];           // towns this faction has had in view at some point
  thought: number;          // clock time of the rival's last decision
  raised: number;           // armies raised so far, for naming them
  /** What this side last knew of each town's defence strength, from seeing it or from attacking it. */
  intel?: Record<string, number>;
}
export interface Graph { towns: TownNode[]; roads: Road[] }
/** One side's account of a fight, attached to the event that reports it. */
export interface Report {
  kind: 'assault' | 'defence' | 'field';
  place: string;
  won: boolean;
  you: { before: Units; after: Units; power: number };
  them: { owner: number; before: Units; after: Units; power: number };
}
export interface GameEvent { id: number; clock: number; to: number; text: string; kind?: 'battle' | 'built' | 'siege'; at?: Pt; report?: Report }
export interface State {
  version: 5;
  clock: number;            // simulation seconds played
  speed: number;            // 0 paused, otherwise a multiplier
  factions: Faction[];
  graph: Graph;
  towns: Record<string, TownState>;
  armies: Army[];
  nextId: number;
  events: GameEvent[];
  winner: number | null;
  dismissed: boolean;       // the player chose to keep playing after the game was decided
  settings: Settings;
  /** Towns held by each side over time, for the end-of-game chart. */
  history: { clock: number; held: Record<number, number> }[];
  /** Fights won and lost, and units lost, by each side. */
  tally: Record<number, { won: number; lost: number; casualties: number }>;
}
export type Result = { ok: true } | { error: string };
export type RawGraph = { towns: TownNode[]; roads: Omit<Road, 'length' | 'intact' | 'cutAt' | 'repair'>[] };

export const UNIT_KINDS = Object.keys(RULES.units) as UnitKind[];
const each = (fn: (k: UnitKind) => number): Units => Object.fromEntries(UNIT_KINDS.map((k) => [k, fn(k)])) as Units;
const none = (): Units => each(() => 0);
const count = (u: Partial<Units>): number => UNIT_KINDS.reduce((n, k) => n + (u[k] || 0), 0);
const add = (a: Partial<Units>, b: Partial<Units>): Units => each((k) => (a[k] || 0) + (b[k] || 0));
const only = (u: Partial<Units>): Units => each((k) => u[k] || 0);
/** Remove some units from a garrison or army, in place. */
const take = (from: Units, units: Units): void => { for (const k of UNIT_KINDS) from[k] = (from[k] || 0) - units[k]; };
/** A building with its training lines, as when just ordered (or finished, for tests and debugging). */
export function newBuilding(kind: BuildingKind, done = false): Building {
  return { done, progress: 0, lines: Object.fromEntries(RULES.buildings[kind].trains.map((u) => [u, { queue: 0, training: 0, repeat: false }])) };
}
const ordinal = (n: number): string => `${n}${n % 100 >= 11 && n % 100 <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] ?? 'th'}`;

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

/** Attack strength of some units. Storming a town, units with an `assault` value use that instead. */
export const attackPower = (u: Partial<Units>, storming = false): number =>
  UNIT_KINDS.reduce((n, k) => n + (u[k] || 0) * ((storming && (RULES.units[k] as { assault?: number }).assault) || RULES.units[k].attack), 0);
export const defencePower = (u: Partial<Units>, multiplier: number): number =>
  UNIT_KINDS.reduce((n, k) => n + (u[k] || 0) * RULES.units[k].defence, 0) * multiplier;

/**
 * Settle a fight between two strengths. The stronger side wins and loses a share of its
 * units that grows with how close the fight was. The weaker side keeps a share too, with
 * which it retreats if it has anywhere to go. A tie goes to the defender.
 */
export function fight(ap: number, dp: number): { win: boolean; loss: number; keep: number } {
  const win = ap > dp;
  const ratio = win ? (ap > 0 ? dp / ap : 0) : (dp > 0 ? ap / dp : 0);
  return { win, loss: RULES.lossScale * ratio ** RULES.lossPower, keep: RULES.retreat.base + RULES.retreat.close * ratio };
}
/** How much an army's experience multiplies its strength. */
export const veteran = (a: { stars?: number }): number => 1 + (a.stars ?? 0) * RULES.experience.perStar;

/** A share of some units, rounded. A winner always keeps at least one. */
export function share(u: Partial<Units>, keep: number, atLeastOne = false): Units {
  const out = each((k) => Math.round((u[k] || 0) * keep));
  if (atLeastOne && count(out) === 0 && count(u) > 0) out[UNIT_KINDS.reduce((a, b) => ((u[b] || 0) > (u[a] || 0) ? b : a))] = 1;
  return out;
}

/** Metres per simulation second for a group on a class of road: the pace of its slowest kind of unit. */
export function speedOn(u: Partial<Units>, kind: string): number {
  const k = (kind in RULES.speed.vehicle ? kind : 'tertiary') as RoadKind;
  let kmh = Infinity;
  for (const unit of UNIT_KINDS) if ((u[unit] || 0) > 0) kmh = Math.min(kmh, RULES.speed[unit][k]);
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
    state.towns[t.id] = { owner: NEUTRAL, garrison: only(RULES.neutralGarrison[t.tier]), buildings: {}, market: 0, fort: 0, rally: null, supplied: true };
  }
  for (const r of raw.roads) {
    if (!roads.has(r.id)) state.graph.roads.push({ ...r, length: lineLength(r.pts), intact: true, cutAt: null, repair: -1 });
  }
}

export function newState(raw: RawGraph, options: boolean | Partial<Settings> = true): State {
  const settings: Settings = { ...DEFAULTS, ...(typeof options === 'boolean' ? { rivals: options ? 1 : 0 } : options) };
  const side = (id: number, name: string, color: string, ai: boolean): Faction =>
    ({ id, name, color, money: id === NEUTRAL ? 0 : RULES.startMoney, capital: '', ai, alive: true, seen: [], thought: 0, raised: 0 });
  const state: State = {
    version: 5, clock: 0, speed: 1, graph: { towns: [], roads: [] }, towns: {}, armies: [], nextId: 1, events: [], winner: null, dismissed: false, settings, history: [], tally: {},
    factions: [side(NEUTRAL, 'Neutral', '#7d848c', false), side(PLAYER, 'You', '#1f6feb', false)],
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
  // Each rival starts in a small place as far by road from every capital already chosen as the map allows.
  const capitals = [start.id];
  for (let k = 0; k < Math.min(settings.rivals, RULES.rivals.length); k++) {
    const far = capitals.map((c) => sim.distances(c));
    const reach = (t: TownNode) => Math.min(...far.map((d) => d.get(t.id) ?? 0));
    const options = towns.filter((t) => !capitals.includes(t.id) && t.tier <= 2 && reach(t) > 5000);
    if (!options.length) break;
    const home = options.reduce((a, b) => (reach(b) - b.tier * 4000 > reach(a) - a.tier * 4000 ? b : a));
    const f = side(state.factions.length, RULES.rivals[k].name, RULES.rivals[k].color, true);
    state.factions.push(f);
    claim(f, home);
    capitals.push(home.id);
  }
  sim.note(`You hold ${start.name}. Build an infantry base to begin.`, PLAYER, { at: [start.x, start.y] });
  sim.refresh();
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

  note(text: string, to = PLAYER, extra: Partial<Pick<GameEvent, 'at' | 'report' | 'kind'>> = {}): void {
    this.state.events.push({ id: this.state.nextId++, clock: this.state.clock, to, text, ...extra });
    if (this.state.events.length > 240) this.state.events.shift();
  }

  faction(id: number): Faction {
    return this.state.factions.find((f) => f.id === id)!;
  }

  // ----- Derived numbers -----

  /** How much a town multiplies its defenders' strength. After a full siege its fortifications no longer count. */
  defenceOf(id: string, breached = false): number {
    const t = this.nodes.get(id)!, s = this.state.towns[id], b = RULES.defenceBonus;
    return 1 + (t.traits.hill ? b.hill : 0) + (t.traits.river ? b.river : 0) + (breached ? 0 : s.fort * b.fort);
  }

  /** Seconds an attacker must besiege a town before assaulting it; 0 means it can be attacked at once. */
  siegeNeed(id: string): number {
    const tier = this.nodes.get(id)!.tier, k = RULES.siege;
    return this.state.towns[id].fort * k.perFort + (tier === 2 ? k.town : tier === 3 ? k.city : 0);
  }

  /** Armies of a town's owner camped at it; they fight alongside its garrison. */
  defendersAt(id: string): Army[] {
    const owner = this.state.towns[id].owner;
    return this.state.armies.filter((a) => a.at === id && a.owner === owner && !a.siege);
  }
  besiegersOf(id: string): Army[] {
    return this.state.armies.filter((a) => a.at === id && a.siege);
  }
  /** Everyone who would defend a town: its garrison and the armies camped there. */
  forceAt(id: string): Units {
    return this.defendersAt(id).reduce((u, a) => add(u, a), only(this.state.towns[id].garrison));
  }
  /** Defence strength of a town: its garrison plus each camped army, which counts for more if it is experienced. */
  strengthOf(id: string, breached = false): number {
    const mult = this.defenceOf(id, breached);
    return this.defendersAt(id).reduce((n, a) => n + defencePower(a, mult) * veteran(a), defencePower(this.state.towns[id].garrison, mult));
  }
  private earn(a: Army): void {
    a.stars = Math.min(RULES.experience.max, (a.stars ?? 0) + 1);
  }
  /** Keep score of a fight for the end-of-game summary. */
  private score(winner: number, loser: number, winnerLost: number, loserLost: number): void {
    const of = (id: number) => (this.state.tally[id] ??= { won: 0, lost: 0, casualties: 0 });
    of(winner).won++; of(winner).casualties += winnerLost;
    of(loser).lost++; of(loser).casualties += loserLost;
  }

  /** Money a town earns per minute for whoever holds it. A besieged town earns nothing. */
  incomeOf(id: string): number {
    const t = this.nodes.get(id)!, s = this.state.towns[id];
    if (this.besiegersOf(id).length) return 0;
    return RULES.income[t.tier] * (1 + s.market * RULES.upgrades.market.perLevel)
      * (1 + (t.traits.port ? RULES.portBonus : 0) + (t.traits.rail ? RULES.railBonus : 0)) * (s.supplied ? 1 : RULES.cutOffShare);
  }

  /** What a neutral town would take to come over without a fight: more the better defended and the bigger it is. */
  bribeCost(id: string): number {
    return Math.round(this.strengthOf(id) * RULES.bribe.perStrength + (this.nodes.get(id)!.tier + 1) * RULES.bribe.perTier);
  }

  upgradeCost(id: string, kind: UpgradeKind): number {
    return RULES.upgrades[kind].base * (this.state.towns[id][kind] + 1) * (this.nodes.get(id)!.tier + 1);
  }

  upkeepOf(who: number): number {
    let total = 0;
    const tally = (u: Partial<Units>) => { for (const k of UNIT_KINDS) total += (u[k] || 0) * RULES.units[k].upkeep; };
    for (const t of Object.values(this.state.towns)) if (t.owner === who) tally(t.garrison);
    for (const a of this.state.armies) if (a.owner === who) tally(a);
    return total;
  }

  position(a: Army): Pt {
    if (a.at) { const t = this.nodes.get(a.at)!; return [t.x, t.y]; }
    const leg = a.path[a.leg], road = this.roads.get(leg.road)!;
    return pointAlong(road.pts, leg.rev ? road.length - a.dist : a.dist);
  }

  /** Everything a faction sees from, as [x, y, range]: the towns it holds and its armies. */
  eyes(who: number): [number, number, number][] {
    const eyes: [number, number, number][] = [];
    for (const t of this.state.graph.towns) if (this.state.towns[t.id].owner === who) eyes.push([t.x, t.y, RULES.vision.town + t.r]);
    // An army sees as far as its longest-sighted units; scouts see a long way.
    for (const a of this.state.armies) {
      if (a.owner !== who) continue;
      const range = UNIT_KINDS.reduce<number>((r, k) => (a[k] > 0 ? Math.max(r, (RULES.units[k] as { sight?: number }).sight ?? 0) : r), RULES.vision.group);
      eyes.push([...this.position(a), range]);
    }
    return eyes;
  }

  /** Towns a faction can see right now: near a town it holds or an army of its own. */
  visible(who: number): Set<string> {
    const eyes = this.eyes(who);
    const out = new Set<string>();
    for (const t of this.state.graph.towns) {
      if (eyes.some(([x, y, r]) => Math.hypot(t.x - x, t.y - y) <= r)) out.add(t.id);
    }
    return out;
  }

  canSee(who: number, p: Pt): boolean {
    return this.eyes(who).some(([x, y, r]) => Math.hypot(x - p[0], y - p[1]) <= r);
  }

  // ----- Routes -----

  /** Road distance from one town to every town it can reach on intact roads. */
  distances(from: string): Map<string, number> {
    return this.search(from, null, (r) => r.length).dist;
  }

  /** Shortest paths from a town. `through` limits which towns a path may pass beyond. */
  private search(from: string, to: string | null, weight: (r: Road) => number, through?: (id: string) => boolean, rider?: number) {
    // Railways carry only the side that holds both ends; with no rider given they are left out.
    const open = (r: Road) => r.intact && ((r.kind !== 'rail' && r.kind !== 'sea') || (rider !== undefined && this.state.towns[r.a].owner === rider && this.state.towns[r.b].owner === rider));
    const dist = new Map<string, number>([[from, 0]]);
    const via = new Map<string, { road: Road; prev: string }>();
    const done = new Set<string>();
    for (;;) {
      let cur: string | null = null, best = Infinity;
      for (const [k, d] of dist) if (!done.has(k) && d < best) { best = d; cur = k; }
      if (cur === null || cur === to) break;
      done.add(cur);
      if (through && cur !== from && !through(cur)) continue;
      for (const { road, other } of this.links.get(cur) ?? []) {
        if (!open(road)) continue;
        const d = best + weight(road);
        if (d < (dist.get(other) ?? Infinity)) { dist.set(other, d); via.set(other, { road, prev: cur }); }
      }
    }
    const legsTo = (id: string): Leg[] => {
      const legs: Leg[] = [];
      for (let at = id; at !== from;) {
        const { road, prev } = via.get(at)!;
        legs.unshift({ road: road.id, rev: road.a !== prev });
        at = prev;
      }
      return legs;
    };
    return { dist, legsTo };
  }

  /** Quickest route for these units between two towns, over intact roads; null if there is none. */
  route(from: string, to: string, units: Partial<Units> & { owner?: number }, owner = units.owner): { legs: Leg[]; time: number } | null {
    if (from === to) return { legs: [], time: 0 };
    const { dist, legsTo } = this.search(from, to, (r) => r.length / speedOn(units, r.kind), undefined, owner);
    return dist.has(to) ? { legs: legsTo(to), time: dist.get(to)! } : null;
  }

  /** The quickest way from a town to the nearest town its side holds, passing only through towns it holds. */
  private wayHome(owner: number, from: string, units: Units): { to: string; legs: Leg[]; time: number } | null {
    const mine = (id: string) => this.state.towns[id].owner === owner;
    const { dist, legsTo } = this.search(from, null, (r) => r.length / speedOn(units, r.kind), mine, owner);
    let best: string | null = null;
    for (const [id, d] of dist) if (id !== from && mine(id) && (best === null || d < dist.get(best)!)) best = id;
    return best ? { to: best, legs: legsTo(best), time: dist.get(best)! } : null;
  }

  private endOf(leg: Leg): string {
    const road = this.roads.get(leg.road)!;
    return leg.rev ? road.a : road.b;
  }

  // ----- Armies -----

  private raise(owner: number, units: Units, at: string | null, extra: Partial<Army> = {}): Army {
    const f = this.faction(owner);
    const name = extra.name ?? `${owner === PLAYER ? '' : `${f.name} `}${ordinal(++f.raised)} Army`;
    const army: Army = { id: this.state.nextId++, owner, ...only(units), at, from: at ?? '', to: at ?? '', path: [], leg: 0, dist: 0, speed: 0,
      siege: null, retreating: false, settle: false, stars: 0, ...extra, name };
    this.state.armies.push(army);
    return army;
  }

  /** An army that has come to rest sets off for the next town it was told to go on to, if any. */
  private carryOn(a: Army): void {
    while (a.orders?.length && a.at && !a.siege && !a.retreating && this.state.armies.includes(a)) {
      const to = a.orders.shift()!;
      const r = to !== a.at ? this.route(a.at, to, a) : null;
      if (r?.legs.length) { const rest = a.orders; this.march(a, r.legs, to); a.orders = rest; return; }
    }
  }

  private disband(a: Army): void {
    const i = this.state.armies.indexOf(a);
    if (i >= 0) this.state.armies.splice(i, 1);
  }

  private march(a: Army, legs: Leg[], to: string): void {
    a.from = a.at ?? a.from;
    a.at = null;
    a.siege = null;
    a.orders = [];
    a.path = legs;
    a.leg = 0;
    a.dist = 0;
    a.to = to;
    a.speed = speedOn(a, this.roads.get(legs[0].road)!.kind);
  }

  /** Raise an army from a town and send it on its way. */
  private dispatch(owner: number, from: string, to: string, units: Units, settle = false): boolean {
    const r = this.route(from, to, units, owner);
    if (!r || !r.legs.length) return false;
    const army = this.raise(owner, units, from, settle ? { settle, name: 'Recruits' } : {});
    this.march(army, r.legs, to);
    return true;
  }

  /** Beaten units fall back from a town towards the nearest town their side holds. Returns how many got away. */
  private retreatFrom(units: Units, owner: number, town: string, name?: string): number {
    if (owner === NEUTRAL || !count(units)) return 0;
    const home = this.wayHome(owner, town, units);
    if (!home) return 0;
    const army = this.raise(owner, units, town, { retreating: true, ...(name ? { name } : {}) });
    this.march(army, home.legs, home.to);
    return count(units);
  }

  /** An army storms the town it has reached. `breached` means a full siege has made the fortifications useless. */
  private assault(army: Army, id: string, breached: boolean): void {
    const s = this.state, town = s.towns[id], node = this.nodes.get(id)!;
    const camped = this.defendersAt(id);
    const attackers = only(army), defenders = this.forceAt(id);
    const ap = attackPower(army, true) * veteran(army), dp = this.strengthOf(id, breached);
    const r = fight(ap, dp);
    const before = town.owner, at: Pt = [node.x, node.y];
    // Whoever attacks a town finds out what was defending it.
    (this.faction(army.owner).intel ??= {})[id] = this.strengthOf(id, true);
    const report = (mine: 'att' | 'def', attLeft: Units, defLeft: Units): Report => (mine === 'att'
      ? { kind: 'assault', place: node.name, won: r.win, you: { before: attackers, after: attLeft, power: ap }, them: { owner: before, before: defenders, after: defLeft, power: dp } }
      : { kind: 'defence', place: node.name, won: !r.win, you: { before: defenders, after: defLeft, power: dp }, them: { owner: army.owner, before: attackers, after: attLeft, power: ap } });

    if (!r.win) {
      // The defenders hold. They take losses in proportion; the attackers fall back if they can.
      const kept = 1 - r.loss;
      town.garrison = share(town.garrison, kept);
      for (const a of camped) Object.assign(a, share(a, kept));
      for (const a of camped) { if (!count(a)) this.disband(a); else this.earn(a); }
      const defLeft = this.forceAt(id);
      if (count(defenders) && !count(defLeft)) town.garrison.infantry = 1;
      const away = army.retreating ? none() : share(army, r.keep);
      this.disband(army);
      const escaped = this.retreatFrom(away, army.owner, id, army.name);
      const left = escaped ? away : none();
      this.score(before, army.owner, count(defenders) - count(this.forceAt(id)), count(attackers) - count(left));
      this.note(`Attack on ${node.name} failed${escaped ? `; ${escaped} of ${count(attackers)} got away` : `: all ${count(attackers)} lost`}.`, army.owner, { at, kind: 'battle', report: report('att', left, this.forceAt(id)) });
      if (before !== NEUTRAL) this.note(`${node.name} held against an attack.`, before, { at, kind: 'battle', report: report('def', left, this.forceAt(id)) });
      return;
    }

    // The town falls. The army camps in it; surviving defenders retreat if they have somewhere to go.
    const survivors = share(army, 1 - r.loss, true);
    const fled = share(defenders, r.keep);
    for (const a of camped) this.disband(a);
    town.owner = army.owner;
    town.garrison = none();
    town.rally = null;
    for (const b of Object.values(town.buildings)) { if (!b.done) b.progress = 0; for (const l of Object.values(b.lines)) Object.assign(l, { queue: 0, training: 0, repeat: false }); }
    Object.assign(army, survivors, { at: id, siege: null, path: [], leg: 0, dist: 0, to: id });
    this.earn(army);
    const onward = army.orders;
    for (const other of this.besiegersOf(id)) if (other.owner === army.owner) other.siege = null;
    const escaped = this.retreatFrom(fled, before, id);
    const defLeft = escaped ? fled : none();
    const lost = count(attackers) - count(survivors);
    this.score(army.owner, before, lost, count(defenders) - count(defLeft));
    const loot = RULES.loot[node.tier];
    this.faction(army.owner).money += loot;
    this.note(`${node.name} captured${lost ? `, ${lost} lost` : ''}; ${loot} seized.`, army.owner, { at, kind: 'battle', report: report('att', survivors, defLeft) });
    if (before !== NEUTRAL) this.note(`${node.name} has fallen${escaped ? `; ${escaped} of its defenders are retreating` : ''}.`, before, { at, kind: 'battle', report: report('def', survivors, defLeft) });
    // Losing its capital finishes a side: its towns go their own way and its armies scatter.
    const loser = s.factions.find((f) => f.id !== NEUTRAL && f.capital === id && f.id !== army.owner && f.alive);
    if (loser) {
      loser.alive = false;
      for (const t of Object.values(s.towns)) if (t.owner === loser.id) { t.owner = NEUTRAL; t.rally = null; for (const b of Object.values(t.buildings)) for (const l of Object.values(b.lines)) Object.assign(l, { queue: 0, training: 0, repeat: false }); }
      for (const a of [...s.armies]) if (a.owner === loser.id) this.disband(a);
      for (const f of s.factions) if (f.id !== NEUTRAL && f.id !== loser.id && f.alive) this.note(`The ${loser.name} has fallen: ${node.name}, its capital, was taken.`, f.id, { at });
      const left = s.factions.filter((f) => f.id !== NEUTRAL && f.alive);
      // The game is decided when the player is out, or only one side is left.
      if (s.winner === null && (loser.id === PLAYER || left.length === 1)) s.winner = army.owner;
    }
    this.onCapture?.(node, army.owner);
    army.orders = onward;
    this.carryOn(army);
  }

  /** An army reaches a town at the end of a leg. Returns false if it can go no further. */
  private reach(army: Army, id: string, last: boolean): boolean {
    const s = this.state, town = s.towns[id], node = this.nodes.get(id)!;
    const at: Pt = [node.x, node.y];
    if (town.owner !== army.owner) {
      // Not ours: join a siege already under way, start one, or attack at once if the place has no walls.
      const ally = this.besiegersOf(id).find((a) => a.owner === army.owner);
      if (ally) { Object.assign(ally, add(ally, army)); this.disband(army); return false; }
      const need = army.retreating ? 0 : this.siegeNeed(id);
      Object.assign(army, { at: id, path: [], leg: 0, dist: 0, to: id });
      if (need > 0) {
        army.siege = { progress: 0, need };
        this.note(`${army.name} is besieging ${node.name}.`, army.owner, { at, kind: 'siege' });
        if (town.owner !== NEUTRAL) this.note(`${node.name} is under siege.`, town.owner, { at, kind: 'siege' });
      } else this.assault(army, id, false);
      return false;
    }
    // Ours. If it is under siege, this army is the relief: it fights the besiegers, helped by a sortie from the garrison.
    const besiegers = this.besiegersOf(id);
    if (besiegers.length) {
      const enemy = besiegers.reduce((u, b) => add(u, b), none());
      const ap = attackPower(army) * veteran(army) + RULES.sortie * attackPower(town.garrison), bp = besiegers.reduce((n, b) => n + attackPower(b) * veteran(b), 0);
      const r = fight(ap, bp), mine = only(army);
      if (r.win) {
        Object.assign(army, share(army, 1 - r.loss, true));
        this.earn(army);
        let fled = 0;
        for (const b of besiegers) { this.disband(b); fled += this.retreatFrom(share(b, r.keep), b.owner, id, b.name); }
        this.note(`${army.name} broke the siege of ${node.name}.`, army.owner, { at, kind: 'battle',
          report: { kind: 'field', place: `outside ${node.name}`, won: true, you: { before: mine, after: only(army), power: ap }, them: { owner: besiegers[0].owner, before: enemy, after: share(enemy, fled ? r.keep : 0), power: bp } } });
        for (const o of new Set(besiegers.map((b) => b.owner))) this.note(`Your siege of ${node.name} was broken.`, o, { at, kind: 'battle',
          report: { kind: 'field', place: `outside ${node.name}`, won: false, you: { before: enemy, after: share(enemy, fled ? r.keep : 0), power: bp }, them: { owner: army.owner, before: mine, after: only(army), power: ap } } });
      } else {
        // Beaten outside the walls: what is left of the relief force gets inside.
        for (const b of besiegers) { Object.assign(b, share(b, 1 - r.loss, true)); this.earn(b); }
        const inside = share(army, r.keep);
        town.garrison = add(town.garrison, inside);
        this.disband(army);
        const after = besiegers.reduce((u, b) => add(u, b), none());
        this.note(`${army.name} failed to break the siege of ${node.name}; ${count(inside)} reached the town.`, army.owner, { at, kind: 'battle',
          report: { kind: 'field', place: `outside ${node.name}`, won: false, you: { before: mine, after: inside, power: ap }, them: { owner: besiegers[0].owner, before: enemy, after, power: bp } } });
        return false;
      }
    }
    if (!last) return true;
    if (army.settle) { town.garrison = add(town.garrison, army); this.disband(army); return false; }
    Object.assign(army, { at: id, path: [], leg: 0, dist: 0, to: id, retreating: false });
    this.carryOn(army);
    return false;
  }

  /** Two hostile armies meet on a road and fight. The loser falls back the way it came, if that leads home. */
  private meet(a: Army, b: Army): void {
    const pa = attackPower(a) * veteran(a), pb = attackPower(b) * veteran(b), ua = only(a), ub = only(b);
    const r = fight(pa, pb);
    const [winner, loser] = r.win ? [a, b] : [b, a];
    const road = this.roads.get(a.path[a.leg].road)!;
    const place = `between ${this.nodes.get(road.a)!.name} and ${this.nodes.get(road.b)!.name}`;
    const at = this.position(a);
    Object.assign(winner, share(winner, 1 - r.loss, true));
    this.earn(winner);
    // The loser turns for whichever end of this road its own side holds; with neither, it is destroyed.
    const kept = loser.retreating ? none() : share(loser, r.keep);
    const leg = loser.path[loser.leg], lr = this.roads.get(leg.road)!;
    const behind = leg.rev ? lr.b : lr.a, ahead = this.endOf(leg);
    const holds = (id: string) => this.state.towns[id].owner === loser.owner;
    if (count(kept) && (holds(behind) || holds(ahead))) {
      Object.assign(loser, kept, { retreating: true });
      if (holds(behind)) { loser.path = [{ road: leg.road, rev: !leg.rev }]; loser.dist = lr.length - loser.dist; loser.to = behind; } else { loser.path = [leg]; loser.to = ahead; }
      loser.leg = 0;
      loser.speed = speedOn(loser, lr.kind);
    } else { Object.assign(loser, none()); this.disband(loser); }
    const side = (mine: Army): Report => {
      const isA = mine === a;
      return { kind: 'field', place, won: mine === winner, you: { before: isA ? ua : ub, after: only(mine), power: isA ? pa : pb },
        them: { owner: (isA ? b : a).owner, before: isA ? ub : ua, after: only(isA ? b : a), power: isA ? pb : pa } };
    };
    this.score(winner.owner, loser.owner, count(winner === a ? ua : ub) - count(winner), count(loser === a ? ua : ub) - count(loser));
    this.note(`${winner.name} won a fight ${place}.`, winner.owner, { at, kind: 'battle', report: side(winner) });
    this.note(`${loser.name} was beaten ${place}${count(loser) ? ` and is retreating with ${count(loser)}` : ' and destroyed'}.`, loser.owner, { at, kind: 'battle', report: side(loser) });
  }

  // ----- One slice of time -----

  step(dt: number): void {
    const s = this.state;
    s.clock += dt;

    // Money: income from towns, less upkeep for every unit.
    for (const f of s.factions) {
      if (f.id === NEUTRAL || !f.alive) continue;
      let perMinute = -this.upkeepOf(f.id);
      // Computer-run sides earn more or less according to the difficulty chosen.
      const tuned = f.ai ? RULES.difficulty[s.settings?.difficulty ?? 'normal'].income : 1;
      for (const t of s.graph.towns) if (s.towns[t.id].owner === f.id) perMinute += this.incomeOf(t.id) * tuned;
      f.money = Math.max(0, f.money + (perMinute * dt) / 60);
    }

    // Construction and training.
    for (const [id, town] of Object.entries(s.towns)) {
      if (town.owner === NEUTRAL) continue;
      const owner = this.faction(town.owner), node = this.nodes.get(id)!;
      for (const [kind, b] of Object.entries(town.buildings) as [BuildingKind, Building][]) {
        const rule = RULES.buildings[kind];
        if (!b.done) {
          b.progress += dt / rule.time;
          if (b.progress >= 1) { b.done = true; b.progress = 0; this.note(`${rule.name} finished in ${node.name}.`, town.owner, { at: [node.x, node.y], kind: 'built' }); }
          continue;
        }
        // Each kind of unit a building trains has its own line, and the lines run side by side.
        for (const [kindOfUnit, line] of Object.entries(b.lines) as [UnitKind, Line][]) {
          const unit = RULES.units[kindOfUnit];
          if (line.repeat && line.queue === 0 && owner.money >= unit.cost) { owner.money -= unit.cost; line.queue = 1; }
          if (line.queue <= 0) continue;
          line.training += dt / unit.time;
          while (line.training >= 1 && line.queue > 0) {
            line.training -= 1;
            line.queue--;
            const fresh = { ...none(), [kindOfUnit]: 1 };
            // New units go straight to the rally point, if one is set and still held.
            if (!(town.rally && s.towns[town.rally]?.owner === town.owner && this.dispatch(town.owner, id, town.rally, fresh, true))) town.garrison[kindOfUnit] = (town.garrison[kindOfUnit] || 0) + 1;
          }
          if (!line.queue) line.training = 0;
        }
      }
    }

    // Neutral towns slowly make good their losses, so a failed attack is not a free head start on the next.
    if (Math.floor(s.clock / RULES.neutralRecover) > Math.floor((s.clock - dt) / RULES.neutralRecover)) {
      for (const t of s.graph.towns) {
        const town = s.towns[t.id], full = RULES.neutralGarrison[t.tier];
        if (town.owner !== NEUTRAL || this.besiegersOf(t.id).length) continue;
        const short = UNIT_KINDS.find((k) => (town.garrison[k] || 0) < ((full as Partial<Units>)[k] || 0));
        if (short) town.garrison[short] = (town.garrison[short] || 0) + 1;
      }
    }

    // Road repairs.
    for (const r of s.graph.roads) {
      if (r.repair < 0) continue;
      r.repair += dt / (r.bridges.length ? RULES.roads.repairBridgeTime : RULES.roads.repairTime);
      if (r.repair >= 1) { r.repair = -1; r.intact = true; r.cutAt = null; }
    }

    // Sieges run their course, then the besiegers go in.
    for (const a of [...s.armies]) {
      if (!a.siege || !a.at || !s.armies.includes(a)) continue;
      if (s.towns[a.at].owner === a.owner) { a.siege = null; continue; }
      // Artillery makes short work of walls.
      a.siege.progress += dt * (1 + Math.min(RULES.siegeGuns.cap, RULES.siegeGuns.each * (a.artillery || 0)));
      if (a.siege.progress >= a.siege.need) this.assault(a, a.at, true);
    }

    // Movement. Each army's stretch of road covered this step is kept so that hostile
    // armies passing each other can be made to fight.
    const swept = new Map<Army, { road: string; lo: number; hi: number }>();
    for (const a of [...s.armies]) {
      if (a.at || !s.armies.includes(a)) continue;
      let move = a.speed * dt;
      const along = () => { const leg = a.path[a.leg], road = this.roads.get(leg.road)!; return leg.rev ? road.length - a.dist : a.dist; };
      const startRoad = a.path[a.leg].road, startAt = along();
      let changed = false;
      while (move > 0) {
        const leg = a.path[a.leg], road = this.roads.get(leg.road)!;
        const left = road.length - a.dist;
        if (move < left) { a.dist += move; break; }
        move -= left;
        changed = true;
        const reached = this.endOf(leg);
        const last = a.leg === a.path.length - 1;
        if (!this.reach(a, reached, last)) break;
        // A cut road ahead: find another way from here, or stop.
        if (!this.roads.get(a.path[a.leg + 1].road)!.intact) {
          const again = this.route(reached, a.to, a);
          if (!again) { this.reach(a, reached, true); this.note(`${a.name} stopped at ${this.nodes.get(reached)!.name}: the road ahead is cut.`, a.owner); break; }
          a.path = [...a.path.slice(0, a.leg + 1), ...again.legs];
        }
        a.leg++;
        a.dist = 0;
        a.speed = speedOn(a, this.roads.get(a.path[a.leg].road)!.kind);
      }
      if (!changed && !a.at && s.armies.includes(a)) { const now = along(); swept.set(a, { road: startRoad, lo: Math.min(startAt, now), hi: Math.max(startAt, now) }); }
    }
    const moving = [...swept.keys()];
    for (let i = 0; i < moving.length; i++) {
      for (let j = i + 1; j < moving.length; j++) {
        const a = moving[i], b = moving[j];
        // An army already in retreat is not brought to battle again on the road.
        if (a.owner === b.owner || !s.armies.includes(a) || !s.armies.includes(b) || a.at || b.at || a.retreating || b.retreating) continue;
        const sa = swept.get(a)!, sb = swept.get(b)!;
        if (sa.road === sb.road && sa.lo <= sb.hi + 60 && sb.lo <= sa.hi + 60) this.meet(a, b);
      }
    }

    this.refresh();

    // The rival thinks every few seconds.
    for (const f of s.factions) {
      if (f.ai && f.alive && this.brain && s.clock - f.thought >= 3) { f.thought = s.clock; this.brain(this, f); }
    }

    // A record of who held how much, for the chart at the end.
    const lastSample = s.history[s.history.length - 1];
    if (!lastSample || s.clock - lastSample.clock >= RULES.historyEvery) {
      const held: Record<number, number> = {};
      for (const t of Object.values(s.towns)) held[t.owner] = (held[t.owner] ?? 0) + 1;
      s.history.push({ clock: Math.round(s.clock), held });
      if (s.history.length > 600) s.history = s.history.filter((_, i) => i % 2 === 0);
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

  private heldNow(): Record<number, number> {
    const held: Record<number, number> = {};
    for (const t of Object.values(this.state.towns)) held[t.owner] = (held[t.owner] ?? 0) + 1;
    return held;
  }

  /** Recompute which towns are joined to their capital, and what each side has seen. */
  refresh(): void {
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
    const asked = (max: Partial<Units>): Units => each((k) => Math.min(max[k] || 0, Math.max(0, Math.floor(Number(c[k]) || 0))));
    const army = s.armies.find((a) => a.id === c.army);
    const myArmy = army?.owner === who;
    /** An army of mine camped in a town of mine, neither besieging nor retreating. */
    const camped = myArmy && !!army.at && !army.siege && !army.retreating && s.towns[army.at].owner === who;

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
        town.buildings[kind] = newBuilding(kind);
        return { ok: true };
      }
      case 'train':
      case 'repeat':
      case 'cancel': {
        const unit = c.unit as UnitKind, rule = RULES.units[unit];
        if (!mine) return fail('not your town');
        if (!rule) return fail('unknown unit');
        const b = Object.values(town.buildings).find((v) => v.done && v.lines[unit])?.lines[unit];
        if (!b) return fail(`needs a finished ${Object.values(RULES.buildings).find((x) => (x.trains as readonly string[]).includes(unit))!.name.toLowerCase()}`);
        if (c.type === 'repeat') { b.repeat = !!c.on; return { ok: true }; }
        if (c.type === 'cancel') {
          // Take one unit off the training queue and give the money back.
          if (b.queue < 1) return fail('nothing in training');
          b.queue--;
          if (!b.queue) b.training = 0;
          me.money += rule.cost;
          return { ok: true };
        }
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
      case 'bribe': {
        // Buy a neutral town outright. It must be next door to a town of yours, and in sight.
        if (!town || town.owner !== NEUTRAL) return fail('only a neutral town can be bought');
        if (!(this.links.get(id) ?? []).some((l) => l.road.intact && s.towns[l.other].owner === who)) return fail('it must be one road away from a town you hold');
        if (this.besiegersOf(id).length) return fail('it is under siege');
        if (!pay(this.bribeCost(id))) return fail('not enough money');
        // Half its defenders stay on as your garrison.
        town.owner = who;
        town.garrison = share(town.garrison, 0.5);
        this.note(`${this.nodes.get(id)!.name} has come over to you.`, who, { at: [this.nodes.get(id)!.x, this.nodes.get(id)!.y], kind: 'built' });
        this.onCapture?.(this.nodes.get(id)!, who);
        this.refresh();
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
        // Raise an army from a town's garrison and send it somewhere.
        const from = String(c.from), to = String(c.to), src = s.towns[from];
        if (!src || src.owner !== who) return fail('not your town');
        if (!s.towns[to] || to === from) return fail('pick another town');
        const units = asked(src.garrison);
        if (!count(units)) return fail('no units to send');
        if (!this.dispatch(who, from, to, units)) return fail('no road leads there');
        take(src.garrison, units);
        return { ok: true };
      }
      case 'muster': {
        // Form an army from the garrison; it camps at the town until given orders.
        if (!mine) return fail('not your town');
        const units = asked(town.garrison);
        if (!count(units)) return fail('no units picked');
        take(town.garrison, units);
        this.raise(who, units, id);
        return { ok: true };
      }
      case 'redirect': {
        // Give an army somewhere new to go. One on the road may carry on to the next town or turn round, whichever is quicker.
        if (!myArmy) return fail('not your army');
        if (army.retreating) return fail('that army is retreating and takes no orders');
        const to = c.to === undefined ? army.from : String(c.to);
        if (!s.towns[to]) return fail('pick a town');
        if (c.queue && (!army.at || army.siege)) {
          // Add a town to go on to afterwards, instead of changing where it is heading now.
          if ((army.orders ??= []).length >= 8) return fail('that is enough waypoints');
          army.orders.push(to);
          return { ok: true };
        }
        if (army.at) {
          if (to === army.at) return fail('it is already there');
          const r = this.route(army.at, to, army);
          if (!r) return fail('no road leads there');
          this.march(army, r.legs, to);
          return { ok: true };
        }
        const leg = army.path[army.leg], road = this.roads.get(leg.road)!;
        const pace = speedOn(army, road.kind);
        const ahead = this.route(this.endOf(leg), to, army), behind = this.route(leg.rev ? road.b : road.a, to, army);
        const tAhead = ahead ? (road.length - army.dist) / pace + ahead.time : Infinity;
        const tBehind = behind ? army.dist / pace + behind.time : Infinity;
        if (tAhead === Infinity && tBehind === Infinity) return fail('no road leads there');
        if (tAhead <= tBehind) army.path = [leg, ...ahead!.legs];
        else { army.path = [{ road: leg.road, rev: !leg.rev }, ...behind!.legs]; army.dist = road.length - army.dist; }
        army.leg = 0;
        army.to = to;
        return { ok: true };
      }
      case 'storm': {
        // Give up on the siege and go in now, against the full fortifications.
        if (!myArmy || !army.siege || !army.at) return fail('that army is not besieging anything');
        this.assault(army, army.at, false);
        return { ok: true };
      }
      case 'merge': {
        // Fold every other army of mine at the same place, doing the same thing, into this one.
        if (!myArmy || !army.at || army.retreating) return fail('that army cannot merge now');
        const others = s.armies.filter((a) => a !== army && a.owner === who && a.at === army.at && !a.retreating && !!a.siege === !!army.siege);
        if (!others.length) return fail('no other army of yours is here');
        // The merged army's experience is the average of its parts, weighted by size.
        const all = [army, ...others], men = all.reduce((n, a) => n + count(a), 0);
        army.stars = Math.floor(all.reduce((n, a) => n + (a.stars ?? 0) * count(a), 0) / men);
        for (const o of others) { Object.assign(army, add(army, o)); this.disband(o); }
        return { ok: true };
      }
      case 'split': {
        if (!camped) return fail('an army can only be split while camped in a town of yours');
        const units = asked(army);
        if (!count(units) || count(units) >= count(army)) return fail('pick some of its units, not all or none');
        take(army, units);
        this.raise(who, units, army.at, { stars: army.stars ?? 0 });
        return { ok: true };
      }
      case 'garrison': {
        // Stand an army down into the town's garrison.
        if (!camped) return fail('an army can only stand down in a town of yours');
        s.towns[army.at!].garrison = add(s.towns[army.at!].garrison, army);
        this.disband(army);
        return { ok: true };
      }
      case 'rename': {
        if (!myArmy) return fail('not your army');
        const name = String(c.name ?? '').trim().slice(0, 30);
        if (!name) return fail('give it a name');
        army.name = name;
        return { ok: true };
      }
      case 'cut':
      case 'repair': {
        const road = this.roads.get(String(c.road));
        if (!road) return fail('unknown road');
        if (s.towns[road.a].owner !== who && s.towns[road.b].owner !== who) return fail('you must hold a town at one end of the road');
        if (road.kind === 'sea') return fail('a sea crossing cannot be cut');
        const bridge = road.bridges.length > 0;
        if (c.type === 'cut') {
          if (!road.intact) return fail('already cut');
          if (!pay(bridge ? RULES.roads.cutBridge : RULES.roads.cut)) return fail('not enough money');
          road.intact = false;
          road.repair = -1;
          road.cutAt = bridge ? [road.bridges[0].x, road.bridges[0].y] : pointAlong(road.pts, road.length / 2);
          for (const f of s.factions) if (f.id !== NEUTRAL && f.id !== who && (s.towns[road.a].owner === f.id || s.towns[road.b].owner === f.id)) {
            this.note(`The road between ${this.nodes.get(road.a)!.name} and ${this.nodes.get(road.b)!.name} has been cut.`, f.id, { at: road.cutAt });
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
        // Everyone who would defend it, their strength behind the walls and once the walls are breached, and how long a siege takes.
        force: vis ? this.forceAt(t.id) : null,
        strength: vis ? this.strengthOf(t.id) : null, breached: vis ? this.strengthOf(t.id, true) : null,
        siege: this.siegeNeed(t.id), besieged: vis && this.besiegersOf(t.id).length > 0,
        // The price of buying it, if it is neutral, in sight and next to a town of the viewer's.
        bribe: vis && st.owner === NEUTRAL && (this.links.get(t.id) ?? []).some((l) => l.road.intact && s.towns[l.other].owner === who) ? this.bribeCost(t.id) : null,
        defence: this.defenceOf(t.id), fort: vis ? st.fort : null,
        ...(own ? { buildings: st.buildings, market: st.market, rally: st.rally, supplied: st.supplied, income: this.incomeOf(t.id),
          costs: { market: this.upgradeCost(t.id, 'market'), fort: this.upgradeCost(t.id, 'fort') } } : {}),
      };
    }
    return {
      clock: s.clock, speed: s.speed, me: { id: me.id, money: me.money, capital: me.capital, income, upkeep: this.upkeepOf(who) },
      factions: s.factions.map((f) => ({ id: f.id, name: f.name, color: f.color, alive: f.alive, capital: seen.has(f.capital) ? f.capital : null,
        // What is known of each side: the towns of theirs you have seen, and the units in those in view now.
        known: s.graph.towns.filter((t) => seen.has(t.id) && s.towns[t.id].owner === f.id).length,
        inView: s.graph.towns.filter((t) => visible.has(t.id) && s.towns[t.id].owner === f.id).reduce((n, t) => n + count(this.forceAt(t.id)), 0) })),
      towns,
      armies: s.armies.filter((a) => a.owner === who || (a.at ? visible.has(a.at) : this.canSee(who, this.position(a)))),
      roads: s.graph.roads.filter((r) => !r.intact).map((r) => ({ id: r.id, cutAt: r.cutAt, repair: r.repair })),
      events: s.events.filter((e) => e.to === who).slice(-40),
      winner: s.winner, dismissed: s.dismissed, settings: s.settings,
      // The record is only sent once the game is decided, when it is no longer a secret.
      summary: s.winner !== null ? { history: [...s.history, { clock: Math.round(s.clock), held: this.heldNow() }], tally: s.tally } : null,
      goal: Math.ceil(s.graph.towns.length * RULES.winShare),
    };
  }
}
