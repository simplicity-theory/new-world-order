import { type Box, type Pt, boxOf } from './geom.ts';
import { hashInt, noise2, rand01 } from './rng.ts';

// Rivers come from a world-wide drainage lattice. Each lattice node drains to its
// steepest-descent neighbour, which is a purely local rule, so the river network is the
// same no matter which part of the world is generated first.
//
// Where that descent ends in a hollow, a lake forms. A lake with a modest catchment
// overflows across the lowest point of its rim into the next valley, so most lakes sit
// on a river rather than ending one. Only very large basins stay closed.
//
// The same class runs at two scales: a coarse lattice for the major rivers (trunk.ts),
// and the 500 m lattice for everything drawn. Nodes of the fine lattice that lie on a
// major river are "locked" to follow it and inherit its far larger catchment.

const CAP = 400;            // upstream count is capped so the search stays local
const SPILL_HOPS = 12;
const MAX_CHAIN = 20000;

export interface Lock { next: [number, number] | null; boost: number }
export interface HydroOpts {
  seed: number;
  spacing: number;                                  // lattice spacing (m)
  elev: (x: number, y: number) => number;
  wiggle: (x: number, y: number) => [number, number];
  pad: number;                                      // how far a channel can stray from its nodes (m)
  step: number;                                     // sampling distance along channels (m)
  riverMin: number;                                 // catchment (nodes) needed for a river
  streamMin: number;                                // catchment needed for a minor stream
  lakeMin: number;
  basinMax: number;                                 // basins larger than this do not overflow; 0 = none do
  cut: (acc: number) => number;                     // how far the water sits below the ground (m)
  lock?: (i: number, j: number) => Lock | null;
}

interface HNode {
  i: number; j: number; x: number; y: number; z: number;
  down: HNode | null | undefined;
  term: HNode | null | undefined;   // pit this node drains to; null for the sea
  acc: number;
  fill: number;                     // metres of fill that level a lake basin up to its rim; -1 = not computed
  boost: number;                    // extra catchment inherited from a major river
  main: HNode | null | undefined;   // the upstream neighbour that continues the same river
  rid: number;                      // identity of the river this node belongs to; -1 = not computed
}
/** Overflow of a lake: leaves the basin from `from` into `to`; `path` runs from the pit to `from`. */
interface Spill { from: HNode; to: HNode; path: Set<HNode> }
interface Curve { pts: Pt[]; box: Box }
export interface River {
  pts: Pt[]; box: Box;
  width: number;            // metres at the upstream end
  w1: number;               // metres at the downstream end (wider only at a river mouth)
  b0: number; b1: number;   // water level (m) at each end
  acc: number;              // catchment, in lattice nodes
  kind: 'river' | 'stream';
  id: number;               // same for every piece of one named river
  crossing: Pt | null;      // where roads are meant to bridge this piece; null = nowhere in particular
  minor: boolean;           // small enough to cross anywhere
}
export interface Lake { ring: Pt[]; x: number; y: number; r: number; box: Box; level: number; id: number }
export interface Peak { x: number; y: number; z: number; id: number }

const NB: [number, number][] = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];

/** Channel width (m) from catchment in 500 m lattice nodes. */
export function riverWidth(acc: number): number {
  if (acc <= CAP) return Math.min(46, Math.max(5, 2.2 * Math.sqrt(acc)));
  return Math.min(170, 46 + 5.5 * Math.sqrt((acc - CAP) / 144));
}

export class Hydro {
  private o: HydroOpts;
  private seed: number;
  private nodes = new Map<number, HNode>();
  private segs = new Map<HNode, Curve>();
  private links = new Map<HNode, Curve>();
  private lakes = new Map<HNode, Lake | null>();
  private rawSpills = new Map<HNode, Spill | null>();
  private spills = new Map<HNode, Spill | null>();

  constructor(opts: HydroOpts) {
    this.o = opts;
    this.seed = opts.seed;
  }

  private node(i: number, j: number): HNode {
    const key = (i + 1048576) * 2097152 + (j + 1048576);
    let n = this.nodes.get(key);
    if (!n) {
      const H = this.o.spacing;
      const x = (i + 0.5 + (rand01(this.seed, i, j) - 0.5) * 0.6) * H;
      const y = (j + 0.5 + (rand01(this.seed + 1, i, j) - 0.5) * 0.6) * H;
      n = { i, j, x, y, z: this.o.elev(x, y), down: undefined, term: undefined, acc: -1, fill: -1, boost: 0, main: undefined, rid: -1 };
      this.nodes.set(key, n);
    }
    return n;
  }

  /** Where a node's water goes next; null in the sea and at the bottom of a hollow. */
  private down(n: HNode): HNode | null {
    if (n.down !== undefined) return n.down;
    if (n.z < 0) return (n.down = null);
    const lock = this.o.lock?.(n.i, n.j);
    if (lock) {
      n.boost = lock.boost;
      if (lock.next) return (n.down = this.node(lock.next[0], lock.next[1]));
    }
    let best: HNode | null = null, bestS = 0;
    for (const [di, dj] of NB) {
      const m = this.node(n.i + di, n.j + dj);
      const s = (n.z - m.z) / Math.hypot(m.x - n.x, m.y - n.y);
      if (s > bestS) { bestS = s; best = m; }
    }
    return (n.down = best);
  }

  private rawUps(n: HNode): HNode[] {
    const out: HNode[] = [];
    for (const [di, dj] of NB) {
      const m = this.node(n.i + di, n.j + dj);
      if (this.down(m) === n) out.push(m);
    }
    return out;
  }

  /** The hollow a node's water collects in, or null if it runs straight to the sea. */
  private terminal(n: HNode): HNode | null {
    const chain: HNode[] = [];
    let c = n, t: HNode | null;
    for (;;) {
      if (c.term !== undefined) { t = c.term; break; }
      if (c.z < 0) { t = null; break; }
      let d = this.down(c);
      // A locked channel can in principle lead back on itself; end it rather than loop.
      if (d && chain.length > MAX_CHAIN) d = c.down = null;
      chain.push(c);
      if (!d) { t = c; break; }
      c = d;
    }
    for (const m of chain) m.term = t;
    if (n.z < 0) n.term = null;
    return t;
  }

  /** Lowest point on the rim of a hollow's basin, ignoring whether overflow chains loop. */
  private rawSpill(pit: HNode): Spill | null {
    let sp = this.rawSpills.get(pit);
    if (sp !== undefined) return sp;
    sp = null;
    const basin = [pit];
    let small = this.o.basinMax > 0;
    for (let k = 0; k < basin.length && small; k++) {
      for (const u of this.rawUps(basin[k])) {
        basin.push(u);
        if (basin.length > this.o.basinMax) { small = false; break; }
      }
    }
    if (small) {
      let bestH = Infinity, from: HNode | null = null, to: HNode | null = null;
      for (const b of basin) {
        for (const [di, dj] of NB) {
          const m = this.node(b.i + di, b.j + dj);
          if (m.z >= 0 && this.terminal(m) === pit) continue;
          const h = Math.max(b.z, m.z);
          if (h < bestH) { bestH = h; from = b; to = m; }
        }
      }
      if (from && to) {
        const path = new Set<HNode>();
        for (let c: HNode | null = from, guard = 0; c && guard < MAX_CHAIN; c = this.down(c), guard++) path.add(c);
        sp = { from, to, path };
      }
    }
    this.rawSpills.set(pit, sp);
    return sp;
  }

  /**
   * Overflow actually used. Hollows can overflow into each other in a ring; the lowest
   * one in such a ring keeps its water, which breaks the loop the same way from any side.
   */
  private spill(pit: HNode): Spill | null {
    let out = this.spills.get(pit);
    if (out !== undefined) return out;
    const first = this.rawSpill(pit);
    out = null;
    if (first) {
      const seen = [pit];
      let cur = first;
      for (let hop = 0; hop < SPILL_HOPS; hop++) {
        const next = this.terminal(cur.to);
        if (!next) { out = first; break; }
        const at = seen.indexOf(next);
        if (at > 0) { out = first; break; }
        if (at === 0) {
          let low = pit;
          for (const p of seen) {
            if (p.z < low.z || (p.z === low.z && (p.i < low.i || (p.i === low.i && p.j < low.j)))) low = p;
          }
          out = low === pit ? null : first;
          break;
        }
        const ns = this.rawSpill(next);
        if (!ns) { out = first; break; }
        seen.push(next);
        cur = ns;
      }
    }
    this.spills.set(pit, out);
    return out;
  }

  /** Nodes whose water arrives at n: uphill neighbours plus any lake overflowing into it. */
  private ups(n: HNode): HNode[] {
    const out = this.rawUps(n);
    if (!this.o.basinMax) return out;
    for (const [di, dj] of NB) {
      const m = this.node(n.i + di, n.j + dj);
      if (m.z < 0) continue;
      const pit = this.terminal(m);
      if (pit && !out.includes(pit) && this.spill(pit)?.to === n) out.push(pit);
    }
    return out;
  }

  /** Catchment of n in lattice nodes: a local count capped at CAP, plus any major-river share. */
  private acc(n: HNode): number {
    if (n.acc >= 0) return n.acc;
    if (n.z < 0) return (n.acc = 0);
    this.down(n); // sets boost
    const stack = [n];
    let count = 0;
    while (stack.length && count < CAP) {
      const c = stack.pop()!;
      count++;
      for (const u of this.ups(c)) stack.push(u);
    }
    return (n.acc = count + n.boost);
  }

  /** The upstream neighbour carrying the most water, if it carries enough to be a river. */
  private mainUp(n: HNode): HNode | null {
    if (n.main !== undefined) return n.main;
    let up: HNode | null = null, upAcc = this.o.riverMin - 1;
    for (const u of this.rawUps(n)) {
      const a = this.acc(u);
      if (a > upAcc) { upAcc = a; up = u; }
    }
    return (n.main = up);
  }

  /** A river keeps its identity downstream until it joins a bigger one. */
  private riverId(n: HNode): number {
    const chain: HNode[] = [];
    let c = n, id: number;
    for (;;) {
      if (c.rid >= 0) { id = c.rid; break; }
      const d = this.down(c);
      chain.push(c);
      if (!d || d.z < 0 || this.mainUp(d) !== c || chain.length > MAX_CHAIN) { id = hashInt(this.seed + 5, c.i, c.j); break; }
      c = d;
    }
    for (const m of chain) m.rid = id;
    return id;
  }

  /** Surface level of the lake a node's basin drains to, if that lake overflows; else null. */
  private lakeLevel(n: HNode): number | null {
    const pit = this.terminal(n);
    if (!pit || this.acc(pit) < this.o.lakeMin) return null;
    const sp = this.spill(pit);
    return sp ? Math.max(sp.from.z, sp.to.z) : null;
  }

  /** Water level where a channel passes a node: cut into the ground, deeper for bigger rivers. */
  private bed(n: HNode): number {
    const cut = n.z - this.o.cut(this.acc(n));
    const level = n.z >= 0 ? this.lakeLevel(n) : null;
    return level === null ? cut : Math.max(cut, level);
  }

  /**
   * Fill heights on the lattice rows j0..j1, columns i0..i1. An overflowing lake stands
   * at the height of its rim, so the hollow below that level is treated as filled in.
   */
  fillGrid(i0: number, j0: number, i1: number, j1: number): Float32Array {
    const w = i1 - i0 + 1;
    const out = new Float32Array(w * (j1 - j0 + 1));
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const n = this.node(i, j);
        if (n.fill < 0) {
          const level = n.z >= 0 ? this.lakeLevel(n) : null;
          n.fill = level === null ? 0 : Math.max(0, level - n.z);
        }
        out[(j - j0) * w + (i - i0)] = n.fill;
      }
    }
    return out;
  }

  private warped(x: number, y: number): Pt {
    const [wx, wy] = this.o.wiggle(x, y);
    return [x + wx, y + wy];
  }

  /**
   * Catmull–Rom from n to d (p0 and p3 shape the ends) with the meander warp applied.
   * `bend` bows the middle sideways by that fraction of the length.
   */
  private curve(p0: [number, number], n: HNode, d: HNode, p3: [number, number], bend = 0): Curve {
    const len = Math.hypot(d.x - n.x, d.y - n.y);
    const steps = Math.max(4, Math.ceil(len / this.o.step));
    const nx = -(d.y - n.y) * bend, ny = (d.x - n.x) * bend;
    const pts: Pt[] = [];
    for (let k = 0; k <= steps; k++) {
      const t = k / steps, t2 = t * t, t3 = t2 * t;
      const bow = Math.sin(Math.PI * t);
      const x = 0.5 * (2 * n.x + (d.x - p0[0]) * t + (2 * p0[0] - 5 * n.x + 4 * d.x - p3[0]) * t2 + (3 * n.x - p0[0] - 3 * d.x + p3[0]) * t3);
      const y = 0.5 * (2 * n.y + (d.y - p0[1]) * t + (2 * p0[1] - 5 * n.y + 4 * d.y - p3[1]) * t2 + (3 * n.y - p0[1] - 3 * d.y + p3[1]) * t3);
      pts.push(this.warped(x + nx * bow, y + ny * bow));
    }
    return { pts, box: boxOf(pts) };
  }

  /** Channel from a node to its downhill neighbour; tributaries join tangentially. */
  private segment(n: HNode, d: HNode): Curve {
    let c = this.segs.get(n);
    if (c) return c;
    const up = this.mainUp(n);
    const dd = this.down(d);
    c = this.curve(up ? [up.x, up.y] : [2 * n.x - d.x, 2 * n.y - d.y], n, d,
      dd ? [dd.x, dd.y] : [2 * d.x - n.x, 2 * d.y - n.y]);
    this.segs.set(n, c);
    return c;
  }

  /** Channel across the rim of a basin, where a lake's overflow leaves it. */
  private link(sp: Spill): Curve {
    let c = this.links.get(sp.from);
    if (!c) {
      const { from: n, to: d } = sp;
      const dd = this.down(d);
      const bend = (rand01(this.seed + 9, n.i, n.j) < 0.5 ? -1 : 1) * (0.12 + 0.14 * rand01(this.seed + 10, n.i, n.j));
      c = this.curve([2 * n.x - d.x, 2 * n.y - d.y], n, d, dd ? [dd.x, dd.y] : [2 * d.x - n.x, 2 * d.y - n.y], bend);
      this.links.set(sp.from, c);
    }
    return c;
  }

  private lake(n: HNode): Lake | null {
    let l = this.lakes.get(n);
    if (l !== undefined) return l;
    const a = Math.min(CAP, this.acc(n));
    if (a < this.o.lakeMin) { this.lakes.set(n, null); return null; }
    const r = (50 + 16 * Math.sqrt(a)) * (this.o.spacing / 500);
    const [cx, cy] = this.warped(n.x, n.y);
    const ring: Pt[] = [];
    const ls = hashInt(this.seed, n.i, n.j);
    for (let k = 0; k < 40; k++) {
      const t = (k / 40) * Math.PI * 2;
      const rr = r * (1 + 0.32 * noise2(ls, 5 + Math.cos(t) * 1.3, 5 + Math.sin(t) * 1.3));
      ring.push([cx + Math.cos(t) * rr, cy + Math.sin(t) * rr]);
    }
    l = { ring, x: cx, y: cy, r, box: boxOf(ring), level: this.bed(n), id: ls };
    this.lakes.set(n, l);
    return l;
  }

  private river(c: Curve, n: HNode, to: HNode, a: number, b0: number): River {
    const stream = a < this.o.riverMin;
    const width = stream ? 3 : riverWidth(a);
    const mouth = to.z < 0;
    const mid = c.pts[c.pts.length >> 1];
    return {
      pts: c.pts, box: c.box, width,
      w1: mouth && !stream ? Math.min(420, Math.max(width * 3.2, width + 25)) : width,
      b0, b1: this.bed(to), acc: a, kind: stream ? 'stream' : 'river',
      id: stream ? 0 : this.riverId(n),
      crossing: !stream && width >= 8 && rand01(this.seed + 7, n.i, n.j) < 0.34 ? mid : null,
      minor: stream || width < 8,
    };
  }

  /** Catchment size (in lattice nodes) of the biggest river near a point, 0 if none. */
  riverNear(x: number, y: number, minDist: number, maxDist: number): number {
    const H = this.o.spacing;
    const i0 = Math.floor(x / H), j0 = Math.floor(y / H);
    let best = 0;
    for (let dj = -1; dj <= 1; dj++) {
      for (let di = -1; di <= 1; di++) {
        const n = this.node(i0 + di, j0 + dj);
        if (n.z < 0) continue;
        const d = Math.hypot(n.x - x, n.y - y);
        if (d < minDist || d > maxDist) continue;
        const a = this.acc(n);
        if (a >= this.o.riverMin && a > best) best = a;
      }
    }
    return best;
  }

  /** Lattice nodes standing above all their neighbours: candidate summits. */
  peaks(b: Box): Peak[] {
    const H = this.o.spacing;
    const out: Peak[] = [];
    for (let j = Math.floor(b.miny / H); j <= Math.floor(b.maxy / H); j++) {
      for (let i = Math.floor(b.minx / H); i <= Math.floor(b.maxx / H); i++) {
        const n = this.node(i, j);
        let top = n.z > 0;
        for (let k = 0; k < 8 && top; k++) top = this.node(i + NB[k][0], j + NB[k][1]).z < n.z;
        if (top) out.push({ x: n.x, y: n.y, z: n.z, id: hashInt(this.seed + 3, i, j) });
      }
    }
    return out;
  }

  /** All rivers, streams and lakes that may touch the box. */
  water(b: Box): { rivers: River[]; lakes: Lake[] } {
    const H = this.o.spacing, pad = this.o.pad, { riverMin, streamMin, lakeMin } = this.o;
    const i0 = Math.floor((b.minx - pad) / H), i1 = Math.floor((b.maxx + pad) / H);
    const j0 = Math.floor((b.miny - pad) / H), j1 = Math.floor((b.maxy + pad) / H);
    const rivers: River[] = [], lakes: Lake[] = [];
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const n = this.node(i, j);
        if (n.z < 0) continue;
        const d = this.down(n);
        const pit = this.terminal(n);
        const sp = pit ? this.spill(pit) : null;
        // The stretch from a lake up to its rim carries the lake's whole outflow.
        const out = sp && this.acc(pit!) >= lakeMin ? this.acc(pit!) : 0;
        if (d) {
          const onPath = out > 0 && sp!.path.has(n);
          const a = onPath ? Math.max(out, this.acc(n), riverMin) : this.acc(n);
          if (a >= streamMin) rivers.push(this.river(this.segment(n, d), n, d, a, this.bed(n)));
        } else {
          const l = this.lake(n);
          if (l) lakes.push(l);
        }
        if (sp && out && sp.from === n) rivers.push(this.river(this.link(sp), n, sp.to, Math.max(out, riverMin), this.bed(n)));
      }
    }
    return { rivers, lakes };
  }
}
