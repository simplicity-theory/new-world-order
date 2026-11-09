import { type Box, type Pt, pointInRing } from './geom.ts';
import type { Hydro } from './hydro.ts';
import type { Terrain } from './terrain.ts';

// The elevation people see: raw terrain with valleys cut along rivers and basins
// levelled around lakes, so contours and hillshade agree with the water. It is a pure
// function of the seed like everything else, and it never moves the coastline.

const REACH = 400;          // how far a valley side can extend from the floodplain (m)
const SIDE = 0.1;           // valley side slope
const H = 500;              // drainage lattice spacing (m)
const LAT = 50;             // spacing of the cached lattice used for routing (m)
const BLOCK = 64;           // cached in blocks of this many cells
const MAX_BLOCKS = 500;

/** Carved elevation `z`, uncarved `raw`, and `near`: 1 at water falling to 0 away from it. */
export interface ReliefGrid { z: Float32Array; raw: Float32Array; near: Float32Array }

export class Relief {
  private terrain: Terrain;
  private hydro: Hydro;
  private blocks = new Map<number, Float32Array>();
  constructor(terrain: Terrain, hydro: Hydro) {
    this.terrain = terrain;
    this.hydro = hydro;
  }

  /**
   * Elevation on a regular grid: node (i, j) is at (x0 + i·step, y0 + j·step).
   * With `carve` false the rivers are skipped (used when cells are far wider than a valley).
   */
  grid(x0: number, y0: number, step: number, w: number, h: number, carve = true): ReliefGrid {
    const { terrain, hydro } = this;
    const out = new Float32Array(w * h);
    if (!carve) {
      for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) out[j * w + i] = terrain.elev(x0 + i * step, y0 + j * step);
      return { z: out, raw: out, near: new Float32Array(w * h) };
    }
    const box: Box = { minx: x0, miny: y0, maxx: x0 + (w - 1) * step, maxy: y0 + (h - 1) * step };

    // Raw terrain, split so the small-scale bumps can be smoothed away near water.
    const base = new Float32Array(w * h), detail = new Float32Array(w * h);
    const fi0 = Math.floor(box.minx / H - 0.5), fj0 = Math.floor(box.miny / H - 0.5);
    const fi1 = Math.floor(box.maxx / H - 0.5) + 1, fj1 = Math.floor(box.maxy / H - 0.5) + 1;
    const fw = fi1 - fi0 + 1;
    const fill = hydro.fillGrid(fi0, fj0, fi1, fj1);
    const lift = new Float32Array(w * h);
    for (let j = 0; j < h; j++) {
      const y = y0 + j * step;
      const gy = y / H - 0.5 - fj0, jy = Math.floor(gy), ty = gy - jy;
      for (let i = 0; i < w; i++) {
        const x = x0 + i * step, k = j * w + i;
        const b = terrain.base(x, y);
        base[k] = b;
        detail[k] = terrain.detail(x, y, b);
        const gx = x / H - 0.5 - fi0, ix = Math.floor(gx), tx = gx - ix;
        const a = fill[jy * fw + ix], c = fill[jy * fw + ix + 1];
        const d = fill[(jy + 1) * fw + ix], e = fill[(jy + 1) * fw + ix + 1];
        lift[k] = (a + (c - a) * tx) * (1 - ty) + (d + (e - d) * tx) * ty;
      }
    }

    // For each cell: the lowest valley profile reaching it, and how close it is to water.
    const target = new Float32Array(w * h).fill(Infinity);
    const near = new Float32Array(w * h);
    const channel = (pts: Pt[], width: number, b0: number, b1: number) => {
      const flat = width * 1.5 + 10, reach = flat + REACH, soft = 150 + 6 * width;
      const segs = pts.length - 1;
      for (let s = 0; s < segs; s++) {
        const [ax, ay] = pts[s], [bx, by] = pts[s + 1];
        const i0 = Math.max(0, Math.ceil((Math.min(ax, bx) - reach - x0) / step));
        const i1 = Math.min(w - 1, Math.floor((Math.max(ax, bx) + reach - x0) / step));
        const j0 = Math.max(0, Math.ceil((Math.min(ay, by) - reach - y0) / step));
        const j1 = Math.min(h - 1, Math.floor((Math.max(ay, by) + reach - y0) / step));
        const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy || 1;
        for (let j = j0; j <= j1; j++) {
          const py = y0 + j * step;
          for (let i = i0; i <= i1; i++) {
            const px = x0 + i * step;
            let t = ((px - ax) * dx + (py - ay) * dy) / l2;
            t = t < 0 ? 0 : t > 1 ? 1 : t;
            const dist = Math.hypot(ax + dx * t - px, ay + dy * t - py);
            if (dist >= reach) continue;
            const k = j * w + i;
            const side = Math.max(0, dist - flat);
            // Past 60% of the reach the profile climbs steeply so it fades out without a step.
            const far = Math.max(0, (dist - 0.6 * reach) / (0.4 * reach));
            const level = b0 + ((b1 - b0) * (s + t)) / segs + (SIDE * side * side) / (side + 30) + 200 * far * far;
            if (level < target[k]) target[k] = level;
            const q = Math.min(1, side / soft);
            const closeness = 1 - q * q * (3 - 2 * q);
            if (closeness > near[k]) near[k] = closeness;
          }
        }
      }
    };
    const { rivers, lakes } = hydro.water({ minx: box.minx - REACH, miny: box.miny - REACH, maxx: box.maxx + REACH, maxy: box.maxy + REACH });
    for (const r of rivers) channel(r.pts, (r.width + r.w1) / 2, r.b0, r.b1);
    for (const l of lakes) {
      channel([...l.ring, l.ring[0]], 0, l.level, l.level);
      const i0 = Math.max(0, Math.ceil((l.box.minx - x0) / step)), i1 = Math.min(w - 1, Math.floor((l.box.maxx - x0) / step));
      const j0 = Math.max(0, Math.ceil((l.box.miny - y0) / step)), j1 = Math.min(h - 1, Math.floor((l.box.maxy - y0) / step));
      for (let j = j0; j <= j1; j++) {
        for (let i = i0; i <= i1; i++) {
          if (pointInRing(x0 + i * step, y0 + j * step, l.ring)) {
            const k = j * w + i;
            near[k] = 1;
            if (l.level < target[k]) target[k] = l.level;
          }
        }
      }
    }

    const rawOut = new Float32Array(w * h);
    for (let k = 0; k < out.length; k++) {
      const raw = rawOut[k] = base[k] + detail[k];
      if (raw <= 0.5) { out[k] = raw; continue; }           // sea and shoreline stay as they are
      const smooth = base[k] + lift[k] + detail[k] * (1 - near[k]);
      out[k] = Math.max(0.5, Math.min(smooth, target[k]));
    }
    return { z: out, raw: rawOut, near };
  }

  /** Carved elevation at node (ix, iy) of the world-wide 50 m lattice; cached in blocks. */
  cell(ix: number, iy: number): number {
    const bx = Math.floor(ix / BLOCK), by = Math.floor(iy / BLOCK);
    const key = (bx + 32768) * 65536 + (by + 32768);
    let b = this.blocks.get(key);
    if (!b) {
      b = this.grid(bx * BLOCK * LAT, by * BLOCK * LAT, LAT, BLOCK, BLOCK).z;
      this.blocks.set(key, b);
      if (this.blocks.size > MAX_BLOCKS) this.blocks.delete(this.blocks.keys().next().value!);
    }
    return b[(iy - by * BLOCK) * BLOCK + (ix - bx * BLOCK)];
  }

  /** Carved elevation at any point, interpolated from the 50 m lattice. */
  at(x: number, y: number): number {
    const gx = x / LAT, gy = y / LAT;
    const ix = Math.floor(gx), iy = Math.floor(gy), tx = gx - ix, ty = gy - iy;
    const a = this.cell(ix, iy), b = this.cell(ix + 1, iy), c = this.cell(ix, iy + 1), d = this.cell(ix + 1, iy + 1);
    return (a + (b - a) * tx) * (1 - ty) + (c + (d - c) * tx) * ty;
  }
}
