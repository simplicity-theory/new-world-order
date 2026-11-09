import * as maplibregl from '/vendor/maplibre-gl.mjs';
import { buildStyle } from '/style.js';

// The page for Conquer. The server runs the game; this draws it and sends commands.

const $ = (id) => document.getElementById(id);
const R = 6378137, DEG = 180 / Math.PI;
const toLngLat = (x, y) => [(x / R) * DEG, (2 * Math.atan(Math.exp(y / R)) - Math.PI / 2) * DEG];
const TIERS = ['Hamlet', 'Village', 'Town', 'City'];
const PLAYER = 1;

let map = null;
let game = null;        // world, rules and the town/road graph
let live = null;        // what changes every tick
let tickAt = 0;
let stream = null;
let selected = null;    // town id
let targeting = false;
let hovered = null;
const sendCount = {};   // unit kind → how many to send; missing means all
let panelKey = '';

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
  toastTimer = setTimeout(() => { $('toast').style.display = 'none'; }, 2600);
}
const veil = (text) => { $('veil').textContent = text || ''; $('veil').style.display = text ? 'flex' : 'none'; };
const command = (c) => api(`/${game.world.id}/command`, { method: 'POST', body: c }).catch((err) => toast(err.message[0].toUpperCase() + err.message.slice(1)));

// ----- Game data helpers -----

const town = (id) => game.graph.towns.find((t) => t.id === id);
const mine = (id) => live.towns[id]?.owner === PLAYER;
const money = () => live.factions.find((f) => f.id === PLAYER).money;
const colorOf = (owner) => live.factions.find((f) => f.id === owner)?.color ?? '#8b9097';

/** Shortest route by road, mirroring the server's rule, for previews. */
function route(from, to) {
  const dist = new Map([[from, 0]]), via = new Map(), done = new Set();
  for (;;) {
    let cur = null, best = Infinity;
    for (const [k, d] of dist) if (!done.has(k) && d < best) { best = d; cur = k; }
    if (cur === null) return null;
    if (cur === to) break;
    done.add(cur);
    for (const r of game.graph.roads) {
      if (!r.intact || (r.a !== cur && r.b !== cur)) continue;
      const other = r.a === cur ? r.b : r.a, d = best + r.length;
      if (d < (dist.get(other) ?? Infinity)) { dist.set(other, d); via.set(other, { r, prev: cur }); }
    }
  }
  const pts = [];
  for (let at = to; at !== from;) {
    const { r, prev } = via.get(at);
    pts.unshift(...(r.a === prev ? r.pts : [...r.pts].reverse()));
    at = prev;
  }
  return { pts, length: dist.get(to) };
}

function pointAlong(pts, d) {
  for (let i = 0; i + 1 < pts.length; i++) {
    const l = Math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]);
    if (d <= l) return [pts[i][0] + ((pts[i + 1][0] - pts[i][0]) * d) / l, pts[i][1] + ((pts[i + 1][1] - pts[i][1]) * d) / l];
    d -= l;
  }
  return pts[pts.length - 1];
}

const garrisonText = (g) => game.unitKinds.filter((k) => g[k]).map((k) => `${g[k]} ${game.rules.units[k].name.toLowerCase()}`).join(', ');
const counts = (id) => Object.fromEntries(game.unitKinds.map((k) => [k, Math.min(live.towns[id].garrison[k], sendCount[k] ?? Infinity)]));

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

function addOverlay() {
  for (const id of ['cq-route', 'cq-towns', 'cq-groups']) map.addSource(id, { type: 'geojson', data: empty });
  map.addLayer({ id: 'cq-route', type: 'line', source: 'cq-route', layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': '#1f6feb', 'line-width': 6, 'line-opacity': 0.5 } });
  map.addLayer({ id: 'cq-town-ring', type: 'circle', source: 'cq-towns', filter: ['==', ['get', 'selected'], 1],
    paint: { 'circle-radius': ['+', ['get', 'size'], 7], 'circle-color': '#ffd54a', 'circle-opacity': 0.85 } });
  map.addLayer({ id: 'cq-towns', type: 'circle', source: 'cq-towns',
    paint: { 'circle-radius': ['get', 'size'], 'circle-color': ['get', 'color'], 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 2.5 } });
  // The game draws its own town names beside the markers, so the map's are hidden.
  if (map.getLayer('place')) map.setLayoutProperty('place', 'visibility', 'none');
  map.addLayer({ id: 'cq-town-name', type: 'symbol', source: 'cq-towns',
    layout: { 'text-field': ['get', 'name'], 'text-font': ['sans-serif'], 'text-size': ['+', 12, ['*', 2, ['get', 'tier']]],
      'text-anchor': 'top', 'text-offset': [0, 0.9], 'text-allow-overlap': true },
    paint: { 'text-color': ['case', ['==', ['get', 'own'], 1], '#12305c', '#2b3440'], 'text-halo-color': '#ffffffe6', 'text-halo-width': 1.8 } });
  map.addLayer({ id: 'cq-town-label', type: 'symbol', source: 'cq-towns', filter: ['!=', ['get', 'label'], ''],
    layout: { 'text-field': ['get', 'label'], 'text-font': ['sans-serif'], 'text-size': 11.5, 'text-anchor': 'bottom', 'text-offset': [0, -1.1], 'text-allow-overlap': true },
    paint: { 'text-color': '#12305c', 'text-halo-color': '#ffffff', 'text-halo-width': 2 } });
  map.addLayer({ id: 'cq-groups', type: 'circle', source: 'cq-groups',
    paint: { 'circle-radius': 8, 'circle-color': ['get', 'color'], 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 2 } });
  map.addLayer({ id: 'cq-group-label', type: 'symbol', source: 'cq-groups',
    layout: { 'text-field': ['get', 'label'], 'text-font': ['sans-serif'], 'text-size': 10.5, 'text-allow-overlap': true },
    paint: { 'text-color': '#ffffff' } });
  drawTowns(true);
}

let townsKey = '';
function drawTowns(force) {
  if (!map?.getSource('cq-towns')) return;
  const features = game.graph.towns.map((t) => {
    const s = live.towns[t.id];
    return { type: 'Feature', geometry: { type: 'Point', coordinates: toLngLat(t.x, t.y) },
      properties: { id: t.id, name: t.name, tier: t.tier, own: s.owner === PLAYER ? 1 : 0, size: 6 + t.tier * 2, color: colorOf(s.owner), selected: t.id === selected ? 1 : 0,
        label: s.owner === PLAYER ? garrisonText(s.garrison) : '' } };
  });
  const key = JSON.stringify(features.map((f) => f.properties));
  if (!force && key === townsKey) return;
  townsKey = key;
  map.getSource('cq-towns').setData(collection(features));
}

function drawGroups() {
  if (!map?.getSource('cq-groups') || !live) return;
  // Between ticks, carry each group forward at its speed so movement is smooth.
  const ahead = Math.min(0.4, (performance.now() - tickAt) / 1000) * live.speed;
  map.getSource('cq-groups').setData(collection(live.groups.map((g) => {
    const leg = g.path[g.leg];
    const road = game.graph.roads.find((r) => r.id === leg.road);
    const pts = leg.rev ? [...road.pts].reverse() : road.pts;
    const [x, y] = pointAlong(pts, Math.min(road.length, g.dist + g.speed * ahead));
    return { type: 'Feature', geometry: { type: 'Point', coordinates: toLngLat(x, y) },
      properties: { color: colorOf(g.owner), label: String(g.infantry + g.vehicle) } };
  })));
}
function frame() { drawGroups(); requestAnimationFrame(frame); }

function drawRoute() {
  if (!map?.getSource('cq-route')) return;
  let data = empty;
  if (selected && mine(selected) && hovered && hovered !== selected) {
    const r = route(selected, hovered);
    const c = counts(selected);
    if (r && (c.infantry || c.vehicle)) {
      data = { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: r.pts.map(([x, y]) => toLngLat(x, y)) } };
      const kmh = c.infantry ? game.rules.units.infantry.kmh : game.rules.units.vehicle.kmh;
      const secs = r.length / ((kmh / 3.6) * game.rules.timeScale);
      toast(`${town(hovered).name}: ${(r.length / 1000).toFixed(1)} km by road, about ${Math.round(secs)} s — ${targeting ? 'click' : 'right-click'} to send`);
    } else if (!r) toast(`No road leads to ${town(hovered).name}`);
  }
  map.getSource('cq-route').setData(data);
}

function townAt(point) {
  const hit = map.queryRenderedFeatures([[point.x - 8, point.y - 8], [point.x + 8, point.y + 8]], { layers: ['cq-towns'] });
  return hit.length ? hit[0].properties.id : null;
}

function send(to) {
  const c = counts(selected);
  if (!c.infantry && !c.vehicle) return toast('No units here to send');
  command({ type: 'move', from: selected, to, ...c });
  targeting = false;
  hovered = null;
  drawRoute();
  renderPanel(true);
}

function select(id) {
  selected = id;
  targeting = false;
  for (const k of Object.keys(sendCount)) delete sendCount[k];
  drawTowns();
  drawRoute();
  renderPanel(true);
}

function startMap() {
  const start = town(game.start);
  map = new maplibregl.Map({
    container: 'map', style: buildStyle(worldUrl('tiles', 'mvt'), worldUrl('dem', 'png'), mask()),
    center: toLngLat(start.x, start.y), zoom: 12.4, minZoom: 8, maxZoom: 18, attributionControl: false,
  });
  window.map = map;
  map.addControl(new maplibregl.NavigationControl(), 'bottom-right');
  map.addControl(new maplibregl.ScaleControl({ maxWidth: 160 }), 'bottom-right');
  map.on('style.load', addOverlay);
  map.on('click', (e) => {
    const id = townAt(e.point);
    if (id && id !== selected && selected && mine(selected) && (targeting || e.originalEvent.shiftKey)) send(id);
    else select(id);
  });
  map.on('contextmenu', (e) => {
    const id = townAt(e.point);
    if (id && id !== selected && selected && mine(selected)) send(id);
  });
  map.on('mousemove', (e) => {
    const id = townAt(e.point);
    map.getCanvas().style.cursor = id ? 'pointer' : '';
    if (id !== hovered) { hovered = id; drawRoute(); }
  });
  requestAnimationFrame(frame);
}

// ----- Heads-up display and town panel -----

function drawHud() {
  const held = game.graph.towns.filter((t) => mine(t.id));
  const income = held.reduce((sum, t) => sum + game.rules.income[t.tier], 0);
  $('money').textContent = Math.floor(money()).toLocaleString();
  $('income').textContent = `money, +${income} a minute`;
  $('towns').textContent = `${held.length} of ${game.graph.towns.length}`;
  const s = Math.floor(live.clock);
  $('clock').textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  for (const b of $('speed').children) b.classList.toggle('on', Number(b.dataset.speed) === live.speed);
  $('log').innerHTML = live.events.slice(-4).map((e) => `<div>${e.text}</div>`).join('') + (live.growing ? '<div>Mapping new territory…</div>' : '');
}

function renderPanel(force) {
  const el = $('panel');
  if (!selected || !live.towns[selected]) { el.style.display = 'none'; panelKey = ''; return; }
  const t = town(selected), s = live.towns[selected], own = s.owner === PLAYER, cash = money();
  // Rebuild only when something other than a progress bar changes, so clicks are never lost mid-press.
  const afford = [...Object.values(game.rules.buildings), ...Object.values(game.rules.units)].map((r) => cash >= r.cost);
  const key = JSON.stringify([selected, s.owner, s.garrison, afford, targeting,
    Object.entries(s.buildings).map(([k, b]) => [k, b.done, b.queue])]);
  if (force || key !== panelKey) {
    panelKey = key;
    let html = `<h2>${t.name}</h2><div class="sub">${TIERS[t.tier]} · ${own ? 'yours' : 'neutral'} · ${own ? 'earns' : 'would earn'} ${game.rules.income[t.tier]} a minute</div>`;
    if (own) {
      html += '<h3>Buildings</h3>';
      for (const [kind, rule] of Object.entries(game.rules.buildings)) {
        const b = s.buildings[kind], unit = game.rules.units[rule.trains];
        if (!b) html += `<div class="row"><button data-build="${kind}" ${cash < rule.cost ? 'disabled' : ''}>Build ${rule.name.toLowerCase()} <span class="cost">${rule.cost}</span></button></div>`;
        else if (!b.done) html += `<div class="row">${rule.name} under construction</div><div class="meter"><div data-meter="${kind}"></div></div>`;
        else html += `<div class="row"><button data-train="${rule.trains}" ${cash < unit.cost ? 'disabled' : ''}>Train ${unit.name.toLowerCase()} <span class="cost">${unit.cost}</span></button>
          <span>${b.queue ? `${b.queue} queued` : ''}</span></div><div class="meter"><div data-meter="${kind}"></div></div>`;
      }
      html += '<h3>Garrison</h3>';
      const any = game.unitKinds.some((k) => s.garrison[k]);
      if (!any) html += '<div class="hint">No units here. Build a base, then train some.</div>';
      else {
        html += game.unitKinds.filter((k) => s.garrison[k]).map((k) => `<div class="row send"><label for="send-${k}" style="flex:1">${game.rules.units[k].name} — ${s.garrison[k]} here, send</label>
          <input id="send-${k}" data-send="${k}" type="number" min="0" max="${s.garrison[k]}" value="${Math.min(s.garrison[k], sendCount[k] ?? s.garrison[k])}"></div>`).join('');
        html += `<div class="row"><button data-target class="${targeting ? 'on' : 'primary'}">${targeting ? 'Now click a town… (cancel)' : 'Send to…'}</button></div>
          <div class="hint">Or right-click any town. Units follow the roads; a mixed group moves at infantry pace.</div>`;
      }
    } else {
      html += '<div class="hint">Select one of your towns and send units here to take it.</div>';
    }
    el.innerHTML = html;
    el.style.display = 'block';
  }
  for (const m of el.querySelectorAll('[data-meter]')) {
    const b = s.buildings[m.dataset.meter];
    if (b) m.style.width = `${100 * (b.done ? b.training : b.progress)}%`;
  }
}

$('panel').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  if (b.dataset.build) command({ type: 'build', town: selected, building: b.dataset.build });
  else if (b.dataset.train) command({ type: 'train', town: selected, unit: b.dataset.train });
  else if ('target' in b.dataset) { targeting = !targeting; renderPanel(true); if (targeting) toast('Click the town to send them to'); }
});
$('panel').addEventListener('input', (e) => {
  if (e.target.dataset.send) sendCount[e.target.dataset.send] = Math.max(0, Number(e.target.value) || 0);
});
$('speed').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (b && game) command({ type: 'speed', value: Number(b.dataset.speed) });
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { if (targeting) { targeting = false; renderPanel(true); } else select(null); }
});

// ----- Loading games -----

function onTick(data) {
  live = data;
  tickAt = performance.now();
  drawHud();
  drawTowns();
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
    drawTowns(true);
  }
}

function play(full) {
  game = full;
  live = full.live;
  tickAt = performance.now();
  selected = null;
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
  $('games').innerHTML = list.map((w) => `<option value="${w.id}">${w.name.replace(/</g, '&lt;')}</option>`).join('');
  if (selectId) $('games').value = selectId;
  $('delete').disabled = $('games').disabled = !list.length;
  return list;
}

$('games').addEventListener('change', async (e) => play(await api(`/${e.target.value}/game`)));
$('new').addEventListener('click', async () => {
  const name = prompt('Name for the new game', 'Campaign');
  if (name === null) return;
  veil('Generating a 528 km² map…');
  try {
    const full = await api('', { method: 'POST', body: { name } });
    await refreshList(full.world.id);
    play(full);
  } catch (err) { toast(`Could not start: ${err.message}`); }
  veil('');
});
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
  veil('');
  toast('Press “New game” to begin');
}
