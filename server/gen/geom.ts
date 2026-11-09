// Geometry helpers: clipping, smoothing, contouring and raster masks.

export type Pt = [number, number];
export interface Box { minx: number; miny: number; maxx: number; maxy: number }

export function boxPad(b: Box, p: number): Box {
  return { minx: b.minx - p, miny: b.miny - p, maxx: b.maxx + p, maxy: b.maxy + p };
}
export function boxesIntersect(a: Box, b: Box): boolean {
  return a.minx <= b.maxx && a.maxx >= b.minx && a.miny <= b.maxy && a.maxy >= b.miny;
}
export function boxOf(pts: Pt[]): Box {
  let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
  for (const [x, y] of pts) {
    if (x < minx) minx = x;
    if (x > maxx) maxx = x;
    if (y < miny) miny = y;
    if (y > maxy) maxy = y;
  }
  return { minx, miny, maxx, maxy };
}
export function inBox(b: Box, x: number, y: number): boolean {
  return x >= b.minx && x < b.maxx && y >= b.miny && y < b.maxy;
}

/** Clip a polyline to a box; returns the pieces that fall inside. */
export function clipLine(pts: Pt[], b: Box): Pt[][] {
  const out: Pt[][] = [];
  let cur: Pt[] | null = null;
  for (let i = 0; i + 1 < pts.length; i++) {
    const [x0, y0] = pts[i], [x1, y1] = pts[i + 1];
    const dx = x1 - x0, dy = y1 - y0;
    let t0 = 0, t1 = 1, ok = true;
    const p = [-dx, dx, -dy, dy];
    const q = [x0 - b.minx, b.maxx - x0, y0 - b.miny, b.maxy - y0];
    for (let k = 0; k < 4; k++) {
      if (p[k] === 0) {
        if (q[k] < 0) { ok = false; break; }
      } else {
        const r = q[k] / p[k];
        if (p[k] < 0) { if (r > t1) { ok = false; break; } if (r > t0) t0 = r; }
        else { if (r < t0) { ok = false; break; } if (r < t1) t1 = r; }
      }
    }
    if (!ok) { cur = null; continue; }
    const a: Pt = [x0 + dx * t0, y0 + dy * t0];
    const c: Pt = [x0 + dx * t1, y0 + dy * t1];
    if (!cur || t0 > 0) { cur = [a]; out.push(cur); }
    cur.push(c);
    if (t1 < 1) cur = null;
  }
  return out.filter((l) => l.length >= 2);
}

/** Sutherland–Hodgman clip of a simple polygon ring (no closing point) to a box. */
export function clipPoly(ring: Pt[], b: Box): Pt[] {
  let pts = ring;
  const edges: [(p: Pt) => boolean, (a: Pt, c: Pt) => Pt][] = [
    [(p) => p[0] >= b.minx, (a, c) => [b.minx, a[1] + ((c[1] - a[1]) * (b.minx - a[0])) / (c[0] - a[0])]],
    [(p) => p[0] <= b.maxx, (a, c) => [b.maxx, a[1] + ((c[1] - a[1]) * (b.maxx - a[0])) / (c[0] - a[0])]],
    [(p) => p[1] >= b.miny, (a, c) => [a[0] + ((c[0] - a[0]) * (b.miny - a[1])) / (c[1] - a[1]), b.miny]],
    [(p) => p[1] <= b.maxy, (a, c) => [a[0] + ((c[0] - a[0]) * (b.maxy - a[1])) / (c[1] - a[1]), b.maxy]],
  ];
  for (const [inside, cut] of edges) {
    const out: Pt[] = [];
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i], c = pts[(i + 1) % pts.length];
      const ia = inside(a), ic = inside(c);
      if (ia) out.push(a);
      if (ia !== ic) out.push(cut(a, c));
    }
    pts = out;
    if (pts.length < 3) return [];
  }
  return pts;
}

export function chaikin(pts: Pt[], iterations: number): Pt[] {
  let cur = pts;
  for (let it = 0; it < iterations; it++) {
    if (cur.length < 3) break;
    const out: Pt[] = [cur[0]];
    for (let i = 0; i + 1 < cur.length; i++) {
      const [x0, y0] = cur[i], [x1, y1] = cur[i + 1];
      out.push([x0 * 0.75 + x1 * 0.25, y0 * 0.75 + y1 * 0.25]);
      out.push([x0 * 0.25 + x1 * 0.75, y0 * 0.25 + y1 * 0.75]);
    }
    out.push(cur[cur.length - 1]);
    cur = out;
  }
  return cur;
}

/** Douglas–Peucker simplification. */
export function simplify(pts: Pt[], eps: number): Pt[] {
  if (pts.length < 3) return pts;
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack: [number, number][] = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    const [ax, ay] = pts[a], [bx, by] = pts[b];
    const dx = bx - ax, dy = by - ay;
    const len = Math.hypot(dx, dy) || 1;
    let best = -1, bestD = eps;
    for (let i = a + 1; i < b; i++) {
      const d = Math.abs((pts[i][0] - ax) * dy - (pts[i][1] - ay) * dx) / len;
      if (d > bestD) { bestD = d; best = i; }
    }
    if (best >= 0) { keep[best] = 1; stack.push([a, best], [best, b]); }
  }
  return pts.filter((_, i) => keep[i]);
}

export function ringArea(r: Pt[]): number {
  let s = 0;
  for (let i = 0; i < r.length; i++) {
    const [x0, y0] = r[i], [x1, y1] = r[(i + 1) % r.length];
    s += x0 * y1 - x1 * y0;
  }
  return s / 2;
}

export function pointInRing(x: number, y: number, r: Pt[]): boolean {
  let inside = false;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const [xi, yi] = r[i], [xj, yj] = r[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/**
 * Contour a scalar field sampled on an n×n node grid: returns polygons (outer ring plus
 * holes, rings unclosed) covering the area where field > 0. The area is closed off along
 * the grid border, so polygons from neighbouring grids abut exactly.
 */
export function contourPolygons(
  field: Float32Array, n: number, x0: number, y0: number, cell: number,
): Pt[][][] {
  const m = n + 2; // padded with one ring of "outside" nodes collapsed onto the border
  const val = (pi: number, pj: number): number => {
    if (pi === 0 || pj === 0 || pi === m - 1 || pj === m - 1) return -1e9;
    return field[(pj - 1) * n + (pi - 1)];
  };
  const pos = (p: number): number => Math.min(n - 1, Math.max(0, p - 1));
  const next = new Map<number, number>();
  const hKey = (i: number, j: number) => 2 * (j * m + i);
  const vKey = (i: number, j: number) => 2 * (j * m + i) + 1;
  let any = false;
  for (let j = 0; j < m - 1; j++) {
    for (let i = 0; i < m - 1; i++) {
      const c =
        (val(i, j) > 0 ? 1 : 0) | (val(i + 1, j) > 0 ? 2 : 0) |
        (val(i + 1, j + 1) > 0 ? 4 : 0) | (val(i, j + 1) > 0 ? 8 : 0);
      if (c === 0 || c === 15) continue;
      any = true;
      const B = hKey(i, j), R = vKey(i + 1, j), T = hKey(i, j + 1), L = vKey(i, j);
      // Segments are directed with the inside on the left.
      switch (c) {
        case 1: next.set(B, L); break;
        case 2: next.set(R, B); break;
        case 3: next.set(R, L); break;
        case 4: next.set(T, R); break;
        case 5: next.set(B, L); next.set(T, R); break;
        case 6: next.set(T, B); break;
        case 7: next.set(T, L); break;
        case 8: next.set(L, T); break;
        case 9: next.set(B, T); break;
        case 10: next.set(R, B); next.set(L, T); break;
        case 11: next.set(R, T); break;
        case 12: next.set(L, R); break;
        case 13: next.set(B, R); break;
        case 14: next.set(L, B); break;
      }
    }
  }
  if (!any) return [];
  const point = (key: number): Pt => {
    const vertical = key & 1;
    const idx = key >> 1;
    const i = idx % m, j = (idx - i) / m;
    const i2 = vertical ? i : i + 1, j2 = vertical ? j + 1 : j;
    const a = val(i, j), b = val(i2, j2);
    const xa = pos(i), ya = pos(j), xb = pos(i2), yb = pos(j2);
    let t = 0.5;
    if (xa !== xb || ya !== yb) t = Math.min(1, Math.max(0, a / (a - b)));
    return [x0 + (xa + (xb - xa) * t) * cell, y0 + (ya + (yb - ya) * t) * cell];
  };
  const rings: Pt[][] = [];
  const done = new Set<number>();
  for (const start of next.keys()) {
    if (done.has(start)) continue;
    const ring: Pt[] = [];
    let k = start;
    let guard = 0;
    while (!done.has(k) && guard++ < 1e6) {
      done.add(k);
      const p = point(k);
      const last = ring[ring.length - 1];
      if (!last || Math.abs(last[0] - p[0]) > 1e-6 || Math.abs(last[1] - p[1]) > 1e-6) ring.push(p);
      const nx = next.get(k);
      if (nx === undefined) break;
      k = nx;
    }
    if (ring.length >= 3) rings.push(ring);
  }
  const outers: { ring: Pt[]; holes: Pt[][]; area: number }[] = [];
  const holes: Pt[][] = [];
  for (const r of rings) {
    const a = ringArea(r);
    if (Math.abs(a) < 1) continue;
    if (a > 0) outers.push({ ring: r, holes: [], area: a });
    else holes.push(r);
  }
  outers.sort((a, b) => a.area - b.area);
  for (const h of holes) {
    const [hx, hy] = h[0];
    // Smallest containing outer ring owns the hole.
    const owner = outers.find((o) => pointInRing(hx, hy, o.ring));
    if (owner) owner.holes.push(h);
  }
  return outers.map((o) => [o.ring, ...o.holes]);
}

/** Coarse raster mask over a box, used for "is this spot water / road" tests. */
export class Mask {
  x0: number; y0: number; cell: number; w: number; h: number; data: Uint8Array;
  constructor(b: Box, cell: number) {
    this.x0 = b.minx; this.y0 = b.miny; this.cell = cell;
    this.w = Math.ceil((b.maxx - b.minx) / cell) + 1;
    this.h = Math.ceil((b.maxy - b.miny) / cell) + 1;
    this.data = new Uint8Array(this.w * this.h);
  }
  get(x: number, y: number): number {
    const i = Math.round((x - this.x0) / this.cell), j = Math.round((y - this.y0) / this.cell);
    if (i < 0 || j < 0 || i >= this.w || j >= this.h) return 0;
    return this.data[j * this.w + i];
  }
  /** Mark every cell within `radius` of the polyline (keeps the larger value). */
  stampLine(pts: Pt[], radius: number, value: number): void {
    const r2 = radius * radius;
    for (let s = 0; s + 1 < pts.length; s++) {
      const [ax, ay] = pts[s], [bx, by] = pts[s + 1];
      const i0 = Math.max(0, Math.floor((Math.min(ax, bx) - radius - this.x0) / this.cell));
      const i1 = Math.min(this.w - 1, Math.ceil((Math.max(ax, bx) + radius - this.x0) / this.cell));
      const j0 = Math.max(0, Math.floor((Math.min(ay, by) - radius - this.y0) / this.cell));
      const j1 = Math.min(this.h - 1, Math.ceil((Math.max(ay, by) + radius - this.y0) / this.cell));
      const dx = bx - ax, dy = by - ay;
      const l2 = dx * dx + dy * dy || 1;
      for (let j = j0; j <= j1; j++) {
        const py = this.y0 + j * this.cell;
        for (let i = i0; i <= i1; i++) {
          const px = this.x0 + i * this.cell;
          let t = ((px - ax) * dx + (py - ay) * dy) / l2;
          t = t < 0 ? 0 : t > 1 ? 1 : t;
          const ex = ax + dx * t - px, ey = ay + dy * t - py;
          if (ex * ex + ey * ey <= r2) {
            const k = j * this.w + i;
            if (this.data[k] < value) this.data[k] = value;
          }
        }
      }
    }
  }
  stampPoly(ring: Pt[], value: number): void {
    const b = boxOf(ring);
    const i0 = Math.max(0, Math.floor((b.minx - this.x0) / this.cell));
    const i1 = Math.min(this.w - 1, Math.ceil((b.maxx - this.x0) / this.cell));
    const j0 = Math.max(0, Math.floor((b.miny - this.y0) / this.cell));
    const j1 = Math.min(this.h - 1, Math.ceil((b.maxy - this.y0) / this.cell));
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        if (pointInRing(this.x0 + i * this.cell, this.y0 + j * this.cell, ring)) {
          const k = j * this.w + i;
          if (this.data[k] < value) this.data[k] = value;
        }
      }
    }
  }
}

/**
 * Contour lines of a field sampled on an n×n node grid at the given level. Lines are
 * open where they leave the grid, and meet the lines of neighbouring grids exactly.
 */
export function contourLines(
  field: Float32Array, n: number, x0: number, y0: number, cell: number, level: number,
): Pt[][] {
  const next = new Map<number, number>();
  const hKey = (i: number, j: number) => 2 * (j * n + i);
  const vKey = (i: number, j: number) => 2 * (j * n + i) + 1;
  for (let j = 0; j < n - 1; j++) {
    for (let i = 0; i < n - 1; i++) {
      const c =
        (field[j * n + i] > level ? 1 : 0) | (field[j * n + i + 1] > level ? 2 : 0) |
        (field[(j + 1) * n + i + 1] > level ? 4 : 0) | (field[(j + 1) * n + i] > level ? 8 : 0);
      if (c === 0 || c === 15) continue;
      const B = hKey(i, j), R = vKey(i + 1, j), T = hKey(i, j + 1), L = vKey(i, j);
      switch (c) {
        case 1: next.set(B, L); break;
        case 2: next.set(R, B); break;
        case 3: next.set(R, L); break;
        case 4: next.set(T, R); break;
        case 5: next.set(B, L); next.set(T, R); break;
        case 6: next.set(T, B); break;
        case 7: next.set(T, L); break;
        case 8: next.set(L, T); break;
        case 9: next.set(B, T); break;
        case 10: next.set(R, B); next.set(L, T); break;
        case 11: next.set(R, T); break;
        case 12: next.set(L, R); break;
        case 13: next.set(B, R); break;
        case 14: next.set(L, B); break;
      }
    }
  }
  if (!next.size) return [];
  const point = (key: number): Pt => {
    const vertical = key & 1;
    const idx = key >> 1;
    const i = idx % n, j = (idx - i) / n;
    const i2 = vertical ? i : i + 1, j2 = vertical ? j + 1 : j;
    const a = field[j * n + i] - level, b = field[j2 * n + i2] - level;
    const t = Math.min(1, Math.max(0, a / (a - b)));
    return [x0 + (i + (i2 - i) * t) * cell, y0 + (j + (j2 - j) * t) * cell];
  };
  const entered = new Set(next.values());
  const done = new Set<number>();
  const lines: Pt[][] = [];
  const trace = (start: number) => {
    const line: Pt[] = [];
    let k: number | undefined = start;
    while (k !== undefined && !done.has(k)) {
      done.add(k);
      line.push(point(k));
      k = next.get(k);
    }
    if (k !== undefined) line.push(point(k)); // end of an open line, or closing a loop
    if (line.length >= 2) lines.push(line);
  };
  for (const k of next.keys()) if (!entered.has(k)) trace(k);   // open lines first
  for (const k of next.keys()) if (!done.has(k)) trace(k);      // then closed loops
  return lines;
}

/** Binary min-heap of (priority, value) pairs. */
export class Heap {
  private f: number[] = [];
  private n: number[] = [];
  get size(): number { return this.f.length; }
  push(f: number, n: number): void {
    let i = this.f.length;
    this.f.push(f); this.n.push(n);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.f[p] <= f) break;
      this.f[i] = this.f[p]; this.n[i] = this.n[p]; i = p;
    }
    this.f[i] = f; this.n[i] = n;
  }
  pop(): number {
    const top = this.n[0];
    const f = this.f.pop()!, n = this.n.pop()!;
    const len = this.f.length;
    if (len) {
      let i = 0;
      for (;;) {
        let c = 2 * i + 1;
        if (c >= len) break;
        if (c + 1 < len && this.f[c + 1] < this.f[c]) c++;
        if (this.f[c] >= f) break;
        this.f[i] = this.f[c]; this.n[i] = this.n[c]; i = c;
      }
      this.f[i] = f; this.n[i] = n;
    }
    return top;
  }
}

/** Points where polyline a crosses polyline b, with a's unit direction at each crossing. */
export function crossings(a: Pt[], b: Pt[]): { x: number; y: number; dx: number; dy: number }[] {
  const out: { x: number; y: number; dx: number; dy: number }[] = [];
  for (let i = 0; i + 1 < a.length; i++) {
    const [ax, ay] = a[i], [bx, by] = a[i + 1];
    const rx = bx - ax, ry = by - ay;
    const minx = Math.min(ax, bx), maxx = Math.max(ax, bx), miny = Math.min(ay, by), maxy = Math.max(ay, by);
    for (let j = 0; j + 1 < b.length; j++) {
      const [cx, cy] = b[j], [dx, dy] = b[j + 1];
      if (Math.max(cx, dx) < minx || Math.min(cx, dx) > maxx || Math.max(cy, dy) < miny || Math.min(cy, dy) > maxy) continue;
      const sx = dx - cx, sy = dy - cy;
      const den = rx * sy - ry * sx;
      if (den === 0) continue;
      const t = ((cx - ax) * sy - (cy - ay) * sx) / den;
      const u = ((cx - ax) * ry - (cy - ay) * rx) / den;
      if (t < 0 || t >= 1 || u < 0 || u >= 1) continue;
      const l = Math.hypot(rx, ry) || 1;
      out.push({ x: ax + rx * t, y: ay + ry * t, dx: rx / l, dy: ry / l });
    }
  }
  return out;
}

/** Closest point on a polyline to (x, y). */
export function nearestOnLine(x: number, y: number, pts: Pt[]): { x: number; y: number; d: number } {
  let best = { x: pts[0][0], y: pts[0][1], d: Infinity };
  for (let i = 0; i + 1 < pts.length; i++) {
    const [ax, ay] = pts[i], [bx, by] = pts[i + 1];
    const dx = bx - ax, dy = by - ay;
    let t = ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy || 1);
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const px = ax + dx * t, py = ay + dy * t;
    const d = Math.hypot(px - x, py - y);
    if (d < best.d) best = { x: px, y: py, d };
  }
  return best;
}

export function lineLength(pts: Pt[]): number {
  let l = 0;
  for (let i = 0; i + 1 < pts.length; i++) l += Math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]);
  return l;
}
