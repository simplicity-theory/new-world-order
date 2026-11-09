import {
  type Box, type Pt, Mask, boxOf, boxPad, boxesIntersect, chaikin, clipLine, clipPoly, contourLines, contourPolygons,
  crossings, inBox, lineLength, nearestOnLine, pointInRing, ringArea,
} from './geom.ts';
import { Hydro, type River } from './hydro.ts';
import { Relief } from './relief.ts';
import { hashInt, noise2, rand01 } from './rng.ts';
import { Settlements, stemName, type Link, type Settlement } from './settle.ts';
import { Terrain } from './terrain.ts';
import { type TownLayout, buildTown, townDensity } from './town.ts';
import { Trunk } from './trunk.ts';

/** Bumped whenever generator output changes; chunks from different versions do not line up. */
export const GEN_VERSION = 6;
export const CHUNK = 2000;  // chunk edge (m)
const CELL = 20;            // terrain sampling (m)
const N = CHUNK / CELL + 1; // nodes per side
export const CONTOUR_STEP = 10;   // metres between contour lines
export const CONTOUR_INDEX = 50;  // every fifth line is an index contour

const R_EARTH = 6378137;
const DEG = 180 / Math.PI;
const TIERS = ['hamlet', 'village', 'town', 'city'];

type Props = Record<string, string | number>;
export interface Feature {
  type: 'Feature';
  properties: Props;
  geometry: { type: string; coordinates: unknown };
}
export interface ChunkResult {
  features: Feature[];
  timings: Record<string, number>;
}

/** Whether a feature is kept in the low-zoom overview copy of a chunk. */
export function isOverview(f: Feature): boolean {
  const { layer, kind } = f.properties;
  switch (layer) {
    case 'building': case 'landuse': case 'field': case 'poi': case 'manmade': case 'bridge': case 'ford': case 'crossing': return false;
    case 'contour': return kind === 'index';
    case 'river': return kind === 'river';
    case 'road': return kind !== 'street' && kind !== 'street_major' && kind !== 'track' && kind !== 'link';
    default: return true;
  }
}

/** One world's generator state. All caches hold pure functions of the seed. */
export class WorldGen {
  seed: number;
  terrain: Terrain;
  trunk: Trunk;
  hydro: Hydro;
  settlements: Settlements;
  relief: Relief;
  origin: Pt = [0, 0];
  private towns = new Map<Settlement, TownLayout>();
  private trimmed = new Map<Link, Pt[]>();

  constructor(seed: number, origin?: Pt) {
    this.seed = seed;
    const terrain = this.terrain = new Terrain(seed);
    this.trunk = new Trunk(terrain);
    terrain.valleys = (x, y) => this.trunk.target(x, y);
    this.hydro = new Hydro({
      seed: hashInt(seed, 4242, 1), spacing: 500,
      elev: (x, y) => terrain.base(x, y),
      wiggle: (x, y) => terrain.wiggle(x, y),
      pad: 1000, step: 25, riverMin: 10, streamMin: 4, lakeMin: 5, basinMax: 120,
      cut: (a) => Math.min(10, 1 + 0.35 * Math.sqrt(Math.min(a, 650))),
      lock: (i, j) => this.trunk.lock(i, j),
    });
    this.relief = new Relief(terrain, this.hydro);
    this.settlements = new Settlements(terrain, this.hydro, this.relief);
    this.origin = origin ?? this.pickOrigin();
  }

  /** Start the world on the nearest sizeable town so the first chunk has something in it. */
  private pickOrigin(): Pt {
    let best: Settlement | null = null, bestScore = -Infinity;
    for (const s of this.settlements.within({ minx: -40000, miny: -40000, maxx: 40000, maxy: 40000 })) {
      const score = Math.min(s.tier, 2) * 30000 - Math.hypot(s.x, s.y);
      if (score > bestScore) { bestScore = score; best = s; }
    }
    return best ? [best.x, best.y] : [0, 0];
  }

  chunkBox(cx: number, cy: number): Box {
    const minx = this.origin[0] + (cx - 0.5) * CHUNK, miny = this.origin[1] + (cy - 0.5) * CHUNK;
    return { minx, miny, maxx: minx + CHUNK, maxy: miny + CHUNK };
  }

  private town(s: Settlement): TownLayout {
    let t = this.towns.get(s);
    if (!t) {
      t = buildTown(this.terrain, this.hydro, this.relief, s, this.settlements.incident(s), this.settlements.railsAt(s));
      this.towns.set(s, t);
    }
    return t;
  }

  /** A road or railway with both ends cut back to where the towns' own layouts take over. */
  private highway(hw: Link): Pt[] {
    let pts = this.trimmed.get(hw);
    if (pts) return pts;
    const ca = this.town(hw.a).cuts.get(hw), cb = hw.spur ? undefined : this.town(hw.b).cuts.get(hw);
    const src = hw.pts;
    const total = lineLength(src);
    const from = ca?.t ?? 0, to = total - (cb?.t ?? 0);
    pts = [];
    if (ca) pts.push(ca.pt);
    if (to - from > 1) {
      let t = 0;
      for (let k = 0; k + 1 < src.length; k++) {
        const [ax, ay] = src[k], [bx, by] = src[k + 1];
        const l = Math.hypot(bx - ax, by - ay);
        const at = (d: number): Pt => [ax + ((bx - ax) * (d - t)) / l, ay + ((by - ay) * (d - t)) / l];
        if (from > t && from < t + l) pts.push(at(from));
        if (t >= from && t < to && !(ca && t === from)) pts.push(src[k]);
        if (to > t && to <= t + l) pts.push(cb ? at(to) : src[k + 1]);
        t += l;
      }
    }
    if (cb) pts.push(cb.pt);
    if (pts.length < 2) pts = ca && cb ? [ca.pt, cb.pt] : src;
    this.trimmed.set(hw, pts);
    return pts;
  }

  /**
   * The settlements in a box and the roads joining them, as plain data in metres from
   * the world origin, for games built on the map. Each road runs centre to centre along
   * the route that is drawn, including the avenue into each town.
   */
  roadGraph(box: Box) {
    const { terrain, hydro, relief, settlements } = this;
    const [ox, oy] = this.origin;
    const local = (p: Pt): Pt => [Math.round(p[0] - ox), Math.round(p[1] - oy)];
    const id = (s: Settlement) => `${s.a}_${s.b}`;
    const towns = settlements.within(box);
    const inside = new Set(towns);

    /** A link's drawn route from town a outwards: avenue, then the trimmed road, then b's avenue if it ends in a town. */
    const drawn = (link: Link): Pt[] => {
      const mid = this.highway(link);
      const avenue = (s: Settlement, at: Pt): Pt[] =>
        this.town(s).streets.find((st) => Math.hypot(st.pts[st.pts.length - 1][0] - at[0], st.pts[st.pts.length - 1][1] - at[1]) < 3)?.pts ?? [];
      const head = avenue(link.a, mid[0]);
      const pts: Pt[] = [[link.a.x, link.a.y], ...head, ...(head.length ? mid.slice(1) : mid)];
      if (!link.spur) {
        const tail = [...avenue(link.b, mid[mid.length - 1])].reverse();
        pts.push(...tail.slice(1), [link.b.x, link.b.y]);
      }
      return pts;
    };
    /** Where a route crosses rivers big enough to need a bridge, as distances along it. */
    const bridges = (pts: Pt[]) => {
      const out: { d: number; x: number; y: number }[] = [];
      const rivers = hydro.water(boxOf(pts)).rivers.filter((r) => !r.minor);
      let d = 0;
      for (let k = 0; k + 1 < pts.length; k++) {
        const seg: Pt[] = [pts[k], pts[k + 1]];
        for (const r of rivers) {
          for (const c of crossings(seg, r.pts)) {
            const at = d + Math.hypot(c.x - pts[k][0], c.y - pts[k][1]);
            if (!out.some((b) => Math.abs(b.d - at) < 40)) out.push({ d: Math.round(at), x: Math.round(c.x - ox), y: Math.round(c.y - oy) });
          }
        }
        d += Math.hypot(pts[k + 1][0] - pts[k][0], pts[k + 1][1] - pts[k][1]);
      }
      return out.sort((a, b) => a.d - b.d);
    };
    const road = (a: Settlement, b: Settlement, kind: string, ref: string, pts: Pt[]) =>
      ({ id: `${id(a)}|${id(b)}${kind === 'motorway' ? '|m' : ''}`, a: id(a), b: id(b), kind, ref, pts: pts.map(local), bridges: bridges(pts) });

    const roads = settlements.highways(box).filter((h) => inside.has(h.a) && inside.has(h.b))
      .map((h) => road(h.a, h.b, h.kind, h.ref, drawn(h)));
    for (const m of settlements.motorways(box)) {
      // A motorway is reached by each city's link road: centre, link, motorway, link, centre.
      if (!inside.has(m.a) || !inside.has(m.b)) continue;
      const la = settlements.incident(m.a).find((h) => h.spur), lb = settlements.incident(m.b).find((h) => h.spur);
      if (la && lb) roads.push(road(m.a, m.b, 'motorway', m.ref, [...drawn(la), ...m.pts.slice(1), ...drawn(lb).reverse().slice(1)]));
    }

    return {
      towns: towns.map((s) => {
        // Border: how far the built-up area reaches in each direction, with a minimum so hamlets stay easy to click.
        const dens = townDensity(s);
        const outline: Pt[] = [];
        for (let k = 0; k < 40; k++) {
          const a = (k / 40) * Math.PI * 2;
          let reach = 0;
          for (let r = 20; r <= s.r * 1.3; r += 20) if (dens(s.x + Math.cos(a) * r, s.y + Math.sin(a) * r) > 0) reach = r;
          const d = Math.max(reach + 40, 300);
          outline.push(local([s.x + Math.cos(a) * d, s.y + Math.sin(a) * d]));
        }
        // Two blocks for the game to put buildings on, industrial ones for preference.
        const sites = this.town(s).blocks.filter((b) => b.kind !== 'park' && b.kind !== 'civic').map((b) => {
          const cx = b.ring.reduce((t, p) => t + p[0], 0) / b.ring.length, cy = b.ring.reduce((t, p) => t + p[1], 0) / b.ring.length;
          return { ring: b.ring, score: Math.abs(Math.hypot(cx - s.x, cy - s.y) - 0.45 * s.r) - (b.kind === 'industrial' ? 0.3 * s.r : 0) };
        }).sort((p, q) => p.score - q.score).slice(0, 2).map((b) => b.ring.map(local));
        for (let k = sites.length; k < 2; k++) {
          const cx = s.x + (k ? 110 : -110), cy = s.y + 90;
          sites.push(([[-35, -25], [35, -25], [35, 25], [-35, 25]] as Pt[]).map(([u, v]) => local([cx + u, cy + v])));
        }
        const here = relief.at(s.x, s.y);
        let around = 0, sea = false;
        for (let k = 0; k < 16; k++) {
          const a = (k / 16) * Math.PI * 2;
          if (k % 2 === 0) around += relief.at(s.x + Math.cos(a) * 1500, s.y + Math.sin(a) * 1500) / 8;
          if (terrain.elev(s.x + Math.cos(a) * (s.r * 1.2 + 150), s.y + Math.sin(a) * (s.r * 1.2 + 150)) < 0) sea = true;
        }
        return {
          id: id(s), name: s.name, tier: s.tier, r: Math.round(s.r), x: Math.round(s.x - ox), y: Math.round(s.y - oy), outline, sites,
          traits: { hill: here - around > 12, river: hydro.riverNear(s.x, s.y, 0, 700) > 0, port: sea, rail: settlements.railsAt(s).length > 0 },
        };
      }),
      roads,
    };
  }

  private ll = (p: Pt): Pt => {
    const x = p[0] - this.origin[0], y = p[1] - this.origin[1];
    const lon = (x / R_EARTH) * DEG;
    const lat = (2 * Math.atan(Math.exp(y / R_EARTH)) - Math.PI / 2) * DEG;
    return [Math.round(lon * 1e7) / 1e7, Math.round(lat * 1e7) / 1e7];
  };

  generate(cx: number, cy: number): ChunkResult {
    const box = this.chunkBox(cx, cy);
    const { terrain, hydro, settlements } = this;
    const features: Feature[] = [];
    const timings: Record<string, number> = {};
    let t0 = performance.now();
    const lap = (name: string) => {
      const t = performance.now();
      timings[name] = Math.round((t - t0) * 100) / 100;
      t0 = t;
    };
    const poly = (layer: string, kind: string, rings: Pt[][], extra?: Props) => {
      const coords = rings.map((r) => { const c = r.map(this.ll); c.push(c[0]); return c; });
      features.push({ type: 'Feature', properties: { layer, kind, ...extra }, geometry: { type: 'Polygon', coordinates: coords } });
    };
    const line = (layer: string, kind: string, pts: Pt[], extra?: Props) => {
      for (const piece of clipLine(pts, box)) {
        features.push({ type: 'Feature', properties: { layer, kind, ...extra }, geometry: { type: 'LineString', coordinates: piece.map(this.ll) } });
      }
    };
    const point = (layer: string, kind: string, x: number, y: number, extra?: Props) => {
      features.push({ type: 'Feature', properties: { layer, kind, ...extra }, geometry: { type: 'Point', coordinates: this.ll([x, y]) } });
    };

    // 1. Terrain with a one-node halo, so slopes match across chunk edges. `z` has the
    //    river valleys cut in; `raw` does not and decides the coastline.
    const M = N + 2;
    const { z, raw, near: nearWater } = this.relief.grid(box.minx - CELL, box.miny - CELL, CELL, M, M);
    const field = new Float32Array(N * N);
    const contour = (layer: string, kind: string, fn: (i: number, j: number, k: number) => number, minArea = 0) => {
      for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) field[j * N + i] = fn(i, j, (j + 1) * M + i + 1);
      for (const rings of contourPolygons(field, N, box.minx, box.miny, CELL)) {
        // Specks are dropped unless they touch the chunk edge, where they may continue next door.
        if (minArea && ringArea(rings[0]) < minArea
          && !rings[0].some(([x, y]) => x <= box.minx || x >= box.maxx || y <= box.miny || y >= box.maxy)) continue;
        poly(layer, kind, rings);
      }
    };
    poly('land', 'land', [[[box.minx, box.miny], [box.maxx, box.miny], [box.maxx, box.maxy], [box.minx, box.maxy]]]);
    contour('landcover', 'sand', (_i, _j, k) => 2.5 - raw[k]);
    contour('water', 'sea', (_i, _j, k) => -raw[k]);
    contour('water', 'tidal', (i, j, k) => Math.min(raw[k] + terrain.tide(box.minx + i * CELL, box.miny + j * CELL), -raw[k] + 0.05));
    lap('terrain');

    // 2. Rivers, streams and lakes.
    const { rivers: allRivers, lakes } = hydro.water(boxPad(box, 700));
    const rivers = allRivers.filter((r) => boxesIntersect(r.box, box));
    for (const r of rivers) {
      if (r.w1 > r.width) {
        // A river mouth: a funnel-shaped estuary instead of a line.
        const left: Pt[] = [], right: Pt[] = [];
        for (let k = 0; k < r.pts.length; k++) {
          const a = r.pts[Math.max(0, k - 1)], b = r.pts[Math.min(r.pts.length - 1, k + 1)];
          const l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
          const t = k / (r.pts.length - 1);
          const hw = (r.width + (r.w1 - r.width) * t * t) / 2;
          const nx = -(b[1] - a[1]) / l * hw, ny = (b[0] - a[0]) / l * hw;
          left.push([r.pts[k][0] + nx, r.pts[k][1] + ny]);
          right.push([r.pts[k][0] - nx, r.pts[k][1] - ny]);
        }
        const ring = clipPoly([...left, ...right.reverse()], box);
        if (ring.length >= 3) poly('water', 'river', [ring]);
      } else {
        line('river', r.kind, r.pts, { width: Math.round(r.width * 10) / 10 });
      }
    }
    for (const l of lakes) {
      if (!boxesIntersect(l.box, box)) continue;
      const ring = clipPoly(l.ring, box);
      if (ring.length >= 3) poly('water', 'lake', [ring]);
      if (inBox(box, l.x, l.y)) {
        const stem = stemName(l.id);
        point('water_label', 'lake', l.x, l.y, { name: l.r > 200 ? `Lake ${stem}` : `${stem} ${['Pond', 'Mere', 'Tarn', 'Pool'][(l.id >>> 20) & 3]}` });
      }
    }
    // One label line per named river: its pieces in this chunk joined end to end.
    const byRiver = new Map<number, River[]>();
    for (const r of rivers) {
      if (r.kind !== 'river') continue;
      let g = byRiver.get(r.id);
      if (!g) byRiver.set(r.id, (g = []));
      g.push(r);
    }
    const ptKey = (p: Pt) => `${Math.round(p[0])},${Math.round(p[1])}`;
    for (const [id, group] of byRiver) {
      const starts = new Map(group.map((r) => [ptKey(r.pts[0]), r]));
      const ends = new Set(group.map((r) => ptKey(r.pts[r.pts.length - 1])));
      const big = group.some((r) => r.acc > 60);
      const stem = stemName(id);
      const name = big ? `River ${stem}` : `${stem} ${['Brook', 'Beck', 'Burn', 'Creek'][(id >>> 20) & 3]}`;
      for (const head of group) {
        if (ends.has(ptKey(head.pts[0]))) continue;
        const pts: Pt[] = [...head.pts];
        for (let r = starts.get(ptKey(pts[pts.length - 1])), guard = 0; r && guard < 50; r = starts.get(ptKey(pts[pts.length - 1])), guard++) {
          pts.push(...r.pts.slice(1));
        }
        for (const piece of clipLine(pts, box)) {
          if (lineLength(piece) < 250) continue;
          features.push({ type: 'Feature', properties: { layer: 'waterway_label', kind: big ? 'river' : 'brook', name }, geometry: { type: 'LineString', coordinates: piece.map(this.ll) } });
        }
      }
    }
    lap('water');

    // 3. Contours of the carved relief, so they bend upstream along the rivers just drawn.
    const core = new Float32Array(N * N);
    let lo = Infinity, hi = -Infinity;
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        const v = core[j * N + i] = z[(j + 1) * M + i + 1];
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
    }
    for (let ele = Math.max(CONTOUR_STEP, Math.ceil(lo / CONTOUR_STEP) * CONTOUR_STEP); ele < hi; ele += CONTOUR_STEP) {
      const kind = ele % CONTOUR_INDEX === 0 ? 'index' : 'minor';
      for (const pts of contourLines(core, N, box.minx, box.miny, CELL, ele)) {
        if (pts.length < 4) continue;
        features.push({ type: 'Feature', properties: { layer: 'contour', kind, ele }, geometry: { type: 'LineString', coordinates: chaikin(pts, 1).map(this.ll) } });
      }
    }
    lap('relief');

    // 4. Transport between settlements: roads, railways and motorways, with their crossings.
    const near = settlements.within(boxPad(box, 5700));
    const wide = boxPad(box, 650);
    const highways = settlements.highways(wide).map((h) => ({ kind: h.kind, ref: h.ref, pts: this.highway(h) }));
    for (const s of near) {
      // A city's link road out to its motorway interchange.
      if (s.tier < 3) continue;
      for (const h of settlements.incident(s)) {
        if (h.spur && boxesIntersect(h.box, wide)) highways.push({ kind: h.kind, ref: h.ref, pts: this.highway(h) });
      }
    }
    const motorways = settlements.motorways(wide);
    const rails = settlements.rails(boxPad(box, 60)).map((r) => ({ kind: 'rail', pts: this.highway(r) }));
    for (const h of highways) line('road', h.kind, h.pts, h.ref ? { ref: h.ref } : undefined);
    for (const m of motorways) line('road', 'motorway', m.pts, { ref: m.ref });
    for (const r of rails) line('rail', 'rail', r.pts);
    for (const s of near) {
      if (inBox(box, s.x, s.y)) point('place', TIERS[s.tier], s.x, s.y, { tier: s.tier, name: s.name });
    }
    // Where a motorway crosses a road: a bridge and four slip roads, one in each corner.
    const ramps: Pt[][] = [];
    for (const m of motorways) {
      for (const h of highways) {
        const back = crossings(h.pts, m.pts);
        for (const c of crossings(m.pts, h.pts)) {
          const hd = back.find((q) => Math.hypot(q.x - c.x, q.y - c.y) < 2);
          if (!hd) continue;
          for (const sm of [1, -1]) {
            for (const sh of [1, -1]) {
              const ax = c.x + c.dx * sm * 240, ay = c.y + c.dy * sm * 240;
              const bx = c.x + hd.dx * sh * 150, by = c.y + hd.dy * sh * 150;
              const qx = c.x + c.dx * sm * 95 + hd.dx * sh * 35, qy = c.y + c.dy * sm * 95 + hd.dy * sh * 35;
              const ramp: Pt[] = [];
              for (let t = 0; t <= 1.001; t += 0.1) {
                ramp.push([(1 - t) * (1 - t) * ax + 2 * t * (1 - t) * qx + t * t * bx, (1 - t) * (1 - t) * ay + 2 * t * (1 - t) * qy + t * t * by]);
              }
              // No slip road into a lake or the sea.
              if (ramp.some(([x, y]) => terrain.elev(x, y) < 1 || lakes.some((l) => pointInRing(x, y, l.ring)))) continue;
              line('road', 'link', ramp);
              ramps.push(ramp);
            }
          }
          if (!inBox(box, c.x, c.y)) continue;
          point('poi', 'junction', c.x, c.y, { name: `${m.ref} / ${h.ref || 'local road'}` });
          features.push({ type: 'Feature', properties: { layer: 'bridge', kind: 'motorway' },
            geometry: { type: 'LineString', coordinates: [[c.x - c.dx * 16, c.y - c.dy * 16] as Pt, [c.x + c.dx * 16, c.y + c.dy * 16] as Pt].map(this.ll) } });
        }
      }
    }
    lap('transport');

    // 5. Land cover. Each kind is a scalar field contoured at zero; later kinds draw on top.
    const urban = new Float32Array(N * N), rural = new Float32Array(N * N);
    const urbanAt = (x: number, y: number): [number, number] => {
      let u = -1, r = 0;
      for (const s of near) {
        // Ragged edge so clearings around towns are not perfect circles.
        const d = Math.hypot(s.x - x, s.y - y);
        u = Math.max(u, 1 - (d * (1 + 0.25 * noise2(s.seed, x / 280, y / 280))) / (s.r * 0.95));
        r = Math.max(r, 1 - d / (s.r + 1600));
      }
      return [u, r];
    };
    const moist = new Float32Array(N * N), vary = new Float32Array(N * N);
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        const x = box.minx + i * CELL, y = box.miny + j * CELL, q = j * N + i;
        [urban[q], rural[q]] = urbanAt(x, y);
        moist[q] = terrain.moisture(x, y);
        vary[q] = terrain.vary(x, y);
      }
    }
    const slope = (k: number): number => Math.hypot(z[k + 1] - z[k - 1], z[k + M] - z[k - M]) / (2 * CELL);
    const farm = new Float32Array(N * N);
    contour('landcover', 'farmland', (i, j, k) => {
      const q = j * N + i;
      return (farm[q] = terrain.fertility(box.minx + i * CELL, box.miny + j * CELL) + 0.12 + rural[q] * 0.55 - slope(k) * 9
        - (raw[k] < 2.5 ? 2 : 0) - Math.max(0, urban[q] + 0.05) * 6 - Math.max(0, z[k] - 170 - 30 * vary[q]) / 12);
    });
    contour('landcover', 'moor', (i, j, k) => {
      const q = j * N + i;
      return (z[k] - 200 - 45 * vary[q]) / 25 - Math.max(0, urban[q] + 0.3) * 4;
    });
    contour('landcover', 'forest', (i, j, k) => {
      const q = j * N + i;
      return moist[q] + 0.02 + Math.min(0.25, slope(k) * 1.5) - (raw[k] < 3 ? 2 : 0)
        - Math.max(0, urban[q] + 0.3) * 4 - Math.max(0, z[k] - 290 - 40 * vary[q]) / 15;
    });
    contour('landcover', 'marsh', (i, j, k) => {
      const q = j * N + i;
      return Math.min(nearWater[k] - 0.72, terrain.wetness(box.minx + i * CELL, box.miny + j * CELL) - 0.08) - slope(k) * 5
        - (raw[k] < 1 ? 2 : 0) - Math.max(0, urban[q] + 0.1) * 4;
    }, 5000);
    contour('landcover', 'rock', (i, j, k) => Math.max((z[k] - 440 - 50 * vary[j * N + i]) / 30, (slope(k) - 0.34) * 8), 1500);
    lap('landcover');

    // 6. Towns: streets, blocks, buildings and landmarks from each town's own layout.
    const roadMask = new Mask(boxPad(box, 40), 8);
    const stamp = (pts: Pt[], r: number) => { for (const piece of clipLine(pts, boxPad(box, 40))) roadMask.stampLine(piece, r, 1); };
    for (const h of highways) stamp(h.pts, 15);
    for (const m of motorways) stamp(m.pts, 26);
    for (const r of rails) stamp(r.pts, 12);
    for (const r of ramps) stamp(r, 11);
    const blocked = (b: { x: number; y: number; ring: Pt[] }): boolean =>
      roadMask.get(b.x, b.y) > 0 || b.ring.some(([x, y]) => roadMask.get(x, y) > 0);
    const streets: { kind: string; pts: Pt[] }[] = [];
    const railArcs: { kind: string; pts: Pt[] }[] = [];
    // Built-up ground under each town, so the gaps between its districts read as town rather than countryside.
    const builtUp = near.filter((s) => boxesIntersect(boxPad({ minx: s.x, miny: s.y, maxx: s.x, maxy: s.y }, s.r + 250), box)).map(townDensity);
    if (builtUp.length) {
      contour('landuse', 'urban', (i, j, k) => {
        if (raw[k] < 1.2) return -1;
        const x = box.minx + i * CELL, y = box.miny + j * CELL;
        let d = -1;
        for (const f of builtUp) d = Math.max(d, f(x, y));
        return d - 0.03;
      }, 3000);
    }
    for (const s of near) {
      if (!boxesIntersect(boxPad({ minx: s.x, miny: s.y, maxx: s.x, maxy: s.y }, s.r + 250), box)) continue;
      const town = this.town(s);
      for (const arc of town.railLinks) { line('rail', 'rail', arc); stamp(arc, 12); railArcs.push({ kind: 'rail', pts: arc }); }
      for (const b of town.blocks) {
        const ring = clipPoly(b.ring, box);
        if (ring.length >= 3) poly('landuse', b.kind, [ring]);
      }
      for (const st of town.streets) {
        line('road', st.kind, st.pts, { name: st.name });
        streets.push(st);
      }
      for (const b of town.buildings) {
        if (inBox(box, b.x, b.y) && !blocked(b)) poly('building', b.kind, [b.ring], { height: b.height });
      }
      for (const p of town.piers) if (inBox(box, p.x, p.y)) poly('manmade', 'pier', [p.ring]);
      for (const p of town.pois) if (inBox(box, p.x, p.y)) point('poi', p.kind, p.x, p.y, { name: p.name });
    }
    lap('towns');

    // 7. Countryside: farmsteads with a track to the nearest road, and field boundaries.
    const tracks: { kind: string; pts: Pt[] }[] = [];
    const FARM = 700;
    for (let b = Math.floor(wide.miny / FARM); b <= Math.floor(wide.maxy / FARM); b++) {
      for (let a = Math.floor(wide.minx / FARM); a <= Math.floor(wide.maxx / FARM); a++) {
        const fs = hashInt(this.seed + 31, a, b);
        if (fs / 4294967296 > 0.38) continue;
        const x = (a + 0.15 + 0.7 * rand01(fs, 1, 0)) * FARM, y = (b + 0.15 + 0.7 * rand01(fs, 2, 0)) * FARM;
        const [u, r] = urbanAt(x, y);
        const e = terrain.elev(x, y);
        if (u > -0.15 || e < 4 || e > 180 || terrain.fertility(x, y) + 0.12 + r * 0.55 < 0.1) continue;
        if (Math.hypot(terrain.elev(x + 40, y) - e, terrain.elev(x, y + 40) - e) / 40 > 0.08) continue;
        if (allRivers.some((w) => nearestOnLine(x, y, w.pts).d < 45 + w.width)) continue;
        const ang = rand01(fs, 3, 0) * Math.PI, cs = Math.cos(ang), sn = Math.sin(ang);
        const rect = (ox: number, oy: number, w: number, d: number) => {
          const px = x + ox * cs - oy * sn, py = y + ox * sn + oy * cs;
          const ring: Pt[] = [[-w / 2, -d / 2], [w / 2, -d / 2], [w / 2, d / 2], [-w / 2, d / 2]]
            .map(([p, q]) => [px + p * cs - q * sn, py + p * sn + q * cs] as Pt);
          const bld = { x: px, y: py, ring };
          if (inBox(box, px, py) && !blocked(bld)) poly('building', 'farm', [ring], { height: 6 });
        };
        rect(0, 0, 13, 9);
        rect(26, 4, 22, 11);
        if (rand01(fs, 4, 0) < 0.6) rect(-6, 28, 11, 20);
        let best: { x: number; y: number; d: number } | null = null;
        for (const h of highways) {
          const n = nearestOnLine(x, y, h.pts);
          if (n.d < 600 && (!best || n.d < best.d)) best = n;
        }
        if (best && best.d > 25) {
          const track: Pt[] = [[x, y], [best.x, best.y]];
          if (!allRivers.some((w) => !w.minor && crossings(track, w.pts).length)) {
            line('road', 'track', track);
            tracks.push({ kind: 'track', pts: track });
          }
        }
      }
    }
    const farmAt = (x: number, y: number): number => {
      const gx = Math.min(N - 1.001, Math.max(0, (x - box.minx) / CELL)), gy = Math.min(N - 1.001, Math.max(0, (y - box.miny) / CELL));
      const i = Math.floor(gx), j = Math.floor(gy), tx = gx - i, ty = gy - j;
      const a = farm[j * N + i], c = farm[j * N + i + 1], d = farm[(j + 1) * N + i], e = farm[(j + 1) * N + i + 1];
      return (a + (c - a) * tx) * (1 - ty) + (d + (e - d) * tx) * ty;
    };
    const REGION = 1000;
    for (let b = Math.floor(box.miny / REGION); b <= Math.floor((box.maxy - 1) / REGION); b++) {
      for (let a = Math.floor(box.minx / REGION); a <= Math.floor((box.maxx - 1) / REGION); a++) {
        const rs = hashInt(this.seed + 37, a, b);
        const part: Box = {
          minx: Math.max(box.minx, a * REGION), miny: Math.max(box.miny, b * REGION),
          maxx: Math.min(box.maxx, (a + 1) * REGION), maxy: Math.min(box.maxy, (b + 1) * REGION),
        };
        const ang = rand01(rs, 1, 0) * Math.PI;
        const mx = (a + 0.5) * REGION, my = (b + 0.5) * REGION;
        for (const [dir, gap] of [[ang, 130 + rand01(rs, 2, 0) * 120], [ang + Math.PI / 2, 190 + rand01(rs, 3, 0) * 160]]) {
          const dx = Math.cos(dir), dy = Math.sin(dir);
          for (let k = -Math.ceil(800 / gap); k <= Math.ceil(800 / gap); k++) {
            const ox = mx - dy * k * gap, oy = my + dx * k * gap;
            for (const piece of clipLine([[ox - dx * 1500, oy - dy * 1500], [ox + dx * 1500, oy + dy * 1500]], part)) {
              // Keep only the stretches that lie in farmland.
              const [[ax, ay], [bx, by]] = piece;
              const steps = Math.max(1, Math.round(Math.hypot(bx - ax, by - ay) / 20));
              let run: Pt[] = [];
              const flush = () => {
                if (run.length > 3) features.push({ type: 'Feature', properties: { layer: 'field', kind: 'boundary' }, geometry: { type: 'LineString', coordinates: [run[0], run[run.length - 1]].map(this.ll) } });
                run = [];
              };
              for (let q = 0; q <= steps; q++) {
                const p: Pt = [ax + ((bx - ax) * q) / steps, ay + ((by - ay) * q) / steps];
                if (farmAt(p[0], p[1]) > 0.05) run.push(p); else flush();
              }
              flush();
            }
          }
        }
      }
    }
    lap('rural');

    // 8. Bridges and fords, wherever a road or railway crosses a river.
    const crossers = [...highways, ...motorways.map((m) => ({ kind: 'motorway', pts: m.pts })),
      ...rails, ...streets, ...tracks];
    for (const road of crossers) {
      const rb = boxOf(road.pts);
      if (!boxesIntersect(rb, box)) continue;
      for (const r of rivers) {
        if (r.minor || !boxesIntersect(r.box, rb)) continue;
        for (const c of crossings(road.pts, r.pts)) {
          if (!inBox(box, c.x, c.y)) continue;
          if (road.kind === 'tertiary' && r.width < 10) { point('ford', 'ford', c.x, c.y); continue; }
          const half = Math.max(r.width, r.w1) / 2 + 9;
          features.push({ type: 'Feature', properties: { layer: 'bridge', kind: road.kind },
            geometry: { type: 'LineString', coordinates: [[c.x - c.dx * half, c.y - c.dy * half] as Pt, [c.x + c.dx * half, c.y + c.dy * half] as Pt].map(this.ll) } });
        }
      }
    }

    // Where a road meets a railway: main roads go over on a bridge, the rest get a level crossing.
    for (const rail of [...rails, ...railArcs]) {
      const rb = boxOf(rail.pts);
      if (!boxesIntersect(rb, box)) continue;
      for (const road of [...highways, ...motorways.map((m) => ({ kind: 'motorway', pts: m.pts })), ...streets, ...tracks]) {
        if (!boxesIntersect(boxOf(road.pts), rb)) continue;
        for (const c of crossings(road.pts, rail.pts)) {
          if (!inBox(box, c.x, c.y)) continue;
          if (road.kind === 'motorway' || road.kind === 'primary' || road.kind === 'secondary') {
            features.push({ type: 'Feature', properties: { layer: 'bridge', kind: road.kind },
              geometry: { type: 'LineString', coordinates: [[c.x - c.dx * 13, c.y - c.dy * 13] as Pt, [c.x + c.dx * 13, c.y + c.dy * 13] as Pt].map(this.ll) } });
          } else point('crossing', 'level', c.x, c.y);
        }
      }
    }

    // 9. Names for the terrain itself: summits, forests and bays.
    const seen = new Set<string>();
    for (const p of hydro.peaks(boxPad(box, 900))) {
      let x = p.x, y = p.y, e = terrain.elev(x, y);
      for (let it = 0; it < 40; it++) {
        let bx = x, by = y, be = e;
        for (let a = 0; a < 8; a++) {
          const nx = x + Math.cos(a * Math.PI / 4) * 25, ny = y + Math.sin(a * Math.PI / 4) * 25;
          const ne = terrain.elev(nx, ny);
          if (ne > be) { bx = nx; by = ny; be = ne; }
        }
        if (be === e) break;
        x = bx; y = by; e = be;
      }
      const key = `${Math.round(x / 50)},${Math.round(y / 50)}`;
      if (e < 40 || !inBox(box, x, y) || seen.has(key)) continue;
      seen.add(key);
      const stem = stemName(p.id);
      const name = e < 150 ? `${stem} Hill` : e < 350 ? `${stem} ${['Fell', 'Top', 'Down', 'Ridge'][(p.id >>> 20) & 3]}` : `Mount ${stem}`;
      point('peak', 'peak', x, y, { name, ele: Math.round(e) });
    }
    const lattice = (size: number, salt: number, fn: (x: number, y: number, h: number) => void) => {
      for (let b = Math.floor(box.miny / size); b <= Math.floor(box.maxy / size); b++) {
        for (let a = Math.floor(box.minx / size); a <= Math.floor(box.maxx / size); a++) {
          const h = hashInt(this.seed + salt, a, b);
          const x = (a + 0.2 + 0.6 * rand01(h, 1, 0)) * size, y = (b + 0.2 + 0.6 * rand01(h, 2, 0)) * size;
          if (inBox(box, x, y)) fn(x, y, h);
        }
      }
    };
    lattice(4500, 41, (x, y, h) => {
      const e = terrain.elev(x, y);
      if (e < 5 || e > 260 || terrain.moisture(x, y) < 0.3 || urbanAt(x, y)[0] > -0.4) return;
      point('area_label', 'forest', x, y, { name: `${stemName(h)} ${['Forest', 'Wood', 'Woods', 'Chase'][(h >>> 20) & 3]}` });
    });
    lattice(6000, 43, (x, y, h) => {
      const e = terrain.elev(x, y);
      if (e > -3 || e < -45) return;
      let land = 0;
      for (let a = 0; a < 8; a++) if (terrain.elev(x + Math.cos(a * Math.PI / 4) * 2200, y + Math.sin(a * Math.PI / 4) * 2200) > 0) land++;
      if (land >= 4) point('area_label', 'bay', x, y, { name: `${stemName(h)} Bay` });
    });
    lap('details');
    return { features, timings };
  }
}
