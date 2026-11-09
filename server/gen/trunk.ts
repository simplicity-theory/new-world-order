import { type Box, type Pt } from './geom.ts';
import { Hydro, type Lock } from './hydro.ts';
import { hashInt } from './rng.ts';
import type { Terrain } from './terrain.ts';

// The major rivers. A coarse drainage lattice over the continental shape gives rivers
// with catchments of thousands of square kilometres. They shape the world in two ways:
//  - each cuts a broad valley into the terrain (target), and
//  - the 500 m drainage lattice is locked to follow each one (lock), so local streams
//    feed a river that keeps growing instead of topping out at the local search limit.

const SPACING = 6000;       // coarse lattice (m)
const MIN_ACC = 3;          // coarse nodes of catchment before a major river starts
const FINE = 500;           // spacing of the lattice being locked (m)
const CELL = 250;           // valley field resolution (m)
const BLOCK = 32;           // valley field is cached in blocks of this many cells
const REACH = 5000;         // how far a valley side extends (m)
const NONE = 1e5;

interface Entry { next: [number, number] | null; pri: number; boost: number }

export class Trunk {
  private macro: Hydro;
  private blocks = new Map<number, Float32Array>();
  private locks = new Map<number, Entry>();
  private regions = new Set<number>();
  private done = new Set<Pt[]>();

  constructor(terrain: Terrain) {
    this.macro = new Hydro({
      seed: hashInt(terrain.seed, 777, 5), spacing: SPACING,
      elev: (x, y) => terrain.macroBase(x, y),
      wiggle: (x, y) => terrain.wiggle(x, y, SPACING / FINE),
      pad: SPACING + 1500, step: 300,
      riverMin: MIN_ACC, streamMin: MIN_ACC, lakeMin: Infinity, basinMax: 0,
      cut: (a) => Math.min(30, 3 + 1.5 * Math.sqrt(a)),
    });
  }

  /** Valley floor height imposed here by the major rivers; very large where there is none. */
  target(x: number, y: number): number {
    const gx = x / CELL, gy = y / CELL;
    const ix = Math.floor(gx), iy = Math.floor(gy);
    const bx = Math.floor(ix / BLOCK), by = Math.floor(iy / BLOCK);
    const key = (bx + 32768) * 65536 + (by + 32768);
    let f = this.blocks.get(key);
    if (!f) { f = this.build(bx, by); this.blocks.set(key, f); }
    const lx = ix - bx * BLOCK, ly = iy - by * BLOCK, w = BLOCK + 1;
    const a = f[ly * w + lx];
    const b = f[ly * w + lx + 1], c = f[(ly + 1) * w + lx], d = f[(ly + 1) * w + lx + 1];
    if (a >= NONE && b >= NONE && c >= NONE && d >= NONE) return NONE;
    const tx = gx - ix, ty = gy - iy;
    return (a + (b - a) * tx) * (1 - ty) + (c + (d - c) * tx) * ty;
  }

  private build(bx: number, by: number): Float32Array {
    const w = BLOCK + 1;
    const f = new Float32Array(w * w).fill(NONE);
    const x0 = bx * BLOCK * CELL, y0 = by * BLOCK * CELL;
    const box: Box = { minx: x0 - REACH, miny: y0 - REACH, maxx: x0 + BLOCK * CELL + REACH, maxy: y0 + BLOCK * CELL + REACH };
    for (const r of this.macro.water(box).rivers) {
      const flat = 220 + 22 * Math.sqrt(r.acc), reach = flat + REACH;
      const segs = r.pts.length - 1;
      for (let s = 0; s < segs; s++) {
        const [ax, ay] = r.pts[s], [qx, qy] = r.pts[s + 1];
        const i0 = Math.max(0, Math.ceil((Math.min(ax, qx) - reach - x0) / CELL));
        const i1 = Math.min(BLOCK, Math.floor((Math.max(ax, qx) + reach - x0) / CELL));
        const j0 = Math.max(0, Math.ceil((Math.min(ay, qy) - reach - y0) / CELL));
        const j1 = Math.min(BLOCK, Math.floor((Math.max(ay, qy) + reach - y0) / CELL));
        const dx = qx - ax, dy = qy - ay, l2 = dx * dx + dy * dy || 1;
        for (let j = j0; j <= j1; j++) {
          const py = y0 + j * CELL;
          for (let i = i0; i <= i1; i++) {
            const px = x0 + i * CELL;
            let t = ((px - ax) * dx + (py - ay) * dy) / l2;
            t = t < 0 ? 0 : t > 1 ? 1 : t;
            const dist = Math.hypot(ax + dx * t - px, ay + dy * t - py);
            if (dist >= reach) continue;
            const side = Math.max(0, dist - flat);
            const far = Math.max(0, (dist - 0.6 * reach) / (0.4 * reach));
            // A gentle cross-slope on the floor keeps local drainage heading for the river.
            const level = r.b0 + ((r.b1 - r.b0) * (s + t)) / segs + dist * 0.002
              + (0.035 * side * side) / (side + 400) + 600 * far * far;
            if (level < f[j * w + i]) f[j * w + i] = level;
          }
        }
      }
    }
    return f;
  }

  /** If fine-lattice cell (i, j) lies on a major river: the next cell along it and the catchment it brings. */
  lock(i: number, j: number): Lock | null {
    const rx = Math.floor(((i + 0.5) * FINE) / SPACING), ry = Math.floor(((j + 0.5) * FINE) / SPACING);
    const rk = (rx + 32768) * 65536 + (ry + 32768);
    if (!this.regions.has(rk)) {
      this.regions.add(rk);
      const box: Box = { minx: rx * SPACING, miny: ry * SPACING, maxx: (rx + 1) * SPACING, maxy: (ry + 1) * SPACING };
      for (const r of this.macro.water(box).rivers) {
        if (this.done.has(r.pts)) continue;
        this.done.add(r.pts);
        this.rasterise(r.pts, r.acc);
      }
    }
    return this.locks.get((i + 1048576) * 2097152 + (j + 1048576)) ?? null;
  }

  private rasterise(pts: Pt[], acc: number): void {
    const cells: [number, number][] = [];
    const add = (x: number, y: number) => {
      const ci = Math.floor(x / FINE), cj = Math.floor(y / FINE);
      const last = cells[cells.length - 1];
      if (!last || last[0] !== ci || last[1] !== cj) cells.push([ci, cj]);
    };
    for (let s = 0; s + 1 < pts.length; s++) {
      const [ax, ay] = pts[s], [bx, by] = pts[s + 1];
      const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / 120));
      for (let k = 0; k < n; k++) add(ax + ((bx - ax) * k) / n, ay + ((by - ay) * k) / n);
    }
    add(pts[pts.length - 1][0], pts[pts.length - 1][1]);
    const boost = acc * (SPACING / FINE) ** 2;
    for (let k = 0; k < cells.length; k++) {
      const [ci, cj] = cells[k];
      // Steps between sampled cells are at most one cell, except rarely across a corner.
      let next: [number, number] | null = k + 1 < cells.length ? cells[k + 1] : null;
      if (next && (Math.abs(next[0] - ci) > 1 || Math.abs(next[1] - cj) > 1)) next = null;
      const key = (ci + 1048576) * 2097152 + (cj + 1048576);
      const old = this.locks.get(key);
      // Where two rivers claim a cell the bigger wins, whichever was drawn first.
      const wins = !old || (next && !old.next) || (!!next === !!old.next && (acc > old.pri
        || (acc === old.pri && next && old.next && (next[0] < old.next[0] || (next[0] === old.next[0] && next[1] < old.next[1])))));
      if (wins) this.locks.set(key, { next, pri: acc, boost });
    }
  }
}
