import * as maplibregl from '/vendor/maplibre-gl.mjs';
import { buildStyle } from '/style.js';
import { artReady, picture, startArt } from '/game/art.js';
import { cityLayers } from '/game/city.js';
import { drawMapArt, mapArtReady, spanOf, startMapArt } from '/game/mapart.js';

// The page for Conquer. The server runs the game; this draws it and sends commands.

const $ = (id) => document.getElementById(id);
const R = 6378137, DEG = 180 / Math.PI;
const toLngLat = (x, y) => [(x / R) * DEG, (2 * Math.atan(Math.exp(y / R)) - Math.PI / 2) * DEG];
const toMetres = (lng, lat) => [(lng / DEG) * R, R * Math.log(Math.tan(Math.PI / 4 + lat / DEG / 2))];
const TIERS = ['Hamlet', 'Village', 'Town', 'City'];
const PLAYER = 1, UNKNOWN = -1;
const SPEEDS = [1, 2, 4, 8, 16];
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

let map = null;
let game = null;        // world, rules and the town/road graph
let live = null;        // what changes every tick
let land = [];          // territory polygons
let seen = [];          // rings around what you can currently see
let tickAt = 0;
let stream = null;
let selTowns = [];      // selected town ids
let selArmy = null;     // selected army id
let selMany = [];       // several armies selected at once (then selArmy is null)
let selRoad = null;     // selected road id
let mode = null;        // what the next click on a town means: 'send', 'rally' or 'redirect'
let drag = null;        // an order being dragged from a town or army
let showRoads = false;  // the road-network overlay
let threeD = false;
let city = null;         // the 3D buildings drawn into the map, when three.js is available
try { showRoads = localStorage.getItem('conquer-roads') === 'on'; } catch { /* storage unavailable */ }
let fcMarker = null;    // the forecast shown at the target
const cycle = {};       // alert kind → which of its places was shown last
let hovered = null;
let hot = { town: null, army: null };   // what the pointer is on in the sidebar lists, or which of your towns on the map
let cmdKey = '', panelKey = '';
let details = false;    // whether the roads-and-amounts panel is open
let boxed = false;
let resumeSpeed = 1;
let lastEvent = 0;      // newest event id already shown
let lastPlace = null;   // where the latest located event happened
const badges = new Map();   // town id → { marker, el, key }
let groupsSaved = {};   // control groups: digit → town ids

async function api(path, options) {
  const res = await fetch(`/api/conquer${path}`, options && {
    method: options.method, headers: { 'content-type': 'application/json' },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

let toastTimer = 0;
function toast(text) {
  $('toast').textContent = text;
  $('toast').style.display = 'block';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { $('toast').style.display = 'none'; }, 3200);
}
const veil = (text) => { $('veil').textContent = text || ''; $('veil').style.display = text ? 'flex' : 'none'; };
const command = (c) => api(`/${game.world.id}/command`, { method: 'POST', body: c })
  .catch((err) => toast(err.message[0].toUpperCase() + err.message.slice(1)));

// ----- Game data helpers -----

const town = (id) => game.graph.towns.find((t) => t.id === id);
const roadOf = (id) => game.graph.roads.find((r) => r.id === id);
const state = (id) => live.towns[id];
const mine = (id) => state(id)?.owner === PLAYER;
const faction = (id) => live.factions.find((f) => f.id === id);
// An alternative set of side colours that stay distinct with the common kinds of colour blindness.
const SAFE = { 1: '#0072b2', 2: '#d55e00', 3: '#cc79a7', 4: '#b8860b' };
let safeColors = false;
try { safeColors = localStorage.getItem('conquer-colors') === 'safe'; } catch { /* storage unavailable */ }
const colorOf = (owner) => (safeColors && SAFE[owner]) || (faction(owner)?.color ?? '#a3a9b0');
const ownerName = (owner) => (owner === PLAYER ? 'yours' : owner === UNKNOWN ? 'unexplored' : faction(owner).name.toLowerCase());
const cutState = (id) => live.roads.find((r) => r.id === id);
const army = (id) => live.armies.find((a) => a.id === id);
const myArmy = (a) => a && a.owner === PLAYER;
/** An army of mine camped in a town of mine and free to take orders. */
const camped = (a) => myArmy(a) && a.at && !a.siege && !a.retreating && mine(a.at);
const armiesAt = (id) => live.armies.filter((a) => a.at === id);
const total = (u) => game.unitKinds.reduce((n, k) => n + (u?.[k] || 0), 0);
const unitText = (u) => game.unitKinds.filter((k) => u[k]).map((k) => `${u[k]} ${game.rules.units[k].name.toLowerCase()}`).join(', ') || 'none';
/** The units an order from this town would move: the cards picked, or everyone when several towns are selected. */
const counts = (id) => (selTowns.length === 1 ? pickedUnits(id) : Object.fromEntries(game.unitKinds.map((k) => [k, state(id).garrison?.[k] ?? 0])));
const clockText = (c) => `${Math.floor(c / 60)}:${String(Math.floor(c) % 60).padStart(2, '0')}`;

// The same arithmetic as the server, for previews.
const attackPower = (u, storming = false) => game.unitKinds.reduce((n, k) => n + (u[k] || 0) * ((storming && game.rules.units[k].assault) || game.rules.units[k].attack), 0);
const UNIT_KEY = { infantry: 'q', scout: 'e', vehicle: 'w', artillery: 't' };
const BUILD_KEY = { barracks: 'q', factory: 'w' };
const veteran = (a) => 1 + (a.stars || 0) * game.rules.experience.perStar;
const defencePower = (u, mult) => game.unitKinds.reduce((n, k) => n + (u[k] || 0) * game.rules.units[k].defence, 0) * mult;
function speedOn(u, kind) {
  const k = kind in game.rules.speed.vehicle ? kind : 'tertiary';
  let kmh = Infinity;
  for (const unit of game.unitKinds) if (u[unit] > 0) kmh = Math.min(kmh, game.rules.speed[unit][k]);
  if (kmh === Infinity) kmh = game.rules.speed.infantry[k];
  return (kmh / 3.6) * game.rules.timeScale;
}

/** Quickest route for these units, mirroring the server's rule. Returns the line, the time and the towns passed. */
function route(from, to, units) {
  const dist = new Map([[from, 0]]), via = new Map(), done = new Set();
  for (;;) {
    let cur = null, best = Infinity;
    for (const [k, d] of dist) if (!done.has(k) && d < best) { best = d; cur = k; }
    if (cur === null) return null;
    if (cur === to) break;
    done.add(cur);
    for (const r of game.graph.roads) {
      if (cutState(r.id) || (r.a !== cur && r.b !== cur)) continue;
      if ((r.kind === 'rail' || r.kind === 'sea') && !(mine(r.a) && mine(r.b))) continue;   // trains and ships run only between towns you hold
      const other = r.a === cur ? r.b : r.a, d = best + r.length / speedOn(units, r.kind);
      if (d < (dist.get(other) ?? Infinity)) { dist.set(other, d); via.set(other, { r, prev: cur }); }
    }
  }
  const pts = [], stops = [];
  let length = 0;
  for (let at = to; at !== from;) {
    const { r, prev } = via.get(at);
    pts.unshift(...(r.a === prev ? r.pts : [...r.pts].reverse()));
    stops.unshift(at);
    length += r.length;
    at = prev;
  }
  return { pts, length, time: dist.get(to), stops };
}

function pointAlong(pts, d) {
  for (let i = 0; i + 1 < pts.length; i++) {
    const l = Math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]);
    if (d <= l) return [pts[i][0] + ((pts[i + 1][0] - pts[i][0]) * d) / (l || 1), pts[i][1] + ((pts[i + 1][1] - pts[i][1]) * d) / (l || 1)];
    d -= l;
  }
  return pts[pts.length - 1];
}

/**
 * What happens if these units set off for a town: the route, where they stop, and how
 * the fight there should go. A walled town is besieged first, which takes its walls out
 * of the reckoning.
 */
function forecast(from, to, units) {
  const r = route(from, to, units);
  if (!r) return { text: `No road leads to ${town(to).name}` };
  const stop = r.stops.find((id) => !mine(id)) ?? to;
  const out = { pts: r.pts, stop, time: r.time, text: `${town(to).name}: ${(r.length / 1000).toFixed(1)} km, about ${Math.round(r.time)} s` };
  if (mine(stop)) return out;
  const s = state(stop);
  if (stop !== to) out.text += ` — they will stop at ${town(stop).name}`;
  // Artillery shortens a siege.
  const guns = 1 + Math.min(game.rules.siegeGuns.cap, game.rules.siegeGuns.each * (units.artillery || 0));
  out.fight = { siege: s.siege / guns, known: s.visible };
  if (s.visible) {
    const ap = attackPower(units, true) * veteran(units), dp = s.siege ? s.breached : s.strength;
    const win = ap > dp, ratio = win ? (ap ? dp / ap : 0) : (dp ? ap / dp : 0);
    Object.assign(out.fight, { ap, dp, win, lose: win ? Math.round(total(units) * game.rules.lossScale * ratio ** game.rules.lossPower) : total(units) - Math.round(total(units) * (game.rules.retreat.base + game.rules.retreat.close * ratio)) });
  }
  return out;
}

/** The forecast as a small card pinned above the target: a bar of your strength against theirs, and the upshot. */
function showForecast(f) {
  fcMarker?.remove();
  fcMarker = null;
  if (!f?.fight || !map) return;
  const { fight } = f, t = town(f.stop), el = document.createElement('div');
  const siege = fight.siege ? `<small>${Math.round(fight.siege)} s siege first</small>` : '';
  if (!fight.known) el.innerHTML = `<div class="fc unknown"><b>Defenders unknown</b>${siege}</div>`;
  else {
    const mineShare = Math.round((100 * fight.ap) / ((fight.ap + fight.dp) || 1));
    el.innerHTML = `<div class="fc ${fight.win ? 'win' : 'lose'}"><div class="bar"><i style="width:${mineShare}%"></i></div>
      <span><em>${fight.ap.toFixed(0)}</em><b>${fight.win ? 'Win' : 'Lose'} · lose about ${fight.lose}</b><em>${fight.dp.toFixed(1)}</em></span>${siege}</div>`;
  }
  fcMarker = new maplibregl.Marker({ element: el, anchor: 'bottom', offset: [0, -30] }).setLngLat(toLngLat(t.x, t.y)).addTo(map);
}

// ----- Map -----

const worldUrl = (kind, ext) => `${location.origin}/api/conquer/${game.world.id}/${kind}/{z}/{x}/{y}.${ext}?v=${game.world.version}`;
function mask() {
  const b = game.world.boundsM;
  const [w0, s0] = toLngLat(b.minx, b.miny), [e0, n0] = toLngLat(b.maxx, b.maxy);
  return { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [
    [[-170, -80], [170, -80], [170, 80], [-170, 80], [-170, -80]], [[w0, s0], [w0, n0], [e0, n0], [e0, s0], [w0, s0]]] } };
}
/** Keep the camera on the generated map: it can step back just far enough to show all of it, and no further. */
function lockMap() {
  if (!map || !game) return;
  const b = game.world.boundsM, c = map.getContainer(), w = c.clientWidth || 1, h = c.clientHeight || 1;
  const pad = { top: 70, bottom: 130, side: 20 };
  const uw = Math.max(100, w - 2 * pad.side), uh = Math.max(100, h - pad.top - pad.bottom);
  const k = Math.max((b.maxx - b.minx) / uw, (b.maxy - b.miny) / uh); // metres to a pixel when the whole map just fits
  const cx = (b.minx + b.maxx) / 2, cy = (b.miny + b.maxy) / 2;
  map.setMinZoom(0);
  map.setMaxBounds([toLngLat(cx - k * (uw / 2 + pad.side), cy - k * (uh / 2 + pad.bottom)), toLngLat(cx + k * (uw / 2 + pad.side), cy + k * (uh / 2 + pad.top))]);
}
const collection = (features) => ({ type: 'FeatureCollection', features });
const empty = collection([]);
const ring = (pts) => { const c = pts.map(([x, y]) => toLngLat(x, y)); c.push(c[0]); return [c]; };
const lineOf = (pts) => pts.map(([x, y]) => toLngLat(x, y));

function addOverlay() {
  const sources = ['cq-land', 'cq-fog', 'cq-paths', 'cq-bridges', 'cq-areas', 'cq-roads', 'cq-cuts', 'cq-sites', 'cq-built', 'cq-route', 'cq-drag', 'cq-labels', 'cq-groups'];
  for (const id of sources) map.addSource(id, { type: 'geojson', data: empty });
  // The towns' buildings as 3D models, under everything the game draws.
  if (!city) city = window.city = cityLayers(map);
  map.addLayer(city.city);
  // The game draws its own town names, so the map's are hidden.
  if (map.getLayer('place')) map.setLayoutProperty('place', 'visibility', 'none');
  const text = { 'text-font': ['sans-serif'], 'text-allow-overlap': true };
  // Territory: a wash of each side's colour over the land it controls, with the front line dashed.
  map.addLayer({ id: 'cq-land', type: 'fill', source: 'cq-land', paint: { 'fill-color': ['get', 'color'], 'fill-opacity': 0.16 } });
  map.addLayer({ id: 'cq-front', type: 'line', source: 'cq-land', paint: { 'line-color': ['get', 'color'], 'line-width': 2, 'line-opacity': 0.6, 'line-dasharray': [3, 2] } });
  // Fog: everything out of sight is dimmed.
  map.addLayer({ id: 'cq-fog', type: 'fill', source: 'cq-fog', paint: { 'fill-color': '#27313d', 'fill-opacity': 0.3, 'fill-antialias': false } });
  // Where armies are heading: the selected army in blue, enemy armies in sight in red.
  map.addLayer({ id: 'cq-paths', type: 'line', source: 'cq-paths', layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': ['get', 'color'], 'line-width': 3.5, 'line-opacity': 0.75, 'line-dasharray': [0.4, 1.8] } });
  map.addLayer({ id: 'cq-path-arrows', type: 'symbol', source: 'cq-paths',
    layout: { 'symbol-placement': 'line', 'symbol-spacing': 90, 'text-field': '▶', 'text-size': 13, 'text-font': ['sans-serif'], 'text-keep-upright': false, 'text-allow-overlap': true },
    paint: { 'text-color': ['get', 'color'], 'text-halo-color': '#ffffff', 'text-halo-width': 1.5 } });
  map.addLayer({ id: 'cq-area', type: 'fill', source: 'cq-areas', paint: { 'fill-color': ['get', 'color'], 'fill-opacity': ['get', 'fill'] } });
  map.addLayer({ id: 'cq-area-edge', type: 'line', source: 'cq-areas',
    paint: { 'line-color': ['case', ['==', ['get', 'selected'], 1], '#f5b301', ['get', 'color']], 'line-width': ['case', ['==', ['get', 'selected'], 1], 4, 2.2],
      'line-opacity': ['case', ['==', ['get', 'known'], 1], 0.95, 0.5] } });
  // The whole road network, coloured by class, for when the player asks to see it.
  map.addLayer({ id: 'cq-road-all', type: 'line', source: 'cq-roads', layout: { visibility: 'none', 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': ['match', ['get', 'kind'], 'motorway', '#c0392b', 'primary', '#e67e22', 'secondary', '#d4ac0d', 'rail', '#1f2933', 'sea', '#1f6f9e', '#6b7785'],
      'line-width': ['match', ['get', 'kind'], 'motorway', 5, 'primary', 4, 'secondary', 3, 2.2], 'line-opacity': 0.85 } });
  map.addLayer({ id: 'cq-bridges', type: 'circle', source: 'cq-bridges', layout: { visibility: 'none' },
    paint: { 'circle-radius': 4.5, 'circle-color': '#ffffff', 'circle-stroke-color': '#1f2933', 'circle-stroke-width': 2 } });
  // Roads are drawn only when cut, being mended or selected, but can always be clicked.
  map.addLayer({ id: 'cq-road-hit', type: 'line', source: 'cq-roads', paint: { 'line-color': '#000000', 'line-opacity': 0.001, 'line-width': 14 } });
  map.addLayer({ id: 'cq-road-state', type: 'line', source: 'cq-roads', filter: ['!=', ['get', 'state'], 'ok'],
    layout: { 'line-cap': 'round' },
    paint: { 'line-color': ['match', ['get', 'state'], 'cut', '#c62828', 'repair', '#e08a00', '#f5b301'], 'line-width': 5,
      'line-opacity': 0.75, 'line-dasharray': ['match', ['get', 'state'], 'selected', ['literal', [1, 0]], ['literal', [1.2, 1.6]]] } });
  map.addLayer({ id: 'cq-cut', type: 'symbol', source: 'cq-cuts', layout: { ...text, 'text-field': '✕', 'text-size': 22 },
    paint: { 'text-color': '#c62828', 'text-halo-color': '#ffffff', 'text-halo-width': 2.5 } });
  // A base or factory stands on its own parcel of the town: the parcel as a yard, and the building on it,
  // seen from above as roofs and in the 3D view as a building among the town's own.
  map.addLayer({ id: 'cq-site', type: 'fill', source: 'cq-sites', minzoom: 12, paint: { 'fill-color': ['get', 'color'], 'fill-opacity': ['get', 'fill'], 'fill-outline-color': '#ffffff' } });
  map.addLayer(city.works);
  // Without three.js the same buildings are plain blocks.
  map.addLayer({ id: 'cq-built', type: 'fill', source: 'cq-built', minzoom: 12.5, layout: { 'fill-sort-key': ['get', 'top'] }, paint: { 'fill-color': ['get', 'color'], 'fill-outline-color': '#00000055' } });
  map.addLayer({ id: 'cq-built-3d', type: 'fill-extrusion', source: 'cq-built', minzoom: 12.5, layout: { visibility: 'none' },
    paint: { 'fill-extrusion-color': ['get', 'color'], 'fill-extrusion-height': ['get', 'top'], 'fill-extrusion-base': ['get', 'base'], 'fill-extrusion-vertical-gradient': true } });
  map.addLayer({ id: 'cq-site-label', type: 'symbol', source: 'cq-sites', minzoom: 14,
    layout: { 'text-font': ['sans-serif'], 'text-field': ['get', 'label'], 'text-size': 11 }, paint: { 'text-color': '#ffffff', 'text-halo-color': '#00000066', 'text-halo-width': 1 } });
  map.addLayer({ id: 'cq-route', type: 'line', source: 'cq-route', layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': '#1f6feb', 'line-width': 6, 'line-opacity': 0.5 } });
  map.addLayer({ id: 'cq-drag', type: 'line', source: 'cq-drag', paint: { 'line-color': '#f5b301', 'line-width': 3, 'line-dasharray': [1.5, 1.5] } });
  map.addLayer({ id: 'cq-name', type: 'symbol', source: 'cq-labels',
    layout: { ...text, 'text-field': ['get', 'name'], 'text-size': ['+', 12.5, ['*', 2, ['get', 'tier']]], 'text-anchor': 'bottom', 'text-offset': [0, -0.1] },
    paint: { 'text-color': '#1c2530', 'text-halo-color': '#ffffffe6', 'text-halo-width': 1.8 } });
  map.addLayer({ id: 'cq-group-hot', type: 'circle', source: 'cq-groups', filter: ['==', ['get', 'hot'], 1],
    paint: { 'circle-radius': 20, 'circle-color': '#f5b301', 'circle-opacity': 0.35, 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 2.5 } });
  map.addLayer({ id: 'cq-group-ring', type: 'circle', source: 'cq-groups', filter: ['==', ['get', 'selected'], 1],
    paint: { 'circle-radius': 14, 'circle-color': '#f5b301', 'circle-opacity': 0.9 } });
  // Armies: a white rim normally, gold while besieging, grey and faded in retreat.
  map.addLayer({ id: 'cq-groups', type: 'circle', source: 'cq-groups',
    paint: { 'circle-radius': 10, 'circle-color': ['get', 'color'], 'circle-opacity': ['match', ['get', 'mood'], 'retreat', 0.55, 1],
      'circle-stroke-color': ['match', ['get', 'mood'], 'siege', '#f5b301', 'retreat', '#9aa1a9', '#ffffff'], 'circle-stroke-width': ['match', ['get', 'mood'], 'siege', 3.5, 2] } });
  // A dark outer rim marks an army with vehicles or guns in it.
  map.addLayer({ id: 'cq-group-heavy', type: 'circle', source: 'cq-groups', filter: ['==', ['get', 'heavy'], 1],
    paint: { 'circle-radius': 13.5, 'circle-color': '#00000000', 'circle-stroke-color': '#1f2933', 'circle-stroke-width': 2, 'circle-stroke-opacity': 0.75 } });
  map.addLayer({ id: 'cq-group-stars', type: 'symbol', source: 'cq-groups', filter: ['!=', ['get', 'stars'], ''],
    layout: { ...text, 'text-field': ['get', 'stars'], 'text-size': 9, 'text-offset': [0, -1.75] }, paint: { 'text-color': '#b7791f', 'text-halo-color': '#ffffff', 'text-halo-width': 1.5 } });
  map.addLayer({ id: 'cq-group-name', type: 'symbol', source: 'cq-groups', minzoom: 12.6, filter: ['!=', ['get', 'name'], ''],
    layout: { 'text-font': ['sans-serif'], 'text-field': ['get', 'name'], 'text-size': 10.5, 'text-offset': [0, 1.5], 'text-anchor': 'top', 'text-optional': true },
    paint: { 'text-color': '#12305c', 'text-halo-color': '#ffffffe6', 'text-halo-width': 1.6 } });
  map.addLayer({ id: 'cq-group-label', type: 'symbol', source: 'cq-groups',
    layout: { ...text, 'text-field': ['get', 'label'], 'text-size': 10.5 }, paint: { 'text-color': '#ffffff' } });
  styleArmies();
  drawStatic(true);
  drawLand();
  drawFog();
}

function drawLand() {
  if (!map?.getSource('cq-land') || !live) return;
  map.getSource('cq-land').setData(collection(land.map((p) => ({ type: 'Feature', properties: { color: colorOf(p.owner) },
    geometry: { type: 'Polygon', coordinates: p.rings.map((r) => ring(r)[0]) } }))));
}

function drawFog() {
  if (!map?.getSource('cq-fog') || !game) return;
  const b = game.world.boundsM;
  const outer = ring([[b.minx, b.miny], [b.maxx, b.miny], [b.maxx, b.maxy], [b.minx, b.maxy]])[0];
  map.getSource('cq-fog').setData({ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [outer, ...seen.map((r) => ring(r)[0])] } });
}

/** The road still ahead of an army, from where it is to where it is going. */
function pathAhead(a) {
  const pts = [armyPoint(a)];
  a.path.slice(a.leg).forEach((leg, k) => {
    const road = roadOf(leg.road), line = leg.rev ? [...road.pts].reverse() : road.pts;
    if (k > 0) return pts.push(...line);
    // On the current leg, keep only what lies beyond the army.
    let d = a.dist;
    for (let i = 0; i + 1 < line.length; i++) {
      const l = Math.hypot(line[i + 1][0] - line[i][0], line[i + 1][1] - line[i][1]);
      if (d < l) { pts.push(...line.slice(i + 1)); break; }
      d -= l;
    }
  });
  // Then on through any waypoints queued after that.
  let from = a.to;
  for (const to of a.owner === PLAYER ? a.orders ?? [] : []) {
    const r = from !== to ? route(from, to, a) : null;
    if (r) pts.push(...r.pts);
    from = to;
  }
  return pts;
}

let pathsKey = '';
function drawPaths() {
  if (!map?.getSource('cq-paths') || !live) return;
  const shown = live.armies.filter((a) => !a.at && a.path.length && (a.owner !== PLAYER || a.id === selArmy || selMany.includes(a.id)));
  const key = JSON.stringify(shown.map((a) => [a.id, a.leg, Math.round(a.dist / 150), a.to, a.orders]));
  if (key === pathsKey) return;
  pathsKey = key;
  map.getSource('cq-paths').setData(collection(shown.map((a) => ({ type: 'Feature', properties: { color: a.owner === PLAYER ? '#1f6feb' : colorOf(a.owner) },
    geometry: { type: 'LineString', coordinates: lineOf(pathAhead(a)) } }))));
}

// ----- Buildings on their parcels -----
// A building is put together from boxes, laid out along the parcel's longer side and sized to fit it.

const blend = (a, b, f) => { const p = (s, i) => parseInt(s.slice(1 + 2 * i, 3 + 2 * i), 16); return `#${[0, 1, 2].map((i) => Math.round(p(a, i) * (1 - f) + p(b, i) * f).toString(16).padStart(2, '0')).join('')}`; };

/** The boxes of the building of this kind on this parcel, in the owner's colour; `built` runs from 0 to 1 while it goes up. */
function buildingBoxes(ring, kind, color, built) {
  // Axes: u along the parcel's longest edge, v across it; the building keeps inside the middle of the parcel.
  let ux = 1, uy = 0, longest = 0;
  ring.forEach(([x, y], i) => { const [nx, ny] = ring[(i + 1) % ring.length], d = Math.hypot(nx - x, ny - y); if (d > longest) { longest = d; ux = (nx - x) / d; uy = (ny - y) / d; } });
  const us = ring.map(([x, y]) => x * ux + y * uy), vs = ring.map(([x, y]) => -x * uy + y * ux);
  const cu = (Math.min(...us) + Math.max(...us)) / 2, cv = (Math.min(...vs) + Math.max(...vs)) / 2;
  const hu = Math.min(46, (Math.max(...us) - Math.min(...us)) * 0.36), hv = Math.min(32, (Math.max(...vs) - Math.min(...vs)) * 0.36);
  const at = (u, v) => toLngLat((cu + u) * ux - (cv + v) * uy, (cu + u) * uy + (cv + v) * ux);
  const rise = Math.max(0.06, built), raw = built < 1;
  const out = [];
  /** A box from (u0, v0) to (u1, v1) in metres from the middle of the parcel, standing from `base` up to `top`. */
  const box = (u0, v0, u1, v1, base, top, paint) => out.push({ type: 'Feature', properties: { color: raw ? blend(paint, '#a89878', 0.55) : paint, base: base * rise, top: top * rise },
    geometry: { type: 'Polygon', coordinates: [[at(u0, v0), at(u1, v0), at(u1, v1), at(u0, v1), at(u0, v0)]] } });
  /** The same from fractions of the room there is: −1 to 1 each way. */
  const part = (a0, b0, a1, b1, base, top, paint) => box(a0 * hu, b0 * hv, a1 * hu, b1 * hv, base, top, paint);
  /** A square post of side `w` metres centred at a fraction of the room. */
  const post = (a, b, w, base, top, paint) => box(a * hu - w / 2, b * hv - w / 2, a * hu + w / 2, b * hv + w / 2, base, top, paint);
  const roof = blend(color, '#1a2028', 0.2), bright = blend(color, '#ffffff', 0.2);
  if (kind === 'barracks') {
    // A walled compound: the drill hall, two huts, a watchtower at the corner and the flag.
    for (const [a0, b0, a1, b1] of [[-1, -1, 1, -0.94], [-1, 0.94, 1, 1], [-1, -1, -0.96, 1], [0.96, -1, 1, 1]]) part(a0, b0, a1, b1, 0, 3, '#a9a495');
    part(-0.78, -0.2, 0.2, 0.74, 0, 8.5, '#cfc2a3');
    part(-0.82, -0.25, 0.24, 0.79, 8.5, 10, roof);
    part(-0.6, 0.12, 0.02, 0.42, 10, 12, blend(roof, '#000000', 0.15));
    for (const b of [-0.72, -0.22]) { part(0.42, b, 0.86, b + 0.36, 0, 4.5, '#d9cdb0'); part(0.4, b - 0.03, 0.88, b + 0.39, 4.5, 5.6, roof); }
    post(-0.86, -0.82, 5.5, 0, 14, '#b9b3a2');
    post(-0.86, -0.82, 7, 14, 15.6, roof);
    post(0.1, -0.62, 0.7, 0, 21, '#e8ecef');
    if (!raw) box(0.1 * hu + 0.35, -0.62 * hv - 0.25, 0.1 * hu + 7, -0.62 * hv + 0.25, 16.5, 20.5, bright);
  } else {
    // A works: saw-tooth sheds, an office, two tanks and a tall chimney with a band in the side's colour.
    for (let i = 0; i < 3; i++) {
      const a0 = -0.86 + i * 0.4;
      part(a0, -0.72, a0 + 0.27, 0.72, 0, 9, '#97a1ac');
      part(a0 + 0.27, -0.72, a0 + 0.4, 0.72, 0, 12.5, '#6c7783');
      part(a0 + 0.02, -0.66, a0 + 0.25, 0.66, 9, 9.4, '#bfe0ee');
    }
    part(0.46, 0.12, 0.88, 0.72, 0, 7, '#c9c2b4');
    part(0.44, 0.09, 0.9, 0.75, 7, 8, roof);
    for (const a of [0.56, 0.8]) post(a, -0.18, 7, 0, 8, '#b8c0c8');
    post(0.66, -0.62, 4, 0, 32, '#8a4b3c');
    post(0.66, -0.62, 4.8, 24, 26.5, bright);
    post(0.66, -0.62, 4.8, 31, 32.4, '#5d3229');
  }
  return out;
}

let staticKey = '';
/** Everything on the overlay except moving groups, badges and the route preview. Redrawn only when it changes. */
function drawStatic(force) {
  if (!map?.getSource('cq-areas')) return;
  const areas = [], labels = [], sites = [], built = [], lots = [], works = [];
  for (const t of game.graph.towns) {
    const s = state(t.id), color = colorOf(s.owner), known = s.owner !== UNKNOWN;
    areas.push({ type: 'Feature', geometry: { type: 'Polygon', coordinates: ring(t.outline) },
      properties: { id: t.id, color, known: known ? 1 : 0, fill: s.owner === PLAYER ? 0.3 : known ? 0.22 : 0.1, selected: selTowns.includes(t.id) ? 1 : 0 } });
    const capital = live.factions.some((f) => f.capital === t.id);
    labels.push({ type: 'Feature', geometry: { type: 'Point', coordinates: toLngLat(t.x, t.y) }, properties: { name: `${capital ? '★ ' : ''}${t.name}`, tier: t.tier } });
    Object.keys(game.rules.buildings).forEach((kind, k) => {
      const b = s.buildings?.[kind];
      if (!b) return;
      const progress = b.done ? 1 : Math.round((b.progress ?? 0) * 20) / 20;
      const busy = b.done && live.speed > 0 && Object.values(b.lines ?? {}).some((l) => l.queue);
      sites.push({ type: 'Feature', geometry: { type: 'Polygon', coordinates: ring(t.sites[k]) },
        properties: { color: blend(color, '#c9c2b0', 0.55), fill: 0.95, label: b.done ? game.rules.buildings[kind].name : 'Building…', progress, busy } });
      if (city?.ok) works.push({ id: `${t.id}|${k}`, ring: t.sites[k], kind, color, built: progress, busy });
      else built.push(...buildingBoxes(t.sites[k], kind, color, progress));
      lots.push(`${t.id}|${k}`);
    });
  }
  const roads = game.graph.roads.map((r) => {
    const c = cutState(r.id);
    return { type: 'Feature', geometry: { type: 'LineString', coordinates: lineOf(r.pts) },
      properties: { id: r.id, kind: r.kind, state: c ? (c.repair >= 0 ? 'repair' : 'cut') : r.id === selRoad ? 'selected' : 'ok' } };
  });
  const cuts = live.roads.filter((c) => c.cutAt).map((c) => ({ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: toLngLat(c.cutAt[0], c.cutAt[1]) } }));
  const key = JSON.stringify([areas.map((f) => f.properties), labels.map((f) => f.properties), sites.map((f) => f.properties), roads.map((f) => f.properties.state), cuts.length]);
  if (!force && key === staticKey) return;
  staticKey = key;
  map.getSource('cq-areas').setData(collection(areas));
  map.getSource('cq-labels').setData(collection(labels));
  map.getSource('cq-sites').setData(collection(sites));
  map.getSource('cq-built').setData(collection(built));
  city?.setWorks(works);
  // The town's own buildings on a parcel make way for what the game builds there.
  for (const id of ['building', 'building-3d']) if (map.getLayer(id)) map.setFilter(id, lots.length ? ['!', ['in', ['coalesce', ['get', 'lot'], ''], ['literal', lots]]] : null);
  map.getSource('cq-roads').setData(collection(roads));
  map.getSource('cq-cuts').setData(collection(cuts));
  map.getSource('cq-bridges').setData(collection(game.graph.roads.flatMap((r) => r.bridges.map((b) => ({ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: toLngLat(b.x, b.y) } })))));
  applyView();
}

/** Apply the road overlay and 3D toggles to the map. */
function applyView() {
  if (!map?.getLayer('cq-road-all')) return;
  for (const id of ['cq-road-all', 'cq-bridges']) map.setLayoutProperty(id, 'visibility', showRoads ? 'visible' : 'none');
  $('toggle-roads').classList.toggle('on', showRoads);
  $('toggle-3d').classList.toggle('on', threeD);
  if (map.getLayer('building-3d')) {
    map.setTerrain(threeD ? { source: 'terrain', exaggeration: 1.5 } : null);
    map.setLayoutProperty('building-3d', 'visibility', threeD ? 'visible' : 'none');
    map.setLayoutProperty('building', 'visibility', threeD ? 'none' : 'visible');
  }
  map.setLayoutProperty('cq-built-3d', 'visibility', threeD ? 'visible' : 'none');
  map.setLayoutProperty('cq-built', 'visibility', threeD ? 'none' : 'visible');
  if (city?.ok) {
    // The models stand in for the map's own flat and block buildings in both views.
    for (const id of ['building', 'building-3d']) if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', 'none');
    city.setTerrain(threeD);
  }
}
$('toggle-roads').addEventListener('click', () => { showRoads = !showRoads; try { localStorage.setItem('conquer-roads', showRoads ? 'on' : 'off'); } catch { /* fine */ } applyView(); });
$('toggle-3d').addEventListener('click', () => { threeD = !threeD; applyView(); map.easeTo({ pitch: threeD ? 55 : 0, bearing: threeD ? map.getBearing() : 0, duration: 700 }); });

// ----- Town badges -----

const ICON = {
  shield: '<svg viewBox="0 0 16 16"><path d="M8 1.5 13.5 3.5v4.2c0 3.2-2.3 5.6-5.5 6.8C4.8 13.3 2.5 10.9 2.5 7.7V3.500Z" fill="currentColor"/></svg>',
  base: '<svg viewBox="0 0 16 16"><path d="M2.500 8.500 8 4l5.500 4.500M2.500 13 8 8.500l5.500 4.500" fill="none" stroke="currentColor" stroke-width="2.200" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  factory: '<svg viewBox="0 0 16 16"><path d="M1.500 14V7l4 2.500V7l4 2.500V3h3.500v11Z" fill="currentColor"/></svg>',
  market: '<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" stroke-width="2"/><path d="M8 4.500v7M6 6.500h3a1.200 1.200 0 0 1 0 2.500H6.500" fill="none" stroke="currentColor" stroke-width="1.400"/></svg>',
  fort: '<svg viewBox="0 0 16 16"><path d="M2 14V4h2.500v2H7V4h2v2h2.500V4H14v10Z" fill="currentColor"/></svg>',
  cut: '<svg viewBox="0 0 16 16"><path d="M8 1.500 15 14H1Z" fill="#d97706"/><path d="M8 6v4M8 11.500v1" stroke="#fff" stroke-width="1.600" stroke-linecap="round"/></svg>',
  threat: '<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="7" fill="#d1345b"/><path d="M8 4v5M8 11v1.200" stroke="#fff" stroke-width="1.800" stroke-linecap="round"/></svg>',
};

/** Enemy armies known to be marching on a town of mine. */
const threatsTo = (id) => (mine(id) ? live.armies.filter((a) => !a.at && a.to === id && a.owner !== PLAYER && !a.retreating) : []);

function badgeHtml(t) {
  const s = state(t.id), own = s.owner === PLAYER;
  if (!s.visible) return { html: '<span class="muted">?</span>', title: `${t.name}: out of sight` };
  const strength = s.strength, units = total(s.force), camps = armiesAt(t.id).filter((a) => a.owner === s.owner && !a.siege).length;
  let html = `<span>${units}</span><span style="color:${colorOf(s.owner)}">${ICON.shield}</span><span>${strength.toFixed(strength < 10 ? 1 : 0)}</span>`;
  let title = `${t.name}: ${unitText(s.force)}${camps ? `, ${camps} ${camps > 1 ? 'armies' : 'army'} camped` : ''}; defence strength ${strength.toFixed(1)} (×${s.defence.toFixed(2)})${s.siege ? `; needs a ${Math.round(s.siege)} s siege` : ''}`;
  if (s.besieged) { html += ICON.threat; title += '; under siege'; }
  // How far along your own siege of this town is.
  const mySiege = armiesAt(t.id).filter((a) => a.siege && myArmy(a)).sort((p, q) => q.siege.progress / q.siege.need - p.siege.progress / p.siege.need)[0];
  if (mySiege) { const pc = Math.floor((20 * mySiege.siege.progress) / mySiege.siege.need) * 5; html += `<span class="siege" style="--p:${pc}">${pc}%</span>`; title += `; your siege is ${pc}% done`; }
  if (own) {
    let extra = '';
    for (const [kind, icon] of [['barracks', ICON.base], ['factory', ICON.factory]]) {
      const b = s.buildings[kind];
      if (b) { extra += `<span class="${b.done ? '' : 'dim'}" style="color:#12305c">${icon}</span>`; title += `; ${game.rules.buildings[kind].name.toLowerCase()}${b.done ? '' : ' (building)'}`; }
    }
    if (s.market) { extra += `<span style="color:#8a6d1c">${ICON.market}</span><span class="lvl">${s.market}</span>`; title += `; market ${s.market}`; }
    if (s.fort) { extra += `<span style="color:#5b6672">${ICON.fort}</span><span class="lvl">${s.fort}</span>`; title += `; fortifications ${s.fort}`; }
    if (extra) html += `<span class="extra" style="display:contents">${extra}</span>`;
    if (!s.supplied) { html += ICON.cut; title += '; cut off from your capital, earning half'; }
    if (!s.besieged && threatsTo(t.id).length) { html += ICON.threat; title += '; an enemy army is heading here'; }
  } else if (s.fort) { html += `<span style="color:#5b6672">${ICON.fort}</span><span class="lvl">${s.fort}</span>`; title += `; fortifications ${s.fort}`; }
  return { html, title };
}

/** A card of everything known about a town, shown while the pointer is on its badge. */
function showCard(t, el) {
  if (drag) return;
  const s = state(t.id), own = s.owner === PLAYER, card = $('card');
  const traits = [t.traits.hill && 'hill site (+25% defence)', t.traits.river && 'river (+25% defence)', t.traits.port && 'port (+25% income)', t.traits.rail && 'railway (+25% income, trains)'].filter(Boolean);
  const units = s.visible ? game.unitKinds.filter((k) => s.force[k]).map((k) => `<span class="u" style="color:${colorOf(s.owner)}">${UI[k]}<b>${s.force[k]}</b></span>`).join('') || '<span class="muted">no defenders</span>' : '<span class="muted">defenders unknown</span>';
  const camps = armiesAt(t.id).filter((a) => !a.siege), sieges = armiesAt(t.id).filter((a) => a.siege);
  card.innerHTML = `<h4 style="border-color:${colorOf(s.owner)}">${esc(t.name)} <small>${TIERS[t.tier]} · ${ownerName(s.owner)}</small></h4>
    <div class="units">${units}</div>
    ${s.visible ? `<div>Defence strength <b>${s.strength.toFixed(1)}</b> (×${s.defence.toFixed(2)})${s.siege ? ` · ${Math.round(s.siege)} s siege, then <b>${s.breached.toFixed(1)}</b>` : ' · no walls'}</div>` : ''}
    ${camps.length ? `<div>${camps.map((a) => `${esc(a.name)} (${total(a)})`).join(', ')} camped here</div>` : ''}
    ${sieges.length ? `<div class="bad">Under siege by ${sieges.map((a) => esc(a.name)).join(', ')}</div>` : ''}
    ${own ? `<div>Earns <b>${Math.round(s.income)}</b> a minute${s.supplied ? '' : ' <span class="bad">(cut off: halved)</span>'}${s.rally ? ` · new units go to ${esc(town(s.rally).name)}` : ''}</div>` : `<div class="muted">Would earn about ${game.rules.income[t.tier]} a minute</div>`}
    ${traits.length ? `<div class="muted">${traits.join(' · ')}</div>` : ''}`;
  card.style.display = 'block';
  const r = el.getBoundingClientRect(), w = card.offsetWidth, h = card.offsetHeight;
  card.style.left = `${Math.max(8, Math.min(window.innerWidth - w - 8, r.left + r.width / 2 - w / 2))}px`;
  card.style.top = `${r.bottom + 8 + h > window.innerHeight - 8 ? r.top - h - 30 : r.bottom + 8}px`;
}

function drawBadges() {
  if (!map) return;
  const small = map.getZoom() < 11.2;
  for (const t of game.graph.towns) {
    let b = badges.get(t.id);
    if (!b) {
      // MapLibre positions the outer element; the badge itself sits inside it.
      const holder = document.createElement('div'), el = document.createElement('div');
      holder.appendChild(el);
      el.dataset.town = t.id;
      el.addEventListener('click', (e) => { e.stopPropagation(); if (boxed) return; clickTown(t.id, e.ctrlKey || e.metaKey); });
      // Drag from a town of yours to send its units somewhere.
      el.addEventListener('mousedown', (e) => {
        if (e.button !== 0 || e.shiftKey || e.ctrlKey || e.metaKey || !mine(t.id) || !total(state(t.id).garrison)) return;
        e.stopPropagation(); // or the map would start panning underneath
        startDrag({ town: t.id }, e);
      });
      el.addEventListener('contextmenu', (e) => { e.preventDefault(); e.stopPropagation(); if (canOrder() && !(selTowns.length === 1 && selTowns[0] === t.id)) order(t.id, e.shiftKey); });
      el.addEventListener('mouseenter', () => { hover(t.id); showCard(t, el); if (mine(t.id)) setHot({ town: t.id }); });
      el.addEventListener('mouseleave', () => { hover(null); $('card').style.display = 'none'; setHot({}); });
      b = { el, key: '', marker: new maplibregl.Marker({ element: holder, anchor: 'top', offset: [0, 3] }).setLngLat(toLngLat(t.x, t.y)).addTo(map) };
      badges.set(t.id, b);
    }
    const s = state(t.id), { html, title } = badgeHtml(t);
    const cls = `badge${selTowns.includes(t.id) ? ' sel' : ''}${mine(t.id) && (s.besieged || threatsTo(t.id).length) ? ' threat' : ''}${small ? ' small' : ''}${hot.town === t.id ? ' hot' : ''}`;
    const key = cls + html + s.owner;
    if (key === b.key) continue;
    b.key = key;
    b.el.className = cls;
    b.el.style.setProperty('--c', colorOf(s.owner));
    b.el.innerHTML = html;
    b.el.dataset.tip = title;
  }
}

/** Where an army is, in world metres. Camped armies sit in a row beside their town so each can be clicked. */
function armyPoint(a, ahead = 0) {
  if (a.at) {
    const t = town(a.at), k = armiesAt(a.at).indexOf(a);
    const p = map.project(toLngLat(t.x, t.y));
    let q;
    if (pictured) {
      // Drawn as formations, each takes the room its figures need: three to a row, side by side.
      const here = armiesAt(a.at), row = Math.floor(k / 3), s = figureScale(), wide = (b) => Math.max(34, spanOf(b) * s) + 12;
      const before = here.slice(row * 3, k).reduce((w, b) => w + wide(b), 0);
      // The bottom row starts clear of the town's name and its badge.
      const clear = Math.max(nameReach(t), (badges.get(t.id)?.el.offsetWidth ?? 0) / 2 + 10);
      q = map.unproject([p.x + clear + before + wide(a) / 2, p.y - 6 - 74 * s * row]);
    } else q = map.unproject([p.x + 34 + 24 * (k % 4), p.y - 20 - 24 * Math.floor(k / 4)]);
    return toMetres(q.lng, q.lat);
  }
  const leg = a.path[a.leg], road = roadOf(leg.road);
  const d = Math.min(road.length, a.dist + a.speed * ahead);
  return pointAlong(road.pts, leg.rev ? road.length - d : d);
}

/** How far to each side of a town's centre its name reaches on screen, roughly, so pictures can stand clear of it. */
const nameReach = (t) => Math.max(34, (12.5 + 2 * t.tier) * 0.29 * (t.name.length + 2) + 10);
/** How large the figures are drawn at the current zoom. */
const figureScale = () => Math.min(1.25, Math.max(0.6, 0.8 + (map.getZoom() - 12) * 0.16));
// Close in, armies are drawn as formations of their units; further out, and without WebGL, as plain markers.
const PICTURES_FROM = 11.4;
let pictured = false;
const facing = new Map();   // army id → 1 heading right, −1 heading left

/** Switch the map's own army markers between the plain look and invisible click targets under the pictures. */
function styleArmies() {
  if (!map?.getLayer('cq-groups')) return;
  const on = pictured;
  map.setPaintProperty('cq-groups', 'circle-opacity', on ? 0.001 : ['match', ['get', 'mood'], 'retreat', 0.55, 1]);
  map.setPaintProperty('cq-groups', 'circle-stroke-opacity', on ? 0 : 1);
  map.setPaintProperty('cq-groups', 'circle-radius', on ? 24 : 10);
  map.setPaintProperty('cq-groups', 'circle-translate', on ? [0, -12] : [0, 0]);
  for (const id of ['cq-group-heavy', 'cq-group-stars', 'cq-group-label', 'cq-group-name']) map.setLayoutProperty(id, 'visibility', on ? 'none' : 'visible');
  // The selection ring and the pointer's halo become patches of ground under the formation.
  map.setPaintProperty('cq-group-ring', 'circle-radius', on ? 30 : 14);
  map.setPaintProperty('cq-group-ring', 'circle-opacity', on ? 0.6 : 0.9);
  map.setPaintProperty('cq-group-hot', 'circle-radius', on ? 36 : 20);
  for (const id of ['cq-group-ring', 'cq-group-hot']) map.setPaintProperty(id, 'circle-pitch-alignment', on ? 'map' : 'viewport');
}

function drawArmies() {
  if (!map?.getSource('cq-groups') || !live) return;
  const want = mapArtReady && map.getZoom() >= PICTURES_FROM;
  if (want !== pictured) { pictured = want; styleArmies(); if (!want) drawMapArt([], 1); }
  // Between ticks, carry each marching army forward at its speed so movement is smooth.
  const running = live.winner === null || live.dismissed;
  const ahead = running ? Math.min(0.4, (performance.now() - tickAt) / 1000) * live.speed : 0;
  const drawn = [];
  map.getSource('cq-groups').setData(collection(live.armies.map((a) => {
    const [x, y] = armyPoint(a, ahead);
    if (pictured) {
      const p = map.project(toLngLat(x, y)), marching = !a.at && running && live.speed > 0;
      if (!a.at) {
        // Which way it is heading on screen, from where it will be a moment from now.
        const [nx, ny] = armyPoint(a, ahead + 2), dx = map.project(toLngLat(nx, ny)).x - p.x;
        if (Math.abs(dx) > 0.5) facing.set(a.id, dx > 0 ? 1 : -1);
      } else facing.set(a.id, a.siege ? -1 : 1);   // beside a town: besiegers face it, a camp faces away
      drawn.push({ id: a.id, x: p.x, y: p.y, color: colorOf(a.owner), units: a, label: String(total(a)), stars: '★'.repeat(a.stars || 0), name: a.owner === PLAYER && map.getZoom() >= 12.6 ? a.name : '', facing: facing.get(a.id) ?? 1,
        doing: marching ? 'march' : a.siege && running && live.speed > 0 ? 'siege' : 'rest', retreating: !!a.retreating });
    }
    return { type: 'Feature', geometry: { type: 'Point', coordinates: toLngLat(x, y) },
      properties: { id: a.id, color: colorOf(a.owner), label: String(total(a)), heavy: (a.vehicle || 0) + (a.artillery || 0) > 0 ? 1 : 0, stars: '★'.repeat(a.stars || 0), name: a.owner === PLAYER ? a.name : '', selected: a.id === selArmy || selMany.includes(a.id) ? 1 : 0, hot: a.id === hot.army ? 1 : 0, mood: a.siege ? 'siege' : a.retreating ? 'retreat' : 'ok' } };
  })));
  if (pictured) drawMapArt(drawn, figureScale());
}
function frame() { drawArmies(); requestAnimationFrame(frame); }

function drawRoute() {
  if (!map?.getSource('cq-route')) return;
  const lines = [];
  const target = hovered;
  let shown = null;
  if (target && mode !== 'rally') {
    const a = selArmy !== null ? army(selArmy) : null;
    if (a) {
      // A camped army's march can be forecast; one already on the road is simply redirected.
      if (a.at && a.at !== target) {
        shown = forecast(a.at, target, a);
        if (shown.pts) lines.push(lineOf(shown.pts));
        toast(shown.text);
      } else if (!a.at) toast(`Redirect ${a.name} to ${town(target).name}`);
    } else {
      const from = selTowns.filter((id) => mine(id) && id !== target && total(counts(id)));
      for (const id of from) {
        const f = forecast(id, target, counts(id));
        if (f.pts) lines.push(lineOf(f.pts));
        if (from.length === 1) { shown = f; toast(f.text); }
      }
      if (from.length > 1) toast(`Send from ${from.length} towns to ${town(target).name}; each army travels and fights on its own`);
    }
  }
  showForecast(shown);
  map.getSource('cq-route').setData(lines.length ? { type: 'Feature', properties: {}, geometry: { type: 'MultiLineString', coordinates: lines } } : empty);
}

function hit(point, layer, pad = 4) {
  const found = map.queryRenderedFeatures([[point.x - pad, point.y - pad], [point.x + pad, point.y + pad]], { layers: [layer] });
  return found.length ? found[0].properties.id : null;
}

function select({ towns = [], army: picked_ = null, armies = [], road = null }) {
  selTowns = towns;
  // One army gets the full army panel; several get a shared one.
  if (armies.length === 1) { picked_ = armies[0]; armies = []; }
  selArmy = picked_;
  selMany = armies;
  selRoad = road;
  mode = null;
  pickAll = true;
  picked = new Set();
  drawStatic();
  drawBadges();
  drawPaths();
  drawRoute();
  renderUi(true);
}

/** Act on a town with whatever is selected: send units, redirect a group or set a rally point. */
function order(to, queue = false) {
  if (queue && selArmy !== null && army(selArmy) && (!army(selArmy).at || army(selArmy).siege)) {
    command({ type: 'redirect', army: selArmy, to, queue: true });
    return toast(`${army(selArmy).name} will go on to ${town(to).name} afterwards`);
  }
  if (selMany.length) {
    for (const id of selMany) { const a = army(id); if (myArmy(a) && !a.retreating && a.at !== to) command({ type: 'redirect', army: id, to, ...(queue && (!a.at || a.siege) ? { queue: true } : {}) }); }
  } else if (mode === 'rally' && selTowns.length === 1) {
    command({ type: 'rally', town: selTowns[0], to });
  } else if (selArmy !== null) {
    command({ type: 'redirect', army: selArmy, to });
  } else {
    const from = selTowns.filter((id) => mine(id) && id !== to && total(counts(id)));
    if (!from.length) return toast('No units selected to send');
    for (const id of from) command({ type: 'move', from: id, to, ...counts(id) });
  }
  mode = null;
  hovered = null;
  drawRoute();
  renderUi(true);
}
const canOrder = () => { const a = selArmy !== null ? army(selArmy) : null; return (myArmy(a) && !a.retreating) || selTowns.some(mine) || selMany.some((id) => myArmy(army(id))); };

function clickTown(id, add) {
  if (mode && canOrder() && !selTowns.includes(id)) return order(id);
  if (add) return select({ towns: selTowns.includes(id) ? selTowns.filter((t) => t !== id) : [...selTowns.filter(mine), ...(mine(id) ? [id] : [])] });
  select({ towns: [id] });
}
function hover(id) {
  const target = id && canOrder() && !(selTowns.length === 1 && selTowns[0] === id) && army(selArmy)?.at !== id ? id : null;
  if (target !== hovered) { hovered = target; drawRoute(); }
}
/** Begin dragging an order out of a town or army. It only becomes a drag once the pointer has moved a little. */
function startDrag(source, down) {
  drag = { source, x0: down.clientX, y0: down.clientY, live: false };
  const origin = () => map.getCanvasContainer().getBoundingClientRect();
  const move = (e) => {
    if (!drag) return;
    if (!drag.live) {
      if (Math.hypot(e.clientX - drag.x0, e.clientY - drag.y0) < 8) return;
      drag.live = true;
      map.dragPan.disable();
      // Dragging from a town that is already selected keeps the cards picked there.
      if (source.army !== undefined) { if (selArmy !== source.army) select({ army: source.army }); }
      else if (!(selTowns.length === 1 && selTowns[0] === source.town)) select({ towns: [source.town] });
    }
    const o = origin(), p = [e.clientX - o.left, e.clientY - o.top];
    const under = document.elementFromPoint(e.clientX, e.clientY)?.closest?.('.badge');
    hover(under ? under.dataset.town : hit({ x: p[0], y: p[1] }, 'cq-area'));
    const a = source.army !== undefined ? army(source.army) : null;
    const start = a ? armyPoint(a) : [town(source.town).x, town(source.town).y];
    const end = map.unproject(p);
    map.getSource('cq-drag')?.setData({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: [toLngLat(start[0], start[1]), [end.lng, end.lat]] } });
  };
  const up = () => {
    document.removeEventListener('mousemove', move);
    document.removeEventListener('mouseup', up);
    const was = drag;
    drag = null;
    if (!was?.live) return;
    map.dragPan.enable();
    map.getSource('cq-drag')?.setData(empty);
    // Swallow the click that follows the release.
    boxed = true;
    setTimeout(() => { boxed = false; }, 60);
    if (hovered) order(hovered); else { hover(null); drawRoute(); }
  };
  document.addEventListener('mousemove', move);
  document.addEventListener('mouseup', up);
}
const goTo = (x, y, zoom) => map.easeTo({ center: toLngLat(x, y), zoom: zoom ?? Math.max(map.getZoom(), 12), duration: 500 });

function startMap() {
  const start = town(live.me.capital) ?? game.graph.towns[0];
  map = new maplibregl.Map({
    container: 'map', style: buildStyle(worldUrl('tiles', 'mvt'), worldUrl('dem', 'png'), mask()),
    center: toLngLat(start.x, start.y), zoom: 12.2, minZoom: 8, maxZoom: 18, attributionControl: false, boxZoom: false, keyboard: false,
  });
  window.map = map;
  city = null;
  pictured = false;
  startMapArt(map);
  lockMap();
  map.on('resize', lockMap);
  map.addControl(new maplibregl.ScaleControl({ maxWidth: 140 }), 'bottom-left');
  map.on('style.load', addOverlay);
  map.on('zoomend', drawBadges);
  map.on('move', drawMini);
  map.on('mousedown', 'cq-groups', (e) => {
    const a = army(e.features[0].properties.id);
    if (e.originalEvent.button !== 0 || e.originalEvent.shiftKey || !myArmy(a) || a.retreating) return;
    e.preventDefault();
    startDrag({ army: a.id }, e.originalEvent);
  });
  map.on('click', (e) => {
    if (boxed) { boxed = false; return; }
    const group = hit(e.point, 'cq-groups', 8), id = hit(e.point, 'cq-area'), road = hit(e.point, 'cq-road-hit', 6);
    if (group !== null && !mode) {
      // Ctrl-click adds an army of yours to the selection, or takes it out.
      const add = (e.originalEvent.ctrlKey || e.originalEvent.metaKey) && myArmy(army(group));
      const now = selMany.length ? selMany : selArmy !== null && myArmy(army(selArmy)) ? [selArmy] : [];
      return select(add ? { armies: now.includes(group) ? now.filter((id) => id !== group) : [...now, group] } : { army: group });
    }
    if (id) return clickTown(id, e.originalEvent.ctrlKey || e.originalEvent.metaKey);
    if (road && !mode) return select({ road });
    select({});
  });
  // Double-click a town to go in close; the map's own double-click zoom is off so it does not fight with selecting.
  map.doubleClickZoom.disable();
  map.on('dblclick', (e) => { const id = hit(e.point, 'cq-area'); if (id) { const t = town(id); goTo(t.x, t.y, Math.max(map.getZoom(), 14.2)); } else map.easeTo({ center: e.lngLat, zoom: map.getZoom() + 1, duration: 300 }); });
  map.on('contextmenu', (e) => {
    const id = hit(e.point, 'cq-area');
    if (id && canOrder() && !(selTowns.length === 1 && selTowns[0] === id)) order(id, e.originalEvent.shiftKey);
  });
  map.on('mousemove', (e) => {
    const id = hit(e.point, 'cq-area');
    map.getCanvas().style.cursor = id || hit(e.point, 'cq-groups', 8) !== null || hit(e.point, 'cq-road-hit', 6) ? 'pointer' : '';
    if (!drag) hover(id);
    // An army under the pointer shows a card of what is known about it.
    const over = hit(e.point, 'cq-groups', 8), a = over !== null && !drag ? army(over) : null;
    if (a) {
      const where = a.siege ? `besieging ${town(a.at).name}, ${Math.round(100 * a.siege.progress / a.siege.need)}% done` : a.retreating ? `retreating to ${town(a.to).name}` : a.at ? `camped at ${town(a.at).name}` : `marching to ${town(a.to).name}`;
      const card = $('card');
      card.innerHTML = `<h4 style="border-color:${colorOf(a.owner)}">${esc(a.name)} <small>${myArmy(a) ? 'yours' : esc(faction(a.owner).name)}</small></h4>
        <div class="units">${game.unitKinds.filter((k) => a[k]).map((k) => `<span class="u" style="color:${colorOf(a.owner)}">${UI[k]}<b>${a[k]}</b></span>`).join('')}</div>
        <div>Attack strength <b>${(attackPower(a) * veteran(a)).toFixed(1)}</b>${a.stars ? ` · ${'★'.repeat(a.stars)}` : ''}</div><div class="muted">${esc(where)}${a.orders?.length ? `, then ${a.orders.map((id) => esc(town(id).name)).join(', ')}` : ''}</div>`;
      card.style.display = 'block';
      const r = map.getCanvasContainer().getBoundingClientRect();
      card.style.left = `${Math.min(window.innerWidth - card.offsetWidth - 8, r.left + e.point.x + 16)}px`;
      card.style.top = `${r.top + e.point.y + 16}px`;
      card.dataset.army = '1';
    } else if ($('card').dataset.army) { $('card').style.display = 'none'; delete $('card').dataset.army; }
  });
  // Shift-drag draws a box and selects every town of yours inside it.
  const canvas = map.getCanvasContainer();
  canvas.addEventListener('mousedown', (down) => {
    if (!down.shiftKey || down.button !== 0) return;
    down.preventDefault();
    map.dragPan.disable();
    const box = $('box'), origin = canvas.getBoundingClientRect();
    const x0 = down.clientX - origin.left, y0 = down.clientY - origin.top;
    const move = (e) => {
      const x1 = e.clientX - origin.left, y1 = e.clientY - origin.top;
      Object.assign(box.style, { display: 'block', left: `${Math.min(x0, x1)}px`, top: `${Math.min(y0, y1)}px`, width: `${Math.abs(x1 - x0)}px`, height: `${Math.abs(y1 - y0)}px` });
    };
    const up = (e) => {
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
      box.style.display = 'none';
      map.dragPan.enable();
      const x1 = e.clientX - origin.left, y1 = e.clientY - origin.top;
      if (Math.abs(x1 - x0) < 6 && Math.abs(y1 - y0) < 6) return;
      boxed = true;
      setTimeout(() => { boxed = false; }, 50);
      const inside = (x, y) => { const p = map.project(toLngLat(x, y)); return p.x >= Math.min(x0, x1) && p.x <= Math.max(x0, x1) && p.y >= Math.min(y0, y1) && p.y <= Math.max(y0, y1); };
      const towns = game.graph.towns.filter((t) => mine(t.id) && inside(t.x, t.y)).map((t) => t.id);
      // A box with no town of yours in it picks up your armies instead.
      const armies = live.armies.filter((a) => myArmy(a) && !a.retreating && inside(...armyPoint(a))).map((a) => a.id);
      select(towns.length ? { towns } : { armies });
    };
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
  }, true);
  requestAnimationFrame(frame);
}

// ----- Heads-up display -----

function drawHud() {
  const held = game.graph.towns.filter((t) => mine(t.id)).length;
  const net = live.me.income - live.me.upkeep;
  $('money').textContent = Math.floor(live.me.money).toLocaleString();
  $('income').textContent = `money, ${net >= 0 ? '+' : '−'}${Math.abs(Math.round(net))} a minute`;
  $('income').title = `Income ${Math.round(live.me.income)}, upkeep ${Math.round(live.me.upkeep)} a minute`;
  $('towns').textContent = `${held} of ${game.graph.towns.length}`;
  $('goal').textContent = `towns held, ${live.goal} wins`;
  $('progress').firstElementChild.style.width = `${Math.min(100, (100 * held) / live.goal)}%`;
  $('clock').textContent = clockText(live.clock);
  for (const b of $('speed').children) b.classList.toggle('on', Number(b.dataset.speed) === live.speed);
  $('autoplay').classList.toggle('on', !!live.settings?.watch);
  const over = live.winner !== null && !live.dismissed;
  $('result').style.display = over ? 'flex' : 'none';
  if (over) {
    $('result-title').textContent = live.winner === PLAYER ? 'Victory' : 'Defeat';
    const rivals = live.factions.filter((f) => f.id > PLAYER);
    $('result-text').textContent = live.winner === PLAYER
      ? (rivals.length && rivals.every((f) => !f.alive) ? 'Every rival capital has fallen.' : `You hold ${held} of ${game.graph.towns.length} towns.`)
      : (mine(live.me.capital) ? `The ${faction(live.winner)?.name ?? 'rival'} holds most of the map.` : 'Your capital has fallen.');
    drawSummary();
  }
}

// ----- Events and battle reports -----

function reportHtml(e) {
  const r = e.report, row = (who, side) => `<tr><td>${who}</td><td>${total(side.before)}</td><td>${side.power.toFixed(1)}</td><td>${total(side.before) - total(side.after)}</td><td>${total(side.after)}</td></tr>`;
  const title = r.kind === 'field' ? `Fight ${esc(r.place)}` : `${r.kind === 'assault' ? 'Attack on' : 'Defence of'} ${esc(r.place)}`;
  return `<b>${title}: ${r.won ? 'won' : 'lost'}</b><table><tr><th></th><th>units</th><th>strength</th><th>lost</th><th>left</th></tr>
    ${row('You', r.you)}${row(r.them.owner === 0 ? 'Defenders' : esc(faction(r.them.owner)?.name ?? 'Enemy'), r.them)}</table>`;
}

let fightsOnly = false;
function drawEvents(force) {
  const el = $('events');
  const fresh = live.events.filter((e) => (e.id ?? 0) > lastEvent);
  if (force || fresh.length || !el.children.length) {
    el.innerHTML = live.events.filter((e) => !fightsOnly || e.report || e.kind === 'siege').map((e) => `<div ${e.at ? `data-x="${e.at[0]}" data-y="${e.at[1]}" title="Go there"` : ''} class="${e.report ? (e.report.won ? 'win' : 'loss') : ''}"><time>${clockText(e.clock)}</time>${esc(e.text)}</div>`).join('')
      + (live.growing ? '<div>Mapping new territory…</div>' : '');
    el.scrollTop = el.scrollHeight;
  }
  for (const e of fresh) {
    if (e.at) lastPlace = e.at;
    // Optionally stop the clock when one of your towns comes under siege.
    if (lastEvent && autoPause && e.kind === 'siege' && / is under siege/.test(e.text) && live.speed) { resumeSpeed = live.speed; command({ type: 'speed', value: 0 }); toast(`Paused: ${e.text} Press Space to carry on.`); }
    if (lastEvent) chime(e.report ? (e.report.won ? 'won' : 'lost') : e.kind === 'built' ? 'built' : e.kind === 'siege' ? 'siege' : '');
    // A fight pops up on the map where it happened, unless this is the backlog from loading the game.
    if (e.report && e.at && lastEvent && map) {
      // A ring flashes where the fight was.
      const ringEl = document.createElement('div');
      ringEl.innerHTML = `<div class="flash ${e.report.won ? 'won' : 'lost'}"></div>`;
      const flash = new maplibregl.Marker({ element: ringEl }).setLngLat(toLngLat(e.at[0], e.at[1])).addTo(map);
      setTimeout(() => flash.remove(), 1600);
      const popup = new maplibregl.Popup({ closeButton: false, closeOnClick: true, className: `report ${e.report.won ? 'won' : 'lost'}`, maxWidth: '300px', offset: 14 })
        .setLngLat(toLngLat(e.at[0], e.at[1])).setHTML(reportHtml(e)).addTo(map);
      setTimeout(() => popup.remove(), 9000);
    }
  }
  if (live.events.length) lastEvent = Math.max(lastEvent, ...live.events.map((e) => e.id ?? 0), 1);
}

$('events').addEventListener('click', (e) => {
  const row = e.target.closest('[data-x]');
  if (row) goTo(Number(row.dataset.x), Number(row.dataset.y));
});
$('log-fights').addEventListener('click', () => { fightsOnly = !fightsOnly; $('log-fights').classList.toggle('on', fightsOnly); drawEvents(true); });
$('log-toggle').addEventListener('click', () => {
  const open = $('log').classList.toggle('open');
  $('log-toggle').textContent = open ? 'fewer' : 'more';
  $('events').scrollTop = $('events').scrollHeight;
});

// ----- Overview sheet -----
// The whole economy and every army in two sortable tables. Click a row to go there.

let sheetTab = null;                     // 'economy', 'armies', or null when closed
const sheetSort = { economy: ['income', -1], armies: ['units', -1], rivals: ['known', -1] };
const upkeepOf = (u) => game.unitKinds.reduce((n, k) => n + (u?.[k] || 0) * game.rules.units[k].upkeep, 0);

function sheetTable(tab, cols, rows, foot = '') {
  const [by, dir] = sheetSort[tab];
  const col = cols.find((c) => c.key === by) ?? cols[0];
  const sorted = [...rows].sort((a, b) => (typeof a[col.key] === 'number' ? a[col.key] - b[col.key] : String(a[col.key]).localeCompare(String(b[col.key]))) * dir);
  return `<table><thead><tr>${cols.map((c) => `<th data-sort="${c.key}" class="${c.num ? 'num' : ''}" ${c.key === by ? `data-dir="${dir}"` : ''}>${c.label}</th>`).join('')}</tr></thead>
    <tbody>${sorted.map((r) => `<tr data-pick='${JSON.stringify(r.pick)}'>${cols.map((c) => `<td class="${c.num ? 'num' : ''}">${c.show ? c.show(r) : r[c.key]}</td>`).join('')}</tr>`).join('')}</tbody>${foot}</table>`;
}

function sheetHtml() {
  const own = game.graph.towns.filter((t) => mine(t.id));
  if (sheetTab === 'economy') {
    const rows = own.map((t) => {
      const s = state(t.id);
      const tags = [live.me.capital === t.id && '<span class="tag">capital</span>', s.market && `<span class="tag good">market ${s.market}</span>`, t.traits.port && '<span class="tag good">port</span>',
        t.traits.rail && '<span class="tag good">railway</span>', !s.supplied && '<span class="tag bad">cut off</span>', s.besieged && '<span class="tag bad">besieged</span>'].filter(Boolean).join('');
      return { x: t.x, y: t.y, pick: { towns: [t.id] }, name: t.name, size: t.tier, income: Math.round(s.income), upkeep: upkeepOf(s.garrison), net: Math.round(s.income) - upkeepOf(s.garrison), tags };
    });
    const armyUpkeep = live.armies.filter(myArmy).reduce((n, a) => n + upkeepOf(a), 0);
    const cols = [{ key: 'name', label: 'Town' }, { key: 'size', label: 'Size', show: (r) => TIERS[r.size] }, { key: 'tags', label: '', show: (r) => r.tags },
      { key: 'income', label: 'Income', num: true }, { key: 'upkeep', label: 'Garrison upkeep', num: true }, { key: 'net', label: 'Net', num: true }];
    const income = rows.reduce((n, r) => n + r.income, 0), upkeep = rows.reduce((n, r) => n + r.upkeep, 0);
    return sheetTable('economy', cols, rows, `<tfoot><tr><td colspan="3">Armies in the field</td><td class="num"></td><td class="num">${armyUpkeep}</td><td class="num">−${armyUpkeep}</td></tr>
      <tr><td colspan="3">Total a minute</td><td class="num">${income}</td><td class="num">${upkeep + armyUpkeep}</td><td class="num">${income - upkeep - armyUpkeep}</td></tr></tfoot>`);
  }
  if (sheetTab === 'rivals') {
    const rules = game.rules;
    const rivals = live.factions.filter((f) => f.id > PLAYER);
    if (!rivals.length) return '<p class="hint">You have this map to yourself.</p>';
    const mineHeld = own.length;
    const rows = rivals.map((f) => { const c = f.capital ? town(f.capital) : null; return { pick: c ? { towns: [c.id] } : { towns: [live.me.capital] }, name: f.name, id: f.id, truce: f.truce, truceCost: f.truceCost, temper: f.temper ?? '', color: colorOf(f.id), alive: f.alive, known: f.known, inView: f.inView, capital: c ? c.name : 'not found yet' }; });
    const cols = [{ key: 'name', label: 'Side', show: (r) => `<b style="color:${r.color}">${esc(r.name)}</b>${r.alive ? '' : ' <span class="tag bad">defeated</span>'}` }, { key: 'temper', label: 'Temper' },
      { key: 'capital', label: 'Capital' }, { key: 'known', label: 'Towns you know of', num: true }, { key: 'inView', label: 'Units in view', num: true },
      { key: 'truce', label: 'Truce', show: (r) => (!r.alive ? '' : r.truce ? `until ${clockText(r.truce)}` : `<button data-truce="${r.id}" ${live.me.money < r.truceCost ? 'disabled' : ''} title="Pay for ${Math.round(rules.truce.lasts / 60)} minutes in which neither of you attacks the other">Offer <span class="cost">${r.truceCost}</span></button>`) }];
    const rec = live.record;
    return `${sheetTable('rivals', cols, rows)}<p>Your record so far: <b>${rec.won}</b> fights won, <b>${rec.lost}</b> lost, <b>${rec.casualties}</b> units lost.</p><p class="hint">You hold ${mineHeld} of ${game.graph.towns.length} towns; ${live.goal} wins. You only know of a rival's towns once you have seen them, and can count its units only in towns in view now. Taking a rival's capital knocks it out.</p>`;
  }
  const status = (a) => (a.siege ? `besieging ${town(a.at).name} (${Math.round(10 * a.siege.progress / a.siege.need) * 10}%)` : a.retreating ? `retreating to ${town(a.to).name}` : a.at ? `camped at ${town(a.at).name}` : `marching to ${town(a.to).name}`);
  const armies = live.armies.filter(myArmy).map((a) => { return { pick: { army: a.id }, name: a.name, units: total(a), ...Object.fromEntries(game.unitKinds.map((k) => [k, a[k] || 0])), strength: attackPower(a), status: status(a), upkeep: upkeepOf(a) }; });
  const garrisons = own.filter((t) => total(state(t.id).garrison)).map((t) => { const g = state(t.id).garrison; return { x: t.x, y: t.y, pick: { towns: [t.id] }, name: t.name, units: total(g), ...Object.fromEntries(game.unitKinds.map((k) => [k, g[k] || 0])), strength: attackPower(g), status: 'garrison', upkeep: upkeepOf(g) }; });
  const cols = [{ key: 'name', label: 'Name' }, { key: 'status', label: 'Doing' }, ...game.unitKinds.map((k) => ({ key: k, label: game.rules.units[k].name, num: true })),
    { key: 'units', label: 'Units', num: true }, { key: 'strength', label: 'Attack', num: true }, { key: 'upkeep', label: 'Upkeep', num: true }];
  return `<h3>Armies</h3>${armies.length ? sheetTable('armies', cols, armies) : '<p class="hint">No armies yet. Send units out of a town, or muster them, to form one.</p>'}
    <h3>Garrisons</h3>${garrisons.length ? sheetTable('armies', cols, garrisons) : '<p class="hint">No town of yours has units in it.</p>'}`;
}

let sheetKey = '';
function drawSheet(force) {
  $('sheet').style.display = sheetTab ? 'flex' : 'none';
  if (!sheetTab) return;
  const html = sheetHtml();
  if (!force && html === sheetKey) return;
  sheetKey = html;
  $('sheet-body').innerHTML = html;
  for (const b of $('sheet').querySelectorAll('[data-tab]')) b.classList.toggle('on', b.dataset.tab === sheetTab);
}
function openSheet(tab) { sheetTab = tab; drawSheet(true); }
$('open-sheet').addEventListener('click', () => openSheet(sheetTab ? null : 'economy'));
$('close-sheet').addEventListener('click', () => openSheet(null));
$('sheet').addEventListener('click', (e) => {
  const tab = e.target.closest('[data-tab]'), th = e.target.closest('th[data-sort]'), row = e.target.closest('tr[data-pick]');
  const truce = e.target.closest('[data-truce]');
  if (truce) { command({ type: 'truce', with: Number(truce.dataset.truce) }).then(() => drawSheet(true)); return; }
  if (tab) return openSheet(tab.dataset.tab);
  if (th) { const s = sheetSort[sheetTab]; sheetSort[sheetTab] = [th.dataset.sort, s[0] === th.dataset.sort ? -s[1] : -1]; return drawSheet(true); }
  if (row) {
    // Go to wherever the town or army is now, and select it.
    const pick = JSON.parse(row.dataset.pick), a = pick.army !== undefined ? army(pick.army) : null;
    const [x, y] = a ? armyPoint(a) : [town(pick.towns[0]).x, town(pick.towns[0]).y];
    select(pick);
    goTo(x, y);
    openSheet(null);
  }
});

// ----- Tips and sound -----

/** The next sensible thing to do, for someone finding their feet. Null once the player is clearly under way. */
function hintNow() {
  const cap = live.me.capital, s = state(cap);
  if (live.settings?.watch) return 'The computer is playing your side. Use 16× to fast-forward, and press Auto-play to take over at any time.';
  if (!s || s.owner !== PLAYER || live.winner !== null) return null;
  const held = game.graph.towns.filter((t) => mine(t.id)).length, armies = live.armies.filter(myArmy);
  if (held >= 3) return null;
  const base = s.buildings.barracks;
  if (!base) return 'Press H to go to your capital, then Q to build an infantry base. Towns earn money every minute.';
  if (!base.done) return 'The base is going up. Use the speed buttons, or − and =, to pass the time. Space pauses.';
  if (held === 1 && !armies.length && total(s.garrison) < 4) return 'Press Q to train infantry, or Shift+Q to keep training while there is money. You will want four or five for a first attack.';
  if (held === 1 && !armies.length) return 'Drag from your town’s badge to a neighbouring town. A card shows whether you would win before you let go.';
  if (armies.some((a) => a.siege)) return 'Your army is besieging the town. Wait for the walls to be breached, or select the army and storm now at a cost.';
  if (armies.some(camped)) return 'Your army camps where it stops. Drag it to its next target, press V to stand it down into the garrison, or Shift + right-click towns to queue up a route.';
  return 'Open the Overview (O) to see what each town earns and what your armies cost. Holding ' + live.goal + ' towns wins.';
}
let autoPause = true;
try { autoPause = localStorage.getItem('conquer-autopause') !== 'off'; } catch { /* storage unavailable */ }
$('autopause').checked = autoPause;
$('autopause').addEventListener('change', (e) => { autoPause = e.target.checked; try { localStorage.setItem('conquer-autopause', autoPause ? 'on' : 'off'); } catch { /* fine */ } });
$('safe-colors').checked = safeColors;
$('safe-colors').addEventListener('change', (e) => {
  safeColors = e.target.checked;
  try { localStorage.setItem('conquer-colors', safeColors ? 'safe' : 'default'); } catch { /* fine */ }
  drawStatic(true); drawLand(); drawBadges(); drawMini(); pathsKey = ''; drawPaths(); renderUi(true);
});
let hintsOff = false;
try { hintsOff = localStorage.getItem('conquer-hints') === 'off'; } catch { /* storage unavailable */ }
function drawHint() {
  const text = hintsOff ? null : hintNow();
  $('hint').style.display = text ? 'flex' : 'none';
  if (text && $('hint-text').textContent !== text) $('hint-text').textContent = text;
}
$('hint-close').addEventListener('click', () => { hintsOff = true; try { localStorage.setItem('conquer-hints', 'off'); } catch { /* fine */ } drawHint(); });

let sound = true, audio = null;
try { sound = localStorage.getItem('conquer-sound') !== 'off'; } catch { /* storage unavailable */ }
$('toggle-sound').classList.toggle('on', sound);
$('toggle-sound').addEventListener('click', () => {
  sound = !sound;
  $('toggle-sound').classList.toggle('on', sound);
  try { localStorage.setItem('conquer-sound', sound ? 'on' : 'off'); } catch { /* fine */ }
  if (sound) chime('built');
});
/** A short synthesised cue. Notes are [frequency, start, length]. */
function chime(kind) {
  if (!sound) return;
  const notes = { won: [[523, 0, 0.12], [659, 0.1, 0.12], [784, 0.2, 0.22]], lost: [[392, 0, 0.16], [311, 0.14, 0.3]], built: [[880, 0, 0.09], [1175, 0.08, 0.14]], siege: [[196, 0, 0.3], [185, 0.25, 0.35]] }[kind];
  if (!notes) return;
  try {
    audio ??= new (window.AudioContext || window.webkitAudioContext)();
    for (const [freq, at, len] of notes) {
      const osc = audio.createOscillator(), gain = audio.createGain(), t = audio.currentTime + at;
      osc.type = 'triangle';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(0.12, t + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + len);
      osc.connect(gain).connect(audio.destination);
      osc.start(t);
      osc.stop(t + len + 0.02);
    }
  } catch { /* no audio available: play silently */ }
}

// ----- Rules reference -----
// Written out from the rule values the server sent, so it is always in step with the game being played.

function guideHtml() {
  const r = game.rules, pct = (v) => `${Math.round(v * 100)}%`;
  const units = Object.entries(r.units).map(([k, u]) => `<tr><td>${UI[k]}${u.name}</td><td>${u.cost}</td><td>${u.time} s</td><td>${u.attack}${u.assault ? ` (${u.assault} vs towns)` : ''}</td><td>${u.defence}</td><td>${u.upkeep}</td>
    <td>${r.speed[k].tertiary}–${r.speed[k].motorway}</td><td>${Object.values(r.buildings).find((b) => b.trains.includes(k)).name}</td></tr>`).join('');
  const towns = TIERS.map((name, t) => `<tr><td>${name}</td><td>${r.income[t]}</td><td>${Object.entries(r.neutralGarrison[t]).filter(([, n]) => n).map(([k, n]) => `${n} ${r.units[k].name.toLowerCase()}`).join(', ')}</td>
    <td>${t === 2 ? `${r.siege.town} s` : t === 3 ? `${r.siege.city} s` : 'none'}</td><td>${r.loot[t]}</td></tr>`).join('');
  return `
    <h3>The aim</h3>
    <p>Hold ${pct(r.winShare)} of the towns on the map, or knock out every rival by taking its capital (marked ★). Lose your own capital and you are out.</p>
    <h3>Money</h3>
    <p>Each town you hold earns money every minute. A market adds ${pct(r.upgrades.market.perLevel)} per level, a port ${pct(r.portBonus)} and a railway ${pct(r.railBonus)}.
      A town cut off from your capital (no chain of your towns and open roads back to it) earns ${pct(r.cutOffShare)}; a besieged town earns nothing. Every unit costs upkeep each minute, in a garrison or an army. Taking a town brings loot.</p>
    <table><tr><th>Town</th><th>Income / min</th><th>Neutral defenders</th><th>Siege for its size</th><th>Loot</th></tr>${towns}</table>
    <h3>Units</h3>
    <table><tr><th>Unit</th><th>Cost</th><th>Time</th><th>Attack</th><th>Defence</th><th>Upkeep</th><th>Speed km/h</th><th>Trained at</th></tr>${units}</table>
    <p>The ${r.buildings.barracks.name.toLowerCase()} costs ${r.buildings.barracks.cost} and the ${r.buildings.factory.name.toLowerCase()} ${r.buildings.factory.cost}. A mixed army moves at the pace of its slowest unit. Scouts see ${r.units.scout.sight / 1000} km; other armies see ${r.vision.group / 1000} km and towns ${r.vision.town / 1000} km.</p>
    <h3>Garrisons and armies</h3>
    <p>Units you train join the town's garrison. Sending them out, or mustering them, forms an army: it has a name, camps beside whatever town it stops at, and helps defend that town.
      Armies can be split, merged, reinforced from the garrison, or stood down into it. An army earns a star for each fight it wins, up to ${r.experience.max}; each star adds ${pct(r.experience.perStar)} to its strength.</p>
    <h3>Fighting</h3>
    <p>A fight compares the attackers' attack strength with the defenders' defence strength; the stronger side wins, and a tie goes to the defender.
      A town multiplies its defenders' strength: +${pct(r.defenceBonus.hill)} on a hill, +${pct(r.defenceBonus.river)} on a river, +${pct(r.defenceBonus.fort)} per level of fortification.
      The winner loses more the closer the fight was. The loser keeps ${pct(r.retreat.base)}–${pct(r.retreat.base + r.retreat.close)} of its units and retreats to the nearest town its side holds, if it can reach one; neutral defenders do not retreat.</p>
    <p>An army halts at the first town on its route that you do not hold. A walled town must be besieged first: ${r.siege.perFort} s per level of fortification, plus the time for its size. A full siege takes the fortifications out of the fight;
      each artillery piece speeds it by ${pct(r.siegeGuns.each)}. You can storm early and face the walls in full. An army arriving at its own besieged town fights the besiegers, with the garrison adding ${pct(r.sortie)} of its attack.</p>
    <h3>Roads, rail and sea</h3>
    <p>Armies follow roads, and choose the quickest route for what they are. Cutting a road costs ${r.roads.cut} (${r.roads.cutBridge} at a bridge) and mending it ${r.roads.repair} (${r.roads.repairBridge} and longer at a bridge); you need a town at one end.
      Railways (${r.speed.infantry.rail} km/h) and sea crossings (${r.speed.infantry.sea} km/h) carry any army, but only between two towns you hold.</p>
    <h3>Other ways to gain ground</h3>
    <p>A neutral town one road from yours, and in sight, can be bought: the price rises with its defenders and its size, and half of them stay on as your garrison.
      A truce with a rival costs ${r.truce.perTown} per town it holds (at least ${r.truce.min}) and lasts ${Math.round(r.truce.lasts / 60)} minutes, during which neither of you can attack the other.</p>`;
}
function openGuide(on) {
  $('guide').style.display = on ? 'flex' : 'none';
  if (on) { $('guide-body').innerHTML = guideHtml(); $('help').style.display = 'none'; }
}
$('open-guide').addEventListener('click', () => openGuide(true));
$('close-guide').addEventListener('click', () => openGuide(false));

// ----- Alerts -----
// What needs attention right now, as a column of buttons. Click one to go to the next place it is about.

function alertsNow() {
  const own = game.graph.towns.filter((t) => mine(t.id));
  const at = (t) => ({ x: t.x, y: t.y, pick: { towns: [t.id] } });
  const of = (a) => { const [x, y] = a.at ? [town(a.at).x, town(a.at).y] : armyPoint(a); return { x, y, pick: { army: a.id } }; };
  return [
    { kind: 'attack', icon: ICON.threat, color: '#d1345b', title: 'under siege or with an enemy army on its way', places: own.filter((t) => state(t.id).besieged || threatsTo(t.id).length).map(at) },
    { kind: 'siege', icon: UI.fort, color: '#d97706', title: 'of your armies besieging a town', places: live.armies.filter((a) => myArmy(a) && a.siege).map(of) },
    { kind: 'idle', icon: UI.flag, color: '#1f6feb', title: 'of your armies camped and waiting for orders', places: live.armies.filter(camped).map(of) },
    { kind: 'cut', icon: ICON.cut, color: '#d97706', title: 'cut off from your capital and earning half', places: own.filter((t) => state(t.id).supplied === false).map(at) },
    { kind: 'built', icon: UI.base, color: '#2e7d32', title: 'just finished building', places: live.events.filter((e) => e.kind === 'built' && e.at && live.clock - e.clock < 25).map((e) => ({ x: e.at[0], y: e.at[1], pick: {} })) },
  ].filter((a) => a.places.length);
}

let alertsKey = '';
function drawAlerts() {
  const list = alertsNow();
  const key = JSON.stringify(list.map((a) => [a.kind, a.places.length]));
  if (key === alertsKey) return;
  alertsKey = key;
  $('alerts').innerHTML = list.map((a) => `<button class="alert" data-alert="${a.kind}" style="--c:${a.color}" title="${a.places.length} ${a.title} — click to go there">
    ${a.icon}<span class="count">${a.places.length}</span></button>`).join('');
}
$('alerts').addEventListener('click', (e) => {
  const b = e.target.closest('[data-alert]');
  const a = b && alertsNow().find((x) => x.kind === b.dataset.alert);
  if (!a) return;
  cycle[a.kind] = ((cycle[a.kind] ?? -1) + 1) % a.places.length;
  const place = a.places[cycle[a.kind]];
  if (place.pick.towns || place.pick.army !== undefined) select(place.pick);
  goTo(place.x, place.y);
});

// ----- Minimap -----

function miniScale() {
  const c = $('mini'), b = game.world.boundsM;
  const k = Math.min(c.width / (b.maxx - b.minx), c.height / (b.maxy - b.miny));
  const ox = (c.width - (b.maxx - b.minx) * k) / 2, oy = (c.height - (b.maxy - b.miny) * k) / 2;
  return { k, to: (x, y) => [ox + (x - b.minx) * k, c.height - oy - (y - b.miny) * k], from: (px, py) => [b.minx + (px - ox) / k, b.miny + (c.height - oy - py) / k] };
}

let miniPicture = null;   // the terrain picture behind the minimap, and which map it is of
function drawMini() {
  if (!game || !live || !map) return;
  const c = $('mini'), g = c.getContext('2d'), { k, to } = miniScale(), b = game.world.boundsM;
  g.clearRect(0, 0, c.width, c.height);
  g.fillStyle = '#e6e9dc';
  const [x0, y1] = to(b.minx, b.miny), [x1, y0] = to(b.maxx, b.maxy);
  g.fillRect(x0, y0, x1 - x0, y1 - y0);
  const want = `/api/conquer/${game.world.id}/mini?v=${game.world.version}`;
  if (miniPicture?.src !== want) {
    const img = new Image();
    img.onload = () => { if (miniPicture?.img === img) { miniPicture.ready = true; drawMini(); } };
    img.src = want;
    miniPicture = { src: want, img, ready: false };
  }
  if (miniPicture.ready) {
    // The picture is a square from the south-west corner; only the part inside the map is shown.
    const side = Math.max(b.maxx - b.minx, b.maxy - b.miny) * k;
    g.save();
    g.beginPath(); g.rect(x0, y0, x1 - x0, y1 - y0); g.clip();
    g.drawImage(miniPicture.img, x0, y1 - side, side, side);
    g.restore();
  }
  for (const p of land) {
    g.fillStyle = `${colorOf(p.owner)}66`;
    g.beginPath();
    for (const r of p.rings) { r.forEach(([x, y], i) => { const q = to(x, y); if (i) g.lineTo(q[0], q[1]); else g.moveTo(q[0], q[1]); }); g.closePath(); }
    g.fill('evenodd');
  }
  // Fog: everything outside what you can see is dimmed, as on the main map.
  if (seen.length) {
    g.fillStyle = 'rgba(39, 49, 61, 0.28)';
    g.beginPath();
    g.rect(x0, y0, x1 - x0, y1 - y0);
    for (const r of seen) { r.forEach(([x, y], i) => { const q = to(x, y); if (i) g.lineTo(q[0], q[1]); else g.moveTo(q[0], q[1]); }); g.closePath(); }
    g.fill('evenodd');
  }
  for (const t of game.graph.towns) {
    const [x, y] = to(t.x, t.y), s = state(t.id);
    g.fillStyle = colorOf(s.owner);
    g.beginPath();
    g.arc(x, y, 2.5 + t.tier * 0.9, 0, Math.PI * 2);
    g.fill();
    if (s.besieged || threatsTo(t.id).length) { g.strokeStyle = '#d1345b'; g.lineWidth = 2; g.beginPath(); g.arc(x, y, 6 + t.tier, 0, Math.PI * 2); g.stroke(); }
  }
  for (const a of live.armies) {
    if (a.at) continue;
    const [x, y] = to(...armyPoint(a));
    g.fillStyle = colorOf(a.owner);
    g.strokeStyle = '#ffffff';
    g.lineWidth = 1;
    g.fillRect(x - 3, y - 3, 6, 6);
    g.strokeRect(x - 3, y - 3, 6, 6);
  }
  // Whatever the pointer is on in the sidebar lists is ringed here too, so it can be found when it is off screen.
  const lit = hot.town ? town(hot.town) : null, litArmy = hot.army !== null ? army(hot.army) : null;
  const at = lit ? to(lit.x, lit.y) : litArmy ? to(...armyPoint(litArmy)) : null;
  if (at) {
    for (const [colour, width] of [['#1f2933', 5], ['#ffd84a', 2.5]]) { g.strokeStyle = colour; g.lineWidth = width; g.beginPath(); g.arc(at[0], at[1], 11, 0, Math.PI * 2); g.stroke(); }
  }
  // The part of the map on screen.
  const v = map.getBounds(), [vx0, vy0] = toMetres(v.getWest(), v.getSouth()), [vx1, vy1] = toMetres(v.getEast(), v.getNorth());
  const [a0, b1] = to(vx0, vy0), [a1, b0] = to(vx1, vy1);
  g.strokeStyle = '#1f2933';
  g.lineWidth = 1.5;
  g.strokeRect(Math.max(1, a0), Math.max(1, b0), Math.min(c.width - 2, a1) - Math.max(1, a0), Math.min(c.height - 2, b1) - Math.max(1, b0));
}
{
  // Click or drag on the minimap to look there.
  const look = (e) => {
    if (!map || !game) return;
    const c = $('mini'), r = c.getBoundingClientRect();
    const [x, y] = miniScale().from(((e.clientX - r.left) * c.width) / r.width, ((e.clientY - r.top) * c.height) / r.height);
    map.jumpTo({ center: toLngLat(x, y) });
  };
  $('mini').addEventListener('mousedown', (e) => {
    look(e);
    const up = () => { document.removeEventListener('mousemove', look); document.removeEventListener('mouseup', up); };
    document.addEventListener('mousemove', look);
    document.addEventListener('mouseup', up);
  });
}

// ----- Command bar -----
// Laid out like a strategy game's campaign panel: who is selected on the left, their
// units as a row of cards in the middle, and square slots for everything they can do
// on the right. Pictures and numbers first; the words are in the tooltips.

const svg = (body) => `<svg viewBox="0 0 24 24" aria-hidden="true">${body}</svg>`;
const UI = {
  infantry: svg('<circle cx="12" cy="6.500" r="3.500" fill="currentColor"/><path d="M5 21v-4.500C5 13 8 11.500 12 11.500s7 1.500 7 5V21Z" fill="currentColor"/><path d="M7.500 5.500h9" stroke="currentColor" stroke-width="2.400" stroke-linecap="round"/>'),
  scout: svg('<circle cx="7" cy="14" r="4.500" fill="none" stroke="currentColor" stroke-width="2.400"/><circle cx="17" cy="14" r="4.500" fill="none" stroke="currentColor" stroke-width="2.400"/><path d="M11.500 13h1M4 10l2-5h2M20 10l-2-5h-2" fill="none" stroke="currentColor" stroke-width="2.200" stroke-linecap="round"/>'),
  artillery: svg('<path d="M3 13 17 5l2 3.500L7 16Z" fill="currentColor"/><circle cx="9" cy="17" r="4" fill="none" stroke="currentColor" stroke-width="2.400"/><path d="M13 19h7" stroke="currentColor" stroke-width="2.400" stroke-linecap="round"/>'),
  vehicle: svg('<path d="M2 15V8.500h11V15M13 10.500h4.500L21 13.500V15" fill="none" stroke="currentColor" stroke-width="2.200" stroke-linejoin="round"/><rect x="2" y="8.500" width="11" height="6.500" fill="currentColor"/><circle cx="7" cy="17" r="2.600" fill="currentColor"/><circle cx="17" cy="17" r="2.600" fill="currentColor"/>'),
  base: svg('<path d="M4 12.500 12 6l8 6.500M4 19l8-6.500 8 6.500" fill="none" stroke="currentColor" stroke-width="2.800" stroke-linecap="round" stroke-linejoin="round"/>'),
  factory: svg('<path d="M2.500 21V10l6 4v-4l6 4V4.500H20V21Z" fill="currentColor"/>'),
  market: svg('<circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2.400"/><path d="M12 6.500v11M9 9.500h4.500a2 2 0 0 1 0 4H9.500" fill="none" stroke="currentColor" stroke-width="2"/>'),
  fort: svg('<path d="M3 21V6h3.500v3H10V6h4v3h3.500V6H21v15Z" fill="currentColor"/>'),
  flag: svg('<path d="M6 21V3" stroke="currentColor" stroke-width="2.400" stroke-linecap="round"/><path d="M6 4h12l-3 4 3 4H6Z" fill="currentColor"/>'),
  road: svg('<path d="M7 21 9.500 3M17 21 14.500 3" stroke="currentColor" stroke-width="2.200" stroke-linecap="round"/><path d="M12 5v3M12 11v3M12 17v3" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>'),
  cut: svg('<path d="M3 12h6M15 12h6" stroke="currentColor" stroke-width="3.200" stroke-linecap="round"/><path d="m9.500 7 5 10M14.500 7l-5 10" stroke="#c62828" stroke-width="2.600" stroke-linecap="round"/>'),
  repair: svg('<path d="M14.500 3.500a5 5 0 0 0-4.300 7.300L3.500 17.500l3 3 6.700-6.700A5 5 0 0 0 20.500 9.500l-3.200 3.200-3-3 3.200-3.200a5 5 0 0 0-3-3Z" fill="currentColor"/>'),
  go: svg('<path d="M4 12h13M12 6l6 6-6 6" fill="none" stroke="currentColor" stroke-width="2.800" stroke-linecap="round" stroke-linejoin="round"/>'),
  back: svg('<path d="M9 7 4 12l5 5M4 12h10a5 5 0 0 0 5-5V5" fill="none" stroke="currentColor" stroke-width="2.800" stroke-linecap="round" stroke-linejoin="round"/>'),
  coin: svg('<circle cx="12" cy="12" r="9" fill="currentColor"/><path d="M12 7v10" stroke="#fff" stroke-width="2"/>'),
  shield: svg('<path d="M12 2.500 20 5.500v6c0 4.800-3.400 8.300-8 10-4.600-1.700-8-5.200-8-10v-6Z" fill="currentColor"/>'),
  hill: svg('<path d="M2 20 9 7l4 7 3-4 6 10Z" fill="currentColor"/>'),
  river: svg('<path d="M2 8c3-3 5 3 8 0s5 3 8 0 3 1 4 0M2 15c3-3 5 3 8 0s5 3 8 0 3 1 4 0" fill="none" stroke="currentColor" stroke-width="2.400" stroke-linecap="round"/>'),
  port: svg('<circle cx="12" cy="5" r="2.200" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12 7.500V21M5 13c0 5 3.500 8 7 8s7-3 7-8M8 11h8" fill="none" stroke="currentColor" stroke-width="2.200" stroke-linecap="round"/>'),
  rail: svg('<path d="M7 3v18M17 3v18M7 7h10M7 12h10M7 17h10" stroke="currentColor" stroke-width="2.200" stroke-linecap="round"/>'),
  merge: svg('<path d="M5 4v5a7 7 0 0 0 7 7M19 4v5a7 7 0 0 1-7 7v5M8.500 18 12 21.500l3.500-3.500" fill="none" stroke="currentColor" stroke-width="2.600" stroke-linecap="round" stroke-linejoin="round"/>'),
  split: svg('<path d="M12 21v-5a7 7 0 0 0-7-7V4M12 16a7 7 0 0 1 7-7V4M2 7.500 5 4l3 3.500M16 7.500 19 4l3 3.500" fill="none" stroke="currentColor" stroke-width="2.600" stroke-linecap="round" stroke-linejoin="round"/>'),
  repeat: svg('<path d="M5 11a7 7 0 0 1 12-4.500L19 8.500M19 13a7 7 0 0 1-12 4.500L5 15.500M19 4v4.500h-4.500M5 20v-4.500h4.500" fill="none" stroke="currentColor" stroke-width="2.300" stroke-linecap="round" stroke-linejoin="round"/>'),
};

// Units are shown as cards. Big garrisons are dealt into stacks so the row stays short.
let picked = new Set();   // card indexes chosen to move
let pickAll = true;       // everyone goes unless the player has picked cards
let lastCard = 0;
const stackOf = (n) => (n <= 24 ? 1 : n <= 120 ? 5 : 20);
function cardsOf(units) {
  const size = stackOf(total(units)), out = [];
  for (const kind of game.unitKinds) for (let left = units?.[kind] || 0; left > 0; left -= size) out.push({ kind, n: Math.min(size, left) });
  return out;
}
/** How many of each unit the picked cards add up to, out of the units the tray is showing. */
function pickedOf(units) {
  const g = units ?? {};
  if (pickAll) return Object.fromEntries(game.unitKinds.map((k) => [k, g[k] || 0]));
  const out = Object.fromEntries(game.unitKinds.map((k) => [k, 0]));
  cardsOf(g).forEach((c, i) => { if (picked.has(i)) out[c.kind] += c.n; });
  return out;
}
const pickedUnits = (id) => pickedOf(state(id).garrison);
/** The units whose cards can be picked right now: the selected army's, or the selected town's garrison. */
const trayUnits = () => (selArmy !== null ? army(selArmy) : state(selTowns[0])?.garrison);

function tray(units, owner, selectable) {
  const cards = cardsOf(units);
  if (!cards.length) return '<div class="tray empty">No units</div>';
  return `<div class="tray">${cards.map((c, i) => `<button class="unit ${selectable ? (pickAll || picked.has(i) ? 'in' : 'out') : 'fixed'}" style="--c:${colorOf(owner)}"
    ${selectable ? `data-card="${i}"` : 'disabled'} title="${c.n > 1 ? `${c.n} ` : ''}${game.rules.units[c.kind].name}${selectable ? ' — click to pick just this one, Ctrl-click to add or remove, double-click for all of this kind' : ''}">
    ${artReady ? picture(c.kind, colorOf(owner)) : UI[c.kind]}${c.n > 1 ? `<span class="n">${c.n}</span>` : ''}</button>`).join('')}</div>`;
}

/** One square action. Icon and number carry the meaning; `title` holds the sentence. */
function slot({ key, icon, art = null, does, title, price, caption, disabled = false, cls = '', meter = '', badge = '', pips = null, at = '', corner = '' }) {
  const shown = key ? `<kbd>${key.toUpperCase()}</kbd>` : '';
  const dots = pips ? `<span class="pips">${Array.from({ length: pips[1] }, (_, i) => `<i class="${i < pips[0] ? 'on' : ''}"></i>`).join('')}</span>` : '';
  return `<div class="cell"><button class="slot ${cls}" data-do="${does}" ${at ? `data-town="${at}"` : ''} ${key ? `data-key="${key}"` : ''} ${disabled ? 'disabled' : ''} title="${esc(title)}">
    ${shown}${art ?? `<span class="ico">${icon}</span>`}<span class="sr">${esc(title)}</span>${meter ? `<span class="wipe" data-meter="${meter}"></span>` : ''}${badge ? `<span class="count">${badge}</span>` : ''}${dots}</button>
    <span class="cap">${price != null ? `<b>${price}</b>` : ''}${caption ? esc(caption) : ''}</span>${corner}</div>`;
}
const chip = (icon, text, title, color = '') => `<span class="chip" title="${esc(title)}" ${color ? `style="color:${color}"` : ''}>${icon}<b>${text}</b></span>`;
/** A picture for a slot or tile, or null (so the plain icon shows) when pictures cannot be drawn. */
const art = (kind, extra = '') => (artReady ? `<span class="ico art">${picture(kind, colorOf(PLAYER), extra)}</span>` : null);
/** Who is selected: a portrait when there is one, then the name, a line about it, and its numbers. */
const who = (title, sub, owner, chips = '', portrait = null) => `<div class="who" style="--c:${colorOf(owner)}">${artReady && portrait ? `<div class="face">${picture(portrait[0], colorOf(owner), portrait[1] ?? '')}</div>` : ''}
  <div class="about"><h2>${title}</h2><div class="sub">${sub}</div><div class="chips">${chips}</div></div></div>`;
const townFace = (t) => ['town', `${t.tier}${t.traits.hill ? 'h' : ''}${t.traits.river ? 'r' : ''}${t.traits.port ? 'p' : ''}`];

function cmdHtml() {
  const cash = live.me.money, rules = game.rules;
  if (selArmy !== null) {
    const a = army(selArmy);
    if (!a) return '';
    const own = myArmy(a), free = camped(a), n = total(a);
    const where = a.siege ? `besieging ${town(a.at).name}` : a.retreating ? `retreating to ${town(a.to).name}` : a.at ? `camped at ${town(a.at).name}` : `marching to ${town(a.to).name}`;
    const chips = chip(UI.shield, (attackPower(a) * veteran(a)).toFixed(1), `Attack strength${a.stars ? `, including +${a.stars * 10}% for experience` : ''}`)
      + (a.stars ? chip('', '★'.repeat(a.stars), `${a.stars} of ${rules.experience.max} stars: one for each fight won, each adding ${rules.experience.perStar * 100}% strength`, '#e3b341') : '')
      + (a.siege ? chip(UI.fort, `${Math.round(100 * a.siege.progress / a.siege.need)}%`, `Siege: ${Math.round(a.siege.need - a.siege.progress)} s until the walls are breached`, '#f59e0b') : '');
    let html = who(esc(a.name), `${own ? '' : `${esc(faction(a.owner).name)} · `}${esc(where)}`, a.owner, chips, ['army']);
    const going = free ? total(pickedOf(a)) : n;
    html += `<div class="mid"><div class="pick"><span><b>${free ? going : n}</b>${free ? ` of ${n} selected` : ` unit${n > 1 ? 's' : ''}`}</span>
      ${free && n > 1 ? `<button data-do="pick:all" data-key="a" class="mini ${pickAll ? 'on' : ''}" title="Select every unit (A)">All</button><button data-do="pick:half" class="mini" title="Select half">Half</button>` : ''}
      <span class="tip">${!own ? '' : a.retreating ? 'falling back, takes no orders' : 'drag or right-click to send'}</span></div>${tray(a, a.owner, free)}</div>`;
    if (!own) return html;
    html += '<div class="slots">';
    if (!a.retreating) html += slot({ key: 's', icon: UI.go, does: 'mode:redirect', cls: mode === 'redirect' ? 'on' : '', caption: mode === 'redirect' ? 'click a town' : 'March', title: 'Send this army to a town' });
    if (a.siege) html += slot({ key: 't', icon: UI.fort, does: 'storm', caption: 'Storm', title: 'Attack now instead of waiting for the siege, against the full fortifications' });
    if (!a.at && !a.retreating) html += slot({ key: 'b', icon: UI.back, does: 'recall', caption: 'Recall', title: `Turn back to ${town(a.from).name}` });
    const others = a.at ? armiesAt(a.at).filter((o) => o !== a && o.owner === PLAYER && !o.retreating && !!o.siege === !!a.siege).length : 0;
    if (others) html += slot({ key: 'g', icon: UI.merge, does: 'merge', caption: 'Merge', badge: others + 1, title: `Combine with the ${others > 1 ? `${others} other armies` : 'other army'} here` });
    if (free) {
      html += slot({ key: 'x', icon: UI.split, does: 'split', caption: 'Split', disabled: pickAll || !going || going >= n, title: 'Pick some of its cards, then split them off as a new army' });
      if (total(state(a.at).garrison)) html += slot({ key: 'j', icon: UI.merge, does: 'reinforce', caption: 'Take all', badge: total(state(a.at).garrison), title: `Add the whole garrison of ${town(a.at).name} to this army` });
      html += slot({ key: 'v', icon: UI.fort, does: 'garrison', caption: 'Disband', title: `Stand down: dissolve the army into the garrison of ${town(a.at).name}` });
    }
    html += slot({ key: 'n', icon: UI.flag, does: 'rename', caption: 'Rename', title: 'Give this army a name' });
    return `${html}</div>`;
  }
  if (selMany.length) {
    const list = selMany.map(army).filter(Boolean);
    const sum = Object.fromEntries(game.unitKinds.map((k) => [k, list.reduce((n, a) => n + (a[k] || 0), 0)]));
    const together = list.every((a) => a.at && a.at === list[0].at && !a.siege);
    return who(`${list.length} armies`, list.map((a) => esc(a.name)).join(', '), PLAYER, chip(UI.shield, attackPower(sum).toFixed(0), 'Combined attack strength'), ['army'])
      + `<div class="mid"><div class="pick"><span><b>${total(sum)}</b> units</span><span class="tip">right-click a town to send them all</span></div>${tray(sum, PLAYER, false)}</div>
      <div class="slots">${slot({ key: 's', icon: UI.go, does: 'mode:redirect', cls: mode === 'redirect' ? 'on' : '', caption: mode === 'redirect' ? 'click a town' : 'March', title: 'Send all these armies to a town' })}
      ${together ? slot({ key: 'g', icon: UI.merge, does: 'mergemany', caption: 'Merge', badge: list.length, title: 'Combine these armies into one' }) : ''}</div>`;
  }
  if (selRoad) {
    const r = roadOf(selRoad), c = cutState(r.id), bridge = r.bridges.length > 0, k = rules.roads, can = mine(r.a) || mine(r.b);
    const cutCost = bridge ? k.cutBridge : k.cut, fixCost = bridge ? k.repairBridge : k.repair;
    const status = c ? (c.repair >= 0 ? 'Being repaired' : 'Cut — nobody can use it') : 'Open';
    const rail = r.kind === 'rail' || r.kind === 'sea', sea = r.kind === 'sea';
    return who(sea ? 'Sea crossing' : rail ? 'Railway' : r.ref || 'Road', `${esc(town(r.a).name)} – ${esc(town(r.b).name)}`, 0,
      chip(rail ? UI.rail : UI.road, `${(r.length / 1000).toFixed(1)} km`, sea ? 'Sea crossing between two ports: usable only while you hold both, and it cannot be cut' : rail ? 'Railway: armies travel it at train speed, but only while you hold both ends' : `${r.kind} road${bridge ? ' with a bridge' : ''}`)
      + chip(UI.vehicle, `${rules.speed.vehicle[r.kind] ?? rules.speed.vehicle.tertiary}`, rail ? 'Train speed, km/h, for every kind of unit' : 'Vehicle speed here, km/h'))
      + `<div class="mid"><div class="tray empty">${status}</div><div class="tip">${can ? 'A cut road isolates the towns beyond it; cut off from their capital they earn half' : 'Hold a town at one end to cut or repair this road'}</div></div>
      <div class="slots">${c
        ? slot({ key: 'e', icon: UI.repair, does: `repair:${r.id}`, price: fixCost, caption: '', disabled: !can || c.repair >= 0 || cash < fixCost, title: 'Repair the road' })
        : sea ? '' : slot({ key: 'c', icon: UI.cut, does: `cut:${r.id}`, price: cutCost, caption: '', disabled: !can || cash < cutCost, title: bridge ? 'Blow the bridge: cheap to do, slow and costly to mend' : 'Cut the road' })}</div>`;
  }
  if (selTowns.length > 1) {
    const sum = Object.fromEntries(game.unitKinds.map((k) => [k, selTowns.reduce((n, id) => n + (state(id).garrison?.[k] ?? 0), 0)]));
    return who(`${selTowns.length} towns`, selTowns.map((id) => esc(town(id).name)).join(', '), PLAYER, chip(UI.shield, attackPower(sum).toFixed(0), 'Combined attack strength'))
      + `<div class="mid">${tray(sum, PLAYER, false)}<div class="tip">Right-click a town to send everyone; each town's units travel as their own group</div></div>`;
  }
  if (selTowns.length !== 1) return '';
  const id = selTowns[0], t = town(id), s = state(id), own = s.owner === PLAYER;
  const traits = (t.traits.hill ? chip(UI.hill, '', 'Hill site: +25% defence') : '') + (t.traits.river ? chip(UI.river, '', 'River: +25% defence') : '')
    + (t.traits.port ? chip(UI.port, '', 'Port: +25% income') : '') + (t.traits.rail ? chip(UI.rail, '', 'Railway: +25% income') : '');
  if (!own) {
    const strength = s.visible ? defencePower(s.garrison, s.defence).toFixed(1) : '?';
    return who(esc(t.name), `${TIERS[t.tier]} · ${ownerName(s.owner)}`, Math.max(0, s.owner),
      chip(UI.shield, strength, `Defence strength (defenders × ${s.defence.toFixed(2)})`, '#aab4bf') + traits, townFace(t))
      + `<div class="mid">${s.visible ? tray(s.force, Math.max(0, s.owner), false) : '<div class="tray empty">Defenders unknown — out of sight</div>'}
        <div class="tip">Drag one of your towns or armies here to attack${s.siege ? `; it needs a ${Math.round(s.siege)} s siege` : ''}</div></div>`
      + (s.bribe != null ? `<div class="slots">${slot({ key: 'u', icon: UI.coin, does: 'bribe', price: s.bribe, caption: '', disabled: live.me.money < s.bribe,
        title: 'Buy the town: it comes over without a fight and half its defenders stay on as your garrison. Only for neutral towns one road from a town of yours.' })}</div>` : '');
  }
  const units = pickedUnits(id), going = total(units), all = total(s.garrison);
  let html = who(esc(t.name), `${TIERS[t.tier]}${live.me.capital === id ? ' · capital' : ''}`, PLAYER,
    chip(UI.coin, `+${Math.round(s.income)}`, `Earns ${Math.round(s.income)} a minute${s.supplied ? '' : ' — halved, cut off from your capital'}`, s.supplied ? '#e3b341' : '#f59e0b')
    + chip(UI.shield, s.strength.toFixed(1), `Defence strength: garrison and camped armies × ${s.defence.toFixed(2)}`, '#aab4bf') + traits, townFace(t));
  const here = armiesAt(id).filter((a) => a.owner === PLAYER);
  const banners = here.length ? `<div class="banners">${here.map((a) => `<button class="banner" data-army="${a.id}" title="Select ${esc(a.name)}">${UI.flag}<b>${esc(a.name)}</b> ${total(a)}</button>`).join('')}</div>` : '';
  html += `<div class="mid">${banners}<div class="pick"><span title="Units of the garrison picked to move">${all ? `<b>${going}</b> of ${all} selected` : 'Garrison'}</span>
      ${all > 1 ? `<button data-do="pick:all" data-key="a" class="mini ${pickAll ? 'on' : ''}" title="Select every unit (A)">All</button><button data-do="pick:half" class="mini" title="Select half">Half</button>` : ''}
      ${all ? `<span class="tip">drag or right-click to send</span>` : ''}</div>${tray(s.garrison, PLAYER, true)}</div><div class="slots">`;
  const callable = game.graph.roads.some((r) => (r.a === id || r.b === id) && !cutState(r.id) && mine(r.a === id ? r.b : r.a) && total(state(r.a === id ? r.b : r.a).garrison));
  if (callable) html += slot({ key: 'c', icon: UI.merge, does: 'gather', caption: 'Gather', title: 'Call in the garrisons of your neighbouring towns to join the garrison here' });
  if (all) html += slot({ key: 'y', icon: UI.flag, does: 'muster', caption: 'Muster', disabled: !going, title: 'Form the selected units into an army camped here, ready for orders' }) + '<span class="gap"></span>';
  for (const [kind, rule] of Object.entries(rules.buildings)) {
    const b = s.buildings[kind], icon = kind === 'barracks' ? UI.base : UI.factory, key = BUILD_KEY[kind];
    const makes = rule.trains.map((u) => rules.units[u].name.toLowerCase()).join(' and ');
    if (!b) html += slot({ key, icon, art: art(kind), does: `build:${kind}`, price: rule.cost, cls: 'empty', disabled: cash < rule.cost, title: `Build ${rule.name.toLowerCase()} — lets you train ${makes}` });
    else if (!b.done) html += slot({ key, icon, art: art(kind), does: 'none', caption: 'building', disabled: true, meter: `${id}|${kind}`, title: `${rule.name} under construction` });
    else {
      for (const u of rule.trains) {
        const unit = rules.units[u], line = b.lines[u], k = UNIT_KEY[u];
        const what = u === 'scout' ? ' Fast, sees a long way, hardly fights.' : u === 'artillery' ? ' Slow; five times the attack against towns, and speeds up sieges.' : '';
        html += slot({ key: k, icon: UI[u], art: art(u), does: `train:${u}`, price: unit.cost, cls: cash < unit.cost ? 'poor' : '', meter: `${id}|${kind}|${u}`, badge: line.queue || '',
          title: `Train ${unit.name.toLowerCase()} — click to queue one, Shift-click for five, right-click to cancel one.${what}${line.queue ? ` ${line.queue} in training.` : ''}`,
          corner: `<button class="mini repeat ${line.repeat ? 'on' : ''}" data-do="repeat:${u}" data-key="${k.toUpperCase()}" title="Keep training ${unit.name.toLowerCase()} while there is money (Shift+${k.toUpperCase()})">${UI.repeat}</button>` });
      }
    }
  }
  html += '<span class="gap"></span>';
  [['market', 'm', UI.market], ['fort', 'f', UI.fort]].forEach(([kind, key, icon]) => {
    const rule = rules.upgrades[kind], level = kind === 'market' ? s.market : s.fort, top = level >= rules.maxLevel;
    html += slot({ key: top ? '' : key, icon, art: art(kind), does: top ? 'none' : `upgrade:${kind}`, price: top ? null : s.costs[kind], caption: top ? 'max' : '', pips: [level, rules.maxLevel],
      disabled: top || cash < s.costs[kind], title: `${rule.name} level ${level} of ${rules.maxLevel}: each level adds ${rule.perLevel * 100}% ${rule.effect}` });
  });
  html += '<span class="gap"></span>';
  html += slot({ key: 'r', icon: UI.flag, does: 'mode:rally', cls: mode === 'rally' ? 'on' : s.rally ? 'set' : '', caption: mode === 'rally' ? 'click a town' : s.rally ? town(s.rally).name : 'Rally',
    title: s.rally ? `New units march to ${town(s.rally).name}. Click to change, Shift+R to clear` : 'Choose a town for newly trained units to march to' });
  if (s.rally) html += `<button class="mini repeat" data-do="norally" data-key="R" title="Clear the rally point (Shift+R)">✕</button>`;
  html += slot({ key: 'd', icon: UI.road, does: 'details', cls: details ? 'on' : '', caption: 'Roads', title: 'Show the roads from this town, to cut or repair them' });
  return `${html}</div>`;
}

function roadRows(roads, from) {
  return roads.map((r) => {
    const c = cutState(r.id), bridge = r.bridges.length > 0, k = game.rules.roads, cash = live.me.money;
    let action = '';
    if (c?.repair >= 0) action = '<span>being repaired</span>';
    else if (r.kind === 'sea') action = '';
    else if (c) action = `<button data-do="repair:${r.id}" ${cash < (bridge ? k.repairBridge : k.repair) ? 'disabled' : ''}>Repair<span class="cost">${bridge ? k.repairBridge : k.repair}</span></button>`;
    else action = `<button data-do="cut:${r.id}" ${cash < (bridge ? k.cutBridge : k.cut) ? 'disabled' : ''}>Cut<span class="cost">${bridge ? k.cutBridge : k.cut}</span></button>`;
    return `<div class="row road"><span style="flex:1">${r.kind === 'sea' ? 'Sea crossing' : r.kind === 'rail' ? 'Railway' : r.ref || r.kind[0].toUpperCase() + r.kind.slice(1)} to ${esc(town(r.a === from ? r.b : r.a).name)}<br><span class="hint">${(r.length / 1000).toFixed(1)} km${bridge ? ', bridge' : ''}</span></span>${action}</div>`;
  }).join('');
}

function panelHtml() {
  if (!details || selTowns.length !== 1 || !mine(selTowns[0])) return '';
  const id = selTowns[0];
  return `<h3>Roads from ${esc(town(id).name)}</h3>${roadRows(game.graph.roads.filter((r) => r.a === id || r.b === id), id)}`;
}

/** Unit cards are as large as one row allows. When a single row would make them smaller than two rows would, they go to two rows. */
function sizeTray() {
  const tray = $('cmd').querySelector('.tray:not(.empty)');
  if (!tray) return;
  const GAP = 5, PAD = 6, SMALLEST = 28, n = tray.children.length;
  const others = [...tray.parentElement.children].filter((el) => el !== tray);
  const high = $('cmd').clientHeight - 20 - others.reduce((h, el) => h + el.offsetHeight + GAP, 0) - PAD;
  const wide = tray.clientWidth - PAD;
  const fit = (perRow) => Math.floor((wide - GAP * (perRow - 1)) / perRow);
  const twoRows = Math.floor((high - GAP) / 2);
  const oneRow = Math.min(high, fit(n));
  const size = oneRow >= twoRows ? oneRow : Math.max(SMALLEST, Math.min(twoRows, fit(Math.ceil(n / 2))));
  tray.style.setProperty('--card', `${size}px`);
  tray.style.maxHeight = `${high + PAD}px`;
}
addEventListener('resize', sizeTray);

function renderUi(force) {
  const s = selTowns.length === 1 ? state(selTowns[0]) : null;
  // Rebuild only when something other than a progress bar changes, so clicks are never lost mid-press.
  const afford = [50, 60, 100, 120, 150, 200, 240, 300, 350, 360, 400, 500, 600, 800, 1000, 1500].map((c) => live.me.money >= c);
  const g = selArmy !== null ? army(selArmy) : null;
  const key = JSON.stringify([selTowns, selArmy, selRoad, mode, details, afford, live.roads, pickAll, [...picked], selMany.map((id) => { const a = army(id); return a && [a.id, a.at, total(a)]; }),
    g && [g.name, g.at, g.to, total(g), g.at && total(state(g.at).garrison ?? {}), g.retreating, g.siege && Math.round(100 * g.siege.progress / g.siege.need), g.at && armiesAt(g.at).length],
    selTowns.map((id) => armiesAt(id).map((a) => [a.id, a.name, total(a)])),
    selTowns.length === 1 && mine(selTowns[0]) && game.graph.roads.filter((r) => r.a === selTowns[0] || r.b === selTowns[0]).map((r) => { const o = r.a === selTowns[0] ? r.b : r.a; return mine(o) && total(state(o).garrison); }),
    selTowns.map((id) => [state(id).owner, state(id).garrison, state(id).visible, state(id).bribe, state(id).force, state(id).rally, state(id).supplied, state(id).market, state(id).fort, Math.round(state(id).income ?? 0)]),
    s?.buildings && Object.entries(s.buildings).map(([k, b]) => [k, b.done, Object.values(b.lines).map((l) => [l.queue, l.repeat])])]);
  if (force || key !== cmdKey) {
    cmdKey = key;
    // The command bar is always there; with nothing selected it says how to pick something.
    $('cmd').innerHTML = cmdHtml() || `<div class="idle"><b>Nothing selected</b><span>Click a town or an army</span><span><kbd>Tab</kbd> next one waiting for orders</span><span><kbd>H</kbd> capital</span><span><kbd>Shift</kbd> + drag to box-select</span></div>`;
    sizeTray();
    const side = panelHtml();
    if (force || side !== panelKey) { panelKey = side; $('panel').innerHTML = side; $('panel').style.display = side ? 'block' : 'none'; }
  }
  drawProduction();
  drawLists();
  // Progress shows as a clock wipe over the icon: the shaded part is what is left to do.
  for (const m of document.querySelectorAll('[data-meter]')) {
    const [id, kind, unit] = m.dataset.meter.split('|');
    const b = state(id)?.buildings?.[kind], line = unit ? b?.lines[unit] : null;
    const idle = !b || (unit ? !line?.queue : b.done);
    m.style.display = idle ? 'none' : 'block';
    if (!idle) m.style.setProperty('--p', (100 * (unit ? line.training : b.progress)).toFixed(1));
  }
}

// ----- Sidebar lists -----
// Under the minimap: your towns, your armies, or production, one at a time.

let sideTab = 'towns';
try { sideTab = ['towns', 'armies', 'prod'].includes(localStorage.getItem('conquer-side')) ? localStorage.getItem('conquer-side') : 'towns'; } catch { /* storage unavailable */ }
function showSide(tab) {
  sideTab = tab;
  try { localStorage.setItem('conquer-side', tab); } catch { /* fine */ }
  setHot({});
  listsKey = '';
  if (live) drawLists();
}

/** Light up a town or an army: its row in the lists, its badge or marker on the map, and a ring on the minimap. */
function setHot({ town: t = null, army: a = null }) {
  if (t === hot.town && a === hot.army) return;
  badges.get(hot.town)?.el.classList.remove('hot');
  hot = { town: t, army: a };
  badges.get(t)?.el.classList.add('hot');
  markHot();
  drawMini();
}
function markHot() {
  const want = hot.town ? `t:${hot.town}` : hot.army !== null ? `a:${hot.army}` : '';
  for (const el of $('lists').querySelectorAll('.lrow')) el.classList.toggle('hot', el.dataset.row === want);
}

const armyDoing = (a) => (a.siege ? `Besieging ${town(a.at).name}` : a.retreating ? `Retreating to ${town(a.to).name}` : a.at ? `Camped at ${town(a.at).name}` : `Marching to ${town(a.to).name}`);
const leading = (u) => game.unitKinds.reduce((best, k) => ((u[k] || 0) > (u[best] || 0) ? k : best), game.unitKinds[0]);

// How each list is arranged. Towns are sorted; armies are filtered by what they are doing.
const TOWN_SORTS = { size: 'Size', income: 'Income', units: 'Garrison', danger: 'Danger' };
const ARMY_FILTERS = { all: 'All', idle: 'Idle', moving: 'Moving', siege: 'Sieging' };
const armyIs = { all: () => true, idle: (a) => camped(a), moving: (a) => !a.at, siege: (a) => !!a.siege };
let townSort = 'size', armyFilter = 'all';
try {
  if (TOWN_SORTS[localStorage.getItem('conquer-town-sort')]) townSort = localStorage.getItem('conquer-town-sort');
  if (ARMY_FILTERS[localStorage.getItem('conquer-army-filter')]) armyFilter = localStorage.getItem('conquer-army-filter');
} catch { /* storage unavailable */ }
/** How urgently a town needs looking at: under siege, then an enemy on the way, then cut off. */
const dangerOf = (t) => { const s = state(t.id); return s.besieged ? 3 : threatsTo(t.id).length ? 2 : !s.supplied ? 1 : 0; };

function barHtml() {
  if (sideTab === 'towns') return `<span>Sort</span>${Object.entries(TOWN_SORTS).map(([k, label]) => `<button data-sort="${k}" class="${k === townSort ? 'on' : ''}" title="${k === 'size' ? 'Capital first, then the largest towns' : k === 'income' ? 'Richest first' : k === 'units' ? 'Largest garrison first' : 'Towns in trouble first, then the most lightly held'}">${label}</button>`).join('')}`;
  const own = live.armies.filter(myArmy);
  return Object.entries(ARMY_FILTERS).map(([k, label]) => `<button data-filter="${k}" class="${k === armyFilter ? 'on' : ''}" title="${k === 'all' ? 'Every army' : k === 'idle' ? 'Camped in a town of yours, waiting for orders' : k === 'moving' ? 'On the road, marching or retreating' : 'Besieging a town'}">${label} <b>${own.filter(armyIs[k]).length}</b></button>`).join('');
}

function townRows() {
  const capitalFirst = (p, q) => (q.id === live.me.capital) - (p.id === live.me.capital);
  const garrison = (t) => total(state(t.id).garrison);
  const by = {
    size: (p, q) => capitalFirst(p, q) || q.tier - p.tier,
    income: (p, q) => (state(q.id).income ?? 0) - (state(p.id).income ?? 0),
    units: (p, q) => garrison(q) - garrison(p),
    danger: (p, q) => dangerOf(q) - dangerOf(p) || garrison(p) - garrison(q),
  }[townSort];
  const own = game.graph.towns.filter((t) => mine(t.id)).sort((p, q) => by(p, q) || p.name.localeCompare(q.name));
  if (!own.length) return '<p class="hint">You hold no towns.</p>';
  const income = own.reduce((n, t) => n + Math.round(state(t.id).income ?? 0), 0), units = own.reduce((n, t) => n + total(state(t.id).garrison), 0);
  return `<div class="sum"><span><b>${own.length}</b> of ${game.graph.towns.length} towns, <b>${live.goal}</b> to win</span><span><b>${units}</b> units · <b>+${income}</b> a minute</span></div>` + own.map((t) => {
    const s = state(t.id), threat = s.besieged || threatsTo(t.id).length > 0, camps = armiesAt(t.id).filter(myArmy).length;
    const works = [['barracks', ICON.base], ['factory', ICON.factory]].map(([kind, icon]) => { const b = s.buildings?.[kind]; return b ? `<span class="${b.done ? '' : 'dim'}" title="${esc(game.rules.buildings[kind].name)}${b.done ? '' : ' (building)'}">${icon}</span>` : ''; }).join('');
    const extras = `${s.market ? `${ICON.market}${s.market}` : ''}${s.fort ? ` ${ICON.fort}${s.fort}` : ''}`;
    const trouble = s.besieged ? '<span class="bad">under siege</span>' : threat ? '<span class="bad">enemy approaching</span>' : !s.supplied ? '<span class="bad">cut off</span>' : '';
    return `<button class="lrow ${selTowns.includes(t.id) ? 'sel' : ''} ${threat ? 'alarm' : ''}" data-row="t:${t.id}" style="--c:${colorOf(PLAYER)}" title="${esc(t.name)}: click to select and go there, Ctrl-click to add to the selection, right-click to send what is selected here">
      <span class="thumb">${artReady ? picture(...townFace(t).slice(0, 1), colorOf(PLAYER), townFace(t)[1]) : ICON.shield}</span>
      <span class="txt"><span class="name">${esc(t.name)}${t.id === live.me.capital ? ' <i title="Your capital">★</i>' : ''}</span>
        <span class="sub">${trouble || `${TIERS[t.tier]} ${works}${extras}${camps ? ` · ${camps} ${camps > 1 ? 'armies' : 'army'}` : ''}`}</span></span>
      <span class="nums"><span title="Units in the garrison">${ICON.shield}${total(s.garrison)}</span><span class="coin" title="Income a minute">+${Math.round(s.income ?? 0)}</span></span></button>`;
  }).join('');
}

function armyRows() {
  const own = live.armies.filter(myArmy);
  if (!own.length) return '<p class="hint">No armies yet. Send units out of a town, or muster them, to form one.</p>';
  const shown = own.filter(armyIs[armyFilter]);
  return `<div class="sum"><span><b>${own.length}</b> ${own.length > 1 ? 'armies' : 'army'}, <b>${own.reduce((n, a) => n + total(a), 0)}</b> units</span><span>upkeep <b>${own.reduce((n, a) => n + upkeepOf(a), 0)}</b> a minute</span></div>`
    + (shown.length ? '' : `<p class="hint">No army of yours is ${armyFilter === 'idle' ? 'waiting for orders' : armyFilter === 'moving' ? 'on the road' : 'besieging a town'}.</p>`) + shown.map((a) => {
    const kind = leading(a), pc = a.siege ? Math.floor((20 * a.siege.progress) / a.siege.need) * 5 : null;
    const mix = game.unitKinds.filter((k) => a[k]).map((k) => `${a[k]} ${game.rules.units[k].name.toLowerCase()}`).join(', ');
    return `<button class="lrow ${a.id === selArmy || selMany.includes(a.id) ? 'sel' : ''}" data-row="a:${a.id}" style="--c:${colorOf(PLAYER)}" title="${esc(`${a.name}: ${mix}. Click to select and go there, Ctrl-click to add to the selection`)}">
      <span class="thumb">${artReady ? picture(kind, colorOf(PLAYER)) : UI[kind]}</span>
      <span class="txt"><span class="name">${esc(a.name)}${a.stars ? ` <i title="Experience">${'★'.repeat(a.stars)}</i>` : ''}</span>
        <span class="sub ${a.retreating ? 'bad' : ''}">${esc(armyDoing(a))}${pc !== null ? ` · ${pc}%` : ''}</span></span>
      <span class="nums"><span title="Units">${UI[kind]}${total(a)}</span><span class="atk" title="Attack strength">⚔ ${Math.round(attackPower(a))}</span></span>
      ${pc !== null ? `<span class="bar" style="--p:${pc}"><i></i></span>` : ''}</button>`;
  }).join('');
}

let listsKey = '', barKey = '';
function drawLists() {
  const towns = game.graph.towns.filter((t) => mine(t.id)), armies = live.armies.filter(myArmy);
  const alarm = towns.some((t) => state(t.id).besieged || threatsTo(t.id).length);
  $('n-towns').textContent = towns.length;
  $('n-towns').className = alarm ? 'alarm' : '';
  $('n-armies').textContent = armies.length || '';
  $('n-prod').textContent = towns.reduce((n, t) => n + Object.values(state(t.id).buildings ?? {}).reduce((m, b) => m + Object.values(b.lines ?? {}).reduce((q, l) => q + (l.queue || 0), 0), 0), 0) || '';
  for (const b of $('tabs').children) { b.classList.toggle('on', b.dataset.side === sideTab); b.setAttribute('aria-selected', b.dataset.side === sideTab); }
  $('prod').style.display = sideTab === 'prod' ? '' : 'none';
  $('lists').style.display = sideTab === 'prod' ? 'none' : 'block';
  $('lbar').style.display = sideTab === 'prod' ? 'none' : 'flex';
  if (sideTab === 'prod') return;
  const bar = barHtml();
  if (bar !== barKey) { barKey = bar; $('lbar').innerHTML = bar; }
  const html = sideTab === 'towns' ? townRows() : armyRows();
  const key = sideTab + artReady + html;
  if (key === listsKey) return;
  listsKey = key;
  $('lists').innerHTML = html;
  markHot();
}
$('tabs').addEventListener('click', (e) => { const b = e.target.closest('button[data-side]'); if (b) showSide(b.dataset.side); });
{
  const rowOf = (e) => { const el = e.target.closest?.('.lrow'); if (!el) return null; const [what, id] = el.dataset.row.split(':'); return what === 't' ? { town: id } : { army: Number(id) }; };
  // Pointing at a town row with something selected previews the route there, as pointing at the town on the map does.
  $('lists').addEventListener('mouseover', (e) => { const row = rowOf(e); setHot(row ?? {}); hover(row?.town ?? null); });
  $('lists').addEventListener('mouseleave', () => { setHot({}); hover(null); });
  // Right-click a town row to send whatever is selected there, the same as right-clicking the town on the map.
  $('lists').addEventListener('contextmenu', (e) => {
    e.preventDefault();
    const row = rowOf(e);
    if (!row?.town) return;
    if (!canOrder()) return toast('Select an army or a town with units first');
    if (selTowns.length === 1 && selTowns[0] === row.town) return;
    order(row.town, e.shiftKey);
  });
  $('lbar').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.sort) { townSort = b.dataset.sort; try { localStorage.setItem('conquer-town-sort', townSort); } catch { /* fine */ } }
    if (b.dataset.filter) { armyFilter = b.dataset.filter; try { localStorage.setItem('conquer-army-filter', armyFilter); } catch { /* fine */ } }
    drawLists();
    $('lists').scrollTop = 0;
  });
  // The minimap can be made small to give the list more room.
  let compact = false;
  try { compact = localStorage.getItem('conquer-mini') === 'small'; } catch { /* storage unavailable */ }
  const size = () => {
    $('side').classList.toggle('compact', compact);
    $('mini-size').innerHTML = svg(compact ? '<path d="M14 10 20 4M15 4h5v5M10 14l-6 6M4 15v5h5" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>' : '<path d="M20 4l-6 6M14 5v5h5M4 20l6-6M5 14h5v5" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>');
    $('mini-size').title = compact ? 'Make the minimap large again' : 'Make the minimap small, for a longer list';
  };
  $('mini-size').addEventListener('mousedown', (e) => e.stopPropagation());
  $('mini-size').addEventListener('click', () => { compact = !compact; try { localStorage.setItem('conquer-mini', compact ? 'small' : 'large'); } catch { /* fine */ } size(); });
  size();
  $('lists').addEventListener('click', (e) => {
    const row = rowOf(e), add = e.ctrlKey || e.metaKey;
    if (!row) return;
    if (row.town) {
      const t = town(row.town);
      if (add) return clickTown(t.id, true);
      select({ towns: [t.id] });
      goTo(t.x, t.y);
    } else {
      const a = army(row.army);
      if (!a) return;
      const now = selArmy !== null ? [selArmy] : selMany;
      if (add) return select({ armies: now.includes(a.id) ? now.filter((id) => id !== a.id) : [...now, a.id] });
      select({ army: a.id });
      goTo(...armyPoint(a));
    }
  });
}

// ----- Production sidebar -----
// Every base and factory you own, wherever it is: queue units without finding the town first.

let prodKey = '';
function drawProduction() {
  const rows = game.graph.towns.filter((t) => mine(t.id) && Object.values(state(t.id).buildings ?? {}).some((b) => b.done));
  const cash = live.me.money;
  const key = JSON.stringify([rows.map((t) => [t.id, Object.entries(state(t.id).buildings).map(([k, b]) => [k, b.done, Object.values(b.lines).map((l) => [l.queue, l.repeat])])]), selTowns,
    Object.values(game.rules.units).map((u) => cash >= u.cost)]);
  if (key === prodKey) return;
  prodKey = key;
  $('prod').innerHTML = '<header>Production</header>' + (rows.length ? '' : '<p class="hint">No base or factory yet. Select a town of yours and build one to train units.</p>') + rows.map((t) => {
    const s = state(t.id);
    const tiles = Object.entries(game.rules.buildings).flatMap(([kind, rule]) => rule.trains.map((u) => {
      const b = s.buildings[kind], unit = game.rules.units[u], line = b?.lines[u];
      if (!b?.done) return '<span class="tile none"></span>';
      return `<button class="slot tile ${cash < unit.cost ? 'poor' : ''} ${line.repeat ? 'looping' : ''}" data-do="train:${u}" data-town="${t.id}"
        title="${esc(`${unit.name} in ${t.name}, ${unit.cost} each — click to queue one, Shift-click for five, right-click to cancel one${line.repeat ? '. Repeating' : ''}`)}">
        ${art(u) ?? `<span class="ico">${UI[u]}</span>`}<span class="wipe" data-meter="${t.id}|${kind}|${u}"></span>${line.queue ? `<span class="count">${line.queue}</span>` : ''}</button>`;
    })).join('');
    return `<div class="prow ${selTowns.includes(t.id) ? 'sel' : ''}"><button class="pname" data-goto="${t.id}" title="Go to ${esc(t.name)}">${esc(t.name)}</button>${tiles}</div>`;
  }).join('');
}

function perform(does, at, many = false) {
  const [what, arg] = does.split(':'), id = at || selTowns[0];
  if (what === 'build') command({ type: 'build', town: id, building: arg });
  else if (what === 'train') { for (let k = 0; k < (many ? 5 : 1); k++) command({ type: 'train', town: id, unit: arg }); }
  else if (what === 'repeat') command({ type: 'repeat', town: id, unit: arg, on: !Object.values(state(id).buildings).find((b) => b.lines[arg])?.lines[arg].repeat });
  else if (what === 'upgrade') command({ type: 'upgrade', town: id, upgrade: arg });
  else if (what === 'bribe') command({ type: 'bribe', town: id });
  else if (what === 'gather') command({ type: 'gather', town: id });
  else if (what === 'cut') command({ type: 'cut', road: does.slice(4) });
  else if (what === 'repair') command({ type: 'repair', road: does.slice(7) });
  else if (what === 'norally') command({ type: 'rally', town: id, to: null });
  else if (what === 'recall') command({ type: 'redirect', army: selArmy });
  else if (what === 'storm') { if (confirm('Storm the town now? Its fortifications will count in full.')) command({ type: 'storm', army: selArmy }); }
  else if (what === 'merge') command({ type: 'merge', army: selArmy });
  else if (what === 'reinforce') command({ type: 'reinforce', army: selArmy });
  else if (what === 'mergemany') { const keep = selMany[0]; command({ type: 'merge', army: keep }).then(() => select({ army: keep })); }
  else if (what === 'garrison') { const at = army(selArmy)?.at; command({ type: 'garrison', army: selArmy }).then(() => at && select({ towns: [at] })); }
  else if (what === 'split') { command({ type: 'split', army: selArmy, ...pickedOf(army(selArmy)) }); pickAll = true; picked = new Set(); }
  else if (what === 'muster') { command({ type: 'muster', town: id, ...pickedUnits(id) }); pickAll = true; picked = new Set(); }
  else if (what === 'rename') { const name = prompt('Name for this army', army(selArmy)?.name ?? ''); if (name) command({ type: 'rename', army: selArmy, name }); }
  else if (what === 'details') { details = !details; renderUi(true); }
  else if (what === 'pick') {
    const n = cardsOf(trayUnits()).length;
    pickAll = arg === 'all';
    picked = new Set(arg === 'half' ? Array.from({ length: Math.ceil(n / 2) }, (_, i) => i) : []);
    drawRoute();
    renderUi(true);
  } else if (what === 'mode') {
    mode = mode === arg ? null : arg;
    renderUi(true);
    if (mode) toast(mode === 'rally' ? 'Click one of your other towns' : 'Click the town to send them to');
  }
}
for (const id of ['cmd', 'panel', 'prod']) {
  $(id).addEventListener('click', (e) => {
    const b = e.target.closest('button[data-do]');
    if (b && !b.disabled) perform(b.dataset.do, b.dataset.town, e.shiftKey);
    const banner = e.target.closest('[data-army]');
    if (banner) select({ army: Number(banner.dataset.army) });
    const go = e.target.closest('[data-goto]');
    if (go) { const t = town(go.dataset.goto); select({ towns: [t.id] }); goTo(t.x, t.y); }
  });
  // Right-click a training tile to take one unit off its queue.
  $(id).addEventListener('contextmenu', (e) => {
    const b = e.target.closest('button[data-do^="train:"]');
    if (!b) return;
    e.preventDefault();
    command({ type: 'cancel', town: b.dataset.town || selTowns[0], unit: b.dataset.do.slice(6) });
  });
}
// Picking unit cards: click for just one, Ctrl-click to add or remove, Shift-click for a run.
$('cmd').addEventListener('click', (e) => {
  const card = e.target.closest('[data-card]');
  if (!card) return;
  const i = Number(card.dataset.card), n = cardsOf(trayUnits()).length;
  const current = pickAll ? new Set(Array.from({ length: n }, (_, k) => k)) : new Set(picked);
  if (e.shiftKey) { current.clear(); for (let k = Math.min(lastCard, i); k <= Math.max(lastCard, i); k++) current.add(k); }
  else if (e.ctrlKey || e.metaKey) { if (current.has(i)) current.delete(i); else current.add(i); }
  else { current.clear(); current.add(i); }
  if (!e.shiftKey) lastCard = i;
  pickAll = false;
  picked = current;
  drawRoute();
  renderUi(true);
});
$('cmd').addEventListener('dblclick', (e) => {
  const card = e.target.closest('[data-card]');
  if (!card) return;
  const cards = cardsOf(trayUnits()), kind = cards[Number(card.dataset.card)].kind;
  pickAll = false;
  picked = new Set(cards.map((c, k) => (c.kind === kind ? k : -1)).filter((k) => k >= 0));
  drawRoute();
  renderUi(true);
});
$('speed').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (b && game) command({ type: 'speed', value: Number(b.dataset.speed) });
});
$('keep').addEventListener('click', () => command({ type: 'dismiss' }));
$('autoplay').addEventListener('click', () => { const on = !live.settings?.watch; command({ type: 'autoplay', on }); toast(on ? 'The computer is playing your side. Press Auto-play again to take over.' : 'You are back in command.'); });
$('keys').addEventListener('click', () => { $('help').style.display = $('help').style.display === 'block' ? 'none' : 'block'; });

// ----- Keyboard -----

const groupsKey = () => `conquer-groups-${game.world.id}`;
function loadGroups() { try { groupsSaved = JSON.parse(localStorage.getItem(groupsKey())) || {}; } catch { groupsSaved = {}; } }
function saveGroups() { try { localStorage.setItem(groupsKey(), JSON.stringify(groupsSaved)); } catch { /* storage unavailable: groups last for this visit only */ } }
let lastDigit = { key: '', at: 0 };

document.addEventListener('keydown', (e) => {
  if (!game || !live || e.target.matches('input, select, textarea')) return;
  const k = e.key;
  if (k === 'Escape') {
    if ($('guide').style.display === 'flex') openGuide(false);
    else if (sheetTab) openSheet(null);
    else if ($('help').style.display === 'block') $('help').style.display = 'none';
    else if (mode) { mode = null; renderUi(true); } else select({});
    return;
  }
  if (/^[1-9]$/.test(k)) {
    e.preventDefault();
    if (e.ctrlKey || e.metaKey) {
      const own = selTowns.filter(mine);
      if (!own.length) return toast('Select towns of yours first');
      groupsSaved[k] = own;
      saveGroups();
      return toast(`Group ${k}: ${own.map((id) => town(id).name).join(', ')}`);
    }
    const ids = (groupsSaved[k] || []).filter((id) => live.towns[id] && mine(id));
    if (!ids.length) return toast(`Group ${k} is empty — select towns and press Ctrl+${k}`);
    select({ towns: ids });
    // Pressed twice quickly: go there.
    if (lastDigit.key === k && performance.now() - lastDigit.at < 450) {
      const xs = ids.map((id) => town(id).x), ys = ids.map((id) => town(id).y);
      map.fitBounds([toLngLat(Math.min(...xs) - 2500, Math.min(...ys) - 2500), toLngLat(Math.max(...xs) + 2500, Math.max(...ys) + 2500)], { duration: 500, maxZoom: 13 });
    }
    lastDigit = { key: k, at: performance.now() };
    return;
  }
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (k === ' ') {
    e.preventDefault();
    if (live.speed) { resumeSpeed = live.speed; command({ type: 'speed', value: 0 }); } else command({ type: 'speed', value: resumeSpeed });
  } else if (k === '-' || k === '=' || k === '+') {
    const at = SPEEDS.indexOf(live.speed || resumeSpeed);
    command({ type: 'speed', value: SPEEDS[Math.max(0, Math.min(SPEEDS.length - 1, at + (k === '-' ? -1 : 1)))] });
  } else if (k === 'Tab') {
    e.preventDefault();
    // Round every place with units of yours waiting for orders: towns with a garrison, then camped armies.
    const idle = [...game.graph.towns.filter((t) => mine(t.id) && total(state(t.id).garrison)).map((t) => ({ pick: { towns: [t.id] }, x: t.x, y: t.y, is: selTowns[0] === t.id })),
      ...live.armies.filter(camped).map((a) => ({ pick: { army: a.id }, x: town(a.at).x, y: town(a.at).y, is: selArmy === a.id }))];
    if (!idle.length) return toast('Nothing of yours is waiting for orders');
    const at = idle.findIndex((i) => i.is);
    const next = idle[(at + (e.shiftKey ? idle.length - 1 : 1)) % idle.length];
    select(next.pick);
    goTo(next.x, next.y);
  } else if (k === 'h' || k === 'H') {
    const c = town(live.me.capital);
    if (c) { select({ towns: [c.id] }); goTo(c.x, c.y); }
  } else if (k === 'j' || k === 'J') {
    if (lastPlace) goTo(lastPlace[0], lastPlace[1]); else toast('Nothing has happened yet');
  } else if ((k === 'o' || k === 'O') && !$('cmd').querySelector('[data-key="o"]')) {
    openSheet(sheetTab ? null : 'economy');
  } else if ((k === 'z' || k === 'Z') && !$('cmd').querySelector('[data-key="z"]')) {
    // Step back to see the whole map.
    const b = game.world.boundsM;
    map.fitBounds([toLngLat(b.minx, b.miny), toLngLat(b.maxx, b.maxy)], { duration: 500, padding: 24 });
  } else if (k.startsWith('Arrow')) {
    e.preventDefault();
    const step = e.shiftKey ? 320 : 140, d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[k];
    map.panBy(d, { duration: 120 });
  } else if (k === 'l' || k === 'L') {
    $('toggle-roads').click();
  } else if (k === '?') {
    $('keys').click();
  } else {
    // Letters belong to whatever the command bar is showing. Shift picks the capital-letter action.
    const b = $('cmd').querySelector(`[data-key="${CSS.escape(k)}"]`) || (k.length === 1 && !e.shiftKey ? $('cmd').querySelector(`[data-key="${CSS.escape(k.toLowerCase())}"]`) : null);
    if (b && !b.disabled) { e.preventDefault(); perform(b.dataset.do); }
  }
});

// Everything under the top bar hangs from wherever the bar ends, which moves when it wraps onto two rows.
new ResizeObserver(() => document.documentElement.style.setProperty('--top', `${Math.round($('bar').getBoundingClientRect().bottom + 10)}px`)).observe($('bar'));
// Right-clicking a panel never opens the browser's menu; on a training tile it cancels one, as before.
document.addEventListener('contextmenu', (e) => { if (e.target.closest?.('.dock, #left')) e.preventDefault(); });

// ----- Loading games -----

function onTick(data) {
  live = data;
  tickAt = performance.now();
  if (selArmy !== null && !army(selArmy)) { selArmy = null; mode = null; }
  if (selMany.length) selMany = selMany.filter((id) => army(id));
  drawHud();
  drawStatic();
  drawBadges();
  drawEvents();
  drawAlerts();
  drawHint();
  drawPaths();
  drawMini();
  drawSheet();
  renderUi();
}

function onGraph(full) {
  game = full;
  land = full.territory;
  seen = full.sight ?? seen;
  onTick(full.live);
  if (map?.getSource('world')) {
    map.getSource('world').setTiles([worldUrl('tiles', 'mvt')]);
    map.getSource('dem').setTiles([worldUrl('dem', 'png')]);
    map.getSource('terrain').setTiles([worldUrl('dem', 'png')]);
    map.getSource('mask').setData(mask());
    lockMap();
    drawStatic(true);
    drawLand();
    drawFog();
  }
}

function play(full) {
  game = full;
  live = full.live;
  land = full.territory;
  seen = full.sight ?? [];
  tickAt = performance.now();
  selTowns = []; selArmy = null; selRoad = null; mode = null; lastEvent = 0; lastPlace = null;
  $('events').innerHTML = '';
  for (const b of badges.values()) b.marker.remove();
  badges.clear();
  loadGroups();
  history.replaceState(null, '', `?game=${game.world.id}`);
  if (map) { map.remove(); map = null; }
  startMap();
  onTick(live);
  renderUi(true);
  stream?.close();
  stream = new EventSource(`/api/conquer/${game.world.id}/events`);
  stream.addEventListener('tick', (e) => onTick(JSON.parse(e.data)));
  stream.addEventListener('graph', (e) => onGraph(JSON.parse(e.data)));
  stream.addEventListener('territory', (e) => { land = JSON.parse(e.data); drawLand(); drawMini(); });
  stream.addEventListener('sight', (e) => { seen = JSON.parse(e.data); drawFog(); drawMini(); });
}

async function refreshList(selectId) {
  const list = await api('');
  $('games').innerHTML = list.map((w) => `<option value="${w.id}">${esc(w.name)}</option>`).join('');
  if (selectId) $('games').value = selectId;
  $('delete').disabled = $('games').disabled = !list.length;
  return list;
}

function newGame() {
  $('help').style.display = 'none';
  $('setup').style.display = 'flex';
  $('setup').querySelector('[name=name]').select();
}
$('setup-cancel').addEventListener('click', () => { $('setup').style.display = 'none'; });
$('setup').querySelector('form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = new FormData(e.target);
  const body = { name: form.get('name'), seed: form.get('seed') || undefined, size: form.get('size'), rivals: Number(form.get('rivals')), difficulty: form.get('difficulty'), watch: form.get('watch') === 'on', reveal: form.get('reveal') === 'on' };
  $('setup').style.display = 'none';
  veil('Generating the map…');
  try {
    const full = await api('', { method: 'POST', body });
    await refreshList(full.world.id);
    play(full);
  } catch (err) { toast(`Could not start: ${err.message}`); }
  veil('');
});

/** The end-of-game chart: towns held by each side over time, and the tally of fights. */
function drawSummary() {
  const sum = live.summary;
  if (!sum) return;
  const c = $('chart'), g = c.getContext('2d'), pad = 28;
  g.clearRect(0, 0, c.width, c.height);
  const sides = live.factions.filter((f) => f.id !== 0);
  const end = Math.max(1, sum.history[sum.history.length - 1]?.clock ?? 1), top = Math.max(2, ...sum.history.flatMap((h) => sides.map((f) => h.held[f.id] ?? 0)), live.goal);
  const X = (t) => pad + ((c.width - pad - 8) * t) / end, Y = (n) => c.height - pad - ((c.height - pad - 10) * n) / top;
  g.strokeStyle = '#cfd6dd'; g.lineWidth = 1; g.fillStyle = '#5b6672'; g.font = '20px system-ui, sans-serif';
  g.beginPath(); g.moveTo(pad, 6); g.lineTo(pad, c.height - pad); g.lineTo(c.width - 6, c.height - pad); g.stroke();
  g.setLineDash([6, 6]); g.beginPath(); g.moveTo(pad, Y(live.goal)); g.lineTo(c.width - 6, Y(live.goal)); g.stroke(); g.setLineDash([]);
  g.fillText(String(live.goal), 2, Y(live.goal) + 7);
  g.fillText(clockText(end), c.width - 60, c.height - 4);
  for (const f of sides) {
    g.strokeStyle = f.color; g.lineWidth = 4; g.lineJoin = 'round';
    g.beginPath();
    sum.history.forEach((h, i) => { const x = X(h.clock), y = Y(h.held[f.id] ?? 0); if (i) g.lineTo(x, y); else g.moveTo(x, y); });
    g.stroke();
  }
  $('tally').innerHTML = '<tr><th></th><th>Towns</th><th>Fights won</th><th>Lost</th><th>Units lost</th></tr>' + sides.map((f) => {
    const t = sum.tally[f.id] ?? { won: 0, lost: 0, casualties: 0 }, held = sum.history[sum.history.length - 1]?.held[f.id] ?? 0;
    return `<tr><td style="color:${f.color}">${esc(f.name)}${f.alive ? '' : ' (defeated)'}</td><td>${held}</td><td>${t.won}</td><td>${t.lost}</td><td>${t.casualties}</td></tr>`;
  }).join('');
}

$('games').addEventListener('change', async (e) => play(await api(`/${e.target.value}/game`)));
$('new').addEventListener('click', newGame);
$('again').addEventListener('click', newGame);
$('delete').addEventListener('click', async () => {
  if (!game || !confirm(`Delete “${game.world.name}” permanently?`)) return;
  stream?.close();
  await api(`/${game.world.id}`, { method: 'DELETE' });
  location.search = '';
});

// Pictures first, so the panels are drawn with them from the start; without WebGL the plain icons are used.
await startArt();
const list = await refreshList();
const query = new URLSearchParams(location.search);
const wanted = query.get('game');
// Arriving from the map explorer with a seed: offer a new game on that world.
if (query.get('seed')) {
  const form = $('setup').querySelector('form');
  form.elements.seed.value = query.get('seed');
  form.elements.name.value = query.get('name') || 'Campaign';
  newGame();
}
if (list.length) {
  const id = list.some((w) => w.id === wanted) ? wanted : list[0].id;
  $('games').value = id;
  play(await api(`/${id}/game`));
} else {
  newGame();
}
