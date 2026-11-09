import * as maplibregl from '/vendor/maplibre-gl.mjs';
import { buildStyle } from '/style.js';

// The page for Conquer. The server runs the game; this draws it and sends commands.

const $ = (id) => document.getElementById(id);
const R = 6378137, DEG = 180 / Math.PI;
const toLngLat = (x, y) => [(x / R) * DEG, (2 * Math.atan(Math.exp(y / R)) - Math.PI / 2) * DEG];
const TIERS = ['Hamlet', 'Village', 'Town', 'City'];
const PLAYER = 1, UNKNOWN = -1;
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

let map = null;
let game = null;        // world, rules and the town/road graph
let live = null;        // what changes every tick
let tickAt = 0;
let stream = null;
let selTowns = [];      // selected town ids
let selGroup = null;    // selected group id
let selRoad = null;     // selected road id
let mode = null;        // what the next click on a town means: 'send', 'rally' or 'redirect'
let hovered = null;
const sendCount = {};   // unit kind → how many to send; missing means all
let panelKey = '';
let boxed = false;

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
const total = (u) => game.unitKinds.reduce((n, k) => n + (u[k] || 0), 0);
const unitText = (u) => game.unitKinds.filter((k) => u[k]).map((k) => `${u[k]} ${game.rules.units[k].name.toLowerCase()}`).join(', ') || 'none';
const counts = (id) => Object.fromEntries(game.unitKinds.map((k) => [k, Math.min(state(id).garrison?.[k] ?? 0, selTowns.length === 1 ? sendCount[k] ?? Infinity : Infinity)]));

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
  const sources = ['cq-areas', 'cq-roads', 'cq-cuts', 'cq-sites', 'cq-route', 'cq-labels', 'cq-groups'];
  for (const id of sources) map.addSource(id, { type: 'geojson', data: empty });
  // The game draws its own town names, so the map's are hidden.
  if (map.getLayer('place')) map.setLayoutProperty('place', 'visibility', 'none');
  const text = { 'text-font': ['sans-serif'], 'text-allow-overlap': true };
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
  map.addLayer({ id: 'cq-info', type: 'symbol', source: 'cq-labels', filter: ['!=', ['get', 'info'], ''],
    layout: { ...text, 'text-field': ['get', 'info'], 'text-size': 11.5, 'text-anchor': 'top', 'text-offset': [0, 0.25] },
    paint: { 'text-color': ['get', 'color'], 'text-halo-color': '#ffffff', 'text-halo-width': 1.8 } });
  map.addLayer({ id: 'cq-group-ring', type: 'circle', source: 'cq-groups', filter: ['==', ['get', 'selected'], 1],
    paint: { 'circle-radius': 14, 'circle-color': '#f5b301', 'circle-opacity': 0.9 } });
  map.addLayer({ id: 'cq-groups', type: 'circle', source: 'cq-groups',
    paint: { 'circle-radius': 9, 'circle-color': ['get', 'color'], 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 2 } });
  map.addLayer({ id: 'cq-group-label', type: 'symbol', source: 'cq-groups',
    layout: { ...text, 'text-field': ['get', 'label'], 'text-size': 10.5 }, paint: { 'text-color': '#ffffff' } });
  drawStatic(true);
}

let staticKey = '';
/** Everything on the overlay except moving groups and the route preview. Redrawn only when it changes. */
function drawStatic(force) {
  if (!map?.getSource('cq-areas')) return;
  const areas = [], labels = [], sites = [];
  for (const t of game.graph.towns) {
    const s = state(t.id), color = colorOf(s.owner), known = s.owner !== UNKNOWN;
    areas.push({ type: 'Feature', geometry: { type: 'Polygon', coordinates: ring(t.outline) },
      properties: { id: t.id, color, known: known ? 1 : 0, fill: s.owner === PLAYER ? 0.3 : known ? 0.22 : 0.1, selected: selTowns.includes(t.id) ? 1 : 0 } });
    const capital = live.factions.some((f) => f.capital === t.id);
    const info = s.visible ? (total(s.garrison) ? game.unitKinds.filter((k) => s.garrison[k]).map((k) => `${s.garrison[k]} ${k === 'infantry' ? 'inf' : 'veh'}`).join(' · ') : (s.owner === PLAYER ? 'undefended' : 'no defenders')) : '?';
    labels.push({ type: 'Feature', geometry: { type: 'Point', coordinates: toLngLat(t.x, t.y) },
      properties: { name: `${capital ? '★ ' : ''}${t.name}`, tier: t.tier, info: `${info}${s.supplied === false ? ' · cut off' : ''}`, color: s.owner === PLAYER ? '#12305c' : known && s.owner > 0 ? '#8a1535' : '#4a525b' } });
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
    if (selGroup !== null && mode === 'redirect') {
      const g = live.groups.find((x) => x.id === selGroup);
      if (g) toast(`Redirect to ${town(target).name} — click to confirm`);
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
  for (const k of Object.keys(sendCount)) delete sendCount[k];
  drawStatic();
  drawRoute();
  renderPanel(true);
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
  renderPanel(true);
}
const canOrder = () => (selGroup !== null && live.groups.find((g) => g.id === selGroup)?.owner === PLAYER) || selTowns.some(mine);

function startMap() {
  const start = town(live.me.capital) ?? game.graph.towns[0];
  map = new maplibregl.Map({
    container: 'map', style: buildStyle(worldUrl('tiles', 'mvt'), worldUrl('dem', 'png'), mask()),
    center: toLngLat(start.x, start.y), zoom: 12.2, minZoom: 8, maxZoom: 18, attributionControl: false, boxZoom: false,
  });
  window.map = map;
  map.addControl(new maplibregl.NavigationControl(), 'bottom-right');
  map.addControl(new maplibregl.ScaleControl({ maxWidth: 160 }), 'bottom-right');
  map.on('style.load', addOverlay);
  map.on('click', (e) => {
    if (boxed) { boxed = false; return; }
    const group = hit(e.point, 'cq-groups', 8), id = hit(e.point, 'cq-area'), road = hit(e.point, 'cq-road-hit', 6);
    const add = e.originalEvent.ctrlKey || e.originalEvent.metaKey;
    if (group !== null && !mode) return select({ group });
    if (id && mode && canOrder() && !selTowns.includes(id)) return order(id);
    if (id && add) return select({ towns: selTowns.includes(id) ? selTowns.filter((t) => t !== id) : [...selTowns.filter(mine), ...(mine(id) ? [id] : [])] });
    if (id) return select({ towns: [id] });
    if (road) return select({ road });
    select({});
  });
  map.on('contextmenu', (e) => {
    const id = hit(e.point, 'cq-area');
    if (id && canOrder() && !(selTowns.length === 1 && selTowns[0] === id)) order(id);
  });
  map.on('mousemove', (e) => {
    const id = hit(e.point, 'cq-area');
    map.getCanvas().style.cursor = id || hit(e.point, 'cq-groups', 8) !== null || hit(e.point, 'cq-road-hit', 6) ? 'pointer' : '';
    const target = id && canOrder() && !(selTowns.length === 1 && selTowns[0] === id) ? id : null;
    if (target !== hovered) { hovered = target; drawRoute(); }
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

// ----- Heads-up display and side panel -----

function drawHud() {
  const held = game.graph.towns.filter((t) => mine(t.id)).length;
  const net = live.me.income - live.me.upkeep;
  $('money').textContent = Math.floor(live.me.money).toLocaleString();
  $('income').textContent = `money, ${net >= 0 ? '+' : '−'}${Math.abs(Math.round(net))} a minute`;
  $('income').title = `Income ${Math.round(live.me.income)}, upkeep ${Math.round(live.me.upkeep)} a minute`;
  $('towns').textContent = `${held} of ${game.graph.towns.length}`;
  $('goal').textContent = `towns held, ${live.goal} wins`;
  const s = Math.floor(live.clock);
  $('clock').textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  for (const b of $('speed').children) b.classList.toggle('on', Number(b.dataset.speed) === live.speed);
  $('log').innerHTML = live.events.slice(-4).map((e) => `<div>${esc(e.text)}</div>`).join('') + (live.growing ? '<div>Mapping new territory…</div>' : '');
  const over = live.winner !== null && !live.dismissed;
  $('result').style.display = over ? 'flex' : 'none';
  if (over) {
    $('result-title').textContent = live.winner === PLAYER ? 'Victory' : 'Defeat';
    $('result-text').textContent = live.winner === PLAYER
      ? (faction(2)?.alive === false ? 'You took the rival capital.' : `You hold ${held} of ${game.graph.towns.length} towns.`)
      : (mine(live.me.capital) ? 'The rival holds most of the map.' : 'Your capital has fallen.');
  }
}

const traitText = (t) => [t.traits.hill && 'hill site', t.traits.river && 'river', t.traits.port && 'port', t.traits.rail && 'railway'].filter(Boolean).join(' · ');

function roadRows(roads) {
  return roads.map((r) => {
    const c = cutState(r.id), bridge = r.bridges.length > 0, k = game.rules.roads;
    const canAct = mine(r.a) || mine(r.b);
    const where = selTowns.length === 1 ? `to ${town(r.a === selTowns[0] ? r.b : r.a).name}` : `${town(r.a).name} – ${town(r.b).name}`;
    let action = '';
    if (c?.repair >= 0) action = '<span>being repaired</span>';
    else if (c) action = canAct ? `<button data-repair="${r.id}" ${live.me.money < (bridge ? k.repairBridge : k.repair) ? 'disabled' : ''}>Repair <span class="cost">${bridge ? k.repairBridge : k.repair}</span></button>` : '<span>cut</span>';
    else if (canAct) action = `<button data-cut="${r.id}" ${live.me.money < (bridge ? k.cutBridge : k.cut) ? 'disabled' : ''}>Cut <span class="cost">${bridge ? k.cutBridge : k.cut}</span></button>`;
    return `<div class="row road"><span style="flex:1">${r.ref || r.kind[0].toUpperCase() + r.kind.slice(1)} ${esc(where)}<br><span class="hint">${(r.length / 1000).toFixed(1)} km${bridge ? ', bridge' : ''}</span></span>${action}</div>`;
  }).join('');
}

function panelHtml() {
  const cash = live.me.money, rules = game.rules;
  if (selGroup !== null) {
    const g = live.groups.find((x) => x.id === selGroup);
    if (!g) return '';
    const own = g.owner === PLAYER;
    return `<h2>Group of ${g.infantry + g.vehicle}</h2><div class="sub">${own ? 'Yours' : esc(faction(g.owner).name)} · ${unitText(g)} · heading for ${esc(town(g.to).name)}</div>`
      + (own ? `<div class="row"><button data-mode="redirect" class="${mode === 'redirect' ? 'on' : 'primary'}">${mode === 'redirect' ? 'Now click a town… (cancel)' : 'Redirect to…'}</button></div>
        <div class="row"><button data-recall>Recall to ${esc(town(g.from).name)}</button></div><div class="hint">Or right-click any town.</div>` : '');
  }
  if (selRoad) {
    const r = roadOf(selRoad);
    return `<h2>${r.ref || 'Road'}</h2><div class="sub">${r.kind[0].toUpperCase() + r.kind.slice(1)} road · vehicles ${rules.speed.vehicle[r.kind] ?? rules.speed.vehicle.tertiary} km/h</div>${roadRows([r])}
      <div class="hint">You can cut or repair a road if you hold a town at either end. A cut road cannot be used by anyone, and towns it isolates from their capital earn half.</div>`;
  }
  if (selTowns.length > 1) {
    const sum = Object.fromEntries(game.unitKinds.map((k) => [k, selTowns.reduce((n, id) => n + (state(id).garrison?.[k] ?? 0), 0)]));
    return `<h2>${selTowns.length} towns</h2><div class="sub">${selTowns.map((id) => esc(town(id).name)).join(', ')}</div><h3>Garrisons</h3><div class="row">${unitText(sum)}</div>
      <div class="row"><button data-mode="send" class="${mode === 'send' ? 'on' : 'primary'}">${mode === 'send' ? 'Now click a town… (cancel)' : 'Send all to…'}</button></div>
      <div class="hint">Or right-click any town. Each town's units travel as their own group.</div>`;
  }
  if (selTowns.length !== 1) return '';
  const id = selTowns[0], t = town(id), s = state(id), own = s.owner === PLAYER;
  const traits = traitText(t);
  let html = `<h2>${esc(t.name)}</h2><div class="sub">${TIERS[t.tier]} · ${ownerName(s.owner)}${traits ? ` · ${traits}` : ''}</div>`;
  if (!own) {
    html += `<div class="row">Defence ×${s.defence.toFixed(2)}${s.visible ? `, defenders: ${unitText(s.garrison)} (strength ${defencePower(s.garrison, s.defence).toFixed(1)})` : ', defenders unknown'}</div>
      <div class="hint">Select one of your towns, then right-click here to attack. A group stops at the first town on its way that you do not hold.</div>`;
    return html;
  }
  html += `<div class="row">Earns ${Math.round(s.income)} a minute${s.supplied ? '' : ' (halved: cut off from your capital)'} · defence ×${s.defence.toFixed(2)}</div><h3>Buildings</h3>`;
  for (const [kind, rule] of Object.entries(rules.buildings)) {
    const b = s.buildings[kind], unit = rules.units[rule.trains];
    if (!b) html += `<div class="row"><button data-build="${kind}" ${cash < rule.cost ? 'disabled' : ''}>Build ${rule.name.toLowerCase()} <span class="cost">${rule.cost}</span></button></div>`;
    else if (!b.done) html += `<div class="row">${rule.name} under construction</div><div class="meter"><div data-meter="${kind}"></div></div>`;
    else html += `<div class="row"><button data-train="${rule.trains}" ${cash < unit.cost ? 'disabled' : ''}>Train ${unit.name.toLowerCase()} <span class="cost">${unit.cost}</span></button>
      <label class="check" title="Keep training one after another while there is money"><input type="checkbox" data-repeat="${rule.trains}" ${b.repeat ? 'checked' : ''}> repeat</label></div>
      <div class="meter"><div data-meter="${kind}"></div></div>${b.queue ? `<div class="hint" style="margin-top:-6px">${b.queue} in training</div>` : ''}`;
  }
  html += '<h3>Upgrades</h3>';
  for (const [kind, rule] of Object.entries(rules.upgrades)) {
    const level = kind === 'market' ? s.market : s.fort;
    html += level >= rules.maxLevel ? `<div class="row">${rule.name}: level ${level}, complete</div>`
      : `<div class="row"><button data-upgrade="${kind}" ${cash < s.costs[kind] ? 'disabled' : ''}>${rule.name} ${level} → ${level + 1} (+${rule.perLevel * 100}% ${rule.effect}) <span class="cost">${s.costs[kind]}</span></button></div>`;
  }
  html += '<h3>Garrison</h3>';
  if (!total(s.garrison)) html += '<div class="hint">No units here. Build a base, then train some.</div>';
  else {
    html += game.unitKinds.filter((k) => s.garrison[k]).map((k) => `<div class="row send"><label for="send-${k}" style="flex:1">${rules.units[k].name} — ${s.garrison[k]} here, send</label>
      <input id="send-${k}" data-send="${k}" type="number" min="0" max="${s.garrison[k]}" value="${Math.min(s.garrison[k], sendCount[k] ?? s.garrison[k])}"></div>`).join('');
    html += `<div class="row"><button data-mode="send" class="${mode === 'send' ? 'on' : 'primary'}">${mode === 'send' ? 'Now click a town… (cancel)' : 'Send to…'}</button></div>
      <div class="hint">Or right-click any town. A mixed group moves at infantry pace.</div>`;
  }
  html += `<div class="row" style="margin-top:8px"><span style="flex:1">New units go to: <b>${s.rally ? esc(town(s.rally).name) : 'stay here'}</b></span>
    <button data-mode="rally" class="${mode === 'rally' ? 'on' : ''}" style="flex:none">${mode === 'rally' ? 'Click a town…' : 'Set'}</button>${s.rally ? '<button data-norally style="flex:none">Clear</button>' : ''}</div>`;
  html += `<h3>Roads</h3>${roadRows(game.graph.roads.filter((r) => r.a === id || r.b === id))}`;
  return html;
}

function renderPanel(force) {
  const el = $('panel');
  const s = selTowns.length === 1 ? state(selTowns[0]) : null;
  // Rebuild only when something other than a progress bar changes, so clicks are never lost mid-press.
  const afford = [50, 60, 100, 120, 150, 200, 240, 300, 350, 360, 400, 500, 600, 800, 1000, 1500].map((c) => live.me.money >= c);
  const g = selGroup !== null ? live.groups.find((x) => x.id === selGroup) : null;
  const key = JSON.stringify([selTowns, selGroup, selRoad, mode, afford, live.roads, g && [g.to, g.infantry, g.vehicle],
    selTowns.map((id) => [state(id).owner, state(id).garrison, state(id).visible, state(id).rally, state(id).supplied, state(id).market, state(id).fort, Math.round(state(id).income ?? 0)]),
    s?.buildings && Object.entries(s.buildings).map(([k, b]) => [k, b.done, b.queue, b.repeat])]);
  if (force || key !== panelKey) {
    panelKey = key;
    const html = panelHtml();
    el.innerHTML = html;
    el.style.display = html ? 'block' : 'none';
  }
  if (s?.buildings) {
    for (const m of el.querySelectorAll('[data-meter]')) {
      const b = s.buildings[m.dataset.meter];
      if (b) m.style.width = `${100 * (b.done ? b.training : b.progress)}%`;
    }
  }
}

$('panel').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  const d = b.dataset, id = selTowns[0];
  if (d.build) command({ type: 'build', town: id, building: d.build });
  else if (d.train) command({ type: 'train', town: id, unit: d.train });
  else if (d.upgrade) command({ type: 'upgrade', town: id, upgrade: d.upgrade });
  else if (d.cut) command({ type: 'cut', road: d.cut });
  else if (d.repair) command({ type: 'repair', road: d.repair });
  else if ('norally' in d) command({ type: 'rally', town: id, to: null });
  else if ('recall' in d) command({ type: 'redirect', group: selGroup });
  else if (d.mode) {
    mode = mode === d.mode ? null : d.mode;
    renderPanel(true);
    if (mode) toast(mode === 'rally' ? 'Click one of your other towns' : 'Click the town to send them to');
  }
});
$('panel').addEventListener('input', (e) => {
  if (e.target.dataset.send) sendCount[e.target.dataset.send] = Math.max(0, Number(e.target.value) || 0);
  if (e.target.dataset.repeat) command({ type: 'repeat', town: selTowns[0], unit: e.target.dataset.repeat, on: e.target.checked });
});
$('speed').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (b && game) command({ type: 'speed', value: Number(b.dataset.speed) });
});
$('keep').addEventListener('click', () => command({ type: 'dismiss' }));
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { if (mode) { mode = null; renderPanel(true); } else select({}); }
});

// ----- Loading games -----

function onTick(data) {
  live = data;
  tickAt = performance.now();
  if (selGroup !== null && !live.groups.some((g) => g.id === selGroup)) { selGroup = null; mode = null; }
  drawHud();
  drawStatic();
  renderPanel();
}

function onGraph(full) {
  game = full;
  onTick(full.live);
  if (map?.getSource('world')) {
    map.getSource('world').setTiles([worldUrl('tiles', 'mvt')]);
    map.getSource('dem').setTiles([worldUrl('dem', 'png')]);
    map.getSource('terrain').setTiles([worldUrl('dem', 'png')]);
    map.getSource('mask').setData(mask());
    drawStatic(true);
  }
}

function play(full) {
  game = full;
  live = full.live;
  tickAt = performance.now();
  selTowns = []; selGroup = null; selRoad = null; mode = null;
  history.replaceState(null, '', `?game=${game.world.id}`);
  if (map) { map.remove(); map = null; }
  startMap();
  drawHud();
  renderPanel(true);
  stream?.close();
  stream = new EventSource(`/api/conquer/${game.world.id}/events`);
  stream.addEventListener('tick', (e) => onTick(JSON.parse(e.data)));
  stream.addEventListener('graph', (e) => onGraph(JSON.parse(e.data)));
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
