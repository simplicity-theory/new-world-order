// Map style for generated worlds. No external basemap, sprites or fonts.

const RELIEF_EXAGGERATION = 3;
const M_PER_PX_Z0 = 78271.517; // metres per pixel at zoom 0 on the equator (512px tiles)
const FONT = ['sans-serif'];

/** Line width that tracks a real-world width in metres (property), with a pixel floor. */
function metres(prop, floor, extra = 0) {
  const stops = [];
  for (let z = 8; z <= 20; z += 2) {
    stops.push(z, ['max', floor, ['*', ['+', ['get', prop], extra], 2 ** z / M_PER_PX_Z0]]);
  }
  return ['interpolate', ['exponential', 2], ['zoom'], ...stops];
}

const width = (...stops) => ['interpolate', ['exponential', 1.6], ['zoom'], ...stops];
const kind = (...kinds) => ['in', ['get', 'kind'], ['literal', kinds]];
const byKind = (map, fallback) => ['match', ['get', 'kind'], ...Object.entries(map).flat(), fallback];

// Road classes, least to most important: [kinds, minzoom, fill, casing, fill width, casing width].
const ROADS = [
  ['street', ['street'], 13, '#ffffff', '#d3ccc0', width(13, 0.6, 15, 3, 17, 9, 19, 26), width(13, 0, 14.5, 4, 17, 11, 19, 29)],
  ['street-major', ['street_major'], 12, '#ffffff', '#cdc5b8', width(12, 0.7, 15, 4.5, 17, 12, 19, 32), width(12, 0, 14, 4, 15, 6, 17, 14.5, 19, 35)],
  ['tertiary', ['tertiary'], 9, '#ffffff', '#c4bcae', width(9, 0.6, 12, 1.6, 15, 5.5, 17, 14, 19, 36), width(9, 0, 12, 2.8, 15, 7.5, 17, 16.5, 19, 39)],
  ['secondary', ['secondary'], 8, '#fdf3b4', '#cdb35c', width(8, 0.8, 12, 2.4, 15, 7, 17, 17, 19, 42), width(8, 1.2, 12, 3.8, 15, 9, 17, 19.5, 19, 45)],
  ['primary', ['primary'], 6, '#fbd58b', '#cf9a3c', width(6, 1, 12, 3, 15, 8.5, 17, 20, 19, 48), width(6, 1.6, 12, 4.6, 15, 10.5, 17, 22.5, 19, 51)],
  ['link', ['link'], 11, '#ef9f7c', '#b9583a', width(11, 0.7, 15, 4, 17, 10, 19, 24), width(11, 1.2, 15, 5.6, 17, 12.5, 19, 27)],
  ['motorway', ['motorway'], 5, '#ef9f7c', '#b9583a', width(5, 1.4, 12, 3.8, 15, 10, 17, 24, 19, 56), width(5, 2.2, 12, 5.6, 15, 12.5, 17, 27, 19, 60)],
];
const ROAD_COLOR = { street: '#ffffff', street_major: '#ffffff', tertiary: '#ffffff', track: '#ffffff', secondary: '#fdf3b4', primary: '#fbd58b', motorway: '#ef9f7c', rail: '#8a8a8a' };
const BRIDGE_W = (extra) => ['interpolate', ['exponential', 1.6], ['zoom'],
  12, ['+', byKind({ motorway: 3.8, primary: 3, secondary: 2.4, rail: 1.6 }, 1.4), extra],
  15, ['+', byKind({ motorway: 10, primary: 8.5, secondary: 7, rail: 2.6, street: 3 }, 5), extra],
  17, ['+', byKind({ motorway: 24, primary: 20, secondary: 17, rail: 4, street: 9 }, 13), extra],
  19, ['+', byKind({ motorway: 56, primary: 48, secondary: 42, rail: 7, street: 26 }, 34), extra]];

export function buildStyle(tilesUrl, demUrl, mask) {
  const line = (id, layer, extra) => ({ id, type: 'line', source: 'world', 'source-layer': layer, ...extra });
  const road = ([id, kinds, minzoom, color, casing, w, cw]) => {
    const base = { filter: kind(...kinds), minzoom, layout: { 'line-cap': 'round', 'line-join': 'round' } };
    return [
      line(`${id}-casing`, 'road', { ...base, paint: { 'line-color': casing, 'line-width': cw } }),
      line(id, 'road', { ...base, paint: { 'line-color': color, 'line-width': w } }),
    ];
  };
  const roads = ROADS.map(road);
  const fill = (id, layer, kinds, color, extra = {}) => ({
    id, type: 'fill', source: 'world', 'source-layer': layer, ...(kinds ? { filter: kind(...kinds) } : {}),
    paint: { 'fill-color': color, 'fill-antialias': false, ...extra.paint }, ...(extra.minzoom ? { minzoom: extra.minzoom } : {}),
  });
  const label = (id, layer, extra) => ({ id, type: 'symbol', source: 'world', 'source-layer': layer, ...extra,
    layout: { 'text-font': FONT, ...extra.layout } });
  const dem = { type: 'raster-dem', tiles: [demUrl], tileSize: 256, minzoom: 9, maxzoom: 13 };
  return {
    version: 8,
    sources: {
      world: { type: 'vector', tiles: [tilesUrl], minzoom: 0, maxzoom: 16 },
      // Terrarium-encoded elevation, read with tripled factors so gentle hills still shade.
      dem: { ...dem, encoding: 'custom',
        redFactor: 256 * RELIEF_EXAGGERATION, greenFactor: RELIEF_EXAGGERATION, blueFactor: RELIEF_EXAGGERATION / 256,
        baseShift: -32768 * RELIEF_EXAGGERATION },
      // The same tiles at true height, for the 3D view.
      terrain: { ...dem, encoding: 'terrarium' },
      mask: { type: 'geojson', data: mask },
    },
    layers: [
      { id: 'void', type: 'background', paint: { 'background-color': '#d9dde0' } },
      fill('land', 'land', null, '#eef0e3'),
      fill('farmland', 'landcover', ['farmland'], '#f1ead0'),
      fill('moor', 'landcover', ['moor'], '#e3dcc6'),
      fill('forest', 'landcover', ['forest'], '#cfe2bd'),
      fill('marsh', 'landcover', ['marsh'], '#d2e6dc'),
      fill('rock', 'landcover', ['rock'], '#d9d6d0'),
      fill('sand', 'landcover', ['sand'], '#f6ecc9'),
      line('field', 'field', { minzoom: 13.5, paint: { 'line-color': '#cfc496', 'line-width': 0.7,
        'line-opacity': ['interpolate', ['linear'], ['zoom'], 13.5, 0, 14.5, 0.9] } }),
      { id: 'hillshade', type: 'hillshade', source: 'dem',
        paint: { 'hillshade-exaggeration': 0.5, 'hillshade-shadow-color': '#4a4034', 'hillshade-highlight-color': '#ffffff', 'hillshade-accent-color': '#6b5d4c' } },
      { id: 'mask', type: 'fill', source: 'mask', paint: { 'fill-color': '#d9dde0', 'fill-antialias': false } },
      line('contour', 'contour', { minzoom: 11,
        filter: ['any', ['>=', ['zoom'], 13], ['==', ['get', 'kind'], 'index']],
        paint: { 'line-color': '#a8855a',
          'line-opacity': ['match', ['get', 'kind'], 'index', 0.6, 0.38],
          'line-width': ['match', ['get', 'kind'], 'index', 1.1, 0.6] } }),
      fill('urban', 'landuse', ['urban'], '#ebe8e0', { minzoom: 12 }),
      fill('residential', 'landuse', ['residential'], '#e8e3da', { minzoom: 12 }),
      fill('commercial', 'landuse', ['commercial'], '#efdfd8', { minzoom: 12 }),
      fill('industrial', 'landuse', ['industrial'], '#e2dde6', { minzoom: 12 }),
      fill('civic', 'landuse', ['civic'], '#ebe2c8', { minzoom: 12 }),
      fill('park', 'landuse', ['park'], '#c5e3ab', { minzoom: 12 }),
      // Trees along watercourses.
      line('riverside', 'river', { minzoom: 14, layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': '#c3dcae', 'line-width': metres('width', 3, 16), 'line-opacity': 0.8 } }),
      fill('water', 'water', ['sea', 'lake', 'river'], '#a5cfee'),
      fill('tidal', 'water', ['tidal'], '#c6d9da'),
      line('river', 'river', {
        filter: ['all', ['any', ['>=', ['zoom'], 13], ['==', ['get', 'kind'], 'river']], ['any', ['>=', ['zoom'], 11], ['>=', ['get', 'width'], 11]]],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': '#a5cfee', 'line-width': metres('width', 0.9) } }),
      fill('pier', 'manmade', null, '#d8d2c6', { minzoom: 13 }),
      line('track', 'road', { filter: kind('track'), minzoom: 13.5,
        paint: { 'line-color': '#b9a98a', 'line-width': width(13.5, 0.6, 17, 2.2), 'line-dasharray': [4, 2] } }),
      ...roads.map((r) => r[0]),
      line('rail', 'rail', { minzoom: 8, paint: { 'line-color': '#8a8a8a', 'line-width': width(8, 0.8, 13, 1.8, 17, 4) } }),
      line('rail-ties', 'rail', { minzoom: 12, paint: { 'line-color': '#ffffff', 'line-width': width(12, 0.6, 17, 2.2), 'line-dasharray': [3, 3] } }),
      ...roads.map((r) => r[1]),
      line('bridge-casing', 'bridge', { minzoom: 12, paint: { 'line-color': '#5f5a52', 'line-width': BRIDGE_W(3) } }),
      line('bridge', 'bridge', { minzoom: 12, paint: { 'line-color': byKind(ROAD_COLOR, '#ffffff'), 'line-width': BRIDGE_W(0) } }),
      { id: 'building', type: 'fill', source: 'world', 'source-layer': 'building', minzoom: 13.5,
        paint: {
          'fill-color': byKind({ commercial: '#d9c9c0', industrial: '#cdc7d3', farm: '#cfc3ae', church: '#bfae9c', school: '#d6c59a', townhall: '#c9b48a', hospital: '#e3bdb8' }, '#d8d0c4'),
          'fill-outline-color': '#b9b0a3',
          'fill-opacity': ['interpolate', ['linear'], ['zoom'], 13.5, 0, 14.5, 1],
        } },
      { id: 'building-3d', type: 'fill-extrusion', source: 'world', 'source-layer': 'building', minzoom: 13.5,
        layout: { visibility: 'none' },
        paint: {
          'fill-extrusion-color': byKind({ commercial: '#d9c9c0', industrial: '#cdc7d3', farm: '#cfc3ae', church: '#bfae9c', school: '#d6c59a', townhall: '#c9b48a', hospital: '#e3bdb8' }, '#d8d0c4'),
          'fill-extrusion-height': ['get', 'height'], 'fill-extrusion-opacity': 0.92,
        } },
      { id: 'crossing', type: 'circle', source: 'world', 'source-layer': 'crossing', minzoom: 14.5,
        paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 14.5, 2, 18, 5], 'circle-color': '#ffffff', 'circle-stroke-color': '#6f6f6f', 'circle-stroke-width': 1.4 } },
      { id: 'ford', type: 'circle', source: 'world', 'source-layer': 'ford', minzoom: 14,
        paint: { 'circle-radius': 3, 'circle-color': '#ffffff', 'circle-stroke-color': '#6f9fc4', 'circle-stroke-width': 1.5 } },
      { id: 'poi-dot', type: 'circle', source: 'world', 'source-layer': 'poi', minzoom: 14,
        paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 14, 2.5, 17, 5],
          'circle-color': byKind({ church: '#7a5c3e', school: '#b8860b', townhall: '#8b3a3a', hospital: '#c0392b', station: '#34495e', harbour: '#2e6f9e', junction: '#b9583a' }, '#555555'),
          'circle-stroke-color': '#ffffff', 'circle-stroke-width': 1.2 } },
      label('contour-label', 'contour', { minzoom: 13, filter: ['==', ['get', 'kind'], 'index'],
        layout: { 'symbol-placement': 'line', 'symbol-spacing': 420, 'text-field': ['to-string', ['get', 'ele']], 'text-size': 10, 'text-max-angle': 25 },
        paint: { 'text-color': '#8a6a42', 'text-halo-color': '#f3f1e6', 'text-halo-width': 1.4 } }),
      label('waterway-label', 'waterway_label', { minzoom: 11, filter: ['any', ['>=', ['zoom'], 13.5], ['==', ['get', 'kind'], 'river']],
        layout: { 'symbol-placement': 'line', 'symbol-spacing': 500, 'text-field': ['get', 'name'], 'text-letter-spacing': 0.12,
          'text-size': ['match', ['get', 'kind'], 'river', 12.5, 11], 'text-max-angle': 30 },
        paint: { 'text-color': '#3f77a3', 'text-halo-color': '#ffffffcc', 'text-halo-width': 1.4 } }),
      label('water-label', 'water_label', { minzoom: 11,
        layout: { 'text-field': ['get', 'name'], 'text-size': 12, 'text-letter-spacing': 0.1 },
        paint: { 'text-color': '#3f77a3', 'text-halo-color': '#ffffffcc', 'text-halo-width': 1.4 } }),
      label('road-name', 'road', { minzoom: 15, filter: ['has', 'name'],
        layout: { 'symbol-placement': 'line', 'symbol-spacing': 350, 'text-field': ['get', 'name'],
          'text-size': ['interpolate', ['linear'], ['zoom'], 15, 10, 18, 13], 'text-max-angle': 30 },
        paint: { 'text-color': '#5b5348', 'text-halo-color': '#ffffff', 'text-halo-width': 1.5 } }),
      label('road-ref', 'road', { minzoom: 10, filter: ['has', 'ref'],
        layout: { 'symbol-placement': 'line', 'symbol-spacing': 600, 'text-field': ['get', 'ref'], 'text-size': 10.5,
          'text-rotation-alignment': 'viewport', 'text-letter-spacing': 0.05 },
        paint: { 'text-color': ['match', ['get', 'kind'], 'motorway', '#8e3a22', '#6b5320'], 'text-halo-color': '#ffffff', 'text-halo-width': 2 } }),
      label('poi-label', 'poi', { minzoom: 15.2,
        layout: { 'text-field': ['get', 'name'], 'text-size': 11, 'text-offset': [0, 0.9], 'text-anchor': 'top', 'text-max-width': 8, 'text-optional': true },
        paint: { 'text-color': '#4a4238', 'text-halo-color': '#ffffff', 'text-halo-width': 1.5 } }),
      label('area-label', 'area_label', { minzoom: 10,
        layout: { 'text-field': ['get', 'name'], 'text-size': 12.5, 'text-letter-spacing': 0.18, 'text-max-width': 7 },
        paint: { 'text-color': ['match', ['get', 'kind'], 'bay', '#3f77a3', '#4f7a4a'], 'text-halo-color': '#ffffffb0', 'text-halo-width': 1.3 } }),
      label('peak', 'peak', { minzoom: 11,
        layout: { 'text-field': ['concat', '▲\n', ['get', 'name'], '\n', ['to-string', ['get', 'ele']], ' m'], 'text-size': 10.5, 'text-line-height': 1.15,
          'symbol-sort-key': ['-', 0, ['get', 'ele']] },
        paint: { 'text-color': '#6b5334', 'text-halo-color': '#ffffffcc', 'text-halo-width': 1.4 } }),
      label('place', 'place', {
        filter: ['>=', ['zoom'], ['match', ['get', 'tier'], 3, 0, 2, 9, 1, 11, 12]],
        layout: {
          'text-field': ['get', 'name'],
          'text-size': ['interpolate', ['linear'], ['zoom'],
            9, ['match', ['get', 'tier'], 3, 15, 2, 12, 10],
            15, ['match', ['get', 'tier'], 3, 26, 2, 21, 1, 17, 14]],
          'symbol-sort-key': ['-', 3, ['get', 'tier']],
          'text-letter-spacing': 0.04,
        },
        paint: { 'text-color': '#2b3440', 'text-halo-color': '#ffffffd9', 'text-halo-width': 1.6 } }),
    ],
  };
}
