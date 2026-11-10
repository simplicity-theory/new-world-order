// Armies drawn on the map with PixiJS.
//
// A transparent canvas sits over the map, under the town badges. Each army in view is a
// small formation built from the same drawings as the panels: soldiers, motorcycles,
// armoured cars and guns under the side's banner, with a plate showing how many units it
// has. The game says where each army is on screen every frame; this module only draws.
// Nothing here takes clicks: the map's own invisible markers still do that.
//
// Things move only while they are doing something. An army on the road marches, an army
// besieging a town fires its guns, and a camped army stands still.

import { Application, Container, Graphics, Text } from '/vendor/pixi.mjs';
import { G, GOLD, INK, KHAKI, car, flag, gun, hex, lighten, mix, rider, soldier } from '/game/art.js';

let app = null;
const sprites = new Map();   // army id → what is drawn for it
const still = matchMedia('(prefers-reduced-motion: reduce)');

/** Whether armies can be drawn as pictures. Until this is true the map shows its plain markers. */
export let mapArtReady = false;

// Each kind of unit: how wide it stands in the formation, where its ground point is in its own
// drawing, and how to build it. Heavy units form the rear rank.
const KINDS = {
  infantry: { width: 12, rear: false, most: 3, build: (c, color, i) => { const m = soldier(c, 0, 0, 1, i * 1.9, mix(color, KHAKI, 0.3)); return (t, doing) => m(t, doing === 'march'); } },
  scout: { width: 31, rear: false, most: 2, foot: [33, 56.5], build: (c, color) => { const m = rider(c, color, mix(color, KHAKI, 0.3)); return (t, doing) => m(t, doing === 'march'); } },
  vehicle: { width: 47, rear: true, most: 2, foot: [33, 56.6], build: (c, color) => { const m = car(c, color, mix(0x8f9ba8, color, 0.42)); return (t, doing) => m(t, doing === 'march'); } },
  artillery: { width: 50, rear: true, most: 2, foot: [27, 56], build: (c) => { const m = gun(c); return (t, doing) => m(t, doing === 'siege' ? 'fire' : doing === 'march' ? 'roll' : 'rest'); } },
};
/** How many figures stand for `n` units of a kind: one for a few, more for many. */
const figures = (kind, n) => (n <= 0 ? 0 : Math.min(KINDS[kind].most, n < 4 ? 1 : n < 12 ? 2 : 3));

/** How wide an army's formation stands, before scaling: the wider of its two ranks. */
export function spanOf(units) {
  const rank = (rear) => Object.keys(KINDS).filter((k) => KINDS[k].rear === rear).reduce((w, k) => w + figures(k, units[k] || 0) * (KINDS[k].width + 2), -2);
  return Math.max(rank(true), rank(false), 24);
}

/** Which figures an army is drawn with, as a string; the formation is rebuilt only when this changes. */
const shapeOf = (a) => `${a.color}|${Object.keys(KINDS).map((k) => figures(k, a.units[k] || 0)).join('')}`;

function build(a) {
  const color = hex(a.color);
  const box = app.stage.addChild(new Container());
  const ground = G(box);                            // shadows, under everything
  const body = box.addChild(new Container());       // the formation; mirrored when the army heads left
  const moves = [];
  const rank = (rear) => {
    const items = Object.keys(KINDS).filter((k) => KINDS[k].rear === rear).flatMap((k) => Array.from({ length: figures(k, a.units[k] || 0) }, (_, i) => [k, i]));
    const wide = items.reduce((w, [k]) => w + KINDS[k].width + 2, -2);
    let x = wide / 2;                               // the front of the column is on the right
    for (const [k, i] of items) {
      const kind = KINDS[k], cx = x - kind.width / 2, y = rear ? -7 : 2 + (i % 2) * 2.5;
      x -= kind.width + 2;
      const holder = body.addChild(new Container());
      holder.position.set(cx - (kind.foot?.[0] ?? 0), y - (kind.foot?.[1] ?? 0));
      moves.push(kind.build(holder, color, i));
      ground.ellipse(cx, y + 0.5, kind.width * 0.46, 2.6).fill({ color: 0x0b0f14, alpha: 0.28 });
    }
    return wide;
  };
  // The banner stands behind everyone, the rear rank in front of it, the front rank nearest.
  const pole = G(body);
  const wave = flag(body, 0.7, -57, 21, 12.5, lighten(color, 0.18));
  const rearWide = rank(true), frontWide = rank(false);
  pole.moveTo(0, -5).lineTo(0, -58).stroke({ width: 1.5, color: INK, cap: 'round' });
  pole.circle(0, -58.5, 1.5).fill(GOLD);
  ground.ellipse(0, -5, 3, 1.4).fill({ color: 0x0b0f14, alpha: 0.28 });
  // The plate under the formation: how many units, and its experience.
  const plate = box.addChild(new Container());
  const back = G(plate);
  const label = plate.addChild(new Text({ text: '', style: { fontFamily: 'system-ui, sans-serif', fontSize: 11, fontWeight: '700', fill: 0xffffff } }));
  label.anchor.set(0.5);
  label.resolution = Math.max(2, devicePixelRatio || 1);
  // Its name, for your own armies when the map is close enough to read it.
  const name = plate.addChild(new Text({ text: '', style: { fontFamily: 'system-ui, sans-serif', fontSize: 11, fontWeight: '600', fill: 0x12305c, stroke: { color: 0xffffff, width: 3, join: 'round' } } }));
  name.anchor.set(0.5, 0);
  name.position.set(0, 8);
  name.resolution = label.resolution;
  return { box, body, plate, back, label, name, wave, moves, color, wide: Math.max(rearWide, frontWide, 24), shape: shapeOf(a), text: '', mood: '' };
}

function letter(s, a) {
  const text = `${a.label}${a.stars ? ` ${a.stars}` : ''}`, mood = a.doing === 'siege' ? 'siege' : a.retreating ? 'retreat' : 'ok';
  if (text === s.text && mood === s.mood) return;
  s.text = text;
  s.mood = mood;
  s.label.text = text;
  const w = Math.max(20, s.label.width + 10);
  s.back.clear().roundRect(-w / 2, -7.5, w, 15, 7.5).fill(mood === 'retreat' ? mix(s.color, 0x9aa1a9, 0.6) : s.color)
    .stroke({ width: mood === 'siege' ? 2.5 : 1.5, color: mood === 'siege' ? 0xf5b301 : 0xffffff });
}

/**
 * Draw these armies. Each is { id, x, y, color, units, label, stars, name, facing, doing, retreating }, where x and y are
 * screen pixels, facing is 1 for heading right and −1 for left, and doing is 'march', 'siege' or 'rest'.
 * `scale` is how large the figures are for the current zoom.
 */
export function drawMapArt(armies, scale) {
  if (!mapArtReady) return;
  const t = performance.now() / 1000, seen = new Set(), w = app.screen.width, h = app.screen.height;
  for (const a of armies) {
    seen.add(a.id);
    let s = sprites.get(a.id);
    if (s && s.shape !== shapeOf(a)) { s.box.destroy({ children: true }); s = null; }
    if (!s) { s = build(a); sprites.set(a.id, s); }
    // Anything off screen is neither moved nor drawn.
    s.box.visible = a.x > -120 && a.x < w + 120 && a.y > -40 && a.y < h + 140;
    if (!s.box.visible) continue;
    s.box.position.set(a.x, a.y);
    s.box.zIndex = a.y;
    s.box.alpha = a.retreating ? 0.62 : 1;
    s.body.scale.set(scale * a.facing, scale);
    s.plate.position.set(0, 13);
    letter(s, a);
    if (s.name.text !== a.name) s.name.text = a.name;
    const doing = still.matches ? 'rest' : a.doing;
    for (const move of s.moves) move(t, doing);
    s.wave(doing === 'march' ? t : 0.4);
  }
  for (const [id, s] of sprites) if (!seen.has(id)) { s.box.destroy({ children: true }); sprites.delete(id); }
  // For anything that needs to know what is on show, such as the browser tests.
  const shown = String([...sprites.values()].filter((s) => s.box.visible).length);
  if (app.canvas.dataset.armies !== shown) app.canvas.dataset.armies = shown;
  app.renderer.render(app.stage);
}

/** Starts the overlay on this map, or moves it to a new one. Resolves to true when armies can be drawn, false when the browser cannot (no WebGL). */
export async function startMapArt(map) {
  try {
    const holder = map.getContainer(), size = () => [holder.clientWidth || 1, holder.clientHeight || 1];
    if (!app) {
      const made = new Application();
      await made.init({ width: size()[0], height: size()[1], backgroundAlpha: 0, antialias: true, autoStart: false, preference: 'webgl', resolution: devicePixelRatio || 1, autoDensity: true });
      app = made;
      app.stage.sortableChildren = true;
      app.canvas.id = 'map-art';
      app.canvas.style.cssText = 'position:absolute;left:0;top:0;pointer-events:none';
    }
    for (const s of sprites.values()) s.box.destroy({ children: true });
    sprites.clear();
    // Straight after the map's own canvas, so the town badges that follow stay on top.
    map.getCanvas().after(app.canvas);
    app.renderer.resize(...size());
    map.on('resize', () => app.renderer.resize(...size()));
    mapArtReady = true;
  } catch (err) {
    console.warn('Armies are drawn as plain markers: PixiJS could not start on the map.', err);
    mapArtReady = false;
  }
  return mapArtReady;
}
