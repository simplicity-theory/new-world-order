// Pictures for the control panels, drawn and animated with PixiJS.
//
// Pixi renders the pictures in use into one sheet, a grid of cells. Each picture on the
// page is a small <canvas data-pic="…"> that copies its cell from the sheet. A picture is
// still until the pointer is over its button; then it is redrawn every frame.
// The buttons around the pictures stay ordinary HTML, so clicks, keys, tooltips and
// screen readers work as before, and the panels keep their normal layout and scrolling.
//
// A picture is named by a key: "kind|colour|extra", for example "infantry|#1f6feb".

import { Application, Container, Graphics } from '/vendor/pixi.mjs';

const CELL = 128;      // pixels per cell in the sheet, and per picture canvas
const UNIT = 64;       // pictures are designed on a 64 × 64 grid
const COLS = 8, ROWS = 8;
const FRAME_MS = 33;

const INK = 0x10151b, STEEL = 0x55616e, PALE = 0xdfe6ee, SKIN = 0xf0c9a0, KHAKI = 0xe3d5a6, DRAB = 0x8c8362, GOLD = 0xf2c230, HELMET = 0x3d4a41;

const hex = (s) => { const n = parseInt(String(s).replace('#', ''), 16); return Number.isFinite(n) ? n : 0x7d848c; };
function mix(a, b, f) {
  const ch = (s) => Math.round(((a >> s) & 255) * (1 - f) + ((b >> s) & 255) * f);
  return (ch(16) << 16) | (ch(8) << 8) | ch(0);
}
const darken = (c, f) => mix(c, 0x0b0f14, f);
const lighten = (c, f) => mix(c, 0xffffff, f);
const G = (parent) => parent.addChild(new Graphics());
/** A layer drawn `k` times larger, growing up and out from the middle of the ground, so a small subject fills its card. */
function enlarged(parent, k, floor = 58) {
  const z = parent.addChild(new Container());
  z.scale.set(k);
  z.position.set((UNIT / 2) * (1 - k), floor * (1 - k));
  return z;
}

// ----- Parts shared between pictures -----

/** A backdrop: a sky fading from `top` to `bottom`, over a strip of ground from `horizon` down. */
function backdrop(c, top, bottom, ground, horizon = 50) {
  const g = G(c), bands = 10, h = horizon / bands;
  for (let i = 0; i < bands; i++) g.rect(0, i * h, UNIT, h + 0.5).fill(mix(top, bottom, i / (bands - 1)));
  g.rect(0, horizon, UNIT, UNIT - horizon).fill(ground);
  g.rect(0, horizon, UNIT, 1).fill(lighten(ground, 0.18));
}
/** The backdrop for a unit: its side's colour, so a card says whose it is at a glance. */
const field = (c, color) => backdrop(c, darken(color, 0.55), lighten(color, 0.12), darken(color, 0.72));
/** The backdrop for a building: an evening sky. */
const dusk = (c) => backdrop(c, 0x243245, 0x8ea2b6, 0x364233);

/** A flag flying from (x, y) to the right; returns the function that waves it. */
function flag(parent, x, y, w, h, color) {
  const g = G(parent);
  return (t) => {
    const n = 7, top = [], bottom = [];
    for (let i = 0; i <= n; i++) {
      const u = i / n, dy = Math.sin(t * 5 - u * 4.5) * h * 0.16 * u;
      top.push(x + u * w, y + dy);
      bottom.unshift(x + u * w, y + h + dy);
    }
    g.clear().poly([...top, ...bottom]).fill(color);
    g.poly([...top.slice(0, 2), ...top.slice(-2), top[top.length - 2], top[top.length - 1] + h * 0.3, x, y + h * 0.3]).fill({ color: 0xffffff, alpha: 0.18 });
  };
}

/** Puffs of smoke that rise from (x, y) and fade. */
function smoke(parent, x, y, { n = 4, rise = 16, drift = 5, r = 2.6, color = 0xd8dde3, period = 2.4, alpha = 0.7 } = {}) {
  const g = G(parent);
  return (t) => {
    g.clear();
    for (let i = 0; i < n; i++) {
      const p = (t / period + i / n) % 1;
      g.circle(x + drift * p + Math.sin(p * 6 + i * 2) * 1.2, y - rise * p, r * (0.5 + p)).fill({ color, alpha: (1 - p) * alpha });
    }
  };
}

/** A spoked wheel; turn it by setting its rotation. */
function wheel(parent, x, y, r, { tyre = INK, hub = STEEL, spokes = 4, width = 2.2 } = {}) {
  const w = parent.addChild(new Container());
  w.position.set(x, y);
  const g = G(w);
  g.circle(0, 0, r).fill(darken(hub, 0.35)).stroke({ width, color: tyre });
  for (let i = 0; i < spokes; i++) {
    const a = (i / spokes) * Math.PI;
    g.moveTo(Math.cos(a) * (r - 1), Math.sin(a) * (r - 1)).lineTo(-Math.cos(a) * (r - 1), -Math.sin(a) * (r - 1)).stroke({ width: 0.9, color: hub });
  }
  g.circle(0, 0, r * 0.28).fill(lighten(hub, 0.3));
  return w;
}

/** A soldier marching to the right, feet at (x, y); returns the function that moves him. */
function soldier(parent, x, y, scale, phase = 0, coat = KHAKI) {
  const s = parent.addChild(new Container());
  s.position.set(x, y);
  s.scale.set(scale);
  const leg = (shade) => {
    const l = s.addChild(new Graphics());
    l.position.set(0, -11);
    l.roundRect(-1.7, 0, 3.4, 10, 1).fill(shade).roundRect(-1.7, 8.6, 5.4, 2.6, 1).fill(INK);
    return l;
  };
  const back = leg(darken(DRAB, 0.45)), front = leg(darken(DRAB, 0.25));
  const body = G(s);
  body.roundRect(-7.4, -23, 4, 8.5, 1.2).fill(darken(coat, 0.45));                       // pack
  body.roundRect(-4.2, -24.5, 8.4, 14.5, 2.4).fill(coat);                                // coat
  body.roundRect(-4.2, -24.5, 3, 14.5, 2).fill({ color: 0x000000, alpha: 0.16 });        // shade on the coat
  body.rect(-4.2, -14.2, 8.4, 1.7).fill(INK);                                            // belt
  body.moveTo(1.5, -11).lineTo(7.5, -35).stroke({ width: 1.4, color: INK, cap: 'round' }); // rifle
  body.moveTo(7.2, -34).lineTo(7.9, -38).stroke({ width: 0.7, color: PALE, cap: 'round' }); // bayonet
  body.ellipse(0.4, -30, 4.5, 3.6).fill(HELMET);                                         // helmet, with the face over its lower half
  body.circle(0.8, -27.4, 3.1).fill(SKIN);
  body.roundRect(-4.8, -29.8, 10.6, 1.5, 0.7).fill(darken(HELMET, 0.3));                 // brim
  const arm = s.addChild(new Graphics());
  arm.position.set(0.5, -22.5);
  arm.roundRect(-1.5, 0, 3, 9, 1.4).fill(darken(coat, 0.2));
  return (t) => {
    const a = Math.sin(t * 6 + phase);
    front.rotation = a * 0.5;
    back.rotation = -a * 0.5;
    arm.rotation = -0.5 + a * 0.12;
    s.y = y - Math.abs(Math.cos(t * 6 + phase)) * 0.9 * scale;
  };
}

// ----- The pictures -----
// Each takes the cell to draw into and returns a function that moves it to time t, in seconds.

const PICTURES = {
  infantry(c, color) {
    field(c, color);
    const far = soldier(c, 18, 54, 1.05, 1.6, mix(KHAKI, darken(color, 0.4), 0.35));
    const near = soldier(c, 37, 58, 1.42, 0);
    return (t) => { far(t); near(t); };
  },

  scout(c, color) {
    field(c, color);
    const streaks = G(c);
    c = enlarged(c, 1.15);
    const dust = smoke(c, 12, 54, { n: 4, rise: 5, drift: -12, r: 2.4, color: lighten(color, 0.6), period: 0.9, alpha: 0.55 });
    const bike = c.addChild(new Container());
    bike.position.set(33, 49);
    const rear = wheel(bike, -12, 0, 7.5), fore = wheel(bike, 13, 0, 7.5);
    const g = G(bike);
    g.moveTo(-12, 0).lineTo(-3, -10).lineTo(9, -10).lineTo(13, 0).stroke({ width: 2.2, color: STEEL, join: 'round', cap: 'round' });
    g.moveTo(-3, -10).lineTo(2, 0).lineTo(-12, 0).stroke({ width: 1.8, color: STEEL, join: 'round' });
    g.roundRect(-3, -14.5, 11, 5, 2.4).fill(PALE);                                         // tank
    g.roundRect(-12, -12.5, 9, 2.6, 1.3).fill(INK);                                        // seat
    g.moveTo(9, -10).lineTo(11.5, -17.5).stroke({ width: 1.6, color: INK, cap: 'round' }); // forks up to the bars
    g.circle(13.5, -12, 1.8).fill(GOLD);                                                   // lamp
    g.moveTo(-7, -13).lineTo(-1, -3).stroke({ width: 3.6, color: darken(DRAB, 0.3), cap: 'round' });   // leg
    g.moveTo(-7, -14).lineTo(1, -27).stroke({ width: 6.4, color: KHAKI, cap: 'round' });               // back
    g.moveTo(0.5, -25).lineTo(11, -17.5).stroke({ width: 2.6, color: darken(KHAKI, 0.2), cap: 'round' }); // arm
    g.ellipse(3.2, -33, 4.3, 3.4).fill(INK);                                               // cap, with the face over its lower half
    g.circle(3.8, -30.6, 3.2).fill(SKIN);
    g.roundRect(4, -32.4, 3.8, 2.2, 1).fill(PALE);                                         // goggles
    return (t) => {
      rear.rotation = fore.rotation = t * 11;
      bike.y = 49 + Math.sin(t * 15) * 0.5;
      bike.rotation = Math.sin(t * 2.3) * 0.02;
      streaks.clear();
      for (let i = 0; i < 4; i++) {
        const x = UNIT + 20 - ((t * 70 + i * 31) % (UNIT + 40)), y = 14 + i * 9;
        streaks.moveTo(x, y).lineTo(x + 12, y).stroke({ width: 1, color: 0xffffff, alpha: 0.22, cap: 'round' });
      }
      dust(t);
    };
  },

  vehicle(c, color) {
    field(c, color);
    c = enlarged(c, 1.28);
    const fumes = smoke(c, 9, 40, { n: 3, rise: 9, drift: -8, r: 2.2, color: 0xcfd6dd, period: 1.3, alpha: 0.5 });
    const car = c.addChild(new Container());
    car.position.set(33, 50);
    const hull = 0x8f9ba8;
    const g = G(car);
    g.poly([-22, -3, -19, -15, 7, -15, 13, -10, 21, -9, 22, -3]).fill(hull);
    g.poly([-22, -3, 22, -3, 20, 1, -20, 1]).fill(darken(hull, 0.45));
    g.poly([-19, -15, 7, -15, 13, -10, -20.2, -10]).fill(lighten(hull, 0.22));
    g.roundRect(-10, -22, 14, 7.5, 2).fill(darken(hull, 0.12));                        // turret
    g.roundRect(-10, -22, 14, 2.4, 1.2).fill(lighten(hull, 0.3));
    g.roundRect(3, -19.6, 16, 2.4, 1.2).fill(darken(hull, 0.4));                       // gun
    g.rect(-16, -9.2, 9, 2.6).fill(lighten(color, 0.25));                              // side stripe in the side's colour
    g.rect(8.5, -13.4, 3.6, 2.4).fill(INK);                                            // driver's slit
    const wheels = [-14, 0, 14].map((x) => wheel(car, x, 1, 5.6, { spokes: 3 }));
    return (t) => {
      for (const w of wheels) w.rotation = t * 8;
      car.y = 50 + Math.sin(t * 9) * 0.45;
      car.rotation = Math.sin(t * 4.5) * 0.012;
      fumes(t);
    };
  },

  artillery(c, color) {
    field(c, color);
    c = enlarged(c, 1.3);
    const gun = c.addChild(new Container());
    gun.position.set(27, 56);
    const trail = G(gun);
    trail.moveTo(0, -9).lineTo(-19, -0.5).stroke({ width: 2.8, color: INK, cap: 'round' });
    trail.moveTo(-19, -0.5).lineTo(-22, -3).stroke({ width: 2.2, color: INK, cap: 'round' });
    const barrel = gun.addChild(new Container());
    barrel.position.set(0, -12);
    barrel.rotation = -0.47;
    const b = G(barrel);
    b.roundRect(-7, -2.4, 30, 4.8, 1.6).fill(0x9aa5b1);
    b.roundRect(-7, -2.4, 30, 1.6, 0.8).fill(lighten(0x9aa5b1, 0.3));
    b.roundRect(-10, -3.4, 8, 6.8, 1.6).fill(STEEL);
    b.roundRect(21, -3, 3.2, 6, 1).fill(STEEL);
    const shield = G(gun);
    shield.poly([3, -22, 6.5, -21, 5, -5, 1.5, -6]).fill(darken(STEEL, 0.15));
    const w = wheel(gun, 0, -9, 9, { spokes: 5, width: 2.4, hub: 0x8a6f4a });
    const flash = G(c), puff = G(c);
    const PERIOD = 2.8;
    return (t) => {
      const p = (t % PERIOD) / PERIOD, kick = Math.exp(-p * 9);
      barrel.x = -5 * kick * Math.cos(0.47);
      barrel.y = -12 + 5 * kick * Math.sin(0.47);
      w.rotation = -kick * 0.25;
      gun.x = 27 - kick * 1.4;
      const mx = 27 + 25 * Math.cos(-0.47), my = 56 - 12 + 25 * Math.sin(-0.47);
      flash.clear();
      if (p < 0.045) {
        const s = 1 - p / 0.045;
        flash.star(mx + 3, my - 1.6, 6, 8 * s + 2, 3 * s + 1, t * 9).fill({ color: 0xfff1a8, alpha: 0.95 });
        flash.circle(mx + 2, my - 1, 3 * s + 1).fill(0xffffff);
      }
      puff.clear();
      if (p < 0.6) {
        const q = p / 0.6;
        for (let i = 0; i < 3; i++) puff.circle(mx + 4 + q * (9 + i * 4), my - 2 - q * (5 + i * 3) + i, 2 + q * (3.5 + i)).fill({ color: 0xe6eaee, alpha: (1 - q) * 0.6 });
      }
    };
  },

  /** The infantry base: a drill hall with the side's flag. */
  barracks(c, color) {
    dusk(c);
    const g = G(c);
    g.rect(9, 32, 42, 20).fill(0xcfc2a3);
    g.rect(9, 32, 42, 3).fill({ color: 0x000000, alpha: 0.18 });
    g.poly([5.5, 33, 30, 19, 54.5, 33]).fill(darken(color, 0.15));
    g.poly([30, 19, 54.5, 33, 50, 33, 30, 21.6]).fill({ color: 0x000000, alpha: 0.22 });
    g.roundRect(26.5, 40, 7, 12, 1).fill(INK);
    const windows = [13, 19.5, 37.5, 44].map((x) => G(c).rect(x, 39, 4, 5).fill(0xffe7a0));
    g.moveTo(46, 33).lineTo(46, 7).stroke({ width: 1.2, color: PALE, cap: 'round' });
    g.rect(4, 51, 9, 3).fill(0x8d8468).rect(6, 48.4, 7, 3).fill(0x9a9175);            // sandbags
    const wave = flag(c, 46.5, 7.5, 13, 8, lighten(color, 0.25));
    const sentry = soldier(c, 0, 56, 0.6);
    return (t) => {
      wave(t);
      windows.forEach((w, i) => { w.alpha = 0.82 + 0.18 * Math.sin(t * 1.7 + i * 2.1); });
      sentry(t);
      // The sentry paces across the front and comes round again.
      c.children[c.children.length - 1].x = ((t * 5) % 76) - 6;
    };
  },

  /** The vehicle factory: saw-tooth roof, a smoking chimney and a turning gear. */
  factory(c, color) {
    dusk(c);
    const fumes = smoke(c, 46.5, 9, { n: 5, rise: 13, drift: 9, r: 2.8, color: 0xbcc4cc, period: 3.2 });
    const g = G(c);
    g.rect(43, 10, 7, 26).fill(0x8a4b3c);
    g.rect(43, 14, 7, 3).fill(lighten(color, 0.2));
    g.rect(43, 10, 2.2, 26).fill({ color: 0x000000, alpha: 0.2 });
    for (let i = 0; i < 3; i++) {
      const x = 7 + i * 12;
      g.poly([x, 34, x, 24, x + 12, 34]).fill(0x6c7783);
      g.poly([x + 1.2, 33, x + 1.2, 26.4, x + 9, 33]).fill(0xbfe0ee);
    }
    g.rect(7, 34, 46, 18).fill(0x97a1ac);
    g.rect(7, 34, 46, 2.4).fill({ color: 0x000000, alpha: 0.2 });
    g.rect(11, 41, 14, 11).fill(INK);
    for (let i = 0; i < 4; i++) g.rect(11, 42.5 + i * 2.6, 14, 0.8).fill({ color: PALE, alpha: 0.22 });
    const windows = [30, 36.5, 43].map((x) => G(c).rect(x, 40, 4.4, 4.4).fill(0xffd27a));
    const gear = c.addChild(new Container());
    gear.position.set(39, 48.5);
    const gg = G(gear);
    gg.star(0, 0, 8, 4.6, 3.4).fill(GOLD);
    gg.circle(0, 0, 1.5).fill(INK);
    return (t) => {
      fumes(t);
      gear.rotation = t * 1.6;
      windows.forEach((w, i) => { w.alpha = 0.75 + 0.25 * Math.sin(t * 4 + i * 1.9) * Math.sin(t * 1.3 + i); });
    };
  },

  /** The market: a stall under a striped awning, and a coin turning above it. */
  market(c, color) {
    dusk(c);
    const g = G(c);
    g.rect(12, 30, 2, 22).fill(0x6b5237).rect(50, 30, 2, 22).fill(0x6b5237);
    g.rect(11, 41, 42, 11).fill(0xa98253);
    g.rect(11, 41, 42, 2).fill(lighten(0xa98253, 0.25));
    for (let i = 0; i < 6; i++) {
      const x = 8 + i * 8, shade = i % 2 ? PALE : lighten(color, 0.15);
      g.poly([x + 2, 22, x + 10, 22, x + 8, 31, x, 31]).fill(shade);
      g.circle(x + 4, 31, 4).fill(shade);
    }
    g.rect(8, 21, 48, 1.6).fill(darken(color, 0.3));
    g.roundRect(15, 36, 7, 5, 1).fill(0xd98a4e).roundRect(24, 37, 6, 4, 1).fill(0x9bbf62).roundRect(32, 35.5, 8, 5.5, 1).fill(0xd9c45a).roundRect(42, 37, 7, 4, 1).fill(0xc9685e);
    const coin = c.addChild(new Container());
    const cg = G(coin);
    cg.circle(0, 0, 6.2).fill(GOLD).stroke({ width: 1.1, color: darken(GOLD, 0.35) });
    cg.rect(-0.9, -3.4, 1.8, 6.8).fill(darken(GOLD, 0.4));
    return (t) => {
      coin.position.set(32, 12 + Math.sin(t * 2.4) * 1.6);
      coin.scale.x = Math.cos(t * 2.2);
    };
  },

  /** Fortifications: a stone tower between two walls, flying the side's flag. */
  fort(c, color) {
    dusk(c);
    const stone = 0xb1ada2, g = G(c);
    const battlements = (x, y, w, n) => { const m = w / (2 * n - 1); for (let i = 0; i < n; i++) g.rect(x + i * 2 * m, y - 3.4, m, 3.6).fill(stone); };
    g.rect(3, 36, 58, 16).fill(darken(stone, 0.16));
    battlements(3, 36, 58, 9);
    g.rect(21, 20, 22, 32).fill(stone);
    battlements(21, 20, 22, 4);
    g.rect(21, 20, 5, 32).fill({ color: 0x000000, alpha: 0.14 });
    for (const [x, y] of [[29, 27], [36, 33], [25, 37], [34, 24], [38, 42], [8, 42], [14, 46], [50, 41], [55, 46]]) g.rect(x, y, 4, 1).fill({ color: 0x000000, alpha: 0.16 });
    g.roundRect(28, 40, 8, 12, 4).fill(INK);
    g.rect(28, 46, 8, 6).fill(INK);
    g.rect(30.6, 28, 2.8, 5.5).fill(INK);
    g.moveTo(32, 16.6).lineTo(32, 3).stroke({ width: 1.2, color: PALE, cap: 'round' });
    const wave = flag(c, 32.5, 3.5, 13, 7.5, lighten(color, 0.25));
    return (t) => wave(t);
  },

  /** A town's portrait: bigger places have more roofs and a church; `extra` is the tier, then letters for hill, river and port. */
  town(c, color, extra = '1') {
    const tier = Number(extra[0]) || 0, hill = extra.includes('h'), water = extra.includes('p') || extra.includes('r');
    backdrop(c, 0x5a86b6, 0xd3e4ef, 0x5d8a4c, 46);
    const clouds = G(c);
    const g = G(c);
    const base = hill ? 40 : 46;
    if (hill) g.poly([-2, 47, 14, 37, 32, 33, 50, 37, 66, 47]).fill(0x6b9656);
    const roofs = [0xb5553c, 0x9c4a36, 0xc46a48, 0x8b6f5a];
    const walls = [0xefe6d2, 0xe2d6bd, 0xf5efe2];
    const houses = [[27, 10, 9], [39, 9, 8], [16, 9, 7], [49, 8, 7], [7, 8, 6], [33, 8, 11], [22, 7, 10], [44, 7, 9]].slice(0, 2 + tier * 2);
    houses.sort((a, b) => b[2] - a[2]).forEach(([x, w, h], i) => {
      const y = base - (hill ? 6 * (1 - Math.abs(x + w / 2 - 32) / 32) : 0);
      g.rect(x, y - h, w, h + 2).fill(walls[i % 3]);
      g.rect(x, y - h, w * 0.3, h + 2).fill({ color: 0x000000, alpha: 0.1 });
      g.poly([x - 1.2, y - h, x + w / 2, y - h - w * 0.55, x + w + 1.2, y - h]).fill(roofs[i % 4]);
      g.rect(x + w / 2 - 1, y - h + 2.6, 2, 2.4).fill(0x4a5a6b);
    });
    let pole = [32, base - 14];
    if (tier >= 2) {                                               // church
      const y = base - (hill ? 6 : 0);
      g.rect(28.5, y - 22, 6, 23).fill(0xd9d3c4);
      g.poly([27.5, y - 22, 31.5, y - 33, 35.5, y - 22]).fill(0x5d6b7a);
      g.rect(30.6, y - 19, 1.8, 3.4).fill(INK);
      pole = [31.5, y - 33];
    }
    if (tier >= 3) {                                               // a city has a hall as well
      const y = base - (hill ? 4 : 0);
      g.rect(40, y - 17, 11, 18).fill(0xcabfa8);
      g.rect(39, y - 18.6, 13, 2).fill(0x7c5a45);
      for (let i = 0; i < 3; i++) g.rect(41.6 + i * 3, y - 14, 1.6, 3).fill(0x4a5a6b).rect(41.6 + i * 3, y - 8, 1.6, 3).fill(0x4a5a6b);
    }
    g.moveTo(pole[0], pole[1]).lineTo(pole[0], pole[1] - 10).stroke({ width: 1, color: INK, cap: 'round' });
    const wave = flag(c, pole[0] + 0.4, pole[1] - 10, 11, 6.5, color);
    const hearth = smoke(c, 12, base - 9, { n: 3, rise: 12, drift: 6, r: 1.8, color: 0xf2f4f6, period: 3.6, alpha: 0.6 });
    const sea = G(c);
    return (t) => {
      clouds.clear();
      for (let i = 0; i < 3; i++) {
        const x = ((t * (2 + i) + i * 30) % 90) - 14, y = 7 + i * 6;
        clouds.ellipse(x, y, 8, 2.6).fill({ color: 0xffffff, alpha: 0.7 }).ellipse(x + 5, y - 1.6, 5, 2.4).fill({ color: 0xffffff, alpha: 0.7 });
      }
      wave(t);
      hearth(t);
      if (water) {
        sea.clear().rect(0, 53, UNIT, 11).fill(0x3f7fb5);
        for (let i = 0; i < 2; i++) for (let x = -8; x < UNIT + 8; x += 8) {
          const sx = x + ((t * (5 + i * 3)) % 8), y = 56.5 + i * 4;
          sea.moveTo(sx, y).lineTo(sx + 3.6, y).stroke({ width: 0.9, color: 0xffffff, alpha: 0.5, cap: 'round' });
        }
      }
    };
  },

  /** An army's portrait: its banner over a file of marching soldiers. */
  army(c, color) {
    field(c, color);
    const g = G(c);
    g.moveTo(22, 54).lineTo(22, 5).stroke({ width: 1.6, color: INK, cap: 'round' });
    g.circle(22, 4.5, 1.6).fill(GOLD);
    const wave = flag(c, 22.6, 7, 30, 17, lighten(color, 0.32));
    const badge = G(c);
    const file = [[10, 55, 0.78, 2.2], [26, 57, 0.9, 1.1], [44, 59, 1.02, 0]].map(([x, y, s, p]) => soldier(c, x, y, s, p));
    return (t) => {
      wave(t);
      const dy = Math.sin(t * 5 - 2.2) * 1.3;
      badge.clear().poly([33, 12 + dy, 38, 15.5 + dy, 43, 12 + dy, 43, 15 + dy, 38, 18.5 + dy, 33, 15 + dy]).fill(darken(color, 0.35));
      badge.poly([33, 17 + dy, 38, 20.5 + dy, 43, 17 + dy, 43, 20 + dy, 38, 23.5 + dy, 33, 20 + dy]).fill(darken(color, 0.35));
      for (const s of file) s(t);
    };
  },
};

// ----- The sheet and the page -----

let app = null;
const cells = new Map();     // key → { index, box, move }
const still = matchMedia('(prefers-reduced-motion: reduce)');

/** Whether pictures can be drawn. Until this is true, callers show their plain icons instead. */
export let artReady = false;

/** The HTML for a picture. `extra` distinguishes variants, such as a town's size. */
export function picture(kind, color = '#7d848c', extra = '') {
  return `<canvas class="pic" data-pic="${kind}|${color}|${extra}" width="${CELL}" height="${CELL}"></canvas>`;
}

function cellFor(key) {
  let cell = cells.get(key);
  if (cell) return cell;
  if (cells.size >= COLS * ROWS) {                 // far more variety than a game shows at once: start the sheet again
    for (const old of cells.values()) old.box.destroy({ children: true });
    cells.clear();
    for (const el of document.querySelectorAll('canvas.pic')) el.painted = false;
  }
  const taken = new Set([...cells.values()].map((v) => v.index));
  let index = 0;
  while (taken.has(index)) index++;
  const [kind, color, extra] = key.split('|');
  const box = app.stage.addChild(new Container());
  box.position.set((index % COLS) * CELL, Math.floor(index / COLS) * CELL);
  box.scale.set(CELL / UNIT);
  const clip = new Graphics().rect(0, 0, UNIT, UNIT).fill(0xffffff);
  box.addChild(clip);
  box.mask = clip;
  const inner = box.addChild(new Container());
  const move = (PICTURES[kind] ?? PICTURES.infantry)(inner, hex(color), extra) ?? (() => {});
  cell = { index, box, move };
  cells.set(key, cell);
  return cell;
}

// A picture stands still until the pointer is over its button (or over a portrait); only then does it move.
const POSE = 0.7;            // the moment every still picture shows
const HOT = 'button:hover canvas.pic, .face:hover canvas.pic';
let lastRender = -1e9;

/** Draws the cells these canvases need at time t, then copies each canvas its cell. */
function paint(els, t) {
  const wanted = new Set(els.map((el) => cells.get(el.dataset.pic)));
  for (const cell of cells.values()) { cell.box.visible = wanted.has(cell); if (cell.box.visible) cell.move(t); }
  app.renderer.render(app.stage);
  for (const el of els) {
    const { index } = cells.get(el.dataset.pic), g = el.getContext('2d');
    g.clearRect(0, 0, CELL, CELL);
    g.drawImage(app.canvas, (index % COLS) * CELL, Math.floor(index / COLS) * CELL, CELL, CELL, 0, 0, CELL, CELL);
    el.painted = true;
  }
}

function frame(now) {
  requestAnimationFrame(frame);
  const els = [...document.querySelectorAll('canvas.pic')];
  if (!els.length) return;
  for (const el of els) cellFor(el.dataset.pic);
  const hot = still.matches ? [] : els.filter((el) => el.matches(HOT));
  // A picture the pointer has left goes back to its still pose.
  for (const el of els) if (el.moving && !hot.includes(el)) { el.moving = false; el.painted = false; }
  const fresh = els.filter((el) => !el.painted && !hot.includes(el));
  if (fresh.length) paint(fresh, POSE);
  if (hot.length && (now - lastRender >= FRAME_MS || hot.some((el) => !el.painted))) {
    paint(hot, now / 1000);
    for (const el of hot) el.moving = true;
    lastRender = now;
  }
}

/** Starts Pixi. Resolves to true when pictures can be drawn, false when the browser cannot (no WebGL). */
export async function startArt() {
  try {
    app = new Application();
    await app.init({ width: COLS * CELL, height: ROWS * CELL, backgroundAlpha: 0, antialias: true, autoStart: false, preference: 'webgl', preserveDrawingBuffer: true, resolution: 1, autoDensity: false });
    artReady = true;
    requestAnimationFrame(frame);
  } catch (err) {
    console.warn('Pictures are off: PixiJS could not start.', err);
    app = null;
  }
  return artReady;
}
