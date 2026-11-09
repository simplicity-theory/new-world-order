import { type Box, type Pt, Mask, boxPad, nearestOnLine } from './geom.ts';
import type { Hydro } from './hydro.ts';
import type { Relief } from './relief.ts';
import { hashInt, mulberry32, noise2, rand01 } from './rng.ts';
import type { Link, Settlement } from './settle.ts';
import type { Terrain } from './terrain.ts';

// A town is laid out as a whole from its own seed, then chunks take the part inside them.
//
// The plan starts from the roads that arrive: each becomes a straight avenue from the
// edge of town inwards. The avenues divide the town into districts, each with its own
// street grid aligned to the avenue beside it. Towns and cities also get a tight,
// irregular old core inside a ring road. Outer streets curve and some end in cul-de-sacs.

export interface Street { pts: Pt[]; kind: string; name: string }
export interface Block { ring: Pt[]; kind: string }
export interface Building { ring: Pt[]; x: number; y: number; kind: string; height: number }
export interface Poi { x: number; y: number; kind: string; name: string }
export interface TownLayout {
  streets: Street[]; blocks: Block[]; buildings: Building[]; pois: Poi[]; piers: Building[];
  /** Where each incident highway hands over to an avenue: distance along it from the centre, and the junction. */
  cuts: Map<Link, { t: number; pt: Pt }>;
  /** Track joining the railways that arrive, so they all reach the one station. */
  railLinks: Pt[][];
}

const ARTERIAL = 3;
const TAU = Math.PI * 2;
const RANK: Record<string, number> = { street_major: 0, tertiary: 1, secondary: 2, primary: 3 };
const WORDS = ['Oak', 'Elm', 'Maple', 'Cedar', 'Pine', 'Birch', 'Ash', 'Willow', 'Mill', 'Church', 'Station', 'Market',
  'Bridge', 'Park', 'High', 'King', 'Queen', 'Victoria', 'Albert', 'North', 'South', 'East', 'West', 'Garden', 'Orchard',
  'Meadow', 'Hill', 'Lake', 'River', 'Spring', 'Forge', 'Chapel', 'School', 'Castle', 'Abbey', 'Grove', 'Rose', 'Linden',
  'Hazel', 'Harbour', 'Quarry', 'Tanner', 'Baker', 'Weaver', 'Cooper', 'Fisher', 'Shepherd', 'Mason'];
const SAINTS = ['Mary', 'John', 'Peter', 'Anne', 'Luke', 'Clare', 'Martin', 'Agnes', 'Paul', 'Hilda'];

/** How built-up a town is at a point: about 1 at the centre, 0 at its ragged edge, negative beyond. */
export function townDensity(s: Settlement): (x: number, y: number) => number {
  const seed = hashInt(s.seed, 555, s.tier);
  return (x, y) => 1 - Math.hypot(x - s.x, y - s.y) / (0.77 * s.r) + 0.3 * noise2(seed + 3, x / (0.5 * s.r), y / (0.5 * s.r));
}

interface Avenue { ang: number; len: number; kind: string; name: string; pt: Pt }

export function buildTown(
  terrain: Terrain, hydro: Hydro, relief: Relief, s: Settlement, incident: Link[], rails: Link[],
): TownLayout {
  const seed = hashInt(s.seed, 555, s.tier);
  const rng = mulberry32(seed);
  const big = s.tier >= 2;
  const edge = s.r * 0.95;              // where highways hand over to avenues
  const rc = big ? s.r * (s.tier === 3 ? 0.17 : 0.2) : 0;   // mean radius of the old core
  // The core is a rounded, lopsided shape rather than a circle.
  const lobe2 = rng() * Math.PI * 2, lobe3 = rng() * Math.PI * 2;
  const rcAt = (a: number): number => rc * (1 + 0.16 * Math.sin(2 * a + lobe2) + 0.1 * Math.sin(3 * a + lobe3));

  // Everything is planned on straight lines, then bent by this warp. It is zero at the
  // centre and at the edge, so avenues still meet their highways exactly.
  const amp = big ? 55 : 22, wl = big ? 700 : 380;
  const fin = (x: number, y: number): Pt => {
    const q = Math.min(1, Math.hypot(x - s.x, y - s.y) / edge);
    const k = amp * Math.sin(Math.PI * q);
    return [x + k * noise2(seed + 1, x / wl, y / wl), y + k * noise2(seed + 2, x / wl, y / wl)];
  };
  const density = townDensity(s);

  const area: Box = boxPad({ minx: s.x, miny: s.y, maxx: s.x, maxy: s.y }, s.r * 1.5 + 250);
  const mask = new Mask(area, 8);
  const { rivers, lakes } = hydro.water(area);
  for (const r of rivers) mask.stampLine(r.pts, Math.max(r.width, r.w1) / 2 + (r.kind === 'stream' ? 7 : 12), 1);
  for (const l of lakes) { mask.stampPoly(l.ring, 1); mask.stampLine([...l.ring, l.ring[0]], 12, 1); }
  const wet = (x: number, y: number): boolean => mask.get(x, y) > 0 || terrain.elev(x, y) < 1.2;
  const gentle = (x: number, y: number): boolean => {
    const z = relief.at(x, y);
    return Math.hypot(relief.at(x + 30, y) - z, relief.at(x, y + 30) - z) / 30 < 0.14;
  };
  const nearRail = (x: number, y: number): boolean => rails.some((r) => nearestOnLine(x, y, r.pts).d < 170);

  const layout: TownLayout = { streets: [], blocks: [], buildings: [], pois: [], piers: [], cuts: new Map(), railLinks: [] };
  /** Where a line leaving the centre first reaches a given distance from it. */
  const exit = (link: Link, radius: number): { t: number; pt: Pt } | null => {
    const arr = link.a === s ? link.pts : [...link.pts].reverse();
    let t = 0;
    for (let k = 0; k + 1 < arr.length; k++) {
      const [ax, ay] = arr[k], [bx, by] = arr[k + 1];
      const l = Math.hypot(bx - ax, by - ay);
      if (Math.hypot(bx - s.x, by - s.y) >= radius) {
        if (Math.hypot(ax - s.x, ay - s.y) >= radius) return { t, pt: [ax, ay] };
        let lo = 0, hi = 1;
        for (let it = 0; it < 20; it++) {
          const m = (lo + hi) / 2;
          if (Math.hypot(ax + (bx - ax) * m - s.x, ay + (by - ay) * m - s.y) < radius) lo = m; else hi = m;
        }
        return { t: t + l * hi, pt: [ax + (bx - ax) * hi, ay + (by - ay) * hi] };
      }
      t += l;
    }
    return null;
  };
  const dead = new Set<Building>();

  // --- Avenues: one per arriving highway, most important first. ---
  const avenues: Avenue[] = [];
  const order = [...incident].sort((p, q) => RANK[q.kind] - RANK[p.kind]
    || (q.spur ? 0 : (q.a === s ? q.b : q.a).rank) - (p.spur ? 0 : (p.a === s ? p.b : p.a).rank));
  for (const hw of order) {
    const out = exit(hw, edge);
    if (!out) continue;
    const hit = out.pt;
    const ang = Math.atan2(hit[1] - s.y, hit[0] - s.x);
    const main = avenues.find((a) => Math.abs(((a.ang - ang + Math.PI * 3) % TAU) - Math.PI) < 0.6);
    if (main) {
      // Too close to a bigger road's avenue to have its own: it joins that road outside town.
      // The join is a straight run, so it is only made where that run stays on dry land.
      for (const reach of [1.5, 1.15]) {
        const far = exit(hw, edge * reach);
        if (!far) continue;
        let dry = true;
        for (let q = 1; q < 16 && dry; q++) dry = !wet(main.pt[0] + ((far.pt[0] - main.pt[0]) * q) / 16, main.pt[1] + ((far.pt[1] - main.pt[1]) * q) / 16);
        if (dry) { layout.cuts.set(hw, { t: far.t, pt: main.pt }); break; }
      }
      continue;
    }
    const other = hw.a === s ? hw.b : hw.a;
    avenues.push({ ang, len: Math.hypot(hit[0] - s.x, hit[1] - s.y), kind: hw.kind, name: hw.spur ? `${s.name} Link` : `${other.name} Road`, pt: hit });
    layout.cuts.set(hw, out);
  }
  const extra = (ang: number) => avenues.push({ ang, len: edge * 0.9, kind: 'street_major', name: 'High Street',
    pt: [s.x + Math.cos(ang) * edge * 0.9, s.y + Math.sin(ang) * edge * 0.9] });
  if (!avenues.length) extra(rng() * TAU - Math.PI);
  if (avenues.length === 1) extra(avenues[0].ang > 0 ? avenues[0].ang - Math.PI : avenues[0].ang + Math.PI);
  avenues.sort((a, b) => a.ang - b.ang);

  const emit = (plan: Pt[], kind: string, name: string) => {
    // Drop stretches over water, but bridge short ones.
    const pts = plan.map(([x, y]) => fin(x, y));
    const dry = pts.map(([x, y]) => !wet(x, y));
    let cur: Pt[] = [], last = -1;
    const flush = () => { if (cur.length > 1) layout.streets.push({ pts: cur, kind, name }); cur = []; };
    for (let k = 0; k < pts.length; k++) {
      if (!dry[k]) continue;
      if (last >= 0 && k - last > 5) flush();
      cur.push(pts[k]);
      last = k;
    }
    flush();
  };
  for (const a of avenues) {
    const plan: Pt[] = [];
    for (let d = rcAt(a.ang); d < a.len; d += 40) plan.push([s.x + Math.cos(a.ang) * d, s.y + Math.sin(a.ang) * d]);
    plan.push([s.x + Math.cos(a.ang) * a.len, s.y + Math.sin(a.ang) * a.len]);
    emit(plan, a.kind, a.name);
  }
  if (rc) {
    const plan: Pt[] = [];
    for (let k = 0; k <= 48; k++) plan.push([s.x + Math.cos((k / 48) * TAU) * rcAt((k / 48) * TAU), s.y + Math.sin((k / 48) * TAU) * rcAt((k / 48) * TAU)]);
    emit(plan, 'street_major', `${s.name} Ring`);
  }

  // --- Districts. `span` is the angle a district covers anticlockwise from its avenue; null for the core. ---
  interface Lot { x: number; y: number; block: Block; first: number; last: number; civic: (kind: string, w: number, d: number, h: number) => void }
  const lots: Lot[] = [];

  const district = (id: number, theta: number, bw: number, bh: number, span: number | null) => {
    const cs = Math.cos(theta), sn = Math.sin(theta);
    const T = (u: number, v: number): Pt => fin(s.x + u * cs - v * sn, s.y + u * sn + v * cs);
    const lim = span === null ? rc * 1.3 : s.r;
    const nu = Math.ceil(lim / bw) + 1, nv = Math.ceil(lim / bh) + 1;
    const W = 2 * nu + 1, Hh = 2 * nv + 1;
    const vi = (i: number, j: number) => (j + nv) * W + (i + nu);
    const sinS = span === null ? 0 : Math.sin(span), cosS = span === null ? 1 : Math.cos(span);
    /** 0 outside the district, 1 inside, 2 on the avenue that bounds it. */
    const geo = (u: number, v: number, onAxis: boolean): number => {
      const d = Math.hypot(u, v);
      const ring = rc ? rcAt(Math.atan2(v, u) + theta) : 0;
      if (span === null) return d < ring - 10 ? 1 : 0;
      if (onAxis && u > 0 && u >= ring - 1) return 2;
      if (d < ring + 12) return 0;
      let a = Math.atan2(v, u);
      if (a < 0) a += TAU;
      if (a <= 0 || a >= span) return 0;
      if (u * cosS + v * sinS > 0 && Math.abs(-u * sinS + v * cosS) < 12) return 0;
      return 1;
    };
    const P: Pt[] = new Array(W * Hh);
    const D = new Float32Array(W * Hh);
    const G = new Uint8Array(W * Hh);
    const ok = new Uint8Array(W * Hh);
    for (let j = -nv; j <= nv; j++) {
      for (let i = -nu; i <= nu; i++) {
        const k = vi(i, j);
        // The old core's corners are nudged off the grid so its lanes are not quite straight.
        const ju = span === null ? (rand01(seed + 11, i, j) - 0.5) * 9 : 0, jv = span === null ? (rand01(seed + 12, i, j) - 0.5) * 9 : 0;
        const p = T(i * bw + ju, j * bh + jv);
        P[k] = p;
        G[k] = geo(i * bw, j * bh, j === 0);
        D[k] = density(p[0], p[1]);
        if (G[k] && D[k] > -0.4 && !wet(p[0], p[1]) && gentle(p[0], p[1])) ok[k] = 1;
      }
    }

    const built = new Uint8Array(W * Hh);
    const coreAt = s.tier === 3 ? 0.7 : s.tier === 2 ? 0.8 : 2;
    const addBuilding = (uc: number, vc: number, du: number, dv: number, kind: string, height: number) => {
      const [x, y] = T(uc, vc);
      const [x1, y1] = T(uc + 1, vc);
      const ax = x1 - x, ay = y1 - y;
      const al = Math.hypot(ax, ay) || 1;
      const ux = ax / al, uy = ay / al;
      const hx = du / 2, hy = dv / 2;
      const ring: Pt[] = [
        [x - ux * hx + uy * hy, y - uy * hx - ux * hy],
        [x + ux * hx + uy * hy, y + uy * hx - ux * hy],
        [x + ux * hx - uy * hy, y + uy * hx + ux * hy],
        [x - ux * hx - uy * hy, y - uy * hx + ux * hy],
      ];
      for (const [px, py] of ring) if (mask.get(px, py) > 0) return;
      if (wet(x, y)) return;
      layout.buildings.push({ ring, x, y, kind, height: Math.round(height) });
    };

    for (let j = -nv; j < nv; j++) {
      for (let i = -nu; i < nu; i++) {
        if (!(ok[vi(i, j)] && ok[vi(i + 1, j)] && ok[vi(i, j + 1)] && ok[vi(i + 1, j + 1)])) continue;
        const u0 = i * bw, v0 = j * bh, u1 = u0 + bw, v1 = v0 + bh;
        if (!geo(u0 + bw / 2, v0 + bh / 2, false)) continue;
        const [cx, cy] = T(u0 + bw / 2, v0 + bh / 2);
        const d = density(cx, cy);
        if (d <= 0 || wet(cx, cy)) continue;
        built[vi(i, j)] = 1;
        const br = mulberry32(hashInt(seed + id, i * 31 + 7, j * 17 + 3));
        let kind = d > coreAt ? 'commercial' : d > 0.38 && s.tier >= 1 ? 'dense' : 'house';
        const roll = br();
        if (s.tier >= 1 && roll < 0.055) kind = 'park';
        else if (s.tier >= 1 && d < 0.45 && nearRail(cx, cy) ? roll < 0.6 : s.tier >= 2 && d < 0.3 && roll < 0.17) kind = 'industrial';
        const block: Block = {
          ring: [P[vi(i, j)], T(u0 + bw / 2, v0), P[vi(i + 1, j)], T(u1, v0 + bh / 2), P[vi(i + 1, j + 1)],
            T(u0 + bw / 2, v1), P[vi(i, j + 1)], T(u0, v0 + bh / 2)],
          kind: kind === 'dense' || kind === 'house' ? 'residential' : kind,
        };
        layout.blocks.push(block);
        const first = layout.buildings.length;
        const lot = (): void => {
          lots.push({ x: cx, y: cy, block, first, last: layout.buildings.length,
            civic: (k, w, dep, h) => addBuilding(u0 + bw / 2, v0 + bh / 2, Math.min(w, bw - 24), Math.min(dep, bh - 24), k, h) });
        };
        if (kind === 'park') continue;

        const inset = 8;
        const iu0 = u0 + inset, iu1 = u1 - inset, iv0 = v0 + inset, iv1 = v1 - inset;
        if (kind === 'industrial') {
          const depth = Math.min(iu1 - iu0 - 8, 40 + br() * 15);
          let v = iv0 + 4;
          while (v + 30 < iv1) {
            const len = Math.min(iv1 - v - 2, 35 + br() * 40);
            if (br() > 0.15) addBuilding((iu0 + iu1) / 2, v + len / 2, depth, len, 'industrial', 8 + br() * 5);
            v += len + 10 + br() * 8;
          }
          continue;
        }
        const commercial = kind === 'commercial', dense = kind === 'dense';
        const setback = commercial ? 0 : dense ? 3 : 5;
        let depth = commercial ? 22 + br() * 7 : dense ? 13 + br() * 3 : 9 + br() * 3;
        depth = Math.min(depth, (iu1 - iu0) / 2 - setback - 3);
        const tall = commercial ? (s.tier === 3 ? 12 + 60 * Math.max(0, d - coreAt) / (1 - coreAt + 0.3) : 10) : 0;
        // Two rows of lots facing the long sides of the block.
        for (const side of [0, 1]) {
          const uc = side ? iu1 - setback - depth / 2 : iu0 + setback + depth / 2;
          let v = iv0 + (commercial ? 0 : 2);
          while (v < iv1) {
            const lw = commercial ? 14 + br() * 22 : dense ? 8 + br() * 6 : 18 + br() * 8;
            if (v + lw > iv1) break;
            const len = commercial ? lw - 0.6 : dense ? lw - (br() < 0.3 ? 2.5 : 0.5) : 9 + br() * 4;
            const dep = depth * (commercial ? 1 : 0.85 + br() * 0.3);
            const off = (depth - dep) / 2 * (side ? 1 : -1);
            if (commercial || br() > 0.08) {
              const height = commercial ? tall * (0.6 + br() * 0.8) : dense ? 9 + br() * 6 : 5 + br() * 3;
              addBuilding(uc - off, v + lw / 2, dep, len, commercial ? 'commercial' : 'residential', height);
            }
            v += lw;
          }
        }
        // Dense blocks also front the short sides.
        if (commercial || dense) {
          const ua = iu0 + setback + depth + 3, ub = iu1 - setback - depth - 3;
          for (const side of [0, 1]) {
            const vc = side ? iv1 - setback - depth / 2 : iv0 + setback + depth / 2;
            let u = ua;
            while (u < ub) {
              const lw = commercial ? 14 + br() * 14 : 8 + br() * 5;
              if (u + lw > ub) break;
              const height = commercial ? tall * (0.6 + br() * 0.8) : 9 + br() * 6;
              addBuilding(u + lw / 2, vc, lw - 0.6, depth, commercial ? 'commercial' : 'residential', height);
              u += lw;
            }
          }
        }
        lot();
      }
    }

    // Streets: every grid line is walked once. Arterial lines continue past the built-up
    // area and may bridge short stretches of water.
    const lineName = (horizontal: boolean, line: number): string => {
      const word = WORDS[hashInt(seed + id * 7, line, horizontal ? 1 : 2) % WORDS.length];
      return `${word} ${span === null ? (horizontal ? 'Lane' : 'Row') : horizontal ? 'Street' : 'Avenue'}`;
    };
    const isBuilt = (i: number, j: number): boolean =>
      i >= -nu && i < nu && j >= -nv && j < nv && built[vi(i, j)] === 1;
    const walk = (horizontal: boolean, line: number) => {
      const n = horizontal ? nu : nv;
      const arterial = ((line % ARTERIAL) + ARTERIAL) % ARTERIAL === 0;
      const at = (k: number) => (horizontal ? vi(k, line) : vi(line, k));
      const mid = (k: number): Pt => (horizontal ? T((k + 0.5) * bw, line * bh) : T(line * bw, (k + 0.5) * bh));
      const kind = arterial ? 'street_major' : 'street', name = lineName(horizontal, line);
      let cur: Pt[] | null = null;
      const flush = () => { if (cur && cur.length > 1) layout.streets.push({ pts: cur, kind, name }); cur = null; };
      let k = -n;
      while (k < n) {
        const a = at(k);
        let step = 0;
        if (ok[a]) {
          const b = at(k + 1);
          const beside = horizontal
            ? isBuilt(k, line) || isBuilt(k, line - 1)
            : isBuilt(line, k) || isBuilt(line - 1, k);
          const onAvenue = G[a] === 2 && G[b] === 2;      // drawn as the avenue itself
          // In the outskirts some side streets are left out, which makes cul-de-sacs.
          const culDeSac = !arterial && D[a] < 0.3 && D[b] < 0.3 && rand01(seed + 13 + id, a, b) < 0.22;
          if (ok[b] && !onAvenue && !culDeSac && (beside || (arterial && D[a] > 0.05 && D[b] > 0.05))) step = 1;
          else if (arterial && D[a] > 0.05 && !ok[b]) {
            for (let j = 2; j <= 3 && k + j <= n; j++) {
              if (ok[at(k + j)]) { if (D[at(k + j)] > 0.05) step = j; break; }
            }
          }
        }
        if (!step) { flush(); k++; continue; }
        if (!cur) cur = [P[a]];
        if (step === 1) cur.push(mid(k));
        cur.push(P[at(k + step)]);
        k += step;
      }
      flush();
    };
    for (let j = -nv; j <= nv; j++) walk(true, j);
    for (let i = -nu; i <= nu; i++) walk(false, i);

    // Streets that would run out of the district are carried on to the avenue or ring
    // road at its edge, so every district is joined to its neighbours.
    for (let j = -nv; j <= nv; j++) {
      for (let i = -nu; i <= nu; i++) {
        const a = vi(i, j);
        if (!ok[a] || G[a] !== 1 || D[a] <= 0.05) continue;
        for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const i2 = i + di, j2 = j + dj;
          if (i2 < -nu || i2 > nu || j2 < -nv || j2 > nv || G[vi(i2, j2)] !== 0) continue;
          const ua = i * bw, va = j * bh, ub = i2 * bw, vb = j2 * bh;
          let best = 2;
          if (span !== null) {
            const sa = -ua * sinS + va * cosS, sb = -ub * sinS + vb * cosS;
            if (sa * sb < 0) {
              const t = sa / (sa - sb);
              const u = ua + (ub - ua) * t, v = va + (vb - va) * t;
              if (u * cosS + v * sinS >= rc * 0.8 && t < best) best = t;
            }
            if (va * vb < 0) {
              const t = va / (va - vb);
              if (ua + (ub - ua) * t >= rc * 0.8 && t < best) best = t;
            }
          }
          if (rc) {
            // Where the segment meets the ring road: bisect for the crossing.
            const off = (t: number): number => {
              const u = ua + (ub - ua) * t, v = va + (vb - va) * t;
              return Math.hypot(u, v) - rcAt(Math.atan2(v, u) + theta);
            };
            if (off(0) * off(1) < 0) {
              let lo = 0, hi = 1;
              const inside = off(0) < 0;
              for (let it = 0; it < 18; it++) {
                const m = (lo + hi) / 2;
                if ((off(m) < 0) === inside) lo = m; else hi = m;
              }
              if (hi > 0.02 && hi < best) best = hi;
            }
          }
          if (best > 1) continue;
          const end = T(ua + (ub - ua) * best, va + (vb - va) * best);
          const half = T(ua + (ub - ua) * best / 2, va + (vb - va) * best / 2);
          if (wet(end[0], end[1]) || wet(half[0], half[1])) continue;
          layout.streets.push({ pts: [P[a], end], kind: 'street', name: lineName(dj === 0, dj === 0 ? j : i) });
        }
      }
    }
  };

  if (rc) district(0, rng() * Math.PI / 2, 56 + rng() * 8, 74 + rng() * 12, null);
  avenues.forEach((a, k) => {
    const next = avenues[(k + 1) % avenues.length];
    const span = ((next.ang - a.ang + TAU) % TAU) || TAU;
    district(k + 1, a.ang, 78 + rng() * 26, 125 + rng() * 45, span);
  });

  // --- Landmarks: each takes over the block nearest a chosen spot. ---
  const used = new Set<Lot>();
  const landmark = (frac: number, kind: string, name: string, w: number, d: number, h: number) => {
    const a = rng() * TAU;
    const tx = s.x + Math.cos(a) * s.r * frac, ty = s.y + Math.sin(a) * s.r * frac;
    let best: Lot | null = null, bd = s.r * 0.5;
    for (const l of lots) {
      const dd = Math.hypot(l.x - tx, l.y - ty);
      if (dd < bd && !used.has(l) && l.block.kind !== 'park' && l.block.kind !== 'industrial') { bd = dd; best = l; }
    }
    if (!best) return;
    used.add(best);
    for (let k = best.first; k < best.last; k++) dead.add(layout.buildings[k]);
    best.block.kind = 'civic';
    const before = layout.buildings.length;
    best.civic(kind, w, d, h);
    if (layout.buildings.length > before) layout.pois.push({ x: best.x, y: best.y, kind, name });
  };
  if (s.tier >= 2) landmark(0, 'townhall', `${s.name} ${s.tier === 3 ? 'City' : 'Town'} Hall`, 44, 30, 18);
  if (s.tier >= 1) landmark(0.22, 'church', `St ${SAINTS[s.seed % SAINTS.length]}'s Church`, 18, 34, 14);
  if (s.tier >= 1) landmark(0.42, 'school', `${s.name} School`, 50, 26, 9);
  if (s.tier === 3) landmark(0.5, 'hospital', `${s.name} Hospital`, 60, 44, 20);
  if (s.tier === 3) landmark(0.35, 'church', `St ${SAINTS[(s.seed >>> 4) % SAINTS.length]}'s Church`, 18, 34, 14);
  // Railways stop short of the centre. The line to the biggest neighbour gets the station,
  // and the others curve round to meet it.
  const stops = [...rails].sort((p, q) => (q.a === s ? q.b : q.a).rank - (p.a === s ? p.b : p.a).rank)
    .map((r) => ({ r, out: exit(r, Math.max(rc + 45, s.r * 0.3)) })).filter((e) => e.out);
  stops.forEach(({ r, out }, k) => {
    layout.cuts.set(r, out!);
    if (k === 0) { layout.pois.push({ x: out!.pt[0], y: out!.pt[1], kind: 'station', name: `${s.name} Station` }); return; }
    const home = stops[0].out!.pt, rr = Math.hypot(out!.pt[0] - s.x, out!.pt[1] - s.y);
    const a0 = Math.atan2(out!.pt[1] - s.y, out!.pt[0] - s.x);
    const sweep = ((Math.atan2(home[1] - s.y, home[0] - s.x) - a0 + Math.PI * 3) % TAU) - Math.PI;
    const arc: Pt[] = [];
    const n = Math.max(2, Math.ceil(Math.abs(sweep) / 0.12));
    for (let q = 0; q <= n; q++) arc.push([s.x + Math.cos(a0 + (sweep * q) / n) * rr, s.y + Math.sin(a0 + (sweep * q) / n) * rr]);
    arc[arc.length - 1] = home;
    layout.railLinks.push(arc);
  });
  layout.buildings = layout.buildings.filter((b) => !dead.has(b));

  // --- Harbour: piers where the town reaches the sea. ---
  if (s.tier >= 1) {
    let shore: Pt | null = null, sa = 0, sd = Infinity;
    for (let k = 0; k < 24; k++) {
      const a = (k / 24) * TAU;
      for (let d = s.r * 0.3; d < s.r * 1.15 && d < sd; d += 25) {
        const x = s.x + Math.cos(a) * d, y = s.y + Math.sin(a) * d;
        if (terrain.elev(x, y) < -0.3) { shore = [x, y]; sa = a; sd = d; break; }
      }
    }
    if (shore) {
      const dx = Math.cos(sa), dy = Math.sin(sa);
      const n = 2 + s.tier;
      for (let k = 0; k < n; k++) {
        const off = (k - (n - 1) / 2) * 46;
        const bx = shore[0] - dy * off - dx * 12, by = shore[1] + dx * off - dy * 12;
        const len = 70 + rng() * 70;
        if (terrain.elev(bx + dx * len, by + dy * len) > -0.5 || terrain.elev(bx - dx * 30, by - dy * 30) < 0.5) continue;
        const hw = 3.5;
        layout.piers.push({
          ring: [[bx - dy * hw, by + dx * hw], [bx + dx * len - dy * hw, by + dy * len + dx * hw],
            [bx + dx * len + dy * hw, by + dy * len - dx * hw], [bx + dy * hw, by - dx * hw]],
          x: bx + dx * len / 2, y: by + dy * len / 2, kind: 'pier', height: 2,
        });
      }
      if (layout.piers.length) layout.pois.push({ x: shore[0], y: shore[1], kind: 'harbour', name: `${s.name} Harbour` });
    }
  }
  return layout;
}
