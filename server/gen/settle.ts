import { type Box, type Pt, Heap, Mask, boxOf, boxPad, boxesIntersect, chaikin, simplify } from './geom.ts';
import type { Hydro } from './hydro.ts';
import type { Relief } from './relief.ts';
import { hashInt, rand01 } from './rng.ts';
import type { Terrain } from './terrain.ts';

// Settlements and the transport links between them. All are pure functions of the seed:
// a settlement depends only on its lattice cell and neighbours, and a road, railway or
// motorway only on its two endpoints, so any chunk can ask for them and get the same answer.

const CELL = 3000;          // settlement lattice (m)
const MAX_ROAD = 10000;     // longest direct highway (m)
const MAX_RAIL = 22000;     // longest direct railway, between towns and cities (m)
const MAX_MOTORWAY = 30000; // longest direct motorway, between cities (m)

export interface Settlement {
  a: number; b: number; x: number; y: number;
  tier: number;             // 0 hamlet, 1 village, 2 town, 3 city
  r: number; name: string; rank: number; seed: number;
}
export interface Link { pts: Pt[]; kind: string; box: Box; a: Settlement; b: Settlement; ref: string; spur?: boolean }
export type Highway = Link;

interface SearchOpts {
  from: Pt; to: Pt;
  grid: number;             // routing grid (m), a multiple of 50
  pad: number;              // search margin around the endpoints (m)
  grade: number;            // penalty weight on gradient squared
  stream: number;           // cost of crossing a minor stream
  river: number;            // cost of crossing a river away from a crossing point
  site: number;             // cost of crossing a river at a crossing point
  avoid: Settlement[];      // built-up areas to route around
}

const TIER_R = [170, 380, 800, 1700];
const PRE = ['Ash', 'Bel', 'Cal', 'Dor', 'El', 'Fen', 'Gar', 'Hal', 'Ist', 'Kel', 'Lor', 'Mar', 'Nor', 'Oak', 'Pen',
  'Quin', 'Ros', 'Sel', 'Tor', 'Ul', 'Val', 'Wes', 'Yar', 'Bran', 'Clay', 'Dun', 'Ever', 'Fair', 'Glen', 'Har',
  'King', 'Mill', 'New', 'Red', 'Stone', 'Wood', 'Wel', 'Cor', 'Lin', 'Thorn', 'Ald', 'Black', 'Green', 'Hart'];
const MID = ['', '', '', 'a', 'e', 'i', 'o', 'en', 'er', 'ing', 'ber', 'den', 'ley', 'ming'];
const SUF = ['ton', 'ville', 'field', 'ford', 'burg', 'ham', 'port', 'wood', 'dale', 'mont', 'ridge', 'brook',
  'haven', 'stead', 'worth', 'view', 'crest', 'side', 'bury', 'mouth', 'wick', 'by', 'well', 'moor'];

/** A place-style name from a hash, e.g. "Calenford". */
export function placeName(h: number): string {
  return PRE[h % PRE.length] + MID[(h >>> 8) % MID.length] + SUF[(h >>> 16) % SUF.length];
}
/** A shorter name stem, e.g. "Calen", for rivers, hills and forests. */
export function stemName(h: number): string {
  return PRE[h % PRE.length] + MID[(h >>> 8) % MID.length];
}

export class Settlements {
  private terrain: Terrain;
  private hydro: Hydro;
  private relief: Relief;
  private seed: number;
  private raw = new Map<number, Settlement | null>();
  private final = new Map<number, Settlement | null>();
  private routes = new Map<string, Link | null>();
  private hubs = new Map<Settlement, Pt | null>();

  constructor(terrain: Terrain, hydro: Hydro, relief: Relief) {
    this.terrain = terrain;
    this.hydro = hydro;
    this.relief = relief;
    this.seed = hashInt(terrain.seed, 9001, 3);
  }

  private key(a: number, b: number): number {
    return (a + 1048576) * 2097152 + (b + 1048576);
  }

  private candidate(a: number, b: number): Settlement | null {
    const k = this.key(a, b);
    const hit = this.raw.get(k);
    if (hit !== undefined) return hit;
    const s = this.seed;
    let out: Settlement | null = null;
    if (rand01(s, a, b) < 0.45) {
      let best = -Infinity, bx = 0, by = 0, bRiver = 0;
      for (let c = 0; c < 4; c++) {
        const x = (a + 0.12 + 0.76 * rand01(s + 10 + c, a, b)) * CELL;
        const y = (b + 0.12 + 0.76 * rand01(s + 20 + c, a, b)) * CELL;
        const z = this.terrain.elev(x, y);
        if (z < 4 || z > 420) continue;
        const slope = Math.hypot(this.terrain.elev(x + 60, y) - z, this.terrain.elev(x, y + 60) - z) / 60;
        if (slope > 0.12) continue;
        const river = this.hydro.riverNear(x, y, 130, 650);
        const score = (river ? 0.5 + 0.02 * Math.sqrt(Math.min(river, 2500)) : 0) + (z < 25 ? 0.3 : 0)
          + 0.5 * rand01(s + 30 + c, a, b) - slope * 8;
        if (score > best) { best = score; bx = x; by = y; bRiver = river; }
      }
      if (best > -Infinity) {
        const h = hashInt(s + 40, a, b);
        const t = this.terrain.population(bx, by) * 1.7 + rand01(s + 50, a, b) + (bRiver ? 0.2 : 0) + (bRiver > 400 ? 0.15 : 0);
        const tier = t > 1.4 ? 3 : t > 0.9 ? 2 : t > 0.42 ? 1 : 0;
        out = {
          a, b, x: Math.round(bx), y: Math.round(by), tier,
          r: TIER_R[tier] * (0.85 + 0.3 * rand01(s + 60, a, b)),
          name: placeName(h), rank: tier * 4294967296 + h, seed: h,
        };
      }
    }
    this.raw.set(k, out);
    return out;
  }

  /** A candidate survives unless a higher-ranked candidate's footprint overlaps it. */
  private at(a: number, b: number): Settlement | null {
    const k = this.key(a, b);
    const hit = this.final.get(k);
    if (hit !== undefined) return hit;
    let s = this.candidate(a, b);
    if (s) {
      outer: for (let db = -2; db <= 2; db++) {
        for (let da = -2; da <= 2; da++) {
          if (!da && !db) continue;
          const o = this.candidate(a + da, b + db);
          if (o && o.rank > s.rank && Math.hypot(o.x - s.x, o.y - s.y) < (o.r + s.r) * 1.05) {
            s = null;
            break outer;
          }
        }
      }
    }
    this.final.set(k, s);
    return s;
  }

  within(b: Box, minTier = 0): Settlement[] {
    const out: Settlement[] = [];
    const a0 = Math.floor(b.minx / CELL), a1 = Math.floor(b.maxx / CELL);
    const b0 = Math.floor(b.miny / CELL), b1 = Math.floor(b.maxy / CELL);
    for (let j = b0; j <= b1; j++) {
      for (let i = a0; i <= a1; i++) {
        const s = this.at(i, j);
        if (s && s.tier >= minTier && s.x >= b.minx && s.x <= b.maxx && s.y >= b.miny && s.y <= b.maxy) out.push(s);
      }
    }
    return out;
  }

  /**
   * Links of one network whose route may pass through the box. Two settlements are
   * linked if they are close enough and no third sits between them (a Gabriel graph).
   */
  private network(b: Box, minTier: number, maxLen: number, pad: number, make: (A: Settlement, B: Settlement) => Link | null): Link[] {
    const near = this.within(boxPad(b, maxLen * 2), minTier);
    const out: Link[] = [];
    for (let i = 0; i < near.length; i++) {
      for (let j = i + 1; j < near.length; j++) {
        const A = near[i], B = near[j];
        const d = Math.hypot(A.x - B.x, A.y - B.y);
        if (d > maxLen) continue;
        if (!boxesIntersect(boxPad(boxOf([[A.x, A.y], [B.x, B.y]]), pad), b)) continue;
        const mx = (A.x + B.x) / 2, my = (A.y + B.y) / 2;
        let blocked = false;
        for (const C of near) {
          if (C !== A && C !== B && Math.hypot(C.x - mx, C.y - my) < d / 2) { blocked = true; break; }
        }
        if (blocked) continue;
        const link = A.rank < B.rank ? make(A, B) : make(B, A);
        if (link && boxesIntersect(link.box, b)) out.push(link);
      }
    }
    return out;
  }

  private cached(kind: string, A: Settlement, B: Settlement, build: () => Link | null): Link | null {
    const key = `${kind}:${A.a},${A.b}|${B.a},${B.b}`;
    let hit = this.routes.get(key);
    if (hit === undefined) { hit = build(); this.routes.set(key, hit); }
    return hit;
  }

  /** Ordinary roads between neighbouring settlements. */
  highways(b: Box): Link[] {
    return this.network(b, 0, MAX_ROAD, 1300, (A, B) => this.cached('road', A, B, () => {
      const pts = this.search({ from: [A.x, A.y], to: [B.x, B.y], grid: 50, pad: 1200, grade: 196, stream: 30, river: 2500, site: 150, avoid: [] });
      if (!pts) return null;
      const low = Math.min(A.tier, B.tier);
      const kind = low >= 2 ? 'primary' : low >= 1 ? 'secondary' : 'tertiary';
      const h = hashInt(this.seed + 70, A.seed, B.seed);
      const ref = kind === 'primary' ? `A${10 + (h % 89)}` : kind === 'secondary' ? `B${100 + (h % 899)}` : '';
      const smooth = chaikin(simplify(pts, 40), 3);
      return { pts: smooth, kind, box: boxOf(smooth), a: A, b: B, ref };
    }));
  }

  /** Railways between towns and cities, built for gentle gradients. */
  rails(b: Box): Link[] {
    return this.network(b, 2, MAX_RAIL, 2200, (A, B) => this.cached('rail', A, B, () => {
      const pts = this.search({ from: [A.x, A.y], to: [B.x, B.y], grid: 100, pad: 2000, grade: 2500, stream: 20, river: 500, site: 500, avoid: [] });
      if (!pts) return null;
      const smooth = chaikin(simplify(pts, 70), 3);
      return { pts: smooth, kind: 'rail', box: boxOf(smooth), a: A, b: B, ref: '' };
    }));
  }

  /** Where a city's motorways meet: a point just outside town, on dry land. */
  interchange(s: Settlement): Pt | null {
    let p = this.hubs.get(s);
    if (p !== undefined) return p;
    p = null;
    if (s.tier === 3) {
      const a0 = rand01(this.seed + 80, s.a, s.b) * Math.PI * 2;
      for (let k = 0; k < 8 && !p; k++) {
        const a = a0 + (k * Math.PI) / 4;
        const x = Math.round(s.x + Math.cos(a) * (s.r + 700)), y = Math.round(s.y + Math.sin(a) * (s.r + 700));
        if (this.terrain.elev(x, y) > 3) p = [x, y];
      }
    }
    this.hubs.set(s, p);
    return p;
  }

  /** Motorways between cities. They run interchange to interchange and steer round other towns. */
  motorways(b: Box): Link[] {
    return this.network(b, 3, MAX_MOTORWAY, 4200, (A, B) => this.cached('motorway', A, B, () => {
      const from = this.interchange(A), to = this.interchange(B);
      if (!from || !to) return null;
      const avoid = this.within(boxPad(boxOf([from, to]), 5000));
      const pts = this.search({ from, to, grid: 100, pad: 4000, grade: 900, stream: 20, river: 400, site: 400, avoid });
      if (!pts) return null;
      const smooth = chaikin(simplify(pts, 80), 3);
      return { pts: smooth, kind: 'motorway', box: boxOf(smooth), a: A, b: B, ref: `M${1 + (hashInt(this.seed + 71, A.seed, B.seed) % 60)}` };
    }));
  }

  private around(s: Settlement): Box {
    return { minx: s.x - 1, miny: s.y - 1, maxx: s.x + 1, maxy: s.y + 1 };
  }

  /** Roads that start or end at a settlement, including a city's link out to its motorway interchange. */
  incident(s: Settlement): Link[] {
    const out = this.highways(this.around(s)).filter((h) => h.a === s || h.b === s);
    const hub = this.interchange(s);
    if (hub && this.motorways(boxPad(this.around(s), s.r + 800)).some((m) => m.a === s || m.b === s)) {
      const spur = this.cached('spur', s, s, () => {
        const pts: Pt[] = [];
        const n = Math.ceil(Math.hypot(hub[0] - s.x, hub[1] - s.y) / 50);
        for (let k = 0; k <= n; k++) pts.push([s.x + ((hub[0] - s.x) * k) / n, s.y + ((hub[1] - s.y) * k) / n]);
        return { pts, kind: 'primary', box: boxOf(pts), a: s, b: s, ref: '', spur: true };
      });
      if (spur) out.push(spur);
    }
    return out;
  }

  railsAt(s: Settlement): Link[] {
    return s.tier >= 2 ? this.rails(this.around(s)).filter((h) => h.a === s || h.b === s) : [];
  }

  /**
   * Least-cost route over the carved terrain, so routes take valley floors and passes.
   * Rivers are crossed at designated crossing points where possible, which is what makes
   * separate roads share a bridge.
   */
  private search(o: SearchOpts): Pt[] | null {
    const G = o.grid, K = G / 50;
    const x0 = Math.floor((Math.min(o.from[0], o.to[0]) - o.pad) / G) * G;
    const y0 = Math.floor((Math.min(o.from[1], o.to[1]) - o.pad) / G) * G;
    const w = Math.ceil((Math.max(o.from[0], o.to[0]) + o.pad - x0) / G) + 1;
    const h = Math.ceil((Math.max(o.from[1], o.to[1]) + o.pad - y0) / G) + 1;
    const win: Box = { minx: x0, miny: y0, maxx: x0 + (w - 1) * G, maxy: y0 + (h - 1) * G };
    const mask = new Mask(win, G);      // 1 stream, 2 river, 3 lake
    const sites = new Mask(win, G);     // crossing points
    const zones = new Mask(win, G);     // built-up areas to avoid
    const { rivers, lakes } = this.hydro.water(win);
    for (const r of rivers) {
      mask.stampLine(r.pts, Math.max(r.width, r.w1) / 2 + G * 0.6, r.minor ? 1 : 2);
      if (r.crossing) sites.stampLine([r.crossing, r.crossing], r.width / 2 + G * 1.8, 1);
    }
    for (const l of lakes) { mask.stampPoly(l.ring, 3); mask.stampLine([...l.ring, l.ring[0]], G * 0.6, 3); }
    for (const s of o.avoid) zones.stampLine([[s.x, s.y], [s.x, s.y]], s.r + 250, 1);
    const ix0 = x0 / 50, iy0 = y0 / 50;
    const z = new Float32Array(w * h).fill(NaN);
    const elev = (k: number): number => {
      let v = z[k];
      if (v !== v) {
        const i = k % w, j = (k - i) / w;
        v = z[k] = this.relief.cell(ix0 + i * K, iy0 + j * K);
      }
      return v;
    };
    const open = (k: number): boolean => mask.data[k] !== 3 && elev(k) > 0.8;
    const snap = (p: Pt): number => {
      const ci = Math.round((p[0] - x0) / G), cj = Math.round((p[1] - y0) / G);
      for (let r = 0; r <= 4; r++) {
        for (let dj = -r; dj <= r; dj++) {
          for (let di = -r; di <= r; di++) {
            const i = ci + di, j = cj + dj;
            if (i >= 0 && j >= 0 && i < w && j < h && open(j * w + i)) return j * w + i;
          }
        }
      }
      return -1;
    };
    const start = snap(o.from), goal = snap(o.to);
    if (start < 0 || goal < 0) return null;
    const gi = goal % w, gj = (goal - gi) / w;
    const g = new Float32Array(w * h).fill(Infinity);
    const from = new Int32Array(w * h).fill(-1);
    const closed = new Uint8Array(w * h);
    const heap = new Heap();
    g[start] = 0;
    heap.push(0, start);
    let found = false;
    while (heap.size) {
      const k = heap.pop();
      if (closed[k]) continue;
      closed[k] = 1;
      if (k === goal) { found = true; break; }
      const i = k % w, j = (k - i) / w;
      const zk = elev(k);
      for (let dj = -1; dj <= 1; dj++) {
        const nj = j + dj;
        if (nj < 0 || nj >= h) continue;
        for (let di = -1; di <= 1; di++) {
          const ni = i + di;
          if ((!di && !dj) || ni < 0 || ni >= w) continue;
          const nk = nj * w + ni;
          if (closed[nk] || !open(nk)) continue;
          const d = di && dj ? G * 1.41421356 : G;
          const grade = Math.abs(elev(nk) - zk) / d;
          const m = mask.data[nk];
          const water = m === 1 ? o.stream : m === 2 ? (sites.data[nk] ? o.site : o.river) : 0;
          const cost = g[k] + d * (1 + grade * grade * o.grade) * (zones.data[nk] ? 8 : 1) + water;
          if (cost < g[nk]) {
            g[nk] = cost;
            from[nk] = k;
            heap.push(cost + Math.hypot(ni - gi, nj - gj) * G, nk);
          }
        }
      }
    }
    if (!found) return null;
    const pts: Pt[] = [];
    for (let k = goal; k >= 0; k = from[k]) pts.push([x0 + (k % w) * G, y0 + Math.floor(k / w) * G]);
    pts.reverse();
    pts[0] = o.from;
    pts[pts.length - 1] = o.to;
    return pts;
  }
}
