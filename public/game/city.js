// Buildings on the map as 3D models, drawn with three.js inside the map's own 3D scene.
//
// Two map layers share one renderer. The first draws every building the world generator put in
// a town or on a farm: houses, terraces, shops, offices, sheds, barns, churches, schools, town
// halls and hospitals, each put together in code from its footprint, height and kind. The second
// draws what the game builds on a town's parcels: infantry bases and vehicle factories in their
// owner's colour.
//
// Buildings are gathered from the map's vector tiles as they load, grouped into squares of ground
// and merged into one mesh per square, so a city is a handful of draw calls. Everything is measured
// in metres from an origin near the map, with x east, y north and z up.

import * as THREE from '/vendor/three.module.js';

const R = 6378137, DEG = 180 / Math.PI, AROUND = 2 * Math.PI * R;
const CELL = 400;             // metres to a side of each merged square of buildings
const FROM_ZOOM = 13.4;       // buildings appear from this zoom

const toMetres = (lng, lat) => [(lng / DEG) * R, R * Math.log(Math.tan(Math.PI / 4 + lat / DEG / 2))];
const toLngLat = (x, y) => [(x / R) * DEG, (2 * Math.atan(Math.exp(y / R)) - Math.PI / 2) * DEG];

/** A repeatable random number source from a string, so a building looks the same every time it is drawn. */
function random(key) {
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) { h ^= key.charCodeAt(i); h = Math.imul(h, 16777619); }
  return () => { h ^= h << 13; h ^= h >>> 17; h ^= h << 5; return ((h >>> 0) % 100000) / 100000; };
}
const pick = (r, list) => list[Math.floor(r() * list.length) % list.length];

const linear = new Map();
/** A colour as three numbers in the renderer's working space; `shade` darkens (below 1) or lightens it. */
function rgb(hex, shade = 1) {
  let c = linear.get(hex);
  if (!c) { c = new THREE.Color(hex); linear.set(hex, c); }
  return [c.r * shade, c.g * shade, c.b * shade];
}
const tint = (a, b, f) => { const p = rgb(a), q = rgb(b); return [p[0] + (q[0] - p[0]) * f, p[1] + (q[1] - p[1]) * f, p[2] + (q[2] - p[2]) * f]; };

// ----- Putting shapes together -----

/** Collects triangles. Shapes are given in a building's own frame: u along its width, v along its depth, z up. */
class Shapes {
  constructor() { this.pos = []; this.nor = []; this.col = []; this.frames = []; this.set(0, 0, 0, 0); }
  /** Stand at (x, y, z) facing `angle`: everything added afterwards is measured from here. */
  set(x, y, z, angle) { this.x = x; this.y = y; this.z = z; this.cos = Math.cos(angle); this.sin = Math.sin(angle); this.angle = angle; }
  /** Do `fn` in a frame moved to (u, v) and turned by `turn` within the current one. */
  at(u, v, turn, fn) {
    const keep = [this.x, this.y, this.z, this.angle];
    this.set(this.x + u * this.cos - v * this.sin, this.y + u * this.sin + v * this.cos, this.z, this.angle + turn);
    fn();
    this.set(...keep);
  }
  tri(a, b, c, color) {
    const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], e2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    let nu = e1[1] * e2[2] - e1[2] * e2[1], nv = e1[2] * e2[0] - e1[0] * e2[2], nz = e1[0] * e2[1] - e1[1] * e2[0];
    const len = Math.hypot(nu, nv, nz) || 1;
    nu /= len; nv /= len; nz /= len;
    const nx = nu * this.cos - nv * this.sin, ny = nu * this.sin + nv * this.cos;
    for (const p of [a, b, c]) {
      this.pos.push(this.x + p[0] * this.cos - p[1] * this.sin, this.y + p[0] * this.sin + p[1] * this.cos, this.z + p[2]);
      this.nor.push(nx, ny, nz);
      this.col.push(color[0], color[1], color[2]);
    }
  }
  quad(a, b, c, d, color) { this.tri(a, b, c, color); this.tri(a, c, d, color); }
  /** A box; `top` false leaves it open for a roof to sit on. */
  box(u0, v0, u1, v1, z0, z1, color, top = true) {
    this.quad([u0, v0, z0], [u1, v0, z0], [u1, v0, z1], [u0, v0, z1], color);
    this.quad([u1, v0, z0], [u1, v1, z0], [u1, v1, z1], [u1, v0, z1], color);
    this.quad([u1, v1, z0], [u0, v1, z0], [u0, v1, z1], [u1, v1, z1], color);
    this.quad([u0, v1, z0], [u0, v0, z0], [u0, v0, z1], [u0, v1, z1], color);
    if (top) this.quad([u0, v0, z1], [u1, v0, z1], [u1, v1, z1], [u0, v1, z1], color);
  }
  /** A pitched roof with its ridge along u, over walls that reach `eave`; the gable ends are filled in the wall's colour. */
  gable(u0, v0, u1, v1, eave, ridge, roof, wall, over = 0.45) {
    const vm = (v0 + v1) / 2, drop = over * (ridge - eave) / ((v1 - v0) / 2), low = eave - drop;
    this.quad([u0 - over, v0 - over, low], [u1 + over, v0 - over, low], [u1 + over, vm, ridge], [u0 - over, vm, ridge], roof);
    this.quad([u1 + over, v1 + over, low], [u0 - over, v1 + over, low], [u0 - over, vm, ridge], [u1 + over, vm, ridge], roof);
    this.tri([u1, v0, eave], [u1, v1, eave], [u1, vm, ridge], wall);
    this.tri([u0, v1, eave], [u0, v0, eave], [u0, vm, ridge], wall);
  }
  /** A hipped roof: slopes on all four sides, the ridge along u and `inset` shorter at each end. A full inset makes a pyramid. */
  hip(u0, v0, u1, v1, eave, ridge, roof, inset = (v1 - v0) / 2, over = 0.4) {
    const vm = (v0 + v1) / 2, i = Math.min(inset, (u1 - u0) / 2);
    const a = [u0 - over, v0 - over, eave], b = [u1 + over, v0 - over, eave], c = [u1 + over, v1 + over, eave], d = [u0 - over, v1 + over, eave];
    const r0 = [u0 + i, vm, ridge], r1 = [u1 - i, vm, ridge];
    this.quad(a, b, r1, r0, roof);
    this.tri(b, c, r1, roof);
    this.quad(c, d, r0, r1, roof);
    this.tri(d, a, r0, roof);
  }
  /** One bay of a saw-tooth roof: a slope rising from u0 to a wall of glass at u1. */
  tooth(u0, v0, u1, v1, z0, z1, roof, glass, wall) {
    this.quad([u0, v0, z0], [u1, v0, z1], [u1, v1, z1], [u0, v1, z0], roof);
    this.quad([u1, v0, z0], [u1, v1, z0], [u1, v1, z1], [u1, v0, z1], glass);
    this.tri([u0, v0, z0], [u1, v0, z0], [u1, v0, z1], wall);
    this.tri([u1, v1, z0], [u0, v1, z0], [u1, v1, z1], wall);
  }
  /** A round tower, tank or chimney of `n` sides, r0 across at the bottom and r1 at the top (0 for a cone). */
  round(uc, vc, r0, r1, z0, z1, color, n = 10) {
    for (let k = 0; k < n; k++) {
      const a0 = (k / n) * 2 * Math.PI, a1 = ((k + 1) / n) * 2 * Math.PI, shade = 0.86 + 0.14 * Math.cos(a0 - 2.2);
      const c = [color[0] * shade, color[1] * shade, color[2] * shade];
      const p = (a, r, z) => [uc + Math.cos(a) * r, vc + Math.sin(a) * r, z];
      if (r1 > 0) this.quad(p(a0, r0, z0), p(a1, r0, z0), p(a1, r1, z1), p(a0, r1, z1), c);
      else this.tri(p(a0, r0, z0), p(a1, r0, z0), [uc, vc, z1], c);
      if (r1 > 0) this.tri([uc, vc, z1], p(a0, r1, z1), p(a1, r1, z1), color);
    }
  }
  /**
   * A flat panel on one wall of the box from (u0, v0) to (u1, v1): a window, a door or a sign.
   * `face` is 0 for the wall at v0, then round anticlockwise; `s` is how far along that wall it starts, seen from outside.
   */
  panel(rect, face, s, z, w, h, color, out = 0.06) {
    const [u0, v0, u1, v1] = rect;
    const [o, right, n] = [[[u0, v0], [1, 0], [0, -1]], [[u1, v0], [0, 1], [1, 0]], [[u1, v1], [-1, 0], [0, 1]], [[u0, v1], [0, -1], [-1, 0]]][face];
    const p = (along, up) => [o[0] + right[0] * along + n[0] * out, o[1] + right[1] * along + n[1] * out, up];
    this.quad(p(s, z), p(s + w, z), p(s + w, z + h), p(s, z + h), color);
  }
  /** A row of evenly spaced panels along one wall, keeping `edge` clear at each end. */
  row(rect, face, z, w, h, gap, color, edge = 0.9) {
    const long = face % 2 ? rect[3] - rect[1] : rect[2] - rect[0], n = Math.floor((long - 2 * edge + gap) / (w + gap));
    if (n < 1) return;
    const start = (long - (n * w + (n - 1) * gap)) / 2;
    for (let i = 0; i < n; i++) this.panel(rect, face, start + i * (w + gap), z, w, h, color);
  }
  /** Rows of windows on every storey of the chosen walls. */
  windows(rect, faces, z0, storeys, storey, color, w = 1.1, gap = 1.5) {
    for (let f = 0; f < storeys; f++) for (const face of faces) this.row(rect, face, z0 + f * storey + storey * 0.32, w, storey * 0.42, gap, color);
  }
  geometry() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    return g;
  }
}

// ----- The town's own buildings -----

const WALLS = ['#efe6d2', '#e6dcc6', '#f4efe4', '#d9c2a0', '#c9a27e', '#b9785c', '#d8d2c4', '#e9d9b0'];
const ROOFS = ['#a6503a', '#8f4533', '#b8623f', '#6a5a52', '#5b6470', '#7a4a3a', '#4f5863'];
const GLASS = '#3d4f63', DOOR = '#4a3626', STONE = '#cfc8b8', CONCRETE = '#b9bcc0';

/** Add the model of one generated building to `s`. It is `w` wide, `d` deep and about `h` tall, centred where `s` stands. */
function model(s, b) {
  const r = random(b.key), w = b.w, d = b.d, h = Math.max(4, b.h);
  const rect = [-w / 2, -d / 2, w / 2, d / 2], glass = rgb(GLASS), lit = rgb('#56708c');
  /** Does `fn` with u along the building's longer side; `fn` gets the length and breadth. */
  const along = (fn) => (w >= d ? fn(w, d) : s.at(0, 0, Math.PI / 2, () => fn(d, w)));
  const kind = b.kind;

  if (kind === 'church') {
    return along((l, br) => {
      const wall = rgb(pick(r, ['#d9d3c4', '#cfc6b2', '#c4b9a6'])), roof = rgb(pick(r, ['#5d6b7a', '#6a5a52', '#4f5863']));
      const eave = h * 0.55, nave = [-l / 2 + br * 0.5, -br * 0.36, l / 2, br * 0.36];
      s.box(...nave, 0, eave, wall, false);
      s.gable(...nave, eave, eave + br * 0.42, roof, wall);
      for (const face of [0, 2]) s.row(nave, face, eave * 0.3, 0.9, eave * 0.5, 2.2, glass, 1.5);
      // The tower stands at one end, with a spire.
      const t = Math.min(br * 0.36, 4.2), tower = [-l / 2, -t, -l / 2 + 2 * t, t], top = h * 1.15;
      s.box(...tower, 0, top, wall);
      s.panel(tower, 3, t - 0.8, 0, 1.6, 2.6, rgb(DOOR));
      for (let f = 0; f < 4; f++) s.panel(tower, f, t - 0.5, top * 0.72, 1, 2, glass);
      s.hip(...tower, top, top + t * 2.6, roof, t, 0.2);
    });
  }
  if (kind === 'townhall') {
    return along((l, br) => {
      const wall = rgb(pick(r, ['#d6c8a8', '#cdbd9c', '#dccfb4'])), roof = rgb('#5b6470'), eave = h * 0.7, body = [-l / 2, -br / 2, l / 2, br / 2];
      s.box(...body, 0, eave, wall, false);
      s.hip(...body, eave, eave + br * 0.22, roof, br * 0.5);
      s.windows(body, [0, 1, 2, 3], 0, Math.max(2, Math.round(eave / 3.4)), eave / Math.max(2, Math.round(eave / 3.4)), glass, 1.2, 1.6);
      // A porch of columns in front and a clock tower over the middle.
      const porch = Math.min(l * 0.3, 7);
      s.box(-porch, -br / 2 - 2.2, porch, -br / 2, 0, 0.5, rgb(STONE));
      for (let i = 0; i < 4; i++) s.round(-porch + 0.6 + (i * (2 * porch - 1.2)) / 3, -br / 2 - 1.7, 0.36, 0.36, 0.5, eave * 0.72, rgb('#ece6d8'), 8);
      s.box(-porch, -br / 2 - 2.2, porch, -br / 2, eave * 0.72, eave * 0.86, rgb(STONE));
      const t = Math.min(br * 0.2, 2.6), top = eave + br * 0.22 + 5;
      s.box(-t, -t, t, t, eave, top, wall);
      for (let f = 0; f < 4; f++) s.panel([-t, -t, t, t], f, t - 0.7, top - 2.2, 1.4, 1.4, rgb('#f4efe2'));
      s.hip(-t, -t, t, t, top, top + t * 1.8, roof, t, 0.25);
    });
  }
  if (kind === 'school' || kind === 'hospital') {
    return along((l, br) => {
      const school = kind === 'school', wall = rgb(school ? pick(r, ['#c9895f', '#d4a070', '#cfb48a']) : '#eef0f1'), roof = rgb(school ? '#7a4a3a' : '#9aa3ac');
      const storeys = Math.max(2, Math.round(h / 3.4)), storey = h / storeys, wing = br * 0.42;
      // A long front block with a wing at each end.
      const front = [-l / 2, -br / 2, l / 2, -br / 2 + wing], parts = [front, [-l / 2, -br / 2 + wing, -l / 2 + wing, br / 2], [l / 2 - wing, -br / 2 + wing, l / 2, br / 2]];
      for (const p of parts) {
        s.box(...p, 0, h, wall, !school);
        s.windows(p, [0, 1, 2, 3], 0, storeys, storey, glass, 1.3, 1.2);
        if (school) s.hip(...p, h, h + 2.4, roof, Math.min(p[3] - p[1], p[2] - p[0]) / 2);
        else s.box(p[0] + 0.5, p[1] + 0.5, p[2] - 0.5, p[3] - 0.5, h, h + 0.25, roof);
      }
      s.panel(front, 0, l / 2 - 1.3, 0, 2.6, 2.7, rgb(DOOR));
      if (!school) {
        // A red cross on the roof and over the door.
        const red = rgb('#c8372d'), z = h + 0.3, a = Math.min(wing * 0.3, 2.4);
        s.quad([-a, -br / 2 + wing / 2 - a / 3, z], [a, -br / 2 + wing / 2 - a / 3, z], [a, -br / 2 + wing / 2 + a / 3, z], [-a, -br / 2 + wing / 2 + a / 3, z], red);
        s.quad([-a / 3, -br / 2 + wing / 2 - a, z + 0.01], [a / 3, -br / 2 + wing / 2 - a, z + 0.01], [a / 3, -br / 2 + wing / 2 + a, z + 0.01], [-a / 3, -br / 2 + wing / 2 + a, z + 0.01], red);
        s.panel(front, 0, l / 2 - 0.9, 3.1, 1.8, 0.6, red, 0.1);
        s.panel(front, 0, l / 2 - 0.3, 2.5, 0.6, 1.8, red, 0.11);
      }
    });
  }
  if (kind === 'industrial') {
    return along((l, br) => {
      const wall = rgb(pick(r, ['#aab2ba', '#b7b0a4', '#9aa5ae', '#c2b8a3'])), roof = rgb(pick(r, ['#6c7783', '#7d8790', '#8a6a55'])), eave = h * 0.72, body = [-l / 2, -br / 2, l / 2, br / 2];
      s.box(...body, 0, eave, wall, false);
      if (r() < 0.45 && l > 16) {
        // Saw-tooth bays across the shed.
        const bays = Math.max(2, Math.round(l / 8)), step = l / bays;
        for (let i = 0; i < bays; i++) s.tooth(-l / 2 + i * step, -br / 2, -l / 2 + (i + 1) * step, br / 2, eave, eave + step * 0.42, roof, rgb('#a9cfe0'), wall);
      } else s.gable(...body, eave, eave + br * 0.18, roof, wall, 0.3);
      // A roller door, a strip of high windows and sometimes a stack.
      s.panel(body, 1, br / 2 - 2, 0, 4, Math.min(4.2, eave - 0.6), rgb('#59626b'));
      for (const face of [0, 2]) s.row(body, face, eave - 1.6, 1.8, 0.8, 1.2, lit, 1.4);
      if (r() < 0.4) s.round(l / 2 - 2.4, br / 2 - 2.4, 0.8, 0.6, eave, h * 1.9, rgb('#8a4b3c'), 8);
    });
  }
  if (kind === 'farm') {
    return along((l, br) => {
      const barn = r() < 0.55, wall = rgb(barn ? pick(r, ['#9c4634', '#8a4a34', '#6f5a48']) : pick(r, ['#e9e2cf', '#d8ccb4'])), roof = rgb(barn ? '#4b4640' : pick(r, ROOFS));
      const eave = barn ? 3.6 : 2.9, body = [-l / 2, -br / 2, l / 2, br / 2];
      s.box(...body, 0, eave, wall, false);
      s.gable(...body, eave, eave + br * (barn ? 0.46 : 0.38), roof, wall);
      if (barn) { s.panel(body, 1, br / 2 - 1.7, 0, 3.4, 3.1, rgb('#e8e0cf')); s.panel(body, 1, br / 2 - 1.5, 0, 3, 2.9, rgb('#5a3526'), 0.08); }
      else { s.panel(body, 0, l / 2 - 0.5, 0, 1, 2.1, rgb(DOOR)); s.row(body, 0, 1.1, 1, 1.1, 2.6, glass, 1.2); s.row(body, 2, 1.1, 1, 1.1, 2.2, glass, 1.2); s.box(l / 4, -0.4, l / 4 + 0.8, 0.4, eave, eave + br * 0.38 + 0.9, rgb('#8a5a48')); }
    });
  }
  if (kind === 'commercial') {
    return along((l, br) => {
      const storeys = Math.max(1, Math.round(h / 3.3)), body = [-l / 2, -br / 2, l / 2, br / 2];
      if (storeys >= 5) {
        const storey = h / storeys, style = r(), faces = [0, 1, 2, 3], span = (face) => (face % 2 ? br : l);
        const plant = () => { s.box(-l * 0.2 + r() * l * 0.1, -br * 0.2, l * 0.1 + r() * l * 0.1, br * 0.12, h, h + 1.8 + r() * 1.4, rgb('#8d949b')); if (r() < 0.5) s.round(l * 0.3, br * 0.28, 1, 1, h, h + 1.6, rgb('#a7aeb5'), 8); };
        if (style < 0.36) {
          // An older block in stone or brick: rows of tall windows, shops at street level and a cornice, some under a slate roof.
          const wall = rgb(pick(r, ['#d9c9a6', '#c9a27e', '#b9785c', '#e3d8c2', '#a8644c', '#cfc4b0'])), trim = rgb(pick(r, ['#efe8d8', '#d8d0c0', '#bfb5a2']));
          s.box(...body, 0, h, wall);
          for (const face of faces) { s.panel(body, face, 0.5, 0.3, span(face) - 1, storey * 0.7, rgb('#2f3d4d')); s.panel(body, face, 0, storey * 0.86, span(face), 0.4, trim, 0.25); }
          s.windows(body, faces, storey, storeys - 1, storey, glass, 1.1, 1.1);
          s.box(-l / 2 - 0.5, -br / 2 - 0.5, l / 2 + 0.5, br / 2 + 0.5, h, h + 0.6, trim);
          if (r() < 0.5) s.hip(-l / 2 + 0.6, -br / 2 + 0.6, l / 2 - 0.6, br / 2 - 0.6, h + 0.6, h + 0.6 + Math.min(4, br * 0.22), rgb(pick(r, ['#4f5863', '#5b6470', '#6a5a52', '#3f6a5a'])), br * 0.5, 0);
          else plant();
        } else if (style < 0.72) {
          // A modern block: bands of glass between floors, and plant on the roof.
          const wall = rgb(pick(r, ['#e4e6e8', '#d6d0c4', '#b5bcc4', '#cbbfae', '#8f979f', '#ece4d4'])), band = rgb(pick(r, ['#3d4f63', '#35556a', '#4a5a52', '#5a4a3c']));
          s.box(...body, 0, h, wall);
          for (let f = 1; f < storeys; f++) for (const face of faces) s.panel(body, face, 0.5, f * storey + storey * 0.25, span(face) - 1, storey * 0.5, f % 3 ? band : lit);
          for (const face of faces) s.panel(body, face, 0.5, 0.3, span(face) - 1, storey * 0.72, rgb('#2f3d4d'));
          s.box(-l / 2 + 0.4, -br / 2 + 0.4, l / 2 - 0.4, br / 2 - 0.4, h, h + 0.5, rgb(CONCRETE, 0.85));
          plant();
        } else {
          // A glass tower: a curtain wall with a line at every floor, stepping in for its top floors.
          const sheet = rgb(pick(r, ['#5f8fa8', '#4f7f8f', '#6a8fb0', '#587a72', '#7a94a8'])), line = rgb('#dfe6ea'), cut = h - storey * Math.min(3, Math.floor(storeys / 3)), inset = Math.min(l, br) * 0.14;
          const top = [-l / 2 + inset, -br / 2 + inset, l / 2 - inset, br / 2 - inset];
          s.box(...body, 0, cut, sheet);
          s.box(...top, cut, h, sheet);
          for (let f = 1; f * storey < h - 0.5; f++) for (const face of faces) { const part = f * storey < cut ? body : top; s.panel(part, face, 0, f * storey, face % 2 ? part[3] - part[1] : part[2] - part[0], 0.22, line); }
          for (const face of faces) s.panel(body, face, 0.6, 0, span(face) - 1.2, storey * 0.9, rgb('#27343f'));
          s.box(top[0] + 0.5, top[1] + 0.5, top[2] - 0.5, top[3] - 0.5, h, h + 0.4, rgb('#aab2ba'));
          if (r() < 0.4) s.round(0, 0, 0.25, 0.1, h, h + 9, rgb('#d8dde2'), 6);
        }
        return;
      }
      // A shop with rooms over it: a glazed front under an awning, and a parapet round a flat roof.
      const wall = rgb(pick(r, WALLS)), storey = h / storeys, awning = rgb(pick(r, ['#b5483a', '#3f6f8f', '#3f7a55', '#c79a3a', '#7a4a6a']));
      s.box(...body, 0, h, wall);
      s.box(-l / 2 + 0.35, -br / 2 + 0.35, l / 2 - 0.35, br / 2 - 0.35, h - 0.4, h - 0.39, rgb('#6f6a63'));
      for (const face of [0, 2]) {
        const long = l;
        s.panel(body, face, 0.6, 0.35, long - 1.2, storey * 0.62, rgb('#2f3d4d'));
        s.panel(body, face, 0.4, storey * 0.74, long - 0.8, 0.5, awning, 0.5);
      }
      if (storeys > 1) s.windows(body, [0, 1, 2, 3], storey, storeys - 1, storey, glass, 1.1, 1.3);
      if (r() < 0.5) s.box(l * 0.1, -br * 0.15, l * 0.1 + 1.6, -br * 0.15 + 1.2, h, h + 0.9, rgb('#8d949b'));
    });
  }
  // Houses. Low ones are cottages under a pitched or hipped roof; taller ones are terraces of several floors.
  return along((l, br) => {
    const wall = rgb(pick(r, WALLS)), roof = rgb(pick(r, ROOFS)), body = [-l / 2, -br / 2, l / 2, br / 2];
    const storeys = h < 7.5 ? (h < 5.5 ? 1 : 2) : Math.max(3, Math.round(h / 3.2)), storey = h < 7.5 ? 2.7 : (h * 0.82) / storeys, eave = storeys * storey;
    s.box(...body, 0, eave, wall, false);
    const rise = Math.min(br * 0.42, storeys > 2 ? 2.6 : 3.4);
    if (r() < 0.3) s.hip(...body, eave, eave + rise, roof, br * 0.5);
    else s.gable(...body, eave, eave + rise, roof, wall);
    s.windows(body, [0, 2], 0, storeys, storey, glass, 1, storeys > 2 ? 1.3 : 1.9);
    if (storeys > 2) s.windows(body, [1, 3], 0, storeys, storey, glass, 1, 1.6);
    const door = r() < 0.5 ? 0 : 2;
    s.panel(body, door, l * (0.25 + 0.5 * r()) - 0.5, 0, 1, 2.05, rgb(pick(r, [DOOR, '#2f4a3a', '#6a2f2a', '#2f3d5a'])), 0.09);
    // A chimney through the ridge, and sometimes a lean-to at the back.
    const cu = (r() - 0.5) * l * 0.5;
    s.box(cu - 0.4, -0.35, cu + 0.4, 0.35, eave, eave + rise + 0.9, rgb('#8a5a48'));
    if (storeys < 3 && r() < 0.3 && l > 7) { s.box(-l / 4, br / 2, l / 4, br / 2 + 2.2, 0, 2.3, wall, false); s.quad([-l / 4, br / 2 + 2.4, 2.2], [-l / 4, br / 2, 2.9], [l / 4, br / 2, 2.9], [l / 4, br / 2 + 2.4, 2.2], roof); }
  });
}

// ----- What the game builds -----

/**
 * The frame a parcel gives its building: where its middle is, which way its longer side runs, and how far the
 * building may reach each way. The building keeps to the middle of the parcel, whatever the parcel's shape.
 */
function parcel(ring) {
  let ux = 1, uy = 0, longest = 0;
  ring.forEach(([x, y], i) => { const [nx, ny] = ring[(i + 1) % ring.length], len = Math.hypot(nx - x, ny - y); if (len > longest) { longest = len; ux = (nx - x) / len; uy = (ny - y) / len; } });
  const us = ring.map(([x, y]) => x * ux + y * uy), vs = ring.map(([x, y]) => -x * uy + y * ux);
  const cu = (Math.min(...us) + Math.max(...us)) / 2, cv = (Math.min(...vs) + Math.max(...vs)) / 2;
  return { x: cu * ux - cv * uy, y: cu * uy + cv * ux, angle: Math.atan2(uy, ux),
    hu: Math.min(46, (Math.max(...us) - Math.min(...us)) * 0.38), hv: Math.min(32, (Math.max(...vs) - Math.min(...vs)) * 0.38) };
}

/** Timber scaffolding round the box from (u0, v0) to (u1, v1), up to `top`. */
function scaffold(s, u0, v0, u1, v1, top) {
  const wood = rgb('#8a6f4a'), t = 0.14;
  const posts = (a0, b0, a1, b1) => { const n = Math.max(2, Math.round(Math.hypot(a1 - a0, b1 - b0) / 4)); for (let i = 0; i <= n; i++) { const a = a0 + ((a1 - a0) * i) / n, b = b0 + ((b1 - b0) * i) / n; s.box(a - t, b - t, a + t, b + t, 0, top, wood); } };
  posts(u0, v0, u1, v0); posts(u1, v0, u1, v1); posts(u1, v1, u0, v1); posts(u0, v1, u0, v0);
  for (let z = 2; z < top; z += 2.2) { s.box(u0 - t, v0 - t, u1 + t, v0 + t, z, z + 0.2, wood); s.box(u0 - t, v1 - t, u1 + t, v1 + t, z, z + 0.2, wood); s.box(u0 - t, v0, u0 + t, v1, z, z + 0.2, wood); s.box(u1 - t, v0, u1 + t, v1, z, z + 0.2, wood); }
}

/**
 * The model of an infantry base or a vehicle factory on its parcel, in the owner's colour. `built` runs from 0 to 1:
 * part-built, it stands that tall inside scaffolding, in bare materials. Returns where its flag and its smoke go.
 */
function works(s, kind, hu, hv, color, built) {
  const raw = built < 1, grow = Math.max(0.08, built);
  const c = (hex, shade = 1) => (raw ? tint(hex, '#b3a58a', 0.6).map((x) => x * shade) : rgb(hex, shade));
  const side = raw ? tint(color, '#b3a58a', 0.6) : rgb(color), dark = side.map((x) => x * 0.72), glass = c(GLASS);
  const z = (m) => m * grow;
  const marks = { flag: null, smoke: null };
  if (kind === 'barracks') {
    // A walled compound: a drill hall and two huts round a parade ground, a watchtower at the gate, and the flag.
    const wall = c('#a9a495'), th = 0.5;
    s.box(-hu, -hv, hu, hv, 0, 0.12, c('#c9c0a6'));
    s.box(-hu, hv - th, hu, hv, 0, z(2.8), wall); s.box(-hu, -hv, -hu + th, hv, 0, z(2.8), wall); s.box(hu - th, -hv, hu, hv, 0, z(2.8), wall);
    s.box(-hu, -hv, -hu * 0.18, -hv + th, 0, z(2.8), wall); s.box(hu * 0.18, -hv, hu, -hv + th, 0, z(2.8), wall);
    for (const a of [-hu * 0.18, hu * 0.18]) s.box(a - 0.6, -hv - 0.2, a + 0.6, -hv + th + 0.2, 0, z(3.8), c('#8f8a7c'));
    const hall = [-hu * 0.82, hv * 0.05, hu * 0.22, hv * 0.8], eave = z(6.5);
    s.box(...hall, 0, eave, c('#d6c9a8'), false);
    s.gable(...hall, eave, eave + z((hall[3] - hall[1]) * 0.36), dark, c('#d6c9a8'));
    if (!raw) { s.windows(hall, [0], 0, 2, 3.2, glass, 1.1, 1.7); s.panel(hall, 0, (hall[2] - hall[0]) / 2 - 1.4, 0, 2.8, 3, c(DOOR), 0.1); }
    for (const v of [-hv * 0.72, -hv * 0.2]) {
      const hut = [hu * 0.38, v, hu * 0.86, v + hv * 0.4];
      s.box(...hut, 0, z(3), c('#ddd2b6'), false);
      s.gable(...hut, z(3), z(3) + z((hut[3] - hut[1]) * 0.34), dark, c('#ddd2b6'), 0.3);
      if (!raw) s.row(hut, 3, 1.1, 0.9, 1.1, 1.6, glass, 0.8);
    }
    // Watchtower: a stone shaft, a wider lookout and a pointed cap.
    const tu = -hu * 0.84, tv = -hv * 0.8, t = 1.9;
    s.box(tu - t, tv - t, tu + t, tv + t, 0, z(10), c('#b9b3a2'));
    s.box(tu - t - 0.5, tv - t - 0.5, tu + t + 0.5, tv + t + 0.5, z(10), z(11.6), c('#8f8a7c'));
    if (!raw) for (let f = 0; f < 4; f++) s.panel([tu - t - 0.5, tv - t - 0.5, tu + t + 0.5, tv + t + 0.5], f, 0.7, z(10.4), 2 * t - 0.4, 0.8, c('#2c333b'));
    s.hip(tu - t - 0.5, tv - t - 0.5, tu + t + 0.5, tv + t + 0.5, z(11.6), z(14.6), side, t + 0.5, 0.3);
    // Crates and sandbags by the gate, and the pole for the flag.
    s.box(hu * 0.02, -hv * 0.82, hu * 0.02 + 1.6, -hv * 0.82 + 1.2, 0, z(1.1), c('#8d8468'));
    s.box(hu * 0.02 + 1.9, -hv * 0.84, hu * 0.02 + 3.2, -hv * 0.84 + 1.3, 0, z(1.4), c('#7a6a4a'));
    const fu = -hu * 0.3, fv = -hv * 0.42;
    s.round(fu, fv, 0.16, 0.1, 0, z(15), c('#e8ecef'), 6);
    if (!raw) marks.flag = [fu, fv, 14.6];
    if (raw) scaffold(s, hall[0] - 0.8, hall[1] - 0.8, hall[2] + 0.8, hall[3] + 0.8, Math.max(2.5, eave + 2));
  } else {
    // A works: saw-tooth sheds, an office, two tanks, a yard and a tall chimney with a band in the owner's colour.
    s.box(-hu, -hv, hu, hv, 0, 0.12, c('#b5b7b6'));
    const shed = [-hu * 0.88, -hv * 0.7, hu * 0.34, hv * 0.78], eave = z(7), bays = 3, step = (shed[2] - shed[0]) / bays;
    s.box(...shed, 0, eave, c('#a3acb5'), false);
    for (let i = 0; i < bays; i++) s.tooth(shed[0] + i * step, shed[1], shed[0] + (i + 1) * step, shed[3], eave, eave + z(step * 0.4), c('#6c7783'), c('#a9cfe0'), c('#a3acb5'));
    if (!raw) {
      for (let i = 0; i < bays; i++) s.panel(shed, 0, i * step + step / 2 - 2.1, 0, 4.2, 4.4, c('#4d565f'), 0.1);
      s.row(shed, 2, 4.2, 1.8, 1, 1.4, glass, 1.5);
      s.panel(shed, 0, 0.6, 5.4, shed[2] - shed[0] - 1.2, 0.7, side, 0.1);
    }
    const office = [hu * 0.46, hv * 0.12, hu * 0.9, hv * 0.78];
    s.box(...office, 0, z(6.4), c('#d6cfc0'));
    s.box(office[0] - 0.3, office[1] - 0.3, office[2] + 0.3, office[3] + 0.3, z(6.4), z(6.9), dark);
    if (!raw) { s.windows(office, [0, 1, 2], 0, 2, 3.1, glass, 1.1, 1.2); s.panel(office, 3, 1, 0, 1.2, 2.2, c(DOOR), 0.1); }
    for (const a of [hu * 0.56, hu * 0.8]) { const rad = Math.min(3.2, hu * 0.1); s.round(a, -hv * 0.14, rad, rad, 0, z(6), c('#c3cad1'), 12); s.round(a, -hv * 0.14, rad, 0, z(6), z(7.3), c('#aeb6be'), 12); }
    const cu = hu * 0.68, cv = -hv * 0.66;
    s.round(cu, cv, 1.7, 1.15, 0, z(26), c('#8a4b3c'), 12);
    s.round(cu, cv, 1.5, 1.42, z(19), z(21), side, 12);
    s.round(cu, cv, 1.3, 1.3, z(26), z(26.6), c('#5d3229'), 12);
    if (!raw) marks.smoke = [cu, cv, 26.8];
    if (raw) scaffold(s, shed[0] - 0.8, shed[1] - 0.8, shed[2] + 0.8, shed[3] + 0.8, Math.max(2.5, eave + 2.5));
  }
  return marks;
}

// ----- The map layers -----

/**
 * Makes the two map layers. `city` draws the generated buildings and goes under the game's washes of colour; `works`
 * draws what the game has built and goes above the parcels. Call `setWorks` with what stands on each parcel, as
 * { id, ring, kind, color, built, busy } with the ring in metres, and `setTerrain` when the 3D view is switched.
 */
export function cityLayers(map) {
  const centre = map.getCenter(), [ox, oy] = toMetres(centre.lng, centre.lat);
  let renderer = null, failed = false, terrain = false, stamp = 0;
  const camera = new THREE.Camera();
  const cityScene = new THREE.Scene(), worksScene = new THREE.Scene();
  for (const scene of [cityScene, worksScene]) {
    scene.add(new THREE.HemisphereLight(0xffffff, 0x8c8676, 1.55));
    const sun = new THREE.DirectionalLight(0xfff4e0, 2.1);
    sun.position.set(-0.55, -0.45, 0.72);          // from the south-west, fairly high
    scene.add(sun);
  }
  const material = new THREE.MeshLambertMaterial({ vertexColors: true });
  const puff = new THREE.MeshLambertMaterial({ color: 0xe4e8ec, transparent: true, opacity: 0.55, depthWrite: false });
  const puffShape = new THREE.IcosahedronGeometry(1, 1);
  /** Metres from the origin to the map's own coordinates. */
  const place = new THREE.Matrix4().makeTranslation(0.5 + ox / AROUND, 0.5 - oy / AROUND, 0).scale(new THREE.Vector3(1 / AROUND, -1 / AROUND, 1 / AROUND));

  /** How high the ground is at a point, in the map's terms: nothing in the flat view. */
  const ground = (x, y) => (terrain ? map.queryTerrainElevation(toLngLat(x, y)) ?? 0 : 0);

  // The generated buildings, by square of ground.
  const cells = new Map();     // 'i_j' → { all: Map key → building, mesh, dirty, ground }
  let lots = new Set(), pending = true;
  const measured = new Map();  // buildings taken from outlines, by 3 m square, so none is taken twice
  const cellOf = (b) => `${Math.floor(b.x / CELL)}_${Math.floor(b.y / CELL)}`;

  function gather() {
    if (!map.getSource('world') || map.getZoom() < FROM_ZOOM - 0.4) return;
    for (const f of map.querySourceFeatures('world', { sourceLayer: 'building' })) {
      const p = f.properties;
      let b;
      if (p.lon !== undefined) {
        const [x, y] = toMetres(p.lon, p.lat);
        b = { key: `${p.lon},${p.lat}`, x, y, w: p.w, d: p.d, a: p.a, h: p.height, kind: p.kind, lot: p.lot ?? '' };
      } else {
        // A tile made before buildings said where they stand (an older server, or one the browser kept): measure the outline.
        // Only whole rectangles are used; one cut by the edge of a tile is whole in the tile next door.
        const ring = f.geometry.type === 'Polygon' ? f.geometry.coordinates[0] : null;
        if (!ring || ring.length !== 5) continue;
        const c = ring.slice(0, 4).map(([lng, lat]) => toMetres(lng, lat));
        const x = (c[0][0] + c[1][0] + c[2][0] + c[3][0]) / 4, y = (c[0][1] + c[1][1] + c[2][1] + c[3][1]) / 4;
        const w = Math.hypot(c[1][0] - c[0][0], c[1][1] - c[0][1]), d = Math.hypot(c[2][0] - c[1][0], c[2][1] - c[1][1]);
        if (Math.abs(Math.hypot(c[3][0] - c[2][0], c[3][1] - c[2][1]) - w) > 0.6 || w < 2 || d < 2) continue;
        // The same building arrives again, a fraction off, from tiles at other zooms: keep the first.
        const gx = Math.round(x / 3), gy = Math.round(y / 3);
        let dup = false;
        for (let i = -1; i <= 1 && !dup; i++) for (let j = -1; j <= 1 && !dup; j++) { const o = measured.get(`${gx + i},${gy + j}`); if (o && Math.hypot(o[0] - x, o[1] - y) < 2) dup = true; }
        if (dup) continue;
        measured.set(`${gx},${gy}`, [x, y]);
        b = { key: `${Math.round(x)},${Math.round(y)}`, x, y, w, d, a: Math.atan2(c[1][1] - c[0][1], c[1][0] - c[0][0]), h: p.height ?? 6, kind: p.kind, lot: '' };
      }
      const key = b.key;
      const id = cellOf(b);
      let cell = cells.get(id);
      if (!cell) { cell = { all: new Map(), mesh: null, dirty: false, ground: '' }; cells.set(id, cell); }
      if (!cell.all.has(key)) { cell.all.set(key, b); cell.dirty = true; }
    }
  }
  /** The heights of the ground under a square's buildings, as one string: when it changes, the square is built again. */
  const lie = (cell) => { let s = ''; let i = 0; for (const b of cell.all.values()) { if (i++ % 7 === 0) s += `${Math.round(ground(b.x, b.y))},`; } return s; };

  function rebuild(id, cell) {
    const [i, j] = id.split('_').map(Number), cx = (i + 0.5) * CELL, cy = (j + 0.5) * CELL, s = new Shapes(), base = ground(cx, cy);
    for (const b of cell.all.values()) {
      if (b.lot && lots.has(b.lot)) continue;        // the game has built on this parcel
      s.set(b.x - cx, b.y - cy, ground(b.x, b.y) - base, b.a);
      model(s, b);
    }
    if (cell.mesh) { cityScene.remove(cell.mesh); cell.mesh.geometry.dispose(); }
    cell.mesh = new THREE.Mesh(s.geometry(), material);
    cell.mesh.position.set(cx - ox, cy - oy, base);
    cell.mesh.frustumCulled = false;
    cell.mesh.updateMatrixWorld();
    cityScene.add(cell.mesh);
    cell.dirty = false;
    cell.ground = lie(cell);
  }

  // What the game has built, one model each.
  const built = new Map();     // id → { key, group, flag, smoke, busy }
  function setWorks(list) {
    const now = new Set();
    const taken = new Set(list.map((w) => w.id));
    if (taken.size !== lots.size || [...taken].some((id) => !lots.has(id))) {
      const changed = new Set([...taken, ...lots].filter((id) => taken.has(id) !== lots.has(id)));
      lots = taken;
      for (const cell of cells.values()) for (const b of cell.all.values()) if (changed.has(b.lot)) { cell.dirty = true; break; }
    }
    for (const w of list) {
      now.add(w.id);
      const f = parcel(w.ring), key = `${w.kind}|${w.color}|${w.built}|${stamp}`;
      let one = built.get(w.id);
      if (!one || one.key !== key) {
        if (one) { worksScene.remove(one.group); one.group.traverse((o) => { if (o.geometry && o.geometry !== puffShape) o.geometry.dispose(); }); }
        const s = new Shapes(), group = new THREE.Group();
        const marks = works(s, w.kind, f.hu, f.hv, w.color, w.built);
        group.add(new THREE.Mesh(s.geometry(), material));
        group.position.set(f.x - ox, f.y - oy, ground(f.x, f.y));
        group.rotation.z = f.angle;
        one = { key, group, flag: null, smoke: null, busy: false };
        if (marks.flag) {
          // The flag is a sheet of small strips so it can wave.
          const g = new THREE.PlaneGeometry(5.2, 3, 8, 1);
          g.translate(2.6, 0, 0);
          one.flag = new THREE.Mesh(g, new THREE.MeshLambertMaterial({ color: new THREE.Color(w.color), side: THREE.DoubleSide }));
          one.flag.rotation.x = Math.PI / 2;
          one.flag.position.set(marks.flag[0] + 0.1, marks.flag[1], marks.flag[2] - 1.6);
          one.rest = g.attributes.position.array.slice();
          group.add(one.flag);
        }
        if (marks.smoke) {
          one.smoke = Array.from({ length: 6 }, () => { const m = new THREE.Mesh(puffShape, puff.clone()); m.visible = false; group.add(m); return m; });
          one.stack = marks.smoke;
        }
        group.traverse((o) => { o.frustumCulled = false; });
        worksScene.add(group);
        built.set(w.id, one);
      }
      one.busy = !!w.busy;
    }
    for (const [id, one] of built) if (!now.has(id)) { worksScene.remove(one.group); built.delete(id); }
    map.triggerRepaint();
  }

  /** Move what is at work: flags fly and chimneys smoke while a building trains units. */
  function animate(t) {
    for (const one of built.values()) {
      if (one.flag) {
        const p = one.flag.geometry.attributes.position, rest = one.rest;
        for (let i = 0; i < p.count; i++) { const x = rest[i * 3]; p.setZ(i, one.busy ? Math.sin(t * 5 - x * 1.3) * 0.09 * x : 0.05 * x); }
        p.needsUpdate = true;
      }
      if (one.smoke) one.smoke.forEach((m, i) => {
        m.visible = one.busy;
        if (!one.busy) return;
        const f = (t / 5 + i / one.smoke.length) % 1;
        m.position.set(one.stack[0] + f * 9 + Math.sin(f * 7 + i) * 0.8, one.stack[1] + f * 3, one.stack[2] + f * 16);
        m.scale.setScalar(1.1 + f * 3.4);
        m.material.opacity = 0.6 * (1 - f);
      });
    }
  }

  let lastCheck = 0;
  function upkeep(now) {
    if (pending) { pending = false; gather(); }
    // On hilly ground the buildings follow the terrain as its heights arrive.
    if (terrain && now - lastCheck > 900) {
      lastCheck = now;
      for (const cell of cells.values()) if (!cell.dirty && cell.ground !== lie(cell)) cell.dirty = true;
      for (const one of built.values()) { const z = ground(one.group.position.x + ox, one.group.position.y + oy); if (Math.abs(z - one.group.position.z) > 0.2) one.group.position.z = z; }
    }
    // A few squares are rebuilt each frame, nearest the middle of the view first, so a big city fills in without a stall.
    const waiting = [...cells].filter(([, cell]) => cell.dirty);
    if (!waiting.length) return;
    const c = map.getCenter(), [mx, my] = toMetres(c.lng, c.lat);
    const far = ([id]) => { const [i, j] = id.split('_').map(Number); return Math.hypot((i + 0.5) * CELL - mx, (j + 0.5) * CELL - my); };
    for (const [id, cell] of waiting.sort((p, q) => far(p) - far(q)).slice(0, 6)) rebuild(id, cell);
    if (waiting.length > 6) map.triggerRepaint();
  }

  const draw = (scene, from) => (gl, args) => {
    if (failed || map.getZoom() < from) return;
    camera.projectionMatrix = new THREE.Matrix4().fromArray(args.defaultProjectionData.mainMatrix).multiply(place);
    renderer.resetState();
    renderer.render(scene, camera);
  };
  const start = (gl) => {
    if (renderer || failed) return;
    try {
      renderer = new THREE.WebGLRenderer({ canvas: map.getCanvas(), context: gl, antialias: true });
      renderer.autoClear = false;
    } catch (err) {
      console.warn('Buildings are drawn as plain blocks: three.js could not start on the map.', err);
      failed = true;
    }
  };
  const wake = () => { pending = true; map.triggerRepaint(); };
  map.on('sourcedata', (e) => { if (e.sourceId === 'world') wake(); });
  map.on('moveend', wake);

  return {
    city: { id: 'cq-city', type: 'custom', renderingMode: '3d', onAdd: (m, gl) => start(gl), prerender: () => { const now = performance.now(); upkeep(now); animate(now / 1000); }, render: draw(cityScene, FROM_ZOOM) },
    works: { id: 'cq-works', type: 'custom', renderingMode: '3d', onAdd: (m, gl) => start(gl), render: draw(worksScene, 12.5) },
    setWorks,
    setTerrain(on) {
      if (on === terrain) return;
      terrain = on; stamp++;
      // Each square is lifted to its ground at once, then rebuilt so every building sits on its own spot.
      for (const [id, cell] of cells) { const [i, j] = id.split('_').map(Number); cell.dirty = true; if (cell.mesh) { cell.mesh.position.z = ground((i + 0.5) * CELL, (j + 0.5) * CELL); cell.mesh.updateMatrixWorld(); } }
      for (const one of built.values()) one.group.position.z = ground(one.group.position.x + ox, one.group.position.y + oy);
      map.triggerRepaint();
    },
    get ok() { return !failed; },
    /** How many buildings are drawn, for anything that needs to check, such as the browser tests. */
    count: () => ({ buildings: [...cells.values()].reduce((n, c) => n + (c.mesh ? c.all.size : 0), 0), works: built.size, squares: cells.size, waiting: [...cells.values()].filter((c) => c.dirty).length,
      triangles: [...cells.values()].reduce((n, c) => n + (c.mesh ? c.mesh.geometry.attributes.position.count / 3 : 0), 0) }),
  };
}
