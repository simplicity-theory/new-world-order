import { type Pt, chaikin, contourPolygons } from '../gen/geom.ts';
import type { Graph } from './sim.ts';

// Territory: the land each side controls, for shading the map. Every point belongs to
// whichever side has the strongest pull there. A town pulls on the country around it,
// and a road pulls a little along its length when one side holds both ends. Where two
// sides' pulls meet is the front line.

const CELL = 200;           // grid resolution (m)
const TOWN_REACH = 2200;    // how far beyond its own edge a town's pull extends (m)
const ROAD_REACH = 700;     // half-width of the corridor along a held road (m)

export interface Territory { owner: number; rings: Pt[][] }
interface Extent { minx: number; miny: number; maxx: number; maxy: number }

/** `owners` maps town id to its owner as far as the viewer knows; only owners above 0 claim land. */
export function territory(graph: Graph, owners: Record<string, number>, b: Extent): Territory[] {
  const n = Math.ceil(Math.max(b.maxx - b.minx, b.maxy - b.miny) / CELL) + 1;
  const pull = new Map<number, Float32Array>();
  const field = (owner: number): Float32Array => {
    let f = pull.get(owner);
    if (!f) pull.set(owner, (f = new Float32Array(n * n)));
    return f;
  };
  /** Raise the pull within `reach` of a segment, falling off linearly from `peak`. */
  const stamp = (f: Float32Array, ax: number, ay: number, bx: number, by: number, reach: number, peak: number) => {
    const i0 = Math.max(0, Math.floor((Math.min(ax, bx) - reach - b.minx) / CELL)), i1 = Math.min(n - 1, Math.ceil((Math.max(ax, bx) + reach - b.minx) / CELL));
    const j0 = Math.max(0, Math.floor((Math.min(ay, by) - reach - b.miny) / CELL)), j1 = Math.min(n - 1, Math.ceil((Math.max(ay, by) + reach - b.miny) / CELL));
    const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy || 1;
    for (let j = j0; j <= j1; j++) {
      const py = b.miny + j * CELL;
      for (let i = i0; i <= i1; i++) {
        const px = b.minx + i * CELL;
        let t = ((px - ax) * dx + (py - ay) * dy) / l2;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const v = peak * (1 - Math.hypot(ax + dx * t - px, ay + dy * t - py) / reach);
        if (v > f[j * n + i]) f[j * n + i] = v;
      }
    }
  };
  for (const t of graph.towns) {
    const o = owners[t.id];
    if (o > 0) stamp(field(o), t.x, t.y, t.x, t.y, t.r + TOWN_REACH, 1);
  }
  for (const r of graph.roads) {
    const o = owners[r.a];
    if (!(o > 0) || owners[r.b] !== o || !r.intact) continue;
    const step = Math.max(1, Math.floor(r.pts.length / 40));
    for (let k = 0; k < r.pts.length - 1; k += step) {
      const q = r.pts[Math.min(r.pts.length - 1, k + step)];
      stamp(field(o), r.pts[k][0], r.pts[k][1], q[0], q[1], ROAD_REACH, 0.5);
    }
  }
  const out: Territory[] = [];
  const lead = new Float32Array(n * n);
  for (const [owner, mine] of pull) {
    for (let k = 0; k < lead.length; k++) {
      let other = 0;
      for (const [o, f] of pull) if (o !== owner && f[k] > other) other = f[k];
      const x = b.minx + (k % n) * CELL, y = b.miny + Math.floor(k / n) * CELL;
      lead[k] = mine[k] <= 0 || x > b.maxx || y > b.maxy ? -1 : mine[k] - other;
    }
    for (const rings of contourPolygons(lead, n, b.minx, b.miny, CELL)) {
      // Round off the grid's staircase; each ring is smoothed as a closed loop.
      out.push({ owner, rings: rings.map((ring) => chaikin([...ring, ring[0]], 2).slice(0, -1).map(([x, y]) => [Math.round(x), Math.round(y)] as Pt)) });
    }
  }
  return out;
}
