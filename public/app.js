import * as maplibregl from '/vendor/maplibre-gl.mjs';
import { buildStyle } from '/style.js';

const $ = (id) => document.getElementById(id);
const R = 6378137, DEG = 180 / Math.PI;
const toLngLat = (x, y) => [(x / R) * DEG, (2 * Math.atan(Math.exp(y / R)) - Math.PI / 2) * DEG];
const toMetres = (lng, lat) => [(lng / DEG) * R, R * Math.log(Math.tan(Math.PI / 4 + lat / DEG / 2))];

let map = null;
let world = null;
let threeD = false;

async function api(path, options) {
  const res = await fetch(`/api${path}`, options && {
    method: options.method, headers: { 'content-type': 'application/json' },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

const tilesUrl = (w) => `${location.origin}/api/worlds/${w.id}/tiles/{z}/{x}/{y}.mvt?v=${w.version}`;
const demUrl = (w) => `${location.origin}/api/worlds/${w.id}/dem/{z}/{x}/{y}.png?v=${w.version}`;
const bounds = (w, pad = 0) => {
  const b = w.boundsM, px = (b.maxx - b.minx) * pad, py = (b.maxy - b.miny) * pad;
  return [toLngLat(b.minx - px, b.miny - py), toLngLat(b.maxx + px, b.maxy + py)];
};
/** Everything outside the generated rectangle, so hillshade does not spill past the edge. */
const mask = (w) => {
  const [[w0, s0], [e0, n0]] = bounds(w);
  return { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [
    [[-170, -80], [170, -80], [170, 80], [-170, 80], [-170, -80]],
    [[w0, s0], [w0, n0], [e0, n0], [e0, s0], [w0, s0]],
  ] } };
};

function setStatus(text) { $('status').textContent = text; }
const secs = (ms) => (ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${Math.round(ms)} ms`);
const size = (w) => `${w.widthKm} × ${w.heightKm} km`;

function apply3d() {
  if (!map?.getLayer('building-3d')) return;
  map.setTerrain(threeD ? { source: 'terrain', exaggeration: 1.5 } : null);
  map.setLayoutProperty('building-3d', 'visibility', threeD ? 'visible' : 'none');
  map.setLayoutProperty('building', 'visibility', threeD ? 'none' : 'visible');
  $('threed').classList.toggle('on', threeD);
}

function showWorld(w, { refit }) {
  const same = world?.id === w.id;
  world = w;
  history.replaceState(null, '', `?world=${w.id}`);
  if (!map) {
    map = new maplibregl.Map({
      container: 'map', style: buildStyle(tilesUrl(w), demUrl(w), mask(w)), bounds: bounds(w, 0.08),
      minZoom: 7, maxZoom: 19.5, maxPitch: 75, attributionControl: false,
    });
    map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'top-right');
    map.addControl(new maplibregl.ScaleControl({ maxWidth: 160 }), 'bottom-right');
    map.on('style.load', apply3d);
    window.map = map;
  } else {
    // Same world, more land: swap the tile URLs so only the tiles reload.
    if (same && map.getSource('world')) {
      map.getSource('world').setTiles([tilesUrl(w)]);
      map.getSource('dem').setTiles([demUrl(w)]);
      map.getSource('terrain').setTiles([demUrl(w)]);
      map.getSource('mask').setData(mask(w));
    } else map.setStyle(buildStyle(tilesUrl(w), demUrl(w), mask(w)));
    if (refit) map.fitBounds(bounds(w, 0.08), { duration: 900 });
  }
  setStatus(`${w.name} — ${size(w)}, seed “${w.seed}”${w.stale ? ' — made with an older generator, new land will not line up' : ''}`);
  // The game starts from the same seed, so it is played on this same world.
  const play = document.querySelector('#panel h1 a');
  if (play) play.href = `/conquer?seed=${encodeURIComponent(w.seed)}&name=${encodeURIComponent(w.name)}`;
  loadStats();
}

async function loadStats() {
  if (!world) return;
  const s = await api(`/worlds/${world.id}/stats`);
  const rows = s.expansions.map((e) => `<tr>
    <td>${e.sides === 'start' ? 'start' : `${e.sides.length === 4 ? 'all' : e.sides.toUpperCase()} +${Math.ceil(e.km / s.world.chunkKm) * s.world.chunkKm} km`}</td>
    <td>${e.chunks}</td><td>${secs(e.gen_ms)}</td><td>${secs(e.serialize_ms + e.save_ms)}</td>
    <td>${secs(e.total_ms)}</td><td>${(e.bytes / 1048576).toFixed(1)}</td></tr>`).join('');
  const t = s.totals;
  $('stats').innerHTML = `<table>
    <tr><th>added</th><th>chunks</th><th title="Generation time summed over all threads">generate</th><th>save</th><th title="Elapsed time">elapsed</th><th>MB</th></tr>${rows}</table>
    <div id="totals">${t.chunks} chunks, ${t.area_km2} km², ${t.features.toLocaleString()} features, ${s.threads} generator threads<br>
    ${t.gen_ms_per_km2} ms and ${(t.bytes_per_km2 / 1024).toFixed(0)} kB per km²; slowest chunk ${secs(t.slowest_chunk_ms)}<br>
    ${s.elevation_tiles.tiles} elevation tiles built in ${secs(s.elevation_tiles.ms || 0)}, slowest ${secs(s.elevation_tiles.slowest_ms || 0)}</div>`;
}

async function refreshList(selectId) {
  const worlds = await api('/worlds');
  $('worlds').innerHTML = worlds.map((w) => `<option value="${w.id}">${w.name.replace(/</g, '&lt;')}</option>`).join('');
  if (selectId) $('worlds').value = selectId;
  $('expand').disabled = $('delete').disabled = !worlds.length;
  return worlds;
}

async function openWorld(id) {
  showWorld(await api(`/worlds/${id}`), { refit: true });
}

function busy(on) {
  for (const id of ['expand', 'new', 'delete', 'worlds', 'sides']) $(id).disabled = on;
  $('bar').style.visibility = on ? 'visible' : 'hidden';
  if (!on) $('bar').firstElementChild.style.width = '0';
}

/** Which sides to grow so the world extends toward what the map is showing. */
function sidesTowardView() {
  const c = map.getCenter();
  const [x, y] = toMetres(c.lng, c.lat);
  const b = world.boundsM;
  const dx = (x - (b.minx + b.maxx) / 2) / ((b.maxx - b.minx) / 2), dy = (y - (b.miny + b.maxy) / 2) / ((b.maxy - b.miny) / 2);
  const sides = [];
  if (dx > 0.4) sides.push('e');
  if (dx < -0.4) sides.push('w');
  if (dy > 0.4) sides.push('n');
  if (dy < -0.4) sides.push('s');
  return sides.length ? sides : ['n', 'e', 's', 'w'];
}

$('worlds').addEventListener('change', (e) => openWorld(e.target.value));

$('threed').addEventListener('click', () => {
  threeD = !threeD;
  apply3d();
  map.easeTo({ pitch: threeD ? 60 : 0, bearing: threeD ? map.getBearing() : 0, duration: 800 });
});

$('new').addEventListener('click', async () => {
  const name = prompt('Name for the new world', 'New world');
  if (name === null) return;
  const seed = prompt('Seed (leave blank for random)', '');
  if (seed === null) return;
  busy(true);
  setStatus('Creating world…');
  try {
    const w = await api('/worlds', { method: 'POST', body: { name, seed } });
    await refreshList(w.id);
    showWorld(w, { refit: true });
  } catch (err) { setStatus(`Failed: ${err.message}`); }
  busy(false);
});

$('delete').addEventListener('click', async () => {
  if (!world || !confirm(`Delete “${world.name}” permanently?`)) return;
  await api(`/worlds/${world.id}`, { method: 'DELETE' });
  location.search = '';
});

$('expand').addEventListener('click', async () => {
  if (!world) return;
  const km = Number($('km').value) || 2;
  const choice = $('sides').value;
  const sides = choice === 'all' ? ['n', 'e', 's', 'w'] : choice === 'view' ? sidesTowardView() : [choice];
  busy(true);
  setStatus('Generating…');
  const id = world.id;
  const poll = setInterval(async () => {
    const w = await api(`/worlds/${id}`).catch(() => null);
    if (w?.job) {
      $('bar').firstElementChild.style.width = `${(100 * w.job.done) / w.job.total}%`;
      setStatus(`Generating chunk ${w.job.done} of ${w.job.total}…`);
    }
  }, 300);
  try {
    const { world: w, expansion: e } = await api(`/worlds/${id}/expand`, { method: 'POST', body: { km, sides } });
    clearInterval(poll);
    showWorld(w, { refit: choice === 'all' });
    setStatus(`${size(w)} — added ${e.chunks} chunks in ${secs(e.total_ms)} on ${e.threads} threads (generation ${secs(e.gen_ms)}, save ${secs(e.serialize_ms + e.save_ms)})`);
  } catch (err) {
    clearInterval(poll);
    setStatus(`Failed: ${err.message}`);
  }
  busy(false);
});

const worlds = await refreshList();
const wanted = new URLSearchParams(location.search).get('world');
if (worlds.length) {
  const id = worlds.some((w) => w.id === wanted) ? wanted : worlds[0].id;
  $('worlds').value = id;
  await openWorld(id);
} else {
  setStatus('No worlds yet — press New to create one.');
}
