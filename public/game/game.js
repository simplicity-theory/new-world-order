import * as maplibregl from '/vendor/maplibre-gl.mjs';
import { buildStyle } from '/style.js';

// The page for Conquer. The server runs the game; this draws it and sends commands.

const $ = (id) => document.getElementById(id);
const R = 6378137, DEG = 180 / Math.PI;
const toLngLat = (x, y) => [(x / R) * DEG, (2 * Math.atan(Math.exp(y / R)) - Math.PI / 2) * DEG];
const TIERS = ['Hamlet', 'Village', 'Town', 'City'];
const PLAYER = 1, UNKNOWN = -1;
const SPEEDS = [1, 2, 4, 8];
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

let map = null;
let game = null;        // world, rules and the town/road graph
let live = null;        // what changes every tick
let land = [];          // territory polygons
let tickAt = 0;
let stream = null;
let selTowns = [];      // selected town ids
let selGroup = null;    // selected group id
let selRoad = null;     // selected road id
let mode = null;        // what the next click on a town means: 'send', 'rally' or 'redirect'
let hovered = null;
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
const colorOf = (owner) => faction(owner)?.color ?? '#a3a9b0';
const ownerName = (owner) => (owner === PLAYER ? 'yours' : owner === UNKNOWN ? 'unexplored' : faction(owner).name.toLowerCase());
const cutState = (id) => live.roads.find((r) => r.id === id);
const total = (u) => game.unitKinds.reduce((n, k) => n + (u?.[k] || 0), 0);
const unitText = (u) => game.unitKinds.filter((k) => u[k]).map((k) => `${u[k]} ${game.rules.units[k].name.toLowerCase()}`).join(', ') || 'none';
/** The units an order from this town would move: the cards picked, or everyone when several towns are selected. */
const counts = (id) => (selTowns.length === 1 ? pickedUnits(id) : Object.fromEntries(game.unitKinds.map((k) => [k, state(id).garrison?.[k] ?? 0])));
const clockText = (c) => `${Math.floor(c / 60)}:${String(Math.floor(c) % 60).padStart(2, '0')}`;

// The same arithmetic as the server, for previews.
const attackPower = (u) => game.unitKinds.reduce((n, k) => n + (u[k] || 0) * game.rules.units[k].attack, 0);
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

/** What happens if these units set off for a town: where they stop and how the fight there should go. */
function forecast(from, to, units) {
  const r = route(from, to, units);
  if (!r) return { text: `No road leads to ${town(to).name}` };
  const stop = r.stops.find((id) => !mine(id)) ?? to;
  let text = `${town(to).name}: ${(r.length / 1000).toFixed(1)} km, about ${Math.round(r.time)} s`;
  if (!mine(stop)) {
    const s = state(stop);
    if (stop !== to) text += ` — they will stop to fight at ${town(stop).name}`;
    if (!s.visible) text += ' — defenders unknown';
    else {
      const ap = attackPower(units), dp = defencePower(s.garrison, s.defence);
      const share = ap > dp ? (dp / ap) ** game.rules.lossPower : 1;
      text += ` — attack ${ap.toFixed(0)} against defence ${dp.toFixed(1)}: ${ap > dp ? `you should win, losing about ${Math.round(total(units) * share)}` : 'you would lose'}`;
    }
  }
  return { text, pts: r.pts };
}

// ----- Map -----

const worldUrl = (kind, ext) => `${location.origin}/api/conquer/${game.world.id}/${kind}/{z}/{x}/{y}.${ext}?v=${game.world.version}`;
function mask() {
  const b = game.world.boundsM;
  const [w0, s0] = toLngLat(b.minx, b.miny), [e0, n0] = toLngLat(b.maxx, b.maxy);
  return { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [
    [[-170, -80], [170, -80], [170, 80], [-170, 80], [-170, -80]], [[w0, s0], [w0, n0], [e0, n0], [e0, s0], [w0, s0]]] } };
}
const collection = (features) => ({ type: 'FeatureCollection', features });
const empty = collection([]);
const ring = (pts) => { const c = pts.map(([x, y]) => toLngLat(x, y)); c.push(c[0]); return [c]; };
const lineOf = (pts) => pts.map(([x, y]) => toLngLat(x, y));

function addOverlay() {
  const sources = ['cq-land', 'cq-areas', 'cq-roads', 'cq-cuts', 'cq-sites', 'cq-route', 'cq-labels', 'cq-groups'];
  for (const id of sources) map.addSource(id, { type: 'geojson', data: empty });
  // The game draws its own town names, so the map's are hidden.
  if (map.getLayer('place')) map.setLayoutProperty('place', 'visibility', 'none');
  const text = { 'text-font': ['sans-serif'], 'text-allow-overlap': true };
  // Territory: a wash of each side's colour over the land it controls, with the front line dashed.
  map.addLayer({ id: 'cq-land', type: 'fill', source: 'cq-land', paint: { 'fill-color': ['get', 'color'], 'fill-opacity': 0.16 } });
  map.addLayer({ id: 'cq-front', type: 'line', source: 'cq-land', paint: { 'line-color': ['get', 'color'], 'line-width': 2, 'line-opacity': 0.6, 'line-dasharray': [3, 2] } });
  map.addLayer({ id: 'cq-area', type: 'fill', source: 'cq-areas', paint: { 'fill-color': ['get', 'color'], 'fill-opacity': ['get', 'fill'] } });
  map.addLayer({ id: 'cq-area-edge', type: 'line', source: 'cq-areas',
    paint: { 'line-color': ['case', ['==', ['get', 'selected'], 1], '#f5b301', ['get', 'color']], 'line-width': ['case', ['==', ['get', 'selected'], 1], 4, 2.2],
      'line-opacity': ['case', ['==', ['get', 'known'], 1], 0.95, 0.5] } });
  // Roads are drawn only when cut, being mended or selected, but can always be clicked.
  map.addLayer({ id: 'cq-road-hit', type: 'line', source: 'cq-roads', paint: { 'line-color': '#000000', 'line-opacity': 0.001, 'line-width': 14 } });
  map.addLayer({ id: 'cq-road-state', type: 'line', source: 'cq-roads', filter: ['!=', ['get', 'state'], 'ok'],
    layout: { 'line-cap': 'round' },
    paint: { 'line-color': ['match', ['get', 'state'], 'cut', '#c62828', 'repair', '#e08a00', '#f5b301'], 'line-width': 5,
      'line-opacity': 0.75, 'line-dasharray': ['match', ['get', 'state'], 'selected', ['literal', [1, 0]], ['literal', [1.2, 1.6]]] } });
  map.addLayer({ id: 'cq-cut', type: 'symbol', source: 'cq-cuts', layout: { ...text, 'text-field': '✕', 'text-size': 22 },
    paint: { 'text-color': '#c62828', 'text-halo-color': '#ffffff', 'text-halo-width': 2.5 } });
  map.addLayer({ id: 'cq-site', type: 'fill', source: 'cq-sites', minzoom: 12, paint: { 'fill-color': ['get', 'color'], 'fill-opacity': ['get', 'fill'], 'fill-outline-color': '#ffffff' } });
  map.addLayer({ id: 'cq-site-label', type: 'symbol', source: 'cq-sites', minzoom: 14,
    layout: { 'text-font': ['sans-serif'], 'text-field': ['get', 'label'], 'text-size': 11 }, paint: { 'text-color': '#ffffff', 'text-halo-color': '#00000066', 'text-halo-width': 1 } });
  map.addLayer({ id: 'cq-route', type: 'line', source: 'cq-route', layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': '#1f6feb', 'line-width': 6, 'line-opacity': 0.5 } });
  map.addLayer({ id: 'cq-name', type: 'symbol', source: 'cq-labels',
    layout: { ...text, 'text-field': ['get', 'name'], 'text-size': ['+', 12.5, ['*', 2, ['get', 'tier']]], 'text-anchor': 'bottom', 'text-offset': [0, -0.1] },
    paint: { 'text-color': '#1c2530', 'text-halo-color': '#ffffffe6', 'text-halo-width': 1.8 } });
  map.addLayer({ id: 'cq-group-ring', type: 'circle', source: 'cq-groups', filter: ['==', ['get', 'selected'], 1],
    paint: { 'circle-radius': 14, 'circle-color': '#f5b301', 'circle-opacity': 0.9 } });
  map.addLayer({ id: 'cq-groups', type: 'circle', source: 'cq-groups',
    paint: { 'circle-radius': 9, 'circle-color': ['get', 'color'], 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 2 } });
  map.addLayer({ id: 'cq-group-label', type: 'symbol', source: 'cq-groups',
    layout: { ...text, 'text-field': ['get', 'label'], 'text-size': 10.5 }, paint: { 'text-color': '#ffffff' } });
  drawStatic(true);
  drawLand();
}

function drawLand() {
  if (!map?.getSource('cq-land') || !live) return;
  map.getSource('cq-land').setData(collection(land.map((p) => ({ type: 'Feature', properties: { color: colorOf(p.owner) },
    geometry: { type: 'Polygon', coordinates: p.rings.map((r) => ring(r)[0]) } }))));
}

let staticKey = '';
/** Everything on the overlay except moving groups, badges and the route preview. Redrawn only when it changes. */
function drawStatic(force) {
  if (!map?.getSource('cq-areas')) return;
  const areas = [], labels = [], sites = [];
  for (const t of game.graph.towns) {
    const s = state(t.id), color = colorOf(s.owner), known = s.owner !== UNKNOWN;
    areas.push({ type: 'Feature', geometry: { type: 'Polygon', coordinates: ring(t.outline) },
      properties: { id: t.id, color, known: known ? 1 : 0, fill: s.owner === PLAYER ? 0.3 : known ? 0.22 : 0.1, selected: selTowns.includes(t.id) ? 1 : 0 } });
    const capital = live.factions.some((f) => f.capital === t.id);
    labels.push({ type: 'Feature', geometry: { type: 'Point', coordinates: toLngLat(t.x, t.y) }, properties: { name: `${capital ? '★ ' : ''}${t.name}`, tier: t.tier } });
    Object.keys(game.rules.buildings).forEach((kind, k) => {
      const b = s.buildings?.[kind];
      if (b) sites.push({ type: 'Feature', geometry: { type: 'Polygon', coordinates: ring(t.sites[k]) },
        properties: { color, fill: b.done ? 0.95 : 0.45, label: b.done ? game.rules.buildings[kind].name : 'Building…' } });
    });
  }
  const roads = game.graph.roads.map((r) => {
    const c = cutState(r.id);
    return { type: 'Feature', geometry: { type: 'LineString', coordinates: lineOf(r.pts) },
      properties: { id: r.id, state: c ? (c.repair >= 0 ? 'repair' : 'cut') : r.id === selRoad ? 'selected' : 'ok' } };
  });
  const cuts = live.roads.filter((c) => c.cutAt).map((c) => ({ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: toLngLat(c.cutAt[0], c.cutAt[1]) } }));
  const key = JSON.stringify([areas.map((f) => f.properties), labels.map((f) => f.properties), sites.map((f) => f.properties), roads.map((f) => f.properties.state), cuts.length]);
  if (!force && key === staticKey) return;
  staticKey = key;
  map.getSource('cq-areas').setData(collection(areas));
  map.getSource('cq-labels').setData(collection(labels));
  map.getSource('cq-sites').setData(collection(sites));
  map.getSource('cq-roads').setData(collection(roads));
  map.getSource('cq-cuts').setData(collection(cuts));
}

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

/** Enemy groups known to be heading for a town. */
const threatsTo = (id) => live.groups.filter((g) => g.to === id && g.owner !== state(id).owner && g.owner !== PLAYER && mine(id));

function badgeHtml(t) {
  const s = state(t.id), own = s.owner === PLAYER;
  if (!s.visible) return { html: '<span class="muted">?</span>', title: `${t.name}: out of sight` };
  const strength = defencePower(s.garrison, s.defence), units = total(s.garrison);
  let html = `<span>${units}</span><span style="color:${colorOf(s.owner)}">${ICON.shield}</span><span>${strength.toFixed(strength < 10 ? 1 : 0)}</span>`;
  let title = `${t.name}: ${unitText(s.garrison)}; defence strength ${strength.toFixed(1)} (×${s.defence.toFixed(2)})`;
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
    if (threatsTo(t.id).length) { html += ICON.threat; title += '; an enemy group is heading here'; }
  } else if (s.fort) { html += `<span style="color:#5b6672">${ICON.fort}</span><span class="lvl">${s.fort}</span>`; title += `; fortifications ${s.fort}`; }
  return { html, title };
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
      el.addEventListener('click', (e) => { e.stopPropagation(); clickTown(t.id, e.ctrlKey || e.metaKey); });
      el.addEventListener('contextmenu', (e) => { e.preventDefault(); e.stopPropagation(); if (canOrder() && !(selTowns.length === 1 && selTowns[0] === t.id)) order(t.id); });
      el.addEventListener('mouseenter', () => hover(t.id));
      el.addEventListener('mouseleave', () => hover(null));
      b = { el, key: '', marker: new maplibregl.Marker({ element: holder, anchor: 'top', offset: [0, 3] }).setLngLat(toLngLat(t.x, t.y)).addTo(map) };
      badges.set(t.id, b);
    }
    const s = state(t.id), { html, title } = badgeHtml(t);
    const cls = `badge${selTowns.includes(t.id) ? ' sel' : ''}${mine(t.id) && threatsTo(t.id).length ? ' threat' : ''}${small ? ' small' : ''}`;
    const key = cls + html + s.owner;
    if (key === b.key) continue;
    b.key = key;
    b.el.className = cls;
    b.el.style.setProperty('--c', colorOf(s.owner));
    b.el.innerHTML = html;
    b.el.title = title;
  }
}

function groupPoint(g, ahead = 0) {
  const leg = g.path[g.leg], road = roadOf(leg.road);
  const d = Math.min(road.length, g.dist + g.speed * ahead);
  return pointAlong(road.pts, leg.rev ? road.length - d : d);
}

function drawGroups() {
  if (!map?.getSource('cq-groups') || !live) return;
  // Between ticks, carry each group forward at its speed so movement is smooth.
  const running = live.winner === null || live.dismissed;
  const ahead = running ? Math.min(0.4, (performance.now() - tickAt) / 1000) * live.speed : 0;
  map.getSource('cq-groups').setData(collection(live.groups.map((g) => {
    const [x, y] = groupPoint(g, ahead);
    return { type: 'Feature', geometry: { type: 'Point', coordinates: toLngLat(x, y) },
      properties: { id: g.id, color: colorOf(g.owner), label: String(g.infantry + g.vehicle), selected: g.id === selGroup ? 1 : 0 } };
  })));
}
function frame() { drawGroups(); requestAnimationFrame(frame); }

function drawRoute() {
  if (!map?.getSource('cq-route')) return;
  const lines = [];
  const target = hovered;
  if (target && mode !== 'rally') {
    if (selGroup !== null) {
      if (mode === 'redirect') toast(`Redirect to ${town(target).name} — click to confirm`);
    } else {
      const from = selTowns.filter((id) => mine(id) && id !== target && total(counts(id)));
      for (const id of from) {
        const f = forecast(id, target, counts(id));
        if (f.pts) lines.push(lineOf(f.pts));
        if (from.length === 1) toast(`${f.text}${f.pts ? ` — ${mode ? 'click' : 'right-click'} to send` : ''}`);
      }
      if (from.length > 1) toast(`Send from ${from.length} towns to ${town(target).name}; each group travels and fights on its own — ${mode ? 'click' : 'right-click'} to send`);
    }
  }
  map.getSource('cq-route').setData(lines.length ? { type: 'Feature', properties: {}, geometry: { type: 'MultiLineString', coordinates: lines } } : empty);
}

function hit(point, layer, pad = 4) {
  const found = map.queryRenderedFeatures([[point.x - pad, point.y - pad], [point.x + pad, point.y + pad]], { layers: [layer] });
  return found.length ? found[0].properties.id : null;
}

function select({ towns = [], group = null, road = null }) {
  selTowns = towns;
  selGroup = group;
  selRoad = road;
  mode = null;
  pickAll = true;
  picked = new Set();
  drawStatic();
  drawBadges();
  drawRoute();
  renderUi(true);
}

/** Act on a town with whatever is selected: send units, redirect a group or set a rally point. */
function order(to) {
  if (mode === 'rally' && selTowns.length === 1) {
    command({ type: 'rally', town: selTowns[0], to });
  } else if (selGroup !== null) {
    command({ type: 'redirect', group: selGroup, to });
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
const canOrder = () => (selGroup !== null && live.groups.find((g) => g.id === selGroup)?.owner === PLAYER) || selTowns.some(mine);

function clickTown(id, add) {
  if (mode && canOrder() && !selTowns.includes(id)) return order(id);
  if (add) return select({ towns: selTowns.includes(id) ? selTowns.filter((t) => t !== id) : [...selTowns.filter(mine), ...(mine(id) ? [id] : [])] });
  select({ towns: [id] });
}
function hover(id) {
  const target = id && canOrder() && !(selTowns.length === 1 && selTowns[0] === id) ? id : null;
  if (target !== hovered) { hovered = target; drawRoute(); }
}
const goTo = (x, y, zoom) => map.easeTo({ center: toLngLat(x, y), zoom: zoom ?? Math.max(map.getZoom(), 12), duration: 500 });

function startMap() {
  const start = town(live.me.capital) ?? game.graph.towns[0];
  map = new maplibregl.Map({
    container: 'map', style: buildStyle(worldUrl('tiles', 'mvt'), worldUrl('dem', 'png'), mask()),
    center: toLngLat(start.x, start.y), zoom: 12.2, minZoom: 8, maxZoom: 18, attributionControl: false, boxZoom: false, keyboard: false,
  });
  window.map = map;
  map.addControl(new maplibregl.NavigationControl(), 'bottom-right');
  map.addControl(new maplibregl.ScaleControl({ maxWidth: 140 }), 'bottom-right');
  map.on('style.load', addOverlay);
  map.on('zoomend', drawBadges);
  map.on('click', (e) => {
    if (boxed) { boxed = false; return; }
    const group = hit(e.point, 'cq-groups', 8), id = hit(e.point, 'cq-area'), road = hit(e.point, 'cq-road-hit', 6);
    if (group !== null && !mode) return select({ group });
    if (id) return clickTown(id, e.originalEvent.ctrlKey || e.originalEvent.metaKey);
    if (road && !mode) return select({ road });
    select({});
  });
  map.on('contextmenu', (e) => {
    const id = hit(e.point, 'cq-area');
    if (id && canOrder() && !(selTowns.length === 1 && selTowns[0] === id)) order(id);
  });
  map.on('mousemove', (e) => {
    const id = hit(e.point, 'cq-area');
    map.getCanvas().style.cursor = id || hit(e.point, 'cq-groups', 8) !== null || hit(e.point, 'cq-road-hit', 6) ? 'pointer' : '';
    hover(id);
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
      select({ towns: game.graph.towns.filter((t) => {
        const p = map.project(toLngLat(t.x, t.y));
        return mine(t.id) && p.x >= Math.min(x0, x1) && p.x <= Math.max(x0, x1) && p.y >= Math.min(y0, y1) && p.y <= Math.max(y0, y1);
      }).map((t) => t.id) });
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
  $('clock').textContent = clockText(live.clock);
  for (const b of $('speed').children) b.classList.toggle('on', Number(b.dataset.speed) === live.speed);
  const over = live.winner !== null && !live.dismissed;
  $('result').style.display = over ? 'flex' : 'none';
  if (over) {
    $('result-title').textContent = live.winner === PLAYER ? 'Victory' : 'Defeat';
    $('result-text').textContent = live.winner === PLAYER
      ? (faction(2)?.alive === false ? 'You took the rival capital.' : `You hold ${held} of ${game.graph.towns.length} towns.`)
      : (mine(live.me.capital) ? 'The rival holds most of the map.' : 'Your capital has fallen.');
  }
}

// ----- Events and battle reports -----

function reportHtml(e) {
  const r = e.report, row = (who, side) => `<tr><td>${who}</td><td>${total(side.before)}</td><td>${side.power.toFixed(1)}</td><td>${total(side.before) - total(side.after)}</td><td>${total(side.after)}</td></tr>`;
  const title = r.kind === 'field' ? `Fight ${esc(r.place)}` : `${r.kind === 'assault' ? 'Attack on' : 'Defence of'} ${esc(r.place)}`;
  return `<b>${title}: ${r.won ? 'won' : 'lost'}</b><table><tr><th></th><th>units</th><th>strength</th><th>lost</th><th>left</th></tr>
    ${row('You', r.you)}${row(r.them.owner === 0 ? 'Defenders' : esc(faction(r.them.owner)?.name ?? 'Enemy'), r.them)}</table>`;
}

function drawEvents() {
  const el = $('events');
  const fresh = live.events.filter((e) => (e.id ?? 0) > lastEvent);
  if (fresh.length || !el.children.length) {
    el.innerHTML = live.events.map((e) => `<div ${e.at ? `data-x="${e.at[0]}" data-y="${e.at[1]}" title="Go there"` : ''} class="${e.report ? (e.report.won ? 'win' : 'loss') : ''}"><time>${clockText(e.clock)}</time>${esc(e.text)}</div>`).join('')
      + (live.growing ? '<div>Mapping new territory…</div>' : '');
    el.scrollTop = el.scrollHeight;
  }
  for (const e of fresh) {
    if (e.at) lastPlace = e.at;
    // A fight pops up on the map where it happened, unless this is the backlog from loading the game.
    if (e.report && e.at && lastEvent && map) {
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
$('log-toggle').addEventListener('click', () => {
  const open = $('log').classList.toggle('open');
  $('log-toggle').textContent = open ? 'fewer' : 'more';
  $('events').scrollTop = $('events').scrollHeight;
});

// ----- Command bar -----
// Laid out like a strategy game's campaign panel: who is selected on the left, their
// units as a row of cards in the middle, and square slots for everything they can do
// on the right. Pictures and numbers first; the words are in the tooltips.

const svg = (body) => `<svg viewBox="0 0 24 24" aria-hidden="true">${body}</svg>`;
const UI = {
  infantry: svg('<circle cx="12" cy="6.500" r="3.500" fill="currentColor"/><path d="M5 21v-4.500C5 13 8 11.500 12 11.500s7 1.500 7 5V21Z" fill="currentColor"/><path d="M7.500 5.500h9" stroke="currentColor" stroke-width="2.400" stroke-linecap="round"/>'),
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
/** How many of each unit the cards picked in a town add up to. */
function pickedUnits(id) {
  const g = state(id).garrison ?? {};
  if (pickAll) return Object.fromEntries(game.unitKinds.map((k) => [k, g[k] || 0]));
  const out = Object.fromEntries(game.unitKinds.map((k) => [k, 0]));
  cardsOf(g).forEach((c, i) => { if (picked.has(i)) out[c.kind] += c.n; });
  return out;
}

function tray(units, owner, selectable) {
  const cards = cardsOf(units);
  if (!cards.length) return '<div class="tray empty">No units</div>';
  return `<div class="tray">${cards.map((c, i) => `<button class="unit ${selectable ? (pickAll || picked.has(i) ? 'in' : 'out') : 'fixed'}" style="--c:${colorOf(owner)}"
    ${selectable ? `data-card="${i}"` : 'disabled'} title="${c.n > 1 ? `${c.n} ` : ''}${game.rules.units[c.kind].name}${selectable ? ' — click to pick just this one, Ctrl-click to add or remove, double-click for all of this kind' : ''}">
    ${UI[c.kind]}${c.n > 1 ? `<span class="n">${c.n}</span>` : ''}</button>`).join('')}</div>`;
}

/** One square action. Icon and number carry the meaning; `title` holds the sentence. */
function slot({ key, icon, does, title, price, caption, disabled = false, cls = '', meter = '', badge = '', pips = null, at = '' }) {
  const shown = key ? `<kbd>${key.toUpperCase()}</kbd>` : '';
  const dots = pips ? `<span class="pips">${Array.from({ length: pips[1] }, (_, i) => `<i class="${i < pips[0] ? 'on' : ''}"></i>`).join('')}</span>` : '';
  return `<div class="cell"><button class="slot ${cls}" data-do="${does}" ${at ? `data-town="${at}"` : ''} ${key ? `data-key="${key}"` : ''} ${disabled ? 'disabled' : ''} title="${esc(title)}">
    ${shown}<span class="ico">${icon}</span>${meter ? `<span class="wipe" data-meter="${meter}"></span>` : ''}${badge ? `<span class="count">${badge}</span>` : ''}${dots}</button>
    <span class="cap">${price != null ? `<b>${price}</b>` : ''}${caption ? esc(caption) : ''}</span></div>`;
}
const chip = (icon, text, title, color = '') => `<span class="chip" title="${esc(title)}" ${color ? `style="color:${color}"` : ''}>${icon}<b>${text}</b></span>`;
const who = (title, sub, owner, chips = '') => `<div class="who" style="--c:${colorOf(owner)}"><h2>${title}</h2><div class="sub">${sub}</div><div class="chips">${chips}</div></div>`;

function cmdHtml() {
  const cash = live.me.money, rules = game.rules;
  if (selGroup !== null) {
    const g = live.groups.find((x) => x.id === selGroup);
    if (!g) return '';
    const own = g.owner === PLAYER;
    return who(`Group of ${g.infantry + g.vehicle}`, own ? 'on the road' : esc(faction(g.owner).name), g.owner,
      chip(UI.go, esc(town(g.to).name), `Heading for ${town(g.to).name}`) + chip(UI.shield, attackPower(g).toFixed(0), 'Attack strength'))
      + `<div class="mid">${tray(g, g.owner, false)}<div class="tip">${own ? 'Right-click a town to send them somewhere else' : ''}</div></div>`
      + (own ? `<div class="slots">${slot({ key: 's', icon: UI.go, does: 'mode:redirect', cls: mode === 'redirect' ? 'on' : '', caption: mode === 'redirect' ? 'click a town' : 'Redirect', title: 'Send this group to a different town' })}
        ${slot({ key: 'b', icon: UI.back, does: 'recall', caption: 'Recall', title: `Turn back to ${town(g.from).name}` })}</div>` : '');
  }
  if (selRoad) {
    const r = roadOf(selRoad), c = cutState(r.id), bridge = r.bridges.length > 0, k = rules.roads, can = mine(r.a) || mine(r.b);
    const cutCost = bridge ? k.cutBridge : k.cut, fixCost = bridge ? k.repairBridge : k.repair;
    const status = c ? (c.repair >= 0 ? 'Being repaired' : 'Cut — nobody can use it') : 'Open';
    return who(r.ref || 'Road', `${esc(town(r.a).name)} – ${esc(town(r.b).name)}`, 0,
      chip(UI.road, `${(r.length / 1000).toFixed(1)} km`, `${r.kind} road${bridge ? ' with a bridge' : ''}`) + chip(UI.vehicle, `${rules.speed.vehicle[r.kind] ?? rules.speed.vehicle.tertiary}`, 'Vehicle speed here, km/h'))
      + `<div class="mid"><div class="tray empty">${status}</div><div class="tip">${can ? 'A cut road isolates the towns beyond it; cut off from their capital they earn half' : 'Hold a town at one end to cut or repair this road'}</div></div>
      <div class="slots">${c
        ? slot({ key: 'e', icon: UI.repair, does: `repair:${r.id}`, price: fixCost, caption: '', disabled: !can || c.repair >= 0 || cash < fixCost, title: 'Repair the road' })
        : slot({ key: 'c', icon: UI.cut, does: `cut:${r.id}`, price: cutCost, caption: '', disabled: !can || cash < cutCost, title: bridge ? 'Blow the bridge: cheap to do, slow and costly to mend' : 'Cut the road' })}</div>`;
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
      chip(UI.shield, strength, `Defence strength (defenders × ${s.defence.toFixed(2)})`, '#5b6672') + traits)
      + `<div class="mid">${s.visible ? tray(s.garrison, Math.max(0, s.owner), false) : '<div class="tray empty">Defenders unknown — out of sight</div>'}
        <div class="tip">Select one of your towns, pick units, then right-click here to attack</div></div>`;
  }
  const units = pickedUnits(id), going = total(units), all = total(s.garrison);
  let html = who(esc(t.name), `${TIERS[t.tier]}${live.me.capital === id ? ' · capital' : ''}`, PLAYER,
    chip(UI.coin, `+${Math.round(s.income)}`, `Earns ${Math.round(s.income)} a minute${s.supplied ? '' : ' — halved, cut off from your capital'}`, s.supplied ? '#8a6d1c' : '#d97706')
    + chip(UI.shield, defencePower(s.garrison, s.defence).toFixed(1), `Defence strength (garrison × ${s.defence.toFixed(2)})`, '#5b6672') + traits);
  html += `<div class="mid"><div class="pick"><span>${all ? `<b>${going}</b> of ${all} selected` : 'Garrison'}</span>
      ${all > 1 ? `<button data-do="pick:all" data-key="a" class="mini ${pickAll ? 'on' : ''}" title="Select every unit (A)">All</button><button data-do="pick:half" class="mini" title="Select half">Half</button>` : ''}
      ${all ? `<span class="tip">${mode === 'send' ? 'now click a town' : 'right-click a town to send them'}</span>` : ''}</div>${tray(s.garrison, PLAYER, true)}</div><div class="slots">`;
  [['barracks', 'q'], ['factory', 'w']].forEach(([kind, key]) => {
    const rule = rules.buildings[kind], unit = rules.units[rule.trains], b = s.buildings[kind];
    const icon = kind === 'barracks' ? UI.base : UI.factory;
    if (!b) html += slot({ key, icon, does: `build:${kind}`, price: rule.cost, cls: 'empty', disabled: cash < rule.cost, title: `Build ${rule.name.toLowerCase()} — lets you train ${unit.name.toLowerCase()}` });
    else if (!b.done) html += slot({ key, icon, does: 'none', caption: 'building', disabled: true, meter: `${id}|${kind}`, title: `${rule.name} under construction` });
    else {
      html += slot({ key, icon: UI[rule.trains], does: `train:${rule.trains}`, price: unit.cost, cls: cash < unit.cost ? 'poor' : '', meter: `${id}|${kind}`, badge: b.queue || '',
        title: `Train ${unit.name.toLowerCase()} — click to queue one, Shift-click for five, right-click to cancel one${b.queue ? `. ${b.queue} in training` : ''}` });
      html += `<button class="mini repeat ${b.repeat ? 'on' : ''}" data-do="repeat:${rule.trains}" data-key="${key.toUpperCase()}" title="Keep training ${unit.name.toLowerCase()} while there is money (Shift+${key.toUpperCase()})">${UI.repeat}</button>`;
    }
  });
  html += '<span class="gap"></span>';
  [['market', 'm', UI.market], ['fort', 'f', UI.fort]].forEach(([kind, key, icon]) => {
    const rule = rules.upgrades[kind], level = kind === 'market' ? s.market : s.fort, top = level >= rules.maxLevel;
    html += slot({ key: top ? '' : key, icon, does: top ? 'none' : `upgrade:${kind}`, price: top ? null : s.costs[kind], caption: top ? 'max' : '', pips: [level, rules.maxLevel],
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
    else if (c) action = `<button data-do="repair:${r.id}" ${cash < (bridge ? k.repairBridge : k.repair) ? 'disabled' : ''}>Repair<span class="cost">${bridge ? k.repairBridge : k.repair}</span></button>`;
    else action = `<button data-do="cut:${r.id}" ${cash < (bridge ? k.cutBridge : k.cut) ? 'disabled' : ''}>Cut<span class="cost">${bridge ? k.cutBridge : k.cut}</span></button>`;
    return `<div class="row road"><span style="flex:1">${r.ref || r.kind[0].toUpperCase() + r.kind.slice(1)} to ${esc(town(r.a === from ? r.b : r.a).name)}<br><span class="hint">${(r.length / 1000).toFixed(1)} km${bridge ? ', bridge' : ''}</span></span>${action}</div>`;
  }).join('');
}

function panelHtml() {
  if (!details || selTowns.length !== 1 || !mine(selTowns[0])) return '';
  const id = selTowns[0];
  return `<h3>Roads from ${esc(town(id).name)}</h3>${roadRows(game.graph.roads.filter((r) => r.a === id || r.b === id), id)}`;
}

function renderUi(force) {
  const s = selTowns.length === 1 ? state(selTowns[0]) : null;
  // Rebuild only when something other than a progress bar changes, so clicks are never lost mid-press.
  const afford = [50, 60, 100, 120, 150, 200, 240, 300, 350, 360, 400, 500, 600, 800, 1000, 1500].map((c) => live.me.money >= c);
  const g = selGroup !== null ? live.groups.find((x) => x.id === selGroup) : null;
  const key = JSON.stringify([selTowns, selGroup, selRoad, mode, details, afford, live.roads, g && [g.to, g.infantry, g.vehicle], pickAll, [...picked],
    selTowns.map((id) => [state(id).owner, state(id).garrison, state(id).visible, state(id).rally, state(id).supplied, state(id).market, state(id).fort, Math.round(state(id).income ?? 0)]),
    s?.buildings && Object.entries(s.buildings).map(([k, b]) => [k, b.done, b.queue, b.repeat])]);
  if (force || key !== cmdKey) {
    cmdKey = key;
    const html = cmdHtml();
    $('cmd').innerHTML = html;
    $('cmd').style.display = html ? 'flex' : 'none';
    const side = panelHtml();
    if (force || side !== panelKey) { panelKey = side; $('panel').innerHTML = side; $('panel').style.display = side ? 'block' : 'none'; }
  }
  drawProduction();
  // Progress shows as a clock wipe over the icon: the shaded part is what is left to do.
  for (const m of document.querySelectorAll('[data-meter]')) {
    const [id, kind] = m.dataset.meter.split('|');
    const b = state(id)?.buildings?.[kind];
    const idle = !b || (b.done && !b.queue);
    m.style.display = idle ? 'none' : 'block';
    if (!idle) m.style.setProperty('--p', (100 * (b.done ? b.training : b.progress)).toFixed(1));
  }
}

// ----- Production sidebar -----
// Every base and factory you own, wherever it is: queue units without finding the town first.

let prodKey = '';
function drawProduction() {
  const rows = game.graph.towns.filter((t) => mine(t.id) && Object.values(state(t.id).buildings ?? {}).some((b) => b.done));
  const cash = live.me.money;
  const key = JSON.stringify([rows.map((t) => [t.id, Object.entries(state(t.id).buildings).map(([k, b]) => [k, b.done, b.queue, b.repeat])]), selTowns,
    Object.values(game.rules.units).map((u) => cash >= u.cost)]);
  if (key === prodKey) return;
  prodKey = key;
  $('prod').style.display = rows.length ? 'block' : 'none';
  $('prod').innerHTML = '<header>Production</header>' + rows.map((t) => {
    const s = state(t.id);
    const tiles = Object.entries(game.rules.buildings).map(([kind, rule]) => {
      const b = s.buildings[kind], unit = game.rules.units[rule.trains];
      if (!b?.done) return '<span class="tile none"></span>';
      return `<button class="slot tile ${cash < unit.cost ? 'poor' : ''} ${b.repeat ? 'looping' : ''}" data-do="train:${rule.trains}" data-town="${t.id}"
        title="${esc(`${unit.name} in ${t.name}, ${unit.cost} each — click to queue one, Shift-click for five, right-click to cancel one${b.repeat ? '. Repeating' : ''}`)}">
        <span class="ico">${UI[rule.trains]}</span><span class="wipe" data-meter="${t.id}|${kind}"></span>${b.queue ? `<span class="count">${b.queue}</span>` : ''}</button>`;
    }).join('');
    return `<div class="prow ${selTowns.includes(t.id) ? 'sel' : ''}"><button class="pname" data-goto="${t.id}" title="Go to ${esc(t.name)}">${esc(t.name)}</button>${tiles}</div>`;
  }).join('');
}

function perform(does, at, many = false) {
  const [what, arg] = does.split(':'), id = at || selTowns[0];
  if (what === 'build') command({ type: 'build', town: id, building: arg });
  else if (what === 'train') { for (let k = 0; k < (many ? 5 : 1); k++) command({ type: 'train', town: id, unit: arg }); }
  else if (what === 'repeat') command({ type: 'repeat', town: id, unit: arg, on: !Object.entries(state(id).buildings).find(([k]) => game.rules.buildings[k].trains === arg)?.[1].repeat });
  else if (what === 'upgrade') command({ type: 'upgrade', town: id, upgrade: arg });
  else if (what === 'cut') command({ type: 'cut', road: does.slice(4) });
  else if (what === 'repair') command({ type: 'repair', road: does.slice(7) });
  else if (what === 'norally') command({ type: 'rally', town: id, to: null });
  else if (what === 'recall') command({ type: 'redirect', group: selGroup });
  else if (what === 'details') { details = !details; renderUi(true); }
  else if (what === 'pick') {
    const n = cardsOf(state(id).garrison).length;
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
  const i = Number(card.dataset.card), n = cardsOf(state(selTowns[0]).garrison).length;
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
  const cards = cardsOf(state(selTowns[0]).garrison), kind = cards[Number(card.dataset.card)].kind;
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
    if ($('help').style.display === 'block') $('help').style.display = 'none';
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
    const idle = game.graph.towns.filter((t) => mine(t.id) && total(state(t.id).garrison));
    if (!idle.length) return toast('No town of yours has units waiting');
    const at = idle.findIndex((t) => t.id === selTowns[0]);
    const next = idle[(at + (e.shiftKey ? idle.length - 1 : 1)) % idle.length];
    select({ towns: [next.id] });
    goTo(next.x, next.y);
  } else if (k === 'h' || k === 'H') {
    const c = town(live.me.capital);
    if (c) { select({ towns: [c.id] }); goTo(c.x, c.y); }
  } else if (k === 'j' || k === 'J') {
    if (lastPlace) goTo(lastPlace[0], lastPlace[1]); else toast('Nothing has happened yet');
  } else if (k === '?') {
    $('keys').click();
  } else {
    // Letters belong to whatever the command bar is showing. Shift picks the capital-letter action.
    const b = $('cmd').querySelector(`[data-key="${CSS.escape(k)}"]`) || (k.length === 1 && !e.shiftKey ? $('cmd').querySelector(`[data-key="${CSS.escape(k.toLowerCase())}"]`) : null);
    if (b && !b.disabled) { e.preventDefault(); perform(b.dataset.do); }
  }
});

// ----- Loading games -----

function onTick(data) {
  live = data;
  tickAt = performance.now();
  if (selGroup !== null && !live.groups.some((g) => g.id === selGroup)) { selGroup = null; mode = null; }
  drawHud();
  drawStatic();
  drawBadges();
  drawEvents();
  renderUi();
}

function onGraph(full) {
  game = full;
  land = full.territory;
  onTick(full.live);
  if (map?.getSource('world')) {
    map.getSource('world').setTiles([worldUrl('tiles', 'mvt')]);
    map.getSource('dem').setTiles([worldUrl('dem', 'png')]);
    map.getSource('terrain').setTiles([worldUrl('dem', 'png')]);
    map.getSource('mask').setData(mask());
    drawStatic(true);
    drawLand();
  }
}

function play(full) {
  game = full;
  live = full.live;
  land = full.territory;
  tickAt = performance.now();
  selTowns = []; selGroup = null; selRoad = null; mode = null; lastEvent = 0; lastPlace = null;
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
  stream.addEventListener('territory', (e) => { land = JSON.parse(e.data); drawLand(); });
}

async function refreshList(selectId) {
  const list = await api('');
  $('games').innerHTML = list.map((w) => `<option value="${w.id}">${esc(w.name)}</option>`).join('');
  if (selectId) $('games').value = selectId;
  $('delete').disabled = $('games').disabled = !list.length;
  return list;
}

async function newGame() {
  const name = prompt('Name for the new game', 'Campaign');
  if (name === null) return;
  veil('Generating a 528 km² map…');
  try {
    const full = await api('', { method: 'POST', body: { name } });
    await refreshList(full.world.id);
    play(full);
  } catch (err) { toast(`Could not start: ${err.message}`); }
  veil('');
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

const list = await refreshList();
const wanted = new URLSearchParams(location.search).get('game');
if (list.length) {
  const id = list.some((w) => w.id === wanted) ? wanted : list[0].id;
  $('games').value = id;
  play(await api(`/${id}/game`));
} else {
  toast('Press “New game” to begin');
}
